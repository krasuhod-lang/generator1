'use strict';

/**
 * Canonical E-E-A-T 12 score for the SEO pipeline.
 *
 * This deterministic module consumes the existing contract audit. Missing or
 * failed audits remain unknown; they are never converted into a numeric zero.
 * The legacy Stage-7 PQ and composite content-quality score stay separate.
 */

const SCORE_VERSION = 'eeat12.v2';
const AGGREGATION_VERSION = 'eeat12.weighted-v1';
const TARGET_DEFAULT = 7.5;

const EEAT_WEIGHTS = Object.freeze({
  experience: 0.08,
  expertise: 0.09,
  author_transparency: 0.06,
  reviewer_validation: 0.07,
  factual_accuracy: 0.16,
  source_transparency: 0.14,
  entity_completeness: 0.05,
  information_gain: 0.10,
  specificity_actionability: 0.08,
  trustworthiness: 0.10,
  intent_fit: 0.04,
  freshness_editorial_ux: 0.03,
});

const EEAT_CRITERIA = Object.freeze(Object.keys(EEAT_WEIGHTS));
const YMYL_CRITICAL = Object.freeze([
  'factual_accuracy',
  'source_transparency',
  'trustworthiness',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampScore(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
}

function hasNumber(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

function cleanReason(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isHighRisk(contract = {}) {
  return contract.risk_level === 'high' || contract.risk_level === 'ymyl';
}

function sourceEntry(audit, key) {
  const components = asObject(audit?.components);
  const raw = components[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return { score: raw };
}

function criterionApplicability(key, contract = {}) {
  if (key === 'reviewer_validation' && !isHighRisk(contract) && !contract?.format?.require_reviewer) {
    return 'not_applicable';
  }
  return 'applicable';
}

function inferMethod(entry) {
  if (entry.method) return cleanReason(entry.method, 80);
  if (entry.source || entry.evidence_ids) return 'deterministic_plus_evidence';
  return 'deterministic_baseline';
}

function componentReason(key, entry, score, status) {
  if (entry.reason) return cleanReason(entry.reason);
  if (status === 'not_applicable') return 'Критерий не применяется по policy для текущего риска.';
  if (status === 'unavailable') return `Нет валидной оценки критерия ${key}.`;
  if (score == null) return `Оценка критерия ${key} отсутствует.`;
  return `Детерминированная оценка ${key} на основе доступных артефактов.`;
}

function normalizeComponent(key, audit, contract) {
  const entry = sourceEntry(audit, key);
  const applicability = criterionApplicability(key, contract);
  if (applicability === 'not_applicable') {
    return {
      score: null,
      status: 'not_applicable',
      method: 'policy',
      confidence: 1,
      evidence_ids: [],
      reason: componentReason(key, entry, null, 'not_applicable'),
    };
  }

  const score = clampScore(entry.score ?? entry.value);
  const status = score == null
    ? 'unavailable'
    : (entry.status === 'partial' ? 'partial' : 'measured');
  const evidenceIds = Array.isArray(entry.evidence_ids)
    ? entry.evidence_ids.map((item) => String(item).slice(0, 120)).filter(Boolean).slice(0, 12)
    : [];
  const rawConfidence = entry.confidence == null
    ? (evidenceIds.length ? 0.75 : 0.55)
    : Number(entry.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : null;

  return {
    score,
    status,
    method: inferMethod(entry),
    confidence: confidence == null ? null : Math.round(confidence * 100) / 100,
    evidence_ids: evidenceIds,
    reason: componentReason(key, entry, score, status),
  };
}

function buildHardGates({ components, audit, contract, qualityGate = null, blockAggregate = null }) {
  const blockers = [];
  const highRisk = isHighRisk(contract);

  for (const key of YMYL_CRITICAL) {
    const score = components[key]?.score;
    if (highRisk && (score == null || score < 6)) {
      blockers.push(`${key}_below_6_or_unavailable`);
    }
  }

  if (highRisk && (!contract?.author?.reviewer || components.reviewer_validation?.status !== 'measured')) {
    blockers.push('reviewer_required_for_ymyl');
  }

  for (const item of Array.isArray(audit?.blockers) ? audit.blockers : []) {
    const value = cleanReason(item, 240);
    if (value && !blockers.includes(value)) blockers.push(value);
  }
  for (const item of Array.isArray(audit?.unsupported_claims) ? audit.unsupported_claims : []) {
    const value = `unsupported_claim:${cleanReason(item, 220)}`;
    if (value !== 'unsupported_claim:' && !blockers.includes(value)) blockers.push(value);
  }

  if (qualityGate?.quality_gate_status === 'error') blockers.push('quality_gate_unavailable');
  if (qualityGate?.global_audit_status === 'unavailable') blockers.push('global_audit_unavailable');
  if (blockAggregate?.critical_floor != null && blockAggregate.critical_floor < Number(contract.target_score || TARGET_DEFAULT)) {
    blockers.push('critical_block_floor_below_target');
  }

  return {
    passed: blockers.length === 0,
    blockers: Array.from(new Set(blockers)).slice(0, 24),
  };
}

function computeCanonicalEeatScore(audit = null, contract = {}, qualityGate = null, blockAggregate = null) {
  const components = Object.fromEntries(
    EEAT_CRITERIA.map((key) => [key, normalizeComponent(key, audit, contract)]),
  );
  const applicableKeys = EEAT_CRITERIA.filter((key) => components[key].status !== 'not_applicable');
  const measuredKeys = applicableKeys.filter((key) => components[key].status === 'measured' || components[key].status === 'partial');
  const applicableWeight = applicableKeys.reduce((sum, key) => sum + EEAT_WEIGHTS[key], 0);
  const measuredWeight = measuredKeys.reduce((sum, key) => sum + EEAT_WEIGHTS[key], 0);
  const weightedScore = measuredWeight > 0
    ? measuredKeys.reduce((sum, key) => sum + EEAT_WEIGHTS[key] * components[key].score, 0) / measuredWeight
    : null;
  const score = weightedScore == null ? null : Math.round(weightedScore * 100) / 100;
  const coverage = applicableWeight > 0 ? Math.round((measuredWeight / applicableWeight) * 1000) / 1000 : 0;
  const unavailableKeys = applicableKeys.filter((key) => components[key].status === 'unavailable');
  const partialKeys = applicableKeys.filter((key) => components[key].status === 'partial');
  const auditWasPresent = !!audit && typeof audit === 'object';
  const hardGates = buildHardGates({ components, audit, contract, qualityGate, blockAggregate });
  const targetScore = Number.isFinite(Number(contract.target_score))
    ? Math.max(7.5, Math.min(9.5, Number(contract.target_score)))
    : TARGET_DEFAULT;
  const blockStatus = blockAggregate?.status || null;
  const scoreStatus = !auditWasPresent || measuredKeys.length === 0
    ? 'unavailable'
    : (unavailableKeys.length || partialKeys.length || coverage < 1 || blockStatus === 'partial' ? 'partial' : 'measured');
  const requiresHumanReview = contract.human_review_required === true
    || (isHighRisk(contract) && !hardGates.passed)
    || scoreStatus === 'unavailable';
  const status = requiresHumanReview && (isHighRisk(contract) || hardGates.blockers.length > 0)
    ? 'human_review'
    : scoreStatus;
  const publishable = status === 'measured'
    && score != null
    && score >= targetScore
    && hardGates.passed;

  return {
    score_version: SCORE_VERSION,
    aggregation_version: AGGREGATION_VERSION,
    scale: '0_10',
    score,
    status,
    target_score: targetScore,
    coverage,
    criteria_measured: measuredKeys.length,
    criteria_applicable: applicableKeys.length,
    criteria_total: EEAT_CRITERIA.length,
    components,
    hard_gates: hardGates,
    publishable,
    unavailable_criteria: unavailableKeys,
    partial_criteria: partialKeys,
    measured_criteria: measuredKeys,
    block_aggregation: blockAggregate || null,
    computed_at: new Date().toISOString(),
  };
}

function aggregateBlockQuality(entries = [], target = TARGET_DEFAULT) {
  const normalized = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : [];
  const total = normalized.length;
  const measured = normalized.filter((entry) => hasNumber(entry.pq_score));
  const weightedDenominator = measured.reduce((sum, entry) => sum + Math.max(0, Number(entry.plain_chars) || 0), 0);
  const weightedScore = weightedDenominator > 0
    ? measured.reduce((sum, entry) => sum + Number(entry.pq_score) * Math.max(0, Number(entry.plain_chars) || 0), 0) / weightedDenominator
    : (measured.length ? measured.reduce((sum, entry) => sum + Number(entry.pq_score), 0) / measured.length : null);
  const critical = normalized.filter((entry) => entry.critical === true);
  const criticalMeasured = critical.filter((entry) => hasNumber(entry.pq_score));
  const criticalFloor = criticalMeasured.length ? Math.min(...criticalMeasured.map((entry) => Number(entry.pq_score))) : null;
  const unavailable = normalized.filter((entry) => !hasNumber(entry.pq_score)).map((entry) => entry.block_id).filter(Boolean);
  const status = !total || !measured.length ? 'unavailable' : (unavailable.length ? 'partial' : 'measured');
  return {
    aggregation_version: 'blocks.pq.v1',
    status,
    score: weightedScore == null ? null : Math.round(weightedScore * 100) / 100,
    weighted_score: weightedScore == null ? null : Math.round(weightedScore * 100) / 100,
    critical_floor: criticalFloor == null ? null : Math.round(criticalFloor * 100) / 100,
    target_score: Number(target),
    coverage: total ? Math.round((measured.length / total) * 1000) / 1000 : 0,
    blocks_total: total,
    blocks_measured: measured.length,
    unavailable_blocks: unavailable,
    per_block: normalized.map((entry) => ({
      block_id: entry.block_id || null,
      h2: cleanReason(entry.h2, 240) || null,
      pq_score: hasNumber(entry.pq_score) ? Number(entry.pq_score) : null,
      lsi_coverage: hasNumber(entry.lsi_coverage) ? Number(entry.lsi_coverage) : null,
      audit_status: entry.audit_status || (hasNumber(entry.pq_score) ? 'measured' : 'unavailable'),
      critical: entry.critical === true,
    })),
  };
}

function summarizeContentQuality(qualityScore, reports = {}) {
  const keys = Object.keys(reports);
  const available = keys.filter((key) => reports[key] != null).length;
  const total = keys.length;
  return {
    score_version: 'content-quality.v1',
    score: qualityScore?.overall ?? null,
    status: qualityScore?.overall == null ? 'unavailable' : (available < total ? 'partial' : 'measured'),
    coverage: total ? Math.round((available / total) * 1000) / 1000 : 0,
    sub: qualityScore?.sub || {},
  };
}

const weightSum = Object.values(EEAT_WEIGHTS).reduce((sum, value) => sum + value, 0);
if (Math.abs(weightSum - 1) > 1e-9) {
  throw new Error(`E-E-A-T weights must sum to 1.0, got ${weightSum}`);
}

module.exports = {
  SCORE_VERSION,
  AGGREGATION_VERSION,
  EEAT_WEIGHTS,
  EEAT_CRITERIA,
  YMYL_CRITICAL,
  computeCanonicalEeatScore,
  summarizeContentQuality,
  aggregateBlockQuality,
};
