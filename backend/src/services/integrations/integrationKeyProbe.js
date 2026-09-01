'use strict';

const axios = require('axios');
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
      const url = `${base('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/models')}?key=${encodeURIComponent('probe')}`;
      return { method: 'get', url, auth: 'gemini_query' };
    }
    case 'XAI_API_KEY':
      return { method: 'get', url: `${base('XAI_BASE_URL', 'https://api.x.ai/v1')}/models`, auth: 'bearer' };
    case 'DASHSCOPE_API_KEY':
      return { method: 'get', url: `${base('DASHSCOPE_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')}/models`, auth: 'bearer' };
    case 'RESEND_API_KEY':
      return { method: 'get', url: 'https://api.resend.com/api-keys', auth: 'bearer' };
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
  if (status >= 400 && status < 500) return { status: 'rejected', active: null, message: 'Провайдер отклонил health-запрос' };
  if (status >= 500) return { status: 'unreachable', active: null, message: 'Провайдер временно недоступен' };
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
    return { status: 'timeout', active: null, message: 'Health-проверка превысила 10 секунд' };
  }
  return { status: 'unreachable', active: null, message: 'Не удалось связаться с провайдером' };
}

async function probeIntegrationKey(envName, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalized = normalizeName(envName);
  const catalogItem = INTEGRATION_CATALOG.find((item) => item.envName === normalized) || { envName: normalized };
  const info = await getIntegrationSecretInfo(normalized);
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
    if (target.auth === 'bearer') headers.Authorization = `Bearer ${info.value}`;
    if (target.auth === 'gemini_query') {
      delete target.url;
      target.url = `${String(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/+$/, '')}?key=${encodeURIComponent(info.value)}`;
    }
    if (target.auth === 'query_serpapi') params.api_key = info.value;
    const response = await axios({
      method: target.method,
      url: target.url,
      headers,
      params,
      timeout: Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), 15000),
      validateStatus: () => true,
      maxContentLength: 1024,
      maxBodyLength: 1024,
    });
    const httpStatus = Number(response.status) || null;
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ...baseResult, status: 'active', active: true, probeSupported: true, httpStatus, latencyMs: Date.now() - startedAt, message: 'Ключ принят провайдером' };
    }
    const failed = safeFailure({ response: { status: httpStatus } });
    return { ...baseResult, ...failed, probeSupported: true, httpStatus, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const failed = safeFailure(error);
    return { ...baseResult, ...failed, probeSupported: true, httpStatus: Number(error?.response?.status) || null, latencyMs: Date.now() - startedAt };
  }
}

async function probeAllIntegrationKeys() {
  const items = await Promise.all(INTEGRATION_CATALOG.map((item) => probeIntegrationKey(item.envName)));
  return { results: items, checkedAt: new Date().toISOString() };
}

module.exports = {
  probeIntegrationKey,
  probeAllIntegrationKeys,
  _internals: { endpointFor, safeFailure },
};
