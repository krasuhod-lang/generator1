'use strict';

/**
 * Генерация XLSX-файла с результатами SERP B2B-парсинга.
 * Использует exceljs (потоковый writer). Колонки масштабируются по
 * фактической ширине данных (auto-fit), кодировка — UTF-8 (родной формат
 * xlsx). Кириллица отображается корректно во всех версиях Excel/Numbers.
 */

const ExcelJS = require('exceljs');

const COLUMNS = [
  { header: 'Сайт',          key: 'url',          width: 32 },
  { header: 'Юр. лицо',      key: 'company_name', width: 36 },
  { header: 'ИНН',           key: 'inn',          width: 16 },
  { header: 'ОГРН',          key: 'ogrn',         width: 18 },
  { header: 'КПП',           key: 'kpp',          width: 12 },
  { header: 'Телефон',       key: 'phone',        width: 22 },
  { header: 'Email',         key: 'email',        width: 32 },
  { header: 'Контактная стр.', key: 'contact_url', width: 36 },
  { header: 'Статус',        key: 'status',       width: 14 },
  { header: 'Ошибка',        key: 'error',        width: 28 },
];

function _flat(item) {
  return {
    url:          item.url || '',
    company_name: item.company_name || '',
    inn:          item.inn || '',
    ogrn:         item.ogrn || '',
    kpp:          item.kpp || '',
    phone:        Array.isArray(item.phones) ? item.phones.join(', ') : (item.phone || ''),
    email:        Array.isArray(item.emails) ? item.emails.join(', ') : (item.email || ''),
    contact_url:  item.contact_url || '',
    status:       item.status || '',
    error:        item.error || '',
  };
}

function _autoFitWidths(ws, rows) {
  // exceljs не умеет auto-fit «из коробки»; пробегаем по значениям и
  // выставляем ширину = max(длина по строкам, заданный минимум).
  ws.columns.forEach((col) => {
    let max = (col.header || '').length;
    for (const r of rows) {
      const v = r[col.key];
      if (v == null) continue;
      const s = String(v);
      if (s.length > max) max = s.length;
    }
    // Excel-условные единицы ≈ символы; ограничиваем сверху, чтобы
    // длиннющие email-цепочки не выдували колонку до 200 единиц.
    col.width = Math.min(60, Math.max(col.width || 12, max + 2));
  });
}

/**
 * Генерирует XLSX в Buffer.
 * @param {object} task — строка serp_b2b_tasks (нужны query, results)
 * @returns {Promise<Buffer>}
 */
async function buildXlsx(task) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEO Genius — SERP B2B Crawler';
  wb.created = new Date();

  const ws = wb.addWorksheet('Контакты', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = COLUMNS;

  // Заголовок — жирный + светло-серый фон.
  const header = ws.getRow(1);
  header.font = { bold: true, size: 11 };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F7' },
  };

  const rows = (Array.isArray(task.results) ? task.results : []).map(_flat);
  for (const r of rows) ws.addRow(r);

  // Жирная граница под заголовком.
  ws.getRow(1).border = {
    bottom: { style: 'thin', color: { argb: 'FFD2D2D7' } },
  };

  // Перенос текста в широких колонках.
  for (const colKey of ['email', 'phone', 'company_name']) {
    const col = ws.getColumn(colKey);
    col.alignment = { wrapText: true, vertical: 'top' };
  }

  _autoFitWidths(ws, rows);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  buildXlsx,
  COLUMNS,
};
