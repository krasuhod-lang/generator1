'use strict';
/**
 * Рассылка — оркестратор письма.
 *
 * buildProvocationEmailV2(): на входе лид + кампания → на выходе готовое письмо.
 *
 * ДВА ПУТИ:
 *   • FAST (provocation_ready): конкуренты уже посчитаны при сборе лида
 *     (prepareProspect) и лежат в БД — просто рендерим. Отправка быстрая.
 *   • LIVE: если предрасчёта нет — считаем на месте (competitorGap).
 * Кейсы подбираются из БД в обоих случаях (дёшево). Всё «мягко»: недоступный
 * источник → блок не рисуется, письмо остаётся валидным.
 *
 * ПРОГНОЗЫ КЛИЕНТАМ НЕ ОТПРАВЛЯЕМ: письмо содержит только факты по конкурентам
 * и наши кейсы — никаких прогнозов трафика/заявок и ссылок на них.
 */
const { computeCompetitorGapV2 } = require('./competitorGap');
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
 * @returns {Promise<{subject, html, text, meta}>}
 */
async function buildProvocationEmailV2(p) {
  const { prospect, campaign, sender = {}, unsubscribeUrl } = p;
  const niche = prospect.niche || campaign?.niche || '';

  const profile = await resolveNicheProfile(niche, { keyword: campaign?.keyword }).catch(() => null);
  let unit = profile?.lead_unit_gen || 'заявок';

  let competitors = [];
  let prospectTraffic = 0;
  let gapRatio = null;
  let source;

  if (prospect.provocation_ready) {
    // ── FAST: готовые данные из БД (предрасчёт при сборе) ──
    competitors = _parseCompetitors(prospect.competitors);
    prospectTraffic = prospect.prospect_traffic || 0;
    gapRatio = prospect.gap_ratio || null;
    unit = prospect.lead_unit || unit;
    source = 'precomputed';
  } else {
    // ── LIVE: считаем на месте ──
    const gap = await computeCompetitorGapV2(prospect, {}).catch(() => null);
    competitors = gap?.competitors || [];
    prospectTraffic = gap?.prospect_traffic || 0;
    gapRatio = gap?.gap_ratio || null;
    source = 'live';
  }

  // Кейсы — из БД, дёшево, в обоих путях.
  const cases = await selectCasesForProspectV2(prospect, {
    niche, userId: campaign?.user_id, limit: 6,
  }).catch(() => []);

  const sampleQuery = competitors[0]?.top_keywords?.[0]?.phrase || campaign?.keyword || '';

  const letter = composeProvocationEmailV2({
    prospect,
    competitors: competitors.map((c) => ({
      domain: c.domain, company_name: c.company_name || null, traffic_month: c.traffic_month,
    })),
    prospectTraffic,
    cases,
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
      cases: cases.length,
      source,
    },
  };
}

module.exports = { buildProvocationEmailV2 };
