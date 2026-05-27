'use strict';

/**
 * brandTopicHistory — запись и чтение истории тем по бренду.
 *
 * recordTopics: батч-insert ON CONFLICT DO NOTHING — повторно сохранять
 * один и тот же canon-заголовок не нужно (UNIQUE по
 * (user_id, brand_key, topic_title_canon)).
 *
 * loadHistory: подгружает последние lookbackDays строк для конкретного
 * бренда — используется topicDuplicateDetector до prefilter.
 */

const { canonTitle } = require('./brandKey');

async function recordTopics(db, { userId, brandKey, taskId, topics }) {
  if (!db || !userId || !brandKey || !Array.isArray(topics) || !topics.length) {
    return { ok: false, inserted: 0, reason: 'no_input' };
  }
  let inserted = 0;
  for (const t of topics) {
    const title = canonTitle(t && (t.topic_title || t.title));
    if (!title) continue;
    try {
      const r = await db.query(
        `INSERT INTO article_topics_brand_history
           (user_id, brand_key, topic_title_canon, topic_h1_canon, primary_intent, intent_facet, topic_idea_task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, brand_key, topic_title_canon) DO NOTHING
         RETURNING id`,
        [
          userId,
          brandKey,
          title,
          canonTitle(t && (t.h1 || t.topic_h1)) || null,
          (t && (t.primary_intent || t.intent)) || null,
          (t && (t.intent_facet || t.facet)) || null,
          taskId || null,
        ]
      );
      if (r.rowCount > 0) inserted += 1;
    } catch (e) {
      // Логируем, но не прерываем — миграция может не накатиться.
      console.warn('[brandTopicHistory] insert failed:', e.message);
      return { ok: false, inserted, reason: 'db_error', error: e.message };
    }
  }
  return { ok: true, inserted };
}

async function loadHistory(db, { userId, brandKey, lookbackDays = 365, limit = 500 }) {
  if (!db || !userId || !brandKey) return [];
  try {
    const r = await db.query(
      `SELECT id, topic_title_canon, topic_h1_canon, primary_intent, intent_facet,
              topic_idea_task_id, created_at
         FROM article_topics_brand_history
        WHERE user_id = $1
          AND brand_key = $2
          AND created_at > NOW() - ($3::int || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $4`,
      [userId, brandKey, Math.max(1, Number(lookbackDays) || 365), Math.max(1, Number(limit) || 500)]
    );
    return r.rows;
  } catch (e) {
    console.warn('[brandTopicHistory] load failed:', e.message);
    return [];
  }
}

module.exports = { recordTopics, loadHistory };
