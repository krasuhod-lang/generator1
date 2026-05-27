'use strict';

/**
 * aegis/moduleHooks — единый, минимальный observer-слой для модулей
 * генерации (infoArticle / linkArticle / metaTags / articleTopics / parser).
 *
 * Идея: вместо того чтобы каждый модуль вручную создавал свой
 * aegisHooks.js (как relevance/aegisHooks.js), даём общий API:
 *
 *   observeStage({ module, stage, taskId, outcome, durationMs, payload })
 *
 * Что делает:
 *   1) Пушит счётчики aegis_module_stages_total{module,stage,outcome} и
 *      гистограмму aegis_module_stage_latency_ms{module,stage}.
 *   2) Если AEGIS_MODULE_QUALITY_GATE_ENABLED=on и payload содержит
 *      quality_score → дёргает qualityGate.evaluate(payload) и пишет
 *      verdict в счётчик aegis_module_quality_verdicts_total.
 *   3) Опц. печатает компактную строку в console.info (при verbose-флаге).
 *
 * Все вызовы graceful: AEGIS_ENABLED=false → no-op. Никогда не бросают.
 *
 * Цель: дать единое место, где Aegis может «контролировать и улучшать
 * каждый этап работы программы в каждом модуле» — без расползания
 * хук-файлов по сервисам. Модули просто зовут observeStage() и забывают.
 */

const { getAegisFlags } = require('./featureFlags');

let _telemetryRef = null;
let _qualityGateRef = null;

function _telemetry() {
  if (_telemetryRef === null) {
    try { _telemetryRef = require('./telemetry'); }
    catch (_) { _telemetryRef = false; }
  }
  return _telemetryRef || null;
}
function _qualityGate() {
  if (_qualityGateRef === null) {
    try { _qualityGateRef = require('./qualityGate'); }
    catch (_) { _qualityGateRef = false; }
  }
  return _qualityGateRef || null;
}

// Ленивая регистрация метрик: используем уже существующие counter/gauge/histogram.
const _metricsCache = {};
function _getMetrics() {
  if (_metricsCache.stages) return _metricsCache;
  const t = _telemetry();
  if (!t) return null;
  try {
    _metricsCache.stages = t.counter(
      'aegis_module_stages_total',
      'Per-module pipeline stages observed by Aegis',
      ['module', 'stage', 'outcome'],
    );
    _metricsCache.latency = t.histogram(
      'aegis_module_stage_latency_ms',
      'Per-module pipeline stage latency (ms)',
      [50, 250, 1000, 5000, 15000, 60000, 300000],
      ['module', 'stage'],
    );
    _metricsCache.verdicts = t.counter(
      'aegis_module_quality_verdicts_total',
      'Quality-gate verdicts emitted per module/stage',
      ['module', 'stage', 'verdict'],
    );
    _metricsCache.warnings = t.counter(
      'aegis_module_warnings_total',
      'Per-module warnings raised during stage observation',
      ['module', 'stage', 'kind'],
    );
  } catch (_) {
    _metricsCache.stages = null;
  }
  return _metricsCache;
}

function _isOn() {
  try {
    const f = getAegisFlags();
    return !!(f && f.enabled && f.moduleHooks && f.moduleHooks.enabled);
  } catch (_) { return false; }
}

/**
 * observeStage — главный entry-point. Все поля кроме module/stage опц.
 *
 * @param {object} obs
 * @param {string} obs.module    — 'infoArticle' | 'linkArticle' | 'metaTags' | 'articleTopics' | 'parser' | ...
 * @param {string} obs.stage     — короткий стадия-id ('stage2_structure', 'extract_hidden', 'dedup', ...)
 * @param {string} [obs.taskId]
 * @param {'ok'|'warn'|'error'|'skipped'} [obs.outcome='ok']
 * @param {number} [obs.durationMs]
 * @param {object} [obs.payload] — произвольные метрики стадии (counts, scores, samples)
 * @param {object} [obs.warnings] — { kind: count } — дополнительные warning-счётчики
 * @returns {{ verdict?: string, gate_action?: string } | null}
 */
function observeStage(obs = {}) {
  if (!_isOn()) return null;
  const module  = String(obs.module || '').slice(0, 40) || 'unknown';
  const stage   = String(obs.stage  || '').slice(0, 60) || 'unknown';
  const outcome = ['ok', 'warn', 'error', 'skipped'].includes(obs.outcome) ? obs.outcome : 'ok';

  const metrics = _getMetrics();
  if (metrics && metrics.stages) {
    try {
      metrics.stages.inc(1, { module, stage, outcome });
      if (obs.durationMs != null && Number.isFinite(Number(obs.durationMs))) {
        metrics.latency.observe(Number(obs.durationMs), { module, stage });
      }
      if (obs.warnings && typeof obs.warnings === 'object') {
        for (const [kind, n] of Object.entries(obs.warnings)) {
          metrics.warnings.inc(Number(n) || 0, { module, stage, kind: String(kind).slice(0, 40) });
        }
      }
    } catch (_) { /* graceful */ }
  }

  // QualityGate hook — только если в payload есть quality_score (число 0..100).
  let gateResult = null;
  try {
    const cfg = getAegisFlags().moduleHooks;
    if (cfg && cfg.qualityGate && obs.payload && obs.payload.quality_score != null) {
      const qg = _qualityGate();
      if (qg && typeof qg.evaluate === 'function') {
        gateResult = qg.evaluate({
          module, stage, taskId: obs.taskId,
          overall: Number(obs.payload.quality_score) || 0,
          sub: obs.payload.quality_sub || {},
        });
        if (metrics && metrics.verdicts && gateResult && gateResult.verdict) {
          metrics.verdicts.inc(1, { module, stage, verdict: gateResult.verdict });
        }
      }
    }
  } catch (_) { /* graceful */ }

  return gateResult;
}

/**
 * wrapStage(observerOpts, fn) — sugar: оборачивает async-функцию,
 * автоматически замеряет durationMs и outcome (ok/error). Возвращает
 * результат fn() или прокидывает ошибку дальше.
 *
 *   await wrapStage({ module:'linkArticle', stage:'writer', taskId }, async () => {
 *     return runWriter(...);
 *   });
 */
async function wrapStage(observerOpts, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    observeStage({ ...observerOpts, outcome: 'ok', durationMs: Date.now() - started });
    return result;
  } catch (e) {
    observeStage({
      ...observerOpts,
      outcome: 'error',
      durationMs: Date.now() - started,
      warnings: { [String(e.code || 'error').slice(0, 40)]: 1 },
    });
    throw e;
  }
}

module.exports = {
  observeStage,
  wrapStage,
  _resetCacheForTests() {
    _telemetryRef = null;
    _qualityGateRef = null;
    for (const k of Object.keys(_metricsCache)) delete _metricsCache[k];
  },
};
