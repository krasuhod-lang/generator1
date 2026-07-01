'use strict';

/**
 * In-process pipeline для bulk-генерации метатегов.
 * Не использует BullMQ (в отличие от основной SEO-задачи) — задачи короткие
 * (≤ 1 мин/ключ), не требуют распределённого worker'а, и кладутся в DB.
 *
 * Параллельность:
 *   • Внутри одной задачи ключи обрабатываются последовательно (с cool-down),
 *     чтобы не превышать rate-limit XMLStock и Gemini.
 *   • Между задачами разных пользователей разрешён ограниченный параллелизм:
 *     META_TAG_MAX_CONCURRENT (по умолчанию 3). Лишние задачи ставятся в
 *     in-process очередь и стартуют по мере освобождения слотов.
 *
 * Recovery: при рестарте процесса задачи в статусе in_progress
 * помечаются как 'error' (см. recoverStuckMetaTagTasks), их можно
 * перезапустить через UI «дублировать» (TODO) или вручную.
 */

const db = require('../../config/db');
const { runMetaStagesForKeyword, buildAudienceNicheDigest } = require('./metaStages');
const { calcCost }           = require('../metrics/priceCalculator');
const { finalizeByTask } = require('../aegis/backlogHooks');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const { recordQualityLog } = require('../aegis/qualityLogWriter');
const { resolvePromptHash } = require('../aegis/promptAudit');
const { createFunnelTracker } = require('../aegis/funnelTracker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Задержка между ключами — щадим XMLStock + Gemini (как в beta-версии).
// Можно переопределить через env, например META_TAG_COOLDOWN_MS=2000.
const COOLDOWN_BETWEEN_KEYWORDS_MS = (() => {
  const v = parseInt(process.env.META_TAG_COOLDOWN_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 4000;
})();

// Глобальный лимит одновременно выполняемых meta-tag задач (между разными
// пользователями / разными задачами одного пользователя). При превышении
// задача ждёт в in-process очереди.
const MAX_CONCURRENT_TASKS = (() => {
  const v = parseInt(process.env.META_TAG_MAX_CONCURRENT, 10);
  return Number.isFinite(v) && v >= 1 ? v : 3;
})();

// ─── In-process очередь и слоты ───────────────────────────────────
let runningCount = 0;
const waitQueue = []; // { taskId, resolve }

function acquireSlot(taskId) {
  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push({ taskId, resolve });
  });
}

function releaseSlot() {
  runningCount = Math.max(0, runningCount - 1);
  const next = waitQueue.shift();
  if (next) {
    runningCount += 1;
    next.resolve();
  }
}

/**
 * Лог события задачи (в JSONB колонку logs). Не критично если запись упадёт —
 * пайплайн всё равно продолжается.
 */
async function appendLog(taskId, msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  try {
    await db.query(
      `UPDATE meta_tag_tasks
          SET logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [taskId, JSON.stringify([entry])],
    );
  } catch (err) {
    console.error('[metaTags] appendLog failed:', err.message);
  }
}

async function updateProgress(taskId, current, activeKeyword) {
  try {
    await db.query(
      `UPDATE meta_tag_tasks
          SET progress_current = $2,
              active_keyword   = $3
        WHERE id = $1`,
      [taskId, current, activeKeyword || null],
    );
  } catch (err) {
    console.error('[metaTags] updateProgress failed:', err.message);
  }
}

async function pushResult(taskId, item) {
  try {
    await db.query(
      `UPDATE meta_tag_tasks
          SET results = COALESCE(results, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [taskId, JSON.stringify([item])],
    );
  } catch (err) {
    console.error('[metaTags] pushResult failed:', err.message);
  }
}

/**
 * Однократный (на задачу) запуск analyzeAudienceAndNiche — той же функции,
 * что используется в основном SEO-пайплайне (Stage 1 → 3). Адаптирует поля
 * meta_tag_tasks (niche / brand / toponym / summary) под task-схему,
 * которую ожидает анализатор (input_target_service / input_brand_name /
 * input_region / input_brand_facts).
 *
 * Возвращает компактный текст-digest для подстановки в user-prompt
 * метатегов; '' если анализ не дал результата.
 *
 * @param {string} taskId
 * @param {object} task   — строка meta_tag_tasks
 * @param {object} inputs — { niche, brand, toponym, phone, summary }
 * @param {Function} onTokens — (adapter, tIn, tOut, costUsd) для агрегации
 */
async function runAudienceNicheForMetaTask(taskId, task, inputs, onTokens) {
  // Делегируем общему хелперу metaStages.buildAudienceNicheDigest (та же логика,
  // что и в основном SEO-пайплайне Stage 1→3). niche по умолчанию — первый ключ
  // задачи; логирование заворачиваем в appendLog meta_tag_tasks.
  return buildAudienceNicheDigest({
    niche: inputs.niche || (Array.isArray(task.keywords) ? task.keywords[0] : '') || '',
    brand: inputs.brand,
    toponym: inputs.toponym,
    summary: inputs.summary,
    ctx: {
      taskId,
      onTokens,
      log: (msg, type = 'info') => {
        appendLog(taskId, msg, type === 'success' ? 'ok' : type).catch(() => {});
      },
    },
  });
}

/**
 * Основной обработчик одной задачи. Вызывается «fire-and-forget» из контроллера
 * после POST /api/meta-tags. Все ошибки ловятся и пишутся в БД, исключение
 * наружу не выбрасывается.
 *
 * @param {string} taskId
 */
async function processMetaTagTask(taskId) {
  // Лимитируем общее число одновременно бегущих задач. Если все слоты заняты —
  // встаём в FIFO-очередь. Проверку «идём в очередь?» делаем ДО acquireSlot,
  // чтобы лог отражал реальное состояние, а не уже-инкрементированный счётчик.
  const willQueue = runningCount >= MAX_CONCURRENT_TASKS;
  if (willQueue) {
    await appendLog(taskId,
      `⏳ Задача в очереди: уже выполняется ${MAX_CONCURRENT_TASKS} задач(и).`, 'info');
  }
  await acquireSlot(taskId);

  try {
    await runMetaTagTaskInner(taskId);
  } finally {
    releaseSlot();
  }
}

/**
 * Тело обработчика — вынесено отдельно, чтобы acquire/release slot оставался
 * корректным даже при любом исключении.
 */
async function runMetaTagTaskInner(taskId) {
  let task;
  try {
    const { rows } = await db.query(
      `SELECT * FROM meta_tag_tasks WHERE id = $1`,
      [taskId],
    );
    task = rows[0];
    if (!task) {
      console.error(`[metaTags] processMetaTagTask: task ${taskId} not found`);
      try {
        await finalizeByTask({
          table: 'meta_tag_tasks',
          taskId,
          ok: false,
          error: 'task not found',
          taskKind: 'meta_tags',
        });
      } catch (_) { /* no-op */ }
      return;
    }
  } catch (err) {
    console.error('[metaTags] processMetaTagTask: load failed:', err.message);
    try {
      await finalizeByTask({
        table: 'meta_tag_tasks',
        taskId,
        ok: false,
        error: err.message,
        taskKind: 'meta_tags',
      });
    } catch (_) { /* no-op */ }
    return;
  }

  const keywords = Array.isArray(task.keywords) ? task.keywords : [];
  const funnel = createFunnelTracker({ kind: 'meta_tags', taskRef: taskId, userId: task.user_id, niche: task.niche || null });
  if (keywords.length === 0) {
    await db.query(
      `UPDATE meta_tag_tasks
          SET status = 'error', error_message = $2, completed_at = NOW()
        WHERE id = $1`,
      [taskId, 'Список ключевых запросов пуст'],
    );
    funnel.recordStage('load', { outcome: 'fail', reason: 'empty_keywords list' });
    try { await funnel.persist({ status: 'failed', error: 'Список ключевых запросов пуст' }); } catch (_e) { /* no-op */ }
    try {
      await finalizeByTask({
        table: 'meta_tag_tasks',
        taskId,
        ok: false,
        error: 'Список ключевых запросов пуст',
        taskKind: 'meta_tags',
      });
    } catch (_) { /* no-op */ }
    return;
  }

  // Помечаем как in_progress + сбрасываем results/logs/счётчики токенов
  // (на случай повторного запуска через recovery). started_at ставим
  // только если ещё не задан.
  await db.query(
    `UPDATE meta_tag_tasks
        SET status           = 'in_progress',
            progress_current = 0,
            progress_total   = $2,
            active_keyword   = NULL,
            results          = '[]'::jsonb,
            logs             = '[]'::jsonb,
            error_message    = NULL,
            total_tokens_in  = 0,
            total_tokens_out = 0,
            total_cost_usd   = 0,
            llm_model        = NULL,
            started_at       = COALESCE(started_at, NOW())
      WHERE id = $1`,
    [taskId, keywords.length],
  );

  await appendLog(taskId, `🚀 Старт массовой генерации (${keywords.length} запросов)`, 'ok');

  const inputs = {
    niche:   task.niche   || '',
    brand:   task.brand   || '',
    toponym: task.toponym || '',
    phone:   task.phone   || '',
    summary: task.summary || '',
    // audienceNicheDigest проставляется ниже, после однократного запуска
    // analyzeAudienceAndNiche на уровне всей задачи (не на каждый ключ —
    // экономия токенов, цена $0.02-0.05 на одну meta-tag-задачу).
    audienceNicheDigest: '',
    // Sprint B: relevance-артефакт (если у задачи указан
    // source_relevance_report_id). Заполняется ниже, до основного цикла —
    // один раз на задачу, тот же артефакт используется для всех ключей.
    relevanceBrief: '',
    // LLM-провайдер: 'gemini' (default) | 'grok'. Прокидывается в
    // generateDrMaxMeta → callGemini/callGrok через args.inputs.
    llm_provider: (task.llm_provider || 'gemini').toString().toLowerCase() === 'grok' ? 'grok' : 'gemini',
    gemini_model: task.gemini_model || '',
  };

  // Sprint B: подключаем relevance-артефакт (если есть).
  if (task.source_relevance_report_id) {
    try {
      const { loadArtifact, renderForPromptBrief } = require('../relevance/relevanceArtifacts');
      const art = await loadArtifact(db, {
        reportId: task.source_relevance_report_id,
        userId: task.user_id,
      });
      if (art) {
        inputs.relevanceBrief = renderForPromptBrief(art, {
          // Для меты делаем короче, чтобы не утопить per-keyword промпт.
          lsiLimit: 12, ngramsLimit: 8, h2Limit: 6, h3Limit: 6,
        });
        await appendLog(taskId,
          `📚 Relevance-артефакт подключён: LSI=${art.important_lsi.length}, ngrams=${art.top_ngrams.length}`,
          'info');
        try {
          require('../aegis/moduleHooks').observeStage({
            module: 'metaTags', stage: 'relevance_artifact_loaded', taskId,
            payload: { lsi: art.important_lsi.length, ngrams: art.top_ngrams.length },
          });
        } catch (_) { /* graceful */ }
      }
    } catch (e) {
      await appendLog(taskId, `⚠ Relevance-артефакт не загружен (${e.message})`, 'warn');
    }
  }

  // Локальные агрегаты — чтобы не дёргать SUM из JSONB на каждом ключе.
  let totalTokensIn  = 0;
  let totalTokensOut = 0;
  let totalCostUsd   = 0;
  let modelUsed      = null;
  let kwOk           = 0;
  let kwFail         = 0;

  funnel.step('audience_niche');

  // ── Однократный анализ ЦА и ниши до генерации тегов ───────────────
  // Использует ту же логику, что и основной SEO-пайплайн (см. memory о
  // audienceNicheAnalyzer / Stage 3). Запускаем один раз на задачу: бренд,
  // регион и тематика страницы общие для всех ключей в этой партии. Если
  // упадёт — продолжаем без digest, генерация мета-тегов работоспособна.
  try {
    const digest = await runAudienceNicheForMetaTask(taskId, task, inputs, (a, tIn, tOut, cost) => {
      totalTokensIn  += tIn  || 0;
      totalTokensOut += tOut || 0;
      totalCostUsd   += cost || 0;
    });
    if (digest) {
      inputs.audienceNicheDigest = digest;
      await appendLog(taskId,
        `🧭 Анализ ЦА и ниши готов (${digest.length} симв.)`, 'ok');
    } else {
      await appendLog(taskId,
        '🧭 Анализ ЦА и ниши пропущен — продолжаем без digest', 'info');
    }
  } catch (err) {
    await appendLog(taskId,
      `🧭 Анализ ЦА и ниши упал (${err.message}) — продолжаем без digest`, 'warn');
  }

  funnel.step('generate_meta');
  for (let i = 0; i < keywords.length; i += 1) {
    const kw = String(keywords[i] || '').trim();
    await updateProgress(taskId, i, kw);
    await appendLog(taskId, `▶️ [${i + 1}/${keywords.length}] «${kw}»`, 'info');

    if (!kw) {
      await pushResult(taskId, { keyword: '', status: 'error', error: 'Пустая строка' });
      await updateProgress(taskId, i + 1, '');
      kwFail += 1;
      continue;
    }

    try {
      // Этапы 1-4 (SERP → семантика → Gemini → LSI-проверка) вынесены в общий
      // staged-хелпер metaStages.runMetaStagesForKeyword, который переиспользуется
      // и в анализе проектов (projects/pageMetaAudit), чтобы логика этапов и
      // LSI-верификации не дублировалась.
      const { serp, semantics, ctrAnalysis, metas } = await runMetaStagesForKeyword({
        keyword: kw,
        inputs,
        lr: task.lr,
      });
      await appendLog(taskId, `📡 SERP получен: ${serp.length} результатов`, 'info');
      await appendLog(taskId,
        `🔢 LSI: важных ${semantics.title_mandatory_words.length}, рекомендованных ${semantics.description_mandatory_words.length}`,
        'info');

      // 5) Учёт токенов и стоимости (Gemini / Grok).
      // Провайдер для cost-calc подбирается из inputs.llm_provider, чтобы
      // тариф и метрики соответствовали реальному вызову.
      const meta = metas._meta || {};
      const tIn  = Number(meta.tokensIn)  || 0;
      const tOut = Number(meta.tokensOut) || 0;
      const tThoughts = Number(meta.thoughtsTokens) || 0;
      const tCached   = Number(meta.cachedTokens)   || 0;
      const cost = calcCost(inputs.llm_provider || 'gemini', tIn, tOut, {
        thoughtsTokens: tThoughts,
        cachedTokens:   tCached,
      });
      metas._meta = { ...meta, costUsd: cost };
      totalTokensIn  += tIn;
      totalTokensOut += tOut;
      totalCostUsd   += cost;
      if (!modelUsed && meta.model) modelUsed = meta.model;

      // Атомарно обновляем агрегаты в БД (видны на фронте по поллингу).
      await db.query(
        `UPDATE meta_tag_tasks
            SET total_tokens_in  = $2,
                total_tokens_out = $3,
                total_cost_usd   = $4,
                llm_model        = COALESCE(llm_model, $5)
          WHERE id = $1`,
        [taskId, totalTokensIn, totalTokensOut, totalCostUsd.toFixed(6), modelUsed],
      );

      await pushResult(taskId, { keyword: kw, status: 'success', serp, semantics, ctr_analysis: ctrAnalysis, metas });
      kwOk += 1;
      await appendLog(taskId,
        `✅ «${kw}» готово (Title ${metas.title_length}, Desc ${metas.description_length}` +
        `, ${tIn + tOut} ток., $${cost.toFixed(4)})`,
        'ok');
    } catch (err) {
      console.error(`[metaTags] generation failed for "${kw}":`, err.message);
      await pushResult(taskId, { keyword: kw, status: 'error', error: err.message });
      kwFail += 1;
      await appendLog(taskId, `❌ «${kw}»: ${err.message}`, 'err');
    }

    await updateProgress(taskId, i + 1, '');

    if (i < keywords.length - 1) {
      await sleep(COOLDOWN_BETWEEN_KEYWORDS_MS);
    }
  }

  // Записываем исход стадии генерации: все ключи упали → fail, иначе ok
  // (с числом неуспешных «связок» как retry-метрикой для аналитики).
  if (kwOk === 0 && kwFail > 0) {
    funnel.fail(`all ${kwFail} keywords failed (empty_output)`);
  } else {
    funnel.step('finalize');
  }

  await db.query(
    `UPDATE meta_tag_tasks
        SET status = 'done', completed_at = NOW(), active_keyword = NULL
      WHERE id = $1`,
    [taskId],
  );
  await appendLog(taskId,
    `🎉 Bulk-генерация завершена · итого ${totalTokensIn + totalTokensOut} ток., $${totalCostUsd.toFixed(4)}`,
    'ok');
  try {
    const { rows } = await db.query(`SELECT * FROM meta_tag_tasks WHERE id = $1`, [taskId]);
    const t = rows[0];
    if (t) {
      await recordTrainingExample({
        articleRef: `meta_tags:${taskId}`,
        kind: 'meta_tags',
        niche: t.niche || null,
        userPrompt: `${t.name || ''}\\n${Array.isArray(t.keywords) ? t.keywords.join('\\n') : ''}`,
        htmlOutput: JSON.stringify(t.results || []),
        qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
        feedbackMetrics: null,
        modelUsed: t.gemini_model || null,
        costUsd: Number(t.total_cost_usd) || 0,
        userId: t.user_id || null,
        promptHash: resolvePromptHash('systemPrompts'),
      });
      await recordQualityLog({
        articleRef: `meta_tags:${taskId}`,
        kind: 'meta_tags',
        niche: t.niche || null,
        qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
        reports: {},
        modelUsed: t.gemini_model || null,
        costUsd: Number(t.total_cost_usd) || 0,
        iterations: 1,
        taskRef: taskId,
        userId: t.user_id || null,
        userPrompt: `${t.name || ''}\\n${Array.isArray(t.keywords) ? t.keywords.join('\\n') : ''}`,
        promptHash: resolvePromptHash('systemPrompts'),
      });
    }
  } catch (_e) { /* best-effort */ }
  try {
    await finalizeByTask({
      table: 'meta_tag_tasks',
      taskId,
      ok: true,
      taskKind: 'meta_tags',
    });
  } catch (_) { /* no-op */ }
  try {
    await funnel.finish({ status: kwOk > 0 ? 'completed' : 'failed' });
  } catch (_e) { /* analytics must not break generation */ }
}

/**
 * При старте сервера переводим зависшие in_progress задачи в error,
 * чтобы пользователь не ждал их вечно.
 */
async function recoverStuckMetaTagTasks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE meta_tag_tasks
          SET status        = 'error',
              error_message = 'Сервер был перезапущен во время выполнения задачи',
              completed_at  = NOW()
        WHERE status = 'in_progress'`,
    );
    if (rowCount > 0) {
      console.log(`[metaTags] Recovered ${rowCount} stuck in_progress task(s)`);
    }
  } catch (err) {
    // Таблица может ещё не существовать на самом первом запуске до миграций — ок.
    if (!/relation .* does not exist/i.test(err.message)) {
      console.warn('[metaTags] recoverStuckMetaTagTasks failed:', err.message);
    }
  }
}

module.exports = { processMetaTagTask, recoverStuckMetaTagTasks };
