'use strict';

/**
 * projects/pageMetaAudit — аудит и усиление мета-тегов топ-страниц (п.4 ТЗ).
 *
 * Флоу:
 *   1. Детерминированно выбираем страницы-кандидаты: те, где детектор GSC
 *      сигналит о недоборе (ctr_anomalies / page_decay), плюс топ по показам.
 *   2. Парсим текущие title/description/H1 (parser/scraper.js — с retry/SSL).
 *   3. Строим семантику из реальных GSC-запросов страницы и прогоняем через
 *      инструмент мета-тегов (metaTags/metaGenerator.generateDrMaxMeta), чтобы
 *      усилить теги (Gemini, те же квоты/ретраи, без BullMQ).
 *   4. Возвращаем срез «было → стало» с диффом по символам/ключам/LSI.
 *
 * Всё graceful: парсинг/LLM могут падать поштучно — это не валит общий анализ.
 * Детерминированные хелперы (selectPagesToAudit, analyzeMetaLengths,
 * buildSemanticsFromQueries, diffMeta) тестируются без сети.
 */

const { getProjectsConfig } = require('../config');
const { normalizeWord, STOP_WORDS } = require('../../metaTags/semantics');

// Лимиты мета-тегов — синхронны с metaTags/metaGenerator (TITLE_MIN…H1_MAX).
// Дублируем константами, чтобы не тянуть LLM-адаптеры в детерминированный слой.
const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESC_MIN = 140;
const DESC_MAX = 155;
const H1_MAX = 70;

function _len(s) { return String(s || '').length; }

/**
 * Детерминированная диагностика длины/качества текущих мета-тегов.
 * @returns {{title_len, desc_len, h1_len, issues:string[]}}
 */
function analyzeMetaLengths({ title, description, h1 } = {}) {
  const tl = _len(title);
  const dl = _len(description);
  const hl = _len(h1);
  const issues = [];
  if (tl === 0) issues.push('empty_title');
  else if (tl < TITLE_MIN) issues.push('title_too_short');
  else if (tl > TITLE_MAX) issues.push('title_too_long');
  if (dl === 0) issues.push('empty_description');
  else if (dl < DESC_MIN) issues.push('description_too_short');
  else if (dl > DESC_MAX) issues.push('description_too_long');
  if (hl === 0) issues.push('empty_h1');
  else if (hl > H1_MAX) issues.push('h1_too_long');
  if (title && h1 && String(title).trim().toLowerCase() === String(h1).trim().toLowerCase()) {
    issues.push('h1_duplicates_title');
  }
  return { title_len: tl, desc_len: dl, h1_len: hl, issues };
}

/**
 * Выбирает страницы-кандидаты на аудит мета-тегов, приоритизируя сигналы
 * недобора кликов. Возвращает [{ url, reason, queries:[{query,impressions,...}] }].
 *
 * @param {object} snapshot — собранный срез GSC (commercial, page_decay, top_pages)
 * @param {Array}  queryPage — матрица query×page (для привязки запросов к URL)
 * @param {object} cfg — getProjectsConfig().pageMetaAudit
 */
function selectPagesToAudit(snapshot, queryPage, cfg) {
  const maxPages = (cfg && cfg.maxPages) || 8;
  const reasons = new Map(); // url → reason (первый/важнейший выигрывает)

  const addReason = (url, reason) => {
    if (!url || typeof url !== 'string') return;
    if (!reasons.has(url)) reasons.set(url, reason);
  };

  // 1) CTR-аномалии: страница недобирает клики относительно позиции.
  const commercial = snapshot && snapshot.commercial;
  if (commercial && Array.isArray(commercial.ctr_anomalies)) {
    commercial.ctr_anomalies.forEach((a) => {
      // ctr_anomalies на уровне запроса; привяжем к landing page через queryPage.
      const page = _bestPageForQuery(queryPage, a.query);
      if (page) addReason(page, 'ctr_anomaly');
    });
  }
  // 2) Затухающие страницы (page_decay).
  const pd = snapshot && snapshot.page_decay;
  if (pd && Array.isArray(pd.items)) {
    pd.items.filter((it) => it.decaying).forEach((it) => addReason(it.page, 'page_decay'));
  }
  // 3) Несоответствие интента (коммерческий запрос на инфо-странице).
  if (commercial && Array.isArray(commercial.intent_mismatch)) {
    commercial.intent_mismatch.forEach((m) => addReason(m.landing_page, 'intent_mismatch'));
  }
  // 4) Добиваем топом по показам.
  const topPages = (snapshot && snapshot.top_pages) || [];
  topPages.forEach((p) => addReason(p.key, 'top_impressions'));

  const ordered = Array.from(reasons.entries()).slice(0, maxPages);
  return ordered.map(([url, reason]) => ({
    url,
    reason,
    queries: _queriesForPage(queryPage, url),
  }));
}

function _bestPageForQuery(queryPage, query) {
  if (!Array.isArray(queryPage)) return null;
  let best = null;
  queryPage.forEach((r) => {
    if (r.query === query && (!best || (r.impressions || 0) > (best.impressions || 0))) best = r;
  });
  return best ? best.page : null;
}

function _queriesForPage(queryPage, url) {
  if (!Array.isArray(queryPage)) return [];
  return queryPage
    .filter((r) => r.page === url)
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 10)
    .map((r) => ({ query: r.query, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}

/**
 * Строит объект semantics (как в metaTags) из реальных GSC-запросов страницы:
 * слова из высокочастотных запросов → title_mandatory_words, из остальных →
 * description_mandatory_words. Детерминированно, без сети.
 *
 * @param {Array} queries [{query,impressions,...}]
 * @returns {{title_mandatory_words:string[], description_mandatory_words:string[]}}
 */
function buildSemanticsFromQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return { title_mandatory_words: [], description_mandatory_words: [] };
  }
  const weight = Object.create(null);
  queries.forEach((q) => {
    const impr = Math.max(1, Number(q.impressions) || 1);
    String(q.query || '')
      .toLowerCase()
      .replace(/[^а-яёa-z0-9]/g, ' ')
      .split(/\s+/)
      .forEach((w) => {
        const n = normalizeWord(w);
        if (n.length > 2 && !STOP_WORDS.has(n) && !/^\d+$/.test(n)) {
          weight[n] = (weight[n] || 0) + impr;
        }
      });
  });
  const ranked = Object.entries(weight).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  return {
    title_mandatory_words: ranked.slice(0, 6),
    description_mandatory_words: ranked.slice(0, 10),
  };
}

/**
 * Детерминированный дифф «было → стало» по мета-тегам.
 */
function diffMeta(before, after) {
  return {
    title: { before: before.title || '', after: after.title || '',
      before_len: _len(before.title), after_len: _len(after.title) },
    description: { before: before.description || '', after: after.description || '',
      before_len: _len(before.description), after_len: _len(after.description) },
    h1: { before: before.h1 || '', after: after.h1 || '',
      before_len: _len(before.h1), after_len: _len(after.h1) },
  };
}

/**
 * Полный аудит мета-тегов (с парсингом и опциональной LLM-регенерацией).
 * Graceful: ошибки парсинга/LLM на отдельной странице не валят весь срез.
 * Тяжёлые зависимости (scraper/metaGenerator) подгружаются лениво, чтобы
 * детерминированные хелперы оставались тестируемыми без сети.
 *
 * @returns {Promise<{available:boolean, pages:Array}|null>}
 */
async function auditPages({ project, snapshot, queryPage } = {}) {
  const cfg = getProjectsConfig().pageMetaAudit;
  if (!cfg || !cfg.enabled) return null;
  const candidates = selectPagesToAudit(snapshot, queryPage, cfg);
  if (candidates.length === 0) return { available: false, reason: 'no_pages' };

  const { scrapeUrl } = require('../../parser/scraper');
  let generateDrMaxMeta = null;
  if (cfg.autoRegenerate) {
    ({ generateDrMaxMeta } = require('../../metaTags/metaGenerator'));
  }

  const pages = [];
  for (const cand of candidates) {
    try {
      const scraped = await scrapeUrl(cand.url, cfg.scrapeTimeoutMs);
      const hl = scraped.hiddenLayers || {};
      const meta = hl.meta_signals || {};
      const before = {
        title: scraped.title || meta.title || '',
        description: meta.description || '',
        h1: _extractH1(scraped),
      };
      const lengths = analyzeMetaLengths(before);
      const semantics = buildSemanticsFromQueries(cand.queries);

      const entry = {
        url: cand.url,
        reason: cand.reason,
        before,
        lengths,
        mandatory_words: semantics.title_mandatory_words,
        queries: cand.queries,
        suggested: null,
        diff: null,
      };

      if (generateDrMaxMeta && semantics.title_mandatory_words.length > 0) {
        try {
          const keyword = (cand.queries[0] && cand.queries[0].query) || '';
          const gen = await generateDrMaxMeta({
            keyword,
            semantics,
            serpData: null,
            inputs: {
              brand_name: project && project.name,
              page_context: before.description || before.title || '',
            },
          });
          const after = { title: gen.title || '', description: gen.description || '', h1: gen.h1 || '' };
          entry.suggested = after;
          entry.diff = diffMeta(before, after);
        } catch (_) { /* keep audit without suggestion */ }
      }
      pages.push(entry);
    } catch (_) {
      pages.push({ url: cand.url, reason: cand.reason, error: 'scrape_failed' });
    }
  }

  return { available: true, pages, generated: Boolean(generateDrMaxMeta) };
}

function _extractH1(scraped) {
  // scrapeUrl не отдаёт H1 напрямую — пробуем из markdown (первый "# ").
  const md = String(scraped && scraped.markdown || '');
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

module.exports = {
  analyzeMetaLengths,
  selectPagesToAudit,
  buildSemanticsFromQueries,
  diffMeta,
  auditPages,
};
