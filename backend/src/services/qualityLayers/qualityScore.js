'use strict';

/**
 * qualityScore.js — детерминированный калькулятор сводной метрики
 * качества сгенерированной статьи. Берёт уже посчитанные отчёты
 * (eeat_audit / readability_report / intent_verdict / fact_check_report /
 *  plagiarism_report / lsi_report / lsi_overdose_report / validation_report /
 *  image_qa_report) и сворачивает их в один балл 0..100.
 *
 * Цель: возможность сравнивать модели генерации (gemini-3.1-pro-preview vs
 *  gemini-3.5-flash и далее) на одной и той же шкале, не привлекая LLM.
 *
 * Конфигурация (веса субметрик, штрафы и т.п.) хранится в коде через
 * deepFreeze — env-переменные не читаются (см. memory «env configuration»).
 *
 * Никаких side-effects: чистая функция (reports, meta) → result.
 */

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/**
 * Веса субметрик в итоговом overall. Сумма = 1.0.
 *
 * Подобраны так, чтобы:
 *   • E-E-A-T (содержательное качество) и читабельность доминировали;
 *   • fact-check и анти-плагиат давали жёсткие штрафы за низкий verdict;
 *   • LSI-coverage отражал семантическую полноту;
 *   • intent_match и image_qa играли модулирующую роль.
 *
 * Каждая субметрика нормализована в [0, 100]. Если данных нет (verdict='na'
 * или отчёт отсутствует) — вес перераспределяется на остальные.
 */
const WEIGHTS = deepFreeze({
  eeat:        0.28,
  readability: 0.15,
  fact_check:  0.18,
  plagiarism:  0.12,
  intent:      0.07,
  lsi:         0.13,
  image_qa:    0.04,
  validation:  0.03,
});

/**
 * Маппинг verdict → score [0..100] для отчётов с дискретными verdict.
 * Используется как фолбэк, когда у отчёта нет численной шкалы.
 */
const VERDICT_SCORES = deepFreeze({
  pass:       100,
  ok:         100,
  review:     65,
  refine:     50,
  mismatch:   30,
  fail:       10,
  // 'na' обрабатывается отдельно (исключается из взвешивания).
});

function _clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function _verdictToScore(verdict, fallback = null) {
  if (!verdict || verdict === 'na') return fallback;
  const v = String(verdict).toLowerCase();
  return Object.prototype.hasOwnProperty.call(VERDICT_SCORES, v)
    ? VERDICT_SCORES[v]
    : fallback;
}

// ── Per-report extractors ──────────────────────────────────────────

function _eeatScore(report) {
  if (!report || typeof report !== 'object') return null;
  // eeat audit core: total_score ∈ [0..10]
  const total = Number(report.total_score);
  if (Number.isFinite(total)) return _clamp(total * 10, 0, 100);
  return _verdictToScore(report.verdict, null);
}

function _readabilityScore(report) {
  if (!report || report.verdict === 'na') return null;
  // verdict ∈ {pass, review, refine}; есть метрики Flesch-RU, passive%, bureaucratese
  return _verdictToScore(report.verdict, 60);
}

function _factCheckScore(report) {
  if (!report) return null;
  if (report.verdict === 'na') return null;
  // supportedPct ∈ [0..1] или [0..100] — нормализуем
  let supported = Number(report.supportedPct);
  if (Number.isFinite(supported)) {
    if (supported <= 1) supported *= 100;
    return _clamp(supported, 0, 100);
  }
  return _verdictToScore(report.verdict, null);
}

function _plagiarismScore(report) {
  if (!report) return null;
  if (report.verdict === 'na') return null;
  // overlapPctTotal — процент совпадений; чем меньше, тем лучше.
  let overlap = Number(report.overlapPctTotal);
  if (Number.isFinite(overlap)) {
    // 0% → 100; 50%+ → 0.
    return _clamp(100 - overlap * 2, 0, 100);
  }
  return _verdictToScore(report.verdict, null);
}

function _intentScore(report) {
  if (!report) return null;
  if (report.verdict === 'na') return null;
  return _verdictToScore(report.verdict, null);
}

function _lsiScore(lsiReport, lsiOverdoseReport) {
  if (!lsiReport && !lsiOverdoseReport) return null;
  // lsi_report содержит coverage в [0..1] либо []. Берём максимум, что есть.
  let coverage = null;
  if (lsiReport) {
    const c = Number(lsiReport.coverage ?? lsiReport.coverage_pct ?? lsiReport.covered_pct);
    if (Number.isFinite(c)) coverage = c <= 1 ? c * 100 : c;
  }
  // overdose штрафует за переспам — если есть зоны overdose, минусуем.
  let overdosePenalty = 0;
  if (lsiOverdoseReport && Array.isArray(lsiOverdoseReport.zones)) {
    const overdosed = lsiOverdoseReport.zones.filter((z) => z && z.verdict === 'overdose').length;
    overdosePenalty = Math.min(30, overdosed * 8);
  }
  if (coverage === null && overdosePenalty === 0) return null;
  const base = coverage === null ? 70 : _clamp(coverage, 0, 100);
  return _clamp(base - overdosePenalty, 0, 100);
}

function _imageQaScore(report) {
  if (!report || report.verdict === 'na') return null;
  return _verdictToScore(report.verdict, null);
}

function _validationScore(report) {
  if (!report || typeof report !== 'object') return null;
  // validation_report содержит by_kind/issues — больше нарушений → ниже балл.
  const issues = Array.isArray(report.issues) ? report.issues.length
                : Number(report.total_issues || 0);
  if (!Number.isFinite(issues)) return null;
  // 0 issues → 100, 10+ → 30.
  return _clamp(100 - issues * 7, 30, 100);
}

/**
 * computeQualityScore(reports, meta) — главный API.
 *
 * @param {object} reports
 *   {
 *     eeat_audit?, readability_report?, intent_verdict?,
 *     fact_check_report?, plagiarism_report?,
 *     lsi_report?, lsi_overdose_report?,
 *     validation_report?, image_qa_report?
 *   }
 * @param {object} [meta] — { model_used, cost_usd, generation_time_ms,
 *                            tokens_in, tokens_out }
 * @returns {object} {
 *     overall: 0..100 (rounded to 1 decimal),
 *     sub: { eeat, readability, fact_check, plagiarism, intent, lsi,
 *            image_qa, validation } (each 0..100 | null),
 *     applied_weights: { ... }      — фактические веса после редистрибуции
 *     model_used, cost_usd, generation_time_ms, tokens_in, tokens_out,
 *     computed_at: ISO-8601
 *   }
 */
function computeQualityScore(reports = {}, meta = {}) {
  const sub = {
    eeat:        _eeatScore(reports.eeat_audit),
    readability: _readabilityScore(reports.readability_report),
    fact_check:  _factCheckScore(reports.fact_check_report),
    plagiarism:  _plagiarismScore(reports.plagiarism_report),
    intent:      _intentScore(reports.intent_verdict),
    lsi:         _lsiScore(reports.lsi_report, reports.lsi_overdose_report),
    image_qa:    _imageQaScore(reports.image_qa_report),
    validation:  _validationScore(reports.validation_report),
  };

  // Weighted average с перераспределением весов отсутствующих метрик.
  let totalWeight = 0;
  let weightedSum = 0;
  const appliedWeights = {};
  for (const [key, score] of Object.entries(sub)) {
    if (score === null || !Number.isFinite(score)) {
      appliedWeights[key] = 0;
      continue;
    }
    const w = WEIGHTS[key] || 0;
    totalWeight += w;
    weightedSum += w * score;
    appliedWeights[key] = w;
  }

  const overall = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 10) / 10
    : null;

  // Нормализуем appliedWeights (чтобы сумма ≈ 1.0 для отображения в UI).
  if (totalWeight > 0) {
    for (const k of Object.keys(appliedWeights)) {
      appliedWeights[k] = Math.round((appliedWeights[k] / totalWeight) * 1000) / 1000;
    }
  }

  return {
    overall,
    sub,
    applied_weights:     appliedWeights,
    model_used:          meta.model_used         || null,
    cost_usd:            Number.isFinite(Number(meta.cost_usd))           ? Number(meta.cost_usd)           : null,
    generation_time_ms:  Number.isFinite(Number(meta.generation_time_ms)) ? Number(meta.generation_time_ms) : null,
    tokens_in:           Number.isFinite(Number(meta.tokens_in))          ? Number(meta.tokens_in)          : null,
    tokens_out:          Number.isFinite(Number(meta.tokens_out))         ? Number(meta.tokens_out)         : null,
    computed_at:         new Date().toISOString(),
  };
}

module.exports = {
  computeQualityScore,
  WEIGHTS,
  VERDICT_SCORES,
};
