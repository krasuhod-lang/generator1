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

async function predict({ features = null, text = null } = {}) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.post(c.base, '/biobrain/predict', {
    features,
    text,
    threshold_fast_reject: c.fastRejectThreshold,
  }, { timeoutMs: 5000 });
}

async function feedback({ features, predicted, real_spq_overall, real_eeat = null } = {}) {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.post(c.base, '/biobrain/feedback', {
    features,
    predicted,
    real_spq_overall,
    real_eeat,
  }, { timeoutMs: 10000 });
}

async function status() {
  const c = _cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  return http.get(c.base, '/biobrain/status', { timeoutMs: 5000 });
}

module.exports = { predict, feedback, status };
