'use strict';

/**
 * fetchGoogleSerpWithContent — лёгкий Google SERP → тексты конкурентов для GIST.
 *
 * Назначение: дать M2/M3 gist_py реальные тексты из Google top-N, не заставляя
 * Python-сервис скрейпить выдачу самостоятельно. Модуль полностью fail-open:
 * любая фатальная ошибка возвращает [] и пишет console.warn.
 */

const { fetchGoogleSerp } = require('../metaTags/xmlstockClient');
const { scrapeUrl } = require('../parser/scraper');

const DEFAULT_STOP_DOMAINS = [
  'youtube.com',
  'wikipedia.org',
  'yandex.ru',
  'google.com',
  'vk.com',
  'ok.ru',
  'avito.ru',
  'market.yandex.ru',
];

const GOOGLE_SERP_COOLDOWN_MS = (() => {
  const v = parseInt(process.env.GOOGLE_SERP_COOLDOWN_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 4000;
})();

const MIN_WORDS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function _hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function _isStoppedDomain(url, stopDomains = DEFAULT_STOP_DOMAINS) {
  const host = _hostOf(url);
  if (!host) return true;
  return (Array.isArray(stopDomains) ? stopDomains : [])
    .map((d) => String(d || '').trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean)
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function _countWords(text) {
  const m = String(text || '').match(/[А-Яа-яЁёA-Za-z0-9-]+/g);
  return m ? m.length : 0;
}

function _mapSerpItem(item) {
  const url = String(item && item.url || '').trim();
  return {
    url,
    serp_title:       String(item && (item.serp_title || item.title) || '').trim(),
    serp_description: String(item && (item.serp_description || item.snippet) || '').trim(),
  };
}

function _googleOpts({ region, lang, top_n: topN }) {
  const pages = Math.max(1, Math.ceil(Math.max(1, Number(topN) || 10) / 10));
  const opts = { pages, startPage: 0 };
  if (region) opts.lr = region;
  if (String(region || '').toLowerCase() === 'ru' || String(lang || '').toLowerCase() === 'ru') {
    opts.domain = 'google.ru';
  }
  return opts;
}

async function fetchGoogleSerpWithContent({
  keyword,
  region = 'ru',
  lang = 'ru',
  top_n = 10,
  extract_content = true,
  stop_domains = DEFAULT_STOP_DOMAINS,
} = {}) {
  try {
    const query = String(keyword || '').trim();
    if (!query) return [];

    const serpRaw = await fetchGoogleSerp(query, _googleOpts({ region, lang, top_n }));
    const seen = new Set();
    const serp = [];
    for (const raw of (Array.isArray(serpRaw) ? serpRaw : [])) {
      const item = _mapSerpItem(raw);
      if (!item.url || seen.has(item.url) || _isStoppedDomain(item.url, stop_domains)) continue;
      seen.add(item.url);
      serp.push(item);
      if (serp.length >= top_n) break;
    }
    if (!extract_content) return serp.map((s) => ({ ...s, page_content: '', word_count: 0 }));

    const out = [];
    for (let i = 0; i < serp.length; i += 1) {
      const item = serp[i];
      if (i > 0 && GOOGLE_SERP_COOLDOWN_MS > 0) await sleep(GOOGLE_SERP_COOLDOWN_MS);
      try {
        const scraped = await scrapeUrl(item.url, 30000);
        const pageContent = String(scraped && scraped.markdown || '')
          .replace(/\s+/g, ' ')
          .trim();
        const wordCount = _countWords(pageContent);
        if (wordCount >= MIN_WORDS) {
          out.push({
            url: item.url,
            serp_title: item.serp_title || scraped.title || '',
            serp_description: item.serp_description,
            page_content: pageContent,
            word_count: wordCount,
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[fetchGoogleSerp] page skipped ${item.url}: ${e.message}`);
      }
    }
    return out;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[fetchGoogleSerp] failed-open: ${e.message}`);
    return [];
  }
}

module.exports = {
  fetchGoogleSerpWithContent,
  DEFAULT_STOP_DOMAINS,
  _isStoppedDomain,
  _countWords,
  _mapSerpItem,
  _googleOpts,
};
