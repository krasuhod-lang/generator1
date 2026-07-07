'use strict';

/**
 * Генерация XLSX-файла с результатами SERP B2B-парсинга.
 * Использует exceljs (потоковый writer). Колонки масштабируются по
 * фактической ширине данных (auto-fit), кодировка — UTF-8 (родной формат
 * xlsx). Кириллица отображается корректно во всех версиях Excel/Numbers.
 */

const ExcelJS = require('exceljs');

const BASE_COLUMNS = [
  { header: 'Сайт',          key: 'url',          width: 32 },
  { header: 'Юр. лицо',      key: 'company_name', width: 36 },
  { header: 'Статус юр. лица', key: 'company_status', width: 18 },
  { header: 'Источник имени', key: 'company_name_source', width: 16 },
  { header: 'ИНН',           key: 'inn',          width: 16 },
  { header: 'ОГРН',          key: 'ogrn',         width: 18 },
  { header: 'КПП',           key: 'kpp',          width: 12 },
];

const TAIL_COLUMNS = [
  { header: 'Динамика Яндекс', key: 'dynamics_yandex', width: 22 },
  { header: 'Динамика Google', key: 'dynamics_google', width: 22 },
  { header: 'Контактная стр.', key: 'contact_url', width: 36 },
  { header: 'Статус',        key: 'status',       width: 14 },
  { header: 'Ошибка',        key: 'error',        width: 28 },
];

// Текст динамики видимости топ-50 (keys.so): рост / падение / стагнация
// с процентом отклонения первой и последней точки истории.
function _dynamicsText(d) {
  if (!d || !d.trend) return '';
  const label = d.trend === 'growth' ? 'рост' : d.trend === 'decline' ? 'падение' : 'стагнация';
  const pct = d.deviation_pct == null ? '' : ` (${d.deviation_pct > 0 ? '+' : ''}${d.deviation_pct}%)`;
  return `${label}${pct}`;
}

// Excel поддерживает максимум 16 384 колонки на лист. Извлечение контактов
// иногда захватывает аномально много телефонов/email с одного сайта (например,
// каталог номеров или ложные срабатывания регэкспа). Без ограничения такая
// строка раздувала число колонок за лимит Excel, и `writeBuffer()` падал с
// ошибкой «… is out of bounds» → HTTP 500 при скачивании. Ограничиваем число
// колонок в каждой группе; «лишние» значения склеиваются в последнюю колонку
// группы, поэтому данные не теряются.
const MAX_GROUP_COLUMNS = 25;

function _capCount(n) {
  const v = Number.isFinite(n) ? n : 1;
  return Math.min(Math.max(v, 1), MAX_GROUP_COLUMNS);
}

// Раскладывает массив значений по `count` ячейкам. Если значений больше, чем
// колонок, остаток склеивается через запятую в последнюю ячейку.
function _spread(values, count) {
  const arr = Array.isArray(values)
    ? values.filter((v) => v != null && v !== '')
    : [];
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i === count - 1 && arr.length > count) {
      out.push(arr.slice(i).join(', '));
    } else {
      out.push(arr[i] != null ? arr[i] : '');
    }
  }
  return out;
}

function _flat(item) {
  // Backward-compat: если split-полей нет (старые задачи), классифицируем
  // на лету по первому символу кода зоны.
  let mobile = Array.isArray(item.phones_mobile) ? item.phones_mobile : null;
  let landline = Array.isArray(item.phones_landline) ? item.phones_landline : null;
  if ((!mobile || !landline) && Array.isArray(item.phones)) {
    mobile = mobile || [];
    landline = landline || [];
    for (const p of item.phones) {
      const digits = String(p || '').replace(/\D+/g, '');
      const isMobile = digits.length >= 11 && digits[1] === '9';
      if (isMobile) {
        if (!mobile.includes(p)) mobile.push(p);
      } else if (!landline.includes(p)) {
        landline.push(p);
      }
    }
  }
  
  let emails = Array.isArray(item.emails) ? item.emails : (item.email ? item.email.split(',').map(e => e.trim()) : []);
  let services = Array.isArray(item.services) ? item.services : [];

  return {
    url:            item.url || '',
    company_name:   item.company_name || '',
    company_status: _statusLabel(item.company_status),
    company_name_source: _sourceLabel(item.company_name_source),
    inn:            item.inn || '',
    ogrn:           item.ogrn || '',
    kpp:            item.kpp || '',
    mobile,
    landline,
    emails,
    services,
    dynamics_yandex: _dynamicsText(item.dynamics && item.dynamics.yandex),
    dynamics_google: _dynamicsText(item.dynamics && item.dynamics.google),
    contact_url:    item.contact_url || '',
    status:         item.status || '',
    error:          item.error || '',
  };
}

// Человеко-читаемые лейблы для XLSX.
const _STATUS_LABELS = {
  ACTIVE:       'действует',
  LIQUIDATING:  'ликвидируется',
  LIQUIDATED:   'ликвидирована',
  BANKRUPT:     'банкрот',
  REORGANIZING: 'реорганизация',
};
function _statusLabel(s) {
  if (!s) return '';
  return _STATUS_LABELS[String(s).toUpperCase()] || String(s);
}
const _SOURCE_LABELS = {
  jsonld: 'JSON-LD',
  html:   'HTML',
  dadata: 'Dadata',
  llm:    'LLM',
};
function _sourceLabel(s) {
  if (!s) return '';
  return _SOURCE_LABELS[String(s).toLowerCase()] || String(s);
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

  const rows = (Array.isArray(task.results) ? task.results : []).map(_flat);

  let maxMobile = 1;
  let maxLandline = 1;
  let maxEmails = 1;
  let maxServices = 1;

  for (const r of rows) {
    if (r.mobile && r.mobile.length > maxMobile) maxMobile = r.mobile.length;
    if (r.landline && r.landline.length > maxLandline) maxLandline = r.landline.length;
    if (r.emails && r.emails.length > maxEmails) maxEmails = r.emails.length;
    if (r.services && r.services.length > maxServices) maxServices = r.services.length;
  }

  // Ограничиваем число колонок в каждой группе, чтобы суммарно не выйти за
  // лимит Excel (16 384 колонки) и не уронить генерацию файла.
  maxMobile = _capCount(maxMobile);
  maxLandline = _capCount(maxLandline);
  maxEmails = _capCount(maxEmails);
  maxServices = _capCount(maxServices);

  const columns = [...BASE_COLUMNS];
  for (let i = 0; i < maxMobile; i++) {
    columns.push({ header: `Сотовый ${i + 1}`, key: `phone_mobile_${i}`, width: 22 });
  }
  for (let i = 0; i < maxLandline; i++) {
    columns.push({ header: `Городской ${i + 1}`, key: `phone_landline_${i}`, width: 22 });
  }
  for (let i = 0; i < maxEmails; i++) {
    columns.push({ header: `Email ${i + 1}`, key: `email_${i}`, width: 32 });
  }
  for (let i = 0; i < maxServices; i++) {
    columns.push({ header: `Услуга ${i + 1}`, key: `service_${i}`, width: 40 });
  }
  columns.push(...TAIL_COLUMNS);

  const ws = wb.addWorksheet('Контакты', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns;

  // Заголовок — жирный + светло-серый фон.
  const header = ws.getRow(1);
  header.font = { bold: true, size: 11 };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F7' },
  };

  const finalRows = rows.map(r => {
    const flatR = { ...r };
    const mobileCells = _spread(r.mobile, maxMobile);
    const landlineCells = _spread(r.landline, maxLandline);
    const emailCells = _spread(r.emails, maxEmails);
    const serviceCells = _spread(r.services, maxServices);
    for (let i = 0; i < maxMobile; i++) flatR[`phone_mobile_${i}`] = mobileCells[i];
    for (let i = 0; i < maxLandline; i++) flatR[`phone_landline_${i}`] = landlineCells[i];
    for (let i = 0; i < maxEmails; i++) flatR[`email_${i}`] = emailCells[i];
    for (let i = 0; i < maxServices; i++) flatR[`service_${i}`] = serviceCells[i];
    return flatR;
  });

  for (const r of finalRows) ws.addRow(r);

  // Жирная граница под заголовком.
  ws.getRow(1).border = {
    bottom: { style: 'thin', color: { argb: 'FFD2D2D7' } },
  };

  // Перенос текста в широких колонках.
  const wrapKeys = ['company_name'];
  for (let i = 0; i < maxMobile; i++) wrapKeys.push(`phone_mobile_${i}`);
  for (let i = 0; i < maxLandline; i++) wrapKeys.push(`phone_landline_${i}`);
  for (let i = 0; i < maxEmails; i++) wrapKeys.push(`email_${i}`);
  for (let i = 0; i < maxServices; i++) wrapKeys.push(`service_${i}`);
  
  for (const colKey of wrapKeys) {
    const col = ws.getColumn(colKey);
    if (col) col.alignment = { wrapText: true, vertical: 'top' };
  }

  _autoFitWidths(ws, finalRows);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  buildXlsx,
};
