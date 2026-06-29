'use strict';

/**
 * siteCrawler/robotsClient.js — мини-парсер robots.txt с кешем по хосту
 * (задача 3). Только то, что нужно нашему BFS:
 *   - находит группы по User-agent (нашему UA + '*');
 *   - применяет правила Disallow / Allow по «longest match wins»;
 *   - поддерживает wildcard '*' и якорь '$' в значениях правил;
 *   - возвращает {allowed:boolean, crawlDelayMs:number|null}.
 *
 * Полный RFC9309 не требуется: высокоприоритетные краулеры (Google/Yandex)
 * имеют свои нюансы, но мы здесь — добропорядочный «сканер для аудита».
 */

const axios = require('axios');
const { assertPublicHost } = require('./ssrfGuard');

const CACHE = new Map();                  // host → { rules, fetchedAt }
const CACHE_TTL_MS = 60 * 60 * 1000;      // 1 час
const DEFAULT_UA = 'EgidaSiteCrawler';

function _parseRobots(text) {
  // → { groups: [ { agents:[], rules:[{type:'allow'|'disallow', pattern}], crawlDelay } ] }
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (field === 'disallow')  current.rules.push({ type: 'disallow', pattern: value });
      else if (field === 'allow') current.rules.push({ type: 'allow',    pattern: value });
      else if (field === 'crawl-delay') {
        const n = Number(value);
        if (Number.isFinite(n)) current.crawlDelay = n;
      }
    }
  }
  return { groups };
}

function _selectGroup(parsed, ua) {
  const uaLow = String(ua || '').toLowerCase();
  let best = null;       // конкретный UA
  let star = null;       // wildcard
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === '*') { star = g; continue; }
      if (uaLow.includes(a)) { best = g; }
    }
  }
  return best || star || null;
}

function _patternToRegex(pat) {
  // Конвертация robots-pattern в RegExp:
  //   '*' → '.*', '$' в конце → конец строки. Спец-символы экранируем.
  if (!pat) return null;
  let p = pat;
  let anchorEnd = false;
  if (p.endsWith('$')) { anchorEnd = true; p = p.slice(0, -1); }
  let re = '';
  for (const ch of p) {
    if (ch === '*') re += '.*';
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + (anchorEnd ? '$' : ''));
}

/**
 * isAllowed(pathOrUrl, parsed, ua) — pure.
 * Берёт самое длинное совпавшее правило; при равной длине allow > disallow.
 * Если правил нет — true.
 */
function isAllowed(pathOrUrl, parsed, ua = DEFAULT_UA) {
  if (!parsed || !parsed.groups || !parsed.groups.length) return true;
  const grp = _selectGroup(parsed, ua);
  if (!grp || !grp.rules.length) return true;
  let path = pathOrUrl;
  try { const u = new URL(pathOrUrl); path = u.pathname + (u.search || ''); } catch (_) {}
  let bestLen = -1;
  let decision = true;          // по умолчанию разрешено
  for (const r of grp.rules) {
    // Пустой Disallow в стандарте → «всё разрешено» (правило игнорируется
    // для матчинга, но фиксирует, что робот может ходить).
    if (r.type === 'disallow' && r.pattern === '') continue;
    const re = _patternToRegex(r.pattern);
    if (!re) continue;
    if (!re.test(path)) continue;
    const len = r.pattern.length;
    if (len > bestLen || (len === bestLen && r.type === 'allow')) {
      bestLen  = len;
      decision = (r.type === 'allow');
    }
  }
  return decision;
}

/** Достаёт robots.txt с TTL-кешем. На ошибки → пустой parsed (= всё разрешено). */
async function getRules(origin, opts = {}) {
  const ua = opts.ua || DEFAULT_UA;
  const u = new URL(origin);
  const key = u.protocol + '//' + u.host;
  const now = Date.now();
  const cached = CACHE.get(key);
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) return cached.rules;
  let parsed = { groups: [] };
  try {
    // SSRF guard: hostname должен резолвиться в публичный IP. Иначе вернём
    // пустые правила (allow-all) — но запроса не делаем. Это страхует от
    // случая, когда robotsClient вызывается отдельно от crawler.runCrawl.
    await assertPublicHost(u.hostname);
    const res = await axios.get(key + '/robots.txt', {
      timeout: opts.timeout || 8000,
      maxContentLength: 1024 * 1024,
      headers: { 'User-Agent': ua },
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      parsed = _parseRobots(res.data);
    }
  } catch (_) { /* ignore — fail-open */ }
  CACHE.set(key, { rules: parsed, fetchedAt: now });
  return parsed;
}

function _clearCache() { CACHE.clear(); }

module.exports = {
  isAllowed,
  getRules,
  // экспорт для тестов
  _parseRobots,
  _selectGroup,
  _patternToRegex,
  _clearCache,
  DEFAULT_UA,
};
