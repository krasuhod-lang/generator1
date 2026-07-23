'use strict';

/**
 * linkArticlePipeline — оркестратор генератора ссылочной статьи.
 *
 * Полностью изолирован от основного SEO-пайплайна: своя таблица
 * (link_article_tasks), свои промты (prompts/linkArticle/*.txt),
 * свой адаптер для изображений (nanoBananaPro.adapter.js).
 * Существующий `services/pipeline/*` и `prompts/systemPrompts.js`
 * не трогаются — по явному требованию.
 *
 * Последовательность стадий (plain линейная, без refinement-циклов):
 *   1. Pre-Stage 0   → DeepSeek : стратегический анализ темы
 *   2. Stage 0       → DeepSeek : ЦА + тон
 *   3. Stage 1       → DeepSeek : сущности, интенты, user_questions
 *   4. Stage 2       → DeepSeek : структура статьи + anchor_plan + image_plan
 *   5. Stage 3       → Gemini   : написание статьи (с anchor + 3 image-placeholder)
 *   6. Stage 4       → DeepSeek : 3 промта для изображений
 *   7. Nano Banana Pro → 3 параллельных вызова → base64 PNG
 *   8. embedImages   → подменяет плейсхолдеры на <figure><img data:...>
 *   9. buildPlainText → простой strip-tags для output_format='formatted_text'
 *
 * Все ошибки ловятся в runPipeline, задача помечается как 'error' — исключение
 * наружу не выбрасывается.
 */

const db = require('../../config/db');
const { callLLM, resetTaskBudget } = require('../llm/callLLM');
const { runEeatAuditCore } = require('../eeatAudit/core');
const { runQualityEvaluator } = require('../pipeline/stage8');
const { loadLinkArticlePrompt } = require('../../prompts/linkArticle');
const { generateImage, IMAGE_PRICE_USD } = require('./nanoBananaPro.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const sse = require('../sse/sseManager');
const {
  recordTextTokens,
  recordImageCall,
  recordEvent,
} = require('./linkArticleMetrics');
const {
  buildLinkArticleKnowledgeBase,
  lakbCallOpts,
  pointerOrJson,
} = require('./linkArticleKnowledgeBase');
const { createCachedContent, deleteCachedContent } = require('../llm/gemini.adapter');
const { normalizeGeminiCopywritingModel, DEFAULT_GEMINI_COPYWRITING_MODEL } = require('../llm/geminiModels');
const { EEAT_PQ_TARGET } = require('../../utils/objectiveMetrics');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const { recordQualityLog } = require('../aegis/qualityLogWriter');
const { resolvePromptHash } = require('../aegis/promptAudit');
const { finalizeByTask } = require('../aegis/backlogHooks');
const { createFunnelTracker } = require('../aegis/funnelTracker');
const biobrainClient = require('../aegis/biobrainClient');
const {
  getImageConfig: getImagePipelineConfig,
  runSemanticImageQa,
  persistImages,
  evaluateImageGate,
} = require('../images');
const {
  NEGATIVE_BASE: IMAGE_NEGATIVE_BASE,
  NEGATIVE_STRICT_EXTRA: IMAGE_NEGATIVE_STRICT_EXTRA,
} = require('../images/imagePromptComposer');
const { detectBannedPatterns } = require('./qualityPatterns');

// ── Config via env ───────────────────────────────────────────────────
const LINK_ARTICLE_GEMINI_MODEL =
  process.env.LINK_ARTICLE_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  DEFAULT_GEMINI_COPYWRITING_MODEL;

const MAX_PARALLEL_IMAGES = (() => {
  const v = parseInt(process.env.LINK_ARTICLE_MAX_PARALLEL_IMAGES, 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
})();

// IMAGE_PRICE_USD пришёл из nanoBananaPro.adapter (см. там — единый
// источник истины с поддержкой NANO_BANANA_PRO_PRICE_USD env).

// Включает Gemini cachedContents для LAKB. Должен быть GEMINI_PROXY+GEMINI_API_KEY.
// Минимальный размер кэша у Gemini ≥ 4096 input tokens, поэтому LAKB должна быть
// достаточно объёмной (мы стремимся к ≥ 8 КБ текста ~ ≥ 4–5К токенов).
const LINK_ARTICLE_GEMINI_CACHE_ENABLED =
  String(process.env.LINK_ARTICLE_GEMINI_CACHE_ENABLED || '').toLowerCase() === 'true';

// ── M-1 Topic Discovery (Итерация 2, Задача 1.3) ──────────────────────
const TOPIC_DISCOVERY_ENABLED =
  !['0', 'false', 'no', 'off'].includes(String(process.env.TOPIC_DISCOVERY_ENABLED || '1').toLowerCase());
const TOPIC_AUTO_PIVOT =
  ['1', 'true', 'yes', 'on'].includes(String(process.env.TOPIC_AUTO_PIVOT || '').toLowerCase());
const AUTHOR_BLOCK_ENABLED =
  !['0', 'false', 'no', 'off'].includes(String(process.env.AUTHOR_BLOCK_ENABLED || '1').toLowerCase());


// TTL Gemini кэша. Дефолт 900 сек = 15 минут — хватает на Stage 3 + corrective + Stage 4.
const LINK_ARTICLE_GEMINI_CACHE_TTL_S = (() => {
  const v = parseInt(process.env.LINK_ARTICLE_GEMINI_CACHE_TTL_S, 10);
  return Number.isFinite(v) && v >= 60 && v <= 3600 ? v : 900;
})();

// Пороговый E-E-A-T балл для запуска корректировочного прохода writer'а.
// Источник истины — backend/src/utils/objectiveMetrics.js → EEAT_PQ_TARGET.
const LINK_ARTICLE_EEAT_TARGET = (() => {
  const env = parseFloat(process.env.LINK_ARTICLE_EEAT_TARGET);
  if (Number.isFinite(env) && env > 0 && env <= 10) return env;
  return EEAT_PQ_TARGET;
})();

const LINK_ARTICLE_LF_MAX_PASSES = (() => {
  const v = parseInt(process.env.LINK_ARTICLE_LF_MAX_PASSES, 10);
  return Number.isFinite(v) && v >= 0 && v <= 3 ? v : 2;
})();

const IN_PROGRESS = new Set(); // taskId — защита от двойного старта

// Текущая стадия per-task (in-memory) — используется, чтобы recordEvent
// автоматически прикреплял stage к событию без передачи его во все вызовы.
const CURRENT_STAGE = new Map();
// Реестр воронок генерации по taskId — setStage() автоматически отмечает
// переход стадии в funnel.step(). Регистрируется в processLinkArticleTask.
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
      `UPDATE link_article_tasks
          SET current_stage = $2, progress_pct = $3, updated_at = NOW()
        WHERE id = $1`,
      [taskId, stageName, progressPct],
    );
  } catch (err) {
    console.error('[linkArticle] setStage failed:', err.message);
  }
  publishEvent(taskId, 'stage', { stage: stageName, progress: progressPct });
}

async function saveStageResult(taskId, column, data) {
  try {
    await db.query(
      `UPDATE link_article_tasks SET ${column} = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, data != null ? JSON.stringify(data) : null],
    );
  } catch (err) {
    console.error(`[linkArticle] saveStageResult(${column}) failed:`, err.message);
  }
}

function buildCallCtx(taskId, stageName) {
  // NB: taskId НЕ передаём внутрь callLLM, чтобы persistStageCall не пытался
  // писать в task_stages (у неё FK на tasks, а link_article_tasks — отдельная
  // таблица). Собственные метрики кладём через onTokens → recordTextTokens.
  return {
    stageName,
    pipeline: 'link',
    traceTaskId: taskId,
    log: (msg, level = 'info') => appendLog(taskId, msg, level).catch(() => {}),
    onTokens: (adapter, tIn, tOut, cost) => {
      // adapter: 'deepseek' | 'gemini' | 'grok'
      recordTextTokens(taskId, adapter, tIn, tOut, cost).catch(() => {});
    },
  };
}

// ── Stages ───────────────────────────────────────────────────────────

async function runPreStrategy(task, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
  ].join('\n');

  return callLLM(
    'deepseek',
    loadLinkArticlePrompt('preStage0'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'LinkArticle Pre-Stage 0', ...ctx },
  );
}

async function runAudience(task, strategy, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 6000)}`,
  ].join('\n');

  return callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage0'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'LinkArticle Stage 0', ...ctx },
  );
}

async function runIntents(task, strategy, audience, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 4000)}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
  ].join('\n');

  return callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage1'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'LinkArticle Stage 1', ...ctx },
  );
}

// Stage 1B — White-space discovery (DeepSeek).
// Этот этап отвечает за стратегический content-gap анализ и формирование
// `article_hierarchy_hints`, которые далее жёстко учитываются Stage 2.
async function runWhitespace(task, strategy, audience, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy).slice(0, 4000)}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
  ].join('\n');

  return callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage1bWS'),
    user,
    { retries: 3, temperature: 0.35, callLabel: 'LinkArticle Stage 1B (white-space)', ...ctx },
  );
}

function isLinkGoogleSerpEnabled() {
  return String(process.env.LINK_GOOGLE_SERP_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function primaryAudienceLabel(audience) {
  const personas = Array.isArray(audience?.audience_personas) ? audience.audience_personas : [];
  if (personas[0]) return [personas[0].name, personas[0].context].filter(Boolean).join(' — ');
  const clusters = Array.isArray(audience?.audience_clusters) ? audience.audience_clusters : [];
  if (clusters[0]) return [clusters[0].name, clusters[0].intent_bias].filter(Boolean).join(' — ');
  return '';
}

async function runGoogleSerpGistDelta(task, audience, ctx) {
  const result = {
    enabled: isLinkGoogleSerpEnabled(),
    serp_results: [],
    information_delta: [],
    gist_score: null,
    top10_claims: [],
    error: null,
  };
  if (!result.enabled) return result;

  try {
    let fetchGoogleSerpWithContent;
    try {
      ({ fetchGoogleSerpWithContent } = require('../infoArticle/fetchGoogleSerp'));
    } catch (e) {
      result.error = `fetchGoogleSerpWithContent unavailable: ${e.message}`;
      return result;
    }
    const topN = parseInt(process.env.LINK_GOOGLE_SERP_TOP_N || '10', 10);
    const serp = await fetchGoogleSerpWithContent({
      keyword: task.topic,
      region: task.region || 'ru',
      top_n: Number.isFinite(topN) && topN > 0 ? topN : 10,
      extract_content: true,
    });
    result.serp_results = (Array.isArray(serp) ? serp : []).map((item) => ({
      url: item.url,
      serp_title: item.serp_title,
      serp_description: item.serp_description,
      word_count: item.word_count || 0,
      page_content: String(item.page_content || '').slice(0, 24000),
    }));

    const competitorsText = result.serp_results
      .map((item) => item.page_content)
      .filter((text) => typeof text === 'string' && text.trim());
    if (!competitorsText.length) return result;

    let runGistGapFinder;
    try {
      ({ runGistGapFinder } = require('../gist/gistClient'));
    } catch (e) {
      result.error = `runGistGapFinder unavailable: ${e.message}`;
      return result;
    }
    const gist = await runGistGapFinder({
      keyword: task.topic,
      competitors_text: competitorsText,
      page_type: 'link',
      target_audience: primaryAudienceLabel(audience),
    });
    result.information_delta = Array.isArray(gist?.information_delta) ? gist.information_delta : [];
    result.gist_score = gist?.gist_score ?? null;
    result.top10_claims = Array.isArray(gist?.top10_claims) ? gist.top10_claims : [];
    return result;
  } catch (e) {
    result.error = e.message;
    if (ctx && typeof ctx.log === 'function') ctx.log(`GIST delta skipped: ${e.message}`, 'warn');
    return result;
  }
}

async function runCompetitivePurchaseBrief(task, strategy, audience, whitespace, gistDelta, ctx) {
  const serpDigest = (Array.isArray(gistDelta?.serp_results) ? gistDelta.serp_results : [])
    .slice(0, 6)
    .map((item) => ({
      title: item.serp_title,
      description: item.serp_description,
      url: item.url,
      excerpt: String(item.page_content || '').slice(0, 900),
    }));
  const system = [
    'LINK-ARTICLE §10/§11 ANALYST.',
    'Верни только JSON без markdown:',
    '{',
    '  "competitive_failures": ["5-7 коротких тезисов: что конкуренты делают слабо"],',
    '  "purchase_arguments": ["5-7 конкретных аргументов для перехода по анкорной ссылке"]',
    '}',
    'Не выдумывай статистику, бренды и факты; опирайся на SERP/white-space/стратегию.',
  ].join('\n');
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `strategy_digest: ${JSON.stringify(strategy || {}).slice(0, 3500)}`,
    `stage0_audience: ${JSON.stringify(audience || {}).slice(0, 2500)}`,
    `whitespace_analysis: ${JSON.stringify(whitespace || {}).slice(0, 3500)}`,
    `serp_digest: ${JSON.stringify(serpDigest).slice(0, 7000)}`,
    `gist_information_delta: ${JSON.stringify(gistDelta?.information_delta || []).slice(0, 3500)}`,
  ].join('\n');
  try {
    const raw = await callLLM(
      'deepseek',
      system,
      user,
      { retries: 2, temperature: 0.25, callLabel: 'LinkArticle §10/§11 Analyst', ...ctx },
    );
    return {
      competitive_failures: Array.isArray(raw?.competitive_failures)
        ? raw.competitive_failures.slice(0, 7) : [],
      purchase_arguments: Array.isArray(raw?.purchase_arguments)
        ? raw.purchase_arguments.slice(0, 7) : [],
    };
  } catch (e) {
    if (ctx && typeof ctx.log === 'function') ctx.log(`§10/§11 skipped: ${e.message}`, 'warn');
    return { competitive_failures: [], purchase_arguments: [], error: e.message };
  }
}

async function runStructure(task, audience, intents, whitespace, ctx) {
  const hints = (whitespace && whitespace.article_hierarchy_hints) || {};
  // ТЗ 23.07.2026 п.2.2: семантические кластеры конкурентов (cocoon_plan) →
  // опора для H2/H3, чтобы покрыть все микро-интенты ТОПа.
  const { buildCocoonBrief } = require('../relevance/relevanceArtifacts');
  const cocoonBrief = buildCocoonBrief(task && task.__relevanceArtifact && task.__relevanceArtifact.cocoon_plan);
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
    `stage1_intents: ${JSON.stringify(intents).slice(0, 8000)}`,
    `whitespace_hints: ${JSON.stringify(hints).slice(0, 4000)}`,
    ...(cocoonBrief ? ['', cocoonBrief] : []),
  ].join('\n');

  return callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage2'),
    user,
    { retries: 3, temperature: 0.3, callLabel: 'LinkArticle Stage 2', ...ctx },
  );
}

// ── Writer stage (Gemini) with post-validation + one corrective retry ──

const HALLUCINATION_PATTERNS = [
  /по данным исследовани[йя]/i,
  /согласно отчёту/i,
  /согласно исследовани[июя]/i,
  /в\s+\d{4}\s+году\s+рынок\s+вырос/i,
  /аналитик[иа]\s+[А-ЯA-Z][а-яa-z]+\s+сообщ/i,
  /в\s+ходе\s+опроса\s+\d+/i,
];

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (haystack.match(new RegExp(safe, 'gi')) || []).length;
}

// Сколько первых символов анкорного текста должно совпадать между тем, что
// задал пользователь, и тем, что модель поставила внутрь <a>. Нужен запас,
// потому что модель может добавить/убрать хвостовое слово ради грамматики
// («купить ВНЖ» ↔ «купить ВНЖ Португалии»). 40 символов — практический
// компромисс, позволяющий простить окончания и прилагательные.
const ANCHOR_TEXT_PREFIX_MATCH_LEN = 40;

// Максимально допустимая доля текста перед первой встречей анкора.
// По требованию задачи — первые 20 % статьи. Используется и в проверке,
// и в user-facing сообщении об ошибке, чтобы они не расходились.
const ANCHOR_MAX_POSITION_RATIO = 0.20;

// stripTags — вспомогательная функция для извлечения plain-text из HTML-фрагмента.
// Используется в валидаторах для подсчёта длины и сравнения текста (не для
// рендера в DOM). Применяется в цикле до стабильности, чтобы обезвредить
// «наложенные» теги вроде `<<tag>tag>` и удовлетворить проверку CodeQL
// js/incomplete-multi-character-sanitization.
function stripTags(s) {
  if (!s) return '';
  let out = String(s);
  const tagRe = /<[^>]+>/g;
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(tagRe, ' ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ');
}

function normalizeForCoverage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function termStems(term) {
  return normalizeForCoverage(term)
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.min(6, w.length)));
}

function extractMandatoryLsi(task, strategy, intents) {
  const terms = [];
  const art = task.__relevanceArtifact;
  if (art && Array.isArray(art.important_lsi)) {
    for (const item of art.important_lsi.slice(0, 40)) {
      terms.push(typeof item === 'string' ? item : (item.term || item.lemma || item.text || item.keyword));
    }
  }
  if (strategy && Array.isArray(strategy.lsi_entities)) {
    for (const e of strategy.lsi_entities) {
      if (!e || e.must_appear === false) continue;
      terms.push(e.entity);
    }
  }
  if (intents && Array.isArray(intents.semantic_anchors)) {
    terms.push(...intents.semantic_anchors.slice(0, 20));
  }
  return Array.from(new Set(terms.map((t) => String(t || '').trim()).filter(Boolean))).slice(0, 50);
}

function measureLinkLsiCoverage(articleHtml, task, strategy, intents) {
  const mandatory = extractMandatoryLsi(task, strategy, intents);
  if (!mandatory.length) return { coverage_pct: 100, present: [], missing: [], total: 0 };
  const text = normalizeForCoverage(stripTags(articleHtml));
  const present = [];
  const missing = [];
  for (const term of mandatory) {
    const exact = normalizeForCoverage(term);
    const stems = termStems(term);
    const found = (exact && text.includes(exact)) ||
      (stems.length > 0 && stems.every((stem) => text.includes(stem)));
    (found ? present : missing).push(term);
  }
  return {
    coverage_pct: Math.round((present.length / mandatory.length) * 100),
    present,
    missing,
    total: mandatory.length,
  };
}

function buildQualityRefineIssues({ eeatAudit, patternReport, lsiReport }) {
  const issues = [];
  const auditIssues = Array.isArray(eeatAudit?.issues) ? eeatAudit.issues : [];
  issues.push(...auditIssues.filter((it) => it && it.needs_refine !== false));
  if (patternReport && patternReport.banned_intros && patternReport.banned_intros.length) {
    issues.push({
      severity: 'major',
      category: 'banned_intro',
      where: 'intro',
      problem: `Запрещённые вводные: ${patternReport.banned_intros.join(', ')}`,
      fix_instruction: 'Убери вводные-пустышки и начни с конкретной пользы/факта из LAKB.',
    });
  }
  if (patternReport?.repetitive_structure) {
    issues.push({
      severity: 'major',
      category: 'repetitive_structure',
      where: 'article',
      problem: 'Три и более соседних абзаца построены одинаково.',
      fix_instruction: 'Разнообразь синтаксис и логику соседних абзацев без добавления воды.',
    });
  }
  if (patternReport && patternReport.has_table_or_list === false) {
    issues.push({
      severity: 'major',
      category: 'fact_table_or_list',
      where: 'article',
      problem: 'Нет таблицы или маркированного/нумерованного списка с конкретными фактами.',
      fix_instruction: 'Добавь один компактный список или таблицу с фактами из LAKB.',
    });
  }
  if (lsiReport && lsiReport.coverage_pct < 60) {
    issues.push({
      severity: 'major',
      category: 'lsi_coverage',
      where: 'article',
      problem: `LSI coverage ${lsiReport.coverage_pct}% < 60%; пропущено: ${lsiReport.missing.slice(0, 12).join(', ')}`,
      fix_instruction: 'Естественно встрои недостающие обязательные LSI-термины без переспама.',
    });
  }
  return issues;
}

function validateWriterOutput(html, task) {
  const issues = [];
  if (typeof html !== 'string' || html.trim().length < 400) {
    issues.push('article_html слишком короткий или пустой');
    return issues;
  }

  const anchorUrl  = task.anchor_url;
  const anchorText = task.anchor_text;

  // Anchor: ровно один <a ...href="ANCHOR_URL"...>...</a>.
  // Ищем через статический общий regex на любые <a href="...">, затем
  // сверяем href с ожидаемым URL. Это безопаснее, чем собирать RegExp из
  // пользовательского URL (избегаем «tainted regex» и false-positive
  // подсчётов при дополнительных атрибутах вроде rel/target).
  const ANY_ANCHOR_REGEX = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const HREF_ATTR_REGEX  = /\shref\s*=\s*("([^"]*)"|'([^']*)')/i;
  const anchorHits = [];
  let match;
  while ((match = ANY_ANCHOR_REGEX.exec(html)) !== null) {
    const hrefMatch = HREF_ATTR_REGEX.exec(match[1]);
    const href = hrefMatch ? (hrefMatch[2] || hrefMatch[3] || '') : '';
    if (href === anchorUrl) {
      anchorHits.push({ full: match[0], index: match.index, inner: match[2] });
    }
  }

  if (anchorHits.length === 0) {
    issues.push(`Не найдена ссылка <a href="${anchorUrl}">${anchorText}</a>`);
  } else if (anchorHits.length > 1) {
    issues.push(`Ссылка на ${anchorUrl} встречается ${anchorHits.length} раз — должна быть ровно 1`);
  } else {
    const innerText = stripTags(anchorHits[0].inner).trim();
    const needle = anchorText.toLowerCase().slice(0, Math.min(ANCHOR_TEXT_PREFIX_MATCH_LEN, anchorText.length));
    if (innerText && anchorText && !innerText.toLowerCase().includes(needle)) {
      issues.push(`Текст анкора не совпадает: ожидалось «${anchorText}», получено «${innerText}»`);
    }
  }

  // Anchor position: первые ANCHOR_MAX_POSITION_RATIO * 100% текста
  const plain = stripTags(html);
  if (anchorHits.length >= 1) {
    const firstAnchorIdx = anchorHits[0].index;
    const plainUpToAnchor = stripTags(html.slice(0, firstAnchorIdx));
    const ratio = plain.length > 0 ? plainUpToAnchor.length / plain.length : 1;
    if (ratio > ANCHOR_MAX_POSITION_RATIO) {
      issues.push(
        `Анкор стоит слишком глубоко в тексте (${Math.round(ratio * 100)}% — ` +
        `должно быть ≤ ${Math.round(ANCHOR_MAX_POSITION_RATIO * 100)}%)`,
      );
    }
  }

  // Image placeholders
  for (let i = 1; i <= 3; i += 1) {
    const c = countOccurrences(html, `<!-- IMAGE_SLOT_${i} -->`);
    if (c === 0) issues.push(`Отсутствует плейсхолдер <!-- IMAGE_SLOT_${i} -->`);
    else if (c > 1) issues.push(`Плейсхолдер <!-- IMAGE_SLOT_${i} --> встречается ${c} раз (должен 1)`);
  }

  // Hallucination guard
  for (const pat of HALLUCINATION_PATTERNS) {
    if (pat.test(plain)) {
      issues.push(`Найдена запрещённая формулировка (подозрение на галлюцинацию): ${pat}`);
      break;
    }
  }

  // h1 — ровно один
  const h1Count = (html.match(/<h1\b/gi) || []).length;
  if (h1Count !== 1) issues.push(`<h1> должен быть ровно 1, найдено: ${h1Count}`);

  return issues;
}

async function runWriter(task, audience, intents, structure, whitespace, ctx, opts = {}) {
  const lakbReady = !!task.__lakb;
  const eeatIssues = Array.isArray(opts.priorEeatIssues) ? opts.priorEeatIssues : null;

  const buildUser = (correctiveIssues = null) => {
    // SEO/GEO 2026: byline + Author JSON-LD. linkArticle не использует
    // систему персон info-article; берём author из task, если задан,
    // иначе пропускаем byline (writer оставит блок пустым).
    const authorName = String(task.author_name || task.__authorName || '').trim();
    const authorRole = String(task.author_role || task.__authorRole || '').trim();
    const dateModified = task.__dateModified || new Date().toISOString().slice(0, 10);
    task.__dateModified = dateModified;
    task.__authorName = authorName;
    task.__authorRole = authorRole;
    const base = [
      `[INPUTS]`,
      `topic: ${task.topic}`,
      `anchor_text: ${task.anchor_text}`,
      `anchor_url: ${task.anchor_url}`,
      `focus_notes: ${task.focus_notes || '[не задано]'}`,
      `output_format: ${task.output_format || 'html'}`,
      `author_name: ${authorName || '[не задано — пропусти byline-блок]'}`,
      `author_role: ${authorRole || '[не задано]'}`,
      `date_modified: ${dateModified}`,
      `current_year: ${new Date().getFullYear()}`,
      // При активном LAKB вместо толстых JSON-дампов отправляем короткие
      // указатели на разделы LAKB (он уже уехал systemInstruction'ом /
      // в Gemini cachedContents). Это и есть «кэширование DeepSeek-аналитики
      // и передача её в Gemini» из требования.
      `stage0_audience: ${pointerOrJson('§3 Аудитория и тон', audience, lakbReady, 3500)}`,
      `stage1_intents: ${pointerOrJson('§4 Сущности/интенты/вопросы', intents, lakbReady, 5000)}`,
      `whitespace_hints: ${pointerOrJson('§5 White-space → article_hierarchy_hints',
        (whitespace && whitespace.article_hierarchy_hints) || {}, lakbReady, 2500)}`,
      `stage2_structure: ${pointerOrJson('§6 Структура статьи', structure, lakbReady, 8000)}`,
    ];
    // Sprint B: relevance-артефакт (LSI/ngrams/H2-H3 наброски) — добавляем
    // как отдельный блок, чтобы Gemini обязательно использовал LSI-леммы
    // и не пропустил темы из общих заголовков топа.
    if (task.__relevanceArtifact) {
      try {
        const { renderForPromptBrief } = require('../relevance/relevanceArtifacts');
        const brief = renderForPromptBrief(task.__relevanceArtifact);
        if (brief) {
          base.push('');
          base.push(brief);
          base.push('Обязательно: использовать перечисленные LSI-леммы и n-граммы естественным образом; раскрыть темы из H2/H3-набросков (можно адаптировать формулировку).');
          if (Array.isArray(task.__relevanceArtifact.directives) && task.__relevanceArtifact.directives.length) {
            base.push('Обязательно выполни ДИРЕКТИВЫ (наш сайт vs ТОП): добавь недостающие слова (under/missing) и сократи использование переспамленных слов (over).');
          }
        }
      } catch (_) { /* graceful */ }
    }
    if (eeatIssues && eeatIssues.length) {
      base.push('');
      base.push('[PRIOR_EEAT_ISSUES — корректировочный проход. Закрой каждую issue в новой версии:]');
      for (const it of eeatIssues.slice(0, 12)) {
        base.push(`- [${it.severity || 'minor'}|${it.category || 'misc'}] @${it.where || 'article'}: ${it.problem || ''} → ${it.fix_instruction || ''}`);
      }
    }
    if (correctiveIssues && correctiveIssues.length) {
      base.push('');
      base.push('[CORRECTIVE PASS — в предыдущем ответе нарушены следующие правила:]');
      for (const it of correctiveIssues) base.push(`- ${it}`);
      base.push('');
      base.push('Пересобери статью так, чтобы все эти проблемы были устранены, сохранив все уже корректные аспекты.');
    }
    return base.join('\n');
  };

  // first/corrective system: when Gemini cachedContent is active, the cache
  // already contains LAKB + writer-instructions combined (см. orchestrator).
  // Иначе — собираем тут.
  const writerInstructions = loadLinkArticlePrompt('stage3');
  const systemFull = task.__lakb
    ? `${task.__lakb}\n\n========================================\n${writerInstructions}`
    : writerInstructions;
  const systemArg = task.__geminiCacheName ? '' : systemFull;

  // First attempt
  let result = await callLLM(
    'gemini',
    systemArg,
    buildUser(null),
    {
      retries: 3,
      temperature: 0.5,
      maxTokens: 16384,
      callLabel: opts.callLabel || 'LinkArticle Stage 3 (writer)',
      ...lakbCallOpts(task),
      ...ctx,
    },
  );

  let html = typeof result?.article_html === 'string' ? result.article_html : '';
  let issues = validateWriterOutput(html, task);

  if (issues.length) {
    await appendLog(ctx.taskId, `⚠ Статья не прошла валидацию: ${issues.length} проблем — делаем корректировочный прогон`, 'warn');
    const retry = await callLLM(
      'gemini',
      systemArg,
      buildUser(issues),
      {
        retries: 2,
        temperature: 0.45,
        maxTokens: 16384,
        callLabel: 'LinkArticle Stage 3 (corrective)',
        ...lakbCallOpts(task),
        ...ctx,
      },
    );
    const retryHtml = typeof retry?.article_html === 'string' ? retry.article_html : '';
    const retryIssues = validateWriterOutput(retryHtml, task);
    if (retryIssues.length < issues.length && retryHtml) {
      html   = retryHtml;
      result = retry;
      issues = retryIssues;
    }
  }

  return { html, selfAudit: result?.self_audit || null, remainingIssues: issues };
}

// ── Stage 5: E-E-A-T audit (DeepSeek) ──────────────────────────────────
//
// Phase 2 / С2: использует унифицированный eeatAudit/core.js (общий с
// info-article). Локальная версия вокруг — только для сборки user-prompt'а
// (link-article-специфичные поля: anchor_text/anchor_url) и для прокидывания
// link-article порога LINK_ARTICLE_EEAT_TARGET.
async function runEeatAudit(task, audience, intents, articleHtml, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `audience_digest: ${JSON.stringify(audience).slice(0, 2500)}`,
    `intents_digest: ${JSON.stringify({
      user_questions: (intents && intents.user_questions) || [],
      entities: (intents && Array.isArray(intents.entities) ? intents.entities.slice(0, 12) : []),
    }).slice(0, 3500)}`,
    `article_html: ${articleHtml.slice(0, 14000)}`,
  ].join('\n');

  return runEeatAuditCore({
    adapter:   'deepseek',
    system:    loadLinkArticlePrompt('stage5Eeat'),
    userText:  user,
    threshold: LINK_ARTICLE_EEAT_TARGET,
    callOptions: { retries: 3, temperature: 0.2, callLabel: 'LinkArticle Stage 5 (E-E-A-T audit)', ...ctx },
    // chunkOpts намеренно не передаём: link-article короче (≤ ~6kb обычно),
    // и историческое поведение «один LLM-вызов» сохранено для обратной
    // совместимости с существующими E-E-A-T логами и метриками link-article.
  });
}

async function runImagePromptsGen(task, structure, articleHtml, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `stage2_structure: ${JSON.stringify(structure).slice(0, 6000)}`,
    `article_html: ${articleHtml.slice(0, 12000)}`,
  ].join('\n');

  const result = await callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage4Images'),
    user,
    { retries: 3, temperature: 0.4, callLabel: 'LinkArticle Stage 4 (image prompts)', ...ctx },
  );

  const prompts = Array.isArray(result?.image_prompts) ? result.image_prompts : [];
  // editorial_mode=strict по умолчанию для внешних (биржевых) публикаций:
  // усиливаем negative_prompt строгим editorial-скелетом (no text overlays /
  // logos / surreal / malformed hands-faces / glossy generic stock),
  // объединяя с тем, что вернул LLM. Это снижает AI-generic look и
  // повышает editorial-safety для публикуемости.
  const editorialMode = (getImagePipelineConfig().editorialModeDefault) || 'strict';
  const strictNeg = editorialMode === 'strict'
    ? [...IMAGE_NEGATIVE_BASE, ...IMAGE_NEGATIVE_STRICT_EXTRA]
    : IMAGE_NEGATIVE_BASE;
  return prompts.slice(0, 3).map((p, idx) => {
    const llmNeg = String(p.negative_prompt || '').trim();
    const merged = Array.from(new Set([
      ...strictNeg,
      ...(llmNeg ? llmNeg.split(',').map((s) => s.trim()).filter(Boolean) : []),
    ])).join(', ').slice(0, 400);
    return {
      slot:            p.slot || idx + 1,
      section_h2:      String(p.section_h2 || '').slice(0, 200),
      visual_prompt:   String(p.visual_prompt || '').slice(0, 2000),
      negative_prompt: merged,
      alt_ru:          String(p.alt_ru || '').slice(0, 200),
      editorial_mode:  editorialMode,
      status:          'pending',
      image_base64:    null,
      mime_type:       null,
      error:           null,
    };
  });
}

async function runImageGeneration(taskId, imagePrompts) {
  const results = imagePrompts.map((p) => ({ ...p }));

  // Простой батчевый параллелизм. MAX_PARALLEL_IMAGES обычно = 3
  // (размер массива), поэтому это фактически один батч Promise.all.
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

function embedImages(html, imagePrompts) {
  let out = html;
  for (const p of imagePrompts) {
    const placeholder = `<!-- IMAGE_SLOT_${p.slot} -->`;
    if (p.status === 'done' && p.image_base64) {
      // alt-атрибут оставляем — он невидим на странице, но нужен для SEO/доступности
      // и обычно требуется биржевыми проверками. Поведение копирования (как HTML и
      // как форматированный текст) от этого не страдает.
      //
      // Production-режим (storage_mode=cdn_upload) → <img> по URL с
      // lazy/async/width/height для производительности страницы и Google
      // Images; draft/fallback (inline_base64) → data:URI как раньше.
      const alt = escapeHtml(p.alt_ru || '');
      const useUrl = p.storage_mode === 'cdn_upload' && p.image_url;
      const src = useUrl ? escapeHtml(p.image_url) : `data:${p.mime_type};base64,${p.image_base64}`;
      const dims = [];
      if (useUrl && Number(p.width) > 0) dims.push(`width="${Number(p.width)}"`);
      if (useUrl && Number(p.height) > 0) dims.push(`height="${Number(p.height)}"`);
      const perf = useUrl ? ' loading="lazy" decoding="async"' : '';
      const img = `<img src="${src}" alt="${alt}"${dims.length ? ` ${dims.join(' ')}` : ''}${perf} />`;
      const caption = p.caption_ru && String(p.caption_ru).trim()
        ? `<figcaption>${escapeHtml(p.caption_ru)}</figcaption>` : '';
      const figure = `<figure class="link-article-image">${img}${caption}</figure>`;
      out = out.replace(placeholder, figure);
    } else {
      // Неуспешный слот — просто убираем плейсхолдер, чтобы он не «торчал» в финальном HTML.
      out = out.replace(placeholder, '');
    }
  }
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// HTML → форматированный текст (простой strip-tags с переносами).
// NB: мы не используем jsdom ради зависимости — это вывод для копипасты
// в биржевые WYSIWYG-редакторы, поэтому достаточно грубой очистки. Главное:
// (1) стрипим теги в цикле до идемпотентности — чтобы вложенные конструкции
//     вида «&lt;script&gt;» не всплыли как новый тег после одного прохода;
// (2) декодируем `&amp;` ПОСЛЕДНИМ, чтобы не получить double-unescape:
//     строка `&amp;lt;` должна превратиться в `&lt;`, а не в `<`.
function buildPlainText(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<\/(p|h1|h2|h3|h4|li|figure|figcaption|blockquote)\s*>/gi, '$&\n\n');
  s = s.replace(/<br\s*\/?>(\s*)/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');

  // Strip all remaining tags — loop until stable, чтобы обезвредить «наложенные»
  // паттерны вроде «<<script>script>» (после первой итерации остаётся «<script>»,
  // вторая итерация его удалит).
  const tagRe = /<[^>]+>/g;
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(tagRe, '');
    if (next === s) break;
    s = next;
  }

  // Декодирование HTML-сущностей. Порядок важен: `&amp;` идёт последним.
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&amp;/g, '&');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ── Main entrypoint ──────────────────────────────────────────────────

async function processLinkArticleTask(taskId) {
  if (IN_PROGRESS.has(taskId)) return;
  IN_PROGRESS.add(taskId);

  // Tracked across try/catch/finally for cleanup paths.
  let geminiCacheName = null;
  let funnel = null;
  let topicDiscoveryResult = null;

  try {
    const { rows } = await db.query(
      `SELECT * FROM link_article_tasks WHERE id = $1`,
      [taskId],
    );
    const task = rows[0];
    if (!task) {
      console.error(`[linkArticle] task ${taskId} not found`);
      return;
    }

    funnel = createFunnelTracker({ kind: 'link_article', taskRef: taskId, userId: task.user_id, niche: task.topic || null });
    FUNNELS.set(taskId, funnel);

    // Sprint B: подключаем relevance-артефакт (LSI/ngrams/H2/H3-черновики),
    // если у задачи указан source_relevance_report_id. Загружается через
    // общий extractor, прокидывается в task.__relevanceArtifact и далее
    // в user-prompt runWriter через renderForPromptBrief.
    if (task.source_relevance_report_id) {
      try {
        const { loadArtifact } = require('../relevance/relevanceArtifacts');
        const art = await loadArtifact(db, {
          reportId: task.source_relevance_report_id,
          userId: task.user_id,
        });
        if (art) {
          task.__relevanceArtifact = art;
          await appendLog(
            taskId,
            `📚 Relevance-артефакт: LSI=${art.important_lsi.length}, ngrams=${art.top_ngrams.length}, h2=${art.h2_drafts.length}, h3=${art.h3_drafts.length}`,
            'info',
          );
          try {
            require('../aegis/moduleHooks').observeStage({
              module: 'linkArticle', stage: 'relevance_artifact_loaded', taskId,
              payload: {
                lsi: art.important_lsi.length, ngrams: art.top_ngrams.length,
                h2: art.h2_drafts.length, h3: art.h3_drafts.length,
              },
            });
          } catch (_) { /* graceful */ }
        }
      } catch (e) {
        await appendLog(taskId, `⚠ relevance-артефакт не загружен (${e.message})`, 'warn');
      }
    }

    await db.query(
      `UPDATE link_article_tasks
          SET status = 'running', started_at = COALESCE(started_at, NOW()),
              progress_pct = 1, error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [taskId],
    );
    publishEvent(taskId, 'status', { status: 'running' });
    await appendLog(taskId, '🚀 Старт генерации ссылочной статьи', 'ok');

    // 0. M-1 Topic Discovery (InfoGapRadar) — до Stage 0, за флагом
    //    TOPIC_DISCOVERY_ENABLED (default on, fail-open). Задача 1.3 ТЗ.
    if (TOPIC_DISCOVERY_ENABLED) {
      try {
        const topicDiscovery = require('../topicDiscovery/topicDiscovery.service');
        const td = await topicDiscovery.runTopicDiscovery({
          query: task.topic,
          niche: task.topic || '',
          serpVerification: task.__relevanceArtifact && task.__relevanceArtifact.serpVerification
            ? task.__relevanceArtifact.serpVerification
            : null,
          log: (m) => { console.log(`[linkArticle:${taskId}] ${m}`); },
        });
        await saveStageResult(taskId, 'topic_discovery', td);
        topicDiscoveryResult = td;
        await appendLog(
          taskId,
          `🧭 Topic Discovery: state=${td.topic_state}`
            + `${td.topic_score != null ? ` score=${td.topic_score}` : ''}`
            + `${td.manual_review ? ' (manual_review)' : ''}`,
          td.manual_review ? 'warn' : 'ok',
        );
        if (td.topic_state === 'abundance' && td.sub_niche_suggestions.length && !TOPIC_AUTO_PIVOT) {
          await appendLog(
            taskId,
            `⚠ Abundance: рекомендованы подтемы — ${td.sub_niche_suggestions.slice(0, 3).join('; ')}`,
            'warn',
          );
        }
      } catch (tdErr) {
        await appendLog(taskId, `⚠ Topic Discovery: ошибка (${tdErr.message}) — продолжаем`, 'warn');
      }
    }

    // 1. Pre-Stage 0
    await setStage(taskId, 'pre_stage0', 8);
    const ctx = buildCallCtx(taskId, 'link_article');
    const strategy = await runPreStrategy(task, ctx);
    await saveStageResult(taskId, 'strategy_context', strategy);

    // 2. Stage 0
    await setStage(taskId, 'stage0_audience', 18);
    const audience = await runAudience(task, strategy, ctx);
    await saveStageResult(taskId, 'stage0_audience', audience);

    // 3. Stage 1
    await setStage(taskId, 'stage1_intents', 28);
    const intents = await runIntents(task, strategy, audience, ctx);
    await saveStageResult(taskId, 'stage1_intents', intents);

    // 3b. Stage 1B — White-space discovery (DeepSeek)
    await setStage(taskId, 'stage1b_whitespace', 38);
    const whitespace = await runWhitespace(task, strategy, audience, ctx);
    await saveStageResult(taskId, 'whitespace_analysis', whitespace);

    // 3c. Google SERP → GIST delta + §10/§11 аналитика (fail-open).
    await setStage(taskId, 'stage1b_gist_delta', 42);
    const gistDelta = await runGoogleSerpGistDelta(task, audience, ctx);
    await saveStageResult(taskId, 'gist_delta_json', gistDelta);
    if (gistDelta.information_delta.length) {
      await appendLog(
        taskId,
        `🔎 GIST delta: ${gistDelta.information_delta.length} тезис(ов), SERP pages=${gistDelta.serp_results.length}`,
        'info',
      );
    } else if (gistDelta.error) {
      await appendLog(taskId, `⚠ GIST delta пропущена: ${gistDelta.error}`, 'warn');
    }

    const competitiveBrief = await runCompetitivePurchaseBrief(
      task, strategy, audience, whitespace, gistDelta, ctx,
    );

    // 4. Stage 2 (структура — с учётом whitespace.article_hierarchy_hints)
    await setStage(taskId, 'stage2_structure', 48);
    const structure = await runStructure(task, audience, intents, whitespace, ctx);
    await saveStageResult(taskId, 'stage2_structure', structure);

    // 4b. Build LAKB (LINK-ARTICLE KNOWLEDGE BASE) + optional Gemini cachedContents.
    //     Это и есть «кэширование DeepSeek-аналитики и передача её в Gemini».
    task.__lakb = buildLinkArticleKnowledgeBase({
      task, strategy, audience, intents, whitespace, structure, competitiveBrief, gistDelta,
    });
    await appendLog(taskId, `🧠 LAKB собрана (${task.__lakb.length} символов)`, 'info');

    if (LINK_ARTICLE_GEMINI_CACHE_ENABLED) {
      try {
        const writerInstructions = loadLinkArticlePrompt('stage3');
        // Gemini cachedContents требует ≥ 4096 input-токенов. Объединяем
        // LAKB + writer-instructions, чтобы один кэш покрывал и system-промпт,
        // и аналитический контекст. При cache-hit ни то, ни другое не уходит
        // в каждый вызов второй раз.
        const cacheText = `${task.__lakb}\n\n========================================\n${writerInstructions}`;
        const created = await createCachedContent({
          systemInstruction: cacheText,
          ttlSeconds: LINK_ARTICLE_GEMINI_CACHE_TTL_S,
          model: normalizeGeminiCopywritingModel(task.gemini_model),
        });
        task.__geminiCacheName = created.name;
        geminiCacheName = created.name;
        await db.query(
          `UPDATE link_article_tasks SET gemini_cache_name = $2, updated_at = NOW() WHERE id = $1`,
          [taskId, created.name],
        );
        await appendLog(taskId, `💾 Gemini cachedContents создан (${created.name})`, 'ok');
      } catch (e) {
        await appendLog(taskId, `⚠ Gemini cachedContents не создался (${e.message}) — продолжаем без кэша`, 'warn');
        task.__geminiCacheName = null;
      }
    }

    // 5. Stage 3 (writer, Gemini)
    await setStage(taskId, 'stage3_writer', 58);
    let { html: articleHtml, remainingIssues } =
      await runWriter(task, audience, intents, structure, whitespace, ctx);
    if (!articleHtml) {
      throw new Error('Gemini не сгенерировал статью (пустой article_html)');
    }
    if (remainingIssues.length) {
      await appendLog(
        taskId,
        `⚠ Остались замечания после corrective-retry: ${remainingIssues.join('; ')}`,
        'warn',
      );
    }

    // 5b. Stage 5 — E-E-A-T audit (DeepSeek). Если total_score ниже целевого
    //     порога и нет blocker'ов на галлюцинации/anchor → один корректировочный
    //     проход writer'а с передачей prior_eeat_issues.
    await setStage(taskId, 'stage5_eeat_audit', 68);
    let eeatAudit = null;
    let linkQualityPatternsReport = detectBannedPatterns(articleHtml);
    let linkLsiReport = measureLinkLsiCoverage(articleHtml, task, strategy, intents);
    try {
      eeatAudit = await runEeatAudit(task, audience, intents, articleHtml, ctx);
      await db.query(
        `UPDATE link_article_tasks
            SET eeat_audit = $2, eeat_score = $3, updated_at = NOW()
          WHERE id = $1`,
        [taskId, JSON.stringify(eeatAudit), eeatAudit.total_score],
      );
      await appendLog(
        taskId,
        `🧪 E-E-A-T аудит: total=${eeatAudit.total_score.toFixed(1)} / verdict=${eeatAudit.verdict} / issues=${eeatAudit.issues.length}`,
        eeatAudit.verdict === 'pass' ? 'ok' : 'info',
      );

      linkQualityPatternsReport = detectBannedPatterns(articleHtml);
      linkLsiReport = measureLinkLsiCoverage(articleHtml, task, strategy, intents);
      const needsRefine =
        eeatAudit.verdict === 'refine' ||
        (eeatAudit.verdict !== 'reject' && eeatAudit.total_score < LINK_ARTICLE_EEAT_TARGET) ||
        linkLsiReport.coverage_pct < 60 ||
        linkQualityPatternsReport.ok === false;
      const refineIssues = buildQualityRefineIssues({
        eeatAudit,
        patternReport: linkQualityPatternsReport,
        lsiReport: linkLsiReport,
      });

      if (needsRefine && refineIssues.length) {
        await setStage(taskId, 'stage3_writer_eeat_refine', 72);
        await appendLog(
          taskId,
          `↻ Quality refine: E-E-A-T target=${LINK_ARTICLE_EEAT_TARGET}, ` +
          `LSI=${linkLsiReport.coverage_pct}%, patterns_ok=${linkQualityPatternsReport.ok}`,
          'info',
        );
        const refined = await runWriter(
          task, audience, intents, structure, whitespace, ctx,
          { priorEeatIssues: refineIssues, callLabel: 'LinkArticle Stage 3 (quality refine)' },
        );
        if (refined.html) {
          articleHtml = refined.html;
          linkQualityPatternsReport = detectBannedPatterns(articleHtml);
          linkLsiReport = measureLinkLsiCoverage(articleHtml, task, strategy, intents);
          // Re-audit refined version (best-effort; не падаем при ошибке).
          try {
            const reaudit = await runEeatAudit(task, audience, intents, articleHtml, ctx);
            await db.query(
              `UPDATE link_article_tasks
                  SET eeat_audit = $2, eeat_score = $3, updated_at = NOW()
                WHERE id = $1`,
              [taskId, JSON.stringify(reaudit), reaudit.total_score],
            );
            eeatAudit = reaudit;
            await appendLog(
              taskId,
              `🧪 E-E-A-T re-audit: total=${reaudit.total_score.toFixed(1)} / verdict=${reaudit.verdict}`,
              reaudit.verdict === 'pass' ? 'ok' : 'info',
            );
          } catch (e) {
            await appendLog(taskId, `⚠ Re-audit не выполнился: ${e.message}`, 'warn');
          }
        }
      } else if (eeatAudit.verdict === 'reject') {
        await appendLog(taskId, `⛔ E-E-A-T verdict=reject — статья требует ручного просмотра`, 'warn');
      }
    } catch (e) {
      await appendLog(taskId, `⚠ E-E-A-T аудит пропущен (${e.message})`, 'warn');
    }

    // 6. Stage 4 (image prompts)
    await setStage(taskId, 'stage4_image_prompts', 78);
    const imagePrompts = await runImagePromptsGen(task, structure, articleHtml, ctx);
    if (imagePrompts.length < 3) {
      await appendLog(taskId, `⚠ DeepSeek вернул только ${imagePrompts.length} image-промпта вместо 3`, 'warn');
    }
    await saveStageResult(taskId, 'image_prompts', imagePrompts);

    // 7. Image generation (Nano Banana Pro)
    await setStage(taskId, 'image_generation', 87);
    const renderedImages = await runImageGeneration(taskId, imagePrompts);
    await saveStageResult(taskId, 'image_prompts', renderedImages);

    // 7a. Production delivery + Semantic QA + Image Quality Gate
    //     (content-grounded pipeline, services/images). Плейсхолдерная
    //     механика сохранена — здесь только доставка/оценка. Behind flags,
    //     никогда не роняет pipeline.
    let deliveredImages = renderedImages;
    try {
      const imgCfg = getImagePipelineConfig();
      if (imgCfg.storageMode === 'cdn_upload') {
        deliveredImages = await persistImages(deliveredImages, taskId, imgCfg);
        await saveStageResult(taskId, 'image_prompts', deliveredImages);
        const storedN = deliveredImages.filter((p) => p && p.image_url).length;
        await appendLog(taskId, `🗄 Production storage (cdn_upload): сохранено ${storedN} файл(ов)`, storedN ? 'ok' : 'info');
      }
      let semanticQa = null;
      if (imgCfg.semanticQaEnabled) {
        semanticQa = runSemanticImageQa(deliveredImages, { genericScoreThreshold: imgCfg.genericScoreThreshold });
        await saveStageResult(taskId, 'image_semantic_qa_report', semanticQa);
        for (const r of semanticQa.slots) {
          const slot = deliveredImages.find((p) => (p.slot || 1) === r.slot);
          if (slot) { slot.semantic_qa_result = r.verdict; slot.semantic_qa_scores = r.scores; }
        }
        await saveStageResult(taskId, 'image_prompts', deliveredImages);
        const ss = semanticQa.summary;
        const icon = ss.verdict === 'pass' ? '✅' : ss.verdict === 'review' ? '⚠' : ss.verdict === 'na' ? 'ℹ' : '❌';
        await appendLog(taskId, `${icon} Semantic Image QA: pass=${ss.passSlots}/${ss.totalSlots} review=${ss.reviewSlots} fail=${ss.failSlots} verdict=${ss.verdict}`, ss.verdict === 'fail' ? 'warn' : 'info');
      }
      const gate = evaluateImageGate({ imagePrompts: deliveredImages, semanticQa, config: imgCfg });
      await saveStageResult(taskId, 'image_gate', gate);
      const gicon = gate.canFinalize ? (gate.verdict === 'pass' || gate.verdict === 'na' ? '✅' : '⚠') : '❌';
      await appendLog(taskId, `${gicon} Image Gate: verdict=${gate.verdict} canFinalize=${gate.canFinalize}` + (gate.blockers.length ? ` | blockers: ${gate.blockers.slice(0, 3).join('; ')}` : ''), gate.canFinalize ? 'info' : 'warn');
    } catch (imgErr) {
      await appendLog(taskId, `⚠ Image delivery/semantic-QA/gate не выполнились: ${imgErr.message} — продолжаем`, 'warn');
    }

    // 7b. Quality Score — детерминированный агрегат по eeat_audit и др.
    //     отчётам. Не делает сети. Используется в /api/admin/model-comparison.
    // Перед quality_score — финальный лог по статистике Gemini Context Cache.
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
      const { rows: [t] } = await db.query(
        `SELECT eeat_audit, gemini_model,
                total_cost_usd, total_tokens_in, total_tokens_out,
                started_at
           FROM link_article_tasks
          WHERE id = $1`,
        [taskId],
      );
      if (t) {
        const elapsedMs = t.started_at
          ? Date.now() - new Date(t.started_at).getTime()
          : null;
        const quality = computeQualityScore(
          { eeat_audit: t.eeat_audit },
          {
            model_used:         t.gemini_model,
            cost_usd:           Number(t.total_cost_usd)   || 0,
            tokens_in:          Number(t.total_tokens_in)  || 0,
            tokens_out:         Number(t.total_tokens_out) || 0,
            generation_time_ms: elapsedMs,
          },
        );
        await saveStageResult(taskId, 'quality_score', quality);
        try {
          await recordTrainingExample({
            articleRef: `link_article:${taskId}`,
            kind: 'link_article',
            niche: null,
            userPrompt: task.topic || '',
            htmlOutput: articleHtml || '',
            qualityScore: quality,
            feedbackMetrics: null,
            modelUsed: quality.model_used || t.gemini_model || null,
            costUsd: Number(t.total_cost_usd) || 0,
            userId: task.user_id || null,
            promptHash: resolvePromptHash('linkArticle/stage3_writer'),
          });
          await recordQualityLog({
            articleRef: `link_article:${taskId}`,
            kind: 'link_article',
            niche: null,
            qualityScore: quality,
            reports: { eeat_audit: t.eeat_audit },
            modelUsed: quality.model_used || t.gemini_model || null,
            costUsd: Number(t.total_cost_usd) || 0,
            iterations: 1,
            taskRef: taskId,
            userId: task.user_id || null,
            userPrompt: task.topic || '',
            promptHash: resolvePromptHash('linkArticle/stage3_writer'),
          });
          const eeat = quality && quality.subscores ? Number(quality.subscores.eeat) : null;
          await biobrainClient.feedback({
            features: null,
            predicted: null,
            real_spq_overall: quality.overall,
            real_eeat: Number.isFinite(eeat) ? eeat : null,
          });
        } catch (_e) { /* best-effort */ }
        if (quality.overall !== null) {
          await appendLog(
            taskId,
            `📊 Quality score: ${quality.overall.toFixed(1)}/100 (model=${quality.model_used || '?'})`,
            'info',
          );
        }
      }
    } catch (qsErr) {
      console.warn(`[linkArticle] computeQualityScore failed: ${qsErr.message}`);
    }

    // 8. Embed images + strip any unused placeholders
    let finalHtml  = embedImages(articleHtml, deliveredImages);
    let finalPlain = buildPlainText(finalHtml);

    // 8a-bis. LinguaForensic v3.6 — детекция AI-текста + fluency-рерайт
    //     (skill skills/AI-detect-v-3-6.md, общий с gist_py M8). Усиливает
    //     каркас, не заменяя его: graceful, при ошибке/низкой роботности
    //     текст не меняется. Отчёт попадает в quality_gate.lingua_forensic.
    let linguaForensicReport = null;
    let linguaForensicManualReview = false;
    try {
      const { runLinguaForensicPass } = require('../linguaForensic');
      await setStage(taskId, 'linguaforensic', 98);
      const lfResult = await runLinguaForensicPass(finalHtml, {
        pipeline: 'link',
        taskId,
        log: (m, l) => { appendLog(taskId, m, l || 'info').catch(() => {}); },
        maxRobotness: 25,
        maxPasses: LINK_ARTICLE_LF_MAX_PASSES,
        maxStrategy: 'medium',
        strategySequence: ['light', 'medium'].slice(0, LINK_ARTICLE_LF_MAX_PASSES),
      });
      linguaForensicReport = lfResult.report;
      const robotnessAfter = Number(lfResult.report?.robotness_after);
      linguaForensicManualReview = Number.isFinite(robotnessAfter) && robotnessAfter > 25;
      if (lfResult.report?.verdict === 'rewritten') {
        finalHtml  = lfResult.html;
        finalPlain = buildPlainText(finalHtml);
        linkQualityPatternsReport = detectBannedPatterns(finalHtml);
        linkLsiReport = measureLinkLsiCoverage(finalHtml, task, strategy, intents);
        await appendLog(
          taskId,
          `🕵️ LinguaForensic: рерайт принят — роботность ${lfResult.report.robotness_before}% → ${lfResult.report.robotness_after}%`,
          'ok',
        );
      }
      if (linguaForensicManualReview) {
        await appendLog(taskId, '⚠ LinguaForensic: роботность выше 25% после лимита проходов — manual_review', 'warn');
      }
    } catch (lfErr) {
      console.warn(`[linkArticle] LinguaForensic failed: ${lfErr.message}`);
    }

    // 8b. SEO/GEO 2026: JSON-LD (Article + Author + FAQPage [+ HowTo]).
    let articleHtmlWithSchema = finalHtml;
    let jsonLdBlocks = null;
    let authorByline = null;
    try {
      const {
        buildArticleJsonLd,
        buildFaqPageJsonLd,
        buildHowToJsonLd,
        assembleJsonLdScripts,
      } = require('../seo/geoSchema');
      const {
        extractH1,
        extractFaqItems,
        extractHowToSteps,
        extractCoverImage,
        buildArticleDescription,
      } = require('../seo/geoExtractor');

      const headline = extractH1(finalHtml) || task.topic || '';
      const description = buildArticleDescription(finalHtml);
      const datePublished = task.created_at
        ? new Date(task.created_at).toISOString()
        : new Date().toISOString();
      const dateModified = task.__dateModified
        ? `${task.__dateModified}T00:00:00.000Z`
        : new Date().toISOString();

      // Видимый блок «Об авторе» (E-E-A-T, Задача 2) + sameAs для JSON-LD.
      let authorSameAs = [];
      let visibleAuthorHtml = '';
      if (AUTHOR_BLOCK_ENABLED && task.__authorName) {
        try {
          const { buildAuthorBlock } = require('../seo/authorBlock.service');
          const ab = buildAuthorBlock({
            persona: {
              name: task.__authorName,
              role: task.__authorRole,
              short_bio: task.author_bio || '',
            },
            company: {
              company_name: task.brand_name || task.brand || '',
              company_url: task.target_site_url || task.anchor_url || '',
              social_links: Array.isArray(task.__companySocialLinks) ? task.__companySocialLinks : [],
            },
            dateModified: task.__dateModified || '',
          });
          authorSameAs = ab.sameAs || [];
          visibleAuthorHtml = ab.html || '';
        } catch (abErr) {
          console.warn(`[linkArticle] author block failed: ${abErr.message}`);
        }
      }

      const article = buildArticleJsonLd({
        articleType: 'BlogPosting',
        headline,
        description,
        datePublished,
        dateModified,
        inLanguage: 'ru-RU',
        author: task.__authorName ? {
          name: task.__authorName,
          jobTitle: task.__authorRole || '',
          sameAs: authorSameAs,
        } : null,
        image: extractCoverImage(finalHtml),
      });

      const faqItems = extractFaqItems(finalHtml);
      const faq = faqItems.length >= 1 ? buildFaqPageJsonLd(faqItems) : null;

      let howto = null;
      const isHowto = !!(structure && structure.is_howto);
      if (isHowto) {
        const stepsFromOutline = Array.isArray(structure.howto_steps) ? structure.howto_steps : [];
        const stepsFromHtml = extractHowToSteps(finalHtml);
        const steps = stepsFromHtml.length >= 2 ? stepsFromHtml : stepsFromOutline;
        if (steps && steps.length >= 2) {
          howto = buildHowToJsonLd({ name: headline, description, steps });
        }
      }

      const bodyHtml = visibleAuthorHtml ? `${finalHtml}\n${visibleAuthorHtml}` : finalHtml;

      const blocks = [article, faq, howto].filter(Boolean);
      if (blocks.length > 0) {
        const scripts = assembleJsonLdScripts(blocks);
        articleHtmlWithSchema = `${bodyHtml}\n${scripts.join('\n')}`;
        jsonLdBlocks = blocks;
      } else if (visibleAuthorHtml) {
        articleHtmlWithSchema = bodyHtml;
      }
      if (task.__authorName) {
        authorByline = task.__authorRole
          ? `Автор: ${task.__authorName}, ${task.__authorRole}. Обновлено: ${task.__dateModified || ''}`.trim()
          : `Автор: ${task.__authorName}. Обновлено: ${task.__dateModified || ''}`.trim();
      }
      await appendLog(
        taskId,
        `🧬 JSON-LD: ${blocks.length} блок(а) (${blocks.map((b) => b['@type']).join(', ')})`,
        'info',
      );
    } catch (schemaErr) {
      console.warn(`[linkArticle] JSON-LD build failed: ${schemaErr.message}`);
    }

    // 8c. Unified Quality Core (Content Gen v2, Фаза 3): единый gate для
    //     ссылочного пайплайна. У link-статей нет value-add требований
    //     (цель — публикуемость, не топ SERP), поэтому finalize('link')
    //     проверяет в основном freshness / stop-phrases / banned formulations
    //     и disclosure. Graceful: НЕ роняет генерацию, НЕ меняет status.
    let linkQualityGateVerdict = null;
    try {
      const { qualityGate } = require('../qualityCore');
      const gateResult = await qualityGate.runForTask({
        pipeline: 'link',
        taskId,
        raw: {
          html: finalHtml,
          niche: task.topic || task.region || '',
          currentYear: new Date().getFullYear(),
          topicDiscovery: topicDiscoveryResult,
          authorship: {
            byline:   authorByline || task.__authorName || null,
            reviewer: task.__reviewerName || null,
            sources:  Array.isArray(jsonLdBlocks) && jsonLdBlocks.length ? jsonLdBlocks : null,
          },
        },
      });
      linkQualityGateVerdict = {
        canPublish: gateResult.canPublish,
        ymyl:       gateResult.ymyl,
        blockers:   gateResult.blockers.map((b) => ({ name: b.name, verdict: b.verdict })),
        warnings:   gateResult.warnings.map((w) => ({ name: w.name, verdict: w.verdict })),
        summary:    gateResult.summary,
        lingua_forensic: linguaForensicReport
          ? {
              verdict:          linguaForensicReport.verdict,
              robotness_before: linguaForensicReport.robotness_before ?? null,
              robotness_after:  linguaForensicReport.robotness_after ?? null,
              passes:           linguaForensicReport.passes ?? 0,
              manual_review_required: linguaForensicManualReview,
            }
          : null,
        quality_patterns: linkQualityPatternsReport,
        lsi_coverage: linkLsiReport,
        manual_review_required: linguaForensicManualReview,
        checked_at: new Date().toISOString(),
      };
      await appendLog(
        taskId,
        `${gateResult.canPublish ? '✅' : '🚦'} Quality gate: ${gateResult.summary}`,
        gateResult.canPublish ? 'ok' : 'warn',
      );
    } catch (gateErr) {
      console.warn(`[linkArticle] quality gate failed: ${gateErr.message}`);
    }

    // 8c-bis. Stage 8 composite evaluator — fail-open, default ON. Пишет
    // composite_quality_score в link_article_tasks и не влияет на status.
    try {
      const evaluator = await runQualityEvaluator({
        pipeline: 'link',
        taskId,
        articleHtml: finalHtml,
        artifacts: {
          gist_delta_json: gistDelta,
          eeat_score: eeatAudit && eeatAudit.total_score,
          eeat_audit: eeatAudit,
          lsi_coverage: linkLsiReport,
          quality_gate: linkQualityGateVerdict,
        },
        task,
        log: (m, l) => { appendLog(taskId, m, l || 'info').catch(() => {}); },
      });
      if (evaluator && evaluator.composite_quality_score != null) {
        await appendLog(taskId, `📊 Stage 8 composite quality: ${evaluator.composite_quality_score}/100`, 'info');
      }
    } catch (stage8Err) {
      await appendLog(taskId, `⚠ Stage 8 evaluator не выполнился: ${stage8Err.message} — продолжаем`, 'warn');
    }

    // 8d. Мета-теги для ссылочной статьи (Задача D — GIST Meta Filter
    //     Pipeline): пара title/description, которую можно скопировать
    //     отдельно от статьи. Graceful: ошибка генерации мета-тегов НЕ
    //     роняет готовую статью.
    let linkMetaTags = null;
    try {
      const { generateLinkArticleMeta } = require('../metaTags/gistMetaFilter');
      await setStage(taskId, 'meta_tags', 99);
      linkMetaTags = await generateLinkArticleMeta({
        topic: task.topic || '',
        anchorText: task.anchor_text || '',
        articlePlain: finalPlain,
        focusNotes: task.focus_notes || '',
        geminiModel: normalizeGeminiCopywritingModel(task.gemini_model),
      });
      await appendLog(
        taskId,
        `🏷 Мета-теги (GIST): Title ${String(linkMetaTags.title || '').length} симв., Description ${String(linkMetaTags.description || '').length} симв.${linkMetaTags.manual_review_required ? ' · ⚠️ manual review' : ''}`,
        linkMetaTags.manual_review_required ? 'warn' : 'ok',
      );
      const metaUsage = linkMetaTags._meta || {};
      await recordTextTokens(
        taskId,
        metaUsage.provider === 'deepseek' ? 'deepseek' : 'gemini',
        metaUsage.tokensIn || 0,
        metaUsage.tokensOut || 0,
        0,
      );
    } catch (metaErr) {
      console.warn(`[linkArticle] meta tags generation failed: ${metaErr.message}`);
      await appendLog(taskId, `⚠️ Мета-теги не сгенерированы: ${metaErr.message}`, 'warn');
    }

    await db.query(
      `UPDATE link_article_tasks
          SET article_html             = $2,
              article_plain            = $3,
              article_html_with_schema = $4,
              json_ld_blocks           = $5,
              author_byline            = $6,
              quality_gate             = $7,
              meta_tags                = $8,
              status         = 'done',
              progress_pct   = 100,
              current_stage  = 'done',
              completed_at   = NOW(),
              updated_at     = NOW()
        WHERE id = $1`,
      [
        taskId, finalHtml, finalPlain,
        articleHtmlWithSchema, jsonLdBlocks ? JSON.stringify(jsonLdBlocks) : null, authorByline,
        linkQualityGateVerdict ? JSON.stringify(linkQualityGateVerdict) : null,
        linkMetaTags ? JSON.stringify(linkMetaTags) : null,
      ],
    );
    await appendLog(taskId, '🎉 Ссылочная статья готова', 'ok');
    publishEvent(taskId, 'status', { status: 'done' });
    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }
    try {
      const { rows } = await db.query(
        `SELECT quality_score FROM link_article_tasks WHERE id = $1`,
        [taskId],
      );
      const score = rows[0] && rows[0].quality_score && rows[0].quality_score.overall;
      await finalizeByTask({
        table: 'link_article_tasks',
        taskId,
        ok: true,
        spqOverall: score == null ? null : Number(score),
        taskKind: 'link_article',
      });
    } catch (_) { /* no-op */ }

    // 9. Best-effort cleanup Gemini cachedContents (TTL — fallback).
    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
  } catch (err) {
    console.error(`[linkArticle] task ${taskId} failed:`, err);
    if (funnel) { try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ } }
    try {
      await db.query(
        `UPDATE link_article_tasks
            SET status = 'error',
                error_message = $2,
                completed_at  = NOW(),
                updated_at    = NOW()
          WHERE id = $1`,
        [taskId, err.message.slice(0, 1000)],
      );
      await appendLog(taskId, `❌ Ошибка: ${err.message}`, 'err');
      publishEvent(taskId, 'status', { status: 'error', error: err.message });
      await finalizeByTask({
        table: 'link_article_tasks',
        taskId,
        ok: false,
        error: err.message,
        taskKind: 'link_article',
      });
    } catch (_) { /* no-op */ }
  } finally {
    // На любой ветке (success/error) при наличии «висящего» имени кэша —
    // best-effort удаление; TTL подстрахует, если delete упадёт.
    if (geminiCacheName) {
      cleanupGeminiCache(taskId, geminiCacheName);
      geminiCacheName = null;
    }
    IN_PROGRESS.delete(taskId);
    CURRENT_STAGE.delete(taskId);
    FUNNELS.delete(taskId);
    // Освобождаем учёт токенов для задачи: иначе Map tokenBudgetState
    // в callLLM аккумулирует записи навсегда. См. фикс утечки в
    // infoArticlePipeline и аналогичный паттерн в classic-orchestrator.
    resetTaskBudget(taskId);
  }
}

/**
 * cleanupGeminiCache — fire-and-forget удаление Gemini cachedContents
 * и обнуление колонки `gemini_cache_name` в БД. На любой ошибке тихо
 * логируем — TTL подстрахует.
 */
function cleanupGeminiCache(taskId, cacheName) {
  if (!cacheName) return;
  deleteCachedContent(cacheName).catch((e) =>
    console.warn(`[linkArticle] deleteCachedContent ${cacheName}: ${e.message}`));
  db.query(
    `UPDATE link_article_tasks SET gemini_cache_name = NULL, updated_at = NOW() WHERE id = $1`,
    [taskId],
  ).catch(() => {});
}

/**
 * recoverStuckLinkArticleTasks — при старте сервера переводит running-задачи
 * в error (их нельзя продолжить, так как всё состояние in-memory).
 */
async function recoverStuckLinkArticleTasks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE link_article_tasks
          SET status = 'error',
              error_message = 'Сервер был перезапущен во время выполнения задачи',
              completed_at  = NOW(),
              updated_at    = NOW()
        WHERE status = 'running'`,
    );
    if (rowCount > 0) {
      console.log(`[linkArticle] Recovered ${rowCount} stuck running task(s)`);
    }
  } catch (err) {
    if (!/relation .* does not exist/i.test(err.message)) {
      console.warn('[linkArticle] recoverStuckLinkArticleTasks failed:', err.message);
    }
  }
}

module.exports = {
  processLinkArticleTask,
  recoverStuckLinkArticleTasks,
  // Exports for testing only:
  _validateWriterOutput: validateWriterOutput,
  _embedImages: embedImages,
  _buildPlainText: buildPlainText,
  LINK_ARTICLE_GEMINI_MODEL,
  IMAGE_PRICE_USD,
};
