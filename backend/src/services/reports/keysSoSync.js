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
const { getDomainDashboard, KeysSoError, _normalizeDomain, _normalizeBase, getGoogleBase } = require('./keysSoClient');

function _hasApiKey() {
  return !!(process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY);
}

async function _upsertSnapshot(snap) {
  const engine = snap.search_engine || 'yandex';
  await db.query(
    `INSERT INTO keys_so_cache
       (domain, date, yandex_traffic, google_traffic, visibility,
       keywords_top1, keywords_top3, keywords_top10, keywords_top50, keywords_total, adcost, search_engine, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
     ON CONFLICT (domain, date, search_engine) DO UPDATE SET
       yandex_traffic = EXCLUDED.yandex_traffic,
       google_traffic = EXCLUDED.google_traffic,
       visibility     = EXCLUDED.visibility,
       keywords_top1  = EXCLUDED.keywords_top1,
       keywords_top3  = EXCLUDED.keywords_top3,
       keywords_top10 = EXCLUDED.keywords_top10,
       keywords_top50 = EXCLUDED.keywords_top50,
       keywords_total = EXCLUDED.keywords_total,
       adcost         = EXCLUDED.adcost,
       fetched_at     = NOW()`,
    [
     snap.domain, snap.date,
     snap.yandex_traffic, snap.google_traffic, snap.visibility,
     snap.keywords_top1, snap.keywords_top3, snap.keywords_top10, snap.keywords_top50, snap.keywords_total, snap.adcost,
     engine,
    ],
  );
}

async function syncDomain(domain, opts = {}) {
  if (!_hasApiKey()) {
    return { domain, skipped: true, reason: 'no_api_key' };
  }
  const months = Number(opts.months) || 12;
  const norm = _normalizeDomain(domain);
  const base = _normalizeBase(opts.base);
  const client = opts.client || null;
  const httpOpts = { base, ...(client ? { httpClient: client } : {}) };

  // Один запрос /report/simple/domain_dashboard возвращает и overview, и
  // помесячную историю. Делаем один вызов, чтобы не упираться в лимит
  // Keys.so 10 запросов / 10 секунд при синхронизации десятков доменов.
  let dashboard;
  try {
    dashboard = await getDomainDashboard(norm, httpOpts);
  } catch (err) {
    if (err instanceof KeysSoError && err.code === 'no_api_key') {
      return { domain: norm, skipped: true, reason: 'no_api_key' };
    }
    throw err;
  }

  const { overview, history } = dashboard;
  const searchEngine = opts.searchEngine || 'yandex';
  const monthsToSave = history.slice(-months);
  for (const row of monthsToSave) {
    await _upsertSnapshot({ domain: norm, search_engine: searchEngine, ...row });
  }

  // overview сохраняем датой = первое число текущего месяца (перезапишет
  // последнюю строку history, если она за этот же месяц — это ожидаемо,
  // overview даёт более актуальные значения).
  const today = new Date();
  const monthFirst = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  await _upsertSnapshot({ domain: norm, date: monthFirst, search_engine: searchEngine, ...overview });

  // ── Google: если для региона есть Google-база, синхронизируем и её ──
  let googleSynced = false;
  if (searchEngine === 'yandex') {
    const googleBase = getGoogleBase(base);
    if (googleBase) {
      try {
        await syncDomain(norm, { ...opts, base: googleBase, searchEngine: 'google', client });
        googleSynced = true;
      } catch (err) {
        // Google-sync не критичен — логируем и продолжаем.
        console.warn(`[keysSoSync] Google sync failed for ${norm} (base=${googleBase}): ${err.message}`);
      }
    }
  }

  return {
    domain: norm,
    base,
    syncedMonths: monthsToSave.length,
    hasOverview: true,
    googleSynced,
  };
}

/**
 * CRON-задача: пробежать по всем уникальным (domain, region) из projects.
 * Возвращает агрегат {processed, errors[]}. Никогда не бросает наружу.
 */
async function syncAllDomains(opts = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT keys_so_domain,
            COALESCE(NULLIF(keys_so_region, ''), 'msk') AS keys_so_region
       FROM projects
      WHERE keys_so_domain IS NOT NULL AND keys_so_domain <> ''`,
  );
  const results = { processed: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    try {
      const r = await syncDomain(row.keys_so_domain, { ...opts, base: row.keys_so_region });
      if (r.skipped) results.skipped++;
      else results.processed++;
    } catch (err) {
      results.errors.push({ domain: row.keys_so_domain, error: err.message });
    }
    // Грубое соблюдение лимита 10 запросов / 10 секунд: ~1 запрос/сек,
    // когда доменов много. Один проход = один запрос на домен.
    if (rows.length > 5) await new Promise((r) => setTimeout(r, 1100));
  }
  return results;
}

/** Чтение из кэша: помесячный ряд за период. */
async function loadCachedSeries(domain, dateFrom, dateTo, searchEngine) {
  if (!domain) return [];
  const norm = _normalizeDomain(domain);
  const engine = searchEngine || 'yandex';
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            yandex_traffic, google_traffic, visibility,
            keywords_top1, keywords_top3, keywords_top10, keywords_top50, keywords_total, adcost
       FROM keys_so_cache
      WHERE domain = $1
        AND date >= date_trunc('month', $2::date)
        AND date <= date_trunc('month', $3::date)
        AND search_engine = $4
      ORDER BY date ASC`,
    [norm, dateFrom, dateTo, engine],
  );
  return rows;
}

/** Самый свежий snapshot для домена (для блока «Текущие показатели»). */
async function loadCurrent(domain, searchEngine) {
  if (!domain) return null;
  const norm = _normalizeDomain(domain);
  const engine = searchEngine || 'yandex';
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date,
            yandex_traffic, google_traffic, visibility,
            keywords_top1, keywords_top3, keywords_top10, keywords_top50, keywords_total, adcost,
            fetched_at
       FROM keys_so_cache
      WHERE domain = $1
        AND search_engine = $2
      ORDER BY date DESC
      LIMIT 1`,
    [norm, engine],
  );
  return rows[0] || null;
}

module.exports = { syncDomain, syncAllDomains, loadCachedSeries, loadCurrent };
