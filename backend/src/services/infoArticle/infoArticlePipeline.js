'use strict';

/**
 * infoArticlePipeline — оркестратор генератора информационной статьи в блог.
 *
 * Полностью изолирован от services/linkArticle и services/pipeline. Соблюдает
 * тот же паттерн, что и linkArticlePipeline.js (он же — родительский шаблон):
 *   - своя таблица info_article_tasks + info_article_events;
 *   - свой набор промтов backend/src/prompts/infoArticle/*.txt;
 *   - переиспользует адаптеры llm/* и nanoBananaPro для изображений.
 *
 * Стадии:
 *   1.  Pre-Stage 0   → DeepSeek : стратегический контекст темы + ниша
 *   2.  Stage 0       → DeepSeek : ЦА, тон
 *   3.  Stage 1       → DeepSeek : сущности, интенты, user_questions, jtbd
 *   4.  Stage 1B      → DeepSeek : white-space → article_hierarchy_hints
 *   5.  Stage 2       → DeepSeek : структура статьи (H2/H3 + jtbd-теги + image_plan)
 *   6.  Stage 2B      → DeepSeek : LSI-набор (многофазный + corrective)
 *   7.  Stage 2C      → детерминированный shortlist + DeepSeek picks + post-validator
 *   8.  Build IAKB    → собираем INFO-ARTICLE KB, опционально Gemini cachedContents
 *   9.  Stage 3       → Gemini   : написание HTML с встроенными ссылками по link_plan
 *   10. Stage 5/5b    → DeepSeek : E-E-A-T audit + LLM/детерминированный link audit
 *   11. Refine        → Gemini   : ≤ 1 corrective retry при низком pq_score / coverage / lsi
 *   12. Stage 4       → DeepSeek : 3 image prompts
 *   13. Image gen     → Nano Banana Pro
 *   14. Embed + plain → подмена плейсхолдеров на data:image base64 + strip-tags
 *   15. Cleanup       → удаление Gemini cachedContents
 */

const db = require('../../config/db');
const { callLLM } = require('../llm/callLLM');
const { loadInfoArticlePrompt } = require('../../prompts/infoArticle');
const { generateImage } = require('../linkArticle/nanoBananaPro.adapter');
const sse = require('../sse/sseManager');
const { createCachedContent, deleteCachedContent } = require('../llm/gemini.adapter');
const { EEAT_PQ_TARGET, LSI_COVERAGE_TARGET } = require('../../utils/objectiveMetrics');

const {
  recordTextTokens,
  recordImageCall,
  recordEvent,
} = require('./infoArticleMetrics');
const {
  buildInfoArticleKnowledgeBase,
  iakbCallOpts,
  pointerOrJson,
} = require('./infoArticleKnowledgeBase');
const { synthesizeLsiSet, measureLsiCoverageInHtml } = require('./lsiPipeline');
const { planSemanticLinks, auditHtmlAgainstPlan } = require('./semanticLinkPlanner');
const { domainsFromLinks } = require('./excelParser');
const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Config via env ───────────────────────────────────────────────────

const INFO_ARTICLE_GEMINI_MODEL =
  process.env.INFO_ARTICLE_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-3.1-pro-preview';

const INFO_ARTICLE_DEEPSEEK_MODEL =
  process.env.INFO_ARTICLE_DEEPSEEK_MODEL ||
  process.env.DEEPSEEK_MODEL ||
  'deepseek-chat';

const MAX_PARALLEL_IMAGES = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MAX_PARALLEL_IMAGES, 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
})();

const IMAGE_PRICE_USD = (() => {
  const v = parseFloat(process.env.GEMINI_IMAGE_PRICE_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.04;
})();

const INFO_ARTICLE_GEMINI_CACHE_ENABLED =
  String(process.env.INFO_ARTICLE_GEMINI_CACHE_ENABLED || '').toLowerCase() === 'true';

const INFO_ARTICLE_GEMINI_CACHE_TTL_S = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GEMINI_CACHE_TTL_S, 10);
  return Number.isFinite(v) && v >= 60 && v <= 3600 ? v : 900;
})();

const INFO_ARTICLE_EEAT_TARGET = (() => {
  const env = parseFloat(process.env.INFO_ARTICLE_EEAT_TARGET);
  if (Number.isFinite(env) && env > 0 && env <= 10) return env;
  return EEAT_PQ_TARGET;
})();

const INFO_ARTICLE_LSI_TARGET = (() => {
  const env = parseFloat(process.env.INFO_ARTICLE_LSI_TARGET);
  if (Number.isFinite(env) && env > 0 && env <= 100) return env;
  return LSI_COVERAGE_TARGET;
})();

const IN_PROGRESS = new Set();
const CURRENT_STAGE = new Map();

// ── Helpers ──────────────────────────────────────────────────────────

function publishEvent(taskId, type, payload = {}) {
  try {
    sse.publish(taskId, { type, ...payload, ts: new Date().toISOString() });
  } catch (_) { /* no-op */ }
}

async function appendLog(taskId, msg, level = 'info') {
  const entry = await recordEvent(taskId, msg, level, CURRENT_STAGE.get(taskId) || null);
  publishEvent(taskId, 'log', entry);
}

async function setStage(taskId, stageName, progressPct) {
  CURRENT_STAGE.set(taskId, stageName);
  try {
    await db.query(
      `UPDATE info_article_tasks
          SET current_stage = $2, progress_pct = $3, updated_at = NOW()
        WHERE id = $1`,
      [taskId, stageName, progressPct],
    );
  } catch (err) {
    console.error('[infoArticle] setStage failed:', err.message);
  }
  publishEvent(taskId, 'stage', { stage: stageName, progress: progressPct });
}

async function saveColumn(taskId, column, data) {
  try {
    await db.query(
      `UPDATE info_article_tasks SET ${column} = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, data != null ? JSON.stringify(data) : null],
    );
  } catch (err) {
    console.error(`[infoArticle] saveColumn(${column}) failed:`, err.message);
  }
}

function buildCallCtx(taskId, stageName) {
  // taskId не передаём в callLLM (см. linkArticlePipeline) — у info_article_tasks
  // нет FK-связи с task_metrics; собственные счётчики идут через onTokens.
  return {
    stageName,
    log: (msg, level = 'info') => appendLog(taskId, msg, level).catch(() => {}),
    onTokens: (adapter, tIn, tOut, cost) => {
      recordTextTokens(taskId, adapter, tIn, tOut, cost).catch(() => {});
    },
  };
}

// ── Stages 1–4 (DeepSeek analytics) ──────────────────────────────────

async function runPreStrategy(task, ctx) {
  const links = Array.isArray(task.commercial_links) ? task.commercial_links : [];
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `brand_name: ${task.brand_name || '[не задано]'}`,
    `brand_facts: ${task.brand_facts || '[не задано]'}`,
    `commercial_domains: ${JSON.stringify(domainsFromLinks(links))}`,
    `commercial_h1_sample: ${JSON.stringify(links.slice(0, 10).map((l) => l.h1))}`,
  ].join('\n');
  return callLLM(
    'deepseek',
    loadInfoArticlePrompt('preStage0'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'InfoArticle Pre-Stage 0', ...ctx },
  );
}

async function runAudience(task, strategy, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `brand_facts: ${task.brand_facts || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 5000)}`,
  ].join('\n');
  return callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage0'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'InfoArticle Stage 0', ...ctx },
  );
}

async function runIntents(task, strategy, audience, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 4000)}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
  ].join('\n');
  return callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage1'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'InfoArticle Stage 1', ...ctx },
  );
}

async function runWhitespace(task, strategy, audience, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `brand_facts: ${task.brand_facts || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 4000)}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
  ].join('\n');
  return callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage1bWS'),
    user,
    { retries: 3, temperature: 0.35, callLabel: 'InfoArticle Stage 1B (white-space)', ...ctx },
  );
}

async function runOutline(task, audience, intents, whitespace, ctx) {
  const hints = (whitespace && whitespace.article_hierarchy_hints) || {};
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
    `stage1_intents: ${JSON.stringify(intents).slice(0, 8000)}`,
    `whitespace_hints: ${JSON.stringify(hints).slice(0, 4000)}`,
  ].join('\n');
  return callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage2'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'InfoArticle Stage 2 (outline)', ...ctx },
  );
}

// ── Stage 3: writer (Gemini) with corrective-retry ───────────────────

const HALLUCINATION_PATTERNS = [
  /по данным исследовани[йя]/i,
  /согласно отчёту/i,
  /согласно исследовани[июя]/i,
  /в\s+\d{4}\s+году\s+рынок\s+вырос/i,
  /аналитик[иа]\s+[А-ЯA-Z][а-яa-z]+\s+сообщ/i,
  /в\s+ходе\s+опроса\s+\d+/i,
];

function stripTagsLoop(s) {
  // Delegates to shared utility (CodeQL js/incomplete-multi-character-sanitization).
  return stripHtmlTagsToText(s);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(safe, 'gi')) || []).length;
}

/**
 * Programmatic validation of writer output: image slots, h1 count, hallucination
 * patterns, expert opinion, FAQ block, and link_plan compliance (ground-truth via
 * auditHtmlAgainstPlan).
 */
function validateWriterOutput(html, linkPlan) {
  const issues = [];
  if (typeof html !== 'string' || html.trim().length < 600) {
    issues.push('article_html слишком короткий или пустой');
    return issues;
  }

  // image slots
  for (let i = 1; i <= 3; i += 1) {
    const c = countOccurrences(html, `<!-- IMAGE_SLOT_${i} -->`);
    if (c === 0) issues.push(`Отсутствует плейсхолдер <!-- IMAGE_SLOT_${i} -->`);
    else if (c > 1) issues.push(`Плейсхолдер <!-- IMAGE_SLOT_${i} --> встречается ${c} раз (должен 1)`);
  }

  // h1
  const h1Count = (html.match(/<h1\b/gi) || []).length;
  if (h1Count !== 1) issues.push(`<h1> должен быть ровно 1, найдено: ${h1Count}`);

  // ── Expert opinion (blockquote class="expert-opinion") — ровно 1 ─────
  // Считаем гибко: атрибут class может быть в одинарных/двойных кавычках,
  // могут идти другие классы. Главное — наличие хотя бы одного blockquote
  // с маркером "expert-opinion" в class.
  const expertBlockRe = /<blockquote\b[^>]*class\s*=\s*["'][^"']*\bexpert-opinion\b[^"']*["'][^>]*>/gi;
  const expertCount = (html.match(expertBlockRe) || []).length;
  if (expertCount === 0) {
    issues.push('Отсутствует обязательный блок «Мнение эксперта» — нужен ровно один <blockquote class="expert-opinion">…</blockquote>');
  } else if (expertCount > 1) {
    issues.push(`Блок «Мнение эксперта» (<blockquote class="expert-opinion">) встречается ${expertCount} раз — должен быть ровно 1`);
  } else {
    // Проверим, что внутри есть атрибуция (cite/footer/strong "Мнение эксперта")
    // — мягкая эвристика, чтобы writer не вставил пустой blockquote.
    const exMatch = html.match(/<blockquote\b[^>]*class\s*=\s*["'][^"']*\bexpert-opinion\b[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i);
    const exBody  = exMatch ? exMatch[1] : '';
    const hasAttribution = /<cite\b/i.test(exBody) || /<footer\b/i.test(exBody) || /мнение\s+эксперта/i.test(exBody);
    if (!hasAttribution) {
      issues.push('Блок «Мнение эксперта» не содержит атрибуции (нужны <cite>, <footer> или фраза «Мнение эксперта»)');
    }
  }

  // ── FAQ block: <h2>Часто задаваемые вопросы</h2> + 4–6 H3 после него ─
  const faqHeadingRe = /<h2\b[^>]*>\s*часто\s+задава(?:е|ю)мые\s+вопрос(?:ы|ов)\s*<\/h2>/gi;
  const faqHeadings = html.match(faqHeadingRe) || [];
  if (faqHeadings.length === 0) {
    issues.push('Отсутствует обязательный FAQ-блок: нужен <h2>Часто задаваемые вопросы</h2> в конце статьи');
  } else if (faqHeadings.length > 1) {
    issues.push(`Заголовок «Часто задаваемые вопросы» встречается ${faqHeadings.length} раз — должен быть ровно 1`);
  } else {
    // Считаем H3 между FAQ-заголовком и следующим H2 (Заключение / конец).
    const faqIdx = html.search(faqHeadingRe);
    const tail   = html.slice(faqIdx + faqHeadings[0].length);
    const nextH2 = tail.search(/<h2\b/i);
    const faqBody = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
    const faqQuestions = (faqBody.match(/<h3\b/gi) || []).length;
    if (faqQuestions < 4) {
      issues.push(`В FAQ-блоке найдено ${faqQuestions} вопросов (<h3>) — должно быть 4–6`);
    } else if (faqQuestions > 6) {
      issues.push(`В FAQ-блоке найдено ${faqQuestions} вопросов (<h3>) — должно быть 4–6, лишние сократи`);
    }
  }

  // hallucination guard
  const plain = stripTagsLoop(html);
  for (const pat of HALLUCINATION_PATTERNS) {
    if (pat.test(plain)) {
      issues.push(`Найдена запрещённая формулировка (подозрение на галлюцинацию): ${pat}`);
      break;
    }
  }

  // link plan compliance
  const linkAudit = auditHtmlAgainstPlan({ html, link_plan: linkPlan || [] });
  if (linkAudit.coverage_pct < 100) {
    issues.push(`Покрытие плана ссылок ${linkAudit.coverage_pct}% (должно 100%) — пропущено ${linkAudit.missing.length} ссылок`);
  }
  if (linkAudit.misplacements.length) {
    issues.push(`Ссылки вставлены не в свои H2: ${linkAudit.misplacements.length} нарушений`);
  }
  if (linkAudit.extras.length) {
    issues.push(`Вставлены неожиданные ссылки (вне link_plan): ${linkAudit.extras.length}`);
  }
  if (linkAudit.density_violations.length) {
    issues.push(`Нарушена плотность 1–2 ссылки на H2 в ${linkAudit.density_violations.length} секциях`);
  }

  return issues;
}

async function runWriter(task, args, ctx, opts = {}) {
  const { audience, intents, whitespace, outline, lsi, linkPlan } = args;
  const iakbReady = !!task.__iakb;
  const writerInstructions = loadInfoArticlePrompt('stage3');

  // System prompt: при активном Gemini cache — пусто (всё в кэше);
  // иначе — IAKB + writer-instructions.
  const systemFull = task.__iakb
    ? `${task.__iakb}\n\n========================================\n${writerInstructions}`
    : writerInstructions;
  const systemArg = task.__geminiCacheName ? '' : systemFull;

  const buildUser = (correctiveIssues = null, priorEeatIssues = null, priorLinkIssues = null) => {
    const base = [
      `[INPUTS]`,
      `topic: ${task.topic}`,
      `region: ${task.region || '[не задано]'}`,
      `brand_name: ${task.brand_name || '[авто]'}`,
      `brand_facts: ${task.brand_facts || '[не задано]'}`,
      `output_format: ${task.output_format || 'html'}`,
      `stage0_audience: ${pointerOrJson('§3 Аудитория и тон', audience, iakbReady, 3500)}`,
      `stage1_intents: ${pointerOrJson('§4 Сущности/интенты/jtbd', intents, iakbReady, 5000)}`,
      `whitespace_hints: ${pointerOrJson('§5 White-space', (whitespace && whitespace.article_hierarchy_hints) || {}, iakbReady, 2500)}`,
      `stage2_outline: ${pointerOrJson('§6 Структура статьи', outline, iakbReady, 8000)}`,
      `lsi_set: ${pointerOrJson('§7 LSI-набор', lsi, iakbReady, 2500)}`,
      `link_plan: ${pointerOrJson('§8 Перелинковка', linkPlan, iakbReady, 6000)}`,
    ];
    if (priorEeatIssues && priorEeatIssues.length) {
      base.push('');
      base.push('[PRIOR_EEAT_ISSUES — закрой каждую issue в новой версии:]');
      for (const it of priorEeatIssues.slice(0, 12)) {
        base.push(`- [${it.severity || 'minor'}|${it.category || 'misc'}] @${it.where || 'article'}: ${it.problem || ''} → ${it.fix_instruction || ''}`);
      }
    }
    if (priorLinkIssues && priorLinkIssues.length) {
      base.push('');
      base.push('[PRIOR_LINK_ISSUES — приведи перелинковку в полное соответствие плану:]');
      for (const it of priorLinkIssues.slice(0, 16)) base.push(`- ${it}`);
    }
    if (correctiveIssues && correctiveIssues.length) {
      base.push('');
      base.push('[CORRECTIVE PASS — в предыдущем ответе нарушены правила:]');
      for (const it of correctiveIssues) base.push(`- ${it}`);
      base.push('');
      base.push('Пересобери статью так, чтобы все эти проблемы были устранены, сохранив корректные части.');
    }
    return base.join('\n');
  };

  // First attempt
  let result = await callLLM(
    'gemini',
    systemArg,
    buildUser(null, opts.priorEeatIssues, opts.priorLinkIssues),
    {
      retries: 3,
      temperature: 0.5,
      maxTokens: 16384,
      // Reasoning-модель + 16K токенов ответа — стабильно нужно 3–5 минут.
      // Дефолтный 3-минутный таймаут адаптера регулярно срывал генерацию.
      timeoutMs: 480000,
      callLabel: opts.callLabel || 'InfoArticle Stage 3 (writer)',
      ...iakbCallOpts(task),
      ...ctx,
    },
  );

  let html = typeof result?.article_html === 'string' ? result.article_html : '';
  let issues = validateWriterOutput(html, linkPlan);

  if (issues.length) {
    await appendLog(ctx.taskId, `⚠ Статья не прошла валидацию: ${issues.length} проблем — corrective retry`, 'warn').catch(() => {});
    const retry = await callLLM(
      'gemini',
      systemArg,
      buildUser(issues, opts.priorEeatIssues, opts.priorLinkIssues),
      {
        retries: 2,
        temperature: 0.45,
        maxTokens: 16384,
        timeoutMs: 480000,
        callLabel: 'InfoArticle Stage 3 (corrective)',
        ...iakbCallOpts(task),
        ...ctx,
      },
    );
    const retryHtml = typeof retry?.article_html === 'string' ? retry.article_html : '';
    const retryIssues = validateWriterOutput(retryHtml, linkPlan);
    if (retryIssues.length < issues.length && retryHtml) {
      html = retryHtml;
      result = retry;
      issues = retryIssues;
    }
  }

  return { html, selfAudit: result?.self_audit || null, remainingIssues: issues };
}

// Note: INFO_ARTICLE_GEMINI_MODEL / INFO_ARTICLE_DEEPSEEK_MODEL are read at
// the top of the file from env, exported below for parity with the
// linkArticle module, and consumed by gemini.adapter.js / deepseek.adapter.js
// via the same env vars (callLLM reads provider env directly). The exports
// keep the constants observable for diagnostics / tests.

// ── Stage 5 / 5b: audits ────────────────────────────────────────────

async function runEeatAudit(task, audience, intents, lsiSet, articleHtml, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `brand_name: ${task.brand_name || '[авто]'}`,
    `audience_digest: ${JSON.stringify(audience).slice(0, 2500)}`,
    `intents_digest: ${JSON.stringify({
      user_questions: (intents && intents.user_questions) || [],
      entities: (intents && Array.isArray(intents.entities) ? intents.entities.slice(0, 12) : []),
    }).slice(0, 3500)}`,
    `lsi_set_digest: ${JSON.stringify((lsiSet && lsiSet.important) || []).slice(0, 1500)}`,
    `article_html: ${articleHtml.slice(0, 14000)}`,
  ].join('\n');

  const result = await callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage5Eeat'),
    user,
    { retries: 3, temperature: 0.2, callLabel: 'InfoArticle Stage 5 (E-E-A-T audit)', ...ctx },
  );

  const norm = result || {};
  const totalRaw = Number(norm.total_score);
  norm.total_score = Number.isFinite(totalRaw)
    ? Math.max(0, Math.min(10, Math.round(totalRaw * 10) / 10))
    : 0;
  if (!Array.isArray(norm.issues)) norm.issues = [];
  if (!['pass', 'refine', 'reject'].includes(norm.verdict)) {
    norm.verdict = norm.total_score >= INFO_ARTICLE_EEAT_TARGET ? 'pass' : 'refine';
  }
  if (typeof norm.lsi_coverage_pct !== 'number' || !Number.isFinite(norm.lsi_coverage_pct)) {
    norm.lsi_coverage_pct = 0;
  }
  return norm;
}

async function runLinkAudit(articleHtml, linkPlan, deterministicCheck, ctx) {
  // Передаём LLM detected ground-truth (deterministicCheck), он лишь ранжирует
  // semantic_violations + verdict.
  const user = [
    `[INPUTS]`,
    `article_html: ${articleHtml.slice(0, 14000)}`,
    `link_plan: ${JSON.stringify(linkPlan).slice(0, 6000)}`,
    `links_per_h2: ${JSON.stringify({ min: 1, max: 2 })}`,
    `max_repeats_per_url: 2`,
    `deterministic_check: ${JSON.stringify({
      h2_titles_in_html:        deterministicCheck.h2_titles_in_html,
      anchors_found_in_html:    deterministicCheck.anchors_found_in_html,
      url_usage_count:          deterministicCheck.url_usage_count,
      missing_picks:            deterministicCheck.missing,
      extra_links_outside_plan: deterministicCheck.extras,
    }).slice(0, 8000)}`,
  ].join('\n');

  let llm = null;
  try {
    llm = await callLLM(
      'deepseek',
      loadInfoArticlePrompt('stage5bLink'),
      user,
      { retries: 2, temperature: 0.2, callLabel: 'InfoArticle Stage 5B (link audit)', ...ctx },
    );
  } catch (_) {
    llm = null;
  }

  // Detrministic data — ground truth, всегда побеждает.
  return {
    coverage_pct:        deterministicCheck.coverage_pct,
    total_planned:       deterministicCheck.total_planned,
    total_inserted:      deterministicCheck.total_inserted,
    misplacements:       deterministicCheck.misplacements,
    missing:             deterministicCheck.missing,
    extras:              deterministicCheck.extras,
    density_violations:  deterministicCheck.density_violations,
    repeat_violations:   deterministicCheck.repeat_violations,
    semantic_violations: Array.isArray(llm?.semantic_violations) ? llm.semantic_violations : [],
    verdict:             deterministicCheck.verdict,
    audit_notes:         (llm && typeof llm.audit_notes === 'string') ? llm.audit_notes.slice(0, 500) : '',
  };
}

// ── Stage 4: image prompts + Nano Banana Pro ────────────────────────

async function runImagePromptsGen(task, outline, articleHtml, audience, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `audience_digest: ${JSON.stringify(audience).slice(0, 2000)}`,
    `stage2_outline: ${JSON.stringify(outline).slice(0, 6000)}`,
    `article_html: ${articleHtml.slice(0, 12000)}`,
  ].join('\n');
  const result = await callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage4Images'),
    user,
    { retries: 3, temperature: 0.4, callLabel: 'InfoArticle Stage 4 (image prompts)', ...ctx },
  );
  const prompts = Array.isArray(result?.image_prompts) ? result.image_prompts : [];
  return prompts.slice(0, 3).map((p, idx) => ({
    slot:            p.slot || idx + 1,
    section_h2:      String(p.section_h2 || '').slice(0, 200),
    visual_prompt:   String(p.visual_prompt || '').slice(0, 2000),
    negative_prompt: String(p.negative_prompt || '').slice(0, 400),
    alt_ru:          String(p.alt_ru || '').slice(0, 200),
    status:          'pending',
    image_base64:    null,
    mime_type:       null,
    error:           null,
  }));
}

async function runImageGeneration(taskId, imagePrompts) {
  const results = imagePrompts.map((p) => ({ ...p }));
  for (let i = 0; i < results.length; i += MAX_PARALLEL_IMAGES) {
    const batch = results.slice(i, i + MAX_PARALLEL_IMAGES);
    await Promise.all(batch.map(async (p) => {
      try {
        const { base64, mimeType } = await generateImage(p.visual_prompt, {
          negativePrompt: p.negative_prompt,
        });
        p.image_base64 = base64;
        p.mime_type    = mimeType;
        p.status       = 'done';
        await recordImageCall(taskId, IMAGE_PRICE_USD);
        await appendLog(taskId, `🖼 Slot ${p.slot}: изображение сгенерировано`, 'ok');
      } catch (err) {
        p.status = 'error';
        p.error  = err.message.slice(0, 500);
        await appendLog(taskId, `❌ Slot ${p.slot}: ${err.message}`, 'err');
      }
    }));
  }
  return results;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function embedImages(html, imagePrompts) {
  let out = html;
  for (const p of imagePrompts) {
    const placeholder = `<!-- IMAGE_SLOT_${p.slot} -->`;
    if (p.status === 'done' && p.image_base64) {
      const alt = escapeHtml(p.alt_ru || '');
      const figure =
        `<figure class="info-article-image">` +
        `<img src="data:${p.mime_type};base64,${p.image_base64}" alt="${alt}" />` +
        `</figure>`;
      out = out.replace(placeholder, figure);
    } else {
      out = out.replace(placeholder, '');
    }
  }
  return out;
}

function buildPlainText(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<\/(p|h1|h2|h3|h4|li|figure|figcaption|blockquote)\s*>/gi, '$&\n\n');
  s = s.replace(/<br\s*\/?>(\s*)/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  const tagRe = /<[^>]+>/g;
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(tagRe, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&amp;/g, '&');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Main entrypoint ──────────────────────────────────────────────────

async function processInfoArticleTask(taskId) {
  if (IN_PROGRESS.has(taskId)) return;
  IN_PROGRESS.add(taskId);
  let geminiCacheName = null;

  try {
    const { rows } = await db.query(`SELECT * FROM info_article_tasks WHERE id = $1`, [taskId]);
    const task = rows[0];
    if (!task) { console.error(`[infoArticle] task ${taskId} not found`); return; }

    await db.query(
      `UPDATE info_article_tasks
          SET status = 'running', started_at = COALESCE(started_at, NOW()),
              progress_pct = 1, error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [taskId],
    );
    publishEvent(taskId, 'status', { status: 'running' });
    await appendLog(taskId, '🚀 Старт генерации информационной статьи в блог', 'ok');

    const ctx = { ...buildCallCtx(taskId, 'info_article'), taskId };

    // 1. Pre-Stage 0
    await setStage(taskId, 'pre_stage0', 5);
    const strategy = await runPreStrategy(task, ctx);
    await saveColumn(taskId, 'strategy_context', strategy);

    // 2. Stage 0
    await setStage(taskId, 'stage0_audience', 12);
    const audience = await runAudience(task, strategy, ctx);
    await saveColumn(taskId, 'stage0_audience', audience);

    // 3. Stage 1
    await setStage(taskId, 'stage1_intents', 20);
    const intents = await runIntents(task, strategy, audience, ctx);
    await saveColumn(taskId, 'stage1_intents', intents);

    // 4. Stage 1B
    await setStage(taskId, 'stage1b_whitespace', 28);
    const whitespace = await runWhitespace(task, strategy, audience, ctx);
    await saveColumn(taskId, 'whitespace_analysis', whitespace);

    // 5. Stage 2 outline
    await setStage(taskId, 'stage2_outline', 36);
    const outline = await runOutline(task, audience, intents, whitespace, ctx);
    await saveColumn(taskId, 'stage2_outline', outline);

    // 6. Stage 2B LSI synth
    await setStage(taskId, 'stage2b_lsi', 44);
    const { lsi_set: lsiSet, base_seed: lsiBaseSeed, corrective_used: lsiCorrective } =
      await synthesizeLsiSet({ task, intents, outline, callContext: ctx });
    await saveColumn(taskId, 'lsi_set', lsiSet);
    await appendLog(
      taskId,
      `🔤 LSI: important=${lsiSet.important.length}, supporting=${lsiSet.supporting.length}, base_seed=${lsiBaseSeed.length}${lsiCorrective ? ' (corrective)' : ''}`,
      'info',
    );

    // 7. Stage 2C Semantic Link Planner
    await setStage(taskId, 'stage2c_link_plan', 52);
    const links = Array.isArray(task.commercial_links) ? task.commercial_links : [];
    const planResult = await planSemanticLinks({
      task, outline, links, callContext: ctx,
    });
    await saveColumn(taskId, 'link_plan', planResult.link_plan);
    await saveColumn(taskId, 'link_plan_meta', {
      graph_pattern:       planResult.graph_pattern,
      deterministic_audit: planResult.deterministic_audit,
      shortlist_per_h2:    planResult.shortlistByH2,
    });
    const totalPlanned = planResult.link_plan.reduce((acc, p) => acc + (p.picks?.length || 0), 0);
    const audit = planResult.deterministic_audit || {};
    await appendLog(
      taskId,
      `🔗 Link planner: ${totalPlanned} ссылок на ${planResult.link_plan.length} H2 ` +
      `(глобальный коридор ok: min=${audit.total_min_ok ? 'да' : 'нет'}, max=${audit.total_max_ok ? 'да' : 'нет'}), ` +
      `unique URLs=${Object.keys(planResult.graph_pattern.url_usage_count || {}).length}`,
      'ok',
    );

    // 8. Build IAKB + optional Gemini cachedContents
    task.__iakb = buildInfoArticleKnowledgeBase({
      task, strategy, audience, intents, whitespace, outline, lsi: lsiSet, linkPlan: planResult.link_plan,
    });
    await appendLog(taskId, `🧠 IAKB собрана (${task.__iakb.length} символов)`, 'info');

    if (INFO_ARTICLE_GEMINI_CACHE_ENABLED) {
      try {
        const writerInstructions = loadInfoArticlePrompt('stage3');
        const cacheText = `${task.__iakb}\n\n========================================\n${writerInstructions}`;
        const created = await createCachedContent({
          systemInstruction: cacheText,
          ttlSeconds: INFO_ARTICLE_GEMINI_CACHE_TTL_S,
        });
        task.__geminiCacheName = created.name;
        geminiCacheName = created.name;
        await db.query(
          `UPDATE info_article_tasks SET gemini_cache_name = $2, updated_at = NOW() WHERE id = $1`,
          [taskId, created.name],
        );
        await appendLog(taskId, `💾 Gemini cachedContents создан (${created.name})`, 'ok');
      } catch (e) {
        await appendLog(taskId, `⚠ Gemini cachedContents не создался (${e.message}) — продолжаем без кэша`, 'warn');
        task.__geminiCacheName = null;
      }
    }

    // 9. Stage 3 writer
    await setStage(taskId, 'stage3_writer', 60);
    let { html: articleHtml, remainingIssues: writerIssues } = await runWriter(
      task,
      { audience, intents, whitespace, outline, lsi: lsiSet, linkPlan: planResult.link_plan },
      ctx,
    );
    if (!articleHtml) throw new Error('Gemini не сгенерировал статью (пустой article_html)');
    if (writerIssues.length) {
      await appendLog(taskId, `⚠ Остались ${writerIssues.length} замечаний после первичного writer`, 'warn');
    }

    // 10. Stage 5 (E-E-A-T) + Stage 5b (link audit) — параллельно
    await setStage(taskId, 'stage5_audits', 70);
    const [eeatAudit, linkAuditDet] = await Promise.all([
      runEeatAudit(task, audience, intents, lsiSet, articleHtml, ctx).catch((e) => {
        appendLog(taskId, `⚠ E-E-A-T аудит пропущен: ${e.message}`, 'warn').catch(() => {});
        return null;
      }),
      Promise.resolve(auditHtmlAgainstPlan({ html: articleHtml, link_plan: planResult.link_plan })),
    ]);

    let linkAudit = await runLinkAudit(articleHtml, planResult.link_plan, linkAuditDet, ctx)
      .catch(() => ({ ...linkAuditDet, semantic_violations: [], audit_notes: '' }));

    if (eeatAudit) {
      await db.query(
        `UPDATE info_article_tasks
            SET eeat_report = $2, eeat_score = $3, updated_at = NOW()
          WHERE id = $1`,
        [taskId, JSON.stringify(eeatAudit), eeatAudit.total_score],
      );
      await appendLog(
        taskId,
        `🧪 E-E-A-T: total=${eeatAudit.total_score.toFixed(1)} verdict=${eeatAudit.verdict} issues=${eeatAudit.issues.length}`,
        eeatAudit.verdict === 'pass' ? 'ok' : 'info',
      );
    }
    await saveColumn(taskId, 'link_audit', linkAudit);
    await appendLog(
      taskId,
      `🔍 Link audit: coverage=${linkAudit.coverage_pct}% inserted=${linkAudit.total_inserted}/${linkAudit.total_planned} verdict=${linkAudit.verdict}`,
      linkAudit.verdict === 'pass' ? 'ok' : 'info',
    );

    // LSI coverage measurement (программно)
    const lsiCov = measureLsiCoverageInHtml(articleHtml, lsiSet.important || []);
    await appendLog(taskId, `🔤 LSI coverage: ${lsiCov.coveragePct}% (${lsiCov.coveredCount}/${lsiCov.totalCount})`, 'info');

    // 11. Refine loop (≤ 1 retry)
    const eeatBelow      = eeatAudit && eeatAudit.total_score < INFO_ARTICLE_EEAT_TARGET;
    const linkBelow      = linkAudit && linkAudit.coverage_pct < 100;
    const lsiBelow       = lsiCov.coveragePct < INFO_ARTICLE_LSI_TARGET;
    const refineNeeded   = eeatBelow || linkBelow || lsiBelow;

    if (refineNeeded) {
      await setStage(taskId, 'stage3_writer_refine', 76);
      const linkIssues = [];
      if (linkBelow) {
        for (const m of linkAudit.missing.slice(0, 8)) {
          linkIssues.push(`MISSING: вставь <a href="${m.url}">${m.anchor_text}</a> в H2 #${m.h2_index}`);
        }
        for (const mp of linkAudit.misplacements.slice(0, 6)) {
          linkIssues.push(`MISPLACED: ссылка ${mp.url} стоит в H2 #${mp.actual_h2_index}, должна в #${mp.expected_h2_index}`);
        }
        for (const ex of linkAudit.extras.slice(0, 6)) {
          linkIssues.push(`EXTRA: убери ссылку ${ex.href} из H2 #${ex.h2_index} (нет в плане)`);
        }
      }
      if (lsiBelow) {
        const missingLsi = lsiCov.missing.slice(0, 14).join(', ');
        linkIssues.push(`LSI_MISSING: добавь органично термины — ${missingLsi}`);
      }
      await appendLog(
        taskId,
        `↻ Refine: eeat<${INFO_ARTICLE_EEAT_TARGET}=${!!eeatBelow}, links<100=${!!linkBelow}, lsi<${INFO_ARTICLE_LSI_TARGET}=${!!lsiBelow}`,
        'info',
      );
      const refined = await runWriter(
        task,
        { audience, intents, whitespace, outline, lsi: lsiSet, linkPlan: planResult.link_plan },
        ctx,
        {
          callLabel: 'InfoArticle Stage 3 (refine)',
          priorEeatIssues: eeatAudit ? eeatAudit.issues : null,
          priorLinkIssues: linkIssues,
        },
      );
      if (refined.html) {
        articleHtml = refined.html;
        // Re-audit best-effort.
        try {
          const reaudit = await runEeatAudit(task, audience, intents, lsiSet, articleHtml, ctx);
          await db.query(
            `UPDATE info_article_tasks
                SET eeat_report = $2, eeat_score = $3, updated_at = NOW()
              WHERE id = $1`,
            [taskId, JSON.stringify(reaudit), reaudit.total_score],
          );
          const linkAuditDet2 = auditHtmlAgainstPlan({ html: articleHtml, link_plan: planResult.link_plan });
          linkAudit = await runLinkAudit(articleHtml, planResult.link_plan, linkAuditDet2, ctx)
            .catch(() => ({ ...linkAuditDet2, semantic_violations: [], audit_notes: '' }));
          await saveColumn(taskId, 'link_audit', linkAudit);
          await appendLog(
            taskId,
            `🧪 Re-audit: eeat=${reaudit.total_score.toFixed(1)} link_coverage=${linkAudit.coverage_pct}%`,
            'info',
          );
        } catch (e) {
          await appendLog(taskId, `⚠ Re-audit не выполнился: ${e.message}`, 'warn');
        }
      }
    }

    // 12. Stage 4 image prompts
    await setStage(taskId, 'stage4_image_prompts', 84);
    const imagePrompts = await runImagePromptsGen(task, outline, articleHtml, audience, ctx);
    if (imagePrompts.length < 3) {
      await appendLog(taskId, `⚠ DeepSeek вернул только ${imagePrompts.length} image-промпта вместо 3`, 'warn');
    }
    await saveColumn(taskId, 'image_prompts', imagePrompts);

    // 13. Image generation
    await setStage(taskId, 'image_generation', 92);
    const renderedImages = await runImageGeneration(taskId, imagePrompts);
    await saveColumn(taskId, 'image_prompts', renderedImages);

    // 14. Embed + plain text
    const finalHtml  = embedImages(articleHtml, renderedImages);
    const finalPlain = buildPlainText(finalHtml);

    await db.query(
      `UPDATE info_article_tasks
          SET article_html  = $2,
              article_plain = $3,
              status        = 'done',
              progress_pct  = 100,
              current_stage = 'done',
              completed_at  = NOW(),
              updated_at    = NOW()
        WHERE id = $1`,
      [taskId, finalHtml, finalPlain],
    );
    await appendLog(taskId, '🎉 Информационная статья готова', 'ok');
    publishEvent(taskId, 'status', { status: 'done' });

    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
  } catch (err) {
    console.error(`[infoArticle] task ${taskId} failed:`, err);
    try {
      await db.query(
        `UPDATE info_article_tasks
            SET status = 'error', error_message = $2,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [taskId, err.message.slice(0, 1000)],
      );
      await appendLog(taskId, `❌ Ошибка: ${err.message}`, 'err');
      publishEvent(taskId, 'status', { status: 'error', error: err.message });
    } catch (_) { /* no-op */ }
  } finally {
    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
    IN_PROGRESS.delete(taskId);
    CURRENT_STAGE.delete(taskId);
  }
}

function cleanupGeminiCache(taskId, cacheName) {
  if (!cacheName) return;
  deleteCachedContent(cacheName).catch((e) =>
    console.warn(`[infoArticle] deleteCachedContent ${cacheName}: ${e.message}`));
  db.query(
    `UPDATE info_article_tasks SET gemini_cache_name = NULL, updated_at = NOW() WHERE id = $1`,
    [taskId],
  ).catch(() => {});
}

async function recoverStuckInfoArticleTasks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE info_article_tasks
          SET status = 'error',
              error_message = 'Сервер был перезапущен во время выполнения задачи',
              completed_at  = NOW(),
              updated_at    = NOW()
        WHERE status = 'running'`,
    );
    if (rowCount > 0) {
      console.log(`[infoArticle] Recovered ${rowCount} stuck running task(s)`);
    }
  } catch (err) {
    if (!/relation .* does not exist/i.test(err.message)) {
      console.warn('[infoArticle] recoverStuckInfoArticleTasks failed:', err.message);
    }
  }
}

module.exports = {
  processInfoArticleTask,
  recoverStuckInfoArticleTasks,
  INFO_ARTICLE_GEMINI_MODEL,
  INFO_ARTICLE_DEEPSEEK_MODEL,
};
