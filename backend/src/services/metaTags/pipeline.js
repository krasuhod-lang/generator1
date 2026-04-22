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
const { fetchYandexSerp }    = require('./xmlstockClient');
const { extractSemantics, checkLsiUsage } = require('./semantics');
const { generateDrMaxMeta }  = require('./metaGenerator');
const { calcCost }           = require('../metrics/priceCalculator');
const {
  analyzeAudienceAndNiche,
  serializeAnalysisForPrompt,
} = require('../parser/audienceNicheAnalyzer');

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
  // analyzeAudienceAndNiche ожидает task.input_*-поля основного пайплайна.
  // Собираем синтетический объект, не трогая оригинальный task.
  const syntheticTask = {
    input_target_service: inputs.niche || (Array.isArray(task.keywords) ? task.keywords[0] : '') || 'Нет данных',
    input_brand_name:     inputs.brand || '',
    input_business_type:  '',
    input_region:         inputs.toponym || 'Россия',
    input_brand_facts:    inputs.summary || '',
    input_target_audience: '',
    input_niche_features:  '',
  };

  const ctx = {
    taskId,
    onTokens,
    log: (msg, type = 'info') => {
      // Заворачиваем в наш appendLog, не валим задачу при ошибке записи.
      appendLog(taskId, msg, type === 'success' ? 'ok' : type).catch(() => {});
    },
  };

  const analysis = await analyzeAudienceAndNiche(syntheticTask, ctx);
  if (!analysis) return '';

  const { personasText, nicheDeepDiveText, contentVoiceText, nicheTerminologyText } =
    serializeAnalysisForPrompt(analysis);

  // Собираем компактный digest: тон + 1-2 инсайта ниши + 1 короткая персона
  // + термины. Лимит ~1500 символов, чтобы не раздуть Gemini-промпт.
  const parts = [];
  if (contentVoiceText)     parts.push(`▸ Тон/голос:\n${contentVoiceText}`);
  if (nicheDeepDiveText)    parts.push(`▸ Инсайты ниши:\n${nicheDeepDiveText.slice(0, 600)}`);
  if (personasText)         parts.push(`▸ Ключевая персона ЦА:\n${personasText.slice(0, 500)}`);
  if (nicheTerminologyText) parts.push(`▸ Терминология ниши: ${nicheTerminologyText.slice(0, 200)}`);

  const digest = parts.join('\n\n').slice(0, 1500);
  return digest;
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
      return;
    }
  } catch (err) {
    console.error('[metaTags] processMetaTagTask: load failed:', err.message);
    return;
  }

  const keywords = Array.isArray(task.keywords) ? task.keywords : [];
  if (keywords.length === 0) {
    await db.query(
      `UPDATE meta_tag_tasks
          SET status = 'error', error_message = $2, completed_at = NOW()
        WHERE id = $1`,
      [taskId, 'Список ключевых запросов пуст'],
    );
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
  };

  // Локальные агрегаты — чтобы не дёргать SUM из JSONB на каждом ключе.
  let totalTokensIn  = 0;
  let totalTokensOut = 0;
  let totalCostUsd   = 0;
  let modelUsed      = null;

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

  for (let i = 0; i < keywords.length; i += 1) {
    const kw = String(keywords[i] || '').trim();
    await updateProgress(taskId, i, kw);
    await appendLog(taskId, `▶️ [${i + 1}/${keywords.length}] «${kw}»`, 'info');

    if (!kw) {
      await pushResult(taskId, { keyword: '', status: 'error', error: 'Пустая строка' });
      await updateProgress(taskId, i + 1, '');
      continue;
    }

    try {
      // 1) XMLStock SERP
      const serp = await fetchYandexSerp(kw, { lr: task.lr });
      await appendLog(taskId, `📡 SERP получен: ${serp.length} результатов`, 'info');

      // 2) Semantics (TF-IDF)
      const semantics = extractSemantics(kw, serp);
      await appendLog(taskId,
        `🔢 LSI: важных ${semantics.title_mandatory_words.length}, рекомендованных ${semantics.description_mandatory_words.length}`,
        'info');

      // 3) Gemini → Title + Description (та же модель, что и Stage 3/5/6)
      const metas = await generateDrMaxMeta({ keyword: kw, semantics, serpData: serp, inputs });

      // 4) Проверка фактического использования LSI в готовых метатегах.
      // ВАЖНО: считаем «использовано» по объединённому тексту Title + Description + H1.
      // Иначе слово, которое модель уместно вписала в Description (например «google»
      // или «сайт»), отображается на фронте как пропущенное в Title — что вводит
      // в заблуждение: для важных LSI достаточно появиться в любом из трёх полей.
      const combinedMetaText = [
        metas.title       || '',
        metas.description || '',
        metas.h1          || '',
      ].join(' ');
      const lsiTitleCheck = checkLsiUsage(combinedMetaText, semantics.title_mandatory_words);
      const lsiDescCheck  = checkLsiUsage(combinedMetaText, semantics.description_mandatory_words);
      metas.lsi_check = {
        title:       lsiTitleCheck,
        description: lsiDescCheck,
        // Объединённый список «не использовано» — для удобства фронта.
        missed_lsi: [...lsiTitleCheck.missed_lsi, ...lsiDescCheck.missed_lsi],
      };

      // 5) Учёт токенов и стоимости (Gemini)
      const meta = metas._meta || {};
      const tIn  = Number(meta.tokensIn)  || 0;
      const tOut = Number(meta.tokensOut) || 0;
      const cost = calcCost('gemini', tIn, tOut);
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

      await pushResult(taskId, { keyword: kw, status: 'success', serp, semantics, metas });
      await appendLog(taskId,
        `✅ «${kw}» готово (Title ${metas.title_length}, Desc ${metas.description_length}` +
        `, ${tIn + tOut} ток., $${cost.toFixed(4)})`,
        'ok');
    } catch (err) {
      console.error(`[metaTags] generation failed for "${kw}":`, err.message);
      await pushResult(taskId, { keyword: kw, status: 'error', error: err.message });
      await appendLog(taskId, `❌ «${kw}»: ${err.message}`, 'err');
    }

    await updateProgress(taskId, i + 1, '');

    if (i < keywords.length - 1) {
      await sleep(COOLDOWN_BETWEEN_KEYWORDS_MS);
    }
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
