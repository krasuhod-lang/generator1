'use strict';

/**
 * categoryLead/filterParser.js — [A] СБОР ФИЛЬТРОВ.
 *
 * Два источника фасетной навигации категории:
 *   1) Ручной ввод (основной, надёжный): строка вида
 *      «Бренд: Samsung, LG; Цвет: красный, синий; Мощность: 100 Вт, 200 Вт».
 *   2) Best-effort парсинг HTML страницы категории (опционально): эвристика
 *      по контейнерам с class/id, содержащими filter/facet, + чекбоксы/лейблы.
 *
 * Парсинг чужого HTML ненадёжен по своей природе, поэтому любая ошибка сети /
 * разметки НЕ роняет пайплайн — возвращается пустой результат и пользователь
 * вводит фильтры вручную.
 */

const { getCategoryLeadConfig } = require('./config');

let _cheerio = null;
function getCheerio() {
  if (_cheerio === null) {
    try { _cheerio = require('cheerio'); } catch (_) { _cheerio = false; }
  }
  return _cheerio || null;
}

let _axios = null;
function getAxios() {
  if (_axios === null) {
    try { _axios = require('axios'); } catch (_) { _axios = false; }
  }
  return _axios || null;
}

function _clip(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Парсит ручной ввод фильтров в структуру групп.
 * Формат: «Группа: знач1, знач2; Группа2: знач3».
 * Разделитель групп — `;` или перевод строки; внутри группы значения — `,`.
 */
function parseManualFilters(raw) {
  const cfg = getCategoryLeadConfig().limits;
  if (Array.isArray(raw)) {
    // Уже структурировано: [{group, values:[]}] или [{name, values}]
    return _normalizeGroups(raw);
  }
  const text = String(raw || '');
  if (!text.trim()) return [];

  const groups = [];
  // Группы разделяем по ; и переводам строк (без regexp-backtracking рисков).
  const chunks = text.split(/[;\n\r]+/);
  for (const chunk of chunks) {
    const c = chunk.trim();
    if (!c) continue;
    const colon = c.indexOf(':');
    let group, valuesPart;
    if (colon === -1) {
      // Нет названия группы — трактуем как одно значение без группы.
      group = '';
      valuesPart = c;
    } else {
      group = c.slice(0, colon);
      valuesPart = c.slice(colon + 1);
    }
    const values = valuesPart.split(',')
      .map((v) => _clip(v, cfg.filterLabelLen))
      .filter(Boolean)
      .slice(0, cfg.maxFilterValues);
    groups.push({ group: _clip(group, cfg.filterLabelLen), values });
  }
  return _normalizeGroups(groups).slice(0, cfg.maxFilterGroups);
}

function _normalizeGroups(arr) {
  const cfg = getCategoryLeadConfig().limits;
  const out = [];
  const seen = new Set();
  for (const g of (arr || [])) {
    if (!g) continue;
    const group = _clip(g.group ?? g.name ?? '', cfg.filterLabelLen);
    let values = Array.isArray(g.values) ? g.values : [];
    values = values
      .map((v) => _clip(typeof v === 'object' && v ? (v.value ?? v.label ?? '') : v, cfg.filterLabelLen))
      .filter(Boolean);
    // Дедупликация значений внутри группы (case-insensitive).
    const vSeen = new Set();
    values = values.filter((v) => {
      const k = v.toLowerCase();
      if (vSeen.has(k)) return false;
      vSeen.add(k);
      return true;
    }).slice(0, cfg.maxFilterValues);
    if (!group && values.length === 0) continue;
    const key = group.toLowerCase();
    if (group && seen.has(key)) {
      // Слияние значений в существующую группу.
      const existing = out.find((o) => o.group.toLowerCase() === key);
      if (existing) {
        for (const v of values) {
          if (!existing.values.some((x) => x.toLowerCase() === v.toLowerCase())) {
            existing.values.push(v);
          }
        }
        continue;
      }
    }
    if (group) seen.add(key);
    out.push({ group, values });
  }
  return out;
}

/**
 * Best-effort извлечение фасетов из HTML-строки страницы категории.
 * Полностью graceful: при отсутствии cheerio или нераспознанной разметке
 * возвращает [].
 */
function extractFiltersFromHtml(html) {
  const cheerio = getCheerio();
  if (!cheerio || typeof html !== 'string' || !html) return [];
  const cfg = getCategoryLeadConfig();
  const limits = cfg.limits;

  let $;
  try { $ = cheerio.load(html); } catch (_) { return []; }

  const groups = [];
  const seenGroup = new Set();

  for (const sel of cfg.parser.facetSelectors) {
    let containers;
    try { containers = $(sel); } catch (_) { continue; }
    containers.each((_i, el) => {
      if (groups.length >= limits.maxFilterGroups) return false;
      const $el = $(el);
      // Название группы: ближайший заголовок/legend/первая текстовая метка.
      let groupName = '';
      const heading = $el.find('legend, h2, h3, h4, [class*="title" i]').first();
      if (heading && heading.text) groupName = _clip(heading.text(), limits.filterLabelLen);
      if (!groupName) {
        const aria = $el.attr('aria-label') || $el.attr('data-filter') || $el.attr('data-facet');
        if (aria) groupName = _clip(aria, limits.filterLabelLen);
      }

      const values = [];
      const vSeen = new Set();
      for (const vsel of cfg.parser.valueSelectors) {
        $el.find(vsel).each((_j, v) => {
          if (values.length >= limits.maxFilterValues) return false;
          const $v = $(v);
          let label = _clip($v.attr('aria-label') || $v.attr('value') || $v.text(), limits.filterLabelLen);
          // Чекбокс без текста — берём текст родительского label.
          if (!label && ($v.attr('type') === 'checkbox' || $v.attr('type') === 'radio')) {
            label = _clip($v.parent().text(), limits.filterLabelLen);
          }
          if (!label) return undefined;
          const k = label.toLowerCase();
          if (vSeen.has(k)) return undefined;
          // Отсекаем явный мусор: чисто числовые id, служебные «Показать ещё».
          if (/^\d+$/.test(label)) return undefined;
          vSeen.add(k);
          values.push(label);
          return undefined;
        });
      }

      if (values.length === 0) return undefined;
      const key = (groupName || `group_${groups.length}`).toLowerCase();
      if (seenGroup.has(key)) return undefined;
      seenGroup.add(key);
      groups.push({ group: groupName, values });
      return undefined;
    });
    if (groups.length >= limits.maxFilterGroups) break;
  }

  return _normalizeGroups(groups).slice(0, limits.maxFilterGroups);
}

/**
 * Скачивает страницу категории и извлекает фильтры. Graceful: любая ошибка →
 * { ok:false, groups:[], error }.
 */
async function fetchFiltersFromUrl(url) {
  const axios = getAxios();
  const cfg = getCategoryLeadConfig().parser;
  if (!axios) return { ok: false, groups: [], error: 'axios_unavailable' };

  let safeUrl;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, groups: [], error: 'bad_protocol' };
    }
    safeUrl = u.toString();
  } catch (_) {
    return { ok: false, groups: [], error: 'bad_url' };
  }

  try {
    const resp = await axios.get(safeUrl, {
      timeout: cfg.fetchTimeoutMs,
      maxContentLength: cfg.maxHtmlBytes,
      maxBodyLength: cfg.maxHtmlBytes,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CategoryLeadBot/1.0)' },
      // 4xx/5xx → treated as error by axios default; ловим в catch.
    });
    const html = typeof resp.data === 'string' ? resp.data : '';
    const groups = extractFiltersFromHtml(html);
    return { ok: groups.length > 0, groups, url: safeUrl };
  } catch (err) {
    return { ok: false, groups: [], error: err.message || 'fetch_failed', url: safeUrl };
  }
}

/**
 * Плоский список «сущностей» фильтров для подстановки в [СПИСОК_ФИЛЬТРОВ]
 * Прохода 1 и [CURRENT_FILTERS] Прохода 2.
 */
function renderFiltersForPrompt(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return '(фильтры не заданы)';
  return groups.map((g) => {
    const name = g.group || 'Без названия';
    const vals = (g.values || []).join(', ') || '—';
    return `- ${name}: ${vals}`;
  }).join('\n');
}

module.exports = {
  parseManualFilters,
  extractFiltersFromHtml,
  fetchFiltersFromUrl,
  renderFiltersForPrompt,
  _normalizeGroups,
};
