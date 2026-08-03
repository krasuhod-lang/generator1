'use strict';
/**
 * prepareProspect — ПРЕДРАСЧЁТ провокационных данных лида (при сборе), чтобы
 * отправка была быстрой: считаем конкурентов + прогноз ЗАРАНЕЕ и кладём в БД.
 *
 * Сохраняет у лида: competitors (jsonb), якорь конкурента, prospect_traffic,
 * gap_ratio, lead_unit, provocation_ready=true. Прогноз (forecast_*) пишет сам
 * ensureForecastForProspectV2. Дальше buildProvocationEmailV2 берёт готовое.
 *
 * ИЗОЛЯЦИЯ: новый модуль. Пишет только в outreach_prospects (свои поля из mig 128).
 */
const db = require('../../../config/db');
const { computeCompetitorGapV2 } = require('./competitorGap');
const { ensureForecastForProspectV2 } = require('./forecastForProspect');
const { resolveNicheProfile } = require('./nicheProfile');

/**
 * @param {object|string} prospectOrId — строка лида или его id
 * @param {object} [opts] — { campaign, appUrl }
 * @returns {Promise<null | {competitors:number, forecast:boolean}>}
 */
async function prepareProspectProvocationV2(prospectOrId, opts = {}) {
  const { campaign, appUrl } = opts;

  let prospect = prospectOrId;
  if (typeof prospectOrId === 'string') {
    const { rows } = await db.query('SELECT * FROM outreach_prospects WHERE id = $1', [prospectOrId]);
    if (!rows.length) return null;
    prospect = rows[0];
  }
  if (!prospect || !prospect.id) return null;

  const niche = prospect.niche || campaign?.niche || '';
  const profile = await resolveNicheProfile(niche, { keyword: campaign?.keyword }).catch(() => null);
  const unit = profile?.lead_unit_gen || 'заявок';

  // Прогноз в V2 ВРЕМЕННО ОТКЛЮЧЁН: ссылка была битая, а расчёт плодил
  // forecaster_tasks и жёг квоту Арсенкина. Считаем ТОЛЬКО конкурентов
  // (агрегаторы уже отфильтрованы в computeCompetitorGapV2). Вернуть прогноз —
  // восстановить вызов ensureForecastForProspectV2 здесь + гейт forecastDone,
  // и снять `forecastUrl = null` в provocation/index.js.
  const gap = await computeCompetitorGapV2(prospect, {}).catch(() => null);

  const competitors = (gap?.competitors || []).map((c) => ({
    domain: c.domain,
    company_name: c.company_name || null,
    traffic_month: c.traffic_month,
    growing: c.growing,
    top_keywords: c.top_keywords || [],
  }));
  const anchor = competitors[0] || null;

  // Лид ГОТОВ к отправке, когда собрано ЯДРО письма — хотя бы один ПРЯМОЙ
  // конкурент (не агрегатор). Если keys.so отдал 429/пусто — лид не-готов и
  // дособерётся в следующем цикле. Без конкурента письмо слабое — не отправляем.
  const ready = competitors.length > 0;

  await db.query(
    `UPDATE outreach_prospects SET
       competitors        = $2::jsonb,
       competitor_domain  = $3,
       competitor_traffic = $4,
       competitor_growing = $5,
       prospect_traffic   = $6,
       gap_ratio          = $7,
       lead_unit          = $8,
       provocation_ready  = $9
     WHERE id = $1`,
    [
      prospect.id, JSON.stringify(competitors),
      anchor?.domain || null, anchor?.traffic_month || null,
      typeof anchor?.growing === 'boolean' ? anchor.growing : null,
      gap?.prospect_traffic || null, gap?.gap_ratio || null, unit,
      ready,
    ],
  );

  return { competitors: competitors.length, ready };
}

module.exports = { prepareProspectProvocationV2 };
