'use strict';

/**
 * trendsCollector — сборщик сигналов Google Trends для M-1 Topic Discovery.
 *
 * Отдаёт компактный `trends_data`, который M-1 (gist_py) превращает в
 * demand/supply-сигналы:
 *   {
 *     keyword,
 *     demand_signal: 0..100,   // средний интерес за период (interest over time)
 *     trend_slope:   -1..1,    // рост/падение (последняя треть vs первая треть)
 *     rising_queries: string[],// related rising queries (сигнал «лакуны»)
 *     top_queries:   string[],
 *     collected_at:  ISO
 *   }
 *
 * Устойчивость (ТЗ §1.2):
 *   • Кэш — файловый, TTL 24 часа (Trends агрессивно банит по IP).
 *   • Rate-limit — не чаще 1 запроса в 5 секунд (глобально по процессу).
 *   • Fail-open — при любой ошибке/недоступности возвращает `null`; M-1 уже
 *     корректно обрабатывает отсутствие сигналов через manual_review: true.
 *
 * Основной путь — npm-библиотека `google-trends-api` (interest over time за
 * 12 месяцев + related queries). Библиотека необязательна: если она не
 * установлена, коллектор мягко деградирует до `null` (fail-open), не роняя
 * пайплайн. Для тестов доступен инъектируемый `fetcher`.
 *
 * ENV:
 *   TOPIC_TRENDS_ENABLED       — включение (default: on)
 *   TOPIC_TRENDS_CACHE_DIR     — каталог файлового кэша
 *   TOPIC_TRENDS_CACHE_TTL_MS  — TTL кэша (default: 86400000 = 24ч)
 *   TOPIC_TRENDS_MIN_INTERVAL_MS — минимальный интервал между запросами (default: 5000)
 *   TOPIC_TRENDS_GEO           — гео (default: '' — worldwide; для RU: 'RU')
 *   TOPIC_TRENDS_TIMEZONE      — смещение в минутах (default: 0)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MIN_INTERVAL_MS = 5000; // 1 req / 5s

function _bool(v, dflt) {
  if (v == null) return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

function _num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function _cfg() {
  return {
    enabled: _bool(process.env.TOPIC_TRENDS_ENABLED, true),
    cacheDir: process.env.TOPIC_TRENDS_CACHE_DIR
      || path.join(os.tmpdir(), 'topic-trends-cache'),
    ttlMs: _num(process.env.TOPIC_TRENDS_CACHE_TTL_MS, DEFAULT_TTL_MS),
    minIntervalMs: _num(process.env.TOPIC_TRENDS_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS),
    geo: process.env.TOPIC_TRENDS_GEO || '',
    tz: _num(process.env.TOPIC_TRENDS_TIMEZONE, 0),
  };
}

function _cacheKey(keyword, geo) {
  return crypto.createHash('sha1')
    .update(`${String(keyword).toLowerCase().trim()}|${geo || ''}`)
    .digest('hex');
}

function _readCache(cacheDir, key, ttlMs, now) {
  try {
    const file = path.join(cacheDir, `${key}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.saved_at !== 'number') return null;
    if (now - parsed.saved_at > ttlMs) return null; // истёк
    return parsed.data || null;
  } catch (_e) {
    return null;
  }
}

function _writeCache(cacheDir, key, data, now) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `${key}.json`);
    fs.writeFileSync(file, JSON.stringify({ saved_at: now, data }), 'utf8');
  } catch (_e) {
    /* кэш необязателен — молча игнорируем ошибки записи */
  }
}

// Глобальный (по процессу) rate-limiter: не чаще 1 запроса в minIntervalMs.
let _lastFetchAt = 0;
function _rateLimitOk(minIntervalMs, now) {
  if (now - _lastFetchAt < minIntervalMs) return false;
  return true;
}

/**
 * Дефолтный fetcher поверх `google-trends-api`. Возвращает сырьё
 * { interestOverTime, relatedQueries } либо бросает исключение.
 * Если библиотека не установлена — бросает, коллектор ловит и возвращает null.
 */
async function _defaultFetcher(keyword, { geo, tz }) {
  // Загружаем лениво и мягко: отсутствие библиотеки не должно ломать require().
  // eslint-disable-next-line global-require, import/no-unresolved
  const googleTrends = require('google-trends-api');
  const startTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 12 месяцев
  const opts = { keyword, geo: geo || undefined, startTime, timezone: tz };
  const [iotRaw, relRaw] = await Promise.all([
    googleTrends.interestOverTime(opts),
    googleTrends.relatedQueries(opts).catch(() => null),
  ]);
  return {
    interestOverTime: iotRaw ? JSON.parse(iotRaw) : null,
    relatedQueries: relRaw ? JSON.parse(relRaw) : null,
  };
}

function _clamp01to100(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

/**
 * Превращает сырой ответ google-trends-api в компактный demand-сигнал.
 */
function _normalize(keyword, raw, now) {
  const timeline = raw
    && raw.interestOverTime
    && raw.interestOverTime.default
    && Array.isArray(raw.interestOverTime.default.timelineData)
    ? raw.interestOverTime.default.timelineData
    : [];

  const values = timeline
    .map((pt) => (pt && Array.isArray(pt.value) ? Number(pt.value[0]) : NaN))
    .filter((v) => Number.isFinite(v));

  let demandSignal = null;
  let trendSlope = null;
  if (values.length) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    demandSignal = _clamp01to100(avg);
    if (values.length >= 3) {
      const third = Math.max(1, Math.floor(values.length / 3));
      const firstAvg = values.slice(0, third).reduce((a, b) => a + b, 0) / third;
      const lastAvg = values.slice(-third).reduce((a, b) => a + b, 0) / third;
      const denom = Math.max(1, firstAvg + lastAvg);
      trendSlope = Math.max(-1, Math.min(1, (lastAvg - firstAvg) / denom));
    }
  }

  const rankedList = raw
    && raw.relatedQueries
    && raw.relatedQueries.default
    && Array.isArray(raw.relatedQueries.default.rankedList)
    ? raw.relatedQueries.default.rankedList
    : [];
  const pickQueries = (idx) => {
    const bucket = rankedList[idx] && Array.isArray(rankedList[idx].rankedKeyword)
      ? rankedList[idx].rankedKeyword
      : [];
    return bucket
      .map((k) => (k && typeof k.query === 'string' ? k.query.trim() : ''))
      .filter(Boolean)
      .slice(0, 10);
  };
  // rankedList[0] — top, rankedList[1] — rising (по контракту google-trends-api).
  const topQueries = pickQueries(0);
  const risingQueries = pickQueries(1);

  if (demandSignal == null && !topQueries.length && !risingQueries.length) {
    return null; // нет полезных сигналов — fail-open
  }

  return {
    keyword: String(keyword),
    demand_signal: demandSignal,
    trend_slope: trendSlope,
    rising_queries: risingQueries,
    top_queries: topQueries,
    collected_at: new Date(now).toISOString(),
  };
}

/**
 * collectTrends — основной вход. Возвращает `trends_data` или `null`.
 *
 * @param {string} keyword — ключевой запрос
 * @param {object} [opts]
 * @param {function} [opts.fetcher] — инъекция для тестов: async (keyword, {geo,tz}) => raw
 * @param {function} [opts.log] — лог-callback
 * @param {number}   [opts.now] — инъекция времени (тесты)
 * @param {object}   [opts.overrides] — переопределение _cfg (тесты)
 * @returns {Promise<object|null>}
 */
async function collectTrends(keyword, opts = {}) {
  const cfg = { ..._cfg(), ...(opts.overrides || {}) };
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  if (!keyword || !String(keyword).trim()) return null;
  if (!cfg.enabled) return null;

  const key = _cacheKey(keyword, cfg.geo);

  // 1) Кэш.
  const cached = _readCache(cfg.cacheDir, key, cfg.ttlMs, now);
  if (cached) {
    log(`[trends] cache hit: ${keyword}`);
    return cached;
  }

  // 2) Rate-limit — если рано, отдаём null (fail-open), не блокируя пайплайн.
  if (!_rateLimitOk(cfg.minIntervalMs, now)) {
    log(`[trends] rate-limited: ${keyword}`);
    return null;
  }

  // 3) Сеть.
  const fetcher = typeof opts.fetcher === 'function' ? opts.fetcher : _defaultFetcher;
  _lastFetchAt = now;
  try {
    const raw = await fetcher(keyword, { geo: cfg.geo, tz: cfg.tz });
    const data = _normalize(keyword, raw, now);
    if (data) {
      _writeCache(cfg.cacheDir, key, data, now);
      log(`[trends] collected: ${keyword}`);
    }
    return data;
  } catch (err) {
    log(`[trends] fail-open (${err && err.message ? err.message : err}): ${keyword}`);
    return null;
  }
}

// Сброс rate-limiter — только для тестов.
function _resetRateLimit() {
  _lastFetchAt = 0;
}

module.exports = {
  collectTrends,
  _internal: {
    _normalize, _cacheKey, _readCache, _writeCache, _resetRateLimit, _rateLimitOk,
  },
};
