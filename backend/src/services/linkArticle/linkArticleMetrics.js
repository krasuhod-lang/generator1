'use strict';

/**
 * linkArticleMetrics — учёт токенов / стоимости / событий для генератора
 * ссылочной статьи.
 *
 * Выделен из linkArticlePipeline.js, чтобы:
 *   • пайплайн остался чисто оркестратором (читать проще);
 *   • при появлении Grok/Claude/других адаптеров мы добавляли колонки
 *     только здесь;
 *   • события писались одновременно в две «витрины»:
 *       – inline-массив `logs JSONB` в link_article_tasks (для UI),
 *       – отдельную таблицу link_article_events (для аудита / админки).
 *
 * API:
 *   recordTextTokens(taskId, adapter, tokensIn, tokensOut, costUsd)
 *   recordImageCall(taskId, costUsd)
 *   recordEvent(taskId, msg, level='info', stage=null)   // → logs + events
 *
 * Все функции безопасно логируют ошибки БД, никогда не бросают исключения
 * наверх, чтобы сбой учёта не ронял основной пайплайн.
 */

const db = require('../../config/db');

/**
 * Преобразует имя адаптера в пару колонок токенов.
 * 'deepseek'             → deepseek_tokens_in/out
 * 'gemini' | 'grok' | …  → gemini_tokens_in/out (у генератора ссылочной статьи
 *   grok пока не используется, но на будущее сохраняем явный маппинг).
 */
function _columnsFor(adapter) {
  if (adapter === 'deepseek') {
    return { in: 'deepseek_tokens_in', out: 'deepseek_tokens_out' };
  }
  return { in: 'gemini_tokens_in', out: 'gemini_tokens_out' };
}

async function recordTextTokens(taskId, adapter, tokensIn, tokensOut, costUsd) {
  const col = _columnsFor(adapter);
  try {
    await db.query(
      `UPDATE link_article_tasks
          SET ${col.in}  = ${col.in}  + $2,
              ${col.out} = ${col.out} + $3,
              cost_usd   = cost_usd   + $4,
              updated_at = NOW()
        WHERE id = $1`,
      [taskId, tokensIn || 0, tokensOut || 0, Number(costUsd || 0).toFixed(6)],
    );
  } catch (err) {
    console.error('[linkArticleMetrics] recordTextTokens failed:', err.message);
  }
}

async function recordImageCall(taskId, costUsd) {
  try {
    await db.query(
      `UPDATE link_article_tasks
          SET gemini_image_calls = gemini_image_calls + 1,
              cost_usd           = cost_usd           + $2,
              updated_at         = NOW()
        WHERE id = $1`,
      [taskId, Number(costUsd || 0).toFixed(6)],
    );
  } catch (err) {
    console.error('[linkArticleMetrics] recordImageCall failed:', err.message);
  }
}

/**
 * Записывает событие в link_article_events (аудит) и дописывает
 * короткую строку в link_article_tasks.logs (для UI-фида).
 * Возвращает entry, чтобы вызывающая сторона могла использовать его
 * для публикации через SSE.
 */
async function recordEvent(taskId, msg, level = 'info', stage = null) {
  const entry = {
    time:  new Date().toISOString(),
    msg:   String(msg || '').slice(0, 2000),
    level: ['info', 'ok', 'warn', 'err'].includes(level) ? level : 'info',
    stage: stage || null,
  };

  // 1) Inline-лог в самой таблице задач — то, что читает UI прямо сейчас.
  try {
    await db.query(
      `UPDATE link_article_tasks
          SET logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [taskId, JSON.stringify([entry])],
    );
  } catch (err) {
    console.error('[linkArticleMetrics] recordEvent/logs failed:', err.message);
  }

  // 2) Отдельная табличка событий — для ретроспективного аудита и админ-панели.
  //    Таблица создаётся в ensureSchema(); если её почему-то нет, игнорируем.
  try {
    await db.query(
      `INSERT INTO link_article_events (task_id, stage, level, message)
       VALUES ($1, $2, $3, $4)`,
      [taskId, entry.stage, entry.level, entry.msg],
    );
  } catch (err) {
    if (!/relation .* does not exist/i.test(err.message)) {
      console.error('[linkArticleMetrics] recordEvent/events failed:', err.message);
    }
  }

  return entry;
}

module.exports = {
  recordTextTokens,
  recordImageCall,
  recordEvent,
};
