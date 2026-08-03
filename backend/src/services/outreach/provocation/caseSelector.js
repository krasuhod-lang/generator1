'use strict';
/**
 * caseSelector — подбор кейсов под конкретного лида.
 *
 * Правила (согласованы с владельцем):
 *   • та же ниша, что у лида;
 *   • ГОРОД ЛИДА ИСКЛЮЧАЕМ (кейсы всегда из других городов — иначе показали бы
 *     конкурента лида и спалили, что работаем у него под боком);
 *   • реальные клиенты (is_client) — вперёд, дальше по росту/трафику;
 *   • если своей ниши мало — добираем из других ниш (город всё равно исключаем).
 *
 * ИЗОЛЯЦИЯ: новый модуль, читает только outreach_cases.
 */
const db = require('../../../config/db');
// Кейс не может быть агрегатором/справочником (docdoc, krasotaimedicina, 2gis…),
// даже если он «растущий и в топ-10». Пул мог быть собран до этого фильтра —
// поэтому подстраховываемся ещё и на выборке.
const { isAggregatorV2 } = require('./aggregatorBlacklistV2');

function _mapRow(r) {
  let kws = r.keywords;
  if (typeof kws === 'string') { try { kws = JSON.parse(kws); } catch (_) { kws = []; } }
  return {
    domain: r.domain,
    city: r.city,
    traffic_month: r.traffic_month,
    leads_min: r.leads_min,
    leads_max: r.leads_max,
    lead_unit: r.lead_unit,
    top_keywords: Array.isArray(kws) ? kws.slice(0, 2) : [],
    is_client: r.is_client,
  };
}

/**
 * @param {object} prospect — outreach_prospects (нужны city; niche опц.)
 * @param {object} [opts]
 * @param {string} [opts.niche]  — ниша лида (обычно prospect.niche || campaign.niche)
 * @param {string} [opts.userId] — скоуп агентства (если задан)
 * @param {number} [opts.limit]  — сколько кейсов (по умолч. 6)
 * @param {number} [opts.min]    — минимум своей ниши до фолбэка (по умолч. 3)
 * @returns {Promise<Array>} массив кейсов для композера
 */
async function selectCasesForProspectV2(prospect, opts = {}) {
  const { niche, userId, limit = 6, min = 3 } = opts;
  const city = prospect?.city || '';

  const picked = [];
  const seen = new Set();

  // 1. Та же ниша, город лида исключаем.
  if (niche) {
    const { rows } = await db.query(
      `SELECT * FROM outreach_cases
        WHERE active = true
          AND ($1::uuid IS NULL OR user_id = $1)
          AND niche IS NOT NULL AND lower(niche) = lower($2)
          AND (city IS NULL OR lower(city) <> lower($3))
        ORDER BY is_client DESC, growth_pct DESC NULLS LAST, traffic_month DESC NULLS LAST
        LIMIT $4`,
      [userId || null, niche, city, limit],
    );
    for (const r of rows) {
      if (seen.has(r.domain) || isAggregatorV2(r.domain)) continue;
      seen.add(r.domain); picked.push(_mapRow(r));
    }
  }

  // 2. Фолбэк: если своей ниши мало — добираем из любых ниш (город исключаем).
  if (picked.length < Math.max(min, 1) || picked.length < limit) {
    const need = limit - picked.length;
    if (need > 0) {
      const exclude = [...seen];
      const { rows } = await db.query(
        `SELECT * FROM outreach_cases
          WHERE active = true
            AND ($1::uuid IS NULL OR user_id = $1)
            AND (city IS NULL OR lower(city) <> lower($2))
            AND ($3::text[] IS NULL OR domain <> ALL($3))
          ORDER BY is_client DESC, growth_pct DESC NULLS LAST, traffic_month DESC NULLS LAST
          LIMIT $4`,
        [userId || null, city, exclude.length ? exclude : null, need],
      );
      for (const r of rows) {
        if (seen.has(r.domain) || isAggregatorV2(r.domain)) continue;
        seen.add(r.domain); picked.push(_mapRow(r));
      }
    }
  }

  return picked.slice(0, limit);
}

module.exports = { selectCasesForProspectV2 };
