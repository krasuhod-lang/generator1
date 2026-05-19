'use strict';

/**
 * forecaster/parser.js — парсер CSV/XLSX-выгрузок Wordstat.
 *
 * Принимает на вход «сырое» содержимое:
 *   • CSV-строка (Buffer/string) — парсим сами (поддержка кавычек и
 *     стандартных разделителей `; , \t |`),
 *   • либо уже-распарсенный JSON массив строк (rows: string[][]),
 *     полученный, например, на фронте через `read-excel-file` для XLSX.
 *
 * Делает autodetect-карту колонок:
 *   • phraseCol  — колонка с ключевой фразой (по эвристикам имени
 *     "фраза" | "запрос" | "phrase" | "query" | "keyword"),
 *   • totalCol   — колонка с общей частотностью (необязательная),
 *   • monthCols  — массив помесячных колонок: detect либо по дате
 *     заголовка ("2024-01", "01.2024", "янв.24", "янв'24", "Jan-24"…),
 *     либо по числовому суффиксу при последовательности из ≥6 колонок.
 *
 * На выходе возвращает структуру, которую дальше едят `series.js`
 * (агрегация) и пайплайн. Никаких сетевых вызовов.
 */

const MONTH_RU_MAP = {
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6,
  июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};
const MONTH_EN_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const PHRASE_HEADER_RE = /(фраз|запрос|ключев|phrase|query|keyword)/i;
const TOTAL_HEADER_RE  = /(общ|всег|baseline|total|базов|сумм|wordstat\b|ws\b|частотн)/i;
const QUOTE_HEADER_RE  = /(точн|"!"|"!\b|exact|кавыч)/i;

// ─── низкоуровневый CSV-парсер ─────────────────────────────────────
// Простой потоковый парсер: поддерживает кавычки ("…""…"), разделитель
// auto-detect по первой строке.
function _detectDelimiter(firstLine, candidates) {
  let best = ';';
  let bestCount = -1;
  for (const d of candidates) {
    // не считаем разделители внутри кавычек
    let inQ = false;
    let cnt = 0;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        inQ = !inQ;
      } else if (!inQ && ch === d) {
        cnt += 1;
      }
    }
    if (cnt > bestCount) {
      bestCount = cnt;
      best = d;
    }
  }
  return best;
}

function parseCsv(input, opts = {}) {
  const candidates = opts.delimiters || [';', ',', '\t', '|'];
  let text;
  if (Buffer.isBuffer(input)) {
    // снимаем BOM
    text = input.toString('utf8').replace(/^\uFEFF/, '');
  } else {
    text = String(input || '').replace(/^\uFEFF/, '');
  }
  if (!text.trim()) return [];

  // Нормализуем переводы строк
  text = text.replace(/\r\n?/g, '\n');

  // Определяем разделитель по первой непустой строке
  const firstLine = text.split('\n').find((ln) => ln.trim().length > 0) || '';
  const delim = _detectDelimiter(firstLine, candidates);

  const rows = [];
  let field = '';
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQ = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  // финальный хвост
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // удаляем полностью пустые строки
  return rows.filter((r) => r.some((c) => String(c).trim().length > 0));
}

// ─── parse header → period "YYYY-MM" ───────────────────────────────
function _parsePeriodFromHeader(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;

  // 1) ISO-формат YYYY-MM  или YYYY/MM или YYYY.MM
  let m = s.match(/(20\d{2}|19\d{2})[\-./](0?[1-9]|1[0-2])\b/);
  if (m) return _toPeriod(+m[1], +m[2]);

  // 2) MM[-./]YYYY (DD не учитываем — нас интересует месяц)
  m = s.match(/\b(0?[1-9]|1[0-2])[\-./](20\d{2}|19\d{2})\b/);
  if (m) return _toPeriod(+m[2], +m[1]);

  // 3) DD.MM.YYYY (берём только MM/YYYY)
  m = s.match(/\b\d{1,2}\.(0?[1-9]|1[0-2])\.(20\d{2}|19\d{2})\b/);
  if (m) return _toPeriod(+m[2], +m[1]);

  // 4) русские/английские месяцы:  "янв 2024", "янв.24", "янв'24",
  //    "Jan 2024", "Jan-24", "сент. 2025"
  m = s.match(/([а-яёa-z]{3,9})[\s\-'.]*((?:20|19)?\d{2})\b/);
  if (m) {
    const monKey = m[1].slice(0, 4); // достаточно 4 символов
    let monNum = MONTH_RU_MAP[monKey.slice(0, 3)] || MONTH_EN_MAP[monKey.slice(0, 3)];
    if (!monNum && monKey === 'mayм') monNum = 5;
    if (!monNum) monNum = MONTH_EN_MAP[monKey.slice(0, 4)];
    if (monNum) {
      let yr = parseInt(m[2], 10);
      if (yr < 100) yr += 2000;
      return _toPeriod(yr, monNum);
    }
  }
  return null;
}

function _toPeriod(year, month) {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ─── normalize number (русские "1 234,56" → 1234.56) ───────────────
function _parseNumber(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim();
  if (!s) return 0;
  // убираем неразрывные пробелы, обычные пробелы внутри числа
  s = s.replace(/[\u00A0\u202F\s]/g, '');
  // запятая → точка (десятичный разделитель в RU)
  s = s.replace(/,/g, '.');
  // отрезаем нечисловые суффиксы (например, "≈ 1500" / "до 200")
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : 0;
}

// ─── главный API ───────────────────────────────────────────────────
/**
 * Парсит входной CSV и возвращает нормализованную структуру.
 *
 * @param {Buffer|string|{rows:string[][]}} input
 * @param {Object} [opts]
 *   - filename:  имя файла для отчётности
 *   - rows:      готовый массив строк (для XLSX-режима с фронта)
 *   - delimiters: список кандидатов разделителей CSV
 * @returns {{
 *   filename: string,
 *   rowsCount: number,
 *   phraseCol: number|null,
 *   totalCol:  number|null,
 *   monthCols: Array<{index:number, header:string, period:string}>,
 *   rows: Array<Object>,  // {phrase, total, byPeriod:Map<period,number>}
 *   warnings: string[],
 * }}
 */
function parseForecasterInput(input, opts = {}) {
  const warnings = [];

  let table;
  if (input && Array.isArray(input.rows)) {
    table = input.rows.map((r) => r.map((v) => (v == null ? '' : String(v))));
  } else {
    table = parseCsv(input, opts);
  }
  if (table.length < 2) {
    return {
      filename: opts.filename || '',
      rowsCount: 0,
      phraseCol: null,
      totalCol: null,
      monthCols: [],
      rows: [],
      warnings: ['Файл пустой или содержит только заголовок'],
    };
  }

  const header = table[0].map((c) => String(c || '').trim());
  // ── Поиск колонки с фразой
  let phraseCol = header.findIndex((h) => PHRASE_HEADER_RE.test(h));
  if (phraseCol < 0) {
    // эвристика: первая «нечисловая» колонка с непустыми значениями
    for (let c = 0; c < header.length; c++) {
      let nonNumeric = 0;
      let nonEmpty = 0;
      for (let r = 1; r < Math.min(table.length, 30); r++) {
        const v = String(table[r][c] || '').trim();
        if (v) {
          nonEmpty += 1;
          if (!/^-?[\d\s.,]+$/.test(v)) nonNumeric += 1;
        }
      }
      if (nonEmpty >= 3 && nonNumeric / nonEmpty >= 0.6) {
        phraseCol = c;
        break;
      }
    }
  }
  if (phraseCol < 0) {
    warnings.push('Не удалось определить колонку с ключевой фразой — взята колонка 0');
    phraseCol = 0;
  }

  // ── Поиск месячных колонок по заголовку
  const monthCols = [];
  const periodsSeen = new Set();
  for (let c = 0; c < header.length; c++) {
    if (c === phraseCol) continue;
    const period = _parsePeriodFromHeader(header[c]);
    if (period && !periodsSeen.has(period)) {
      monthCols.push({ index: c, header: header[c], period });
      periodsSeen.add(period);
    }
  }
  // сортируем по периоду ASC
  monthCols.sort((a, b) => a.period.localeCompare(b.period));

  // ── Поиск totalCol (общая частотность) — необязательно
  let totalCol = -1;
  for (let c = 0; c < header.length; c++) {
    if (c === phraseCol) continue;
    if (monthCols.some((m) => m.index === c)) continue;
    if (TOTAL_HEADER_RE.test(header[c]) && !QUOTE_HEADER_RE.test(header[c])) {
      totalCol = c;
      break;
    }
  }

  if (monthCols.length === 0) {
    warnings.push('Не удалось определить помесячные колонки. Убедитесь, что в заголовке есть даты типа "2024-01", "Янв.24" или "01.2024".');
  }

  // ── Сборка строк
  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    if (!cells || cells.length === 0) continue;
    const phrase = String(cells[phraseCol] || '').trim();
    if (!phrase) continue;
    const total = totalCol >= 0 ? _parseNumber(cells[totalCol]) : 0;
    const byPeriod = {};
    for (const mc of monthCols) {
      const v = _parseNumber(cells[mc.index]);
      byPeriod[mc.period] = v;
    }
    rows.push({ phrase, total, byPeriod });
  }

  return {
    filename: opts.filename || '',
    rowsCount: rows.length,
    phraseCol,
    totalCol: totalCol >= 0 ? totalCol : null,
    monthCols,
    rows,
    warnings,
  };
}

module.exports = {
  parseForecasterInput,
  parseCsv,
  // экспортируем internals для тестов
  _parsePeriodFromHeader,
  _parseNumber,
};
