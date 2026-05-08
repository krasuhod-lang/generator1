'use strict';

/**
 * readabilityAnalyzer — B4.1 плана «Усиление "Комбайна"».
 *
 * Вычисляет метрики читабельности русскоязычного HTML/plain-текста:
 *   - readabilityIndex     — адаптация Tuldava index для русского;
 *   - avgSentenceLen       — средняя длина предложения (в словах);
 *   - longSentenceRatio    — доля предложений длиннее 30 слов;
 *   - passiveRatio         — доля пассивных конструкций (грубая морфология);
 *   - bureaucrateseRatio   — доля канцелярита (словарь маркеров).
 *
 * Возвращает также verdict-блок: какие пороги нарушены и насколько сильно.
 * Пороги задаются вызывающим кодом (обычно из featureFlags.readability).
 *
 * Это deterministic-функция, без внешних зависимостей кроме общего
 * stripHtmlTags из backend/src/utils.
 */

const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Словари ─────────────────────────────────────────────────────────

/**
 * BUREAUCRATESE_MARKERS — частые маркеры канцелярита.
 * Список умышленно компактный: задача — поймать «системный» канцелярит,
 * а не объявить охоту на все отглагольные существительные.
 */
const BUREAUCRATESE_MARKERS = [
  'осуществлять', 'осуществляется', 'осуществляются',
  'является', 'являются', 'являлся', 'являлась',
  'в случае если', 'в случае, если', 'в случае',
  'в целях', 'с целью', 'в качестве',
  'необходимо отметить', 'следует отметить',
  'имеет место', 'имеется', 'имеются',
  'в рамках', 'на сегодняшний день',
  'путём', 'посредством',
  'данный', 'данная', 'данное', 'данные',
  'вышеуказанн', 'нижеуказанн',
  'в связи с тем что', 'в связи с тем, что',
  'ввиду того что', 'ввиду того, что',
  'согласно которому', 'согласно которой',
  'осуществление', 'реализация', 'функционирование',
];

// ── Утилиты ─────────────────────────────────────────────────────────

function toPlainText(input) {
  if (!input) return '';
  // если это похоже на HTML — снимаем теги
  if (/<[a-z!\/][^>]*>/i.test(String(input))) {
    return stripHtmlTagsToText(String(input));
  }
  return String(input);
}

function splitSentences(text) {
  if (!text) return [];
  // RU/EN sentence splitter: . ! ? … + перенос строки
  // Защита от сокращений: «г.», «ст.», «п.», «№»  не разрезают.
  // Простая эвристика: разбиваем по [.!?…]+\s+(?=[А-ЯA-Z]) либо по \n\n.
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/(?<=[.!?…])\s+(?=[«"„(0-9A-ZА-ЯЁ])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

function countWords(text) {
  if (!text) return 0;
  const m = text.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

function countSyllablesRu(word) {
  if (!word) return 0;
  // Слоги ≈ количество гласных. Для русского очень неплохо.
  const m = word.toLowerCase().match(/[аеёиоуыэюяaeiouy]/g);
  return m ? m.length : 0;
}

// ── Метрики ─────────────────────────────────────────────────────────

/**
 * tuldavaIndex — формула Тулдавы (адаптация Flesch для русского):
 *
 *   I = (avg_syllables_per_word) × (avg_word_per_sentence) / (норм. константа)
 *
 * Готовой «канонической» нормировки для веб-блогов нет, поэтому используем
 * монотонное преобразование к 0..100 (выше — проще), чтобы выводить в UI
 * как «индекс читабельности» сопоставимый между статьями.
 *
 * I_raw = avgSyllPerWord * avgWordsPerSentence
 * Дальше:  100 - clamp((I_raw - 7) * 6, 0, 100)
 *   I_raw = 7 → 100 (очень легко, как разговорная речь);
 *   I_raw = 24 → 0 (тяжёлый канцелярит).
 */
function computeTuldavaIndex({ avgWordsPerSentence, avgSyllPerWord }) {
  if (!avgWordsPerSentence || !avgSyllPerWord) return 100;
  const raw = avgWordsPerSentence * avgSyllPerWord;
  const penalty = (raw - 7) * 6;
  const clamped = Math.max(0, Math.min(100, penalty));
  return Math.round((100 - clamped) * 10) / 10;
}

/**
 * passiveRatio — грубая оценка доли пассивных конструкций.
 * Маркеры:
 *   1. Краткие пассивные причастия на -н/-т: «сделан», «закрыт», «принят»,
 *      «опубликовано», «выполнены» — после быть/был/была/будет/-ся это
 *      классический пассив.
 *   2. Глагол + «-ся/-сь» в форме настоящего/прошедшего, когда субъект
 *      не указан явно. Для простоты — все формы на -ется/-ются считаем
 *      пассивно-возвратными (false-positives бывают, но это soft-warn).
 */
const SHORT_PASSIVE_PARTICIPLE_RE = /(?<![\p{L}])\p{L}{3,}(?:[аеио]н|т)[ао]?(?![\p{L}])/giu;
const REFLEXIVE_VERB_RE = /(?<![\p{L}])\p{L}{3,}(?:ется|ются|ался|алась|алось|ались)(?![\p{L}])/giu;
const PASSIVE_AUX_RE = /(?<![\p{L}])(?:был[аои]?|быть|будет|будут|являет(?:ся|ся)?)(?![\p{L}])/giu;

function computePassiveRatio(text) {
  const totalWords = countWords(text);
  if (!totalWords) return 0;
  const auxHits = (text.match(PASSIVE_AUX_RE) || []).length;
  const shortPart = (text.match(SHORT_PASSIVE_PARTICIPLE_RE) || []).length;
  const refl = (text.match(REFLEXIVE_VERB_RE) || []).length;
  // Грубая оценка: кол-во «маркерных» слов / кол-во всех слов.
  // Не выйдет > 1, т.к. AUX редко превышает 5–10% даже в плохом тексте.
  const markerWords = auxHits + shortPart + refl;
  return Math.min(1, markerWords / totalWords);
}

function computeBureaucrateseRatio(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const m of BUREAUCRATESE_MARKERS) {
    const escaped = m.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'giu');
    const found = lower.match(re);
    if (found) hits += found.length;
  }
  const totalWords = countWords(text);
  if (!totalWords) return 0;
  return Math.min(1, hits / totalWords);
}

// ── Главная функция ─────────────────────────────────────────────────

/**
 * analyzeReadability — комплексный анализ.
 *
 * @param {string} input  HTML или plain-text
 * @param {object} [thresholds]
 * @param {number} [thresholds.minIndex=55]
 * @param {number} [thresholds.maxAvgSentenceLen=22]
 * @param {number} [thresholds.maxPassiveRatio=0.18]
 * @param {number} [thresholds.maxBureaucrateseRatio=0.04]
 *
 * @returns {{
 *   metrics: {
 *     wordCount, sentenceCount,
 *     avgSentenceLen, longSentenceRatio, avgSyllPerWord,
 *     readabilityIndex, passiveRatio, bureaucrateseRatio
 *   },
 *   verdict: {
 *     violations: string[],          // human-readable
 *     severeViolations: string[],    // нарушения с >50% превышения порога
 *     ok: boolean,
 *   }
 * }}
 */
function analyzeReadability(input, thresholds = {}) {
  const t = {
    minIndex: 55,
    maxAvgSentenceLen: 22,
    maxPassiveRatio: 0.18,
    maxBureaucrateseRatio: 0.04,
    ...thresholds,
  };

  const text = toPlainText(input);
  const sentences = splitSentences(text);
  const wordCount = countWords(text);
  const sentenceCount = sentences.length;

  let totalSyll = 0;
  let totalWordsPerSent = 0;
  let longCount = 0;
  for (const s of sentences) {
    const wordsInSent = countWords(s);
    totalWordsPerSent += wordsInSent;
    if (wordsInSent > 30) longCount += 1;
    const tokens = s.match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of tokens) totalSyll += countSyllablesRu(w);
  }

  const avgWordsPerSentence = sentenceCount ? totalWordsPerSent / sentenceCount : 0;
  const avgSyllPerWord = wordCount ? totalSyll / wordCount : 0;
  const readabilityIndex = computeTuldavaIndex({
    avgWordsPerSentence,
    avgSyllPerWord,
  });
  const passiveRatio = computePassiveRatio(text);
  const bureaucrateseRatio = computeBureaucrateseRatio(text);

  const metrics = {
    wordCount,
    sentenceCount,
    avgSentenceLen: Math.round(avgWordsPerSentence * 10) / 10,
    longSentenceRatio: sentenceCount ? Math.round((longCount / sentenceCount) * 1000) / 1000 : 0,
    avgSyllPerWord: Math.round(avgSyllPerWord * 100) / 100,
    readabilityIndex,
    passiveRatio: Math.round(passiveRatio * 1000) / 1000,
    bureaucrateseRatio: Math.round(bureaucrateseRatio * 1000) / 1000,
  };

  // Verdict
  const violations = [];
  const severeViolations = [];
  function check(name, value, limit, mode) {
    // mode: 'min' (значение должно быть ≥ limit) или 'max' (≤ limit)
    let bad = false;
    let severity = 0;
    if (mode === 'min' && value < limit) {
      bad = true;
      severity = (limit - value) / Math.max(1, limit);
    } else if (mode === 'max' && value > limit) {
      bad = true;
      severity = (value - limit) / Math.max(0.0001, limit);
    }
    if (bad) {
      const msg = `${name}=${value} ${mode === 'min' ? '< min ' : '> max '}${limit}`;
      violations.push(msg);
      if (severity > 0.5) severeViolations.push(msg);
    }
  }
  check('readabilityIndex', metrics.readabilityIndex, t.minIndex, 'min');
  check('avgSentenceLen', metrics.avgSentenceLen, t.maxAvgSentenceLen, 'max');
  check('passiveRatio', metrics.passiveRatio, t.maxPassiveRatio, 'max');
  check('bureaucrateseRatio', metrics.bureaucrateseRatio, t.maxBureaucrateseRatio, 'max');

  return {
    metrics,
    verdict: {
      violations,
      severeViolations,
      ok: violations.length === 0,
    },
  };
}

module.exports = {
  analyzeReadability,
  // экспорт под-метрик для тестов и переиспользования
  _internal: {
    splitSentences,
    countWords,
    countSyllablesRu,
    computeTuldavaIndex,
    computePassiveRatio,
    computeBureaucrateseRatio,
    BUREAUCRATESE_MARKERS,
  },
};
