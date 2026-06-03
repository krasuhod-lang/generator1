'use strict';

/**
 * aegis/algoWatcher (B5) — наблюдатель за апдейтами поисковых алгоритмов.
 *
 * Раз в `algoWatcher.intervalSec` пробегает по списку RSS-источников
 * (см. featureFlags.algoWatcher.sources), достаёт `<item>` элементы,
 * нормализует и сохраняет уникальные записи в `aegis_algo_updates`
 * (uniq по (source, url) — повторные тики безопасны).
 *
 * Поверх каждой записи запускается лёгкий regex-классификатор: matched
 * tags пишутся в массив tags (core_update / spam_update / helpful_content /
 * eeat / linking / technical / ranking_factor). LLM-уровень опционален и
 * по умолчанию выключен — без новых токен-расходов.
 *
 * Без новых ENV: конфиг полностью в коде (deepFreeze в featureFlags.js).
 * Сетевые ошибки не выбрасываются наружу — best-effort + warn.
 */

const http = require('./_httpClient');
const { getAegisFlags } = require('./featureFlags');

let _db = null;
function setDbConnection(db) { _db = db; }

function _stripCdata(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function _decodeEntities(s) {
  if (typeof s !== 'string') return '';
  // CodeQL js/double-escaping: replace `&amp;` LAST so e.g. `&amp;lt;`
  // remains literal `&lt;` instead of being double-decoded into `<`.
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Минимальный RSS/Atom парсер на регулярках. Этого достаточно для
 * стандартных фидов Google/SERoundtable; полный XML-парсер не подключаем,
 * чтобы не тащить новых deps. Не интерпретирует HTML внутри description.
 *
 * Возвращает массив { title, url, summary, published_at } (никогда не
 * выбрасывает; в ошибке вернёт []).
 */
function parseFeed(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  // RSS 2.0: <item>...</item>; Atom: <entry>...</entry>
  // Используем bounded quantifiers (\s{0,N}) для защиты от ReDoS.
  // Лимит длины каждого item — 32k символов; должно хватать для любого
  // нормального фида и не тащит длинные потенциально враждебные строки.
  const itemRe = /<(item|entry)\b[^>]{0,500}>([\s\S]{0,32000}?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(raw)) !== null) {
    const body = m[2];
    const title = _matchInner(body, /<title\b[^>]{0,200}>([\s\S]{0,2000}?)<\/title>/i);
    let url = _matchInner(body, /<link\b[^>]{0,200}>([\s\S]{0,2000}?)<\/link>/i);
    if (!url) {
      // Atom: <link href="..." />
      const lh = body.match(/<link\b[^>]{0,500}\bhref\s{0,4}=\s{0,4}["']([^"']{1,2000})["']/i);
      url = lh ? lh[1] : '';
    }
    const summary = _matchInner(body, /<(?:description|summary|content)\b[^>]{0,500}>([\s\S]{0,8000}?)<\/(?:description|summary|content)>/i);
    const pub = _matchInner(body, /<(?:pubDate|published|updated)\b[^>]{0,200}>([\s\S]{0,200}?)<\/(?:pubDate|published|updated)>/i);
    if (!title || !url) continue;
    out.push({
      title: _decodeEntities(_stripCdata(title)).slice(0, 500),
      url:   _decodeEntities(_stripCdata(url)).trim().slice(0, 1000),
      summary: _decodeEntities(_stripCdata(summary)).replace(/<[^>]{0,500}>/g, '').slice(0, 4000),
      published_at: _parseDate(_stripCdata(pub)),
    });
  }
  return out;
}

function _matchInner(body, re) {
  const m = body.match(re);
  return m ? m[1] : '';
}

function _parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** Применяет regex-правила из featureFlags к заголовку+summary. */
function classify(title, summary) {
  const flags = getAegisFlags().algoWatcher || {};
  const rules = (flags.classifier && flags.classifier.tagRules) || [];
  const text = `${title || ''}\n${summary || ''}`.toLowerCase();
  const tags = new Set();
  for (const rule of rules) {
    if (!rule || !rule.re || !rule.tag) continue;
    try {
      // 'i' уже не нужен: текст уже lowercased; экономим compile-cost.
      const re = new RegExp(rule.re);
      if (re.test(text)) tags.add(rule.tag);
    } catch (_) { /* битый regex в конфиге — пропускаем */ }
  }
  // Эвристическая severity: чем больше тегов матчнулось, тем выше.
  // 0 тегов → 0.1 (просто заметка); core_update → ≥0.7 даже один.
  let sev = Math.min(0.5, 0.1 + tags.size * 0.15);
  if (tags.has('core_update') || tags.has('spam_update')) sev = Math.max(sev, 0.8);
  if (tags.has('helpful_content')) sev = Math.max(sev, 0.6);
  return { tags: Array.from(tags), severity: Number(sev.toFixed(3)) };
}

/**
 * Скачать один RSS-источник (best-effort). Использует общий _httpClient,
 * но он возвращает body как JSON — здесь нам нужен raw. Для простоты
 * используем встроенный http/https через мини-обёртку.
 */
async function fetchFeed(url) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? require('https') : require('http');
  return new Promise((resolve) => {
    const req = lib.get({
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Aegis-AlgoWatcher/1.0', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      timeout:  15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
        } else {
          resolve({ ok: false, reason: 'http_' + res.statusCode });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ ok: false, reason: 'network', error: err.message }));
  });
}

/**
 * Один проход по всем источникам. Возвращает агрегированную статистику:
 *   { fetched, parsed, inserted, sources: [...] }
 * UPSERT по (source, url) — повторные тики безопасны.
 */
async function runOnce() {
  const flags = getAegisFlags().algoWatcher || {};
  if (!flags.enabled) return { ok: false, reason: 'disabled' };
  if (!_db) return { ok: false, reason: 'db_not_wired' };
  const sources = Array.isArray(flags.sources) ? flags.sources : [];
  const stats = { fetched: 0, parsed: 0, inserted: 0, sources: [] };
  for (const src of sources) {
    if (!src || !src.id || !src.url) continue;
    const r = await fetchFeed(src.url);
    if (!r.ok) {
      stats.sources.push({ id: src.id, ok: false, reason: r.reason });
      continue;
    }
    stats.fetched += 1;
    const items = parseFeed(r.body);
    stats.parsed += items.length;
    let inserted = 0;
    for (const it of items) {
      const cls = classify(it.title, it.summary);
      try {
        const res = await _db.query(
          `INSERT INTO aegis_algo_updates
              (source, title, url, summary, published_at, tags, severity, classified_at, raw)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8::jsonb)
            ON CONFLICT (source, url) DO UPDATE
              SET title = EXCLUDED.title,
                  summary = EXCLUDED.summary,
                  tags = EXCLUDED.tags,
                  severity = EXCLUDED.severity
            RETURNING (xmax = 0) AS inserted`,
          [src.id, it.title, it.url, it.summary, it.published_at,
           cls.tags, cls.severity, JSON.stringify({ source: src.id })]
        );
        if (res && res.rows && res.rows[0] && res.rows[0].inserted) inserted += 1;
      } catch (e) {
        // Индивидуальный сбой одной строки не должен валить весь источник.
        console.warn('[aegis/algoWatcher] insert failed:', e.message);
      }
    }
    stats.inserted += inserted;
    stats.sources.push({ id: src.id, ok: true, items: items.length, inserted });
  }
  return { ok: true, ...stats };
}

let _timer = null;
function startAlgoWatcher() {
  if (_timer) return;
  const flags = getAegisFlags().algoWatcher || {};
  if (!flags.enabled) return;
  const intervalSec = Number(flags.intervalSec) || 3600;
  // Первый прогон отложенно — даём bootstrap'у завершиться.
  setTimeout(() => runOnce().catch((e) => console.warn('[aegis/algoWatcher] first run:', e.message)), 30_000).unref?.();
  _timer = setInterval(() => {
    runOnce().catch((e) => console.warn('[aegis/algoWatcher] tick:', e.message));
  }, intervalSec * 1000);
  _timer.unref?.();
}

function stopAlgoWatcher() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  setDbConnection,
  parseFeed,
  classify,
  runOnce,
  startAlgoWatcher,
  stopAlgoWatcher,
};
