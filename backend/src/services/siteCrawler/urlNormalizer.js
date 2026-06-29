'use strict';

/**
 * siteCrawler/urlNormalizer.js — нормализация URL для краулера (задача 3).
 * См. описание в test-site-crawler.js.
 */

const STRIPPED_QUERY_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_referrer', 'utm_id', 'utm_name', 'utm_brand',
  'fbclid', 'gclid', 'yclid', 'ymclid', 'msclkid', '_ga', '_gl', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source',
]);

const NON_HTML_EXT = new Set([
  'jpg','jpeg','png','gif','webp','svg','ico','bmp','tiff','avif',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','zip','rar','7z','tar','gz',
  'mp3','mp4','avi','mov','mkv','webm','ogg','wav',
  'css','js','json','xml','rss','atom','txt',
  'woff','woff2','ttf','otf','eot',
]);

function normalize(rawUrl, base) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('tel:') ||
      lower.startsWith('javascript:') || lower.startsWith('vbscript:') ||
      lower.startsWith('data:') || lower.startsWith('file:')) {
    return null;
  }
  let u;
  try { u = base ? new URL(trimmed, base) : new URL(trimmed); }
  catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:'  && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  const params = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (STRIPPED_QUERY_PARAMS.has(k.toLowerCase())) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = '';
  if (params.length) {
    const sp = new URLSearchParams();
    for (const [k, v] of params) sp.append(k, v);
    u.search = '?' + sp.toString();
  }
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (!path) path = '/';
  u.pathname = path;
  return u.toString();
}

function isLikelyNonHtml(urlString) {
  if (!urlString) return false;
  try {
    const u = new URL(urlString);
    const m = u.pathname.match(/\.([a-z0-9]{1,5})$/i);
    if (!m) return false;
    return NON_HTML_EXT.has(m[1].toLowerCase());
  } catch (_) { return true; }
}

function registrableDomain(host) {
  if (!host || typeof host !== 'string') return null;
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function hostMatches(host, startHost, includeSubdomains) {
  if (!host || !startHost) return false;
  host      = host.toLowerCase();
  startHost = startHost.toLowerCase();
  if (host === startHost) return true;
  if (!includeSubdomains) return false;
  return registrableDomain(host) === registrableDomain(startHost);
}

module.exports = {
  normalize,
  isLikelyNonHtml,
  registrableDomain,
  hostMatches,
  STRIPPED_QUERY_PARAMS,
  NON_HTML_EXT,
};
