'use strict';

const { russianStem } = require('./russianStem');

/**
 * semanticSimilarity.js — Гибридный поиск (Lexical + Vector Similarity)
 * для семантического покрытия LSI-терминов.
 *
 * Использует TF-IDF векторное представление текста для вычисления
 * cosine similarity между параграфами и LSI-терминами.
 * Не требует внешних API — всё вычисляется локально.
 */

// Русские стоп-слова для TF-IDF
const STOP_WORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то',
  'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за',
  'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет',
  'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли', 'если',
  'уже', 'или', 'ни', 'быть', 'был', 'него', 'до', 'вас', 'нибудь', 'опять',
  'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может', 'они',
  'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была',
  'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет',
  'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой', 'совсем',
  'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее',
  'при', 'это', 'этой', 'эти', 'также', 'которые', 'который', 'которая',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'of', 'in', 'to', 'for',
  'with', 'on', 'at', 'from', 'by', 'about', 'as', 'into', 'through',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
]);

/**
 * tokenize — разбивает текст на стеммированные токены.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')  // strip HTML
    .replace(/&\w+;/g, ' ')   // strip HTML entities
    .replace(/[^\wа-яёА-ЯЁ\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .map(russianStem);
}

/**
 * buildTfIdfVector — строит TF-IDF вектор для текста.
 * @param {string[]} tokens — стеммированные токены документа
 * @param {Map<string,number>} idf — IDF-словарь (stem → idf)
 * @returns {Map<string,number>} — вектор (stem → tf-idf)
 */
function buildTfIdfVector(tokens, idf) {
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const vec = new Map();
  for (const [term, count] of tf) {
    const tfidf = (count / tokens.length) * (idf.get(term) || 1);
    vec.set(term, tfidf);
  }
  return vec;
}

/**
 * cosineSimilarity — вычисляет косинусное сходство двух TF-IDF векторов.
 * @param {Map<string,number>} vecA
 * @param {Map<string,number>} vecB
 * @returns {number} — 0..1
 */
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, valA] of vecA) {
    const valB = vecB.get(term) || 0;
    dotProduct += valA * valB;
    normA += valA * valA;
  }
  for (const [, valB] of vecB) {
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * splitIntoParagraphs — разбивает HTML на параграфы (абзацы/блоки).
 * @param {string} html
 * @returns {Array<{ index: number, text: string }>}
 */
function splitIntoParagraphs(html) {
  if (!html) return [];
  // Разбиваем по тегам: <p>, <li>, <h2>, <h3>, <h4>, <blockquote>
  const blocks = html.split(/<(?:p|li|h[2-4]|blockquote|div)[^>]*>/i);
  return blocks
    .map((block, index) => ({
      index,
      text: block.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter(b => b.text.length > 20);
}

/**
 * computeSemanticCoverage — вычисляет семантическое покрытие LSI-терминов
 * в HTML-контенте через cosine similarity TF-IDF векторов.
 *
 * @param {string}   htmlContent — HTML-текст блока
 * @param {string[]} lsiTerms   — LSI-слова для проверки
 * @param {number}   threshold  — порог cosine similarity (по умолчанию 0.15)
 * @returns {{ semanticallyCovered: string[], semanticallyMissing: string[], semanticScore: number,
 *             paragraphHints: Array<{ term: string, bestParagraphIndex: number, similarity: number }> }}
 */
function computeSemanticCoverage(htmlContent, lsiTerms, threshold = 0.15) {
  if (!lsiTerms || !lsiTerms.length) {
    return { semanticallyCovered: [], semanticallyMissing: [], semanticScore: 100, paragraphHints: [] };
  }

  const paragraphs = splitIntoParagraphs(htmlContent);
  if (!paragraphs.length) {
    return {
      semanticallyCovered: [],
      semanticallyMissing: [...lsiTerms],
      semanticScore: 0,
      paragraphHints: [],
    };
  }

  // Собираем все документы (параграфы + LSI-термины) для IDF
  const allDocs = [
    ...paragraphs.map(p => tokenize(p.text)),
    ...lsiTerms.map(t => tokenize(t)),
  ];

  // Вычисляем IDF
  const idf = computeIDF(allDocs);

  // Строим TF-IDF векторы для каждого параграфа
  const paragraphVectors = paragraphs.map(p => ({
    index: p.index,
    text:  p.text,
    vec:   buildTfIdfVector(tokenize(p.text), idf),
  }));

  const semanticallyCovered = [];
  const semanticallyMissing = [];
  const paragraphHints      = [];

  for (const term of lsiTerms) {
    const termTokens = tokenize(term);
    const termVec    = buildTfIdfVector(termTokens, idf);

    let bestSim   = 0;
    let bestIndex = 0;

    for (const pv of paragraphVectors) {
      const sim = cosineSimilarity(termVec, pv.vec);
      if (sim > bestSim) {
        bestSim   = sim;
        bestIndex = pv.index;
      }
    }

    if (bestSim >= threshold) {
      semanticallyCovered.push(term);
    } else {
      semanticallyMissing.push(term);
    }

    // Всегда сохраняем hint — полезно для Stage 6 инъекции
    paragraphHints.push({
      term,
      bestParagraphIndex: bestIndex,
      similarity:         Math.round(bestSim * 1000) / 1000,
    });
  }

  const semanticScore = lsiTerms.length > 0
    ? Math.round((semanticallyCovered.length / lsiTerms.length) * 100)
    : 100;

  return { semanticallyCovered, semanticallyMissing, semanticScore, paragraphHints };
}

/**
 * computeIDF — вычисляет IDF (inverse document frequency) для корпуса.
 * @param {string[][]} docs — массив документов (каждый = массив токенов)
 * @returns {Map<string,number>}
 */
function computeIDF(docs) {
  const N   = docs.length;
  const df  = new Map(); // term → количество документов, содержащих term

  for (const doc of docs) {
    const uniqueTerms = new Set(doc);
    for (const term of uniqueTerms) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [term, count] of df) {
    // Laplace smoothing (+1) prevents division by zero for rare/absent terms
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
}

/**
 * hybridCoverage — объединяет лексическое и семантическое покрытие.
 *
 * @param {string}   htmlContent — HTML-текст
 * @param {string[]} targetWords — LSI-слова
 * @param {object}   lexical     — результат calculateCoverage()
 * @param {{ lexicalWeight: number, semanticWeight: number }} weights
 * @returns {{ covered: string[], missing: string[], percent: number,
 *             lexicalPercent: number, semanticPercent: number, paragraphHints: Array }}
 */
function hybridCoverage(htmlContent, targetWords, lexical, weights = {}) {
  const { lexicalWeight = 0.6, semanticWeight = 0.4 } = weights;

  const semantic = computeSemanticCoverage(htmlContent, targetWords);

  // Объединяем: термин покрыт, если покрыт лексически ИЛИ семантически
  const coveredSet = new Set([
    ...lexical.covered,
    ...semantic.semanticallyCovered,
  ]);

  const covered = targetWords.filter(w => coveredSet.has(w));
  const missing = targetWords.filter(w => !coveredSet.has(w));
  const percent = targetWords.length > 0
    ? Math.round((covered.length / targetWords.length) * 100)
    : 100;

  // Взвешенный гибридный процент (для UI)
  const hybridPercent = Math.round(
    lexical.percent * lexicalWeight + semantic.semanticScore * semanticWeight
  );

  return {
    covered,
    missing,
    percent,                            // бинарный: покрыт лексически ИЛИ семантически
    hybridPercent,                      // взвешенный: 60% lexical + 40% semantic
    lexicalPercent:  lexical.percent,
    semanticPercent: semantic.semanticScore,
    paragraphHints:  semantic.paragraphHints,
  };
}

module.exports = {
  computeSemanticCoverage,
  hybridCoverage,
  splitIntoParagraphs,
  tokenize,
  cosineSimilarity,
};
