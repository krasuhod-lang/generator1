'use strict';

/**
 * excelParser — server-side validator/normalizer для commercial_links.
 *
 * Ввод XLSX уже распарсен на фронте (через `read-excel-file`) и приходит как
 * JSON-массив `[{ url, h1 }]`. Функция:
 *   - удаляет пустые строки;
 *   - нормализует URL (trim, lowercase host, удаление trailing slash, валидация http/https);
 *   - дедупит по нормализованному URL (последняя запись побеждает по h1);
 *   - обрезает h1 до разумной длины;
 *   - режет массив до limit (по умолчанию INFO_ARTICLE_MAX_COMMERCIAL_LINKS=200).
 *
 * Возвращает { links, dropped, errors }.
 */

const MAX_H1_LEN = 300;
const DEFAULT_LIMIT = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MAX_COMMERCIAL_LINKS, 10);
  return Number.isFinite(v) && v >= 1 && v <= 1000 ? v : 200;
})();

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  // Префикс https:// если пользователь забыл (часто бывает в excel'е).
  if (!/^https?:\/\//i.test(trimmed) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Нормализуем: lower-case host, удаляем trailing slash в пути (но не для корня).
    u.hostname = u.hostname.toLowerCase();
    let pathname = u.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = pathname;
    return u.toString();
  } catch (_) {
    return null;
  }
}

function normalizeH1(value) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > MAX_H1_LEN ? s.slice(0, MAX_H1_LEN) : s;
}

/**
 * @param {Array<{url:string, h1:string}>} rows
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {{ links: Array<{url, h1}>, dropped: number, errors: string[] }}
 */
function normalizeCommercialLinks(rows, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const errors = [];
  if (!Array.isArray(rows)) {
    return { links: [], dropped: 0, errors: ['commercial_links должен быть массивом'] };
  }

  const seen = new Map(); // normalizedUrl → { url, h1 }
  let dropped = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const url = isValidHttpUrl(r.url ?? r.URL ?? r.link ?? r.Link);
    const h1  = normalizeH1(r.h1 ?? r.H1 ?? r.title ?? r.name ?? r.anchor);
    if (!url) {
      dropped += 1;
      if (errors.length < 10) errors.push(`row ${i + 1}: некорректный URL "${r.url ?? r.link ?? ''}"`);
      continue;
    }
    if (!h1) {
      dropped += 1;
      if (errors.length < 10) errors.push(`row ${i + 1}: пустой h1 для ${url}`);
      continue;
    }
    seen.set(url, { url, h1 });
    if (seen.size >= limit) break;
  }

  return { links: Array.from(seen.values()), dropped, errors };
}

/**
 * domainsFromLinks — извлекает уникальные домены (≤ 8) для Pre-Stage 0.
 */
function domainsFromLinks(links) {
  const set = new Set();
  for (const l of links || []) {
    try {
      const u = new URL(l.url);
      set.add(u.hostname.replace(/^www\./, ''));
    } catch (_) { /* skip */ }
    if (set.size >= 8) break;
  }
  return Array.from(set);
}

module.exports = {
  normalizeCommercialLinks,
  domainsFromLinks,
  isValidHttpUrl,
  MAX_COMMERCIAL_LINKS: DEFAULT_LIMIT,
};
