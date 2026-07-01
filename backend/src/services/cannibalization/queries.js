'use strict';

/**
 * cannibalization/queries.js — извлекает список запросов (H1) из страниц,
 * собранных краулером (site_crawl_pages), для указанной задачи краулинга.
 *
 * - берём только «свои» страницы с непустым H1 и http_status 2xx;
 * - нормализуем H1 (collapse whitespace, trim), отбрасываем пустые/служебные;
 * - дедуп по нормализованному H1 (если один H1 на нескольких URL — берём
 *   первый, но помним, что это кандидат каннибализации сам по себе);
 * - кэп по maxQueries (защита квоты XMLStock).
 *
 * Чистых функций-хелперов (normalizeH1, isJunkH1, dedupe) достаточно для
 * юнит-теста без БД; loadQueriesFromCrawl требует db.
 */

const db = require('../../config/db');

// Служебные/мусорные H1, которые не имеет смысла проверять как запросы.
const JUNK_H1 = new Set([
  '', '404', 'ошибка', 'error', 'страница не найдена', 'page not found',
  'корзина', 'cart', 'оформление заказа', 'checkout', 'поиск', 'search',
  'результаты поиска', 'search results',
]);

function normalizeH1(h1) {
  if (!h1 || typeof h1 !== 'string') return '';
  return h1.replace(/\s+/g, ' ').trim();
}

function isJunkH1(h1) {
  const n = normalizeH1(h1).toLowerCase();
  if (!n) return true;
  if (JUNK_H1.has(n)) return true;
  if (n.length < 3) return true;                 // слишком короткий
  if (/^\d+$/.test(n)) return true;              // чисто число
  return false;
}

/**
 * Приводит список страниц {url, h1} к дедуплицированному списку запросов.
 * @returns {{ queries: Array<{query, source_url, dup_urls}>, skipped: number, duplicates: number }}
 */
function dedupe(pages, opts = {}) {
  const maxQueries = Math.max(1, Number(opts.maxQueries) || 300);
  const byNorm = new Map();      // lower(H1) → { query, source_url, dup_urls:[] }
  let skipped = 0;
  for (const p of (pages || [])) {
    const h1 = normalizeH1(p && p.h1);
    if (isJunkH1(h1)) { skipped++; continue; }
    const key = h1.toLowerCase();
    if (!byNorm.has(key)) {
      byNorm.set(key, { query: h1, source_url: (p && p.url) || null, dup_urls: [] });
    } else {
      const existing = byNorm.get(key);
      if (p && p.url && p.url !== existing.source_url) existing.dup_urls.push(p.url);
    }
  }
  let duplicates = 0;
  for (const v of byNorm.values()) if (v.dup_urls.length) duplicates++;
  const queries = [...byNorm.values()].slice(0, maxQueries);
  return { queries, skipped, duplicates, truncated: byNorm.size > maxQueries };
}

async function loadQueriesFromCrawl(crawlTaskId, opts = {}) {
  const { rows } = await db.query(
    `SELECT url, h1, http_status
       FROM site_crawl_pages
      WHERE task_id = $1
        AND h1 IS NOT NULL AND h1 <> ''
        AND (http_status IS NULL OR http_status BETWEEN 200 AND 299)
      ORDER BY depth ASC, url ASC`,
    [crawlTaskId],
  );
  return dedupe(rows, opts);
}

module.exports = { normalizeH1, isJunkH1, dedupe, loadQueriesFromCrawl, JUNK_H1 };
