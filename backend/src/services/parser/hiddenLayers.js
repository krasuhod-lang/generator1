'use strict';

/**
 * hiddenLayers — extractor «скрытых слоёв» страницы, которые могут влиять
 * на ранжирование в поисковых системах, но традиционно вычищаются из
 * markdown через Readability + NOISE_SELECTORS.
 *
 * Что вытаскиваем (всё graceful, любое поле может отсутствовать):
 *   • structured_data:
 *       - jsonld[]  — массив распарсенных JSON-LD блоков (Article, FAQPage,
 *                     BreadcrumbList, Product, Organization и т.д.)
 *       - microdata[] — собранные itemprop'ы (text + content + href)
 *       - __NEXT_DATA__, __NUXT__ — embedded SSR-state Next/Nuxt
 *   • meta_signals:
 *       - title, description, keywords, robots
 *       - canonical, hreflang[]
 *       - og:title/og:description/og:image/og:type
 *       - twitter:title/twitter:description/twitter:card
 *       - amp_html, manifest, ld_count
 *   • hidden_text:
 *       - noscript[]   — текст внутри <noscript>
 *       - template[]   — текст внутри <template>
 *       - hidden_attr[] — текст элементов с [hidden] / aria-hidden="true"
 *       - display_none[] — элементы с style*="display:none|visibility:hidden"
 *   • sitemap_hints:
 *       - sitemap_urls[] — из <link rel="sitemap"> + robots-meta
 *       - feed_urls[]   — из <link rel="alternate" type="application/rss+xml">
 *
 * Все массивы строк дедуплицированы и обрезаны до MAX_ITEMS / MAX_LEN
 * на элемент, чтобы не раздуть payload.
 */

const MAX_ITEMS = 30;
const MAX_LEN = 1500;
const MAX_JSONLD_LEN = 8000;

function _truncate(s, max = MAX_LEN) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function _uniqPush(arr, value, max = MAX_ITEMS) {
  if (!value) return;
  if (arr.length >= max) return;
  if (arr.includes(value)) return;
  arr.push(value);
}

function _safeJsonParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { /* fallthrough */ }
  // Иногда JSON-LD содержит JS-комментарии или trailing commas — мягкая чистка.
  try {
    const cleaned = String(raw)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

function _absUrl(baseUrl, href) {
  if (!href) return '';
  try { return new URL(href, baseUrl).toString(); } catch (_) { return String(href); }
}

/**
 * extractHiddenLayers($, { baseUrl }) — принимает cheerio-инстанс,
 * собирает скрытые слои. baseUrl нужен для разрешения относительных
 * canonical / hreflang / sitemap.
 */
function extractHiddenLayers($, { baseUrl = '' } = {}) {
  const out = {
    structured_data: { jsonld: [], microdata: [], next_data: null, nuxt_data: null },
    meta_signals:    {
      title: '', description: '', keywords: '', robots: '',
      canonical: '', amp_html: '', manifest: '',
      hreflang: [], og: {}, twitter: {}, ld_count: 0,
    },
    hidden_text: { noscript: [], template: [], hidden_attr: [], display_none: [] },
    sitemap_hints: { sitemap_urls: [], feed_urls: [] },
  };

  // ── JSON-LD ──────────────────────────────────────────────────────
  try {
    const ldScripts = $('script[type="application/ld+json"]');
    out.meta_signals.ld_count = ldScripts.length;
    ldScripts.each((_i, el) => {
      if (out.structured_data.jsonld.length >= MAX_ITEMS) return;
      const raw = $(el).contents().text() || $(el).html() || '';
      if (!raw || raw.length > MAX_JSONLD_LEN * 2) return;
      const parsed = _safeJsonParse(raw);
      if (parsed) out.structured_data.jsonld.push(parsed);
    });
  } catch (_) { /* ignore */ }

  // ── __NEXT_DATA__ / __NUXT__ ─────────────────────────────────────
  try {
    const nextEl = $('script#__NEXT_DATA__');
    if (nextEl.length) {
      const raw = nextEl.contents().text() || nextEl.html() || '';
      const parsed = _safeJsonParse(raw);
      if (parsed) {
        // Сохраняем только page / props / query — это достаточно для
        // понимания «что должно рендериться», без всего state-tree.
        out.structured_data.next_data = {
          page: parsed.page || '',
          query: parsed.query || null,
          buildId: parsed.buildId || '',
          props_keys: parsed.props && typeof parsed.props === 'object'
            ? Object.keys(parsed.props).slice(0, 20) : [],
        };
      }
    }
    const nuxtEl = $('script:contains("window.__NUXT__")').first();
    if (nuxtEl.length) {
      out.structured_data.nuxt_data = { detected: true };
    }
  } catch (_) { /* ignore */ }

  // ── meta tags ────────────────────────────────────────────────────
  try {
    out.meta_signals.title       = _truncate($('title').first().text(), 500);
    out.meta_signals.description = _truncate($('meta[name="description"]').attr('content'), 500);
    out.meta_signals.keywords    = _truncate($('meta[name="keywords"]').attr('content'), 500);
    out.meta_signals.robots      = _truncate($('meta[name="robots"]').attr('content'), 200);

    const can = $('link[rel="canonical"]').attr('href');
    if (can) out.meta_signals.canonical = _absUrl(baseUrl, can);
    const amp = $('link[rel="amphtml"]').attr('href');
    if (amp) out.meta_signals.amp_html = _absUrl(baseUrl, amp);
    const mfst = $('link[rel="manifest"]').attr('href');
    if (mfst) out.meta_signals.manifest = _absUrl(baseUrl, mfst);

    $('link[rel="alternate"][hreflang]').each((_i, el) => {
      const lang = $(el).attr('hreflang');
      const href = $(el).attr('href');
      if (lang && href && out.meta_signals.hreflang.length < MAX_ITEMS) {
        out.meta_signals.hreflang.push({ lang, href: _absUrl(baseUrl, href) });
      }
    });

    $('meta[property^="og:"]').each((_i, el) => {
      const prop = $(el).attr('property');
      const val  = $(el).attr('content');
      if (prop && val) out.meta_signals.og[prop.slice(3)] = _truncate(val, 500);
    });
    $('meta[name^="twitter:"]').each((_i, el) => {
      const name = $(el).attr('name');
      const val  = $(el).attr('content');
      if (name && val) out.meta_signals.twitter[name.slice(8)] = _truncate(val, 500);
    });
  } catch (_) { /* ignore */ }

  // ── sitemap / feed hints ────────────────────────────────────────
  try {
    $('link[rel="sitemap"]').each((_i, el) => {
      _uniqPush(out.sitemap_hints.sitemap_urls, _absUrl(baseUrl, $(el).attr('href')));
    });
    $('link[rel="alternate"]').each((_i, el) => {
      const type = ($(el).attr('type') || '').toLowerCase();
      const href = $(el).attr('href');
      if (!href) return;
      if (type.includes('rss') || type.includes('atom') || type.includes('json+feed')) {
        _uniqPush(out.sitemap_hints.feed_urls, _absUrl(baseUrl, href));
      }
    });
  } catch (_) { /* ignore */ }

  // ── microdata (itemprop) ─────────────────────────────────────────
  try {
    $('[itemprop]').each((_i, el) => {
      if (out.structured_data.microdata.length >= MAX_ITEMS) return;
      const prop = $(el).attr('itemprop');
      if (!prop) return;
      const content = $(el).attr('content') || $(el).attr('href') || $(el).text() || '';
      const value = _truncate(content, 500);
      if (value) {
        out.structured_data.microdata.push({ prop, value });
      }
    });
  } catch (_) { /* ignore */ }

  // ── <noscript> ────────────────────────────────────────────────────
  try {
    $('noscript').each((_i, el) => {
      const text = _truncate($(el).text(), MAX_LEN);
      _uniqPush(out.hidden_text.noscript, text);
    });
  } catch (_) { /* ignore */ }

  // ── <template> ───────────────────────────────────────────────────
  try {
    $('template').each((_i, el) => {
      const html = $(el).html() || '';
      const text = _truncate(html.replace(/<[^>]+>/g, ' '), MAX_LEN);
      _uniqPush(out.hidden_text.template, text);
    });
  } catch (_) { /* ignore */ }

  // ── [hidden] / aria-hidden ───────────────────────────────────────
  try {
    $('[hidden], [aria-hidden="true"]').each((_i, el) => {
      const text = _truncate($(el).text(), MAX_LEN);
      _uniqPush(out.hidden_text.hidden_attr, text);
    });
  } catch (_) { /* ignore */ }

  // ── style*="display:none|visibility:hidden" ──────────────────────
  try {
    // Ограниченные диапазоны {0,40} в regex — защита от ReDoS:
    // длина пробелов/имени свойства ограничена сверху, без бэктрекинга.
    const styleRe = /(display\s{0,4}:\s{0,4}none|visibility\s{0,4}:\s{0,4}hidden)/i;
    $('[style]').each((_i, el) => {
      if (out.hidden_text.display_none.length >= MAX_ITEMS) return;
      const style = $(el).attr('style') || '';
      if (style.length > 400) return; // не трогаем гигантские inline-стили
      if (styleRe.test(style)) {
        const text = _truncate($(el).text(), MAX_LEN);
        _uniqPush(out.hidden_text.display_none, text);
      }
    });
  } catch (_) { /* ignore */ }

  return out;
}

/**
 * summarizeHiddenLayers(layers) — короткий человекочитаемый digest
 * для логов / UI. Возвращает строку «JSON-LD: 3 (Article, FAQPage); …».
 */
function summarizeHiddenLayers(layers) {
  if (!layers) return '';
  const parts = [];
  const types = [];
  for (const ld of (layers.structured_data.jsonld || [])) {
    if (ld && ld['@type']) {
      const t = Array.isArray(ld['@type']) ? ld['@type'].join('+') : ld['@type'];
      if (!types.includes(t)) types.push(t);
    }
  }
  parts.push(`JSON-LD: ${layers.meta_signals.ld_count}${types.length ? ' (' + types.slice(0, 6).join(', ') + ')' : ''}`);
  parts.push(`microdata: ${layers.structured_data.microdata.length}`);
  parts.push(`hreflang: ${layers.meta_signals.hreflang.length}`);
  if (layers.meta_signals.canonical) parts.push('canonical✓');
  if (layers.structured_data.next_data) parts.push('Next✓');
  if (layers.structured_data.nuxt_data) parts.push('Nuxt✓');
  parts.push(`noscript: ${layers.hidden_text.noscript.length}`);
  parts.push(`hidden_attr: ${layers.hidden_text.hidden_attr.length}`);
  parts.push(`display_none: ${layers.hidden_text.display_none.length}`);
  return parts.join(' | ');
}

module.exports = {
  extractHiddenLayers,
  summarizeHiddenLayers,
  _safeJsonParse,
  _truncate,
};
