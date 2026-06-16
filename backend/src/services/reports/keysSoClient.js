'use strict';

/**
 * reports/keysSoClient.js — HTTP-клиент Keys.so (https://api.keys.so/v3).
 *
 * Только две операции, нужные модулю Reports:
 *   • getDomainOverview(domain) — текущий «срез» (видимость, трафик, ТОПы).
 *   • getDomainHistory(domain, months) — помесячная история за N месяцев.
 *
 * Авторизация: API-ключ в заголовке `key` (см. документацию Keys.so).
 * Ключ берётся из ENV KEYS_SO_API_KEY (без него клиент бросит ошибку).
 *
 * Ретраи: одна повторная попытка с задержкой 1.5с при HTTP 429/5xx, чтобы
 * не валить ночной CRON из-за одного транзиентного 5xx.
 */

const axios = require('axios');

const BASE_URL = process.env.KEYS_SO_BASE_URL || 'https://api.keys.so/v3';
const TIMEOUT_MS = parseInt(process.env.KEYS_SO_TIMEOUT_MS, 10) || 15_000;

class KeysSoError extends Error {
  constructor(message, code = 'keys_so_error', status = 502) {
    super(message);
    this.name = 'KeysSoError';
    this.code = code;
    this.status = status;
  }
}

function _apiKey() {
  const k = process.env.KEYS_SO_API_KEY || '';
  if (!k) {
    throw new KeysSoError('KEYS_SO_API_KEY is not configured', 'no_api_key', 503);
  }
  return k;
}

function _normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') {
    throw new KeysSoError('Domain is required', 'bad_request', 400);
  }
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

async function _get(path, params, { httpClient } = {}) {
  const client = httpClient || axios;
  const url = `${BASE_URL}${path}`;
  const headers = { key: _apiKey() };
  let attempt = 0;
  const maxAttempts = 2;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const { data } = await client.get(url, { params, headers, timeout: TIMEOUT_MS });
      return data;
    } catch (err) {
      const status = err?.response?.status;
      const transient = !status || status === 429 || (status >= 500 && status < 600);
      lastErr = err;
      if (!transient || attempt >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const status = lastErr?.response?.status || 0;
  const msg = lastErr?.response?.data?.message || lastErr?.message || 'Keys.so request failed';
  throw new KeysSoError(`Keys.so ${path} failed: ${msg}`, 'http_error', status || 502);
}

/**
 * Текущий overview. Тонкая нормализация — приводим поля к контракту,
 * который ждёт reports/keysSoSync.js.
 */
async function getDomainOverview(domain, opts = {}) {
  const d = _normalizeDomain(domain);
  const raw = await _get('/domain/overview', { domain: d }, opts);
  const node = raw?.data || raw || {};
  return {
    domain: d,
    visibility: _num(node.visibility ?? node.visibility_index),
    yandex_traffic: _int(node.yandex_traffic ?? node.traffic_yandex),
    google_traffic: _int(node.google_traffic ?? node.traffic_google),
    keywords_top1: _int(node.keywords_top1 ?? node.top1),
    keywords_top3: _int(node.keywords_top3 ?? node.top3),
    keywords_top10: _int(node.keywords_top10 ?? node.top10),
    keywords_total: _int(node.keywords_total ?? node.total_keywords),
    fetched_at: new Date().toISOString(),
  };
}

/**
 * История по месяцам. Возвращает массив снапшотов:
 *   [{date:'2026-01-01', visibility, yandex_traffic, google_traffic, top1/3/10/total}, ...]
 */
async function getDomainHistory(domain, months = 12, opts = {}) {
  const d = _normalizeDomain(domain);
  const m = Math.max(1, Math.min(36, Math.round(Number(months) || 12)));
  const raw = await _get('/domain/history', { domain: d, months: m }, opts);
  const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.history) ? raw.history : [];
  return items
    .map((row) => {
      const dt = String(row.date || row.month || '').slice(0, 10);
      const monthFirst = dt.length >= 7 ? `${dt.slice(0, 7)}-01` : null;
      if (!monthFirst) return null;
      return {
        date: monthFirst,
        visibility: _num(row.visibility ?? row.visibility_index),
        yandex_traffic: _int(row.yandex_traffic ?? row.traffic_yandex),
        google_traffic: _int(row.google_traffic ?? row.traffic_google),
        keywords_top1: _int(row.keywords_top1 ?? row.top1),
        keywords_top3: _int(row.keywords_top3 ?? row.top3),
        keywords_top10: _int(row.keywords_top10 ?? row.top10),
        keywords_total: _int(row.keywords_total ?? row.total_keywords),
      };
    })
    .filter(Boolean);
}

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _int(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  getDomainOverview,
  getDomainHistory,
  KeysSoError,
  _normalizeDomain,
};
