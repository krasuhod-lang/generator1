'use strict';

/**
 * projects/serpVerifier.js — верификация каннибализации по РЕАЛЬНОЙ топ-выдаче
 * Google (через xmlstock).
 *
 * Детектор каннибализации в commercialIntent.js работает по данным Google
 * Search Console и лишь сигнализирует о подозрении (один коммерческий запрос
 * делят несколько URL сайта, ни один не в топ-3). Прежде чем рекомендовать
 * склейку/канонизацию разделов, мы снимаем реальную выдачу Google по запросу и
 * проверяем, действительно ли несколько страниц сайта конкурируют в топе —
 * только тогда слияние оправдано.
 *
 * Всё graceful: при недоступности xmlstock/пустой выдаче вердикт —
 * 'inconclusive', основной анализ продолжается без потерь.
 *
 * Вердикты:
 *   • merge_recommended — ≥ minPagesInTop страниц сайта стоят в топе Google и
 *     ни одна не в топ-3 → конкуренция своих URL подтверждена, склейка/каноникал
 *     оправданы.
 *   • keep_separate     — в топе Google ≤ 1 страницы сайта (Google сам выбрал
 *     одну) либо есть явный лидер в топ-3 → физическое слияние не требуется.
 *   • inconclusive      — выдачу снять не удалось (сеть/лимиты/пустой SERP).
 */

const { fetchGoogleSerp } = require('../metaTags/xmlstockClient');
const { getProjectsConfig } = require('./config');

// ── In-memory LRU + TTL cache (одна выдача переиспользуется между кейсами) ──
const _cache = new Map(); // key → { value, expiresAt }

function _cacheGet(key, ttlMs) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { _cache.delete(key); return null; }
  _cache.delete(key);
  _cache.set(key, hit); // move-to-head (LRU)
  void ttlMs;
  return hit.value;
}

function _cacheSet(key, value, ttlMs, maxEntries) {
  if (_cache.size >= maxEntries) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function _cacheClear() { _cache.clear(); }

// ── URL-нормализация / сопоставление ──────────────────────────────────

function _normParts(rawUrl) {
  if (!rawUrl) return null;
  try {
    const s = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = (u.pathname || '/').toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, ''); // без хвостового слэша
    return { host, path };
  } catch (_) {
    return null;
  }
}

function _sameUrl(a, b) {
  const x = _normParts(a);
  const y = _normParts(b);
  if (!x || !y) return false;
  return x.host === y.host && x.path === y.path;
}

/**
 * Дедупит SERP по нормализованному URL (хост-дубликаты СОХРАНЯЕМ — для
 * каннибализации важно видеть несколько страниц одного сайта) и возвращает
 * список {url, host, path, position} в порядке выдачи.
 */
function _rankedSerp(serpRaw) {
  const seen = new Set();
  const out = [];
  for (const item of (Array.isArray(serpRaw) ? serpRaw : [])) {
    const url = String((item && item.url) || '').trim();
    const parts = _normParts(url);
    if (!parts) continue;
    const id = `${parts.host}${parts.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ url, host: parts.host, path: parts.path, position: out.length + 1 });
  }
  return out;
}

/**
 * Строит вердикт по одному кейсу каннибализации на основе снятой выдачи.
 * @returns {{verdict, recommendation, site_pages_in_top, best_position, checked:boolean}}
 */
function _buildVerdict(candidate, ranked, cfg) {
  const pages = Array.isArray(candidate.pages) ? candidate.pages : [];
  const matched = [];
  for (const p of pages) {
    const pageUrl = p && (p.page || p.url || p);
    const hit = ranked.find((r) => _sameUrl(r.url, pageUrl));
    if (hit) matched.push({ page: pageUrl, position: hit.position });
  }
  matched.sort((a, b) => a.position - b.position);

  const minPages = cfg.minPagesInTop || 2;
  const inTopCount = matched.length;
  const bestPosition = inTopCount ? matched[0].position : null;

  let verdict;
  let recommendation;
  if (inTopCount >= minPages && (bestPosition == null || bestPosition > 3)) {
    verdict = 'merge_recommended';
    recommendation = `В топ-${ranked.length} Google по запросу «${candidate.query}» `
      + `найдено ${inTopCount} страниц сайта (лучшая позиция ${bestPosition}). `
      + 'Каннибализация подтверждена — склейте/канонизируйте страницы или '
      + 'консолидируйте контент на одной посадочной.';
  } else if (inTopCount >= minPages) {
    // Несколько страниц в топе, но одна уже в топ-3 — есть явный лидер.
    verdict = 'keep_separate';
    recommendation = `В топе Google уже есть лидер (позиция ${bestPosition}). `
      + 'Физическое слияние не требуется — усильте лидера и закрепите каноникал, '
      + 'остальные страницы перелинкуйте на него.';
  } else {
    verdict = 'keep_separate';
    recommendation = inTopCount === 0
      ? 'В топе Google нет страниц сайта по этому запросу — каннибализация в '
        + 'выдаче не подтверждается; работайте над релевантностью, а не слиянием.'
      : 'В топе Google стоит лишь одна страница сайта — Google сам выбрал '
        + 'релевантную; слияние не требуется.';
  }

  return {
    verdict,
    recommendation,
    site_pages_in_top: matched,
    site_pages_in_top_count: inTopCount,
    best_position: bestPosition,
    checked: true,
  };
}

/**
 * Проверяет кейсы каннибализации по топ-выдаче Google.
 *
 * @param {Object} params
 *   candidates  Array<{query, pages:[{page}|string], ...}>  (из commercial.cannibalization)
 *   region/domain/device  переопределяют конфиг (опционально)
 *   fetchSerp   функция выборки SERP (по умолчанию fetchGoogleSerp) — инъекция для тестов
 *   logger      (msg, level) — опционально
 * @returns {Promise<{available, engine, checked_count, items:[...], warnings:[]}>}
 */
async function verifyCannibalization(params = {}) {
  const cfg = getProjectsConfig().serpVerification;
  const out = {
    available: false,
    engine: cfg.engine,
    checked_count: 0,
    items: [],
    warnings: [],
  };
  if (!cfg.enabled) { out.warnings.push('serp_verification_disabled'); return out; }

  const candidates = Array.isArray(params.candidates) ? params.candidates : [];
  if (candidates.length === 0) return out;

  const fetchSerp = typeof params.fetchSerp === 'function' ? params.fetchSerp : fetchGoogleSerp;
  const log = typeof params.logger === 'function' ? params.logger : () => {};
  const region = params.region != null ? params.region : cfg.region;
  const domain = params.domain != null ? params.domain : cfg.domain;
  const device = params.device != null ? params.device : cfg.device;

  const limited = candidates.slice(0, cfg.maxCandidates);
  for (const candidate of limited) {
    const query = String((candidate && candidate.query) || '').trim();
    if (!query) continue;
    const cacheKey = JSON.stringify({ q: query.toLowerCase(), e: cfg.engine, r: region, d: domain, v: device });

    let ranked = _cacheGet(cacheKey, cfg.cacheTtlMs);
    if (!ranked) {
      try {
        const serpRaw = await fetchSerp(query, {
          pages: cfg.pages, lr: region, domain, device,
        });
        ranked = _rankedSerp(serpRaw).slice(0, cfg.topResults);
        _cacheSet(cacheKey, ranked, cfg.cacheTtlMs, cfg.cacheMaxEntries);
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        out.warnings.push(`serp_failed:${query.slice(0, 40)}:${msg.slice(0, 80)}`);
        log(`⚠ SERP-верификация: не сняли выдачу по «${query}» (${msg})`, 'warn');
        out.items.push({
          query,
          verdict: 'inconclusive',
          recommendation: 'Не удалось снять топ Google (сеть/лимиты ключа xmlstock) — '
            + 'решение о слиянии принимайте по данным GSC.',
          site_pages_in_top: [],
          site_pages_in_top_count: 0,
          best_position: null,
          checked: false,
        });
        continue;
      }
    }

    const verdict = _buildVerdict(candidate, ranked, cfg);
    out.checked_count += 1;
    out.items.push({ query, intent: candidate.intent, ...verdict });
  }

  out.available = out.items.length > 0;
  return out;
}

module.exports = {
  verifyCannibalization,
  _rankedSerp,
  _buildVerdict,
  _sameUrl,
  _cacheClear,
};
