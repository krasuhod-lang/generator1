'use strict';

/**
 * aegis/failureAnalyzer — Root Cause Analysis для провальных статей.
 *
 * Берёт уже посчитанные отчёты (eeat_audit, fact_check_report, plagiarism_report,
 * readability_report, intent_verdict, lsi_report, image_qa_report,
 * validation_report) и сводный qualityScore — возвращает структурированный
 * список «симптомов»: что именно сломалось.
 *
 * Чисто детерминированный mapper, БЕЗ LLM — это безопасно, дёшево и
 * воспроизводимо. Результат сохраняется в aegis_quality_log.diagnoses /
 * failure_reasons и используется UI («Топ причин провалов») + будущим
 * Lessons-репозиторием (слой 4 плана).
 *
 * Симптомы — стабильные snake_case-идентификаторы; не меняй их без миграции
 * данных, иначе сломается агрегация по истории.
 */

const { getAegisFlags } = require('./featureFlags');

// ── Пороги срабатывания симптомов ──────────────────────────────────
//
// Числа подобраны консервативно: симптом «зажигается» только при явном
// пробое, чтобы не плодить ложноположительных диагнозов. Все пороги
// согласованы с qualityLayers/qualityScore.js (та же шкала 0..100 для
// субметрик и проценты для долей в отчётах).
const DEFAULT_THRESHOLDS = Object.freeze({
  // fact_check_report.unsupportedPctTotal (%) — выше => зажигаем.
  fact_unsupported_pct: 30,
  fact_min_score: 70,
  // plagiarism_report.overlapPctTotal (%) и plagiarismCount.
  plagiarism_overlap_pct: 30,
  plagiarism_min_score: 70,
  plagiarism_min_sentences: 1,
  // readability_report — доля passive/bureaucratese (%).
  readability_passive_pct: 25,
  readability_bureaucratese_pct: 15,
  readability_min_score: 70,
  // intent_verdict.verdict === 'mismatch' / 'review'.
  intent_min_score: 70,
  // lsi_report.coverage 0..1 (или 0..100 если уже %).
  lsi_min_coverage: 0.55,
  // E-E-A-T subscores: experience/expertise/authority/trust 0..10.
  eeat_min_experience: 6,
  eeat_min_expertise: 6,
  eeat_min_authority: 6,
  eeat_min_trust: 6,
  eeat_min_score: 70,
  // image_qa: cover/количество ошибок.
  image_qa_min_score: 70,
  // validation: количество failures.
  validation_min_score: 70,
  // missing_lsi: сколько top-terms перечислять в симптоме.
  lsi_top_missing: 5,
});

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _pct(v) {
  // допускает и 0..1 и 0..100; нормализует к 0..100.
  const n = _num(v);
  if (n == null) return null;
  return n <= 1 ? n * 100 : n;
}

function _verdict(report) {
  if (!report || typeof report !== 'object') return null;
  const v = report.verdict || report.status || report.overall_verdict;
  return v ? String(v).toLowerCase() : null;
}

function _push(out, symptom, details = {}) {
  if (!symptom) return;
  out.push({ symptom, ...details });
}

function _thresholds(override) {
  // featureFlags может содержать кастомные пороги; override (для тестов)
  // имеет наивысший приоритет.
  let flagsTh = {};
  try {
    const flags = getAegisFlags();
    if (flags && flags.qualityLog && flags.qualityLog.thresholds) {
      flagsTh = flags.qualityLog.thresholds;
    }
  } catch (_) { /* optional */ }
  return Object.assign({}, DEFAULT_THRESHOLDS, flagsTh, override || {});
}

// ── Per-report analyzers ───────────────────────────────────────────

function _analyzeFactCheck(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const verdict = _verdict(report);
  const unsupportedPct = _pct(
    report.unsupportedPctTotal != null ? report.unsupportedPctTotal : report.unsupported_pct,
  );
  const score = _num(report.score);

  if (unsupportedPct != null && unsupportedPct > th.fact_unsupported_pct) {
    _push(out, 'unsupported_numbers', {
      unsupported_pct: Math.round(unsupportedPct * 10) / 10,
      threshold: th.fact_unsupported_pct,
    });
  }
  if (verdict === 'fail' || (score != null && score < th.fact_min_score)) {
    _push(out, 'fact_check_failed', { verdict, score });
  }
  return out;
}

function _analyzePlagiarism(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const verdict = _verdict(report);
  const overlapPct = _pct(
    report.overlapPctTotal != null ? report.overlapPctTotal : report.overlap_pct,
  );
  const plagCount = _num(report.plagiarismCount);
  const score = _num(report.score);

  if (overlapPct != null && overlapPct > th.plagiarism_overlap_pct) {
    _push(out, 'paraphrase_too_close', {
      overlap_pct: Math.round(overlapPct * 10) / 10,
      threshold: th.plagiarism_overlap_pct,
    });
  }
  if (plagCount != null && plagCount >= th.plagiarism_min_sentences && verdict === 'fail') {
    _push(out, 'verbatim_copy', { count: plagCount });
  }
  if (verdict === 'fail' || (score != null && score < th.plagiarism_min_score)) {
    _push(out, 'plagiarism_failed', { verdict, score });
  }
  return out;
}

function _analyzeReadability(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const passivePct = _pct(report.passivePct != null ? report.passivePct : report.passive_pct);
  const bureaucPct = _pct(
    report.bureaucratesePct != null ? report.bureaucratesePct : report.bureaucratese_pct,
  );
  const score = _num(report.score);

  if (passivePct != null && passivePct > th.readability_passive_pct) {
    _push(out, 'too_passive', {
      passive_pct: Math.round(passivePct * 10) / 10,
      threshold: th.readability_passive_pct,
    });
  }
  if (bureaucPct != null && bureaucPct > th.readability_bureaucratese_pct) {
    _push(out, 'bureaucratese_overload', {
      bureaucratese_pct: Math.round(bureaucPct * 10) / 10,
      threshold: th.readability_bureaucratese_pct,
    });
  }
  if (score != null && score < th.readability_min_score) {
    _push(out, 'readability_low', { score });
  }
  return out;
}

function _analyzeIntent(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const verdict = _verdict(report);
  const score = _num(report.score);

  if (verdict === 'mismatch') {
    _push(out, 'wrong_intent_shape', { verdict });
  } else if (verdict === 'review' || (score != null && score < th.intent_min_score)) {
    _push(out, 'intent_drift', { verdict, score });
  }
  return out;
}

function _analyzeLsi(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const coverage = _num(
    report.coverage != null ? report.coverage
      : report.coverageRatio != null ? report.coverageRatio
        : report.coverage_pct != null ? report.coverage_pct
          : null,
  );
  if (coverage == null) return out;

  // Normalize to 0..1.
  const cov01 = coverage > 1 ? coverage / 100 : coverage;
  if (cov01 < th.lsi_min_coverage) {
    // Подсматриваем top-N отсутствующих фраз, если есть.
    const missingRaw = Array.isArray(report.missing) ? report.missing
      : Array.isArray(report.missingPhrases) ? report.missingPhrases
        : Array.isArray(report.missing_terms) ? report.missing_terms
          : [];
    const missing = missingRaw
      .slice(0, th.lsi_top_missing)
      .map((m) => (typeof m === 'string' ? m : (m && (m.phrase || m.term)) || ''))
      .filter(Boolean);

    _push(out, 'missing_lsi', {
      coverage: Math.round(cov01 * 1000) / 1000,
      threshold: th.lsi_min_coverage,
      missing,
    });
  }
  return out;
}

function _analyzeEeat(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;

  // E-E-A-T may have either per-pillar scores (0..10) or aggregated.
  const sub = report.subscores || report.pillars || report || {};
  const exp = _num(sub.experience != null ? sub.experience : sub.experience_score);
  const expert = _num(sub.expertise != null ? sub.expertise : sub.expertise_score);
  const auth = _num(sub.authority != null ? sub.authority : sub.authority_score);
  const trust = _num(sub.trust != null ? sub.trust : sub.trust_score);

  if (exp != null && exp < th.eeat_min_experience) {
    _push(out, 'lacks_personal_experience', { score: exp, threshold: th.eeat_min_experience });
  }
  if (expert != null && expert < th.eeat_min_expertise) {
    _push(out, 'lacks_expertise', { score: expert, threshold: th.eeat_min_expertise });
  }
  if (auth != null && auth < th.eeat_min_authority) {
    _push(out, 'lacks_authority', { score: auth, threshold: th.eeat_min_authority });
  }
  if (trust != null && trust < th.eeat_min_trust) {
    _push(out, 'lacks_trust_signals', { score: trust, threshold: th.eeat_min_trust });
  }
  return out;
}

function _analyzeImageQa(report, th) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const verdict = _verdict(report);
  const slots = Array.isArray(report.slots) ? report.slots : [];
  const cover = slots.find((s) => Number(s && s.slot) === 1) || null;

  if (cover && (cover.status === 'error' || cover.status === 'missing')) {
    _push(out, 'bad_cover_image', { cover_status: cover.status });
  }
  const errors = slots.filter((s) => s && s.status === 'error').length;
  if (errors > 0) {
    _push(out, 'image_errors', { errors });
  }
  if (verdict === 'fail') {
    _push(out, 'image_qa_failed', { verdict });
  }
  return out;
}

function _analyzeValidation(report) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const failures = Array.isArray(report.failures) ? report.failures
    : Array.isArray(report.items) ? report.items
      : [];
  if (!failures.length) return out;

  // Группируем по layer для компактности.
  const byLayer = new Map();
  for (const f of failures) {
    const layer = (f && (f.layer || f.stage || f.kind)) || 'unknown';
    byLayer.set(layer, (byLayer.get(layer) || 0) + 1);
  }
  for (const [layer, count] of byLayer.entries()) {
    _push(out, 'validation_failed', { layer, count });
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Определяет «лидера падения» по subscores qualityScore:
 * субметрика с наибольшим отрицательным зазором до своего порога.
 */
function _findTopFailureLayer(qualityScore, th) {
  const subs = qualityScore && qualityScore.subscores;
  if (!subs || typeof subs !== 'object') return null;

  // Минимальные пороги — те же, что у DSPy-гейта (с фолбэком 70).
  let gateSub = {};
  try {
    const flags = getAegisFlags();
    if (flags && flags.qualityGate && flags.qualityGate.minSub) {
      gateSub = flags.qualityGate.minSub;
    }
  } catch (_) { /* optional */ }
  const floor = 70;

  let worstLayer = null;
  let worstGap = 0;
  for (const [layer, raw] of Object.entries(subs)) {
    const v = _num(raw);
    if (v == null) continue;
    const minForLayer = _num(gateSub[layer]);
    const minimum = minForLayer != null ? minForLayer : floor;
    const gap = minimum - v;
    if (gap > worstGap) {
      worstGap = gap;
      worstLayer = layer;
    }
  }
  return worstLayer;
}

/**
 * Сворачивает verdict'ы всех отчётов в одну карту.
 */
function _verdictSummary(reports) {
  const out = {};
  if (!reports) return out;
  const mapping = {
    eeat:        reports.eeat_audit,
    fact_check:  reports.fact_check_report,
    plagiarism:  reports.plagiarism_report,
    readability: reports.readability_report,
    intent:      reports.intent_verdict,
    image_qa:    reports.image_qa_report,
    validation:  reports.validation_report,
  };
  for (const [key, rep] of Object.entries(mapping)) {
    const v = _verdict(rep);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Главная функция: reports + qualityScore → diagnoses + failure_reasons.
 *
 * @param {Object} input
 * @param {Object} input.reports     — { eeat_audit, fact_check_report, ... }
 * @param {Object} input.qualityScore — { overall, subscores: { ... } }
 * @param {Object} [input.thresholds] — override порогов (для тестов).
 * @returns {{ symptoms: Array, failure_reasons: string[], top_failure_layer: string|null,
 *             verdict_summary: Object }}
 */
function analyzeFailures({ reports, qualityScore, thresholds } = {}) {
  const th = _thresholds(thresholds);
  const safeReports = reports || {};

  const symptoms = [];
  symptoms.push(..._analyzeFactCheck(safeReports.fact_check_report, th));
  symptoms.push(..._analyzePlagiarism(safeReports.plagiarism_report, th));
  symptoms.push(..._analyzeReadability(safeReports.readability_report, th));
  symptoms.push(..._analyzeIntent(safeReports.intent_verdict, th));
  symptoms.push(..._analyzeLsi(safeReports.lsi_report, th));
  symptoms.push(..._analyzeEeat(safeReports.eeat_audit_report || safeReports.eeat_audit, th));
  symptoms.push(..._analyzeImageQa(safeReports.image_qa_report, th));
  symptoms.push(..._analyzeValidation(safeReports.validation_report));

  return {
    symptoms,
    failure_reasons: symptoms.map((s) => s.symptom),
    top_failure_layer: _findTopFailureLayer(qualityScore, th),
    verdict_summary: _verdictSummary(safeReports),
  };
}

module.exports = {
  analyzeFailures,
  DEFAULT_THRESHOLDS,
  // exported for tests
  _analyzeFactCheck,
  _analyzePlagiarism,
  _analyzeReadability,
  _analyzeIntent,
  _analyzeLsi,
  _analyzeEeat,
  _analyzeImageQa,
  _analyzeValidation,
  _findTopFailureLayer,
};
