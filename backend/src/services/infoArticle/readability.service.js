'use strict';

/**
 * readability.service — Phase 2 / Б4. Детерминированный анализатор
 * читабельности русскоязычной статьи.
 *
 * Назначение: после writer'а (и после возможного refine-loop'а) посчитать
 * программные метрики «как читается текст»:
 *   • индекс читабельности (адаптация Флеша для русского, по Тулдаве:
 *     ARI = 6.26 + 0.2805 × (chars/words) + 0.2805 × (words/sentences)
 *     — но мы используем шкалу «понятности» 0..100, где >60 — норм,
 *     <30 — тяжело);
 *   • средняя длина предложения (слов);
 *   • доля «длинных» предложений (>30 слов) — «стена слов»;
 *   • доля канцелярита (по словарю маркеров: «осуществлять», «является»,
 *     «в случае если» и т.п.);
 *   • доля пассива по морфологическим суффиксам (-ен/-ан/-ован/-ирован).
 *
 * Контракт без LLM:
 *   • быстро (<50ms на статью), детерминировано, без сети;
 *   • никогда не валит pipeline (только soft warnings).
 *
 * Гейтировано env'ом INFO_ARTICLE_READABILITY_ENABLED (default ON).
 * Пороги — env-overridable (READABILITY_*), но сейчас без правки .env.example.
 */

const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Параметры (env-overridable) ────────────────────────────────────────

const MIN_READABILITY_INDEX = (() => {
  const v = parseFloat(process.env.READABILITY_MIN_INDEX);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 40;
})();

const MAX_AVG_SENTENCE_LEN = (() => {
  const v = parseFloat(process.env.READABILITY_MAX_AVG_SENTENCE_LEN);
  return Number.isFinite(v) && v >= 5 && v <= 60 ? v : 22;
})();

const MAX_PASSIVE_RATIO = (() => {
  const v = parseFloat(process.env.READABILITY_MAX_PASSIVE_RATIO);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.18;
})();

const MAX_BUREAUCRATESE_RATIO = (() => {
  const v = parseFloat(process.env.READABILITY_MAX_BUREAUCRATESE_RATIO);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.05;
})();

const LONG_SENTENCE_WORDS = 30;

// Ловит классические русские «канцеляризмы» — слова и обороты, которые
// продуктовый стайл-гайд (см. ТЗ Б4.1) рекомендует избегать.
// Список не исчерпывающий, но покрывает наиболее частые случаи.
const BUREAUCRATESE_TERMS = [
  // глаголы-«пустышки»
  'осуществлять', 'осуществление', 'осуществляется', 'осуществляются',
  'являться', 'является', 'являются', 'явилось', 'являлось',
  'производить', 'производится', 'производятся', 'произведение',
  'обеспечивать', 'обеспечивается', 'обеспечиваются',
  // обороты
  'в случае если', 'в случае когда', 'в связи с тем что', 'в целях',
  'в рамках', 'в части', 'на предмет', 'в отношении',
  'имеет место', 'имеют место', 'в настоящее время', 'на сегодняшний день',
  'в установленном порядке', 'в соответствии с', 'согласно с',
  'путем', 'путём', 'посредством',
  // существительные-«пустышки»
  'наличие', 'отсутствие', 'необходимость', 'возможность',
  'осуществление', 'произведение', 'произведения', 'выполнение',
  'реализация', 'реализации', 'данный', 'данная', 'данное', 'данные',
];

// Регэкспы суффиксов причастных пассивных форм.
// Ловим словоформы пассивных причастий: краткие формы (-н/-на/-но/-ны,
// -ен/-ена/-ено/-ены, -т/-та/-то/-ты) и длинные (-нный, -ный, -тый, -ованный,
// -ированный + падежные окончания). Активные глаголы наст. времени
// (ловит, моет, читает) НЕ должны попадать сюда.
const PASSIVE_SUFFIX_RE = /^[А-Яа-яёЁ]{3,}(?:ован(?:ный?|ная|ное|ные|ных|ными|ну|н|на|но|ны)|ирован(?:ный?|ная|ное|ные|ных|ными|ну|н|на|но|ны)|ну?тый?|нутая?|нутое?|нутые|ну?т|ну?та|ну?то|ну?ты)$/;
const REFLEXIVE_PASSIVE_RE = /^[А-Яа-яёЁ]{4,}(?:ется|ются|ался|алась|алось|ались)$/;

// Сокращения, после которых точка НЕ означает конец предложения.
const ABBREV_NO_BREAK = new Set([
  'г.', 'гг.', 'т.', 'т. н.', 'т.н.', 'т. д.', 'т.д.', 'т. п.', 'т.п.', 'т. е.', 'т.е.',
  'руб.', 'коп.', 'долл.', 'грн.', 'млн.', 'млрд.', 'тыс.', 'кг.', 'км.', 'см.', 'мм.',
  'ст.', 'ст.ст.', 'стр.', 'кв.', 'д.', 'ул.', 'пр.', 'пер.', 'обл.', 'р.', 'оз.',
  'им.', 'г-н', 'г-жа', 'проф.', 'акад.', 'к.т.н.', 'д.т.н.', 'к.э.н.', 'д.э.н.',
  'и.', 'о.',
]);

// ── Вспомогательные функции ────────────────────────────────────────────

/**
 * Извлекает «чистый» plain-text из article HTML, сохраняя разделители
 * предложений между блочными тегами.
 */
function htmlToPlain(html) {
  if (!html) return '';
  // strip-tags-loop устойчив к многосимвольным паттернам
  return stripHtmlTagsToText(html).replace(/\s+/g, ' ').trim();
}

/**
 * Делит plain-текст на предложения. Уважает сокращения (см. ABBREV_NO_BREAK)
 * и не разбивает на «35.» в составе числа.
 */
function splitSentences(plain) {
  if (!plain) return [];
  const out = [];
  const tokens = plain.split(/(\s+)/); // с пробелами
  let buf = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    buf += t;
    if (/\s+$/.test(t)) continue;
    // конец предложения — символ ?!. в конце токена; для . — проверяем,
    // не сокращение ли это (низкорегистровое слово с точкой).
    const trimmed = t.replace(/[)»"']+$/, '');
    if (/[?!]$/.test(trimmed)) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    if (/\.$/.test(trimmed)) {
      const lower = trimmed.toLowerCase();
      // одиночные сокращения — не конец
      if (ABBREV_NO_BREAK.has(lower)) continue;
      // число вида "1." (нумерация списка) — не конец
      if (/^\d+\.$/.test(trimmed)) continue;
      // следующий значимый символ — заглавная или конец строки → конец предложения
      let next = '';
      for (let j = i + 1; j < tokens.length; j += 1) {
        const tn = tokens[j].replace(/^\s+/, '');
        if (tn) { next = tn; break; }
      }
      if (!next || /^[А-ЯA-ZЁ«"'(]/.test(next) || /^\d/.test(next)) {
        out.push(buf.trim());
        buf = '';
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Слова-токены (без пунктуации), нижний регистр, ё→е.
 */
function wordsOf(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .match(/[а-яa-z0-9-]+/gi) || [];
}

/**
 * Считает символы (только буквы+цифры) — для индекса читабельности.
 */
function alphanumericChars(text) {
  if (!text) return 0;
  const m = text.match(/[А-Яа-яЁёA-Za-z0-9]/g);
  return m ? m.length : 0;
}

/**
 * Адаптация индекса Флеша для русского (по Тулдаве):
 *   FRES_RU = 206.836 − 1.52 × ASL − 65.14 × ASW
 *   где ASL = avg слов на предложение, ASW = avg слогов на слово.
 * Для слогов используем простую эвристику: число гласных в слове
 * (а, я, у, ю, о, ё, э, е, и, ы) — стандартный приём для рус. языка.
 *
 * Возвращаем число в диапазоне примерно [-50..100]; зажимаем [0..100]
 * для удобства интерпретации (>60 — нормально, <30 — тяжёлый текст).
 */
function flesch(text, words, sentences) {
  if (!words.length || !sentences.length) return 0;
  const VOWELS = /[аяуюоёэеиы]/gi;
  let totalSyllables = 0;
  for (const w of words) {
    const m = w.match(VOWELS);
    totalSyllables += m ? m.length : 0;
    // слова без гласных — считаем как 1 слог (например, аббревиатуры).
    if (!m && w.length > 0) totalSyllables += 1;
  }
  const ASL = words.length / sentences.length;
  const ASW = totalSyllables / words.length;
  const raw = 206.836 - 1.52 * ASL - 65.14 * ASW;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Доля канцеляритных оборотов: считаем число вхождений каждого маркера.
 * Для одиночных слов (без пробелов) применяем prefix-match — это позволяет
 * поймать все морфологические формы («осуществлять» → «осуществляем»,
 * «осуществление», «осуществляется»). Для фраз с пробелами — точное
 * вхождение фразы в текст.
 */
function bureaucrateseRatio(plain, words) {
  if (!words.length) return 0;
  const text = ` ${plain.toLowerCase().replace(/[ёЁ]/g, 'е')} `;
  let hits = 0;
  for (const term of BUREAUCRATESE_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    if (/\s/.test(term)) {
      // фраза — точное вхождение со словесными границами
      re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|[.,;:!?)»]|$)`, 'g');
    } else {
      // одиночное слово — prefix-match: term должен быть началом слова длиной
      // ≥ term.length+0 и иметь только русские суффиксы дальше (≤ 6 букв).
      // Берём первые 5 букв термина как стабильный «корень-стемм» — короче
      // нельзя (даст шум), длиннее — слишком строго (отрежет морфологию).
      const root = term.slice(0, Math.min(term.length, term.length <= 5 ? term.length : term.length - 2))
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(`(?:^|\\s)${root}[а-я]{0,8}(?=\\s|[.,;:!?)»]|$)`, 'g');
    }
    const m = text.match(re);
    if (m) hits += m.length;
  }
  return Math.min(1, hits / words.length);
}

/**
 * Доля пассивных форм: на каждое слово проверяем суффиксы причастных
 * пассивных форм + рефлексивный пассив (-ется/-ются). Эвристика
 * приближённая, но в стиле спецификации Б4.1 («морфология»).
 */
function passiveRatio(words) {
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) {
    if (PASSIVE_SUFFIX_RE.test(w) || REFLEXIVE_PASSIVE_RE.test(w)) hits += 1;
  }
  return Math.min(1, hits / words.length);
}

// ── Публичные функции ────────────────────────────────────────────────

/**
 * analyzeReadability — основной публичный энтрипоинт.
 * Принимает HTML, возвращает объект с метриками + verdict.
 */
function analyzeReadability(html, opts = {}) {
  const minIndex      = Number.isFinite(opts.minIndex)         ? opts.minIndex         : MIN_READABILITY_INDEX;
  const maxAvgSentLen = Number.isFinite(opts.maxAvgSentLen)    ? opts.maxAvgSentLen    : MAX_AVG_SENTENCE_LEN;
  const maxPassive    = Number.isFinite(opts.maxPassive)       ? opts.maxPassive       : MAX_PASSIVE_RATIO;
  const maxBureau     = Number.isFinite(opts.maxBureaucratese) ? opts.maxBureaucratese : MAX_BUREAUCRATESE_RATIO;

  const plain = htmlToPlain(html);
  const sentences = splitSentences(plain);
  const allWords  = wordsOf(plain);

  if (!sentences.length || allWords.length < 20) {
    return {
      enabled:    true,
      verdict:    'na',
      reason:     sentences.length ? 'too_few_words' : 'no_sentences',
      metrics: {
        flesch_index:        0,
        avg_sentence_words:  0,
        long_sentence_pct:   0,
        bureaucratese_pct:   0,
        passive_pct:         0,
        sentence_count:      sentences.length,
        word_count:          allWords.length,
        char_count:          alphanumericChars(plain),
      },
      issues: [],
      thresholds: {
        min_flesch_index:        minIndex,
        max_avg_sentence_words:  maxAvgSentLen,
        max_passive_ratio:       maxPassive,
        max_bureaucratese_ratio: maxBureau,
        long_sentence_words:     LONG_SENTENCE_WORDS,
      },
    };
  }

  // Per-sentence stats
  let longSentCount = 0;
  let totalSentenceWords = 0;
  for (const s of sentences) {
    const sw = wordsOf(s);
    totalSentenceWords += sw.length;
    if (sw.length > LONG_SENTENCE_WORDS) longSentCount += 1;
  }
  const avgSentenceWords = totalSentenceWords / sentences.length;
  const longSentPct      = sentences.length ? (longSentCount / sentences.length) : 0;
  const fleschIndex      = flesch(plain, allWords, sentences);
  const bureauRatio      = bureaucrateseRatio(plain, allWords);
  const passive          = passiveRatio(allWords);

  // Issue compilation + verdict
  const issues = [];
  if (fleschIndex < minIndex) {
    issues.push({
      kind:     'low_readability',
      message:  `Индекс читабельности ${fleschIndex} < минимума ${minIndex} — текст тяжело читать`,
      severity: fleschIndex < minIndex - 15 ? 'high' : 'medium',
    });
  }
  if (avgSentenceWords > maxAvgSentLen) {
    issues.push({
      kind:     'long_sentences',
      message:  `Средняя длина предложения ${avgSentenceWords.toFixed(1)} слов > порога ${maxAvgSentLen}`,
      severity: avgSentenceWords > maxAvgSentLen * 1.3 ? 'high' : 'medium',
    });
  }
  if (passive > maxPassive) {
    issues.push({
      kind:     'too_much_passive',
      message:  `Доля пассива ${(passive * 100).toFixed(1)}% > порога ${(maxPassive * 100).toFixed(0)}%`,
      severity: passive > maxPassive * 1.5 ? 'high' : 'medium',
    });
  }
  if (bureauRatio > maxBureau) {
    issues.push({
      kind:     'too_much_bureaucratese',
      message:  `Доля канцелярита ${(bureauRatio * 100).toFixed(1)}% > порога ${(maxBureau * 100).toFixed(0)}%`,
      severity: bureauRatio > maxBureau * 2 ? 'high' : 'medium',
    });
  }

  // verdict: pass = нет high-issue и не более 1 medium; review = иначе.
  // refine = ≥2 high (тяжёлые нарушения, надо переписать).
  const highCount   = issues.filter((i) => i.severity === 'high').length;
  const mediumCount = issues.filter((i) => i.severity === 'medium').length;
  let verdict;
  if (highCount === 0 && mediumCount <= 1) verdict = 'pass';
  else if (highCount >= 2)                  verdict = 'refine';
  else                                       verdict = 'review';

  return {
    enabled: true,
    verdict,
    reason:  null,
    metrics: {
      flesch_index:       fleschIndex,
      avg_sentence_words: Math.round(avgSentenceWords * 10) / 10,
      long_sentence_pct:  Math.round(longSentPct * 1000) / 10,
      bureaucratese_pct:  Math.round(bureauRatio * 1000) / 10,
      passive_pct:        Math.round(passive * 1000) / 10,
      sentence_count:     sentences.length,
      word_count:         allWords.length,
      char_count:         alphanumericChars(plain),
    },
    issues,
    thresholds: {
      min_flesch_index:        minIndex,
      max_avg_sentence_words:  maxAvgSentLen,
      max_passive_ratio:       maxPassive,
      max_bureaucratese_ratio: maxBureau,
      long_sentence_words:     LONG_SENTENCE_WORDS,
    },
  };
}

module.exports = {
  analyzeReadability,
  // exports for tests
  _internal: {
    htmlToPlain,
    splitSentences,
    wordsOf,
    flesch,
    bureaucrateseRatio,
    passiveRatio,
    BUREAUCRATESE_TERMS,
  },
};
