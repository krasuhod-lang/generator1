'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const dbDefault = require('../../config/db');
const {
  INTEGRATION_CATALOG,
  getIntegrationSecretInfo,
  normalizeName,
} = require('./integrationVault');

const DEFAULT_TIMEOUT_MS = 10000;

function endpointFor(envName) {
  const base = (value, fallback) => String(process.env[value] || fallback).replace(/\/+$/, '');
  switch (envName) {
    case 'OPENAI_API_KEY':
      return { method: 'get', url: `${base('OPENAI_BASE_URL', 'https://api.openai.com/v1')}/models`, auth: 'bearer' };
    case 'DEEPSEEK_API_KEY':
      return { method: 'get', url: `${base('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')}/models`, auth: 'bearer' };
    case 'GEMINI_API_KEY': {
      const url = base('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/models');
      return { method: 'get', url, auth: 'gemini_query' };
    }
    case 'XAI_API_KEY':
      return { method: 'get', url: `${base('XAI_BASE_URL', 'https://api.x.ai/v1')}/models`, auth: 'bearer' };
    case 'DASHSCOPE_API_KEY':
      return { method: 'get', url: `${base('DASHSCOPE_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')}/models`, auth: 'bearer' };
    case 'RESEND_API_KEY':
      return { method: 'get', url: 'https://api.resend.com/api-keys', auth: 'bearer' };
    case 'RELEVANCE_INTERNAL_TOKEN': {
      const url = `${base('RELEVANCE_INTERNAL_URL', 'http://relevance:8000')}/health`;
      return { method: 'get', url, auth: 'internal_header' };
    }
    case 'SERPAPI_API_KEY':
      return { method: 'get', url: 'https://serpapi.com/account.json', auth: 'query_serpapi' };
    default:
      return null;
  }
}

function safeFailure(error) {
  const status = Number(error?.response?.status) || null;
  if (status === 401 || status === 403) return { status: 'inactive', active: false, message: 'Ключ отклонён провайдером' };
  if (status === 404) return { status: 'unsupported', active: null, message: 'Health endpoint не найден; ключ не признан неактивным' };
  if (status === 429) return { status: 'rate_limited', active: null, message: 'Провайдер временно ограничил health-проверку; ключ не признан неактивным' };
  if (status >= 400 && status < 500) return { status: 'rejected', active: null, message: 'Провайдер отклонил health-запрос' };
  if (status >= 500) return { status: 'unreachable', active: null, message: 'Провайдер временно недоступен' };
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
    return { status: 'timeout', active: null, message: 'Health-проверка превысила 10 секунд' };
  }
  return { status: 'unreachable', active: null, message: 'Не удалось связаться с провайдером' };
}

function releaseProbeBody(response) {
  const body = response?.data;
  if (!body || typeof body.destroy !== 'function') return;
  try {
    if (typeof body.on === 'function') body.on('error', () => {});
    body.destroy();
  } catch {
    // The probe only needs response headers/status; cleanup must stay fail-open.
  }
}

function normalizeProbeProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.includes('@')) return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const withProto = value.match(/^(https?:\/\/)([^:]+):([^:]+):([^:]+):(\d+)$/i);
  if (withProto) {
    const [, proto, user, pass, host, port] = withProto;
    return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  const parts = value.split(':');
  if (parts.length === 4) {
    const [p1, p2, p3, p4] = parts;
    const isPort = (s) => /^\d+$/.test(s);
    const isHost = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
    if (isHost(p3) && isPort(p4)) return `http://${encodeURIComponent(p1)}:${encodeURIComponent(p2)}@${p3}:${p4}`;
    if (isHost(p1) && isPort(p2)) return `http://${encodeURIComponent(p3)}:${encodeURIComponent(p4)}@${p1}:${p2}`;
  }
  return value;
}

function resolveGeminiProbeProxyUrls() {
  const urls = [];
  for (const suffix of ['', '_2', '_3', '_4', '_5']) {
    const full = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
    const host = process.env[`GEMINI_PROXY_HOST${suffix}`] || '';
    const port = process.env[`GEMINI_PROXY_PORT${suffix}`] || '';
    const user = process.env[`GEMINI_PROXY_USER${suffix}`] || '';
    const pass = process.env[`GEMINI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`GEMINI_PROXY_PROTO${suffix}`] || 'http';
    const candidate = full
      || (host && port
        ? (user && pass
          ? `${proto}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
          : `${proto}://${host}:${port}`)
        : '');
    if (candidate) urls.push(normalizeProbeProxy(candidate));
  }
  if (!urls.length) {
    const systemProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (systemProxy) urls.push(normalizeProbeProxy(systemProxy));
  }
  return [...new Set(urls.filter(Boolean))];
}

function probeTransports(target) {
  if (target.auth !== 'gemini_query') return [{}];
  const proxies = resolveGeminiProbeProxyUrls();
  if (!proxies.length) return [{}];
  return proxies.map((proxyUrl) => {
    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      return { httpsAgent: agent, httpAgent: agent, proxy: false };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function probeIntegrationKey(envName, { timeoutMs = DEFAULT_TIMEOUT_MS, request = axios, db } = {}) {
  const normalized = normalizeName(envName);
  const catalogItem = INTEGRATION_CATALOG.find((item) => item.envName === normalized) || { envName: normalized };
  const info = await getIntegrationSecretInfo(normalized, db ? { db } : undefined);
  const baseResult = {
    envName: normalized,
    label: catalogItem.label || normalized,
    group: catalogItem.group || 'Интеграции',
    source: info.source,
    configured: Boolean(info.configured),
    checkedAt: new Date().toISOString(),
  };

  if (!info.configured) {
    return { ...baseResult, status: 'not_configured', active: false, probeSupported: false, message: 'Ключ не задан' };
  }

  const target = endpointFor(normalized);
  if (!target) {
    return {
      ...baseResult,
      status: 'configured_unprobed',
      active: null,
      probeSupported: false,
      message: 'Для этого сервиса нет безопасного non-billable health endpoint',
    };
  }

  const startedAt = Date.now();
  try {
    const headers = { Accept: 'application/json', 'User-Agent': 'generator1-key-probe' };
    const params = {};
    let url = target.url;
    if (target.auth === 'bearer') headers.Authorization = `Bearer ${info.value}`;
    if (target.auth === 'internal_header') headers['X-Internal-Token'] = info.value;
    if (target.auth === 'gemini_query') params.key = info.value;
    if (target.auth === 'query_serpapi') params.api_key = info.value;
    const requestFn = typeof request === 'function' ? request : axios;
    const transports = probeTransports(target);
    let lastFailure = null;
    let lastHttpStatus = null;
    let lastError = null;
    for (const transport of transports) {
      try {
        const response = await requestFn({
          method: target.method,
          url,
          headers,
          params,
          ...transport,
          timeout: Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), 15000),
          validateStatus: () => true,
          // Model-list responses can exceed 1 KB. Stream headers/status and discard
          // the body instead of turning a valid key into a false transport failure.
          responseType: 'stream',
        });
        releaseProbeBody(response);
        const httpStatus = Number(response.status) || null;
        if (httpStatus >= 200 && httpStatus < 300) {
          return { ...baseResult, status: 'active', active: true, probeSupported: true, httpStatus, latencyMs: Date.now() - startedAt, message: 'Ключ принят провайдером' };
        }
        lastHttpStatus = httpStatus;
        lastFailure = safeFailure({ response: { status: httpStatus } });
        // Authentication rejection is independent of the selected proxy; do not
        // send the same secret through all backup routes after 401/403.
        if (httpStatus === 401 || httpStatus === 403 || target.auth !== 'gemini_query') {
          return { ...baseResult, ...lastFailure, probeSupported: true, httpStatus, latencyMs: Date.now() - startedAt };
        }
      } catch (error) {
        releaseProbeBody(error?.response);
        lastError = error;
        if (target.auth !== 'gemini_query') break;
      }
    }
    if (lastFailure) {
      return { ...baseResult, ...lastFailure, probeSupported: true, httpStatus: lastHttpStatus, latencyMs: Date.now() - startedAt };
    }
    if (lastError) throw lastError;
    return { ...baseResult, status: 'unreachable', active: null, probeSupported: true, httpStatus: null, latencyMs: Date.now() - startedAt, message: 'Не удалось связаться с провайдером' };
  } catch (error) {
    releaseProbeBody(error?.response);
    const failed = safeFailure(error);
    return { ...baseResult, ...failed, probeSupported: true, httpStatus: Number(error?.response?.status) || null, latencyMs: Date.now() - startedAt };
  }
}

async function persistProbeResult(result, db = dbDefault) {
  if (!result?.envName || !result?.status) return result;
  try {
    await db.query(
      `INSERT INTO admin_integration_key_probe_results
        (env_name, status, active, probe_supported, http_status, latency_ms, message, checked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (env_name) DO UPDATE SET
         status = EXCLUDED.status,
         active = EXCLUDED.active,
         probe_supported = EXCLUDED.probe_supported,
         http_status = EXCLUDED.http_status,
         latency_ms = EXCLUDED.latency_ms,
         message = EXCLUDED.message,
         checked_at = EXCLUDED.checked_at,
         updated_at = NOW()`,
      [
        result.envName,
        result.status,
        result.active ?? null,
        result.probeSupported === true,
        result.httpStatus ?? null,
        Number.isFinite(Number(result.latencyMs)) ? Math.max(0, Math.trunc(Number(result.latencyMs))) : null,
        String(result.message || '').slice(0, 500),
        result.checkedAt || new Date().toISOString(),
      ],
    );
  } catch (error) {
    // Observability must never make a key check or admin page fail.
    if (!/does not exist|relation .* does not exist/i.test(String(error.message || ''))) {
      console.warn('[AdminIntegrationKeys] probe metadata write skipped:', error.message);
    }
  }
  return result;
}

async function probeAndPersistIntegrationKey(envName, options = {}) {
  const result = await probeIntegrationKey(envName, options);
  return persistProbeResult(result, options.db || dbDefault);
}

async function clearProbeResult(envName, db = dbDefault) {
  try {
    const normalized = normalizeName(envName);
    await db.query('DELETE FROM admin_integration_key_probe_results WHERE env_name = $1', [normalized]);
  } catch (error) {
    if (!/does not exist|relation .* does not exist/i.test(String(error.message || ''))) {
      console.warn('[AdminIntegrationKeys] probe metadata clear skipped:', error.message);
    }
  }
}

async function listProbeResults(db = dbDefault) {
  try {
    const { rows } = await db.query(
      `SELECT env_name, status, active, probe_supported, http_status, latency_ms,
              message, checked_at
         FROM admin_integration_key_probe_results`,
    );
    return rows || [];
  } catch (error) {
    if (!/does not exist|relation .* does not exist/i.test(String(error.message || ''))) throw error;
    return [];
  }
}

async function probeAllIntegrationKeys(options = {}) {
  const items = await Promise.all(INTEGRATION_CATALOG.map((item) => probeAndPersistIntegrationKey(item.envName, options)));
  return { results: items, checkedAt: new Date().toISOString() };
}

module.exports = {
  probeIntegrationKey,
  probeAndPersistIntegrationKey,
  probeAllIntegrationKeys,
  persistProbeResult,
  clearProbeResult,
  listProbeResults,
  _internals: {
    endpointFor,
    safeFailure,
    releaseProbeBody,
    normalizeProbeProxy,
    resolveGeminiProbeProxyUrls,
  },
};
