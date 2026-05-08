'use strict';

/**
 * factExtractor — извлечение «верифицируемых утверждений» из готового HTML
 * статьи (A1.1 плана «Усиление пайплайна "Комбайн"»).
 *
 * Цель: дать downstream-слою (factVerifier) минимальный набор claims
 * с координатами в исходнике, чтобы по нему можно было:
 *   1. сверить даты/нормативы с выдержками из топ-10 SERP;
 *   2. кросс-проверить ФИО/регалии через дополнительный поисковый запрос;
 *   3. понизить E-E-A-T порог при доле supported < min_supported_ratio.
 *
 * Это чистая (deterministic, без сетевых вызовов) функция — для последующей
 * LLM-обогащения можно прокинуть claims через отдельный enrichment-стейдж.
 *
 * Не путать с backend/src/utils/factCheck.js — тот ловит лишь числа,
 * которых нет в фактах бренда. Здесь шире: даты, нормативы, ФИО, проценты,
 * цены, числа-с-единицами.
 *
 * Возвращает массив объектов вида:
 *   { type, text, value?, paragraphIndex, charOffset, normativeKind? }
 *
 * Где type ∈ {
 *   'date'              — даты (любой год 1900–2099, ISO/RU форматы)
 *   'standard'          — ГОСТ / СНиП / ФЗ / СП / СанПиН + номер
 *   'percentage'        — проценты
 *   'price'             — цены (₽, руб., usd, $, eur, €)
 *   'number_with_unit'  — числа с единицами измерения (кг, м, см, ч и т.п.)
 *   'person'            — ФИО + (опционально) regalia в скобках/предлогах
 * }
 */

// ── Утилиты ─────────────────────────────────────────────────────────

/**
 * stripHtml — убирает теги, нормализует пробелы, схлопывает entities.
 * Сохраняет границы абзацев заменой блочных тегов на \n\n.
 */
function stripHtml(html) {
  if (!html) return '';
  // Single-pass entity decoder — без double-escaping: сначала именованные/
  // числовые entities, затем теги. Если бы делали `&amp;` → `&` отдельным
  // шагом до `&lt;` → `<`, то `&amp;lt;` превратилось бы в `<` (CodeQL
  // js/double-escaping). Здесь decode идёт за один проход по callback.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  let s = String(html)
    // блочные теги → разделитель абзацев (до очистки сущностей, чтобы
    // случайный `&lt;/p&gt;` не превратился в реальный </p> и не сломал split)
    .replace(/<\/(p|h[1-6]|li|ul|ol|blockquote|div|section|article|figure|figcaption|table|tr|thead|tbody|td|th)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');

  // Многократное снятие тегов — на случай вложенных артефактов вида
  // `<<script>>` (js/incomplete-multi-character-sanitization).
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, ' ');
  } while (s !== prev);

  // Любые остаточные одиночные «<»/«>» (например, из обрезанного тега) —
  // в пробел; иначе CodeQL справедливо считает strip неполным.
  s = s.replace(/[<>]/g, ' ');

  // Decode entities за один проход — без double-escape.
  s = s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? ' ' : ' ';
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? ' ' : ' ';
    }
    const lower = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, lower) ? ENTITIES[lower] : ' ';
  });

  return s.replace(/[\u00A0]/g, ' ');
}

/**
 * splitParagraphs — режет text на абзацы, возвращает [{index, text, offset}].
 * offset — позиция в исходной (text) строке. Это удобно для UI-привязки claim
 * к параграфу: можно подсветить.
 */
function splitParagraphs(text) {
  const paragraphs = [];
  if (!text) return paragraphs;
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let m;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].replace(/\s+/g, ' ').trim();
    if (t.length >= 2) {
      paragraphs.push({ index: idx, text: t, offset: m.index });
      idx += 1;
    }
  }
  return paragraphs;
}

// ── Регулярки для типов claims ──────────────────────────────────────

// Важно: JS `\b` — ASCII-only, для кириллицы не работает. Везде используем
// явные lookbehinds/lookaheads `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])` с
// флагом `u`, либо опираемся на пробел/пунктуацию.

const NLB = '(?<![\\p{L}\\p{N}])'; // not-letter-or-digit before
const NLA = '(?![\\p{L}\\p{N}])';  // not-letter-or-digit after

const RU_MONTHS = '(январ[яеь]|феврал[яеь]|март[ае]?|апрел[яеь]|ма[яе]|июн[яеь]|июл[яеь]|август[ае]?|сентябр[яеь]|октябр[яеь]|ноябр[яеь]|декабр[яеь])';

const DATE_PATTERNS = [
  // 12 марта 2024, 5 января 1999 г.
  new RegExp(`${NLB}\\d{1,2}\\s+${RU_MONTHS}\\s+(?:19|20)\\d{2}(?:\\s*г\\.?)?${NLA}`, 'giu'),
  // март 2024, январь 2025 г.
  new RegExp(`${NLB}${RU_MONTHS}\\s+(?:19|20)\\d{2}(?:\\s*г\\.?)?${NLA}`, 'giu'),
  // ISO 2024-03-12 / 2024.03.12 / 12.03.2024 / 12/03/2024
  new RegExp(`${NLB}(?:19|20)\\d{2}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}${NLA}`, 'gu'),
  new RegExp(`${NLB}\\d{1,2}[.\\-/]\\d{1,2}[.\\-/](?:19|20)\\d{2}${NLA}`, 'gu'),
  // Явные годы с маркером: «в 2024 году», «по состоянию на 2023 год»
  new RegExp(`${NLB}(?:в|с|до|по|на)\\s+(?:19|20)\\d{2}\\s*(?:год[ау]?|г\\.?)${NLA}`, 'giu'),
];

// Нормативы: ГОСТ, ГОСТ Р, СНиП, СП, СанПиН, ФЗ № NNN-ФЗ.
const STANDARD_PATTERNS = [
  { kind: 'gost',   re: new RegExp(`${NLB}ГОСТ(?:\\s+Р)?\\s*\\d+(?:[.\\-/]\\d+)*(?:-\\d{2,4})?${NLA}`, 'gu') },
  { kind: 'snip',   re: new RegExp(`${NLB}СНиП\\s*\\d+(?:[.\\-/]\\d+)*(?:-\\d{2,4})?${NLA}`, 'gu') },
  { kind: 'sp',     re: new RegExp(`${NLB}СП\\s*\\d+(?:[.\\-/]\\d+)*(?:-\\d{2,4})?${NLA}`, 'gu') },
  { kind: 'sanpin', re: new RegExp(`${NLB}СанПиН\\s*\\d+(?:[.\\-/]\\d+)*(?:-\\d{2,4})?${NLA}`, 'gu') },
  // Федеральный закон: «ФЗ № 152-ФЗ», «Федеральный закон № 152-ФЗ»
  { kind: 'fz',     re: new RegExp(`${NLB}(?:ФЗ|федеральн[ыо]м?\\s+закон[аеу]?)\\s*№?\\s*\\d+[\\-\\u2013]?ФЗ${NLA}`, 'giu') },
  // Технический регламент ТР ТС / ЕАЭС
  { kind: 'tr_ts',  re: new RegExp(`${NLB}ТР\\s*(?:ТС|ЕАЭС)\\s*\\d+\\/\\d{4}${NLA}`, 'gu') },
];

const PERCENT_RE = new RegExp(`${NLB}\\d{1,3}(?:[.,]\\d{1,3})?\\s?%`, 'gu');

// Цены: 1 500 ₽, 1500 руб., $99, 99 USD, 100€
const PRICE_PATTERNS = [
  new RegExp(`${NLB}\\d{1,3}(?:[ \\u00A0]?\\d{3})*(?:[.,]\\d{1,2})?\\s?(?:₽|руб(?:\\.|лей|ля|ль)?)${NLA}`, 'giu'),
  new RegExp(`${NLB}\\d{1,3}(?:[ \\u00A0]?\\d{3})*(?:[.,]\\d{1,2})?\\s?(?:USD|€|\\$|EUR)${NLA}`, 'giu'),
  new RegExp(`\\$\\s?\\d{1,3}(?:[ \\u00A0]?\\d{3})*(?:[.,]\\d{1,2})?${NLA}`, 'gu'),
];

// Числа с единицами измерения.
const UNITS_GROUP = '(?:кг|тонн[аы]?|т|г|мг|км|метр(?:ов|а)?|м|см|мм|л|мл|сек|с|мин|ч|час(?:ов|а)?|год(?:а|ов)?|лет|раз|шт|чел(?:овек)?|°C|°F|MHz|МГц|GHz|ГГц|МБ|кВт|Вт|А|В|Гц)';
const NUMBER_WITH_UNIT_RE = new RegExp(
  `${NLB}\\d{1,4}(?:[.,]\\d{1,3})?\\s?${UNITS_GROUP}${NLA}`,
  'gu',
);

// ФИО: Иванов И.И., Иванов Иван Иванович, проф. Иванов И.И.
const PERSON_PATTERNS = [
  // Surname I.I.   (может быть с маркером-должностью спереди)
  new RegExp(
    `${NLB}(?:проф\\.?|акад\\.?|д\\.[мбсхтэ]\\.?\\s?н\\.?|к\\.[мбсхтэ]\\.?\\s?н\\.?|доц\\.?|ph\\.?d\\.?|проф(?:ессор)?)?\\s*[А-ЯЁ][а-яё]+\\s+[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.${NLA}`,
    'gu',
  ),
  // I.I. Surname
  new RegExp(
    `${NLB}(?:проф\\.?|акад\\.?|д\\.[мбсхтэ]\\.?\\s?н\\.?|к\\.[мбсхтэ]\\.?\\s?н\\.?|доц\\.?|ph\\.?d\\.?|проф(?:ессор)?)?\\s*[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.\\s?[А-ЯЁ][а-яё]+${NLA}`,
    'gu',
  ),
  // Surname Firstname Patronymic
  new RegExp(
    `${NLB}[А-ЯЁ][а-яё]+\\s+[А-ЯЁ][а-яё]+\\s+[А-ЯЁ][а-яё]+(?:ович|евич|овна|евна|ична|инична)${NLA}`,
    'gu',
  ),
];

// ── Основная функция ───────────────────────────────────────────────

/**
 * extractClaims — пробегает по абзацам text-only представления html и
 * собирает claims всех типов. Дедупликация по (type, normalized_text)
 * в пределах абзаца.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string[]} [opts.types]  — ограничить какие типы извлекать
 * @returns {{ claims: Array, paragraphs: Array, summary: object }}
 */
function extractClaims(html, opts = {}) {
  const text = stripHtml(html);
  const paragraphs = splitParagraphs(text);
  const allowedTypes = opts.types && opts.types.length ? new Set(opts.types) : null;
  const allow = (t) => !allowedTypes || allowedTypes.has(t);

  const claims = [];

  function pushUnique(type, payload, paragraph, charOffset) {
    const norm = String(payload.text).toLowerCase().replace(/\s+/g, ' ').trim();
    const dupKey = `${type}::${norm}::${paragraph.index}`;
    if (claims.some((c) => c._dupKey === dupKey)) return;
    claims.push({
      type,
      text: payload.text,
      value: payload.value,
      normativeKind: payload.normativeKind,
      paragraphIndex: paragraph.index,
      charOffset,
      _dupKey: dupKey,
    });
  }

  for (const p of paragraphs) {
    if (allow('date')) {
      for (const re of DATE_PATTERNS) {
        const reLocal = new RegExp(re.source, re.flags);
        let m;
        while ((m = reLocal.exec(p.text)) !== null) {
          pushUnique('date', { text: m[0] }, p, p.offset + m.index);
        }
      }
    }
    if (allow('standard')) {
      for (const { kind, re } of STANDARD_PATTERNS) {
        const reLocal = new RegExp(re.source, re.flags);
        let m;
        while ((m = reLocal.exec(p.text)) !== null) {
          pushUnique('standard', { text: m[0], normativeKind: kind }, p, p.offset + m.index);
        }
      }
    }
    if (allow('percentage')) {
      const reLocal = new RegExp(PERCENT_RE.source, PERCENT_RE.flags);
      let m;
      while ((m = reLocal.exec(p.text)) !== null) {
        const numStr = m[0].replace(/[^\d.,]/g, '').replace(',', '.');
        pushUnique('percentage', { text: m[0], value: parseFloat(numStr) }, p, p.offset + m.index);
      }
    }
    if (allow('price')) {
      for (const re of PRICE_PATTERNS) {
        const reLocal = new RegExp(re.source, re.flags);
        let m;
        while ((m = reLocal.exec(p.text)) !== null) {
          pushUnique('price', { text: m[0] }, p, p.offset + m.index);
        }
      }
    }
    if (allow('number_with_unit')) {
      const reLocal = new RegExp(NUMBER_WITH_UNIT_RE.source, NUMBER_WITH_UNIT_RE.flags);
      let m;
      while ((m = reLocal.exec(p.text)) !== null) {
        pushUnique('number_with_unit', { text: m[0] }, p, p.offset + m.index);
      }
    }
    if (allow('person')) {
      for (const re of PERSON_PATTERNS) {
        const reLocal = new RegExp(re.source, re.flags);
        let m;
        while ((m = reLocal.exec(p.text)) !== null) {
          // отбраковка слишком общих слов: «Москва Иванов» — нет инициалов и нет
          // патронимического окончания → исходный pattern уже это соблюдает,
          // но дополнительно требуем, чтобы строка содержала хотя бы один
          // апостроф/инициал/окончание -ович/евич/овна/евна.
          const hit = m[0];
          const hasInitials = /[А-ЯЁ]\./.test(hit);
          const hasPatronymic = /(ович|евич|овна|евна|ична|инична)(?![\p{L}])/u.test(hit);
          if (!hasInitials && !hasPatronymic) continue;
          pushUnique('person', { text: hit.trim() }, p, p.offset + m.index);
        }
      }
    }
  }

  // Снимаем служебный _dupKey
  for (const c of claims) delete c._dupKey;

  // Summary
  const summary = claims.reduce(
    (acc, c) => {
      acc.byType[c.type] = (acc.byType[c.type] || 0) + 1;
      acc.total += 1;
      return acc;
    },
    { total: 0, byType: {} },
  );

  return { claims, paragraphs, summary };
}

module.exports = {
  extractClaims,
  // экспорт служебных функций — для тестов и для downstream verifier
  _internal: { stripHtml, splitParagraphs },
};
