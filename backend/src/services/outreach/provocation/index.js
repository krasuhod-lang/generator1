'use strict';
/**
 * Провокационный режим outreach — оркестратор.
 *
 * buildProvocationEmailV2(): на входе лид + кампания → на выходе готовое письмо.
 *
 * ДВА ПУТИ:
 *   • FAST (provocation_ready): конкуренты/прогноз уже посчитаны при сборе лида
 *     (prepareProspect) и лежат в БД — просто рендерим. Отправка быстрая.
 *   • LIVE: если предрасчёта нет — считаем на месте (competitorGap + forecast).
 * Кейсы подбираются из БД в обоих случаях (дёшево). Всё «мягко»: недоступный
 * источник → блок не рисуется, письмо остаётся валидным.
 *
 * ИЗОЛЯЦИЯ: полностью новый путь. Классическую рассылку не трогает.
 */
const { computeCompetitorGapV2 } = require('./competitorGap');
const { ensureForecastForProspectV2, _publicUrl } = require('./forecastForProspect');
const { selectCasesForProspectV2 } = require('./caseSelector');
const { resolveNicheProfile } = require('./nicheProfile');
const { composeProvocationEmailV2 } = require('./emailComposerProvocation');

function _parseCompetitors(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = []; } }
  return Array.isArray(v) ? v : [];
}

/**
 * @param {object} p
 * @param {object} p.prospect         — строка outreach_prospects
 * @param {object} [p.campaign]       — строка outreach_campaigns
 * @param {object} p.sender           — {senderName, senderCompany, senderSite, senderTelegram}
 * @param {string} p.unsubscribeUrl
 * @param {string} [p.appUrl]         — база публичного URL (для ссылки прогноза)
 * @param {boolean} [p.skipForecast]  — не считать прогноз (быстрый preview live-пути)
 * @returns {Promise<{subject, html, text, meta}>}
 */
async function buildProvocationEmailV2(p) {
  const { prospect, campaign, sender = {}, unsubscribeUrl, appUrl, skipForecast = false } = p;
  const niche = prospect.niche || campaign?.niche || '';

  const profile = await resolveNicheProfile(niche, { keyword: campaign?.keyword }).catch(() => null);
  let unit = profile?.lead_unit_gen || 'заявок';

  let competitors = [];
  let prospectTraffic = 0;
  let forecastUrl = null;
  let gapRatio = null;
  let source;

  if (prospect.provocation_ready) {
    // ── FAST: готовые данные из БД (предрасчёт при сборе) ──
    competitors = _parseCompetitors(prospect.competitors);
    prospectTraffic = prospect.prospect_traffic || 0;
    gapRatio = prospect.gap_ratio || null;
    unit = prospect.lead_unit || unit;
    forecastUrl = (prospect.forecast_status === 'done' && prospect.forecast_share_token)
      ? _publicUrl(appUrl, prospect.forecast_share_token)
      : null;
    source = 'precomputed';
  } else {
    // ── LIVE: считаем на месте ──
    const [gap, forecast] = await Promise.all([
      computeCompetitorGapV2(prospect, {}).catch(() => null),
      skipForecast ? Promise.resolve(null)
        : ensureForecastForProspectV2(prospect, { campaign, appUrl }).catch(() => null),
    ]);
    competitors = gap?.competitors || [];
    prospectTraffic = gap?.prospect_traffic || 0;
    gapRatio = gap?.gap_ratio || null;
    forecastUrl = forecast?.url || null;
    source = 'live';
  }

  // Кейсы — из БД, дёшево, в обоих путях.
  const cases = await selectCasesForProspectV2(prospect, {
    niche, userId: campaign?.user_id, limit: 6,
  }).catch(() => []);

  const sampleQuery = competitors[0]?.top_keywords?.[0]?.phrase || campaign?.keyword || '';

  // ВРЕМЕННО: ссылка прогноза битая → полностью убираем прогноз из письма
  // (композер при пустом URL не рисует ни кнопку, ни подводку). Вернуть прогноз
  // — удалить эту строку.
  forecastUrl = null;

  const letter = composeProvocationEmailV2({
    prospect,
    competitors: competitors.map((c) => ({
      domain: c.domain, company_name: c.company_name || null, traffic_month: c.traffic_month,
    })),
    prospectTraffic,
    cases,
    forecastUrl,
    unit,
    sampleQuery,
    sender,
    unsubscribeUrl,
  });

  return {
    ...letter,
    meta: {
      unit,
      competitors: competitors.length,
      gap_ratio: gapRatio,
      forecast: !!forecastUrl,
      cases: cases.length,
      source,
    },
  };
}

module.exports = { buildProvocationEmailV2 };
