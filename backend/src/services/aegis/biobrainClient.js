'use strict';

const http = require('./_httpClient');
const { getAegisFlags } = require('./featureFlags');

function _cfg() {
  const flags = getAegisFlags();
  return {
    enabled: Boolean(flags.biobrain && flags.biobrain.enabled),
    base: flags.graphrag.pyServiceUrl,
    fastRejectThreshold: flags.biobrain && flags.biobrain.fastRejectThreshold,
  };
}

async function predict({ features = null, text = null, signals = null } = {}) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.post(c.base, '/biobrain/predict', {
    features,
    text,
    signals,
    threshold_fast_reject: c.fastRejectThreshold,
  }, { timeoutMs: 5000 });
}

async function feedback({ features = null, text = null, signals = null, predicted = null, real_spq_overall, real_eeat = null } = {}) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.post(c.base, '/biobrain/feedback', {
    features,
    text,
    signals,
    predicted,
    real_spq_overall,
    real_eeat,
  }, { timeoutMs: 10000 });
}

async function advice({ features = null, text = null, signals = null } = {}) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.post(c.base, '/biobrain/advice', {
    features,
    text,
    signals,
    threshold_fast_reject: c.fastRejectThreshold,
  }, { timeoutMs: 5000 });
}

async function status() {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.get(c.base, '/biobrain/status', { timeoutMs: 5000 });
}

async function generations(limit = 50) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return http.get(c.base, `/biobrain/generations?limit=${lim}`, { timeoutMs: 5000 });
}

module.exports = { predict, feedback, advice, status, generations };
