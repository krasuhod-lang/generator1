'use strict';

/**
 * reports/keysSoSync.js — синхронизация Keys.so → таблица keys_so_cache.
 *
 *   syncDomain(domain, {months=12, client?}) — апсёртит history + overview.
 *   syncAllDomains({months=12}) — для CRON: проходит по distinct
 *                                projects.keys_so_domain и вызывает syncDomain.
 *
 * Идемпотентно: ON CONFLICT (domain, date) DO UPDATE.
 * Если KEYS_SO_API_KEY не задан — функция тихо возвращает {skipped:true}, чтобы
 * локальный/dev-запуск без ключей не падал.
 */

const db = require('../../config/db');
const { getDomainHistory, getDomainOverview, KeysSoError, _normalizeDomain } = require('./keysSoClient');

async function _upsertSnapshot(snap) {
  await db.query(
    `INSERT INTO keys_so_cache
       (domain, date, yandex_traffic, google_traffic, visibility,
        keywords_top1, keywords_top3, keywords_top10, keywords_total, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
     ON CONFLICT (domain, date) DO UPDATE SET
       yandex_traffic = EXCLUDED.yandex_traffic,
       google_traffic = EXCLUDED.google_traffic,
       visibility     = EXCLUDED.visibility,
       keywords_top1  = EXCLUDED.keywords_top1,
       keywords_top3  = EXCLUDED.keywords_top3,
       keywords_top10 = EXCLUDED.keywords_top10,
       keywords_total = EXCLUDED.keywords_total,
       fetched_at     = NOW()`,
    [
      snap.domain, snap.date,
      snap.yandex_traffic, snap.google_traffic, snap.visibility,
      snap.keywords_top1, snap.keywords_top3, snap.keywords_top10, snap.keywords_total,
    ],
  );
}

async function syncDomain(domain, opts = {}) {
  if (!process.env.KEYS_SO_API_KEY) {
    return { domain, skipped: true, reason: 'no_api_key' };
  }
  const months = Number(opts.months) || 12;
  const norm = _normalizeDomain(domain);
  const client = opts.client || null;

  const history = await getDomainHistory(norm, months, client ? { httpClient: client } : {});
  for (const row of history) {
    await _upsertSnapshot({ domain: norm, ...row });
  }

  let overview = null;
  try {
    overview = await getDomainOverview(norm, client ? { httpClient: client } : {});
    // overview сохраняем датой = первое число текущего месяца.
    const today = new Date();
    const monthFirst = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await _upsertSnapshot({ domain: norm, date: monthFirst, ...overview });
  } catch (err) {
    if (!(err instanceof KeysSoError)) throw err;
    // overview-эндпоинт может быть недоступен — не валим всю задачу.
  }

  return { domain: norm, syncedMonths: history.length, hasOverview: !!overview };
}

/**
 * CRON-задача: пробежать по всем уникальным domains из projects.keys_so_domain.
 * Возвращает агрегат {processed, errors[]}. Никогда не бросает наружу.
 */
async function syncAllDomains(opts = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT keys_so_domain
       FROM projects
      WHERE keys_so_domain IS NOT NULL AND keys_so_domain <> ''`,
  );
  const results = { processed: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    try {
      const r = await syncDomain(row.keys_so_domain, opts);
      if (r.skipped) results.skipped++;
      else results.processed++;
    } catch (err) {
      results.errors.push({ domain: row.keys_so_domain, error: err.message });
    }
  }
  return results;
}

/** Чтение из кэша: помесячный ряд за период. */
async function loadCachedSeries(domain, dateFrom, dateTo) {
  if (!domain) return [];
  const norm = _normalizeDomain(domain);
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            yandex_traffic, google_traffic, visibility,
            keywords_top1, keywords_top3, keywords_top10, keywords_total
       FROM keys_so_cache
      WHERE domain = $1
        AND date >= date_trunc('month', $2::date)
        AND date <= date_trunc('month', $3::date)
      ORDER BY date ASC`,
    [norm, dateFrom, dateTo],
  );
  return rows;
}

/** Самый свежий snapshot для домена (для блока «Текущие показатели»). */
async function loadCurrent(domain) {
  if (!domain) return null;
  const norm = _normalizeDomain(domain);
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            yandex_traffic, google_traffic, visibility,
            keywords_top1, keywords_top3, keywords_top10, keywords_total,
            fetched_at
       FROM keys_so_cache
      WHERE domain = $1
      ORDER BY date DESC
      LIMIT 1`,
    [norm],
  );
  return rows[0] || null;
}

module.exports = { syncDomain, syncAllDomains, loadCachedSeries, loadCurrent };
