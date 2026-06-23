'use strict';

/**
 * reports/modules/techAudit.js — лёгкий технический аудит страниц (ТЗ §3.2
 * tech_audit_results). Считает по странице:
 *   total_images, images_no_alt, images_no_title, images_non_webp,
 *   page_size_kb, http_status.
 *
 * Парсинг — cheerio (уже в зависимостях), загрузка — axios. Чистая функция
 * auditHtml() тестируется без сети (см. test-report-modules.js); auditUrl()
 * добавляет сетевой слой и устойчива к ошибкам (возвращает http_status/ошибку).
 */

const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 20_000;
const WEBP_RE = /\.webp(\?|#|$)/i;
const USER_AGENT = 'Mozilla/5.0 (compatible; SEOGeniusBot/1.0; +https://seogenius)';

function _round(n, p = 3) { const f = 10 ** p; return Math.round((Number(n) || 0) * f) / f; }

function _isWebp(src) {
  const s = String(src || '').trim();
  if (!s) return false;
  if (WEBP_RE.test(s)) return true;
  // data:image/webp;base64,...
  return /^data:image\/webp/i.test(s);
}

/**
 * Чистый аудит HTML-строки.
 * @param {string} html
 * @param {object} opts {url, httpStatus, bytes}
 */
function auditHtml(html, opts = {}) {
  const $ = cheerio.load(String(html || ''));
  const images = $('img');
  let totalImages = 0;
  let noAlt = 0;
  let noTitle = 0;
  let nonWebp = 0;

  images.each((_i, el) => {
    totalImages += 1;
    const $el = $(el);
    const alt = ($el.attr('alt') || '').trim();
    const title = ($el.attr('title') || '').trim();
    const src = $el.attr('src') || $el.attr('data-src') || $el.attr('srcset') || '';
    if (!alt) noAlt += 1;
    if (!title) noTitle += 1;
    if (!_isWebp(src)) nonWebp += 1;
  });

  const bytes = Number.isFinite(opts.bytes) ? opts.bytes : Buffer.byteLength(String(html || ''), 'utf8');
  const pageSizeKb = Math.round(bytes / 1024);

  return {
    url: opts.url || null,
    http_status: opts.httpStatus != null ? Number(opts.httpStatus) : null,
    total_images: totalImages,
    images_no_alt: noAlt,
    images_no_title: noTitle,
    images_non_webp: nonWebp,
    images_no_alt_ratio: totalImages > 0 ? _round(noAlt / totalImages, 3) : 0,
    webp_ratio: totalImages > 0 ? _round((totalImages - nonWebp) / totalImages, 3) : null,
    page_size_kb: pageSizeKb,
    audited_at: new Date().toISOString(),
  };
}

/** Загрузить и проаудитировать один URL. Никогда не бросает. */
async function auditUrl(url, opts = {}) {
  const timeout = Number(opts.timeout) || DEFAULT_TIMEOUT_MS;
  try {
    const res = await axios.get(url, {
      timeout,
      responseType: 'text',
      maxRedirects: 5,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      validateStatus: () => true,
    });
    const body = typeof res.data === 'string' ? res.data : String(res.data || '');
    return auditHtml(body, {
      url,
      httpStatus: res.status,
      bytes: Buffer.byteLength(body, 'utf8'),
    });
  } catch (err) {
    return {
      url,
      http_status: err?.response?.status || null,
      error: err?.message || 'fetch_failed',
      total_images: 0,
      images_no_alt: 0,
      images_no_title: 0,
      images_non_webp: 0,
      images_no_alt_ratio: 0,
      webp_ratio: null,
      page_size_kb: 0,
      audited_at: new Date().toISOString(),
    };
  }
}

/** Свод по набору результатов аудита для модуля Tech Audit отчёта. */
function summarizeTechAudit(results) {
  const items = (Array.isArray(results) ? results : []).filter(Boolean);
  const summary = {
    pages: items.length,
    total_images: 0,
    images_no_alt: 0,
    images_non_webp: 0,
    broken: 0,
    avg_page_size_kb: 0,
  };
  let sizeSum = 0;
  for (const it of items) {
    summary.total_images += Number(it.total_images) || 0;
    summary.images_no_alt += Number(it.images_no_alt) || 0;
    summary.images_non_webp += Number(it.images_non_webp) || 0;
    if (it.http_status && Number(it.http_status) >= 400) summary.broken += 1;
    sizeSum += Number(it.page_size_kb) || 0;
  }
  summary.avg_page_size_kb = items.length ? Math.round(sizeSum / items.length) : 0;
  summary.images_no_alt_ratio = summary.total_images > 0
    ? _round(summary.images_no_alt / summary.total_images, 3) : 0;
  return { items, summary };
}

module.exports = { auditHtml, auditUrl, summarizeTechAudit };
