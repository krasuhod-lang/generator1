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
const ExcelJS = require('exceljs');

// Возможные заголовки колонок в локалях GSC (нижний регистр, по подстроке).
const HEADER_HINTS = {
  donor: ['linking site', 'сайт-источник', 'связывающий сайт', 'ссылающийся сайт',
    'ссылающие сайты', 'top linking sites', 'сайт'],
  targetPage: ['linked page', 'target page', 'destination page', 'связанная страница', 'целевая страница',
    'страница назначения', 'страница, на которую ведут ссылки', 'наиболее связываемые'],
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

function _cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.richText === 'object' && Array.isArray(value.richText)) {
      return value.richText.map((part) => part && part.text || '').join('');
    }
    if (value.hyperlink && value.text) return `${value.text} ${value.hyperlink}`;
  }
  return String(value);
}

function _headerMatch(header, hints) {
  const h = header.map((c) => _cellText(c).toLowerCase().trim());
  return hints.some((hint) => h.some((col) => col.includes(hint)));
}

/**
 * Определяет тип таблицы CSV по заголовку.
 * @returns {'sites'|'pages'|'anchors'|'unknown'}
 */
function detectTableType(header) {
  const normalized = (Array.isArray(header) ? header : []).map((c) => _cellText(c).toLowerCase().trim());
  const first = normalized[0] || '';
  // GSC exports identify the table primarily by the first column. This avoids
  // misclassifying Top Linking Sites because its third column is "Target pages".
  if (HEADER_HINTS.anchor.some((hint) => first.includes(hint))) return 'anchors';
  if (HEADER_HINTS.targetPage.some((hint) => first.includes(hint))) return 'pages';
  if (HEADER_HINTS.donor.some((hint) => first.includes(hint))) return 'sites';
  // Fallback for exports with a decorative/empty first header cell.
  if (_headerMatch(header, HEADER_HINTS.anchor)) return 'anchors';
  if (_headerMatch(header, HEADER_HINTS.targetPage)) return 'pages';
  if (_headerMatch(header, HEADER_HINTS.donor)) return 'sites';
  return 'unknown';
}

function _toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const n = parseInt(_cellText(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function _normalizeMatrix(matrix, cfg) {
  if (!Array.isArray(matrix) || matrix.length < 2) return { type: 'unknown', rows: [], count: 0 };
  const header = matrix[0] || [];
  const type = detectTableType(header);
  const body = matrix.slice(1, 1 + (cfg.importMaxRows || 20000));
  const rows = [];
  for (const rawRow of body) {
    const r = Array.isArray(rawRow) ? rawRow : [];
    const c0 = _cellText(r[0]).trim();
    if (!c0) continue;
    const links = _toInt(r[1]);
    if (type === 'anchors') rows.push({ anchor: c0, links });
    else if (type === 'pages') rows.push({ target_page: c0, links, referring_sites: _toInt(r[2]) });
    else if (type === 'sites') rows.push({ donor: c0, links, target_pages: _toInt(r[2]) });
    else rows.push({ value: c0, links });
  }
  return { type, rows, count: rows.length };
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
  return _normalizeMatrix(matrix, cfg);
}

async function importLinksXlsx(buffer) {
  const cfg = getProjectsConfig().linkStrategy;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  let selected = null;
  workbook.eachSheet((worksheet) => {
    if (selected) return;
    const matrix = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (values.some((value) => _cellText(value).trim() !== '')) matrix.push(values);
    });
    if (matrix.length >= 2 && detectTableType(matrix[0]) !== 'unknown') {
      selected = { sheet: worksheet.name, parsed: _normalizeMatrix(matrix, cfg) };
    }
  });

  if (!selected) return { type: 'unknown', rows: [], count: 0, sheet: null };
  return { ...selected.parsed, sheet: selected.sheet, format: 'xlsx' };
}

module.exports = { parseCsv, importLinksCsv, importLinksXlsx, detectTableType, HEADER_HINTS };
