'use strict';

/**
 * naturalnessCheck.js — детекторы «неестественности» сгенерированного текста.
 *
 * Адресуют конкретные жалобы пользователя:
 *   1. «Рубленый» синтаксис (роботизированность) — серии коротких простых
 *      предложений без союзов и оборотов.
 *   2. SEO-переспам — raw-вхождения ключей без склонения, SEO-хвосты вида
 *      «<ключ> топ места», «<ключ> мини группа».
 *   6. Тавтологии («масло масляное») — смежные повторы одной основы слова
 *      («место сбора и точка сбора»).
 *
 * Все функции работают с HTML на входе: теги предварительно снимаются.
 * Отсутствие каких-либо внешних зависимостей; использовать в Stage 3
 * pre-check и Stage 5 special instructions.
 */

const { russianStem: stem } = require('./russianStem');

// ── Конфигурация порогов ────────────────────────────────────────────
const SHORT_SENTENCE_CHARS = 65;   // < 65 символов и без подчинительных связок = «рубленое»
const RUN_OF_SHORT_LIMIT   = 3;    // 3+ подряд коротких простых предложений = роботизированность
const REDUNDANCY_WINDOW    = 6;    // окно слов для поиска тавтологий (соседние повторы основ)
const MIN_STEM_LEN         = 4;    // короче этой длины основа не считается значимой
// Типичные «топорные» SEO-хвосты, прилипшие без склонения.
// ВАЖНО: \b в JS regex основан на ASCII \w, поэтому для кириллицы
// он работает некорректно. Используем явные lookbehind/lookahead с
// «не-буквенным» классом, покрывающим и латиницу, и кириллицу.
const NON_LETTER = '(?:^|[^A-Za-zА-Яа-яЁё])';
const NON_LETTER_END = '(?=$|[^A-Za-zА-Яа-яЁё])';
const SEO_TAIL_PATTERNS = [
  new RegExp(NON_LETTER + 'топ\\s+мест[аыо]?' + NON_LETTER_END, 'gi'),
  new RegExp(NON_LETTER + 'цен[ыа]\\s+отзыв[ыа]' + NON_LETTER_END, 'gi'),
  new RegExp(NON_LETTER + 'купить\\s+недорого' + NON_LETTER_END, 'gi'),
  new RegExp(NON_LETTER + 'в\\s+мини\\s+групп[еыа]?' + NON_LETTER_END, 'gi'), // «в мини группе» без дефиса
  new RegExp(NON_LETTER + '(?:заказать|купить|услуг[ауи])\\s+(?:в|по)\\s+[А-ЯЁ][а-яё]+\\s+(?:недорого|дёшево|быстро|онлайн)' + NON_LETTER_END, 'gi'),
];

// Союзы и связки — индикатор того, что предложение НЕ «рубленое»
const COMPLEX_SENTENCE_MARKERS = [
  ' который', ' которая', ' которое', ' которые',
  ' что ', ' чтобы', ' если', ' когда', ' пока',
  ' потому что', ' поскольку', ' так как', ' благодаря', ' из-за',
  ' несмотря', ' хотя', ' однако', ' тогда как',
  // Причастные/деепричастные обороты — наличие «-ющ-/-ящ-/-вш-/-ш-» в середине
];
const PARTICIPLE_REGEX = /\b\w+(?:ющ|ящ|ущ|ивш|евш|авш|нувш|вши|вая|щая|щий|щее|щие)\w*\b/i;

/**
 * stripTags — снимает HTML-теги, склеивает пробелы.
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * splitSentences — разбивает текст на предложения по терминаторам .!?
 * Игнорирует одиночные точки в аббревиатурах (просто эвристика, не AST).
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text) return [];
  // Защита аббревиатур: «т.д.», «т.е.», «и т.п.» → склеиваем
  const guarded = text
    .replace(/\bт\.\s*д\b/gi, 'тд')
    .replace(/\bт\.\s*е\b/gi, 'те')
    .replace(/\bт\.\s*п\b/gi, 'тп')
    .replace(/\bи\s+др\./gi, 'идр');
  return guarded
    .split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * isComplexSentence — содержит ли предложение союз/оборот, увеличивающий «гладкость».
 * @param {string} sentence
 * @returns {boolean}
 */
function isComplexSentence(sentence) {
  if (!sentence) return false;
  const s = ' ' + sentence.toLowerCase() + ' ';
  if (COMPLEX_SENTENCE_MARKERS.some(m => s.includes(m))) return true;
  if (PARTICIPLE_REGEX.test(sentence)) return true;
  // Запятые часто маркируют сложные конструкции
  const commaCount = (sentence.match(/,/g) || []).length;
  return commaCount >= 2;
}

/**
 * detectChoppyRuns — ищет серии 3+ подряд коротких простых предложений.
 * Это ключевой маркер «роботизированности».
 *
 * @param {string} html
 * @returns {{ count: number, examples: string[] }}
 *   count    — общее число «рубленых» серий
 *   examples — до 3 примеров для подсказки LLM при рефайне
 */
function detectChoppyRuns(html) {
  const text = stripTags(html);
  const sentences = splitSentences(text);
  const examples = [];
  let count = 0;
  let run = [];

  const flush = () => {
    if (run.length >= RUN_OF_SHORT_LIMIT) {
      count++;
      if (examples.length < 3) {
        examples.push(run.join(' ').slice(0, 280));
      }
    }
    run = [];
  };

  for (const s of sentences) {
    if (s.length < SHORT_SENTENCE_CHARS && !isComplexSentence(s)) {
      run.push(s);
    } else {
      flush();
    }
  }
  flush();

  return { count, examples };
}

/**
 * detectRedundancies — ищет смежные повторы одной основы слова в окне
 * REDUNDANCY_WINDOW слов. Пример: «место сбора и точка сбора» → основа «сбор»
 * встречается дважды в окне 4 слов → тавтология.
 *
 * @param {string} html
 * @returns {{ pairs: Array<{ stem: string, snippet: string }> }}
 */
function detectRedundancies(html) {
  const text = stripTags(html).toLowerCase();
  // Берём только слова длиной >= MIN_STEM_LEN (короткие — служебные)
  const tokens = text.match(/[а-яёa-z]+/gi) || [];
  const stems = tokens.map(t => stem(t));

  const seen = new Map(); // stem → last index
  const pairs = [];
  const reported = new Set();

  for (let i = 0; i < stems.length; i++) {
    const st = stems[i];
    if (!st || st.length < MIN_STEM_LEN) continue;
    if (seen.has(st)) {
      const prev = seen.get(st);
      // Соседние повторы в близком окне = тавтология (не общее повторение по тексту)
      if (i - prev <= REDUNDANCY_WINDOW && !reported.has(st)) {
        // Извлекаем сниппет: prev-1..i+1 слов из исходных tokens
        const from = Math.max(0, prev - 1);
        const to   = Math.min(tokens.length, i + 2);
        const snippet = tokens.slice(from, to).join(' ');
        pairs.push({ stem: st, snippet });
        reported.add(st);
      }
    }
    seen.set(st, i);
  }

  return { pairs };
}

/**
 * detectSeoTails — ищет «топорные» SEO-хвосты, прилипшие без склонения.
 * @param {string} html
 * @returns {{ matches: string[] }}
 */
function detectSeoTails(html) {
  const text = stripTags(html);
  const matches = new Set();
  for (const re of SEO_TAIL_PATTERNS) {
    const found = text.match(re);
    if (found) found.forEach(m => matches.add(m.toLowerCase().trim()));
  }
  return { matches: Array.from(matches) };
}

/**
 * detectRawKeywordRepetition — ищет raw-вхождения целевого ключа
 * (без падежных изменений) с подозрительной частотой. Это сигнал
 * SEO-стаффинга: ключ просто «лепят», а не пишут естественно.
 *
 * Логика: если ключ из 2+ слов встречается 3+ раз в одной и той же
 * грамматической форме — это переспам.
 *
 * @param {string} html
 * @param {string} mainQuery — основной запрос (input_target_service)
 * @returns {{ stuffed: string[] }}
 */
function detectRawKeywordRepetition(html, mainQuery) {
  if (!mainQuery || typeof mainQuery !== 'string') return { stuffed: [] };
  const text = stripTags(html).toLowerCase();
  const phrase = mainQuery.toLowerCase().trim();
  // Берём только многословные ключи (одно слово = норма повторять)
  const words = phrase.split(/\s+/).filter(w => w.length > 2);
  if (words.length < 2) return { stuffed: [] };

  // \b ненадёжен для кириллицы → используем явные не-буквенные границы
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(NON_LETTER + escaped + NON_LETTER_END, 'gi');
  const count = (text.match(re) || []).length;
  // Порог 3: 1-2 раза — норма, 3+ в одной и той же форме = stuffing
  return { stuffed: count >= 3 ? [`«${mainQuery}» ${count}× без склонений`] : [] };
}

/**
 * runNaturalnessChecks — агрегатор. Возвращает объединённый отчёт + готовые
 * подсказки на русском для подстановки в SPECIAL_INSTRUCTION Stage 5.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.mainQuery] — основной запрос для проверки SEO-стаффинга
 * @returns {{
 *   passed: boolean,
 *   issues: string[],
 *   instructionFragment: string,
 *   details: { choppy: object, redundancies: object, seoTails: object, kwRepetition: object }
 * }}
 */
function runNaturalnessChecks(html, opts = {}) {
  const { mainQuery = '' } = opts;
  const choppy        = detectChoppyRuns(html);
  const redundancies  = detectRedundancies(html);
  const seoTails      = detectSeoTails(html);
  const kwRepetition  = detectRawKeywordRepetition(html, mainQuery);

  const issues = [];
  const instructionParts = [];

  if (choppy.count > 0) {
    issues.push(`Роботизированный синтаксис: ${choppy.count} серий коротких простых предложений`);
    instructionParts.push(
      'РОБОТИЗИРОВАННОСТЬ: Найдены серии 3+ подряд коротких простых предложений ' +
      '(пример: «' + (choppy.examples[0] || '').slice(0, 180) + '»). ' +
      'Объедини их в сложные конструкции через союзы (который, что, чтобы), ' +
      'причастные («возвышающиеся над водой») и деепричастные («создавая декорации») обороты. ' +
      'Цель: естественная вариация длины предложений.'
    );
  }
  if (redundancies.pairs.length > 0) {
    const examples = redundancies.pairs.slice(0, 3).map(p => `«${p.snippet}»`).join('; ');
    issues.push(`Тавтологии (повтор основы): ${redundancies.pairs.length}`);
    instructionParts.push(
      `ТАВТОЛОГИИ: Найдены смежные повторы одной основы: ${examples}. ` +
      'Удали лишние повторы или замени синонимами. ' +
      'Пример: «место сбора и точка сбора» → «место сбора группы» или «пункт встречи».'
    );
  }
  if (seoTails.matches.length > 0) {
    issues.push(`Топорные SEO-хвосты: ${seoTails.matches.join(', ')}`);
    instructionParts.push(
      `SEO-ХВОСТЫ: Найдены неестественные SEO-склейки: ${seoTails.matches.join(', ')}. ` +
      'Перепиши эти места естественным языком. Поисковик понимает морфологию — ' +
      'склоняй ключи и разбавляй синонимами вместо raw-вставки.'
    );
  }
  if (kwRepetition.stuffed.length > 0) {
    issues.push(`SEO-переспам ключа: ${kwRepetition.stuffed.join(', ')}`);
    instructionParts.push(
      `ПЕРЕСПАМ КЛЮЧА: ${kwRepetition.stuffed.join(', ')}. ` +
      'Сократи прямые повторы, замени на склонения, синонимы или местоимения. ' +
      'Естественный текст не повторяет одну и ту же фразу 3+ раз.'
    );
  }

  return {
    passed:  issues.length === 0,
    issues,
    instructionFragment: instructionParts.join('\n'),
    details: { choppy, redundancies, seoTails, kwRepetition },
  };
}

module.exports = {
  runNaturalnessChecks,
  detectChoppyRuns,
  detectRedundancies,
  detectSeoTails,
  detectRawKeywordRepetition,
  // expose constants for tests/tuning
  SHORT_SENTENCE_CHARS,
  RUN_OF_SHORT_LIMIT,
  REDUNDANCY_WINDOW,
};
