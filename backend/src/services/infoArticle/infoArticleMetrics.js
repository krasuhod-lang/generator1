'use strict';

/**
 * infoArticleMetrics — учёт токенов / стоимости / событий для генератора
 * информационной статьи. Полная аналогия `linkArticleMetrics.js`.
 */

const db = require('../../config/db');

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
      `UPDATE info_article_tasks
          SET ${col.in}  = ${col.in}  + $2,
              ${col.out} = ${col.out} + $3,
              cost_usd   = cost_usd   + $4,
              updated_at = NOW()
        WHERE id = $1`,
      [taskId, tokensIn || 0, tokensOut || 0, Number(costUsd || 0).toFixed(6)],
    );
  } catch (err) {
    console.error('[infoArticleMetrics] recordTextTokens failed:', err.message);
  }
}

async function recordImageCall(taskId, costUsd) {
  try {
    await db.query(
      `UPDATE info_article_tasks
          SET gemini_image_calls = gemini_image_calls + 1,
              cost_usd           = cost_usd           + $2,
              updated_at         = NOW()
        WHERE id = $1`,
      [taskId, Number(costUsd || 0).toFixed(6)],
    );
  } catch (err) {
    console.error('[infoArticleMetrics] recordImageCall failed:', err.message);
  }
}

async function recordEvent(taskId, msg, level = 'info', stage = null) {
  const entry = {
    time:  new Date().toISOString(),
    msg:   String(msg || '').slice(0, 2000),
    level: ['info', 'ok', 'warn', 'err'].includes(level) ? level : 'info',
    stage: stage || null,
  };

  try {
    await db.query(
      `UPDATE info_article_tasks
          SET logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [taskId, JSON.stringify([entry])],
    );
  } catch (err) {
    console.error('[infoArticleMetrics] recordEvent/logs failed:', err.message);
  }

  try {
    await db.query(
      `INSERT INTO info_article_events (task_id, stage, level, message)
       VALUES ($1, $2, $3, $4)`,
      [taskId, entry.stage, entry.level, entry.msg],
    );
  } catch (err) {
    if (!/relation .* does not exist/i.test(err.message)) {
      console.error('[infoArticleMetrics] recordEvent/events failed:', err.message);
    }
  }

  return entry;
}

module.exports = {
  recordTextTokens,
  recordImageCall,
  recordEvent,
};
