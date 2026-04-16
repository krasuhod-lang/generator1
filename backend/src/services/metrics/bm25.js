'use strict';

const { russianStem } = require('../../utils/russianStem');

/**
 * BM25 параметры — стандартные значения по разделу 9 ТЗ.
 */
const K1   = 1.2;
const B    = 0.75;
const AVGDL = 1200;  // эталонная длина коммерческой страницы в словах

/**
 * Токенизирует текст: нижний регистр, убирает теги и пунктуацию,
 * применяет русский стеммер.
 *
 * @param {string} text
 * @returns {string[]} — массив корневых форм слов
 */
function tokenize(text) {
  return text
    .replace(/<[^>]+>/g, ' ')       // снимаем HTML-теги
    .toLowerCase()
    .split(/[\s\p{P}]+/u)           // разбиваем по пробелам и пунктуации
    .map(w => w.replace(/[^а-яёa-z0-9]/gi, '').trim())
    .filter(w => w.length > 2)
    .map(russianStem);
}

/**
 * Считает частоту каждого токена в массиве.
 *
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * calculateBM25 — чистая математическая функция, без LLM.
 *
 * Формула (раздел 9 ТЗ):
 *
 *   BM25(q, D) = Σ IDF(qi) × [ tf(qi,D) × (k1+1) ] / [ tf(qi,D) + k1 × (1 - b + b × |D|/avgdl) ]
 *
 * IDF считается относительно самого документа (упрощённый вариант без корпуса):
 *   IDF(qi) = ln( (N - df + 0.5) / (df + 0.5) + 1 )
 * где N = общее кол-во уникальных терминов документа, df = 1 (термин встречается в документе).
 * Если термин НЕ встречается в документе, IDF = ln(2) ≈ 0.693 (штраф за отсутствие).
 *
 * @param {string|string[]} query        — поисковый запрос или массив LSI-слов
 * @param {string}          documentText — полный текст/HTML страницы
 * @returns {{
 *   score:        number,       — итоговый BM25 score
 *   interpretation: string,     — 'excellent' | 'good' | 'poor'
 *   queryTerms:   number,       — кол-во уникальных терминов запроса
 *   docLength:    number,       — длина документа в словах
 *   termScores:   Array<{term, tf, idf, bm25}>,  — разбивка по терминам
 * }}
 */
function calculateBM25(query, documentText) {
  // Токенизируем документ
  const docTokens = tokenize(documentText);
  const docLen    = docTokens.length;
  const docTF     = termFreq(docTokens);
  const N         = docTF.size;  // уникальных терминов в документе

  // Токенизируем запрос (или используем массив LSI-слов как есть)
  const queryTerms = Array.isArray(query)
    ? Array.from(new Set(query.map(w => russianStem(w.toLowerCase().trim())).filter(Boolean)))
    : Array.from(new Set(tokenize(query)));

  if (!queryTerms.length || !docLen) {
    return { score: 0, interpretation: 'poor', queryTerms: 0, docLength: docLen, termScores: [] };
  }

  // Нормализующий коэффициент длины документа
  const lengthNorm = 1 - B + B * (docLen / AVGDL);

  let totalScore  = 0;
  const termScores = [];

  for (const term of queryTerms) {
    const tf = docTF.get(term) || 0;

    // IDF: если термин есть в документе — полноценный IDF, иначе штраф
    const df  = tf > 0 ? 1 : 0;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    // BM25 слагаемое для этого термина
    const numerator   = tf * (K1 + 1);
    const denominator = tf + K1 * lengthNorm;
    const bm25term    = denominator > 0 ? idf * (numerator / denominator) : 0;

    totalScore += bm25term;

    termScores.push({
      term,
      tf,
      idf:   parseFloat(idf.toFixed(4)),
      bm25:  parseFloat(bm25term.toFixed(4)),
    });
  }

  const score = parseFloat(totalScore.toFixed(4));

  // Интерпретация по разделу 9 ТЗ
  let interpretation;
  if (score > 15)      interpretation = 'excellent';
  else if (score >= 10) interpretation = 'good';
  else                  interpretation = 'poor';

  return {
    score,
    interpretation,
    queryTerms: queryTerms.length,
    docLength:  docLen,
    termScores: termScores.sort((a, b) => b.bm25 - a.bm25),
  };
}

module.exports = { calculateBM25, tokenize };
