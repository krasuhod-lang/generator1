'use strict';

/**
 * linkStrategy/linksImporter — парсинг CSV-выгрузки «Ссылки» из Google Search
 * Console UI (п.1, п.2 ТЗ). Search Analytics API НЕ отдаёт отчёт «Ссылки»,
 * поэтому пользователь выгружает CSV из GSC → «Ссылки» → одну из таблиц:
 *   • Top linking sites  (сайты-доноры → кол-во ссылок / целевых страниц)
 *   • Top linked pages   (наши страницы → кол-во входящих ссылок)
 *   • Top linking text   (анкоры → частота)
 *
 * Детерминированный парсер автоопределяет тип таблицы по заголовку столбцов
 * (рус/eng локали GSC) и нормализует строки в единый формат для хранения в
 * project_gsc_links и анализа. Без сети, graceful.
 */

const { getProjectsConfig } = require('../config');

// Возможные заголовки колонок в локалях GSC (нижний регистр, по подстроке).
const HEADER_HINTS = {
  donor: ['linking site', 'сайт-источник', 'связывающий сайт', 'ссылающийся сайт',
    'ссылающие сайты', 'top linking sites'],
  targetPage: ['linked page', 'target page', 'связанная страница', 'целевая страница',
    'страница, на которую ведут ссылки', 'наиболее связываемые'],
  anchor: ['linking text', 'anchor', 'текст ссылки', 'анкор', 'связывающий текст'],
  linkCount: ['linking sites', 'links', 'ссылки', 'кол-во ссылок', 'число ссылок',
    'target pages', 'целевые страницы'],
};

/**
 * Минимальный CSV-парсер с поддержкой кавычек и запятых/точек-с-запятой.
 * @returns {string[][]} матрица строк
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, ''); // strip BOM
  const delim = _detectDelimiter(src);
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch === '\r') {
      // ignore (CRLF)
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function _detectDelimiter(src) {
  const head = src.split('\n')[0] || '';
  const semis = (head.match(/;/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  const tabs = (head.match(/\t/g) || []).length;
  if (tabs >= semis && tabs >= commas) return '\t';
  return semis > commas ? ';' : ',';
}

function _headerMatch(header, hints) {
  const h = header.map((c) => String(c).toLowerCase().trim());
  return hints.some((hint) => h.some((col) => col.includes(hint)));
}

/**
 * Определяет тип таблицы CSV по заголовку.
 * @returns {'sites'|'pages'|'anchors'|'unknown'}
 */
function detectTableType(header) {
  if (_headerMatch(header, HEADER_HINTS.anchor)) return 'anchors';
  if (_headerMatch(header, HEADER_HINTS.targetPage)) return 'pages';
  if (_headerMatch(header, HEADER_HINTS.donor)) return 'sites';
  return 'unknown';
}

function _toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Парсит CSV-выгрузку и возвращает нормализованные строки + метаданные.
 *
 * @param {string} csvText
 * @returns {{type, rows:Array, count:number}}
 *   row для 'sites':   { donor, links }
 *   row для 'pages':   { target_page, links }
 *   row для 'anchors': { anchor, links }
 */
function importLinksCsv(csvText) {
  const cfg = getProjectsConfig().linkStrategy;
  const matrix = parseCsv(csvText);
  if (matrix.length < 2) return { type: 'unknown', rows: [], count: 0 };
  const header = matrix[0];
  const type = detectTableType(header);
  const body = matrix.slice(1, 1 + (cfg.importMaxRows || 20000));

  const rows = [];
  for (const r of body) {
    const c0 = String(r[0] || '').trim();
    if (!c0) continue;
    const links = _toInt(r[1] != null ? r[1] : 0);
    if (type === 'anchors') rows.push({ anchor: c0, links });
    else if (type === 'pages') rows.push({ target_page: c0, links });
    else if (type === 'sites') rows.push({ donor: c0, links });
    else rows.push({ value: c0, links }); // unknown: keep raw
  }
  return { type, rows, count: rows.length };
}

module.exports = { parseCsv, detectTableType, importLinksCsv, HEADER_HINTS };
