'use strict';

/**
 * In-process pipeline для bulk-генерации метатегов.
 * Не использует BullMQ (в отличие от основной SEO-задачи) — задачи короткие
 * (≤ 1 мин/ключ), не требуют распределённого worker'а, и кладутся в DB.
 *
 * При рестарте процесса задачи в статусе in_progress останутся «висеть»; recovery
 * на старте простой — мы помечаем их как 'error' (см. server.js → recoverStuckMetaTagTasks).
 */

const db = require('../../config/db');
const { fetchYandexSerp }    = require('./xmlstockClient');
const { extractSemantics, checkLsiUsage } = require('./semantics');
const { generateDrMaxMeta }  = require('./metaGenerator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Задержка между ключами — щадим XMLStock + Gemini (как в beta-версии).
const COOLDOWN_BETWEEN_KEYWORDS_MS = 4000;

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
 * Основной обработчик одной задачи. Вызывается «fire-and-forget» из контроллера
 * после POST /api/meta-tags. Все ошибки ловятся и пишутся в БД, исключение
 * наружу не выбрасывается.
 *
 * @param {string} taskId
 */
async function processMetaTagTask(taskId) {
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

  // Помечаем как in_progress + сбрасываем results/logs (на случай повторного
  // запуска через recovery). started_at ставим только если ещё не задан.
  await db.query(
    `UPDATE meta_tag_tasks
        SET status           = 'in_progress',
            progress_current = 0,
            progress_total   = $2,
            active_keyword   = NULL,
            results          = '[]'::jsonb,
            logs             = '[]'::jsonb,
            error_message    = NULL,
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
  };

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

      // 3) Gemini → Title + Description
      const metas = await generateDrMaxMeta({ keyword: kw, semantics, serpData: serp, inputs });

      // 4) Проверка фактического использования LSI в готовых метатегах
      const lsiTitleCheck = checkLsiUsage(metas.title       || '', semantics.title_mandatory_words);
      const lsiDescCheck  = checkLsiUsage(metas.description || '', semantics.description_mandatory_words);
      metas.lsi_check = {
        title:       lsiTitleCheck,
        description: lsiDescCheck,
        // Объединённый список «не использовано» — для удобства фронта.
        missed_lsi: [...lsiTitleCheck.missed_lsi, ...lsiDescCheck.missed_lsi],
      };

      await pushResult(taskId, { keyword: kw, status: 'success', serp, semantics, metas });
      await appendLog(taskId, `✅ «${kw}» готово (Title ${metas.title_length}, Desc ${metas.description_length})`, 'ok');
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
  await appendLog(taskId, '🎉 Bulk-генерация завершена', 'ok');
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
