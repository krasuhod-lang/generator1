'use strict';

/**
 * Project content history for Article Topics.
 *
 * The old brand history is intentionally kept as a separate source because it
 * contains only topic-idea outputs. This loader adds a project-scoped view of
 * finished content tasks, so selecting a project cannot silently suggest a
 * topic that has already been written as an info/blog/link article or used as
 * a meta update.
 *
 * All queries are read-only and fail open per source. That matters for old
 * deployments where one optional table/column may not have been migrated yet.
 */

const db = require('../../config/db');
const { canonTitle } = require('./brandKey');

const SUCCESS_STATUSES = ['done', 'completed', 'published', 'success'];
const DEFAULT_LIMIT = 500;

const SOURCE_QUERIES = [
  {
    source: 'seo_task',
    sql: `
      SELECT id AS ref_id,
             COALESCE(NULLIF(TRIM(input_target_service), ''), NULLIF(TRIM(title), '')) AS title,
             NULL::text AS h1,
             NULL::text AS primary_intent, NULL::text AS intent_facet,
             status::text AS status, COALESCE(completed_at, created_at) AS created_at
        FROM tasks
       WHERE project_id = $1 AND user_id = $2
         AND status::text = ANY($3::text[])
         AND COALESCE(NULLIF(TRIM(input_target_service), ''), NULLIF(TRIM(title), '')) IS NOT NULL
    `,
  },
  {
    source: 'info_article',
    sql: `
      SELECT id AS ref_id, topic AS title, NULL::text AS h1,
             NULL::text AS primary_intent, NULL::text AS intent_facet,
             status::text AS status, COALESCE(completed_at, created_at) AS created_at
        FROM info_article_tasks
       WHERE project_id = $1 AND user_id = $2
         AND status::text = ANY($3::text[])
         AND NULLIF(TRIM(topic), '') IS NOT NULL
    `,
  },
  {
    source: 'link_article',
    sql: `
      SELECT id AS ref_id,
             COALESCE(NULLIF(topic, ''), NULLIF(anchor_text, '')) AS title,
             NULL::text AS h1,
             NULL::text AS primary_intent, NULL::text AS intent_facet,
             status::text AS status, COALESCE(completed_at, created_at) AS created_at
        FROM link_article_tasks
       WHERE project_id = $1 AND user_id = $2
         AND status::text = ANY($3::text[])
         AND COALESCE(NULLIF(TRIM(topic), ''), NULLIF(TRIM(anchor_text), '')) IS NOT NULL
    `,
  },
  {
    source: 'meta_tag',
    sql: `
      SELECT id AS ref_id, name AS title, NULL::text AS h1,
             NULL::text AS primary_intent, NULL::text AS intent_facet,
             status::text AS status, COALESCE(completed_at, created_at) AS created_at
        FROM meta_tag_tasks
       WHERE project_id = $1 AND user_id = $2
         AND status::text = ANY($3::text[])
         AND NULLIF(TRIM(name), '') IS NOT NULL
    `,
  },
  {
    source: 'topic_ideas',
    sql: `
      SELECT t.id AS ref_id,
             COALESCE(NULLIF(TRIM(item->>'title'), ''), NULLIF(TRIM(item->>'h1_variant'), '')) AS title,
             NULLIF(TRIM(item->>'h1_variant'), '') AS h1,
             NULLIF(TRIM(item->>'primary_intent'), '') AS primary_intent,
             NULLIF(TRIM(item->>'intent_facet'), '') AS intent_facet,
             t.status::text AS status, COALESCE(t.completed_at, t.created_at) AS created_at
        FROM article_topic_tasks t
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.topic_ideas_json->'topics') = 'array'
               THEN t.topic_ideas_json->'topics' ELSE '[]'::jsonb END
        ) AS item
       WHERE t.project_id = $1 AND t.user_id = $2
         AND t.mode::text = 'topic_ideas'
         AND t.status::text = ANY($3::text[])
         AND COALESCE(NULLIF(TRIM(item->>'title'), ''), NULLIF(TRIM(item->>'h1_variant'), '')) IS NOT NULL
    `,
  },
  {
    source: 'tasks_auto_log',
    sql: `
      SELECT ref_id, title, NULL::text AS h1,
             NULL::text AS primary_intent, NULL::text AS intent_facet,
             'done'::text AS status, COALESCE(performed_at_ts, performed_at::timestamptz, created_at) AS created_at
        FROM tasks_auto_log
       WHERE project_id = $1
         AND (user_id = $2 OR user_id IS NULL)
         AND task_type IN ('content_generation', 'link_article', 'meta_update')
         AND is_hidden IS NOT TRUE
         AND NULLIF(TRIM(title), '') IS NOT NULL
    `,
  },
];

function _clip(value, max = 260) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

async function _readSource(source) {
  try {
    // tasks_auto_log не имеет status-предиката и использует только $1/$2;
    // остальные источники фильтруются общим списком успешных статусов через $3.
    const params = source.source === 'tasks_auto_log'
      ? [this.projectId, this.userId]
      : [this.projectId, this.userId, SUCCESS_STATUSES];
    const { rows } = await db.query(source.sql, params);
    return {
      source: source.source,
      available: true,
      rows: (rows || []).map((row) => ({
      source_type: source.source,
      ref_id: row.ref_id || null,
      title: _clip(row.title),
      h1: _clip(row.h1),
      primary_intent: _clip(row.primary_intent, 60) || null,
      intent_facet: _clip(row.intent_facet, 80) || null,
      status: _clip(row.status, 40) || null,
      created_at: row.created_at || null,
      })).filter((row) => row.title),
    };
  } catch (err) {
    // Optional tables may not exist on a pre-migration deployment. Do not
    // block topic generation; expose the degraded state to the caller.
    if (!['42P01', '42703', '42883'].includes(err && err.code)) {
      console.warn(`[articleTopics] project history source ${source.source} unavailable: ${err.message}`);
    }
    return { source: source.source, available: false, rows: [] };
  }
}

/**
 * @param {{projectId:string,userId:string,limit?:number}} args
 * @returns {Promise<{items:Array, sources:Array, degraded:boolean}>}
 */
async function loadProjectContentHistory({ projectId, userId, limit = DEFAULT_LIMIT } = {}) {
  if (!projectId || !userId) return { items: [], sources: [], degraded: false };
  const cap = Math.max(1, Math.min(1000, Number(limit) || DEFAULT_LIMIT));
  const boundReader = (source) => _readSource.call({ projectId, userId }, source);
  const settled = await Promise.all(SOURCE_QUERIES.map(boundReader));
  const items = [];
  const seen = new Set();

  for (const result of settled) {
    for (const row of result.rows) {
      const canon = canonTitle(row.title);
      if (!canon) continue;
      // Same content can exist both in the source table and the report auto-log.
      // Keep the richer source row, then use the oldest stable identity only as
      // a fallback for rows without ref_id.
      const key = `${canon}|${row.intent_facet || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...row, canon });
    }
  }

  items.sort((a, b) => {
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bt - at;
  });

  const clipped = items.slice(0, cap);
  const sourceNames = Array.from(new Set(clipped.map((item) => item.source_type)));
  return {
    items: clipped,
    sources: sourceNames,
    available_sources: settled.filter((result) => result.available).map((result) => result.source),
    degraded: settled.some((result) => !result.available),
  };
}

module.exports = {
  loadProjectContentHistory,
  SUCCESS_STATUSES,
  DEFAULT_LIMIT,
};
