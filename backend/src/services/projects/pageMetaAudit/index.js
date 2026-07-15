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

// Лимиты мета-тегов — кириллические safe ranges GIST Meta Filter (Задача D §4,
// синхронны с metaTags/gistMetaFilter). Дублируем константами, чтобы не тянуть
// LLM-адаптеры в детерминированный слой.
const TITLE_MIN = 40;
const TITLE_MAX = 50;
const DESC_MIN = 130;
const DESC_MAX = 145;
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

function mergeGeneratedMetaIntoAudit(pageMetaAudit, generatedPages) {
  const audit = pageMetaAudit && typeof pageMetaAudit === 'object'
    ? { ...pageMetaAudit }
    : { available: true, pages: [] };
  const current = Array.isArray(audit.pages) ? audit.pages : [];
  const incoming = Array.isArray(generatedPages) ? generatedPages.filter((p) => p && p.url) : [];
  if (incoming.length === 0) return audit;

  const byUrl = new Map(current.map((p) => [p && p.url, p]).filter(([url]) => url));
  incoming.forEach((page) => {
    const prev = byUrl.get(page.url) || {};
    byUrl.set(page.url, { ...prev, ...page });
  });

  const incomingUrls = new Set(incoming.map((p) => p.url));
  const merged = current.map((p) => (p && incomingUrls.has(p.url) ? byUrl.get(p.url) : p));
  incoming.forEach((p) => {
    if (!current.some((old) => old && old.url === p.url)) merged.push(byUrl.get(p.url));
  });

  return {
    ...audit,
    available: true,
    pages: merged,
    generated: true,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Полный аудит мета-тегов (с парсингом и опциональной LLM-регенерацией).
 * Graceful: ошибки парсинга/LLM на отдельной странице не валят весь срез.
 * Тяжёлые зависимости (scraper/metaStages) подгружаются лениво, чтобы
 * детерминированные хелперы оставались тестируемыми без сети.
 *
 * Этапы генерации (SERP → семантика → Gemini → LSI-проверка) вынесены в общий
 * staged-хелпер metaTags/metaStages.runMetaStagesForKeyword — тот же, что у
 * инструмента мета-тегов. По умолчанию (regenerate=false) LLM НЕ запускается:
 * быстрый детерминированный аудит «было» внутри анализа GSC. Регенерация —
 * отдельным шагом через regenerateMetaForPages (кнопка / эндпоинт).
 *
 * @param {object} args
 * @param {boolean} [args.regenerate] — запускать ли staged LLM-генерацию
 * @returns {Promise<{available:boolean, pages:Array}|null>}
 */
async function auditPages({ project, snapshot, queryPage, regenerate } = {}) {
  const cfg = getProjectsConfig().pageMetaAudit;
  if (!cfg || !cfg.enabled) return null;
  const candidates = selectPagesToAudit(snapshot, queryPage, cfg);
  if (candidates.length === 0) return { available: false, reason: 'no_pages' };

  const { scrapeUrl } = require('../../parser/scraper');
  // LLM-регенерация запускается только при явном regenerate (отдельный шаг).
  const doRegenerate = regenerate === true;

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
      const { extractPriceData } = require('../../metaTags/metaGenerator');
      const priceData = extractPriceData({ page_context: scraped.markdown || scraped.content || '' });

      const entry = {
        url: cand.url,
        reason: cand.reason,
        before,
        lengths,
        mandatory_words: semantics.title_mandatory_words,
        price_data: priceData,
        queries: cand.queries,
        serp_analyzed: false,
        suggested: null,
        diff: null,
      };

      if (doRegenerate && semantics.title_mandatory_words.length > 0) {
        try {
          const generated = await _regenerateOne({
            project, cand, before, semantics, cfg, priceData,
          });
          if (generated) {
            entry.suggested = generated.suggested;
            entry.diff = generated.diff;
            entry.lsi_check = generated.lsi_check;
            entry.serp_analyzed = generated.serp_analyzed;
          }
        } catch (_) { /* keep audit without suggestion */ }
      }
      pages.push(entry);
    } catch (_) {
      pages.push({ url: cand.url, reason: cand.reason, error: 'scrape_failed' });
    }
  }

  return { available: true, pages, generated: doRegenerate };
}

/**
 * Staged-регенерация мета-тега одной страницы через общий хелпер
 * metaTags/metaStages.runMetaStagesForKeyword (SERP → семантика → Gemini →
 * LSI-проверка). Главный запрос — реальный GSC-запрос страницы, иначе фоллбэк
 * на заголовок/слаг URL. Возвращает {suggested, diff, lsi_check, serp_analyzed}.
 *
 * @param {object} [audienceNicheDigest] — разовый digest ЦА/ниши (опционально)
 */
async function _regenerateOne({
  project, cand, before, semantics, cfg, audienceNicheDigest = '', priceData = null,
}) {
  const { runMetaStagesForKeyword } = require('../../metaTags/metaStages');
  const serpCfg = (cfg && cfg.serpAnalysis) || {};

  const keyword = (cand.queries[0] && cand.queries[0].query)
    || _fallbackKeyword(before, cand.url);
  if (!keyword) return null;

  const { metas, serp } = await runMetaStagesForKeyword({
    keyword,
    semantics,
    lr: serpCfg.lr || '',
    inputs: {
      brand_name: project && project.name,
      brand: (project && project.name) || '',
      niche: (cand.queries[0] && cand.queries[0].query) || '',
      page_context: before.description || before.title || '',
      summary: before.description || before.title || '',
      price_data: priceData,
      audienceNicheDigest: audienceNicheDigest || '',
    },
  });

  const after = { title: metas.title || '', description: metas.description || '', h1: metas.h1 || '' };
  return {
    suggested: after,
    diff: diffMeta(before, after),
    lsi_check: metas.lsi_check || null,
    serp_analyzed: Boolean(serp && serp.length),
  };
}

/**
 * Staged-регенерация мета-тегов для набора уже выбранных страниц (отдельный шаг
 * «генерация» вне тяжёлого анализа GSC). Разово строит digest ЦА/ниши и гоняет
 * каждую страницу через runMetaStagesForKeyword. Этапы трекаются через
 * переданный funnel (audience_niche / generate_meta / finalize).
 *
 * @param {object} args { project, pages:[{url, reason, before, lengths, queries, mandatory_words}], funnel }
 * @returns {Promise<{available:boolean, pages:Array, generated:boolean}>}
 */
async function regenerateMetaForPages({ project, pages = [], funnel = null } = {}) {
  const cfg = getProjectsConfig().pageMetaAudit;
  if (!cfg || !cfg.enabled) return { available: false, reason: 'disabled' };
  if (!Array.isArray(pages) || pages.length === 0) return { available: false, reason: 'no_pages' };

  // Разовый анализ ЦА/ниши на всю пачку URL (как в инструменте мета-тегов).
  let audienceNicheDigest = '';
  if (cfg.audienceNiche && cfg.audienceNiche.enabled) {
    if (funnel) funnel.step('audience_niche');
    try {
      const { buildAudienceNicheDigest } = require('../../metaTags/metaStages');
      const sample = pages[0] || {};
      audienceNicheDigest = await buildAudienceNicheDigest({
        niche: (sample.queries && sample.queries[0] && sample.queries[0].query)
          || (sample.before && (sample.before.h1 || sample.before.title)) || '',
        brand: (project && project.name) || '',
        toponym: '',
        summary: (sample.before && (sample.before.description || sample.before.title)) || '',
      });
    } catch (_) { audienceNicheDigest = ''; }
  }

  if (funnel) funnel.step('generate_meta');
  const out = [];
  let okCount = 0;
  for (const page of pages) {
    const before = page.before || { title: '', description: '', h1: '' };
    const semantics = buildSemanticsFromQueries(page.queries);
    const entry = { ...page, suggested: null, diff: null };
    try {
      const generated = await _regenerateOne({
        project,
        cand: { url: page.url, queries: page.queries || [] },
        before,
        semantics,
        cfg,
        audienceNicheDigest,
        priceData: page.price_data || null,
      });
      if (generated) {
        entry.suggested = generated.suggested;
        entry.diff = generated.diff;
        entry.lsi_check = generated.lsi_check;
        entry.serp_analyzed = generated.serp_analyzed;
        okCount += 1;
      }
    } catch (err) {
      // Не глотаем причину молча — прокидываем в строку, чтобы UI показал,
      // почему «Стало» не сгенерировалось (например, сбой SERP/ключей), а не
      // оставлял оператора в неведении («ничего не произошло»).
      entry.error = String((err && err.message) || err) || 'generation_failed';
    }
    out.push(entry);
  }

  if (funnel) {
    if (okCount === 0) funnel.fail(`all ${pages.length} pages failed`);
    else funnel.step('finalize');
  }
  return {
    available: true,
    pages: out,
    generated: true,
    ok_count: okCount,
    // Когда не сгенерировалась НИ ОДНА страница — отдаём флаг и первую причину,
    // чтобы фронт показал понятную ошибку вместо «тишины».
    error: okCount === 0 ? ((out.find((p) => p.error) || {}).error || 'generation_failed') : null,
  };
}

function _extractH1(scraped) {
  // scrapeUrl не отдаёт H1 напрямую — пробуем из markdown (первый "# ").
  const md = String(scraped && scraped.markdown || '');
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 200) : '';
}

/**
 * Фоллбэк-ключ, когда у страницы нет GSC-запросов: берём H1/Title, иначе —
 * человекочитаемый слаг URL. Нужен, чтобы регенерация мета-тега работала даже
 * без подключённого GSC (п.2 ТЗ).
 */
function _fallbackKeyword(before, url) {
  const fromMeta = String((before && (before.h1 || before.title)) || '').trim();
  if (fromMeta) return fromMeta.slice(0, 120);
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const slug = u.pathname.replace(/^\/|\/$/g, '').split('/').pop() || u.hostname;
    return slug.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim();
  } catch (_) { return ''; }
}

module.exports = {
  analyzeMetaLengths,
  selectPagesToAudit,
  buildSemanticsFromQueries,
  diffMeta,
  mergeGeneratedMetaIntoAudit,
  auditPages,
  regenerateMetaForPages,
};
