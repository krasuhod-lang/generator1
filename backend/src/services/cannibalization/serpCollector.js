'use strict';

/**
 * cannibalization/serpCollector.js — последовательно снимает топ-N выдачу по
 * каждому запросу через XMLStock (yandex|google) в указанном гео (lr) и
 * складывает нормализованные URL в cannibalization_serp (кэш для повторного
 * анализа без пересъёма).
 *
 * Бережно к квоте: последовательный обход (XMLStock-клиент сам поллит
 * транзиентные ошибки и fail-fast'ит на квоте — см. memory «xmlstock parser»).
 * onProgress(done, total, query) — колбэк для обновления stats задачи.
 */

const db       = require('../../config/db');
const xmlstock = require('../metaTags/xmlstockClient');
const urlN     = require('../siteCrawler/urlNormalizer');

const TOP_N_PAGES = (topN) => Math.max(1, Math.ceil(topN / 10)); // 10 doc на страницу

async function _fetchOne(query, { engine, lr, topN }) {
  const pages = TOP_N_PAGES(topN);
  const docs = engine === 'google'
    ? await xmlstock.fetchGoogleSerp(query, { lr: lr || '', pages })
    : await xmlstock.fetchYandexSerp(query, { lr: lr || '', pages });
  const out = [];
  const seen = new Set();
  for (const d of (docs || [])) {
    const norm = urlN.normalize(d && d.url);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ url: norm, title: (d && d.title) || null, position: out.length + 1 });
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * Снимает выдачи и пишет их в БД. Возвращает массив
 * { query, source_url, urls:[...] } для передачи в analyzer.buildReport.
 *
 * @param {number} taskId
 * @param {Array<{query, source_url}>} queries
 * @param {object} opts { engine, lr, topN, onProgress, shouldStop }
 */
async function collect(taskId, queries, opts = {}) {
  const engine = opts.engine === 'google' ? 'google' : 'yandex';
  const lr     = opts.lr || '';
  const topN   = Math.max(1, Number(opts.topN) || 10);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;

  const collected = [];
  const errors = [];
  let done = 0;
  const total = queries.length;

  for (const q of queries) {
    if (await shouldStop()) break;
    try {
      const results = await _fetchOne(q.query, { engine, lr, topN });
      // Пишем в кэш (идемпотентно по (task_id, query, position)).
      for (const r of results) {
        await db.query(
          `INSERT INTO cannibalization_serp
             (task_id, query, source_url, position, result_url, result_title)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (task_id, query, position) DO NOTHING`,
          [taskId, q.query, q.source_url || null, r.position, r.url, r.title],
        );
      }
      collected.push({ query: q.query, source_url: q.source_url || null, urls: results.map((r) => r.url) });
    } catch (e) {
      errors.push({ query: q.query, error: (e && e.message) ? e.message.slice(0, 300) : String(e) });
      collected.push({ query: q.query, source_url: q.source_url || null, urls: [] });
      // Фатальная ошибка квоты — прерываем, чтобы не жечь ключ.
      if (/лимит|limit|quota|исчерпан/i.test((e && e.message) || '')) {
        done++;
        onProgress(done, total, q.query);
        break;
      }
    }
    done++;
    onProgress(done, total, q.query);
  }

  return { collected, errors, done, total };
}

/** Загружает уже снятые выдачи из кэша (для повторного анализа без пересъёма). */
async function loadCached(taskId) {
  const { rows } = await db.query(
    `SELECT query, source_url, position, result_url
       FROM cannibalization_serp
      WHERE task_id = $1
      ORDER BY query ASC, position ASC`,
    [taskId],
  );
  const byQuery = new Map();
  for (const r of rows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, { query: r.query, source_url: r.source_url, urls: [] });
    byQuery.get(r.query).urls.push(r.result_url);
  }
  return [...byQuery.values()];
}

module.exports = { collect, loadCached, _fetchOne };
