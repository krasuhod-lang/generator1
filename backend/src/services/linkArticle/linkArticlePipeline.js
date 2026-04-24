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
const { callLLM } = require('../llm/callLLM');
const { loadLinkArticlePrompt } = require('../../prompts/linkArticle');
const { generateImage } = require('./nanoBananaPro.adapter');
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
const { EEAT_PQ_TARGET } = require('../../utils/objectiveMetrics');

// ── Config via env ───────────────────────────────────────────────────
const LINK_ARTICLE_GEMINI_MODEL =
  process.env.LINK_ARTICLE_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-3.1-pro-preview';

const MAX_PARALLEL_IMAGES = (() => {
  const v = parseInt(process.env.LINK_ARTICLE_MAX_PARALLEL_IMAGES, 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
})();

const IMAGE_PRICE_USD = (() => {
  const v = parseFloat(process.env.GEMINI_IMAGE_PRICE_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.04; // дефолтное прайс-ориентир
})();

// Включает Gemini cachedContents для LAKB. Должен быть GEMINI_PROXY+GEMINI_API_KEY.
// Минимальный размер кэша у Gemini ≥ 4096 input tokens, поэтому LAKB должна быть
// достаточно объёмной (мы стремимся к ≥ 8 КБ текста ~ ≥ 4–5К токенов).
const LINK_ARTICLE_GEMINI_CACHE_ENABLED =
  String(process.env.LINK_ARTICLE_GEMINI_CACHE_ENABLED || '').toLowerCase() === 'true';

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

const IN_PROGRESS = new Set(); // taskId — защита от двойного старта

// Текущая стадия per-task (in-memory) — используется, чтобы recordEvent
// автоматически прикреплял stage к событию без передачи его во все вызовы.
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

async function runStructure(task, audience, intents, whitespace, ctx) {
  const hints = (whitespace && whitespace.article_hierarchy_hints) || {};
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
    `stage1_intents: ${JSON.stringify(intents).slice(0, 8000)}`,
    `whitespace_hints: ${JSON.stringify(hints).slice(0, 4000)}`,
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
    const base = [
      `[INPUTS]`,
      `topic: ${task.topic}`,
      `anchor_text: ${task.anchor_text}`,
      `anchor_url: ${task.anchor_url}`,
      `focus_notes: ${task.focus_notes || '[не задано]'}`,
      `output_format: ${task.output_format || 'html'}`,
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

  const result = await callLLM(
    'deepseek',
    loadLinkArticlePrompt('stage5Eeat'),
    user,
    { retries: 3, temperature: 0.2, callLabel: 'LinkArticle Stage 5 (E-E-A-T audit)', ...ctx },
  );

  // Нормализация: total_score в [0, 10], issues — массив, verdict — enum.
  const norm = result || {};
  const totalRaw = Number(norm.total_score);
  if (!Number.isFinite(totalRaw)) {
    norm.total_score = 0;
  } else {
    norm.total_score = Math.max(0, Math.min(10, Math.round(totalRaw * 10) / 10));
  }
  if (!Array.isArray(norm.issues)) norm.issues = [];
  if (!['pass', 'refine', 'reject'].includes(norm.verdict)) {
    norm.verdict = norm.total_score >= LINK_ARTICLE_EEAT_TARGET ? 'pass' : 'refine';
  }
  return norm;
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
      const alt = escapeHtml(p.alt_ru || '');
      const figure =
        `<figure class="link-article-image">` +
        `<img src="data:${p.mime_type};base64,${p.image_base64}" alt="${alt}" />` +
        (alt ? `<figcaption>${alt}</figcaption>` : '') +
        `</figure>`;
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

    await db.query(
      `UPDATE link_article_tasks
          SET status = 'running', started_at = COALESCE(started_at, NOW()),
              progress_pct = 1, error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [taskId],
    );
    publishEvent(taskId, 'status', { status: 'running' });
    await appendLog(taskId, '🚀 Старт генерации ссылочной статьи', 'ok');

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

    // 4. Stage 2 (структура — с учётом whitespace.article_hierarchy_hints)
    await setStage(taskId, 'stage2_structure', 48);
    const structure = await runStructure(task, audience, intents, whitespace, ctx);
    await saveStageResult(taskId, 'stage2_structure', structure);

    // 4b. Build LAKB (LINK-ARTICLE KNOWLEDGE BASE) + optional Gemini cachedContents.
    //     Это и есть «кэширование DeepSeek-аналитики и передача её в Gemini».
    task.__lakb = buildLinkArticleKnowledgeBase({
      task, strategy, audience, intents, whitespace, structure,
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

      const needsRefine =
        eeatAudit.verdict === 'refine' ||
        (eeatAudit.verdict !== 'reject' && eeatAudit.total_score < LINK_ARTICLE_EEAT_TARGET);

      if (needsRefine && eeatAudit.issues.length) {
        await setStage(taskId, 'stage3_writer_eeat_refine', 72);
        await appendLog(
          taskId,
          `↻ E-E-A-T < ${LINK_ARTICLE_EEAT_TARGET} — корректировочный прогон writer'а`,
          'info',
        );
        const refined = await runWriter(
          task, audience, intents, structure, whitespace, ctx,
          { priorEeatIssues: eeatAudit.issues, callLabel: 'LinkArticle Stage 3 (E-E-A-T refine)' },
        );
        if (refined.html) {
          articleHtml = refined.html;
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

    // 8. Embed images + strip any unused placeholders
    const finalHtml  = embedImages(articleHtml, renderedImages);
    const finalPlain = buildPlainText(finalHtml);

    await db.query(
      `UPDATE link_article_tasks
          SET article_html   = $2,
              article_plain  = $3,
              status         = 'done',
              progress_pct   = 100,
              current_stage  = 'done',
              completed_at   = NOW(),
              updated_at     = NOW()
        WHERE id = $1`,
      [taskId, finalHtml, finalPlain],
    );
    await appendLog(taskId, '🎉 Ссылочная статья готова', 'ok');
    publishEvent(taskId, 'status', { status: 'done' });

    // 9. Best-effort cleanup Gemini cachedContents (TTL — fallback).
    if (geminiCacheName) {
      const cacheName = geminiCacheName;
      geminiCacheName = null;
      deleteCachedContent(cacheName)
        .then(() => db.query(
          `UPDATE link_article_tasks SET gemini_cache_name = NULL, updated_at = NOW() WHERE id = $1`,
          [taskId],
        ).catch(() => {}))
        .catch((e) => console.warn(`[linkArticle] deleteCachedContent ${cacheName}: ${e.message}`));
    }
  } catch (err) {
    console.error(`[linkArticle] task ${taskId} failed:`, err);
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
    } catch (_) { /* no-op */ }
  } finally {
    // На любой ветке (success/error) при наличии «висящего» имени кэша —
    // best-effort удаление; TTL подстрахует, если delete упадёт.
    if (geminiCacheName) {
      const cacheName = geminiCacheName;
      deleteCachedContent(cacheName).catch(() => {});
      db.query(
        `UPDATE link_article_tasks SET gemini_cache_name = NULL, updated_at = NOW() WHERE id = $1`,
        [taskId],
      ).catch(() => {});
    }
    IN_PROGRESS.delete(taskId);
    CURRENT_STAGE.delete(taskId);
  }
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
