/* eslint-disable no-console */
'use strict';

/**
 * report-quality-trends.js — CLI-отчёт по агрегированным quality_score
 * за период. Без LLM-вызовов, единственная зависимость — БД.
 *
 * Использование:
 *   node backend/scripts/report-quality-trends.js [--days 7] [--source info_article|link_article|both]
 *
 * Печатает Markdown-таблицу:
 *   | model | source | tasks | avg overall | avg cost | avg time | trend |
 *
 * Тренд — изменение среднего overall между первой и второй половиной окна.
 */

const args = process.argv.slice(2);
function arg(name, defVal) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : defVal;
}

const days   = Math.max(1, Math.min(365, Number(arg('days', 7))));
const source = arg('source', 'both');

(async () => {
  const db = require('../src/config/db');
  const sources = source === 'both' ? ['info_article', 'link_article'] : [source];
  const rows = [];
  for (const src of sources) {
    const table = src === 'link_article' ? 'link_article_tasks' : 'info_article_tasks';
    const sql = `
      WITH window_data AS (
        SELECT
          COALESCE(quality_score->>'model_used', gemini_model) AS model_used,
          (quality_score->>'overall')::float                   AS overall,
          (quality_score->>'cost_usd')::float                  AS cost_usd,
          (quality_score->>'generation_time_ms')::float        AS gen_ms,
          completed_at,
          CASE WHEN completed_at >= NOW() - ($1::int || ' days')::interval / 2
               THEN 'recent' ELSE 'earlier' END AS half
        FROM ${table}
        WHERE quality_score IS NOT NULL
          AND completed_at >= NOW() - ($1::int || ' days')::interval
      )
      SELECT
        model_used,
        COUNT(*)::int                          AS tasks_count,
        ROUND(AVG(overall)::numeric, 1)        AS avg_overall,
        ROUND(AVG(cost_usd)::numeric, 4)       AS avg_cost,
        ROUND(AVG(gen_ms)::numeric, 0)         AS avg_time_ms,
        ROUND(AVG(overall) FILTER (WHERE half = 'recent')::numeric, 1)  AS avg_recent,
        ROUND(AVG(overall) FILTER (WHERE half = 'earlier')::numeric, 1) AS avg_earlier
      FROM window_data
      WHERE model_used IS NOT NULL
      GROUP BY model_used
      ORDER BY model_used
    `;
    try {
      const { rows: r } = await db.query(sql, [days]);
      for (const row of r) rows.push({ source: src, ...row });
    } catch (e) {
      console.error(`[${src}] query failed: ${e.message}`);
    }
  }

  if (!rows.length) {
    console.log(`\nNo quality_score data in the last ${days} day(s).\n`);
    process.exit(0);
  }

  console.log(`\n## Quality trends — last ${days} day(s)\n`);
  console.log('| Source | Model | Tasks | Avg Overall | Avg Cost ($) | Avg Time (s) | Trend (recent − earlier) |');
  console.log('|--------|-------|------:|------------:|-------------:|-------------:|-------------------------:|');
  for (const r of rows) {
    const trend = (r.avg_recent !== null && r.avg_earlier !== null)
      ? `${(Number(r.avg_recent) - Number(r.avg_earlier)).toFixed(1)} ` +
        (Number(r.avg_recent) > Number(r.avg_earlier) ? '↑'
         : Number(r.avg_recent) < Number(r.avg_earlier) ? '↓' : '→')
      : '—';
    const timeS = r.avg_time_ms !== null
      ? (Number(r.avg_time_ms) / 1000).toFixed(1)
      : '—';
    console.log(
      `| ${r.source} | ${r.model_used} | ${r.tasks_count} | ${r.avg_overall ?? '—'} | ${r.avg_cost ?? '—'} | ${timeS} | ${trend} |`
    );
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
