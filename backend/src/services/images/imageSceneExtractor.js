'use strict';

/**
 * imageSceneExtractor — извлекает из блока статьи смысловую «сцену» для
 * генерации изображения (scene graph), а не просто повторяет заголовок.
 *
 * Детерминированный (без сети/LLM): анализирует текст блока, вытягивает
 * ключевые объекты/якорные факты и собирает structured scene с флагом
 * generic_risk. Если фактов в блоке недостаточно — делает fallback на
 * section summary/заголовок и помечает это в audit-поле.
 *
 * Выход (см. ТЗ §2):
 *   { subject, environment, action, objects[], must_include[], must_avoid[],
 *     composition, factual_anchors[], generic_risk, fallback_used, audit }
 */

const { stripTags, canon, tokenize } = require('./textSignals');

// Стоп-слова RU/EN — исключаем из кандидатов в «объекты сцены».
const STOPWORDS = new Set([
  'это', 'как', 'что', 'для', 'при', 'или', 'над', 'под', 'без', 'если',
  'так', 'уже', 'все', 'весь', 'вся', 'его', 'она', 'они', 'том', 'тем',
  'быть', 'есть', 'может', 'можно', 'нужно', 'надо', 'этот', 'эта', 'эти',
  'который', 'которая', 'которые', 'также', 'более', 'менее', 'очень',
  'если', 'чтобы', 'потому', 'поэтому', 'таким', 'образом', 'например',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'you', 'your',
]);

// Композиция кадра по типу визуальной задачи.
const COMPOSITION_BY_INTENT = {
  cover: 'wide establishing shot',
  explainer_scene: 'medium wide shot',
  step_by_step: 'sequential / process composition',
  comparison_scene: 'side-by-side split composition',
  object_visual: 'product close-up, clean background',
  trust_visual: 'documentary realistic medium shot',
  context_of_use: 'medium wide shot in real environment',
};

// Базовый must_avoid (усиливается композером под strict-editorial).
const BASE_MUST_AVOID = [
  'текст на изображении',
  'водяные знаки и логотипы',
  'искажённые руки и лица',
  'глянцевый generic stock-стиль',
];

/** Извлекает якорные факты: числа с единицами, «в кавычках» термины. */
function extractFactualAnchors(text) {
  const anchors = [];
  const t = String(text || '');
  // Числа с единицами измерения / процентами.
  const numRe = /(\d[\d\s.,]*)\s*(мм|см|м|км|кг|г|л|мл|вт|квт|°c|%|руб|₽|шт|литр\w*|ватт\w*)/gi;
  let m;
  while ((m = numRe.exec(t)) !== null && anchors.length < 8) {
    anchors.push(`${m[1].trim()} ${m[2]}`.replace(/\s+/g, ' ').trim());
  }
  // Термины в кавычках «…» / "…".
  const quoteRe = /[«"]([^«»"]{3,40})[»"]/g;
  while ((m = quoteRe.exec(t)) !== null && anchors.length < 12) {
    anchors.push(m[1].trim());
  }
  return Array.from(new Set(anchors));
}

/** Топ-N значимых существительных/слов как кандидаты «объектов». */
function extractObjects(text, limit = 6) {
  const freq = new Map();
  for (const w of tokenize(text)) {
    if (STOPWORDS.has(w) || w.length < 4) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * extractScene — главный вход.
 *
 * @param {object} input
 * @param {string} input.sectionText   — текст/HTML блока
 * @param {string} input.imageIntent   — тип визуала (из intent-планера)
 * @param {string} [input.sectionH2]   — заголовок блока
 * @param {string} [input.topic]       — тема статьи (для cover / fallback)
 * @param {string} [input.articleType]
 * @param {object} [input.audience]
 * @returns {object} scene graph (никогда не бросает)
 */
function extractScene(input = {}) {
  const intent = String(input.imageIntent || 'explainer_scene');
  const h2 = String(input.sectionH2 || '').trim();
  const topic = String(input.topic || '').trim();
  const rawText = stripTags(input.sectionText != null ? input.sectionText : '');

  const anchors = extractFactualAnchors(input.sectionText != null ? String(input.sectionText) : '');
  const objects = extractObjects(rawText);

  // subject: для обложки — тема; иначе — заголовок блока, при пустоте fallback.
  let subject = intent === 'cover'
    ? (topic || h2)
    : (h2 || topic);
  subject = subject.slice(0, 160);

  // fallback, если в блоке слишком мало содержательных фактов.
  const contentful = objects.length + anchors.length;
  let fallbackUsed = false;
  let auditNote = 'scene extracted from block content';

  // Обложка — особый случай: у неё нет тела секции, визуальный концепт
  // строится из темы статьи. Пустой sectionText для cover — норма, а НЕ
  // повод для fallback/high generic. Считаем cover grounded, если тема
  // достаточно конкретна (≥2 значимых слова).
  const isCover = intent === 'cover';
  const topicWords = tokenize(topic || subject);

  if (isCover) {
    if (topicWords.length < 1) {
      fallbackUsed = true;
      auditNote = 'cover: topic too vague — generic concept';
      if (!subject) subject = topic || h2 || 'обложка статьи';
    }
    if (!objects.length) {
      // Тема как объекты сцены обложки.
      for (const w of topicWords.slice(0, 4)) objects.push(w);
    }
  } else if (contentful < 2) {
    fallbackUsed = true;
    auditNote = 'insufficient block facts — fell back to section summary/heading';
    if (!subject) subject = topic || h2 || 'иллюстрация к статье';
  }

  // generic_risk: мало конкретики → high; средне → medium; много → low.
  let genericRisk = 'low';
  if (isCover) {
    genericRisk = topicWords.length >= 1 ? 'medium' : 'high';
  } else if (contentful <= 1) {
    genericRisk = 'high';
  } else if (contentful <= 3) {
    genericRisk = 'medium';
  }

  // must_include собираем из сильнейших якорей + сути intent.
  const mustInclude = [];
  if (subject) mustInclude.push(subject);
  for (const a of anchors.slice(0, 2)) mustInclude.push(a);
  if (intent === 'comparison_scene') mustInclude.push('два сопоставляемых варианта в одном кадре');
  if (intent === 'step_by_step') mustInclude.push('последовательность действий/этапов');
  if (intent === 'context_of_use') mustInclude.push('реальный сценарий использования');

  const mustAvoid = BASE_MUST_AVOID.slice();

  const composition = COMPOSITION_BY_INTENT[intent] || 'medium wide shot';

  // environment/action — грубые дефолты; уточняются в композере/промпте.
  const environment = intent === 'context_of_use'
    ? 'реалистичная среда использования'
    : (intent === 'object_visual' ? 'нейтральный чистый фон' : 'уместная реальная обстановка');
  const action = intent === 'step_by_step'
    ? 'демонстрация ключевого шага процесса'
    : (intent === 'comparison_scene' ? 'сопоставление вариантов' : 'ключевая сцена блока');

  return {
    subject,
    environment,
    action,
    objects,
    must_include: Array.from(new Set(mustInclude.filter(Boolean))).slice(0, 6),
    must_avoid: mustAvoid,
    composition,
    factual_anchors: anchors,
    generic_risk: genericRisk,
    fallback_used: fallbackUsed,
    audit: auditNote,
  };
}

module.exports = {
  extractScene,
  extractFactualAnchors,
  extractObjects,
  COMPOSITION_BY_INTENT,
  BASE_MUST_AVOID,
  STOPWORDS,
};
