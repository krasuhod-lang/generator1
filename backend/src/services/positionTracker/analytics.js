'use strict';

/**
 * positionTracker/analytics.js
 *
 * Чистые функции и SQL-агрегации для построения аналитики:
 *   • временные ряды позиций (день/неделя/месяц).
 *   • KPI-сводка: средняя позиция, доля ТОП-3/10/30, классификация
 *     запросов «выросло/упало/без изменений» относительно предыдущего
 *     периода.
 *   • топ-движений (movers): какие запросы выросли/упали сильнее всего
 *     за период.
 *
 * Чистые helper-функции (bucketKey, classifyDelta, summarizeRows и т.д.)
 * экспортируются отдельно — они покрыты юнит-тестами на синтетических
 * данных и не зависят от БД.
 */

const db = require('../../config/db');

// ── helpers ─────────────────────────────────────────────────────────

const VALID_GRAN = new Set(['day', 'week', 'month']);
const VALID_PERIOD = new Set(['week', 'month']);

function _gran(input) {
  const g = String(input || 'day').toLowerCase();
  return VALID_GRAN.has(g) ? g : 'day';
}

function _periodDays(period) {
  return String(period || '').toLowerCase() === 'month' ? 30 : 7;
}

/**
 * Считает «эффективную» позицию для агрегаций: NULL = не в ТОП-100 →
 * условно 101 (хуже, чем самая плохая позиция, но не Infinity, чтобы
 * AVG не ломалось).
 */
function effectivePosition(p) {
  if (p == null) return 101;
  return Number(p);
}

/**
 * Классификация дельты позиции:
 *   – delta < 0 (позиция уменьшилась → ВЫРОСЛИ в выдаче)         => 'up'
 *   – delta > 0 (позиция увеличилась → УПАЛИ)                    => 'down'
 *   – |delta| <= threshold (по умолчанию 0)                       => 'flat'
 *   – обе позиции NULL                                            => 'flat'
 *   – одна NULL: NULL→position(не NULL) — 'up'; position→NULL — 'down'.
 */
function classifyDelta(prev, curr, threshold = 0) {
  const pNull = prev == null;
  const cNull = curr == null;
  if (pNull && cNull) return 'flat';
  if (pNull && !cNull) return 'up';     // вошли в ТОП-100
  if (!pNull && cNull) return 'down';   // выпали из ТОП-100
  const d = curr - prev; // меньше = лучше → отрицательная дельта = рост
  if (Math.abs(d) <= threshold) return 'flat';
  return d < 0 ? 'up' : 'down';
}

/**
 * Дельта позиции (ушло вверх — отрицательное число), nullable аккуратно.
 * Если обе NULL — null (не определено). Если одна NULL — возвращает спец.
 * число (для сортировки) согласно "weight": NULL→position трактуется как
 * «прирост» (большое отрицательное), position→NULL — «провал».
 */
function deltaPosition(prev, curr) {
  if (prev == null && curr == null) return null;
  if (prev == null) return -100; // вход в ТОП-100 = +100 позиций
  if (curr == null) return 100;  // выпал из ТОП-100 = −100 позиций
  return curr - prev;
}

/**
 * Группирует строки {keyword_id, bucket, position} по bucket и keyword_id.
 * Возвращает Map<keyword_id, Map<bucket, {avg, best, worst, count}>>.
 * Для агрегации используем effectivePosition: NULL → 101.
 */
function groupSeries(rows) {
  const byKw = new Map();
  for (const r of rows) {
    const kw = r.keyword_id;
    let m = byKw.get(kw);
    if (!m) { m = new Map(); byKw.set(kw, m); }
    let b = m.get(r.bucket);
    if (!b) { b = { sum: 0, count: 0, best: null, worst: null, hasReal: false }; m.set(r.bucket, b); }
    const eff = effectivePosition(r.position);
    b.sum += eff;
    b.count += 1;
    if (r.position != null) {
      b.hasReal = true;
      if (b.best == null || r.position < b.best) b.best = r.position;
      if (b.worst == null || r.position > b.worst) b.worst = r.position;
    }
  }
  // финализируем avg
  const out = new Map();
  for (const [kw, m] of byKw) {
    const buckets = new Map();
    for (const [bk, v] of m) {
      buckets.set(bk, {
        avg: v.count ? v.sum / v.count : null,
        best: v.best,
        worst: v.worst,
        count: v.count,
        hasReal: v.hasReal,
      });
    }
    out.set(kw, buckets);
  }
  return out;
}

/**
 * Сводка по проекту за период: ср. позиция, доли ТОП-N, разбивка
 * выросло/упало/без изменений vs предыдущий равный период.
 *
 * Принимает массив пар {keyword_id, prev:{position}, curr:{position}}
 * (по последнему наблюдению ключа в каждом окне).
 */
function summarizeRows(pairs, opts = {}) {
  const flatThreshold = opts.flatThreshold ?? 0;
  const summary = {
    keywords_total: pairs.length,
    keywords_in_top: 0,
    avg_position: null,
    avg_position_prev: null,
    top3: 0, top10: 0, top30: 0,
    top3_prev: 0, top10_prev: 0, top30_prev: 0,
    up: 0, down: 0, flat: 0,
  };
  let sumCurr = 0; let cntCurr = 0;
  let sumPrev = 0; let cntPrev = 0;
  for (const p of pairs) {
    const c = p.curr?.position;
    const r = p.prev?.position;
    if (c != null) {
      summary.keywords_in_top += 1;
      sumCurr += c; cntCurr += 1;
      if (c <= 3)  summary.top3  += 1;
      if (c <= 10) summary.top10 += 1;
      if (c <= 30) summary.top30 += 1;
    }
    if (r != null) {
      sumPrev += r; cntPrev += 1;
      if (r <= 3)  summary.top3_prev  += 1;
      if (r <= 10) summary.top10_prev += 1;
      if (r <= 30) summary.top30_prev += 1;
    }
    const cls = classifyDelta(r, c, flatThreshold);
    summary[cls] += 1;
  }
  if (cntCurr) summary.avg_position = +(sumCurr / cntCurr).toFixed(2);
  if (cntPrev) summary.avg_position_prev = +(sumPrev / cntPrev).toFixed(2);
  return summary;
}

/**
 * Строит топ движений: сортирует по дельте.
 *   direction='up'   — самые большие приросты (delta < 0) — вперед
 *   direction='down' — самые большие падения  (delta > 0) — вперед
 */
function pickMovers(pairs, direction, limit = 20) {
  const arr = pairs
    .map((p) => ({
      keyword_id: p.keyword_id,
      query: p.query,
      prev: p.prev?.position ?? null,
      curr: p.curr?.position ?? null,
      delta: deltaPosition(p.prev?.position ?? null, p.curr?.position ?? null),
    }))
    .filter((x) => x.delta != null);
  if (direction === 'up') {
    arr.sort((a, b) => a.delta - b.delta); // самые отрицательные сверху
    return arr.filter((x) => x.delta < 0).slice(0, limit);
  }
  arr.sort((a, b) => b.delta - a.delta);   // самые положительные сверху
  return arr.filter((x) => x.delta > 0).slice(0, limit);
}

// ── DB queries ─────────────────────────────────────────────────────

function _bucketSql(gran) {
  // date_trunc возвращает timestamptz; приводим к ISO date через to_char
  if (gran === 'week')  return `to_char(date_trunc('week',  checked_at), 'IYYY-"W"IW')`;
  if (gran === 'month') return `to_char(date_trunc('month', checked_at), 'YYYY-MM')`;
  return `to_char(date_trunc('day', checked_at), 'YYYY-MM-DD')`;
}

/**
 * Временной ряд позиций по конкретному запросу за период.
 * Возвращает [{bucket, avg, best, worst, count}].
 */
async function getKeywordSeries(keywordId, { from, to, granularity = 'day', engine } = {}) {
  const gran = _gran(granularity);
  const filters = [`keyword_id = $1`];
  const params = [keywordId];
  if (engine) { filters.push(`engine = $${params.length + 1}`); params.push(engine); }
  if (from)   { filters.push(`checked_at >= $${params.length + 1}`); params.push(from); }
  if (to)     { filters.push(`checked_at <= $${params.length + 1}`); params.push(to); }
  const sql = `
    SELECT ${_bucketSql(gran)}::text AS bucket,
           AVG(NULLIF(position, NULL))::numeric(10,2)        AS avg,
           MIN(position)                                     AS best,
           MAX(position)                                     AS worst,
           COUNT(*)                                          AS count,
           COUNT(position)                                   AS count_in_top
      FROM position_results
     WHERE ${filters.join(' AND ')}
     GROUP BY bucket
     ORDER BY bucket ASC`;
  const { rows } = await db.query(sql, params);
  return rows.map((r) => ({
    bucket: r.bucket,
    avg: r.avg == null ? null : Number(r.avg),
    best: r.best == null ? null : Number(r.best),
    worst: r.worst == null ? null : Number(r.worst),
    count: Number(r.count),
    count_in_top: Number(r.count_in_top),
  }));
}

/**
 * Временной ряд по всему проекту: средняя позиция и доли ТОП-N
 * по букетам (день/неделя/месяц).
 * Считает только последние позиции каждого ключа в букете (если в букет
 * попало несколько проверок одного ключа — берём AVG как стабильную метрику).
 */
async function getProjectSeries(projectId, { from, to, granularity = 'day', engine } = {}) {
  const gran = _gran(granularity);
  const filters = [`project_id = $1`];
  const params = [projectId];
  if (engine) { filters.push(`engine = $${params.length + 1}`); params.push(engine); }
  if (from)   { filters.push(`checked_at >= $${params.length + 1}`); params.push(from); }
  if (to)     { filters.push(`checked_at <= $${params.length + 1}`); params.push(to); }
  const sql = `
    WITH per_kw AS (
      SELECT ${_bucketSql(gran)}::text AS bucket,
             keyword_id,
             AVG(position)::numeric(10,2) AS avg_pos,
             COUNT(position) AS in_top
        FROM position_results
       WHERE ${filters.join(' AND ')}
       GROUP BY bucket, keyword_id
    )
    SELECT bucket,
           AVG(avg_pos)::numeric(10,2)                         AS avg_position,
           COUNT(*)                                            AS keywords_total,
           COUNT(avg_pos)                                      AS keywords_in_top,
           COUNT(*) FILTER (WHERE avg_pos <= 3)                AS top3,
           COUNT(*) FILTER (WHERE avg_pos <= 10)               AS top10,
           COUNT(*) FILTER (WHERE avg_pos <= 30)               AS top30
      FROM per_kw
     GROUP BY bucket
     ORDER BY bucket ASC`;
  const { rows } = await db.query(sql, params);
  return rows.map((r) => ({
    bucket: r.bucket,
    avg_position:    r.avg_position == null ? null : Number(r.avg_position),
    keywords_total:  Number(r.keywords_total),
    keywords_in_top: Number(r.keywords_in_top),
    top3:  Number(r.top3),
    top10: Number(r.top10),
    top30: Number(r.top30),
  }));
}

/**
 * Сводка по проекту за период: текущее vs предыдущее окно одинаковой длины.
 */
async function getProjectSummary(projectId, { period = 'week', engine } = {}) {
  const days = _periodDays(VALID_PERIOD.has(period) ? period : 'week');
  const params = [projectId];
  let engineFilter = '';
  if (engine) { params.push(engine); engineFilter = ` AND engine = $${params.length}`; }
  // Берём по каждому ключу самую последнюю позицию в текущем периоде и
  // в предыдущем периоде такой же длины.
  const sql = `
    WITH curr_window AS (
      SELECT keyword_id, position, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY checked_at DESC) AS rn
        FROM position_results
       WHERE project_id = $1${engineFilter}
         AND checked_at >= NOW() - ($${params.length + 1}::int || ' days')::interval
    ),
    prev_window AS (
      SELECT keyword_id, position, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY checked_at DESC) AS rn
        FROM position_results
       WHERE project_id = $1${engineFilter}
         AND checked_at <  NOW() - ($${params.length + 1}::int || ' days')::interval
         AND checked_at >= NOW() - (($${params.length + 1}::int * 2) || ' days')::interval
    ),
    kws AS (
      SELECT id, query FROM position_keywords WHERE project_id = $1 AND is_active = TRUE
    )
    SELECT k.id AS keyword_id, k.query,
           c.position AS curr_pos,
           p.position AS prev_pos
      FROM kws k
      LEFT JOIN curr_window c ON c.keyword_id = k.id AND c.rn = 1
      LEFT JOIN prev_window p ON p.keyword_id = k.id AND p.rn = 1`;
  params.push(days);
  const { rows } = await db.query(sql, params);
  const pairs = rows.map((r) => ({
    keyword_id: r.keyword_id,
    query: r.query,
    prev: { position: r.prev_pos },
    curr: { position: r.curr_pos },
  }));
  return summarizeRows(pairs);
}

/**
 * Топ-движения за период (выросло/упало).
 */
async function getMovers(projectId, { period = 'week', direction = 'down', limit = 20, engine } = {}) {
  const days = _periodDays(VALID_PERIOD.has(period) ? period : 'week');
  const params = [projectId];
  let engineFilter = '';
  if (engine) { params.push(engine); engineFilter = ` AND engine = $${params.length}`; }
  const sql = `
    WITH curr_window AS (
      SELECT keyword_id, position, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY checked_at DESC) AS rn
        FROM position_results
       WHERE project_id = $1${engineFilter}
         AND checked_at >= NOW() - ($${params.length + 1}::int || ' days')::interval
    ),
    prev_window AS (
      SELECT keyword_id, position, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY checked_at DESC) AS rn
        FROM position_results
       WHERE project_id = $1${engineFilter}
         AND checked_at <  NOW() - ($${params.length + 1}::int || ' days')::interval
         AND checked_at >= NOW() - (($${params.length + 1}::int * 2) || ' days')::interval
    ),
    kws AS (
      SELECT id, query FROM position_keywords WHERE project_id = $1 AND is_active = TRUE
    )
    SELECT k.id AS keyword_id, k.query,
           c.position AS curr_pos,
           p.position AS prev_pos
      FROM kws k
      LEFT JOIN curr_window c ON c.keyword_id = k.id AND c.rn = 1
      LEFT JOIN prev_window p ON p.keyword_id = k.id AND p.rn = 1`;
  params.push(days);
  const { rows } = await db.query(sql, params);
  const pairs = rows.map((r) => ({
    keyword_id: r.keyword_id,
    query: r.query,
    prev: { position: r.prev_pos },
    curr: { position: r.curr_pos },
  }));
  return pickMovers(pairs, direction === 'up' ? 'up' : 'down', limit);
}

/**
 * Текущая позиция по каждому ключу проекта (для таблицы запросов).
 * Возвращает массив с полями: keyword_id, query, target_url, tags,
 * position, found_url, checked_at, prev_position (за previous period).
 */
async function getKeywordsTable(projectId, { engine, period = 'week' } = {}) {
  const days = _periodDays(VALID_PERIOD.has(period) ? period : 'week');
  const params = [projectId];
  let engineFilter = '';
  if (engine) { params.push(engine); engineFilter = ` AND engine = $${params.length}`; }
  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (keyword_id)
             keyword_id, position, found_url, checked_at, engine
        FROM position_results
       WHERE project_id = $1${engineFilter}
       ORDER BY keyword_id, checked_at DESC
    ),
    prev_window AS (
      SELECT keyword_id, position, ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY checked_at DESC) AS rn
        FROM position_results
       WHERE project_id = $1${engineFilter}
         AND checked_at < NOW() - ($${params.length + 1}::int || ' days')::interval
    )
    SELECT k.id AS keyword_id, k.query, k.target_url, k.tags, k.is_active,
           l.position, l.found_url, l.checked_at, l.engine,
           p.position AS prev_position
      FROM position_keywords k
      LEFT JOIN latest l ON l.keyword_id = k.id
      LEFT JOIN prev_window p ON p.keyword_id = k.id AND p.rn = 1
     WHERE k.project_id = $1
     ORDER BY k.created_at ASC`;
  params.push(days);
  const { rows } = await db.query(sql, params);
  return rows.map((r) => ({
    keyword_id: r.keyword_id,
    query: r.query,
    target_url: r.target_url,
    tags: r.tags || [],
    is_active: !!r.is_active,
    engine: r.engine || null,
    position: r.position == null ? null : Number(r.position),
    found_url: r.found_url || null,
    checked_at: r.checked_at,
    prev_position: r.prev_position == null ? null : Number(r.prev_position),
    delta: deltaPosition(r.prev_position == null ? null : Number(r.prev_position),
                         r.position == null ? null : Number(r.position)),
    direction: classifyDelta(r.prev_position == null ? null : Number(r.prev_position),
                             r.position == null ? null : Number(r.position)),
  }));
}

module.exports = {
  // pure helpers (testable)
  effectivePosition,
  classifyDelta,
  deltaPosition,
  groupSeries,
  summarizeRows,
  pickMovers,
  // db-backed
  getKeywordSeries,
  getProjectSeries,
  getProjectSummary,
  getMovers,
  getKeywordsTable,
};
