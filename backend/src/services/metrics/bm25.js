const { stem } = require('../../utils/russianStem');

/**
 * BM25 scoring function.
 *
 * @param {string} query – search query
 * @param {string} document – document text
 * @param {object} [opts]
 * @param {number} [opts.k1=1.5] – term frequency saturation
 * @param {number} [opts.b=0.75] – length normalization
 * @param {number} [opts.avgDl=500] – average document length
 * @returns {number} BM25 score
 */
function calculateBM25(query, document, opts = {}) {
  if (!query || !document) return 0;

  const { k1 = 1.5, b = 0.75, avgDl = 500 } = opts;

  const queryTerms = tokenize(query);
  const docTerms = tokenize(document);

  if (queryTerms.length === 0 || docTerms.length === 0) return 0;

  const dl = docTerms.length;

  // Build term frequency map for document
  const tf = {};
  for (const term of docTerms) {
    tf[term] = (tf[term] || 0) + 1;
  }

  let score = 0;
  for (const qTerm of queryTerms) {
    const termFreq = tf[qTerm] || 0;
    if (termFreq === 0) continue;

    // Simplified IDF (single-document context — treat as present in 1 of 2 docs)
    const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));

    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (dl / avgDl));

    score += idf * (numerator / denominator);
  }

  return score;
}

/**
 * Tokenize text: lowercase, split by non-word chars, stem Russian words.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\wа-яёА-ЯЁ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => stem(w));
}

module.exports = { calculateBM25 };
