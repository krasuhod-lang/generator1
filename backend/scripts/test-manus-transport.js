'use strict';

const assert = require('assert');
const {
  normalizeProxyUrl,
  resolveManusProxyUrls,
  manusTransportAttempts,
  proxyRequired,
} = require('../src/services/llm/manus.transport');

assert.strictEqual(
  normalizeProxyUrl('login:pass:155.212.59.188:64464'),
  'http://login:pass@155.212.59.188:64464',
);
assert.strictEqual(
  normalizeProxyUrl('http://login:pass:155.212.59.188:64464'),
  'http://login:pass@155.212.59.188:64464',
);

const manusEnv = {
  MANUS_PROXY_URL: 'manus-user:manus-pass:203.0.113.10:8080',
  GEMINI_PROXY_URL: 'gem-user:gem-pass:203.0.113.11:8081',
  HTTPS_PROXY: 'http://system:system-pass@203.0.113.12:8082',
};
assert.deepStrictEqual(
  resolveManusProxyUrls(manusEnv),
  ['http://manus-user:manus-pass@203.0.113.10:8080'],
);

const geminiEnv = {
  GEMINI_PROXY_URL: 'gem-user:gem-pass:203.0.113.11:8081',
  HTTPS_PROXY: 'http://system:system-pass@203.0.113.12:8082',
};
assert.deepStrictEqual(
  resolveManusProxyUrls(geminiEnv),
  ['http://gem-user:gem-pass@203.0.113.11:8081'],
);
assert.strictEqual(manusTransportAttempts(geminiEnv).length, 1);
assert.ok(manusTransportAttempts(geminiEnv)[0].config.httpsAgent);
assert.strictEqual(proxyRequired({ MANUS_PROXY_REQUIRED: 'true' }), true);
assert.strictEqual(proxyRequired({ MANUS_PROXY_REQUIRED: 'false' }), false);
assert.strictEqual(proxyRequired({}), false);

console.log('MANUS_TRANSPORT_CONTRACT_OK checks=9');
