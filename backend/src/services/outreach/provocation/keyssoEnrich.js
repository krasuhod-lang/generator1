'use strict';
/**
 * keyssoEnrich — обогащение домена данными keys.so для провокационного письма.
 * Общий модуль для КЕЙСОВ и КОНКУРЕНТОВ.
 *
 * По домену (+ город) отдаёт:
 *   • traffic_month   — оценка визитов/мес (из keys.so vis);
 *   • keywords_top10  — сколько запросов у домена в топ-10;
 *   • growth_pct      — рост видимости за доступный период, % (для «растёт»);
 *   • top_keywords    — [{phrase, volume, position}] — запросы в топ-10 с
 *                       частотностью «сколько ищут/мес». Это и есть пруф:
 *                       «запрос ищут N раз, сайт в топ-10 → забирает поток».
 *
 * ИЗОЛЯЦИЯ: новый модуль. Существующий код НЕ меняем.
 *   • домен-уровень — переиспуем экспортированный getDomainDashboard (read-only);
 *   • запросы домена — свой самодостаточный фетчер /report/simple/organic/keywords
 *     (эндпоинт и поля документированы в forecaster/keyssoClient.js и openapi.json).
 */

const {
  getDomainDashboard, getGoogleBase, _normalizeDomain, _normalizeBase,
} = require('../../reports/keysSoClient');

const BASE_URL = (process.env.KEYS_SO_BASE_URL || 'https://api.keys.so').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.KEYS_SO_TIMEOUT_MS, 10) || 20_000;
// vis в keys.so — оценка органического трафика (юзеры/день). В месяц ≈ ×30.
// Множитель вынесен в env для калибровки под реальные данные тарифа.
const VIS_TO_MONTH = Number(process.env.KEYSSO_VIS_TO_MONTH) || 30;

const axios = (() => { try { return require('axios'); } catch (_) { return null; } })();

/** Русский город → база региона keys.so (см. VALID_BASES в keysSoClient). */
const CITY_TO_BASE = {
  'Москва': 'msk', 'Санкт-Петербург': 'spb', 'Новосибирск': 'nsk',
  'Екатеринбург': 'ekb', 'Казань': 'kzn', 'Нижний Новгород': 'nnv',
  'Ростов-на-Дону': 'rnd', 'Уфа': 'ufa', 'Самара': 'sam', 'Пермь': 'prm',
  'Омск': 'oms', 'Челябинск': 'che', 'Воронеж': 'vrn', 'Волгоград': 'vlg',
  'Красноярск': 'kry', 'Тюмень': 'tmn', 'Краснодар': 'krr', 'Саратов': 'sar',
  'Томск': 'tom', 'Минск': 'mns',
};

const API_KEY = () => process.env.KEYS_SO_API_KEY || process.env.KEYSSO_API_KEY || '';

/** Город → база keys.so (msk по умолчанию). */
function resolveBase(city) {
  const c = String(city || '').trim();
  return CITY_TO_BASE[c] || (process.env.KEYS_SO_DEFAULT_BASE || 'msk').toLowerCase();
}

/** Минимальный GET JSON (axios или native fetch), возвращает распарсенный объект. */
async function _getJson(url, headers) {
  if (axios) {
    const { data } = await axios.get(url, { headers, timeout: TIMEOUT_MS });
    return data;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Тянет топ-запросы домена (по позиции) с частотностью.
 * @returns {Promise<Array<{phrase:string, volume:number, position:number}>>}
 */
async function fetchDomainKeywords(domain, { base, perPage = 100 } = {}) {
  const key = API_KEY();
  if (!key) return [];
  const dom = _normalizeDomain(domain);
  const b = _normalizeBase(base);
  const qs = new URLSearchParams({
    base: b, domain: dom, page: '1', per_page: String(perPage), sort: 'pos|asc',
  }).toString();
  const url = `${BASE_URL}/report/simple/organic/keywords?${qs}`;
  const headers = { 'X-Keyso-TOKEN': key, Accept: 'application/json' };

  let json;
  try {
    json = await _getJson(url, headers);
  } catch (err) {
    console.warn(`[keyssoEnrich] keywords ${dom}@${b} failed: ${err.message}`);
    return [];
  }

  const arr = Array.isArray(json && json.data) ? json.data : [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const phrase = String(it.word ?? it.keyword ?? it.kw ?? it.phrase ?? '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const posRaw = Number(it.pos ?? it.position ?? 0);
    const position = Number.isFinite(posRaw) && posRaw > 0 ? Math.round(posRaw) : 0;
    // wsk — «!очень !точная» частотность (предпочтительнее), ws — базовая.
    const volRaw = Number(it.wsk ?? it.ws ?? it.frequency ?? it.freq ?? 0);
    const volume = Number.isFinite(volRaw) && volRaw > 0 ? Math.round(volRaw) : 0;
    out.push({ phrase, volume, position });
  }
  return out;
}

/**
 * Выбирает лучшие запросы для пруфа: в топ-10, с наибольшей частотностью,
 * без дублей, ограничение по count.
 */
function pickProofKeywords(keywords, count = 3) {
  return (keywords || [])
    .filter((k) => k.position > 0 && k.position <= 10 && k.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, count);
}

/** Рост видимости по истории: (last-first)/first*100. null если мало точек. */
function _growthPct(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const vals = history.map((h) => Number(h.visibility)).filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 2) return null;
  const first = vals[0];
  const last = vals[vals.length - 1];
  if (first <= 0) return null;
  return Math.round(((last - first) / first) * 100);
}

/**
 * Полное обогащение домена под письмо.
 * @param {string} domain
 * @param {object} [opts]
 * @param {string} [opts.city]      — русский город (для базы региона)
 * @param {string} [opts.engine]    — 'yandex' | 'google'
 * @param {number} [opts.proofCount]— сколько запросов-пруфов вернуть (по умолч. 3)
 * @returns {Promise<null | {
 *   domain:string, base:string, traffic_month:number, keywords_top10:number,
 *   growth_pct:number|null, growing:boolean, top_keywords:Array
 * }>}
 */
async function enrichDomain(domain, opts = {}) {
  const { city, engine = 'yandex', proofCount = 3 } = opts;
  if (!API_KEY()) return null;

  const yBase = resolveBase(city);
  const base = engine === 'google' ? (getGoogleBase(yBase) || yBase) : yBase;

  let dashboard = null;
  try {
    dashboard = await getDomainDashboard(domain, { base });
  } catch (err) {
    console.warn(`[keyssoEnrich] dashboard ${domain}@${base} failed: ${err.message}`);
    return null;
  }
  const overview = dashboard.overview || {};
  const vis = Number(overview.visibility) || 0;
  const trafficMonth = Math.round(vis * VIS_TO_MONTH);
  const growthPct = _growthPct(dashboard.history);

  const keywords = await fetchDomainKeywords(domain, { base });
  const topKeywords = pickProofKeywords(keywords, proofCount);

  return {
    domain: _normalizeDomain(domain),
    base,
    traffic_month: trafficMonth,
    keywords_top10: Number(overview.keywords_top10) || 0,
    growth_pct: growthPct,
    growing: growthPct != null ? growthPct > 5 : (Number(overview.keywords_top10) || 0) > 0,
    top_keywords: topKeywords,
  };
}

module.exports = {
  enrichDomain,
  fetchDomainKeywords,
  pickProofKeywords,
  resolveBase,
  CITY_TO_BASE,
  _growthPct,
};
