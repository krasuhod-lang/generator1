'use strict';

/**
 * aegis/rewardCalculator.js — расчёт reward для observation мозга Эгиды
 * (задача 2: «свой мозг внутри наших продуктов»).
 *
 * Чистые функции, без БД/HTTP. Принимают нормализованные фичи и веса
 * (по умолчанию — из featureFlags.brain.rewards) и возвращают число
 * reward + breakdown по компонентам. Breakdown полезен для дашборда
 * «Brain training health» в админке: видно, какая компонента вносит
 * основной вклад.
 *
 * Тесты: backend/scripts/test-aegis-reward-calculator.js.
 *
 * Формулы (плановое):
 *   Проектный reward
 *     = w_clicks   · norm(Δclicks)
 *     + w_position · norm(-Δposition)             // позиция меньше = лучше
 *     + w_spq      · (spq / 100)
 *     + w_ctr_gap  · ctrGapClosedFraction         // 0..1
 *     − w_budget   · (budgetUsd / 10)             // штраф за расход
 *
 *   Reward за генерацию (статья/мета)
 *     = w_spq        · (spq / 100)
 *     + w_factcheck  · factCheckPassRate          // 0..1
 *     − w_plagiarism · plagiarismOverlap          // 0..1 (доля заимствований)
 *
 * Нормализация Δclicks/Δposition — гиперболический тангенс, чтобы
 * выбросы (типа +10000 кликов) не доминировали в выборке.
 */

const { getAegisFlags } = require('./featureFlags');

const DEFAULT_WEIGHTS = Object.freeze({
  project: { deltaClicks: 1.0, deltaPosition: 1.0, spq: 0.5, ctrGapClosed: 0.5, budgetUsd: 0.1 },
  generation: { spq: 1.0, factCheck: 0.5, plagiarism: 0.5 },
});

function _resolveWeights(kind, override) {
  // Override > featureFlags > DEFAULT_WEIGHTS. Не падаем, если флаги
  // не настроены (например, brain-блок ещё не добавлен в forked инсталляции).
  let fromFlags = null;
  try {
    const flags = getAegisFlags();
    fromFlags = flags && flags.brain && flags.brain.rewards ? flags.brain.rewards[kind] : null;
  } catch (_) { fromFlags = null; }
  return { ...DEFAULT_WEIGHTS[kind], ...(fromFlags || {}), ...(override || {}) };
}

/** Гиперболический тангенс. Сжимает любое число в (-1, 1). */
function _tanh(x) {
  if (!Number.isFinite(x)) return 0;
  if (x > 20)  return  1;
  if (x < -20) return -1;
  const ex = Math.exp(x), enx = Math.exp(-x);
  return (ex - enx) / (ex + enx);
}

function _toNumber(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function _clamp01(v) {
  const n = _toNumber(v, 0);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * computeProjectReward — reward для observation проектной рекомендации.
 *
 * features:
 *   deltaClicks       — изменение кликов GSC/Я.Вебмастер за N дней после
 *                       рекомендации (может быть отрицательным; масштаб ~ кликов
 *                       за период);
 *   deltaPosition     — изменение средней позиции (меньше = лучше);
 *   spq               — overall quality score рекомендации (0..100);
 *   ctrGapClosed      — доля закрытого CTR-gap (0..1) по striking-distance
 *                       страницам, упомянутым в рекомендации;
 *   budgetUsd         — расход бюджета LLM на эту итерацию.
 *
 * Возвращает { reward, breakdown:{...} } — breakdown содержит вклад каждой
 * компоненты с уже применённым весом.
 */
function computeProjectReward(features = {}, opts = {}) {
  const w = _resolveWeights('project', opts.weights);
  // Нормализация клик: tanh(Δclicks / scale). scale=100 — типичный «заметный»
  // прирост за период. Можно переопределить через opts.clickScale.
  const clickScale    = _toNumber(opts.clickScale,    100);
  const positionScale = _toNumber(opts.positionScale, 5);
  const budgetScale   = _toNumber(opts.budgetScale,   10);

  const dClicks   = _toNumber(features.deltaClicks,   0);
  const dPosition = _toNumber(features.deltaPosition, 0);
  const spq       = _toNumber(features.spq,           0);
  const ctrGap    = _clamp01(features.ctrGapClosed);
  const budget    = Math.max(0, _toNumber(features.budgetUsd, 0));

  const breakdown = {
    deltaClicks:   w.deltaClicks   * _tanh(dClicks / clickScale),
    deltaPosition: w.deltaPosition * _tanh(-dPosition / positionScale),
    spq:           w.spq           * (spq / 100),
    ctrGapClosed:  w.ctrGapClosed  * ctrGap,
    budgetUsd:     -w.budgetUsd    * (budget / budgetScale),
  };
  const reward = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { reward, breakdown, weights: w };
}

/**
 * computeGenerationReward — reward для сгенерированного артефакта
 * (статья/мета-теги/линк-артикл). Используется как «золотая метка»
 * при тренировке DSPy сигнатур writer-критик.
 *
 *   spq                 — overall quality 0..100;
 *   factCheckPassRate   — 0..1 доля прошедших проверку утверждений;
 *   plagiarismOverlap   — 0..1 доля n-gram пересечений с конкурентами.
 */
function computeGenerationReward(features = {}, opts = {}) {
  const w = _resolveWeights('generation', opts.weights);
  const spq        = _toNumber(features.spq, 0);
  const factCheck  = _clamp01(features.factCheckPassRate);
  const plagiarism = _clamp01(features.plagiarismOverlap);
  const breakdown = {
    spq:        w.spq        * (spq / 100),
    factCheck:  w.factCheck  * factCheck,
    plagiarism: -w.plagiarism * plagiarism,
  };
  const reward = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { reward, breakdown, weights: w };
}

module.exports = {
  DEFAULT_WEIGHTS,
  computeProjectReward,
  computeGenerationReward,
  // экспорт для тестов
  _internal: { _tanh, _clamp01, _resolveWeights },
};
