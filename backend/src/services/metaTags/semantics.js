'use strict';

/**
 * Семантический анализ ТОП-выдачи (TF-IDF/DF + лемматизация).
 *
 * Идея:
 *   1. Считаем DF (document frequency) каждого слова по всем сниппетам ТОПа.
 *   2. Слово, встречающееся в ≥35% сниппетов → «важное» (обязательно в Title).
 *   3. Слово, встречающееся в 15–35% сниппетов → «рекомендуемое» (для Description).
 *   4. Отдельно ловим годы (\b20\d{2}\b) — они часто маркируют свежесть выдачи.
 *
 * Лемматизация: используем общий `russianStem` (тот же, что и LSI-coverage,
 * naturalnessCheck, BM25 в основном пайплайне). Это даёт универсальное
 * схлопывание падежных/числовых форм для ЛЮБОЙ ниши бизнеса (медицина,
 * юр. услуги, образование, авто, e-commerce, …) — без хардкода
 * предметно-зависимых префиксов.
 */

const { russianStem } = require('../../utils/russianStem');

// Кириллический корпус стоп-слов из beta-версии (без изменений).
const STOP_WORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты','к','у','же',
  'вы','за','бы','по','только','ее','мне','было','вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну',
  'вдруг','ли','если','уже','или','ни','быть','был','него','до','вас','нибудь','опять','уж','вам','ведь','там','потом',
  'себя','ничего','ей','может','они','тут','где','есть','надо','ней','для','мы','тебя','их','чем','была','сам','чтоб','без',
  'будто','чего','раз','тоже','себе','под','будет','ж','тогда','кто','этот','того','потому','этого','какой','совсем',
  'ним','здесь','этом','один','почти','мой','тем','чтобы','нее','сейчас','были','куда','зачем','всех','никогда','можно',
  'при','наконец','два','об','другой','хоть','после','над','больше','тот','через','эти','нас','про','всего','них','какая',
  'много','разве','три','эту','моя','впрочем','хорошо','свою','этой','перед','иногда','лучше','чуть','том','нельзя','такой',
  'им','более','всегда','конечно','всю','между','руб','рублей','это','очень',
]);

/**
 * Универсальная лемматизация под ЛЮБУЮ нишу.
 *
 * Раньше здесь жил жёстко зашитый словарик из beta-версии под автозапчасти
 * + e-commerce («тормозн», «диск», «запчаст», «колодк», «магазин», «купи»,
 * «доставк», «каталог», «интернет», «цен», «москв», «сайт»). Для других
 * ниш (медицина, юр. услуги, образование, недвижимость, …) он либо ничего
 * не давал, либо лишь частично: «услуги/услуг/услугами», «врачей/врача»,
 * «адвокат/адвоката» так и оставались разными токенами и не схлопывались
 * в один LSI. В результате одно и то же слово попадало в
 * `title_mandatory_words` несколько раз, а проверка покрытия не засчитывала
 * падежную форму как использование исходного LSI.
 *
 * Решение: используем общий `russianStem` — тот же стеммер, что и
 * `utils/calculateCoverage.js`, `utils/naturalnessCheck.js` и
 * `services/metrics/bm25.js`. Это даёт единое поведение по всему пайплайну
 * и универсальную работу для произвольной бизнес-ниши.
 */
function normalizeWord(word) {
  if (!word) return '';
  return russianStem(String(word).toLowerCase());
}

/**
 * @param {string} keyword
 * @param {Array<{title:string, snippet:string}>} serpData
 * @returns {{
 *   title_mandatory_words:       string[],   // ≥35% выдачи, до 6 шт
 *   description_mandatory_words: string[],   // 15–35% выдачи, до 10 шт
 * }}
 */
function extractSemantics(keyword, serpData) {
  const totalDocs = Array.isArray(serpData) ? serpData.length : 0;
  if (totalDocs === 0) {
    return { title_mandatory_words: [], description_mandatory_words: [] };
  }

  const docCounts = Object.create(null);

  serpData.forEach((doc) => {
    const text = `${doc.title || ''} ${doc.snippet || ''}`
      .toLowerCase()
      .replace(/[^а-яёa-z0-9]/g, ' ');
    const words = text.split(/\s+/);
    // Уникальные нормализованные слова в пределах одного сниппета — для DF.
    const uniqNormalized = [...new Set(words.map((w) => normalizeWord(w)))];
    uniqNormalized.forEach((w) => {
      if (w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)) {
        docCounts[w] = (docCounts[w] || 0) + 1;
      }
    });
  });

  const titleRaw = [];
  const descRaw  = [];

  // Отдельный счётчик годов (4-значных 20xx) — beta-версия учитывает их в семантике.
  const yearCounts = Object.create(null);
  serpData.forEach((doc) => {
    const text = `${doc.title || ''} ${doc.snippet || ''}`.toLowerCase();
    const matches = text.match(/\b20\d{2}\b/g);
    if (matches) matches.forEach((y) => { yearCounts[y] = (yearCounts[y] || 0) + 1; });
  });
  for (const [year, count] of Object.entries(yearCounts)) {
    const pct = (count / totalDocs) * 100;
    if (pct >= 35)               titleRaw.push({ word: year, count });
    else if (pct >= 15)          descRaw.push({ word: year, count });
  }

  for (const [word, count] of Object.entries(docCounts)) {
    const pct = (count / totalDocs) * 100;
    if (pct >= 35)               titleRaw.push({ word, count });
    else if (pct >= 15)          descRaw.push({ word, count });
  }

  titleRaw.sort((a, b) => b.count - a.count);
  descRaw.sort((a, b) => b.count - a.count);

  return {
    title_mandatory_words:       titleRaw.map((x) => x.word).slice(0, 6),
    description_mandatory_words: descRaw.map((x)  => x.word).slice(0, 10),
  };
}

/**
 * Проверяет, какие из обязательных LSI реально использованы в готовых
 * Title/Description. Совпадение определяется по корню (нормализованной форме),
 * чтобы «диски» в Title засчитались за LSI «диск».
 *
 * @returns {{used_lsi: string[], missed_lsi: string[]}}
 */
function checkLsiUsage(text, mandatoryLsi) {
  if (!Array.isArray(mandatoryLsi) || mandatoryLsi.length === 0) {
    return { used_lsi: [], missed_lsi: [] };
  }
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^а-яёa-z0-9]/g, ' ')
    .split(/\s+/)
    .map((w) => normalizeWord(w));
  const set = new Set(norm);
  const used = [];
  const missed = [];
  mandatoryLsi.forEach((w) => {
    if (set.has(normalizeWord(String(w).toLowerCase()))) used.push(w);
    else missed.push(w);
  });
  return { used_lsi: used, missed_lsi: missed };
}

module.exports = { extractSemantics, checkLsiUsage, normalizeWord, STOP_WORDS };
