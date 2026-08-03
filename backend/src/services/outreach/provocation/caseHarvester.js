'use strict';
/**
 * caseHarvester — «кейс-комбайн». Наполняет outreach_cases сайтами, которые
 * растут в выдаче (наши «подтверждённые работы» — доказательства в письме).
 *
 * Источник — SERP-задачи кампании (по разным городам), которые рассылка уже
 * краулит. Растущие домены (dynamics.trend==='growth') обогащаем через keys.so
 * (трафик, запросы в топ-10 с частотностью), считаем заявки по нише и
 * складываем в outreach_cases (UPSERT по domain+city).
 *
 * Запускается по расписанию / по требованию — НЕ на каждое письмо (бережём квоту).
 * ИЗОЛЯЦИЯ: новый модуль, читает существующие данные и пишет только в свою таблицу.
 */
const db = require('../../../config/db');
const { enrichDomain } = require('./keyssoEnrich');
const { getNicheProfile, estimateLeads } = require('./nicheProfile');
// Маркетплейсы / агрегаторы / федеральные сети не годятся в «наши кейсы».
const { isBlacklistedHost } = require('../../serpB2b/domainBlacklist');
// Только V2: агрегаторы/справочники (docdoc, 2gis…) — не «наш кейс».
const { isAggregatorV2 } = require('./aggregatorBlacklistV2');

function _host(url) {
  if (!url) return '';
  try {
    const u = url.includes('://') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function _isGrowing(site) {
  const y = site?.dynamics?.yandex?.trend;
  const g = site?.dynamics?.google?.trend;
  return y === 'growth' || g === 'growth';
}

/**
 * Обрабатывает результаты одной SERP-задачи: растущие сайты → outreach_cases.
 * @returns {Promise<number>} сколько кейсов добавлено/обновлено
 */
async function harvestFromSerpTask(serpTask, { userId, campaignId, niche, city, maxPerTask = 8 }) {
  const results = Array.isArray(serpTask?.results) ? serpTask.results : [];
  if (!results.length) return 0;

  const prof = getNicheProfile(niche);
  const growing = results.filter(_isGrowing);
  let saved = 0;

  for (const site of growing) {
    if (saved >= maxPerTask) break;
    const domain = _host(site.url);
    if (!domain || isBlacklistedHost(domain) || isAggregatorV2(domain)) continue;

    let e;
    try {
      e = await enrichDomain(domain, { city });
    } catch (_) { e = null; }
    // Кейс годится, ТОЛЬКО если сайт и РАСТЁТ, и реально В ТОП-10:
    //   • growing            — рост видимости (подтверждён и SERP-динамикой выше);
    //   • keywords_top10 > 0  — есть запросы в топ-10 (по дашборду keys.so);
    //   • top_keywords.length — конкретные запросы с позицией ≤10 (их и покажем
    //     в письме для самопроверки «загуглите — мы в топе»).
    // Иначе «проверьте в поиске, мы в топе» не подтвердится — пропускаем.
    if (!e || !e.growing || !(e.keywords_top10 > 0) || !e.top_keywords?.length) continue;

    const leads = estimateLeads(e.traffic_month, prof.conversion_rate);

    try {
      await db.query(
        `INSERT INTO outreach_cases
           (user_id, campaign_id, source_serp_task, domain, city, niche, business_type,
            traffic_month, leads_min, leads_max, lead_unit, keywords, growth_pct, active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,true,NOW())
         ON CONFLICT (domain, city) DO UPDATE SET
           traffic_month = EXCLUDED.traffic_month,
           leads_min     = EXCLUDED.leads_min,
           leads_max     = EXCLUDED.leads_max,
           lead_unit     = EXCLUDED.lead_unit,
           keywords      = EXCLUDED.keywords,
           growth_pct    = EXCLUDED.growth_pct,
           niche         = COALESCE(outreach_cases.niche, EXCLUDED.niche),
           active        = true,
           updated_at    = NOW()`,
        [
          userId || null, campaignId || null, serpTask.id || null,
          domain, city || null, niche || null, prof.matched === 'default' ? null : prof.matched,
          e.traffic_month, leads.min, leads.max, prof.lead_unit_gen,
          JSON.stringify(e.top_keywords), e.growth_pct,
        ],
      );
      saved++;
    } catch (err) {
      console.warn(`[caseHarvester] upsert ${domain} failed: ${err.message}`);
    }
  }
  return saved;
}

/**
 * Собирает кейсы для кампании: по всем SERP-задачам, из которых пришли её лиды.
 * @param {string} campaignId
 * @param {object} [opts]
 * @returns {Promise<{tasks:number, cases:number}>}
 */
async function harvestCasesForCampaignV2(campaignId, opts = {}) {
  const { maxPerTask = 8 } = opts;
  const { rows: camp } = await db.query(
    'SELECT id, user_id, niche FROM outreach_campaigns WHERE id = $1', [campaignId],
  );
  if (!camp.length) return { tasks: 0, cases: 0 };
  const campaign = camp[0];

  const { rows: serpIds } = await db.query(
    `SELECT DISTINCT source_serp_task FROM outreach_prospects
      WHERE campaign_id = $1 AND source_serp_task IS NOT NULL`,
    [campaignId],
  );

  let tasks = 0; let cases = 0;
  for (const { source_serp_task: serpId } of serpIds) {
    const { rows } = await db.query(
      'SELECT id, results, inputs FROM serp_b2b_tasks WHERE id = $1', [serpId],
    );
    if (!rows.length) continue;
    const task = rows[0];
    const inputs = task.inputs && typeof task.inputs === 'object' ? task.inputs : {};
    const city = inputs._city || '';
    const niche = inputs._niche || campaign.niche || '';
    tasks++;
    cases += await harvestFromSerpTask(task, {
      userId: campaign.user_id, campaignId, niche, city, maxPerTask,
    });
  }
  return { tasks, cases };
}

module.exports = { harvestCasesForCampaignV2, harvestFromSerpTask, _isGrowing, _host };
