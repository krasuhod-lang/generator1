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

async function runStructure(task, audience, intents, ctx) {
  const user = [
    `[INPUTS]`,
    `topic: ${task.topic}`,
    `anchor_text: ${task.anchor_text}`,
    `anchor_url: ${task.anchor_url}`,
    `focus_notes: ${task.focus_notes || '[не задано]'}`,
    `stage0_audience: ${JSON.stringify(audience).slice(0, 4000)}`,
    `stage1_intents: ${JSON.stringify(intents).slice(0, 8000)}`,
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

async function runWriter(task, audience, intents, structure, ctx) {
  const buildUser = (correctiveIssues = null) => {
    const base = [
      `[INPUTS]`,
      `topic: ${task.topic}`,
      `anchor_text: ${task.anchor_text}`,
      `anchor_url: ${task.anchor_url}`,
      `focus_notes: ${task.focus_notes || '[не задано]'}`,
      `output_format: ${task.output_format || 'html'}`,
      `stage0_audience: ${JSON.stringify(audience).slice(0, 3500)}`,
      `stage1_intents: ${JSON.stringify(intents).slice(0, 5000)}`,
      `stage2_structure: ${JSON.stringify(structure).slice(0, 8000)}`,
    ];
    if (correctiveIssues && correctiveIssues.length) {
      base.push('');
      base.push('[CORRECTIVE PASS — в предыдущем ответе нарушены следующие правила:]');
      for (const it of correctiveIssues) base.push(`- ${it}`);
      base.push('');
      base.push('Пересобери статью так, чтобы все эти проблемы были устранены, сохранив все уже корректные аспекты.');
    }
    return base.join('\n');
  };

  // First attempt
  let result = await callLLM(
    'gemini',
    loadLinkArticlePrompt('stage3'),
    buildUser(null),
    {
      retries: 3,
      temperature: 0.5,
      maxTokens: 16384,
      callLabel: 'LinkArticle Stage 3 (writer)',
      ...ctx,
    },
  );

  let html = typeof result?.article_html === 'string' ? result.article_html : '';
  let issues = validateWriterOutput(html, task);

  if (issues.length) {
    await appendLog(ctx.taskId, `⚠ Статья не прошла валидацию: ${issues.length} проблем — делаем корректировочный прогон`, 'warn');
    const retry = await callLLM(
      'gemini',
      loadLinkArticlePrompt('stage3'),
      buildUser(issues),
      {
        retries: 2,
        temperature: 0.45,
        maxTokens: 16384,
        callLabel: 'LinkArticle Stage 3 (corrective)',
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
    await setStage(taskId, 'pre_stage0', 10);
    const ctx = buildCallCtx(taskId, 'link_article');
    const strategy = await runPreStrategy(task, ctx);
    await saveStageResult(taskId, 'strategy_context', strategy);

    // 2. Stage 0
    await setStage(taskId, 'stage0_audience', 22);
    const audience = await runAudience(task, strategy, ctx);
    await saveStageResult(taskId, 'stage0_audience', audience);

    // 3. Stage 1
    await setStage(taskId, 'stage1_intents', 35);
    const intents = await runIntents(task, strategy, audience, ctx);
    await saveStageResult(taskId, 'stage1_intents', intents);

    // 4. Stage 2
    await setStage(taskId, 'stage2_structure', 48);
    const structure = await runStructure(task, audience, intents, ctx);
    await saveStageResult(taskId, 'stage2_structure', structure);

    // 5. Stage 3 (writer, Gemini)
    await setStage(taskId, 'stage3_writer', 62);
    const { html: articleHtml, remainingIssues } =
      await runWriter(task, audience, intents, structure, ctx);
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

    // 6. Stage 4 (image prompts)
    await setStage(taskId, 'stage4_image_prompts', 75);
    const imagePrompts = await runImagePromptsGen(task, structure, articleHtml, ctx);
    if (imagePrompts.length < 3) {
      await appendLog(taskId, `⚠ DeepSeek вернул только ${imagePrompts.length} image-промпта вместо 3`, 'warn');
    }
    await saveStageResult(taskId, 'image_prompts', imagePrompts);

    // 7. Image generation (Nano Banana Pro)
    await setStage(taskId, 'image_generation', 85);
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
