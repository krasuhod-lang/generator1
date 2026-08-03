'use strict';
/**
 * competitorGap — прямые конкуренты лида и разрыв по трафику.
 *
 * Конкуренты берём из SERP-задачи, из которой пришёл лид (source_serp_task):
 * это сайты той же выдачи (его город, его запрос), что стоят ВЫШЕ него.
 * Каждого кандидата обогащаем трафиком через keyssoEnrich; оставляем тех,
 * у кого трафика больше, чем у лида, сортируем по трафику.
 *
 * ИЗОЛЯЦИЯ: новый модуль. Существующий код не трогаем; читаем только данные.
 */
const db = require('../../../config/db');
const { enrichDomain } = require('./keyssoEnrich');
// Переиспользуем существующий чёрный список: маркетплейсы / агрегаторы /
// федеральные сети (Ozon, WB, Авито, DNS, М.Видео, Циан, Леруа …) — они НЕ
// «прямые конкуренты» локального бизнеса и должны отсеиваться.
const { isBlacklistedHost } = require('../../serpB2b/domainBlacklist');
// Дополнительно (только V2): агрегаторы/справочники (docdoc, prodoctorov, 2gis…)
// — не «прямой конкурент» локального бизнеса.
const { isAggregatorV2 } = require('./aggregatorBlacklistV2');

// Верхняя граница «сопоставимой лиги»: конкурент не может быть более чем в
// N раз крупнее лида по трафику (иначе это федеральный гигант, а не прямой
// конкурент). Настраивается через env.
const MAX_SCALE = Number(process.env.OUTREACH_COMPETITOR_MAX_SCALE) || 20;

/** hostname без www/протокола/пути. */
function _host(url) {
  if (!url) return '';
  try {
    const u = url.includes('://') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

/**
 * @param {object} prospect — строка outreach_prospects (нужны url, city, source_serp_task)
 * @param {object} [opts]
 * @param {string} [opts.engine]         'yandex'|'google'
 * @param {number} [opts.maxCompetitors] сколько конкурентов вернуть (по умолч. 3)
 * @param {number} [opts.enrichLimit]    сколько кандидатов обогащать keys.so (по умолч. 6)
 * @returns {Promise<null | {
 *   competitors: Array<{domain, traffic_month, growing, top_keywords}>,
 *   anchor: object|null,
 *   prospect_traffic: number,
 *   gap_ratio: number|null,
 * }>}
 */
async function computeCompetitorGapV2(prospect, opts = {}) {
  const { engine = 'yandex', maxCompetitors = 3, enrichLimit = 6 } = opts;
  if (!prospect || !prospect.source_serp_task) return null;

  // 1. Результаты SERP-задачи (в порядке выдачи).
  let results = [];
  try {
    const { rows } = await db.query(
      'SELECT results FROM serp_b2b_tasks WHERE id = $1',
      [prospect.source_serp_task],
    );
    results = Array.isArray(rows[0]?.results) ? rows[0].results : [];
  } catch (err) {
    console.warn(`[competitorGap] load serp failed: ${err.message}`);
    return null;
  }
  if (!results.length) return null;

  const prospectHost = _host(prospect.url);
  const prospectIdx = results.findIndex((r) => _host(r.url) === prospectHost);

  // 2. Кандидаты — сайты ВЫШЕ лида (или топ выдачи, если лид не найден),
  //    без него самого и без дублей домена.
  const seen = new Set([prospectHost]);
  const candidates = [];
  const companyByHost = {}; // host → название компании (из данных SERP)
  const pool = prospectIdx > 0 ? results.slice(0, prospectIdx) : results;
  for (const r of pool) {
    const h = _host(r.url);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    // Отсекаем маркетплейсы / агрегаторы / федеральные сети / справочники —
    // не «прямые конкуренты» локального бизнеса.
    if (isBlacklistedHost(h) || isAggregatorV2(h)) continue;
    companyByHost[h] = (r.company_name || '').trim() || null;
    candidates.push(h);
    if (candidates.length >= enrichLimit) break;
  }
  if (!candidates.length) return null;

  const city = prospect.city || '';

  // 3. Трафик лида + кандидатов (keys.so). Ошибки/пустые — грациозно пропускаем.
  const prospectEnriched = await enrichDomain(prospect.url, { city, engine, proofCount: 2 }).catch(() => null);
  const prospectTraffic = prospectEnriched?.traffic_month || 0;

  const enriched = [];
  for (const domain of candidates) {
    const e = await enrichDomain(domain, { city, engine, proofCount: 2 }).catch(() => null);
    if (e && e.traffic_month > 0) {
      enriched.push({
        domain: e.domain,
        company_name: companyByHost[domain] || companyByHost[e.domain] || null,
        traffic_month: e.traffic_month,
        growing: e.growing,
        top_keywords: e.top_keywords || [],
      });
    }
  }
  if (!enriched.length) return null;

  // 4. Оставляем конкурентов «в сопоставимой лиге»: сильнее лида, но не более
  //    чем в MAX_SCALE раз (иначе это федеральный гигант, а не прямой конкурент).
  let strong = prospectTraffic > 0
    ? enriched.filter((c) => c.traffic_month > prospectTraffic && c.traffic_month <= prospectTraffic * MAX_SCALE)
    : enriched;
  if (!strong.length && prospectTraffic > 0) {
    // Никого в «лиге» — берём хотя бы тех, кто выше лида (гиганты уже отсеяны
    // чёрным списком; масштаб-фильтр мог убрать всех при огромном разрыве).
    strong = enriched.filter((c) => c.traffic_month > prospectTraffic);
  }
  if (!strong.length) {
    // Трафик лида ИЗВЕСТЕН, но никто из выдачи не сильнее него → провокация
    // «вас обходят» была бы ЛОЖНОЙ. Лучше не слать такому лиду, чем соврать.
    if (prospectTraffic > 0) return null;
    // Трафик лида неизвестен (нет данных keys.so) — показываем конкурентов как
    // есть: сравнение идёт с «~0», это корректно.
    strong = enriched;
  }
  strong.sort((a, b) => b.traffic_month - a.traffic_month);
  const competitors = strong.slice(0, maxCompetitors);
  const anchor = competitors[0] || null;

  return {
    competitors,
    anchor,
    prospect_traffic: prospectTraffic,
    gap_ratio: anchor && prospectTraffic > 0
      ? Math.round((anchor.traffic_month / prospectTraffic) * 10) / 10
      : null,
  };
}

module.exports = { computeCompetitorGapV2, _host };
