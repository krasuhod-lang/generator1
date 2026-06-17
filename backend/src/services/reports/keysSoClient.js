'use strict';

/**
 * reports/keysSoClient.js — HTTP-клиент Keys.so (https://api.keys.so).
 *
 * Реализация по реальной OpenAPI-спецификации (см. /openapi.json в корне
 * репозитория и https://apidoc.keys.so/):
 *
 *   • Авторизация (любой из двух эквивалентных способов):
 *       — HTTP-заголовок:  X-Keyso-TOKEN: <token>     (используем этот)
 *       — query-параметр:  &auth-token=<token>
 *
 *   • Базовый URL:  https://api.keys.so   (без /v1, /v2 или /v3)
 *
 *   • Эндпоинт «Информация о домене (Дашборд)»:
 *       GET /report/simple/domain_dashboard?base=msk&domain=example.ru
 *     Ответ — плоский объект с полями:
 *       it1 / it3 / it5 / it10 / it50  — кол-во запросов в ТОП-1/3/5/10/50
 *       vis                            — оценка органического трафика (юзеры/день)
 *       dr, topvis, topkeys, ...
 *       history: { "YYYY.MM": { it1, it3, it10, it50, visAvg, ... } }
 *
 * Лимит API: 10 запросов / 10 секунд. На 429 сервер кладёт `Retry-After`
 * (в секундах) — мы делаем одну повторную попытку с задержкой `Retry-After`
 * либо 1.5s. На 5xx — одна повторная попытка.
 *
 * Принимаем оба имени переменной окружения: KEYS_SO_API_KEY (новое имя,
 * используется модулем reports) и KEYSSO_API_KEY (старое имя из forecaster) —
 * чтобы пользователь мог задать ключ один раз и он работал везде.
 */

const axios = (() => { try { return require('axios'); } catch (_) { return null; } })();

const BASE_URL = (process.env.KEYS_SO_BASE_URL || 'https://api.keys.so').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.KEYS_SO_TIMEOUT_MS, 10) || 20_000;
const DEFAULT_BASE = (process.env.KEYS_SO_DEFAULT_BASE || 'msk').toLowerCase();

// Полный список регионов баз keys.so (см. openapi.json schemas.base).
const VALID_BASES = new Set([
  'msk', 'gru', 'zen', 'gkv', 'rnd', 'ekb', 'ufa', 'sar', 'krr', 'prm',
  'sam', 'kry', 'oms', 'kzn', 'che', 'nsk', 'nnv', 'vlg', 'vrn', 'spb',
  'mns', 'tmn', 'gmns', 'tom', 'gny',
]);

/**
 * Маппинг Яндекс-база → Google-база.
 * Keys.so хранит отдельные базы для Яндекса и Google.
 * Если Google-базы для региона нет — вернём null.
 */
const YANDEX_TO_GOOGLE_BASE = {
  msk: 'gru',    // Москва
  spb: 'gru',    // СПб → ближайшая Google-база Москва
  rnd: 'gru',
  ekb: 'gru',
  ufa: 'gru',
  sar: 'gru',
  krr: 'gru',
  prm: 'gru',
  sam: 'gru',
  kry: 'gru',
  oms: 'gru',
  kzn: 'gru',
  che: 'gru',
  nsk: 'gru',
  nnv: 'gru',
  vlg: 'gru',
  vrn: 'gru',
  tmn: 'gru',
  tom: 'gru',
  mns: 'gmns',   // Минск
};

/** Возвращает Google-базу Keys.so для заданной Яндекс-базы (или null). */
function getGoogleBase(yandexBase) {
  const b = _normalizeBase(yandexBase);
  return YANDEX_TO_GOOGLE_BASE[b] || null;
}

class KeysSoError extends Error {
  constructor(message, code = 'keys_so_error', status = 502) {
    super(message);
    this.name = 'KeysSoError';
    this.code = code;
    this.status = status;
  }
}

function _apiKey() {
  // Совместимость: принимаем оба имени, чтобы пользователю не приходилось
  // дублировать переменную окружения.
  const k = process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY || '';
  if (!k) {
    throw new KeysSoError('KEYS_SO_API_KEY is not configured', 'no_api_key', 503);
  }
  return k;
}

function _normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') {
    throw new KeysSoError('Domain is required', 'bad_request', 400);
  }
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
}

function _normalizeBase(base) {
  const b = String(base || '').trim().toLowerCase();
  if (b && VALID_BASES.has(b)) return b;
  return DEFAULT_BASE;
}

function _retryAfterMs(err) {
  const ra = err?.response?.headers?.['retry-after'];
  const sec = Number(ra);
  if (Number.isFinite(sec) && sec > 0) return Math.min(60_000, sec * 1000);
  return 1500;
}

async function _defaultGet(url, { params, headers, timeout }) {
  if (axios) return axios.get(url, { params, headers, timeout });
  // Fallback на native fetch (Node ≥18). Возвращаем axios-совместимую форму
  // {data} + при ошибке — err.response.{status,data,headers}.
  const qs = params
    ? '?' + Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    : '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 20_000);
  try {
    const resp = await fetch(url + qs, { headers, signal: ctrl.signal });
    const text = await resp.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      const hdr = {};
      resp.headers.forEach((v, k) => { hdr[k.toLowerCase()] = v; });
      err.response = { status: resp.status, data, headers: hdr };
      throw err;
    }
    return { data };
  } finally {
    clearTimeout(t);
  }
}

async function _get(path, params, { httpClient } = {}) {
  const get = httpClient ? httpClient.get.bind(httpClient) : _defaultGet;
  const url = `${BASE_URL}${path}`;
  const headers = { 'X-Keyso-TOKEN': _apiKey(), Accept: 'application/json' };
  let attempt = 0;
  const maxAttempts = 2;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const { data } = await get(url, { params, headers, timeout: TIMEOUT_MS });
      return data;
    } catch (err) {
      const status = err?.response?.status;
      const transient = !status || status === 429 || (status >= 500 && status < 600);
      lastErr = err;
      if (!transient || attempt >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, _retryAfterMs(err)));
    }
  }
  const status = lastErr?.response?.status || 0;
  const body = lastErr?.response?.data;
  const msg = (body && (body.message || body.error)) || lastErr?.message || 'Keys.so request failed';
  // 401/402/404 имеет смысл прокидывать с реальным статусом, чтобы scheduler
  // и UI могли отличить «нет токена/нет тарифа/домен не найден» от «сеть упала».
  const code = status === 401 ? 'unauthorized'
    : status === 402 ? 'plan_restriction'
    : status === 404 ? 'not_found'
    : 'http_error';
  throw new KeysSoError(`Keys.so ${path} failed (${status || 'network'}): ${msg}`, code, status || 502);
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

/** "2026.03" → "2026-03-01"; "2026-03" → "2026-03-01"; иначе null. */
function _monthKeyToDate(key) {
  if (!key) return null;
  const m = String(key).match(/^(\d{4})[.\-](\d{1,2})$/);
  if (!m) return null;
  const yr = m[1];
  const mo = String(m[2]).padStart(2, '0');
  return `${yr}-${mo}-01`;
}

/**
 * Основной запрос: дашборд домена. Возвращает {overview, history[]}, где
 * history — массив помесячных снапшотов, отсортированных по возрастанию даты.
 *
 * @param {string} domain
 * @param {object} [opts]
 * @param {string} [opts.base]         регион базы keys.so (msk|spb|...).
 * @param {object} [opts.httpClient]   подмена axios для тестов.
 */
async function getDomainDashboard(domain, opts = {}) {
  const d = _normalizeDomain(domain);
  const base = _normalizeBase(opts.base);
  const raw = await _get('/report/simple/domain_dashboard', { base, domain: d }, opts);
  const node = raw && typeof raw === 'object' ? raw : {};

  const overview = {
    domain: d,
    base,
    visibility: _num(node.vis ?? node.visibility),
    yandex_traffic: null,            // отдельного поля «трафик из Яндекса» в API нет
    google_traffic: null,            // — оставляем null, чтобы агрегатор показал «—»
    keywords_top1: _int(node.it1),
    keywords_top3: _int(node.it3),
    keywords_top5: _int(node.it5),
    keywords_top10: _int(node.it10),
    keywords_top50: _int(node.it50),
    keywords_total: _int(node.it50),
    adcost: _num(node.adcost ?? node.adCost),
    pages_in_index: _int(node.pagesinindex ?? node.pagesInIndex),
    domain_rating: _int(node.dr),
    ad_traffic: _int(node.adtraf),
    ad_keywords: _int(node.adkeyscnt),
    fetched_at: new Date().toISOString(),
  };

  const histRaw = node.history && typeof node.history === 'object' ? node.history : {};
  const history = Object.entries(histRaw)
    .map(([k, v]) => {
      const date = _monthKeyToDate(k);
      if (!date || !v || typeof v !== 'object') return null;
      return {
        date,
        visibility: _num(v.visAvg ?? v.vis),
        yandex_traffic: null,
        google_traffic: null,
        keywords_top1: _int(v.it1),
        keywords_top3: _int(v.it3),
        keywords_top10: _int(v.it10),
        keywords_top50: _int(v.it50),
        keywords_total: _int(v.it50),
        adcost: _num(v.adcost ?? v.adCost),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  return { overview, history };
}

/** Совместимость со старым API модуля: вернуть только overview. */
async function getDomainOverview(domain, opts = {}) {
  const { overview } = await getDomainDashboard(domain, opts);
  return overview;
}

/**
 * Совместимость со старым API: вернуть массив помесячной истории за
 * последние `months` месяцев. Кейсы старше — отбрасываем.
 */
async function getDomainHistory(domain, months = 12, opts = {}) {
  const m = Math.max(1, Math.min(36, Math.round(Number(months) || 12)));
  const { history } = await getDomainDashboard(domain, opts);
  if (!history.length) return [];
  return history.slice(-m);
}

module.exports = {
  getDomainDashboard,
  getDomainOverview,
  getDomainHistory,
  getGoogleBase,
  KeysSoError,
  _normalizeDomain,
  _normalizeBase,
  _monthKeyToDate,
  VALID_BASES,
  YANDEX_TO_GOOGLE_BASE,
};
