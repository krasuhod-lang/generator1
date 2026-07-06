'use strict';

/**
 * images/textSignals — общие детерминированные текстовые эвристики для
 * image pipeline (без сети, без LLM). Используются intent-планером и
 * scene-экстрактором для оценки, какая визуальная задача у блока статьи.
 *
 * Все функции чистые: тот же вход → тот же выход.
 */

/** Приводит HTML/текст к «голому» нижнему регистру без тегов и сущностей. */
function stripTags(html) {
  let cur = String(html || '');
  for (let i = 0; i < 5; i += 1) {
    const next = cur.replace(/<[^>]+>/g, ' ');
    if (next === cur) break;
    cur = next;
  }
  return cur
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Нормализация для сравнения: lower, только буквы/цифры/пробел. */
function canon(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[^а-яёa-z0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Токенизация в слова (RU/EN/цифры), длиннее 2 символов. */
function tokenize(s) {
  return canon(s).split(' ').filter((w) => w.length >= 3);
}

/** Сколько раз любой из markers встречается в тексте (подстрочно). */
function countMarkers(text, markers) {
  const t = canon(text);
  let n = 0;
  for (const m of markers) {
    const needle = canon(m);
    if (!needle) continue;
    let idx = t.indexOf(needle);
    while (idx !== -1) {
      n += 1;
      idx = t.indexOf(needle, idx + needle.length);
    }
  }
  return n;
}

// ── Наборы маркеров по типам визуальной задачи ──────────────────────

const MARKERS = Object.freeze({
  process: ['шаг', 'этап', 'сначала', 'затем', 'после этого', 'порядок', 'инструкц',
    'алгоритм', 'пошагов', 'как сделать', 'как настроить', 'как установить', 'процесс'],
  comparison: ['сравн', 'против', ' vs ', 'отлич', 'разниц', 'плюсы и минусы',
    'преимущества и недостатки', 'что лучше', 'какой выбрать', 'какую выбрать',
    'варианты', 'типы', 'виды'],
  object: ['устройств', 'аппарат', 'оборудован', 'модель', 'прибор', 'механизм',
    'конструкц', 'деталь', 'материал', 'мм', 'см', 'литр', 'ватт', 'выглядит'],
  trust: ['гарант', 'сертификат', 'лицензи', 'отзыв', 'кейс', 'результат',
    'до и после', 'пример работ', 'эксперт', 'опыт', 'проверен'],
  usage: ['применя', 'использу', 'в быту', 'на улице', 'дома', 'в офисе',
    'на производстве', 'в квартире', 'сценарий', 'ситуац', 'на практике', 'контекст'],
});

// Абстрактные/малополезные для визуала блоки.
const ABSTRACT_MARKERS = Object.freeze([
  'важно понимать', 'стоит отметить', 'таким образом', 'заключение', 'вывод',
  'часто задаваемые', 'faq', 'определение', 'что такое', 'история',
  'юридическ', 'закон', 'норматив', 'терминолог',
]);

/**
 * scoreSectionSignals — оценивает блок статьи по каждому типу визуальной
 * задачи. Возвращает { scores, abstractness, wordCount, hasList }.
 *
 * scores — целые (кол-во маркеров, нормируем позже). abstractness — доля
 * абстрактных маркеров относительно длины (грубая эвристика).
 */
function scoreSectionSignals(section) {
  const html = String(section && section.html || '');
  const text = stripTags(section && (section.text != null ? section.text : html));
  const words = tokenize(text);
  const wordCount = words.length;
  const hasList = /<ol\b|<ul\b/i.test(html) || /\d\.\s|\d\)\s/.test(text);

  const scores = {};
  for (const [type, markers] of Object.entries(MARKERS)) {
    scores[type] = countMarkers(text, markers);
  }
  // Ordered-list усиливает process-сигнал.
  if (/<ol\b/i.test(html)) scores.process += 2;

  const abstractHits = countMarkers(text, ABSTRACT_MARKERS);
  const abstractness = wordCount > 0 ? abstractHits / Math.max(1, wordCount / 40) : 1;

  return { scores, abstractness, wordCount, hasList, text };
}

module.exports = {
  stripTags,
  canon,
  tokenize,
  countMarkers,
  scoreSectionSignals,
  MARKERS,
  ABSTRACT_MARKERS,
};
