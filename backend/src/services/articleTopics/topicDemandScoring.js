'use strict';

/**
 * Deterministic topic prioritization layer.
 *
 * This is deliberately not a search-volume oracle. It combines available
 * first-party signals (GSC/Яндекс context), the model's declared hypothesis,
 * intent, SERP/AI route and originality requirements. Every result states its
 * evidence quality so a forecast cannot be mistaken for measured demand.
 */

const { canonTitleStem } = require('./brandKey');

const VOLUME_LEVELS = new Set(['low', 'mid', 'high', 'unknown']);
const DEMAND_SIGNAL_TYPES = new Set(['observed', 'modeled', 'seasonal', 'editorial', 'unknown']);
const TRAFFIC_ROUTES = new Set(['organic_click', 'ai_citation', 'mixed', 'conversion']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);

const STOP_WORDS = new Set([
  'как', 'что', 'это', 'для', 'при', 'или', 'из', 'по', 'на', 'в', 'и', 'с',
  'the', 'a', 'an', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'with',
]);

function _tokens(value) {
  const stemmed = canonTitleStem(value);
  return new Set(stemmed.split(/\s+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function _overlap(left, right) {
  const a = _tokens(left);
  const b = _tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _level(value) {
  const level = String(value || '').trim().toLowerCase();
  return VOLUME_LEVELS.has(level) ? level : null;
}

function _topicText(topic) {
  return [
    topic && topic.title,
    topic && topic.h1_variant,
    Array.isArray(topic && topic.lsi_seed) ? topic.lsi_seed.join(' ') : '',
    topic && topic.content_angle,
  ].filter(Boolean).join(' ');
}

function _findFirstPartySignals(topic, context) {
  const signals = context && context.signals ? context.signals : {};
  const queries = [];
  const add = (source, list) => {
    if (!Array.isArray(list)) return;
    for (const item of list.slice(0, 60)) {
      const query = item && typeof item === 'object' ? item.query : item;
      if (!query) continue;
      const overlap = _overlap(_topicText(topic), query);
      if (overlap >= 0.34) {
        queries.push({
          source,
          query: String(query).slice(0, 180),
          position: item && typeof item === 'object' ? (_num(item.position) ?? _num(item.best_position)) : null,
          overlap: Number(overlap.toFixed(3)),
        });
      }
    }
  };
  add('gsc_striking_distance', signals.striking_distance);
  add('gsc_cannibalization', signals.cannibalization);
  return queries.sort((a, b) => b.overlap - a.overlap).slice(0, 5);
}

function _scoreTopic(topic, context = {}) {
  const volumeLevel = _level(topic.expected_search_volume_level || topic.expected_search_volume);
  const numericVolume = _num(topic.expected_search_volume);
  const firstParty = _findFirstPartySignals(topic, context);
  const providedEvidenceRows = Array.isArray(topic.demand_evidence)
    ? topic.demand_evidence.map((item) => {
      if (item && typeof item === 'object') return { ...item };
      const claim = String(item || '').trim();
      return claim ? { claim, evidence_status: 'inferred', confidence: 'low' } : null;
    }).filter(Boolean).slice(0, 8)
    : [];
  const providedEvidence = providedEvidenceRows.map((item) => [
    item.claim || item.fact || item.query,
    item.source_url || item.url,
    item.published_at || item.date,
  ].filter(Boolean).join(' — ').trim()).filter(Boolean);
  const intent = String(topic.primary_intent || '').toLowerCase();
  const facet = String(topic.intent_facet || '').toLowerCase();
  const geo = String(topic.geo_potential || '').toLowerCase();
  const stage = String(topic.intent_decision_stage || '').toUpperCase();
  const difficulty = _num(topic.difficulty);
  const commercial = _num(topic.commercial_potential);

  let score = 25;
  const evidence = [];
  const basis = [];

  if (firstParty.length) {
    score += 24;
    basis.push('first_party_search_signal');
    evidence.push(...firstParty.map((item) => `${item.source}: ${item.query}`));
  }
  if (volumeLevel === 'high') { score += 18; basis.push('model_volume_high'); }
  else if (volumeLevel === 'mid') { score += 11; basis.push('model_volume_mid'); }
  else if (volumeLevel === 'low') { score += 4; basis.push('model_volume_low'); }
  else if (numericVolume != null && numericVolume > 0) { score += 12; basis.push('numeric_volume_hypothesis'); }
  else basis.push('volume_unknown');

  if (intent === 'transactional') score += 12;
  else if (intent === 'commercial') score += 10;
  else if (intent === 'informational') score += 5;
  else if (intent === 'navigational') score += 2;

  if (['comparison', 'troubleshooting', 'ai-overview', 'reviews', 'alternatives'].includes(facet)) score += 6;
  if (geo === 'high') score += 5;
  else if (geo === 'medium') score += 2;
  if (stage === 'BOFU') score += 5;
  else if (stage === 'MOFU') score += 3;
  if (commercial != null) score += _clamp((commercial - 3) * 2, -4, 4);
  if (difficulty != null) score -= _clamp((difficulty - 3) * 2, -4, 4);

  const hasOriginality = Boolean(
    String(topic.uniqueness_angle || '').trim() &&
    (String(topic.content_angle || '').trim() || String(topic.first_party_evidence || '').trim()),
  );
  const requestedOriginalityGate = String(topic.originality_gate || '').toLowerCase();
  const originalityGate = requestedOriginalityGate === 'fail'
    ? 'fail'
    : (hasOriginality ? 'pass' : 'needs_first_party_evidence');
  if (hasOriginality) score += 5;
  else score -= 4;

  let demandSignalType = String(topic.demand_signal_type || '').toLowerCase();
  // First-party evidence outranks a model label. A model may call a topic
  // "modeled" even when the project snapshot contains a matching query.
  if (firstParty.length) demandSignalType = 'observed';
  if (!DEMAND_SIGNAL_TYPES.has(demandSignalType)) {
    if (firstParty.length) demandSignalType = 'observed';
    else if (topic.seasonality_window || String(topic.why_now || '').match(/сезон|месяц|квартал|season/i)) demandSignalType = 'seasonal';
    else if (topic.source_url || topic.ai_answer_trigger) demandSignalType = 'modeled';
    else demandSignalType = 'unknown';
  }

  let demandConfidence = String(topic.demand_confidence || '').toLowerCase();
  if (!CONFIDENCE.has(demandConfidence)) {
    demandConfidence = firstParty.length ? 'medium' : (volumeLevel && volumeLevel !== 'unknown' ? 'low' : 'low');
  }
  // A model-declared level alone is never high confidence.
  if (demandSignalType !== 'observed' && demandConfidence === 'high') demandConfidence = 'medium';

  let trafficRoute = String(topic.traffic_route || '').toLowerCase();
  if (!TRAFFIC_ROUTES.has(trafficRoute)) {
    trafficRoute = intent === 'transactional' || intent === 'commercial'
      ? 'conversion'
      : (geo === 'high' || facet === 'ai-overview' ? 'mixed' : 'organic_click');
  }

  const rawHorizon = _num(topic.forecast_horizon_months);
  const horizon = rawHorizon == null ? (demandSignalType === 'seasonal' ? 3 : 12) : _clamp(Math.round(rawHorizon), 0, 60);
  const band = score >= 70 ? 'high' : (score >= 45 ? 'medium' : 'low');

  return {
    ...topic,
    traffic_potential_score: Math.round(_clamp(score, 0, 100)),
    traffic_potential_band: band,
    demand_confidence: demandConfidence,
    demand_signal_type: demandSignalType,
    demand_evidence: (() => {
      const rows = [
        ...firstParty.map((item) => ({
          claim: `${item.source}: ${item.query}`,
          source_url: null,
          published_at: null,
          evidence_type: 'first_party',
          evidence_status: 'verified',
          confidence: 'medium',
        })),
        ...providedEvidenceRows,
      ];
      const seen = new Set();
      return rows.filter((row) => {
        const key = [row.claim || row.fact || row.query, row.source_url || row.url, row.published_at || row.date]
          .filter(Boolean).join('|');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 8);
    })(),
    forecast_horizon_months: horizon,
    traffic_route: trafficRoute,
    originality_gate: originalityGate,
    evidence_gap: topic.evidence_gap || (hasOriginality ? null : 'Нужен first-party факт, тест, интервью или собственный датасет'),
    first_party_evidence_required: topic.first_party_evidence_required || !hasOriginality,
    scoring_basis: basis.concat(providedEvidence.length ? ['model_declared_evidence'] : []),
  };
}

function scoreTopicIdeas(topics, context = {}) {
  if (!Array.isArray(topics)) return { topics: [], summary: null };
  const scored = topics.map((topic) => _scoreTopic(topic, context));
  const summary = {
    scoring_version: 'traffic-demand-v1',
    measured_signal_topics: scored.filter((topic) => topic.demand_signal_type === 'observed').length,
    low_confidence_topics: scored.filter((topic) => topic.demand_confidence === 'low').length,
    originality_gate_topics: scored.filter((topic) => topic.originality_gate !== 'pass').length,
    traffic_bands: {
      high: scored.filter((topic) => topic.traffic_potential_band === 'high').length,
      medium: scored.filter((topic) => topic.traffic_potential_band === 'medium').length,
      low: scored.filter((topic) => topic.traffic_potential_band === 'low').length,
    },
  };
  return { topics: scored, summary };
}

module.exports = {
  scoreTopicIdeas,
  VOLUME_LEVELS,
  DEMAND_SIGNAL_TYPES,
  TRAFFIC_ROUTES,
  _internals: { _overlap, _scoreTopic, _findFirstPartySignals },
};
