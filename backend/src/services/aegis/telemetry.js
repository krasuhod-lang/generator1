'use strict';

/**
 * aegis/telemetry — лёгкий Prometheus-совместимый сборщик метрик.
 *
 * Zero deps: реализует counter / gauge / histogram в чистом JS и
 * экспортирует их в text exposition формат (как у Prometheus). Внешние
 * Prometheus/Grafana — ОПЦИОНАЛЬНЫ; данные доступны из коробки через
 * GET /api/aegis/metrics.
 *
 * Поддерживаемые метрики:
 *   aegis_tokens_total{provider,direction}        counter
 *   aegis_cost_usd_total{provider}                counter
 *   aegis_cache_hits_total{provider}              counter
 *   aegis_cache_misses_total{provider}            counter
 *   aegis_llm_requests_total{provider,outcome}    counter
 *   aegis_llm_latency_ms{provider}                histogram (p50/p95/p99 via buckets)
 *   aegis_workers_active                          gauge
 *   aegis_killswitch                              gauge (1=engaged)
 *   aegis_quality_score{kind}                     gauge (last observed)
 *
 * Все методы безопасны при выключенной телеметрии (флаг enabled=false):
 * становятся no-op, но snapshot() всё равно возвращает структуру.
 *
 * Push-режим (OTLP HTTP): если AEGIS_OTLP_HTTP_URL задан, периодически
 * шлём JSON-снапшот POST'ом на этот URL (для коллектора OpenTelemetry).
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

// ── Внутренние реестры (process-global) ────────────────────────────
const _state = {
  counters: new Map(),       // key → number
  gauges:   new Map(),       // key → number
  histograms: new Map(),     // key → { buckets:Map<le,number>, sum:number, count:number }
  meta: new Map(),           // key → { help, type, labelNames }
};

const DEFAULT_BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function _ensureMeta(name, type, help, labelNames = []) {
  if (!_state.meta.has(name)) {
    _state.meta.set(name, { help, type, labelNames });
  }
}

function _key(name, labels) {
  if (!labels || !Object.keys(labels).length) return name;
  const parts = Object.keys(labels).sort().map((k) => {
    const v = String(labels[k] == null ? '' : labels[k]).replace(/[\\"\n]/g, '_');
    return `${k}="${v}"`;
  });
  return `${name}{${parts.join(',')}}`;
}

function _isOn() {
  try { return getAegisFlags().telemetry.enabled !== false; }
  catch (_e) { return true; }
}

// ── Public API ─────────────────────────────────────────────────────

function counter(name, help, labelNames = []) {
  _ensureMeta(name, 'counter', help, labelNames);
  return {
    inc(value = 1, labels = {}) {
      if (!_isOn()) return;
      const k = _key(name, labels);
      _state.counters.set(k, (_state.counters.get(k) || 0) + Number(value || 0));
    },
  };
}

function gauge(name, help, labelNames = []) {
  _ensureMeta(name, 'gauge', help, labelNames);
  return {
    set(value, labels = {}) {
      if (!_isOn()) return;
      _state.gauges.set(_key(name, labels), Number(value || 0));
    },
    inc(value = 1, labels = {}) {
      if (!_isOn()) return;
      const k = _key(name, labels);
      _state.gauges.set(k, (_state.gauges.get(k) || 0) + Number(value || 0));
    },
    dec(value = 1, labels = {}) {
      this.inc(-Number(value || 0), labels);
    },
  };
}

function histogram(name, help, buckets = DEFAULT_BUCKETS_MS, labelNames = []) {
  _ensureMeta(name, 'histogram', help, labelNames);
  return {
    observe(value, labels = {}) {
      if (!_isOn()) return;
      const k = _key(name, labels);
      let h = _state.histograms.get(k);
      if (!h) {
        h = { buckets: new Map(buckets.map((b) => [b, 0])), sum: 0, count: 0 };
        _state.histograms.set(k, h);
      }
      const v = Number(value || 0);
      h.sum += v;
      h.count += 1;
      for (const le of buckets) {
        if (v <= le) h.buckets.set(le, (h.buckets.get(le) || 0) + 1);
      }
    },
  };
}

// ── Pre-registered metrics (consistent names) ──────────────────────

const M = {
  tokens:        counter('aegis_tokens_total',        'Total LLM tokens charged',           ['provider', 'direction']),
  cost:          counter('aegis_cost_usd_total',      'Total LLM cost in USD',              ['provider']),
  cacheHits:     counter('aegis_cache_hits_total',    'LLM prompt-cache hits',              ['provider']),
  cacheMisses:   counter('aegis_cache_misses_total',  'LLM prompt-cache misses',            ['provider']),
  requests:      counter('aegis_llm_requests_total',  'LLM requests by outcome',            ['provider', 'outcome']),
  latency:       histogram('aegis_llm_latency_ms',    'LLM call latency (ms)',              DEFAULT_BUCKETS_MS, ['provider']),
  workers:       gauge('aegis_workers_active',        'Currently active worker slots'),
  killswitch:    gauge('aegis_killswitch',            'Kill switch engaged (1=on,0=off)'),
  qualityScore:  gauge('aegis_quality_score',         'Last observed quality.overall',      ['kind']),
  budgetUsd:     counter('aegis_budget_usd_total',    'Cumulative budget spent USD',        ['kind']),
  // Phase 14 — Vector GC & relevance integration
  vectorGcRuns:           counter('aegis_vector_gc_runs_total',           'Vector GC invocations',              ['kind', 'ok']),
  vectorGcPointsDeleted:  counter('aegis_vector_gc_points_deleted_total', 'Vector points deleted by GC',        ['kind']),
  relevancePages:         counter('aegis_relevance_pages_total',          'Relevance pages processed',          ['outcome']),
  relevancePoisonDropped: counter('aegis_relevance_poison_dropped_total', 'Relevance pages dropped by poison',  ['reason']),
  dspyMutations:          counter('aegis_dspy_mutations_total',           'ε-greedy DSPy mutations applied',    ['kind']),
};

/**
 * recordLlmCall({ provider, tokensIn, tokensOut, costUsd, cacheHitTokens,
 *                 latencyMs, outcome }) — high-level helper для одного LLM-вызова.
 */
function recordLlmCall(meta = {}) {
  const provider = String(meta.provider || 'unknown').toLowerCase();
  M.tokens.inc(meta.tokensIn  || 0, { provider, direction: 'in' });
  M.tokens.inc(meta.tokensOut || 0, { provider, direction: 'out' });
  M.cost.inc(meta.costUsd     || 0, { provider });
  if (meta.cacheHitTokens && meta.cacheHitTokens > 0) {
    M.cacheHits.inc(meta.cacheHitTokens, { provider });
  } else if (meta.tokensIn > 0) {
    M.cacheMisses.inc(meta.tokensIn, { provider });
  }
  if (meta.latencyMs != null) M.latency.observe(meta.latencyMs, { provider });
  M.requests.inc(1, { provider, outcome: meta.outcome || 'ok' });
}

/** snapshot() — машинно-читаемый JSON всех метрик. */
function snapshot() {
  const counters = {};
  for (const [k, v] of _state.counters) counters[k] = v;
  const gauges = {};
  for (const [k, v] of _state.gauges) gauges[k] = v;
  const histograms = {};
  for (const [k, v] of _state.histograms) {
    histograms[k] = {
      buckets: Object.fromEntries(v.buckets),
      sum:     v.sum,
      count:   v.count,
    };
  }
  return { counters, gauges, histograms, ts: Date.now() };
}

/** toPrometheus() — text exposition format (HELP + TYPE + samples). */
function toPrometheus() {
  const lines = [];
  const emitted = new Set();

  function _emitMetaOnce(baseName) {
    if (emitted.has(baseName)) return;
    const m = _state.meta.get(baseName);
    if (m) {
      if (m.help) lines.push(`# HELP ${baseName} ${m.help}`);
      lines.push(`# TYPE ${baseName} ${m.type}`);
    }
    emitted.add(baseName);
  }

  function _baseName(key) {
    const i = key.indexOf('{');
    return i < 0 ? key : key.slice(0, i);
  }

  for (const [k, v] of _state.counters) {
    _emitMetaOnce(_baseName(k));
    lines.push(`${k} ${v}`);
  }
  for (const [k, v] of _state.gauges) {
    _emitMetaOnce(_baseName(k));
    lines.push(`${k} ${v}`);
  }
  for (const [k, h] of _state.histograms) {
    const base = _baseName(k);
    _emitMetaOnce(base);
    // labels prefix (without trailing })
    const labelsPart = k.includes('{') ? k.slice(k.indexOf('{') + 1, -1) : '';
    const bucketName = `${base}_bucket`;
    const withLabel = (extra) => (labelsPart
      ? `${bucketName}{${labelsPart},${extra}}`
      : `${bucketName}{${extra}}`);
    for (const [le, n] of h.buckets) {
      lines.push(`${withLabel(`le="${le}"`)} ${n}`);
    }
    lines.push(`${withLabel('le="+Inf"')} ${h.count}`);
    lines.push(`${base}_sum${labelsPart ? `{${labelsPart}}` : ''} ${h.sum}`);
    lines.push(`${base}_count${labelsPart ? `{${labelsPart}}` : ''} ${h.count}`);
  }
  return lines.join('\n') + '\n';
}

/** reset() — для тестов; не вызывать в проде. */
function _resetForTests() {
  _state.counters.clear();
  _state.gauges.clear();
  _state.histograms.clear();
  // meta оставляем (зарегистрирована один раз при require).
}

// ── OTLP push (optional, fire-and-forget) ──────────────────────────
let _pushTimer = null;

function startOtlpPusher() {
  const cfg = getAegisFlags().telemetry;
  if (!cfg.enabled || !cfg.otlpHttpUrl || _pushTimer) return false;
  const intervalMs = Math.max(1000, cfg.pushIntervalSec * 1000);
  _pushTimer = setInterval(() => {
    const snap = snapshot();
    // graceful: ошибки игнорируем — телеметрия не должна валить процесс.
    http.post(cfg.otlpHttpUrl, '', snap, { timeoutMs: 5000 }).catch(() => {});
  }, intervalMs);
  if (_pushTimer.unref) _pushTimer.unref();
  return true;
}

function stopOtlpPusher() {
  if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; }
}

module.exports = {
  counter, gauge, histogram,
  M, recordLlmCall,
  snapshot, toPrometheus,
  startOtlpPusher, stopOtlpPusher,
  _resetForTests,
};
