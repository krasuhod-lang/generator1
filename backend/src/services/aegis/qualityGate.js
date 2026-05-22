'use strict';

/**
 * aegis/qualityGate — жёсткий гейт качества Spq ≥ 8.0 (по 10-балльной)
 * или ≥ 80 (по 100-балльной шкале computeQualityScore).
 *
 * По требованию владельца продукта: «делаем жёсткое ограничение от 8».
 *
 * Использует уже посчитанный qualityScore из существующего модуля
 * backend/src/services/qualityLayers/qualityScore.js (computeQualityScore).
 *
 * Поведение при провале (qualityGate.onFail):
 *   - 'fail'   → бросаем QualityGateFailedError. Вызывающий пайплайн
 *                должен отметить статью как failed/needs_human_review.
 *   - 'review' → возвращаем verdict 'review' и продолжаем — статья
 *                будет помечена флажком needs_human_review, но
 *                сохранена и отдана клиенту.
 *
 * Чистая функция; не пишет в БД, не делает сети.
 */

const { getAegisFlags } = require('./featureFlags');

class QualityGateFailedError extends Error {
  constructor(reason, audit) {
    super(`[aegis/qualityGate] ${reason}`);
    this.name   = 'QualityGateFailedError';
    this.reason = reason;
    this.audit  = audit;
  }
}

/**
 * evaluateQualityGate(qualityScore, opts?) — главный API.
 *
 * @param {object} qualityScore — результат computeQualityScore (overall + sub).
 * @param {object} [opts] — override gate-настроек (для тестов).
 * @returns {{
 *   passed: boolean,
 *   verdict: 'pass'|'review'|'fail',
 *   reason: string|null,
 *   overall: number|null,
 *   sub_fails: Array<{key:string, value:number|null, threshold:number}>,
 *   min_overall: number,
 * }}
 */
function evaluateQualityGate(qualityScore, opts = {}) {
  const gate = getAegisFlags().qualityGate;
  const minOverall = Number.isFinite(opts.minOverall) ? opts.minOverall : gate.minOverall;
  const minSub     = opts.minSub || gate.minSub;
  const onFail     = opts.onFail || gate.onFail;

  const overall = Number(qualityScore && qualityScore.overall);
  const sub     = (qualityScore && qualityScore.sub) || {};

  const sub_fails = [];
  for (const [key, threshold] of Object.entries(minSub)) {
    const v = Number(sub[key]);
    if (Number.isFinite(v) && v < threshold) {
      sub_fails.push({ key, value: v, threshold });
    }
  }

  let passed = true;
  let reason = null;

  if (!Number.isFinite(overall)) {
    passed = false;
    reason = 'overall_score_missing';
  } else if (overall < minOverall) {
    passed = false;
    reason = `overall ${overall} < ${minOverall}`;
  } else if (sub_fails.length) {
    passed = false;
    reason = `sub-метрики ниже порога: ${sub_fails.map((f) => `${f.key}=${f.value}<${f.threshold}`).join(', ')}`;
  }

  const verdict = passed ? 'pass' : (onFail === 'review' ? 'review' : 'fail');

  return {
    passed,
    verdict,
    reason,
    overall: Number.isFinite(overall) ? overall : null,
    sub_fails,
    min_overall: minOverall,
  };
}

/**
 * enforceQualityGate(qualityScore, opts?) — то же, но бросает
 * QualityGateFailedError при verdict='fail' (если onFail='fail').
 *
 * @returns audit object с verdict='pass'|'review'.
 */
function enforceQualityGate(qualityScore, opts = {}) {
  const audit = evaluateQualityGate(qualityScore, opts);
  if (audit.verdict === 'fail') {
    throw new QualityGateFailedError(audit.reason || 'unknown', audit);
  }
  return audit;
}

module.exports = {
  evaluateQualityGate,
  enforceQualityGate,
  QualityGateFailedError,
};
