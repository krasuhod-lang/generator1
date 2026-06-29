'use strict';

/**
 * siteCrawler/exporters/csv.js — RFC4180-совместимый CSV-экспортёр
 * (задача 3, требование «выгрузка CSV для Excel»).
 *
 * - разделитель ','
 * - кавычки '"', экранирование удвоением
 * - перенос строки CRLF
 * - в первой строке заголовки колонок (если headers переданы)
 * - впереди BOM \ufeff, чтобы Excel корректно открывал UTF-8
 *
 * pure: возвращает строку. Стримить будем в контроллере через res.write.
 */

function _escapeCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Нужна ли кавычка: запятая, кавычка, CR, LF
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(rows, opts = {}) {
  const headers = opts.headers || (rows && rows.length ? Object.keys(rows[0]) : []);
  const bom = opts.bom !== false ? '\ufeff' : '';
  const lines = [];
  lines.push(headers.map(_escapeCell).join(','));
  for (const r of (rows || [])) {
    lines.push(headers.map((h) => _escapeCell(r[h])).join(','));
  }
  return bom + lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

/** TSV для копирования в Excel/Sheets через буфер обмена (задача 3:
 *  «копирование в Excel»). Без BOM, разделитель \t, кавычки только
 *  если значение содержит \t/\n. */
function buildTsv(rows, opts = {}) {
  const headers = opts.headers || (rows && rows.length ? Object.keys(rows[0]) : []);
  function cell(v) {
    if (v == null) return '';
    let s = String(v);
    if (/[\t\r\n"]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  const lines = [];
  lines.push(headers.map(cell).join('\t'));
  for (const r of (rows || [])) {
    lines.push(headers.map((h) => cell(r[h])).join('\t'));
  }
  return lines.join('\r\n');
}

module.exports = { buildCsv, buildTsv, _escapeCell };
