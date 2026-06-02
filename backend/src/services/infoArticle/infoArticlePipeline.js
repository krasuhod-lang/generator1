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
const { callLLM, resetTaskBudget } = require('../llm/callLLM');
const { loadInfoArticlePrompt } = require('../../prompts/infoArticle');
const { buildPersonaSystemBlock } = require('../../prompts/infoArticle/personas');
const { generateImage, IMAGE_PRICE_USD } = require('../linkArticle/nanoBananaPro.adapter');
const sse = require('../sse/sseManager');
const { createCachedContent, deleteCachedContent } = require('../llm/gemini.adapter');
const { normalizeGeminiCopywritingModel, DEFAULT_GEMINI_COPYWRITING_MODEL } = require('../llm/geminiModels');
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
const { synthesizeLsiSet, measureLsiCoverageInHtml, measureLsiCoverageSemantic } = require('./lsiPipeline');
const { checkLsiOverdose } = require('./lsiDensity.service');
const { planSemanticLinks, auditHtmlAgainstPlan } = require('./semanticLinkPlanner');
const { domainsFromLinks } = require('./excelParser');
const {
  buildSerpEvidence,
  renderEvidenceForPrompt,
} = require('./serpEvidence.service');
const { runFactCheck } = require('./factCheck.service');
const { runPlagiarismCheck } = require('./plagiarism.service');
const { runImageQa } = require('./imageQa.service');
const { analyzeReadability } = require('./readability.service');
const { verifyIntent } = require('./intentVerify.service');
const { createValidationTracker } = require('./validationFailures.service');
const { runEeatAuditCore } = require('../eeatAudit/core');
const { buildLsiDigestByWeight } = require('./eeatChunker');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const { recordQualityLog } = require('../aegis/qualityLogWriter');
const { resolvePromptHash } = require('../aegis/promptAudit');
const { getAegisFlags: _getAegisFlagsForWriter } = require('../aegis/featureFlags');

/**
 * B2: опциональная компрессия writer-промпта через aegis/promptCompressor.
 * Default OFF (см. AEGIS_INFO_WRITER_COMPRESS_PROMPT). Возвращает тот же текст
 * если флаг выключен, промпт короткий или compressor недоступен/упал.
 */
function _maybeCompressWriterPrompt(text) {
  try {
    const cfg = _getAegisFlagsForWriter().infoArticle;
    if (!cfg || !cfg.compressWriterPrompt) return text;
    if (!text || text.length < (cfg.writerCompressMinChars || 12000)) return text;
    const pc = require('../aegis/promptCompressor');
    if (!pc || typeof pc.compressPrompt !== 'function') return text;
    const res = pc.compressPrompt(text);
    if (res && !res.skipped && typeof res.text === 'string' && res.text.length < text.length) {
      try {
        const tel = require('../aegis/telemetry');
        if (tel && tel.M && tel.M.promptCompressSaved) {
          // приближённо: saved chars / 4 ≈ tokens (для русского/латиницы упрощение)
          const savedTokensApprox = Math.max(0, Math.floor((text.length - res.text.length) / 4));
          tel.M.promptCompressSaved.inc(savedTokensApprox, { stage: 'info_writer' });
        }
      } catch (_) { /* graceful */ }
      return res.text;
    }
  } catch (_) { /* graceful */ }
  return text;
}
const { finalizeByTask } = require('../aegis/backlogHooks');
const { createFunnelTracker } = require('../aegis/funnelTracker');
const biobrainClient = require('../aegis/biobrainClient');

// ── SERP-evidence grounding (Phase 1 / P0-2) ──────────────────────────
// Гейт. По умолчанию OFF — фундамент укладываем без изменения дефолтного
// поведения; включение прод-окружения — отдельным конфиг-PR после того,
// как будут готовы P0-1 (fact-check) и P0-3 (антиплагиат), которые тоже
// читают evidence. Включить локально: INFO_ARTICLE_GROUNDING_ENABLED=true.
const INFO_ARTICLE_GROUNDING_ENABLED =
  String(process.env.INFO_ARTICLE_GROUNDING_ENABLED || '').toLowerCase() === 'true';

// ── Fact-check verifier (Phase 1 / P0-1) ──────────────────────────────
// Детерминированный пост-аудит финального articleHtml против собранных
// SERP-evidence сниппетов. По умолчанию OFF; включается независимо от
// grounding-флага, но требует наличия task.__serpEvidence (иначе skip).
const INFO_ARTICLE_FACTCHECK_ENABLED =
  String(process.env.INFO_ARTICLE_FACTCHECK_ENABLED || '').toLowerCase() === 'true';

// ── Anti-plagiarism (Phase 1 / P0-3) ──────────────────────────────────
// Детерминированная сверка финального articleHtml с теми же
// SERP-evidence сниппетами по n-gram overlap. Цель — поймать прямые
// заимствования у конкурентов, особенно при включённом grounding'е,
// когда LLM может «срисовать» абзац вместо рерайта. По умолчанию OFF;
// требует наличия task.__serpEvidence (иначе skip).
const INFO_ARTICLE_PLAGIARISM_ENABLED =
  String(process.env.INFO_ARTICLE_PLAGIARISM_ENABLED || '').toLowerCase() === 'true';

// ── Image QA (Phase 1 / P0-4) ────────────────────────────────────────
// Детерминированный пост-аудит сгенерированных изображений: формат,
// размеры, аспект, дубли (sha256). Не требует SERP-evidence — никогда
// не делает сетевых запросов и не вызывает LLM. По умолчанию ON: чек
// безопасный, никогда не валит pipeline (только пишет отчёт + лог).
// Отключить: INFO_ARTICLE_IMAGE_QA_ENABLED=false.
const INFO_ARTICLE_IMAGE_QA_ENABLED =
  String(process.env.INFO_ARTICLE_IMAGE_QA_ENABLED || 'true').toLowerCase() === 'true';

// ── Phase 2 / Б4: Readability analyzer ──────────────────────────────
// Детерминированный программный аудит читабельности готовой статьи.
// Ничего не валит, только пишет отчёт + лог. Default ON (чек безопасный).
const INFO_ARTICLE_READABILITY_ENABLED =
  String(process.env.INFO_ARTICLE_READABILITY_ENABLED || 'true').toLowerCase() === 'true';

// ── Phase 2 / Б5: Intent verifier ───────────────────────────────────
// Сравнивает программно определённый интент финальной статьи с
// dominant_intent из competitor_signals.serp_intent (если статья
// привязана к relevance_report). Только soft-warning, никогда не валит.
const INFO_ARTICLE_INTENT_VERIFY_ENABLED =
  String(process.env.INFO_ARTICLE_INTENT_VERIFY_ENABLED || 'true').toLowerCase() === 'true';

// ── Phase 2 / Б2: Семантическая LSI-метрика ─────────────────────────
// Гибрид substring+stem-bigram cosine: уменьшает ложные corrective-retry
// для случаев, когда термин «семантически» в тексте есть, но точного
// substring-stem нет (синоним/переформулировка). По умолчанию OFF, чтобы
// не менять поведение существующих задач — включается одной env-переменной.
const INFO_ARTICLE_LSI_SEMANTIC_ENABLED =
  String(process.env.INFO_ARTICLE_LSI_SEMANTIC_ENABLED || '').toLowerCase() === 'true';
const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Config via env ───────────────────────────────────────────────────

const INFO_ARTICLE_GEMINI_MODEL =
  process.env.INFO_ARTICLE_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  DEFAULT_GEMINI_COPYWRITING_MODEL;

const INFO_ARTICLE_DEEPSEEK_MODEL =
  process.env.INFO_ARTICLE_DEEPSEEK_MODEL ||
  process.env.DEEPSEEK_MODEL ||
  'deepseek-chat';

const MAX_PARALLEL_IMAGES = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MAX_PARALLEL_IMAGES, 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
})();

// IMAGE_PRICE_USD пришёл из nanoBananaPro.adapter (см. там — единый
// источник истины с поддержкой NANO_BANANA_PRO_PRICE_USD env).

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
// Реестр воронок генерации по taskId — setStage() автоматически отмечает
// переход стадии в funnel.step(). Регистрируется в processInfoArticleTask.
const FUNNELS = new Map();

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
  const funnel = FUNNELS.get(taskId);
  if (funnel) { try { funnel.step(stageName); } catch (_e) { /* analytics must not break generation */ } }
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

  // image slots: для info-article генерируется ровно 1 cover-изображение
  // (см. runImagePromptsGen / runImageGeneration). В HTML картинка НЕ
  // встраивается (она остаётся в галерее результата для отдельной публикации
  // на сайт), поэтому никакие <!-- IMAGE_SLOT_N --> комментарии не требуются.

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

  // Authorial persona — детерминированно выбираем 1 из 7 готовых персон
  // (см. backend/src/prompts/infoArticle/personas.js). Цель: убрать
  // монотонный «LLM-стиль» и усилить anti-hallucination через жёсткие
  // правила, прописанные в каждой персоне. Persona одинакова для
  // повторных запусков одной задачи (hash от topic+region+brand) —
  // это важно для consistency cached response в Redis.
  let personaBlock = '';
  let personaKey   = '';
  try {
    const picked = buildPersonaSystemBlock({
      topic:  task.topic,
      region: task.region || '',
      brand:  task.brand_name || task.brand || '',
      persona: task.persona || '',
    });
    personaKey = picked.key;
    personaBlock = picked.block || '';
  } catch (e) {
    // Полный graceful — без персоны writer работает по-старому.
    personaBlock = '';
    if (ctx && typeof ctx.taskId !== 'undefined') {
      appendLog(ctx.taskId, `⚠ Persona pick failed: ${e.message}`, 'warn').catch(() => {});
    }
  }

  // System prompt: при активном Gemini cache — пусто (всё в кэше);
  // иначе — IAKB + writer-instructions + персона.
  const writerWithPersona = personaBlock
    ? `${writerInstructions}\n\n${personaBlock}`
    : writerInstructions;
  const systemFull = task.__iakb
    ? `${task.__iakb}\n\n========================================\n${writerWithPersona}`
    : writerWithPersona;
  const systemArg = task.__geminiCacheName ? '' : systemFull;

  if (personaKey && ctx && typeof ctx.taskId !== 'undefined') {
    appendLog(ctx.taskId, `🎭 Авторская персона: ${personaKey}`, 'info').catch(() => {});
  }

  const buildUser = (correctiveIssues = null, priorEeatIssues = null, priorLinkIssues = null) => {
    const noLinks = !Array.isArray(linkPlan) || linkPlan.length === 0;
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
    // Phase 1 / P0-2: SERP-evidence grounding.
    // Намеренно НЕ кладём evidence в IAKB (и тем более в Gemini cache) —
    // цель в том, чтобы writer видел свежие фрагменты топа на каждом
    // вызове (включая corrective retry), а кэш IAKB оставался стабильным
    // для других стадий. Если evidence отсутствует или пуст —
    // renderEvidenceForPrompt возвращает '', ничего не вставляем.
    const evidenceBlock = renderEvidenceForPrompt(task.__serpEvidence);
    if (evidenceBlock) {
      base.push('');
      base.push(evidenceBlock);
    }
    if (noLinks) {
      // Excel-база коммерческих ссылок не загружена → пишем статью без перелинковки.
      // Без этого маркера writer мог бы попытаться придумать фейковые href.
      base.push('');
      base.push('[NO_INTERLINKING_MODE]');
      base.push('  • Коммерческая Excel-база НЕ загружена → link_plan пуст.');
      base.push('  • НЕ вставляй ни одного <a href="…"> с коммерческой ссылкой.');
      base.push('  • Игнорируй пункты writer-промта про "вставь все picks", "1–2 ссылки на каждый <h2>",');
      base.push('    "all_planned_links_inserted" — они НЕ применимы в этом режиме.');
      base.push('  • В self_audit верни: all_planned_links_inserted=true, links_per_h2_within_bounds=true');
      base.push('    (оба true = «нечего нарушать»).');
      base.push('  • Все остальные требования (E-E-A-T, expert_opinion, FAQ, LSI) — в силе.');
    }
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
    return _maybeCompressWriterPrompt(base.join('\n'));
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
  // Phase 2 / Б1.2: подаём LSI-дайджест по весу (не по позиции),
  // без жёсткого среза 1500 символов — функция сама уложится в бюджет.
  const lsiDigest = buildLsiDigestByWeight(lsiSet, 4000);

  // Шаблон сборки user-prompt'а: используется для single-call И для
  // chunk-call'ов (Б1.1). В chunk-режиме article_html заменяется на
  // содержимое чанка с маркером h2_text.
  function buildUserText(htmlSlice, chunkInfo) {
    const articleField = chunkInfo
      ? `article_html (chunk ${chunkInfo.index + 1}: ${chunkInfo.h2_text}): ${htmlSlice}`
      : `article_html: ${htmlSlice}`;
    return [
      `[INPUTS]`,
      `topic: ${task.topic}`,
      `region: ${task.region || '[не задано]'}`,
      `brand_name: ${task.brand_name || '[авто]'}`,
      `audience_digest: ${JSON.stringify(audience).slice(0, 2500)}`,
      `intents_digest: ${JSON.stringify({
        user_questions: (intents && intents.user_questions) || [],
        entities: (intents && Array.isArray(intents.entities) ? intents.entities.slice(0, 12) : []),
      }).slice(0, 3500)}`,
      `lsi_set_digest: ${lsiDigest}`,
      articleField,
    ].join('\n');
  }

  // По-старому single-call (back-compat для коротких статей <=8kb).
  // Для длинных — chunked-режим (Б1.1) автоматически срабатывает в core.
  const callOptions = { retries: 3, temperature: 0.2, callLabel: 'InfoArticle Stage 5 (E-E-A-T audit)', ...ctx };
  return runEeatAuditCore({
    adapter:    'deepseek',
    system:     loadInfoArticlePrompt('stage5Eeat'),
    userText:   buildUserText(articleHtml.slice(0, 14000)), // single-call back-compat
    threshold:  INFO_ARTICLE_EEAT_TARGET,
    callOptions,
    chunkOpts: {
      html: articleHtml,
      buildChunkUserText: (chunk) => buildUserText(chunk.html, chunk),
    },
  });
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

async function runImagePromptsGen(task, outline, articleHtml, audience, ctx, imagesCount = 1) {
  const N = Math.max(1, Math.min(6, parseInt(imagesCount, 10) || 1));
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `region: ${task.region || '[не задано]'}`,
    `images_count_required: ${N}`,
    `audience_digest: ${JSON.stringify(audience).slice(0, 2000)}`,
    `stage2_outline: ${JSON.stringify(outline).slice(0, 6000)}`,
    `article_html: ${articleHtml.slice(0, 12000)}`,
    '',
    // Прокидываем количество прямо в user-промт. Stage 4 system-промт
    // знает про images_count_required (см. stage4_image_prompts.txt).
    // Если N=1 — поведение сохраняется (1 cover-слот). Если N>1 — модель
    // выдаёт slot=1 cover + slot=2..N inline-иллюстрации, привязанные к
    // конкретным H2 из outline (по target_section_index / section_h2).
    `Сгенерируй РОВНО ${N} image_prompts.`,
    N === 1
      ? `Это slot=1 cover (как раньше).`
      : `slot=1 — обложка (как раньше); slot=2..${N} — inline-иллюстрации, ` +
        `каждая привязана к УНИКАЛЬНОЙ H2 из stage2_outline (поле section_h2 ` +
        `должно совпадать с outline.sections[i].h2). Не дублируй секции.`,
  ].join('\n');
  const result = await callLLM(
    'deepseek',
    loadInfoArticlePrompt('stage4Images'),
    user,
    { retries: 3, temperature: 0.4, callLabel: `InfoArticle Stage 4 (${N} image prompts)`, ...ctx },
  );
  const prompts = Array.isArray(result?.image_prompts) ? result.image_prompts : [];
  // style_profile — общий для всей статьи выбор визуального стиля/формата
  // (stage4_image_prompts.txt оценивает тон статьи и подбирает стиль индивидуально).
  // Метку дублируем в каждый слот, чтобы все изображения статьи были в едином стиле.
  const styleProfile = result?.style_profile && typeof result.style_profile === 'object'
    ? result.style_profile
    : null;
  const styleLabel = String(styleProfile?.style_label || '').slice(0, 120);
  if (task?.id && styleLabel) {
    await appendLog(
      task.id,
      `🎨 Стиль изображений подобран под статью: «${styleLabel}»` +
        (styleProfile?.rationale ? ` — ${String(styleProfile.rationale).slice(0, 200)}` : ''),
      'info',
    );
  }
  // Берём первые N, перенумеровываем slot=1..N. Если LLM вернул меньше — сколько
  // прислал. Дубль section_h2 (один и тот же H2 в нескольких inline-слотах)
  // схлопываем, сохраняя первый.
  const seenH2 = new Set();
  const normalized = [];
  for (const p of prompts) {
    if (normalized.length >= N) break;
    const h2 = String(p?.section_h2 || '').slice(0, 200);
    // slot=1 — cover, ему дубль H2 не страшен; для slot>=2 требуем уникальности.
    if (normalized.length >= 1 && h2 && seenH2.has(h2.toLowerCase())) continue;
    if (h2) seenH2.add(h2.toLowerCase());
    normalized.push({
      slot:            normalized.length + 1,
      section_h2:      h2,
      style_label:     String(p?.style_label || styleLabel || '').slice(0, 120),
      visual_prompt:   String(p?.visual_prompt   || '').slice(0, 2000),
      negative_prompt: String(p?.negative_prompt || '').slice(0, 400),
      alt_ru:          String(p?.alt_ru          || '').slice(0, 200),
      status:          'pending',
      image_base64:    null,
      mime_type:       null,
      error:           null,
    });
  }
  return normalized;
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
  // info-article: cover-изображение встраивается в article_html сразу после <h1>
  // (если оно сгенерировалось успешно), чтобы при копировании HTML / форматированного
  // текста картинка уезжала вместе со статьёй (как в link-article).
  //
  // С приходом многослотовой генерации (D, миграция 022) поведение расширено:
  //   • slot=1 (cover) — после </h1>, как и раньше;
  //   • slot=2..N (inline) — перед целевым <h2>, чей текст совпадает с
  //     image_prompts[i].section_h2 (case-insensitive, без знаков). Если
  //     ни один h2 не совпал — слот молча пропускается (остаётся в галерее
  //     отдельно как download-файл, чтобы пользователь мог вставить вручную).
  //
  // Защита от двойной вставки сохранена для cover: если writer всё-таки
  // вставил <img>/<figure> в начале статьи — cover повторно не добавляем.
  let out = String(html || '');
  out = out.replace(/<!--\s*IMAGE_SLOT_\d+\s*-->/gi, '');
  out = out.replace(/<p>\s*<\/p>/gi, '');

  const ready = Array.isArray(imagePrompts)
    ? imagePrompts.filter((p) => p && p.status === 'done' && p.image_base64)
    : [];
  if (!ready.length) return out;

  // Сортируем по slot — slot=1 (cover) идёт первым.
  ready.sort((a, b) => (a.slot || 1) - (b.slot || 1));

  const buildFigure = (p, klass) => {
    const alt  = escapeHtml(p.alt_ru || '');
    const mime = p.mime_type || 'image/png';
    return `<figure class="${klass}">` +
      `<img src="data:${mime};base64,${p.image_base64}" alt="${alt}" />` +
      `</figure>`;
  };

  // ── 1) Cover (slot=1 / первый). ───────────────────────────────────
  const cover = ready.find((p) => (p.slot || 1) === 1) || ready[0];
  const coverIsFirst = cover === ready[0];
  if (coverIsFirst && !/<img\b|<figure\b/i.test(out)) {
    const figure = buildFigure(cover, 'info-article-cover');
    const h1Re = /<\/h1\s*>/i;
    if (h1Re.test(out)) {
      out = out.replace(h1Re, (match) => `${match}\n${figure}`);
    } else {
      out = `${figure}\n${out}`;
    }
  }

  // ── 2) Inline-иллюстрации (slot >= 2). ────────────────────────────
  // Канонизация заголовка для match'а: lowercase, без HTML-сущностей,
  // только буквы/цифры/пробелы. Совпадение по равенству или contains
  // (LLM иногда даёт укороченную/переформулированную версию H2).
  const canon = (s) => String(s || '')
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[^а-яa-z0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Собираем индекс всех <h2>…</h2> с их позициями (start = индекс начала тега).
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
  const h2List = [];
  let m;
  // Извлекаем «голый» текст H2: убираем все вложенные теги. Делаем это
  // в цикле до стабилизации (как в buildPlainText) — на случай вложенных
  // или склеенных конструкций вида "<<a></a>script>", чтобы поведение
  // не зависело от того, как именно writer оформил <h2>. Текст никогда не
  // вставляется обратно в HTML — используется только для canon-сравнения.
  const stripTags = (s) => {
    let cur = String(s || '');
    for (let i = 0; i < 5; i += 1) {
      const next = cur.replace(/<[^>]+>/g, '');
      if (next === cur) break;
      cur = next;
    }
    return cur;
  };
  while ((m = h2Re.exec(out)) !== null) {
    const inner = stripTags(m[1]);
    h2List.push({ start: m.index, text: inner, canon: canon(inner) });
  }
  if (!h2List.length) return out;

  // Накапливаем правки, применяем от конца к началу — чтобы позиции не «съезжали».
  const edits = [];
  const usedH2 = new Set();
  for (const p of ready) {
    if ((p.slot || 1) === 1) continue; // cover уже вставлен
    const target = canon(p.section_h2);
    if (!target) continue;
    let h2 = h2List.find((h, idx) => !usedH2.has(idx) && h.canon === target);
    if (!h2) {
      // fallback: contains-match (target внутри h2 или наоборот).
      const idx = h2List.findIndex((h, i) => !usedH2.has(i)
        && (h.canon.includes(target) || target.includes(h.canon)));
      if (idx >= 0) h2 = h2List[idx];
    }
    if (!h2) continue;
    const h2Index = h2List.indexOf(h2);
    usedH2.add(h2Index);
    edits.push({ pos: h2.start, insertText: `${buildFigure(p, 'info-article-inline')}\n` });
  }
  edits.sort((a, b) => b.pos - a.pos);
  for (const ed of edits) {
    out = out.slice(0, ed.pos) + ed.insertText + out.slice(ed.pos);
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

/**
 * injectMissingLinks — детерминированный пост-инжектор коммерческих ссылок.
 *
 * Контекст: writer (Gemini) + один corrective-retry не дают 100% покрытия
 * link_plan: на 3-4 ссылки на статью одна-две регулярно «теряются». Чтобы
 * заказчик видел стабильную перелинковку из своего Excel-файла, мы добавляем
 * детерминированную страховку: для каждой ссылки из linkAudit.missing
 * программно вставляем `<a href="URL">anchor_text</a>` в нужный H2-сегмент.
 *
 * Стратегия вставки (несколько уровней fallback'a, чтобы coverage стремился к 100%):
 *   1. Находим границы целевой H2-секции (от <h2 ...> до следующего <h2> или
 *      конца документа), используя НЕ-greedy сегментацию идентичную
 *      auditHtmlAgainstPlan.
 *   2. Если в секции есть <p>...</p> — вставляем перед закрывающим </p>
 *      аккуратную внутри-предложенческую сноску " (см. также <a>anchor_text</a>)".
 *   3. Если <p> нет, но есть <li>...</li> (например, в секции только список) —
 *      вставляем сноску перед закрывающим </li> первого элемента.
 *   4. Если ни <p>, ни <li> в секции нет — дописываем новый
 *      <p>См. также: <a>anchor_text</a>.</p> в конец секции (перед следующим <h2>).
 *      Это гарантирует, что coverage всегда достигает 100% при любой структуре writer'а.
 *
 * Анкер escape-им на случай служебных символов; URL — атрибут-escape.
 *
 * @param {string} html
 * @param {Array<{h2_index, url, anchor_text}>} missing
 * @returns {{ html: string, injected: number, skipped: Array<{h2_index, url, anchor_text, reason: string}> }}
 *   html: финальный HTML с дописанными ссылками;
 *   injected: количество фактически вставленных <a>-тегов;
 *   skipped: пропуски с причиной (no_segments / h2_index_out_of_range — реальные
 *     аномалии плана; «нет контента в секции» больше не приводит к пропуску).
 */
function injectMissingLinks(html, missing) {
  if (typeof html !== 'string' || !html || !Array.isArray(missing) || !missing.length) {
    return { html: html || '', injected: 0, skipped: [] };
  }

  // Сегментация по <h2>: тождественна auditHtmlAgainstPlan, поэтому индексы
  // h2_index согласованы.
  const segRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi;
  const segments = [];
  let m;
  let idx = 0;
  while ((m = segRe.exec(html)) !== null) {
    idx += 1;
    segments.push({
      index: idx,
      bodyStart: m.index + m[0].length - m[2].length,
      bodyEnd:   m.index + m[0].length,
    });
  }
  if (!segments.length) return { html, injected: 0, skipped: missing.map((mm) => ({ ...mm, reason: 'no_segments' })) };

  // Группируем missing по h2_index, чтобы при множественных пропусках в одном
  // <h2> вставлять последовательно (offset-сейф через массив правок).
  const byIdx = new Map();
  for (const miss of missing) {
    if (!miss || !miss.url) continue;
    const i = Number(miss.h2_index);
    if (!Number.isInteger(i) || i < 1) continue;
    const arr = byIdx.get(i) || [];
    arr.push(miss);
    byIdx.set(i, arr);
  }

  // Собираем правки [{ pos, insertText }] и применяем за один проход справа-налево.
  const edits = [];
  const skipped = [];
  for (const [h2Idx, list] of byIdx) {
    const seg = segments[h2Idx - 1];
    if (!seg) {
      for (const miss of list) skipped.push({ ...miss, reason: 'h2_index_out_of_range' });
      continue;
    }
    const segHtml = html.slice(seg.bodyStart, seg.bodyEnd);

    // Сборка фразы-сноски и фразы-нового-параграфа.
    const phrases = list.map((miss) => {
      const anchor = String(miss.anchor_text || '').trim() || 'подробнее';
      const url = String(miss.url || '').trim();
      return ` (см. также <a href="${escapeHtml(url)}">${escapeHtml(anchor)}</a>)`;
    });
    const standaloneAnchors = list.map((miss) => {
      const anchor = String(miss.anchor_text || '').trim() || 'подробнее';
      const url = String(miss.url || '').trim();
      return `<a href="${escapeHtml(url)}">${escapeHtml(anchor)}</a>`;
    });

    // Уровень 1: первый <p> в секции — вставляем сноску перед </p>.
    const pMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(segHtml);
    if (pMatch) {
      const closeRel = pMatch.index + pMatch[0].lastIndexOf('</p>');
      const closeAbs = seg.bodyStart + closeRel;
      edits.push({ pos: closeAbs, insertText: phrases.join('') });
      continue;
    }

    // Уровень 2: первый <li> в секции — вставляем сноску перед </li>.
    const liMatch = /<li\b[^>]*>([\s\S]*?)<\/li>/i.exec(segHtml);
    if (liMatch) {
      const closeRel = liMatch.index + liMatch[0].lastIndexOf('</li>');
      const closeAbs = seg.bodyStart + closeRel;
      edits.push({ pos: closeAbs, insertText: phrases.join('') });
      continue;
    }

    // Уровень 3 (последний): дописываем новый <p> в конец секции —
    // прямо перед следующим <h2> (или концом документа).
    const newP = `\n<p>См. также: ${standaloneAnchors.join(', ')}.</p>\n`;
    edits.push({ pos: seg.bodyEnd, insertText: newP });
  }

  // Применяем правки от конца к началу, чтобы сохранить позиции.
  edits.sort((a, b) => b.pos - a.pos);
  let out = html;
  let injected = 0;
  for (const ed of edits) {
    out = out.slice(0, ed.pos) + ed.insertText + out.slice(ed.pos);
    // insertText может содержать несколько <a> — считаем по числу <a>
    injected += (ed.insertText.match(/<a\b/g) || []).length;
  }

  return { html: out, injected, skipped };
}

// ── Main entrypoint ──────────────────────────────────────────────────

async function processInfoArticleTask(taskId) {
  if (IN_PROGRESS.has(taskId)) return;
  IN_PROGRESS.add(taskId);
  let geminiCacheName = null;
  let funnel = null;

  try {
    const { rows } = await db.query(`SELECT * FROM info_article_tasks WHERE id = $1`, [taskId]);
    const task = rows[0];
    if (!task) { console.error(`[infoArticle] task ${taskId} not found`); return; }

    funnel = createFunnelTracker({ kind: 'info_article', taskRef: taskId, userId: task.user_id, niche: task.topic || null });
    FUNNELS.set(taskId, funnel);

    await db.query(
      `UPDATE info_article_tasks
          SET status = 'running', started_at = COALESCE(started_at, NOW()),
              progress_pct = 1, error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [taskId],
    );
    publishEvent(taskId, 'status', { status: 'running' });
    await appendLog(taskId, '🚀 Старт генерации информационной статьи в блог', 'ok');

    // ── Опционально загружаем привязанный отчёт релевантности ──────────
    // Если пользователь нажал «Создать контент» из раздела «Релевантность»,
    // у задачи будет source_relevance_report_id (миграция 022). Из отчёта
    // берём competitor_signals (Wave 1 — title-template, schema.org,
    // freshness, trust-links, anchor-bank, host-hygiene + effort_score)
    // и вливаем в IAKB §9 — Gemini-writer увидит требования топа как
    // hard-constraints. Без отчёта (старые задачи) поле = null, секция §9
    // не рендерится и pipeline идёт «как раньше».
    let relevanceSignals = null;
    let relevanceContext = null;  // 2026-05: расширенный контекст (LSI/ngrams/headings/schema/VoC) для §9b IAKB
    let relevanceArtifact = null; // 2026-05/Sprint B: единый нормализованный артефакт relevance
    if (task.source_relevance_report_id) {
      try {
        const { loadArtifact } = require('../relevance/relevanceArtifacts');
        relevanceArtifact = await loadArtifact(db, {
          reportId: task.source_relevance_report_id,
          userId: task.user_id,
        });
        if (relevanceArtifact) {
          relevanceSignals = relevanceArtifact.competitor_signals || null;
          relevanceContext = {
            important_lsi:  relevanceArtifact.important_lsi,
            additional_lsi: relevanceArtifact.additional_lsi,
            top_ngrams:     relevanceArtifact.top_ngrams,
            shared_headings: relevanceArtifact.shared_headings,
            mandatory_entities: relevanceArtifact.mandatory_entities,
            schema_recommendation_markdown: relevanceArtifact.schema_recommendation_markdown,
            voice_of_customer: relevanceArtifact.voice_of_customer,
            our_url: relevanceArtifact.our_url,
          };
          if (relevanceSignals) {
            await appendLog(
              taskId,
              `🎯 Подключён competitor_signals из relevance_report (${task.source_relevance_report_id.slice(0, 8)}…) — уйдёт в IAKB §9`,
              'info',
            );
          } else {
            await appendLog(taskId, `⚠ relevance_report без competitor_signals — пропускаем`, 'warn');
          }
          await appendLog(
            taskId,
            `📚 §9b: важных LSI=${relevanceArtifact.important_lsi.length}, доп=${relevanceArtifact.additional_lsi.length}, ngrams=${relevanceArtifact.top_ngrams.length}, headings=${relevanceArtifact.shared_headings.length}, h2=${relevanceArtifact.h2_drafts.length}, h3=${relevanceArtifact.h3_drafts.length}` +
            (relevanceArtifact.schema_recommendation_markdown ? ', schema-summary=да' : ''),
            'info',
          );
          // Прокидываем артефакт в task, чтобы стадии (structure/LSI/links)
          // могли использовать h2_drafts/h3_drafts и top_ngrams напрямую.
          task.__relevanceArtifact = relevanceArtifact;
        } else {
          await appendLog(taskId, `⚠ relevance_report не найден или не done — продолжаем без него`, 'warn');
        }
      } catch (relErr) {
        await appendLog(taskId, `⚠ relevance_report: ошибка загрузки (${relErr.message}) — продолжаем без него`, 'warn');
      }
    }

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
    //
    // Если пользователь не загрузил Excel — task.commercial_links будет [].
    // planSemanticLinks fail-safe возвращает пустой link_plan (см. early-exit
    // на empty_shortlists), статья создаётся в режиме «без перелинковки»:
    // Stage 5b пропускается, writer не вставляет коммерческих <a>-ссылок.
    await setStage(taskId, 'stage2c_link_plan', 52);
    const links = Array.isArray(task.commercial_links) ? task.commercial_links : [];
    const noInterlinking = links.length === 0;
    if (noInterlinking) {
      await appendLog(
        taskId,
        '🚫 Excel-база не загружена → статья будет сгенерирована БЕЗ перелинковки (Stage 2C/5b пропускаются)',
        'info',
      );
    }
    const planResult = noInterlinking
      ? {
          link_plan: [],
          graph_pattern: { url_usage_count: {} },
          deterministic_audit: { mode: 'no_interlinking' },
          shortlistByH2: {},
        }
      : await planSemanticLinks({
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
    const corridor = audit.corridor || {};
    await appendLog(
      taskId,
      `🔗 Link planner: ${totalPlanned} ссылок на ${planResult.link_plan.length} H2 ` +
      `(коридор ${corridor.totalMin ?? '?'}..${corridor.totalMax ?? '?'} ` +
      `target=${corridor.target ?? '?'} mode=${corridor.mode || '?'} ~${corridor.estimatedChars || 0} симв.; ` +
      `ok: min=${audit.total_min_ok ? 'да' : 'нет'}, max=${audit.total_max_ok ? 'да' : 'нет'}), ` +
      `unique URLs=${Object.keys(planResult.graph_pattern.url_usage_count || {}).length}`,
      'ok',
    );

    // 8. Build IAKB + optional Gemini cachedContents
    task.__iakb = buildInfoArticleKnowledgeBase({
      task, strategy, audience, intents, whitespace, outline, lsi: lsiSet, linkPlan: planResult.link_plan,
      relevanceSignals,
      relevanceContext,
    });
    await appendLog(taskId, `🧠 IAKB собрана (${task.__iakb.length} символов)`, 'info');

    // 8.5. SERP-evidence grounding (Phase 1 / P0-2). Гейтировано env'ом
    // INFO_ARTICLE_GROUNDING_ENABLED (default OFF). Не валит pipeline ни при
    // каких сбоях — graceful: при ошибке task.__serpEvidence = null,
    // writer-промт получит на 1 блок меньше.
    task.__serpEvidence = null;
    if (INFO_ARTICLE_GROUNDING_ENABLED) {
      try {
        await setStage(taskId, 'stage2d_grounding', 56);
        const evidenceResult = await buildSerpEvidence({
          query:  task.topic,
          region: task.region || '',
          brand:  task.brand_name || task.brand || '',
          logger: (msg, level) => { appendLog(taskId, msg, level || 'info').catch(() => {}); },
        });
        if (evidenceResult && Array.isArray(evidenceResult.evidence) && evidenceResult.evidence.length) {
          task.__serpEvidence = evidenceResult;
          await appendLog(
            taskId,
            `📚 SERP-evidence: ${evidenceResult.evidence.length} URL × до ${evidenceResult.stats.top_k || '?'} сниппетов ` +
            `(${evidenceResult.stats.snippet_count} всего, ${evidenceResult.stats.duration_ms} мс, ` +
            `cache=${evidenceResult.stats.cache_hit ? 'hit' : 'miss'})`,
            'ok',
          );
          if (Array.isArray(evidenceResult.warnings) && evidenceResult.warnings.length) {
            await appendLog(taskId, `⚠ SERP-evidence warnings: ${evidenceResult.warnings.join('; ')}`, 'warn');
          }
        } else {
          const warns = (evidenceResult && evidenceResult.warnings) || [];
          await appendLog(
            taskId,
            `⚠ SERP-evidence пуст (warnings: ${warns.join('; ') || 'unknown'}) — writer без grounding`,
            'warn',
          );
        }
      } catch (groundingErr) {
        await appendLog(
          taskId,
          `⚠ SERP-evidence не собран: ${groundingErr.message} — writer продолжит без grounding`,
          'warn',
        );
      }
    }

    if (INFO_ARTICLE_GEMINI_CACHE_ENABLED) {
      try {
        const writerInstructions = loadInfoArticlePrompt('stage3');
        // Включаем персону в Gemini cached prefix, чтобы тон writer'а
        // оставался стабильным при cache-hit и совпадал с системой,
        // которую видит non-cache путь в runWriter. Cache привязан к задаче
        // (taskId), а персона детерминирована от task.topic+region+brand —
        // поэтому персона в cache соответствует runWriter 1-в-1.
        let personaForCache = '';
        try {
          const picked = buildPersonaSystemBlock({
            topic:  task.topic,
            region: task.region || '',
            brand:  task.brand_name || task.brand || '',
            persona: task.persona || '',
          });
          personaForCache = picked.block || '';
        } catch (_) { personaForCache = ''; }
        const writerWithPersona = personaForCache
          ? `${writerInstructions}\n\n${personaForCache}`
          : writerInstructions;
        const cacheText = `${task.__iakb}\n\n========================================\n${writerWithPersona}`;
        const created = await createCachedContent({
          systemInstruction: cacheText,
          ttlSeconds: INFO_ARTICLE_GEMINI_CACHE_TTL_S,
          model: normalizeGeminiCopywritingModel(task.gemini_model),
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
    // Phase 2 / С1: трекер регрессий валидатора writer'а. Записываем
    // remainingIssues после каждого прохода, в конце сохраняем агрегат
    // в info_article_tasks.validation_report.
    const validationTracker = createValidationTracker();
    let { html: articleHtml, remainingIssues: writerIssues } = await runWriter(
      task,
      { audience, intents, whitespace, outline, lsi: lsiSet, linkPlan: planResult.link_plan },
      ctx,
    );
    if (!articleHtml) throw new Error('Gemini не сгенерировал статью (пустой article_html)');
    validationTracker.recordPass('writer_initial', writerIssues);
    if (writerIssues.length) {
      await appendLog(taskId, `⚠ Остались ${writerIssues.length} замечаний после первичного writer`, 'warn');
    }
    let bioFastReject = false;
    let bioFeatures = null;
    try {
      const br = await biobrainClient.predict({ text: articleHtml, features: null });
      if (br.ok && br.body) {
        const score = Number(br.body.score);
        const gate = br.body.gate || 'pass';
        bioFastReject = gate === 'fast_reject';
        // Запоминаем точный вектор признаков, на котором мозг сделал
        // прогноз, чтобы обучить его на ТОМ ЖЕ векторе по реальному SPQ
        // (закрываем цикл predict → реальный исход → feedback).
        if (Array.isArray(br.body.features)) bioFeatures = br.body.features;
        try { require('../aegis/telemetry').recordBiobrainPrediction({ gate }); } catch (_) {}
        const advice = Array.isArray(br.body.advice) ? br.body.advice : [];
        await appendLog(
          taskId,
          `🧬 BioBrain: score=${Number.isFinite(score) ? score.toFixed(3) : '—'} gate=${gate}` +
            (advice.length ? ` · совет: ${advice[0]}` : ''),
          bioFastReject ? 'warn' : 'info',
        );
      }
    } catch (_) { /* best-effort */ }
    // Делаем захваченный вектор доступным на этапе feedback (ниже по пайплайну).
    task.__bioFeatures = bioFeatures;

    // 10. Stage 5 (E-E-A-T) + Stage 5b (link audit) — параллельно.
    // Stage 5b пропускается, если link_plan пуст (режим «без перелинковки») —
    // нечего проверять, deterministic-аудит даёт coverage_pct=100.
    await setStage(taskId, 'stage5_audits', 70);
    const [eeatAudit, linkAuditDet] = await Promise.all([
      runEeatAudit(task, audience, intents, lsiSet, articleHtml, ctx).catch((e) => {
        appendLog(taskId, `⚠ E-E-A-T аудит пропущен: ${e.message}`, 'warn').catch(() => {});
        return null;
      }),
      Promise.resolve(auditHtmlAgainstPlan({ html: articleHtml, link_plan: planResult.link_plan })),
    ]);

    let linkAudit = noInterlinking
      ? { ...linkAuditDet, semantic_violations: [], audit_notes: 'Режим без перелинковки: link_plan пуст, аудит пропущен.' }
      : await runLinkAudit(articleHtml, planResult.link_plan, linkAuditDet, ctx)
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

    // LSI coverage measurement (программно).
    // Phase 2 / Б2: гибрид substring+семантика. Если включён флаг —
    // используем семантический коверидж для триггера refine. Substring
    // coverage всё равно считаем для лога (для прозрачности).
    const lsiCovSubstring = measureLsiCoverageInHtml(articleHtml, lsiSet.important || []);
    let lsiCov = lsiCovSubstring;
    let lsiSemantic = null;
    if (INFO_ARTICLE_LSI_SEMANTIC_ENABLED) {
      lsiSemantic = measureLsiCoverageSemantic(articleHtml, lsiSet.important || []);
      lsiCov = lsiSemantic; // используем для триггера refine
      await appendLog(
        taskId,
        `🔤 LSI coverage (semantic): ${lsiSemantic.coveragePct}% ` +
        `(substring=${lsiSemantic.substring_covered}, semantic=${lsiSemantic.semantic_covered}, ` +
        `miss=${lsiSemantic.missing.length}; substring-only=${lsiCovSubstring.coveragePct}%)`,
        'info',
      );
    } else {
      await appendLog(taskId, `🔤 LSI coverage: ${lsiCov.coveragePct}% (${lsiCov.coveredCount}/${lsiCov.totalCount})`, 'info');
    }

    // 11. Refine loop (≤ 1 retry)
    const eeatBelow      = eeatAudit && eeatAudit.total_score < INFO_ARTICLE_EEAT_TARGET;
    const linkBelow      = linkAudit && linkAudit.coverage_pct < 100;
    const lsiBelow       = lsiCov.coveragePct < INFO_ARTICLE_LSI_TARGET;
    const refineNeeded   = eeatBelow || linkBelow || lsiBelow || bioFastReject;

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
          priorLinkIssues: bioFastReject
            ? [...linkIssues, 'BIO_FAST_REJECT: переработай текст с более чёткой структурой, фактами и сигналами доверия']
            : linkIssues,
        },
      );
      // Phase 2 / С1: фиксируем результат refine-прохода в трекере регрессий.
      validationTracker.recordPass('writer_refine', refined.remainingIssues || []);
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
          linkAudit = noInterlinking
            ? { ...linkAuditDet2, semantic_violations: [], audit_notes: 'Режим без перелинковки: link_plan пуст, аудит пропущен.' }
            : await runLinkAudit(articleHtml, planResult.link_plan, linkAuditDet2, ctx)
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

    // 11b. Детерминированная пост-инъекция пропущенных коммерческих ссылок.
    //      Writer + 1 corrective-retry не дают 100% покрытия в ~10-20% случаев
    //      (LLM иногда «забывает» вставить 1-2 ссылки). Чтобы заказчик видел
    //      стабильную перелинковку из своего Excel-файла, программно дописываем
    //      пропущенные ссылки в нужный <h2>-сегмент. Делаем это ТОЛЬКО при
    //      noInterlinking=false и наличии linkAudit.missing.
    if (!noInterlinking && Array.isArray(linkAudit?.missing) && linkAudit.missing.length) {
      const inj = injectMissingLinks(articleHtml, linkAudit.missing);
      if (inj.injected > 0) {
        articleHtml = inj.html;
        await appendLog(
          taskId,
          `🔧 Программная инъекция: вставлено ${inj.injected} пропущенных ссылок` +
            (inj.skipped.length ? ` (пропущено ${inj.skipped.length}: ${inj.skipped.map((s) => s.reason).join(',')})` : ''),
          'ok',
        );
        // Re-audit, чтобы пользователь видел финальное coverage_pct=100.
        const reauditDet = auditHtmlAgainstPlan({ html: articleHtml, link_plan: planResult.link_plan });
        linkAudit = {
          ...reauditDet,
          semantic_violations: linkAudit.semantic_violations || [],
          audit_notes: (typeof linkAudit.audit_notes === 'string' && linkAudit.audit_notes
            ? linkAudit.audit_notes + ' '
            : '') + 'После детерминированной инъекции пропущенных ссылок.',
        };
        await saveColumn(taskId, 'link_audit', linkAudit);
      } else if (inj.skipped.length) {
        await appendLog(
          taskId,
          `⚠ Не удалось дописать ${inj.skipped.length} пропущенных ссылок (нет <p> в целевой H2-секции)`,
          'warn',
        );
      }
    }

    // 11c. Детерминированный fact-check (Phase 1 / P0-1).
    //      Гейтировано env'ом INFO_ARTICLE_FACTCHECK_ENABLED (default OFF) +
    //      требует, чтобы grounding отработал и собрал evidence (иначе нечего
    //      сверять). Не валит pipeline ни при каких сбоях — graceful warn.
    if (INFO_ARTICLE_FACTCHECK_ENABLED && task.__serpEvidence) {
      try {
        const factCheck = runFactCheck(articleHtml, task.__serpEvidence);
        await saveColumn(taskId, 'fact_check_report', factCheck);
        const s = factCheck.summary;
        const verdictIcon = s.verdict === 'pass' ? '✅'
          : s.verdict === 'review' ? '⚠'
          : s.verdict === 'na' ? 'ℹ'
          : '❌';
        await appendLog(
          taskId,
          `${verdictIcon} Fact-check: claims=${s.total} ` +
          `(supported=${s.supported}/${s.supportedPct}%, partial=${s.partial}, unsupported=${s.unsupported}) ` +
          `verdict=${s.verdict}`,
          s.verdict === 'pass' || s.verdict === 'na' ? 'ok' : 'info',
        );
        if (factCheck.top_unsupported.length > 0) {
          const sample = factCheck.top_unsupported.slice(0, 3)
            .map((c) => `«${c.text.slice(0, 120)}…»`).join(' | ');
          await appendLog(
            taskId,
            `🔎 Fact-check: ${factCheck.top_unsupported.length} утверждений без подтверждения в SERP-evidence. Примеры: ${sample}`,
            'warn',
          );
        }
      } catch (factCheckErr) {
        await appendLog(
          taskId,
          `⚠ Fact-check не выполнился: ${factCheckErr.message} — продолжаем без отчёта`,
          'warn',
        );
      }
    }

    // 11d. Детерминированная анти-плагиат проверка (Phase 1 / P0-3).
    //      Гейт INFO_ARTICLE_PLAGIARISM_ENABLED (default OFF) + наличие
    //      task.__serpEvidence (иначе skip). Greedy n-gram overlap по тем
    //      же сниппетам, что использовал writer для grounding'а — ловим
    //      буквальные заимствования. Никогда не валит pipeline.
    if (INFO_ARTICLE_PLAGIARISM_ENABLED && task.__serpEvidence) {
      try {
        const plag = runPlagiarismCheck(articleHtml, task.__serpEvidence);
        await saveColumn(taskId, 'plagiarism_report', plag);
        const ps = plag.summary;
        const verdictIcon = ps.verdict === 'pass' ? '✅'
          : ps.verdict === 'review' ? '⚠'
          : ps.verdict === 'na' ? 'ℹ'
          : '❌';
        await appendLog(
          taskId,
          `${verdictIcon} Plagiarism: sentences=${ps.scoredSentences}/${ps.totalSentences} ` +
          `(clean=${ps.cleanCount}, suspicious=${ps.suspiciousCount}, plagiarism=${ps.plagiarismCount}) ` +
          `overlap_total=${ps.overlapPctTotal}% verdict=${ps.verdict}`,
          ps.verdict === 'pass' || ps.verdict === 'na' ? 'ok' : 'info',
        );
        if (plag.top_sentences.length > 0) {
          const sample = plag.top_sentences.slice(0, 2)
            .map((s) => `«${s.text.slice(0, 100)}…» (${Math.round(s.overlapPct * 100)}%, ${s.donors[0]?.url || '?'})`)
            .join(' | ');
          await appendLog(
            taskId,
            `🔎 Plagiarism: top-${Math.min(2, plag.top_sentences.length)} проблемных предложений: ${sample}`,
            'warn',
          );
        }
      } catch (plagErr) {
        await appendLog(
          taskId,
          `⚠ Plagiarism-check не выполнился: ${plagErr.message} — продолжаем без отчёта`,
          'warn',
        );
      }
    }

    // 11e. Phase 2 / Б4: Readability analyzer (детерминированный).
    //      Гейт INFO_ARTICLE_READABILITY_ENABLED (default ON). Безопасный
    //      программный чек: считает индекс Флеша-Тулдавы для русского,
    //      долю длинных предложений, канцелярит, пассив. Soft-warning,
    //      никогда не валит pipeline.
    if (INFO_ARTICLE_READABILITY_ENABLED) {
      try {
        const readability = analyzeReadability(articleHtml);
        await saveColumn(taskId, 'readability_report', readability);
        const m = readability.metrics || {};
        const verdictIcon = readability.verdict === 'pass' ? '✅'
          : readability.verdict === 'review' ? '⚠'
          : readability.verdict === 'refine' ? '❌'
          : 'ℹ';
        await appendLog(
          taskId,
          `${verdictIcon} Readability: flesch=${m.flesch_index} avg_sent=${m.avg_sentence_words}w ` +
          `passive=${m.passive_pct}% bureaucratese=${m.bureaucratese_pct}% verdict=${readability.verdict}`,
          readability.verdict === 'pass' ? 'ok' : 'info',
        );
        if (readability.issues && readability.issues.length) {
          for (const it of readability.issues.slice(0, 3)) {
            await appendLog(taskId, `📖 ${it.message}`, it.severity === 'high' ? 'warn' : 'info');
          }
        }
      } catch (readErr) {
        await appendLog(taskId, `⚠ Readability-check не выполнился: ${readErr.message}`, 'warn');
      }
    }

    // 11e2. LSI density / anti-overspam контроль (детерминированный).
    //       По ТЗ заказчика: «усилить контроль переспама при генерации
    //       контента». Считает per-H2 плотность каждой important-фразы:
    //         - per-term > 2.5% → overdose для этого термина
    //         - total > 8.0%   → overdose для секции
    //       Verdict 'fail' / 'review' / 'pass' / 'na' (если LSI пустой).
    //       Soft-warning, никогда не валит pipeline. Используется UI как
    //       сигнал «эту секцию надо переписать естественнее».
    //
    //       Не вынесен в env-флаг по требованию заказчика «новые ENV не
    //       добавлять»: модуль чисто детерминированный, ничего не сетит,
    //       не платит — всегда безопасно запускать.
    try {
      const importantTerms = (lsiSet && Array.isArray(lsiSet.important))
        ? lsiSet.important
        : [];
      const overdoseReport = checkLsiOverdose(articleHtml, importantTerms);
      // Сохраняем в JSONB-колонку lsi_overdose_report; колонка создаётся
      // лениво через server.js ensureSchema (миграция 029 / IF NOT EXISTS).
      await saveColumn(taskId, 'lsi_overdose_report', overdoseReport).catch(() => {});
      const icon = overdoseReport.verdict === 'pass' ? '✅'
        : overdoseReport.verdict === 'review' ? '⚠'
        : overdoseReport.verdict === 'fail' ? '❌'
        : 'ℹ';
      await appendLog(
        taskId,
        `${icon} LSI overdose: verdict=${overdoseReport.verdict}, `
        + `overdose=${overdoseReport.sections_overdose}/${overdoseReport.sections_total}, `
        + `low=${overdoseReport.sections_low}, good=${overdoseReport.sections_good}`,
        overdoseReport.verdict === 'pass' ? 'ok' : 'info',
      );
      if (overdoseReport.overspam && overdoseReport.overspam.length) {
        for (const o of overdoseReport.overspam.slice(0, 5)) {
          await appendLog(
            taskId,
            `🚨 Переспам «${o.term}» в «${o.section_title}» — плотность ${o.density_pct}%`,
            'warn',
          );
        }
      }
    } catch (overErr) {
      await appendLog(taskId, `⚠ LSI overdose-check не выполнился: ${overErr.message}`, 'warn');
    }

    // 11f. Phase 2 / Б5: Intent verifier (детерминированный).
    //      Гейт INFO_ARTICLE_INTENT_VERIFY_ENABLED (default ON). Сравнивает
    //      программно определённый интент статьи с dominant_intent из
    //      competitor_signals.serp_intent (если статья привязана к
    //      relevance_report). Никогда не валит pipeline (soft-warning).
    if (INFO_ARTICLE_INTENT_VERIFY_ENABLED) {
      try {
        const intentReport = verifyIntent(articleHtml, relevanceSignals || null);
        await saveColumn(taskId, 'intent_verdict', intentReport);
        if (intentReport.verdict === 'na') {
          await appendLog(
            taskId,
            `🎯 Intent: article=${intentReport.article_intent} (verdict=na, ${intentReport.reason || 'no_data'})`,
            'info',
          );
        } else {
          const icon = intentReport.verdict === 'pass' ? '✅'
            : intentReport.verdict === 'mismatch' ? '❌' : '⚠';
          await appendLog(
            taskId,
            `${icon} Intent: article=${intentReport.article_intent}, SERP=${intentReport.serp_intent}, verdict=${intentReport.verdict}`,
            intentReport.verdict === 'pass' ? 'ok' : (intentReport.critical ? 'warn' : 'info'),
          );
          if (intentReport.recommendation) {
            await appendLog(taskId, `💡 ${intentReport.recommendation}`, intentReport.critical ? 'warn' : 'info');
          }
        }
      } catch (intentErr) {
        await appendLog(taskId, `⚠ Intent-verify не выполнился: ${intentErr.message}`, 'warn');
      }
    }

    // 11g. Phase 2 / С1: сохраняем регресс-отчёт валидатора writer'а.
    //      Содержит все проходы (initial, retry, refine) с их issue-списками
    //      и by_kind tally — для последующей аналитики корпуса задач:
    //      какие классы issues регрессируют чаще всего.
    try {
      const validationReport = validationTracker.toReport();
      await saveColumn(taskId, 'validation_report', validationReport);
      if (validationReport.total_passes > 1 || validationReport.final_count > 0) {
        await appendLog(
          taskId,
          `📋 Validation: passes=${validationReport.total_passes}, ` +
          `${validationReport.initial_count}→${validationReport.final_count} issues, ` +
          `fixed=[${validationReport.fixed_kinds.join(',')}], ` +
          `persistent=[${validationReport.persistent_kinds.join(',')}]`,
          validationReport.final_count === 0 ? 'ok' : 'info',
        );
      }
    } catch (vrErr) {
      await appendLog(taskId, `⚠ Validation-report сохранение упало: ${vrErr.message}`, 'warn');
    }

    // 12. Stage 4 image prompts
    // task.images_count приходит из миграции 022 (CHECK 0..6, default 1).
    //   • 0 — пользователь выбрал «Не нужны изображения» → весь блок
    //     генерации картинок (Stage 4 + Nano Banana + Image QA) пропускаем.
    //   • На очень старых задачах поле может отсутствовать → fallback к 1.
    const parsedImagesCount = parseInt(task.images_count, 10);
    const imagesCount = Number.isFinite(parsedImagesCount)
      ? Math.max(0, Math.min(6, parsedImagesCount))
      : 1;
    // renderedImages нужен ниже в embedImages — при отключённых картинках
    // остаётся пустым массивом (embedImages вернёт HTML без изменений).
    let renderedImages = [];
    if (imagesCount === 0) {
      await setStage(taskId, 'stage4_image_prompts', 84);
      await appendLog(
        taskId,
        'ℹ Изображения отключены пользователем («Не нужны изображения») — пропускаем Stage 4 и генерацию картинок',
        'info',
      );
      await saveColumn(taskId, 'image_prompts', []);
    } else {
    // Корректное русское склонение: 1 — «изображение», 2-4 — «изображения»,
    // 5+ — «изображений». В нашем диапазоне 1..6 достаточно явной таблицы.
    const RU_IMAGES_FORMS = {
      1: '1 изображение', 2: '2 изображения', 3: '3 изображения',
      4: '4 изображения', 5: '5 изображений', 6: '6 изображений',
    };
    const imagesPhrase = RU_IMAGES_FORMS[imagesCount] || `${imagesCount} изображений`;
    await setStage(taskId, 'stage4_image_prompts', 84);
    await appendLog(taskId, `🖼 Запрос на ${imagesPhrase} (slot=1 cover${imagesCount > 1 ? `, slot=2..${imagesCount} inline` : ''})`, 'info');
    const imagePrompts = await runImagePromptsGen(task, outline, articleHtml, audience, ctx, imagesCount);
    if (imagePrompts.length < 1) {
      await appendLog(taskId, `⚠ DeepSeek не вернул промт обложки (image_prompts пусто)`, 'warn');
    } else if (imagePrompts.length < imagesCount) {
      await appendLog(
        taskId,
        `⚠ DeepSeek вернул ${imagePrompts.length}/${imagesCount} image_prompts — продолжаем с тем, что есть`,
        'warn',
      );
    }
    await saveColumn(taskId, 'image_prompts', imagePrompts);

    // 13. Image generation
    await setStage(taskId, 'image_generation', 92);
    renderedImages = await runImageGeneration(taskId, imagePrompts);
    await saveColumn(taskId, 'image_prompts', renderedImages);

    // 13b. Image QA — Phase 1 / P0-4. Детерминированный аудит готовых
    //      картинок: формат-через-magic-bytes, ширина/высота, аспект,
    //      sha256-дубли, пустые alt. Не делает сети, не вызывает LLM,
    //      никогда не валит pipeline (try/catch + soft warn). Гейт
    //      INFO_ARTICLE_IMAGE_QA_ENABLED (default ON).
    if (INFO_ARTICLE_IMAGE_QA_ENABLED) {
      try {
        const qa = runImageQa(renderedImages);
        await saveColumn(taskId, 'image_qa_report', qa);
        const qs = qa.summary;
        const verdictIcon = qs.verdict === 'pass' ? '✅'
          : qs.verdict === 'review' ? '⚠'
          : qs.verdict === 'na' ? 'ℹ'
          : '❌';
        await appendLog(
          taskId,
          `${verdictIcon} Image QA: slots=${qs.doneSlots}/${qs.totalSlots} ` +
          `(failed=${qs.failedSlots}, errors=${qs.errors}, warnings=${qs.warnings}, ` +
          `coverOk=${qs.coverOk}) verdict=${qs.verdict}`,
          qs.verdict === 'pass' || qs.verdict === 'na' ? 'ok' : 'info',
        );
        if (qa.duplicate_groups.length > 0) {
          const grp = qa.duplicate_groups
            .map((g) => `[${g.slots.join(',')}]${g.includes_cover ? '!' : ''}`)
            .join(' ');
          await appendLog(
            taskId,
            `🖼 Image QA: обнаружены дубли по sha256: ${grp}` +
            ` (! = группа включает cover)`,
            'warn',
          );
        }
        // Топ-3 диагностических сообщения по уровню error для краткости в логе.
        const topIssues = [];
        for (const s of qa.slots) {
          for (const it of s.issues) {
            if (it.level === 'error') topIssues.push(it.message);
            if (topIssues.length >= 3) break;
          }
          if (topIssues.length >= 3) break;
        }
        if (topIssues.length > 0) {
          await appendLog(
            taskId,
            `🖼 Image QA: top-${topIssues.length} ошибок: ${topIssues.join(' | ')}`,
            'warn',
          );
        }
      } catch (qaErr) {
        await appendLog(
          taskId,
          `⚠ Image-QA не выполнился: ${qaErr.message} — продолжаем без отчёта`,
          'warn',
        );
      }
    }
    } // end else (imagesCount > 0)

    // 13c. Quality Score — детерминированная сводная метрика по всем
    //      посчитанным отчётам качества. Используется в /api/admin/model-comparison
    //      для сравнения gemini-моделей. Не делает сети, никогда не валит
    //      pipeline (try/catch).
    // Перед quality_score — финальный лог по статистике Gemini Context Cache.
    // Помогает диагностировать «cache создался, но переиспользований не было».
    if (geminiCacheName) {
      const reused = Number(task.__geminiCacheReuseCount || 0);
      await appendLog(
        taskId,
        `[cache] gemini cachedContent ${geminiCacheName.split('/').pop()}: ` +
        `${reused > 0 ? `reused ${reused} time(s)` : '⚠ created but NEVER reused (check pipeline flow)'}`,
        reused > 0 ? 'info' : 'warn',
      );
    }
    try {
      const { computeQualityScore } = require('../qualityLayers/qualityScore');
      // Перечитываем актуальные отчёты + метаданные задачи.
      const { rows: [t] } = await db.query(
        `SELECT eeat_audit, readability_report, intent_verdict,
                fact_check_report, plagiarism_report, lsi_report,
                lsi_overdose_report, validation_report, image_qa_report,
                gemini_model,
                total_cost_usd, total_tokens_in, total_tokens_out,
                started_at
           FROM info_article_tasks
          WHERE id = $1`,
        [taskId],
      );
      if (t) {
        const elapsedMs = t.started_at
          ? Date.now() - new Date(t.started_at).getTime()
          : null;
        const quality = computeQualityScore(
          {
            eeat_audit:          t.eeat_audit,
            readability_report:  t.readability_report,
            intent_verdict:      t.intent_verdict,
            fact_check_report:   t.fact_check_report,
            plagiarism_report:   t.plagiarism_report,
            lsi_report:          t.lsi_report,
            lsi_overdose_report: t.lsi_overdose_report,
            validation_report:   t.validation_report,
            image_qa_report:     t.image_qa_report,
          },
          {
            model_used:         t.gemini_model,
            cost_usd:           Number(t.total_cost_usd)   || 0,
            tokens_in:          Number(t.total_tokens_in)  || 0,
            tokens_out:         Number(t.total_tokens_out) || 0,
            generation_time_ms: elapsedMs,
          },
        );
        await saveColumn(taskId, 'quality_score', quality);
        try {
          await recordTrainingExample({
            articleRef: `info_article:${taskId}`,
            kind: 'info_article',
            niche: task.region || null,
            userPrompt: task.topic || '',
            htmlOutput: articleHtml || '',
            qualityScore: quality,
            gaMetrics: null,
            modelUsed: quality.model_used || t.gemini_model || null,
            costUsd: Number(t.total_cost_usd) || 0,
            userId: task.user_id || null,
            promptHash: resolvePromptHash('infoArticle/stage3_writer'),
          });
          await recordQualityLog({
            articleRef: `info_article:${taskId}`,
            kind: 'info_article',
            niche: task.region || null,
            qualityScore: quality,
            reports: {
              eeat_audit:          t.eeat_audit,
              readability_report:  t.readability_report,
              intent_verdict:      t.intent_verdict,
              fact_check_report:   t.fact_check_report,
              plagiarism_report:   t.plagiarism_report,
              lsi_report:          t.lsi_report,
              validation_report:   t.validation_report,
              image_qa_report:     t.image_qa_report,
            },
            modelUsed: quality.model_used || t.gemini_model || null,
            costUsd: Number(t.total_cost_usd) || 0,
            iterations: 1,
            taskRef: taskId,
            userId: task.user_id || null,
            userPrompt: task.topic || '',
            promptHash: resolvePromptHash('infoArticle/stage3_writer'),
          });
          const eeat = quality && quality.subscores ? Number(quality.subscores.eeat) : null;
          await biobrainClient.feedback({
            features: Array.isArray(task.__bioFeatures) ? task.__bioFeatures : null,
            text: Array.isArray(task.__bioFeatures) ? null : (articleHtml || null),
            predicted: null,
            real_spq_overall: quality.overall,
            real_eeat: Number.isFinite(eeat) ? eeat : null,
          });
        } catch (_e) { /* best-effort */ }
        if (quality.overall !== null) {
          await appendLog(
            taskId,
            `📊 Quality score: ${quality.overall.toFixed(1)}/100 ` +
            `(model=${quality.model_used || '?'})`,
            'info',
          );
        }
      }
    } catch (qsErr) {
      console.warn(`[infoArticle] computeQualityScore failed: ${qsErr.message}`);
    }

    // 14. Финализация HTML + plain text. Cover-изображение встраивается в
    //     article_html сразу после <h1> (см. embedImages), чтобы при копировании
    //     HTML / форматированного текста картинка уезжала вместе со статьёй.
    //     image_prompts при этом всё равно сохраняется отдельно — пользователь
    //     может скачать обложку из галереи, если нужен файл для отдельной публикации.
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
    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }
    try {
      const { rows } = await db.query(
        `SELECT quality_score FROM info_article_tasks WHERE id = $1`,
        [taskId],
      );
      const score = rows[0] && rows[0].quality_score && rows[0].quality_score.overall;
      await finalizeByTask({
        table: 'info_article_tasks',
        taskId,
        ok: true,
        spqOverall: score == null ? null : Number(score),
        taskKind: 'info_article',
      });
    } catch (_) { /* no-op */ }

    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
  } catch (err) {
    console.error(`[infoArticle] task ${taskId} failed:`, err);
    if (funnel) { try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ } }
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
      await finalizeByTask({
        table: 'info_article_tasks',
        taskId,
        ok: false,
        error: err.message,
        taskKind: 'info_article',
      });
    } catch (_) { /* no-op */ }
  } finally {
    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
    IN_PROGRESS.delete(taskId);
    CURRENT_STAGE.delete(taskId);
    FUNNELS.delete(taskId);
    // Освобождаем учёт токенов для задачи: иначе Map tokenBudgetState
    // в callLLM аккумулирует записи для всех когда-либо запущенных задач
    // (утечка памяти, ~120 байт на задачу × тысячи прогонов).
    resetTaskBudget(taskId);
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
  // Внутренние хелперы — экспортируются исключительно для unit-тестов
  // (см. backend/scripts/test-info-article-html-helpers.js). Не использовать
  // снаружи pipeline — публичный контракт пайплайна это processInfoArticleTask.
  _internal: { embedImages, injectMissingLinks, buildPlainText },
};
