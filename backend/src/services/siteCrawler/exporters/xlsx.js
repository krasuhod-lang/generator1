'use strict';

/**
 * siteCrawler/exporters/xlsx.js — экспорт результатов краулинга в XLSX
 * через ExcelJS (уже есть в backend/package.json). Стримит в res.
 *
 * Колонки строятся из headers, либо берутся ключи первой строки.
 * Заголовочная строка — жирная. Авто-фильтр включён. Ширина — auto-by-content
 * (для коротких полей), c capping 80.
 */

const ExcelJS = require('exceljs');

async function streamXlsx(rows, opts, res) {
  const headers = (opts && opts.headers) || (rows && rows.length ? Object.keys(rows[0]) : []);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet(opts && opts.sheet ? opts.sheet : 'pages');
  ws.columns = headers.map((h) => ({
    header: h,
    key: h,
    width: Math.min(80, Math.max(10, h.length + 2)),
  }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  for (const r of (rows || [])) {
    const out = {};
    for (const h of headers) {
      let v = r[h];
      if (v == null) v = '';
      else if (typeof v === 'object') v = JSON.stringify(v);
      else if (typeof v === 'string' && v.length > 32000) v = v.slice(0, 32000);
      out[h] = v;
    }
    ws.addRow(out).commit();
  }
  await ws.commit();
  await wb.commit();
}

module.exports = { streamXlsx };
