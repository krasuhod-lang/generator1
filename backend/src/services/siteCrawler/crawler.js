'use strict';

/**
 * siteCrawler/crawler.js — BFS-обходчик сайта (задача 3).
 *
 * Контракт:
 *   runCrawl({ taskId, startUrl, options, db }) → Promise<{ stats }>
 *
 * options:
 *   maxPages           (1000) — верхний предел собранных страниц;
 *   maxDepth           (5)    — глубина от корня;
 *   includeSubdomains  (false);
 *   respectRobots      (true);
 *   concurrency        (4)    — одновременных GET;
 *   requestTimeoutMs   (10000);
 *   maxBytes           (2*1024*1024) — лимит размера ответа;
 *   interRequestMs     (250)  — задержка между запросами к ОДНОМУ хосту;
 *   userAgent          ('EgidaSiteCrawler/1.0 (+contact)');
 *
 * Запускается асинхронно (controller обёрнет в setImmediate). По шагам:
 *   1. Нормализуем startUrl, парсим origin/host;
 *   2. Проверяем SSRF (assertPublicHost);
 *   3. Тянем robots.txt (если respectRobots);
 *   4. Цикл BFS:
 *        - тянем из FIFO, фильтруем (visited/host/depth/robots);
 *        - параллельно concurrency запросов, между запросами к одному хосту
 *          ждём interRequestMs (минимальная вежливость);
 *        - cheerio → title/h1/meta/canonical/robots + извлекаем <a href>;
 *        - INSERT в site_crawl_pages (ON CONFLICT DO NOTHING).
 *   5. По завершении: UPDATE site_crawl_tasks SET status, stats, finished_at.
 *
 * Все ошибки сети ловим в строку, не валим всю задачу.
 *
 * Зависимости (уже есть): axios, cheerio.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const dbDefault = require('../../config/db');
const urlN      = require('./urlNormalizer');
const robots    = require('./robotsClient');
const { assertPublicHost } = require('./ssrfGuard');

const DEFAULTS = {
  maxPages:         5000,
  maxDepth:         10,
  includeSubdomains: false,
  respectRobots:    true,
  concurrency:      4,
  requestTimeoutMs: 10000,
  maxBytes:         2 * 1024 * 1024,
  interRequestMs:   250,
  userAgent:        'EgidaSiteCrawler/1.0 (+https://egida.local; admin@egida.local)',
  useSitemap:       true,    // подсасывать sitemap.xml / sitemap_index.xml
  statsFlushEvery:  10,      // как часто (каждые N страниц) сохранять stats в БД
};

function _mergeOptions(opts) {
  const out = { ...DEFAULTS, ...(opts || {}) };
  out.maxPages         = Math.max(1, Math.min(10000, Number(out.maxPages)         || DEFAULTS.maxPages));
  out.maxDepth         = Math.max(0, Math.min(20,    Number(out.maxDepth)         || DEFAULTS.maxDepth));
  out.concurrency      = Math.max(1, Math.min(16,    Number(out.concurrency)      || DEFAULTS.concurrency));
  out.requestTimeoutMs = Math.max(1000, Math.min(60000, Number(out.requestTimeoutMs) || DEFAULTS.requestTimeoutMs));
  out.interRequestMs   = Math.max(0, Math.min(10000, Number(out.interRequestMs)   || 0));
  out.maxBytes         = Math.max(64 * 1024, Math.min(20 * 1024 * 1024, Number(out.maxBytes) || DEFAULTS.maxBytes));
  out.useSitemap       = (out.useSitemap !== false);
  out.statsFlushEvery  = Math.max(1, Math.min(500, Number(out.statsFlushEvery) || DEFAULTS.statsFlushEvery));
  return out;
}

function _firstText(node) {
  if (!node) return null;
  const t = node.text();
  return t ? t.trim().slice(0, 1000) : null;
}

function _parseHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const title       = _firstText($('head title').first()) || _firstText($('title').first());
  const h1          = _firstText($('h1').first());
  const description = ($('meta[name="description"]').attr('content') ||
                       $('meta[property="og:description"]').attr('content') || '')
                       .toString().trim().slice(0, 1000) || null;
  const canonical   = ($('link[rel="canonical"]').attr('href') || '').trim() || null;
  const robotsMeta  = ($('meta[name="robots"]').attr('content') || '').trim() || null;

  const links = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const n = urlN.normalize(href, baseUrl);
    if (n) links.push(n);
  });
  // pagination hints: <link rel="next"|"prev"> и <a rel="next"|"prev">.
  // Без них пагинация типа /page/2 с JS-навигацией может не попасть в BFS.
  $('link[rel="next"], link[rel="prev"], a[rel="next"], a[rel="prev"]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const n = urlN.normalize(href, baseUrl);
    if (n) links.push(n);
  });

  let resolvedCanonical = canonical;
  if (canonical) {
    const c = urlN.normalize(canonical, baseUrl);
    if (c) resolvedCanonical = c;
  }
  return { title, h1, description, canonical: resolvedCanonical, robots: robotsMeta, links };
}

function _delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function _fetch(url, ua, timeoutMs, maxBytes) {
  const started = Date.now();
  const res = await axios.get(url, {
    timeout: timeoutMs,
    maxContentLength: maxBytes,
    maxRedirects: 5,
    responseType: 'text',
    transformResponse: (x) => x,
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
    validateStatus: () => true,
  });
  return {
    status:      res.status,
    contentType: (res.headers && res.headers['content-type']) || null,
    body:        typeof res.data === 'string' ? res.data : (res.data ? String(res.data) : ''),
    durationMs:  Date.now() - started,
  };
}

/** Сохраняет одну страницу. ON CONFLICT DO NOTHING — повторные нормализации одного URL не плодят строк. */
async function _savePage(db, row) {
  await db.query(
    `INSERT INTO site_crawl_pages
       (task_id, url, depth, parent_url, http_status, content_type, title, h1,
        description, canonical, robots, fetched_at, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13)
     ON CONFLICT (task_id, url) DO NOTHING`,
    [
      row.taskId, row.url, row.depth, row.parentUrl || null,
      row.status || null, row.contentType || null,
      row.title || null, row.h1 || null, row.description || null,
      row.canonical || null, row.robots || null,
      row.durationMs || null, row.error || null,
    ],
  );
}

/**
 * Извлекает URL из sitemap.xml-ленты. Поддерживает <urlset> и <sitemapindex>
 * (рекурсивно, в пределах depth=2, чтобы не уйти в бесконечный цикл).
 * Возвращает Set нормализованных URL. Любая сетевая/парсинговая ошибка → пустой Set.
 */
async function _fetchSitemapUrls(origin, opts, depth = 0) {
  const out = new Set();
  if (depth > 2) return out;
  const candidates = depth === 0
    ? [origin.replace(/\/+$/, '') + '/sitemap.xml',
       origin.replace(/\/+$/, '') + '/sitemap_index.xml']
    : [origin];                                       // depth>0 — origin это уже URL карты
  for (const url of candidates) {
    let body;
    try {
      const res = await axios.get(url, {
        timeout: opts.requestTimeoutMs,
        maxContentLength: opts.maxBytes * 4,          // sitemap может быть крупным
        maxRedirects: 5,
        responseType: 'text',
        transformResponse: (x) => x,
        headers: { 'User-Agent': opts.userAgent, 'Accept': 'application/xml,text/xml,*/*' },
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) continue;
      body = typeof res.data === 'string' ? res.data : String(res.data || '');
    } catch (_) { continue; }
    if (!body) continue;
    // Парсим вложенные sitemap-ы.
    const nestedSitemaps = [];
    const reSm = /<sitemap[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi;
    let m;
    while ((m = reSm.exec(body)) !== null) nestedSitemaps.push(m[1]);
    if (nestedSitemaps.length) {
      for (const sm of nestedSitemaps) {
        const child = await _fetchSitemapUrls(sm, opts, depth + 1);
        for (const u of child) out.add(u);
      }
    }
    // Парсим обычные <url><loc>…</loc></url>.
    const reUrl = /<url[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/url>/gi;
    while ((m = reUrl.exec(body)) !== null) {
      const n = urlN.normalize(m[1]);
      if (n) out.add(n);
    }
    // Fallback: голые <loc>…</loc> вне <url>/<sitemap>.
    if (!nestedSitemaps.length && !out.size) {
      const reLoc = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
      while ((m = reLoc.exec(body)) !== null) {
        const n = urlN.normalize(m[1]);
        if (n) out.add(n);
      }
    }
  }
  return out;
}

async function _persistStats(db, taskId, stats) {
  try {
    await db.query(
      `UPDATE site_crawl_tasks SET stats=$2::jsonb WHERE id=$1`,
      [taskId, JSON.stringify({ ...stats, updated_ms: Date.now() })],
    );
  } catch (_) { /* swallow — лучше потерять прогресс, чем уронить crawl */ }
}

/**
 * runCrawl — основная функция. taskId должен уже существовать в БД
 * (controller создаёт row перед запуском). Внутри — переводим status:
 * queued → running → done/error/cancelled/timeout.
 *
 * Возвращает { stats }.
 */
async function runCrawl({ taskId, startUrl, options }, dbInstance) {
  const db   = dbInstance || dbDefault;
  const opts = _mergeOptions(options);

  const start = urlN.normalize(startUrl);
  if (!start) throw new Error('invalid start_url');
  const startUrlObj = new URL(start);
  const startHost   = startUrlObj.hostname;
  const origin      = startUrlObj.origin;

  await db.query(
    `UPDATE site_crawl_tasks SET status='running', started_at=NOW() WHERE id=$1`,
    [taskId],
  );

  // SSRF на стартовый хост (для остальных — на каждом fetch).
  try { await assertPublicHost(startHost); }
  catch (e) {
    await db.query(
      `UPDATE site_crawl_tasks
          SET status='error', error=$2, finished_at=NOW()
        WHERE id=$1`, [taskId, e.message],
    );
    throw e;
  }

  let rules = { groups: [] };
  if (opts.respectRobots) {
    try { rules = await robots.getRules(origin, { ua: opts.userAgent }); }
    catch (_) { rules = { groups: [] }; }
  }

  const visited = new Set();
  const queue   = [];
  queue.push({ url: start, depth: 0, parent: null });
  visited.add(start);

  // Сидируем очередь из sitemap.xml — это даёт «детальный сканер» обещанный
  // ТЗ: страницы, на которые нет внутренних ссылок (например, фильтры или
  // глубокие листинги пагинации), всё равно попадают в обход.
  if (opts.useSitemap) {
    try {
      const smUrls = await _fetchSitemapUrls(origin, opts);
      for (const u of smUrls) {
        if (visited.has(u)) continue;
        try {
          const lu = new URL(u);
          if (!urlN.hostMatches(lu.hostname, startHost, opts.includeSubdomains)) continue;
        } catch (_) { continue; }
        visited.add(u);
        // sitemap-страницы кладём с depth=1, parent=start (для дерева)
        queue.push({ url: u, depth: 1, parent: start });
      }
    } catch (_) { /* ignore — sitemap optional */ }
  }

  const stats = { pages: 0, errors: 0, by_status: {}, started_ms: Date.now(),
    queued: queue.length, visited: visited.size, from_sitemap: queue.length - 1 };
  let lastFetchByHost = Object.create(null);
  let cancelled = false;

  async function checkCancelled() {
    const { rows } = await db.query(`SELECT status FROM site_crawl_tasks WHERE id=$1`, [taskId]);
    if (rows[0] && rows[0].status === 'cancelled') cancelled = true;
    return cancelled;
  }

  async function processOne(item) {
    if (cancelled || stats.pages >= opts.maxPages) return;
    const u = new URL(item.url);
    // host filter
    if (!urlN.hostMatches(u.hostname, startHost, opts.includeSubdomains)) return;
    // depth
    if (item.depth > opts.maxDepth) return;
    // robots
    if (opts.respectRobots && !robots.isAllowed(item.url, rules, opts.userAgent)) {
      stats.errors++;
      await _savePage(db, { taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
        status: null, error: 'blocked_by_robots' });
      return;
    }
    // non-html по расширению — не качаем
    if (urlN.isLikelyNonHtml(item.url)) {
      stats.pages++;
      await _savePage(db, { taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
        status: null, contentType: 'non-html (by ext)' });
      return;
    }
    // SSRF: на случай, если ссылка на новый поддомен
    try { await assertPublicHost(u.hostname); }
    catch (e) {
      stats.errors++;
      await _savePage(db, { taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
        status: null, error: e.message });
      return;
    }
    // per-host pacing
    const last = lastFetchByHost[u.hostname] || 0;
    const wait = (last + opts.interRequestMs) - Date.now();
    if (wait > 0) await _delay(wait);
    lastFetchByHost[u.hostname] = Date.now();

    let resp;
    try {
      resp = await _fetch(item.url, opts.userAgent, opts.requestTimeoutMs, opts.maxBytes);
    } catch (e) {
      stats.errors++;
      await _savePage(db, { taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
        status: null, error: e.message.slice(0, 500) });
      return;
    }

    stats.pages++;
    stats.by_status[String(resp.status)] = (stats.by_status[String(resp.status)] || 0) + 1;

    const ct = (resp.contentType || '').toLowerCase();
    if (!ct.includes('html') || resp.status >= 400 || !resp.body) {
      await _savePage(db, { taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
        status: resp.status, contentType: resp.contentType, durationMs: resp.durationMs });
      return;
    }
    const parsed = _parseHtml(resp.body, item.url);
    await _savePage(db, {
      taskId, url: item.url, depth: item.depth, parentUrl: item.parent,
      status: resp.status, contentType: resp.contentType,
      title: parsed.title, h1: parsed.h1, description: parsed.description,
      canonical: parsed.canonical, robots: parsed.robots,
      durationMs: resp.durationMs,
    });

    if (item.depth + 1 > opts.maxDepth) return;
    for (const link of parsed.links) {
      if (visited.has(link)) continue;
      if (visited.size >= opts.maxPages * 10) break; // anti-runaway очереди
      try {
        const lu = new URL(link);
        if (!urlN.hostMatches(lu.hostname, startHost, opts.includeSubdomains)) continue;
      } catch (_) { continue; }
      visited.add(link);
      queue.push({ url: link, depth: item.depth + 1, parent: item.url });
    }
  }

  // Worker loop с concurrency.
  let inflight = 0;
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  let cancelTick = 0;

  async function worker() {
    while (!cancelled && stats.pages < opts.maxPages) {
      const item = queue.shift();
      if (!item) {
        if (inflight === 0) { resolveDone(); return; }
        await _delay(50);
        continue;
      }
      inflight++;
      try { await processOne(item); }
      catch (e) { /* swallow */ stats.errors++; }
      inflight--;
      // обновляем счётчики очереди для UI и периодически сбрасываем stats в БД,
      // чтобы фронт видел живое число найденных страниц.
      stats.queued  = queue.length;
      stats.visited = visited.size;
      cancelTick++;
      if (cancelTick % 20 === 0) { await checkCancelled(); }
      if (cancelTick % opts.statsFlushEvery === 0) { await _persistStats(db, taskId, stats); }
    }
    if (inflight === 0) resolveDone();
  }

  const workers = [];
  // первый «снимок» stats — чтобы UI сразу увидел число URL из sitemap.
  await _persistStats(db, taskId, stats);
  for (let i = 0; i < opts.concurrency; i++) workers.push(worker());
  await Promise.race([done, Promise.all(workers)]);

  stats.duration_ms = Date.now() - stats.started_ms;
  stats.avg_ms = stats.pages ? Math.round(stats.duration_ms / stats.pages) : null;

  const finalStatus = cancelled ? 'cancelled' : 'done';
  await db.query(
    `UPDATE site_crawl_tasks
        SET status=$2, stats=$3::jsonb, finished_at=NOW()
      WHERE id=$1`,
    [taskId, finalStatus, JSON.stringify(stats)],
  );
  return { stats, status: finalStatus };
}

module.exports = {
  runCrawl,
  // экспорт для тестов
  _parseHtml,
  _mergeOptions,
  DEFAULTS,
};
