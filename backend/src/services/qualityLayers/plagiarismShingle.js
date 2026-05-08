'use strict';

/**
 * plagiarismShingle — A3 плана «Усиление "Комбайна"».
 *
 * Состоит из двух подсистем:
 *
 *   1. Внешний шингл-сравнитель (A3.1):
 *      w-shingles (n=5–7 слов после нормализации) → Jaccard и containment
 *      по каждому источнику из SERP. При превышении порога maxOverlap —
 *      сигнал «надо перефразировать H2».
 *
 *   2. Внутренний детектор дублей (A3.2):
 *      попарное косинусное сходство абзацев в статье через TF-IDF
 *      (переиспользует backend/src/utils/semanticSimilarity.js — без новых
 *      сетевых зависимостей). При превышении порога maxCosine — сигнал
 *      «удалить более поздний абзац» (writer должен переписать).
 *
 * Все функции pure: ничего не пишут в БД, не делают HTTP-запросов, не
 * читают process.env. Подключение к pipeline и обработка retry — задача
 * вызывающего кода (см. featureFlags.plagiarism).
 */

const {
  tokenize,
  cosineSimilarity,
  splitIntoParagraphs,
} = require('../../utils/semanticSimilarity');

// ── A3.1. Шингл-сравнитель ─────────────────────────────────────────

/**
 * normalizeForShingles — нормализация перед нарезкой:
 *   - lower-case;
 *   - стеммированные токены (через существующий tokenize, который уже
 *     отбрасывает стоп-слова и применяет russianStem);
 *   - результат — массив токенов.
 */
function normalizeForShingles(text) {
  return tokenize(text || '');
}

/**
 * shingleSet — набор уникальных n-словных шинглов из последовательности
 * токенов. Возвращает Set строк "tok1|tok2|...|tokN" длиной n.
 *
 * При len(tokens) < n — Set с одним элементом-всем-текстом (чтобы короткие
 * абзацы не давали 0/0 Jaccard).
 */
function shingleSet(tokens, n = 6) {
  const set = new Set();
  if (!tokens || !tokens.length) return set;
  if (tokens.length < n) {
    set.add(tokens.join('|'));
    return set;
  }
  for (let i = 0; i <= tokens.length - n; i += 1) {
    set.add(tokens.slice(i, i + n).join('|'));
  }
  return set;
}

/**
 * jaccard — |A ∩ B| / |A ∪ B|.
 */
function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * containment — |A ∩ B| / |A|. Метрика «сколько от нашего текста A
 * найдено в источнике B». Хорошо ловит частичное копирование (когда
 * мы скопировали кусок из большого источника) — Jaccard в этом случае
 * занижен из-за большого |B|.
 */
function containment(setA, setB) {
  if (!setA.size) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter += 1;
  return inter / setA.size;
}

/**
 * compareTextsAgainstSources — A3.1.
 *
 * @param {Array<{id?:string, h2?:string, text:string}>} ourBlocks
 *        блоки нашей статьи (обычно — H2-секции после splitByH2).
 * @param {Array<{url:string, title?:string, text:string}>} sources
 *        источники из SERP (relevance pipeline).
 * @param {object} [opts]
 * @param {number} [opts.shingleN=6]       размер шингла (5–7 типично).
 * @param {number} [opts.maxOverlap=0.18]  порог: max(jaccard, containment).
 * @returns {{
 *   blocks: Array<{
 *     id, h2, maxOverlap, worstSource:{url,title,jaccard,containment} | null
 *   }>,
 *   externalMaxOverlap: number,
 *   externalSources: Array<{url, title, maxOverlapAcrossBlocks: number}>,
 *   violations: Array<{ blockId, h2, url, jaccard, containment }>,
 * }}
 */
function compareTextsAgainstSources(ourBlocks, sources, opts = {}) {
  const shingleN = opts.shingleN || 6;
  const maxOverlap = typeof opts.maxOverlap === 'number' ? opts.maxOverlap : 0.18;

  const ourPrep = (ourBlocks || []).map((b, i) => ({
    id: b.id || `b${i}`,
    h2: b.h2 || '',
    text: b.text || '',
    shingles: shingleSet(normalizeForShingles(b.text || ''), shingleN),
  }));

  const srcPrep = (sources || []).map((s, i) => ({
    url: s.url || `src${i}`,
    title: s.title || '',
    shingles: shingleSet(normalizeForShingles(s.text || ''), shingleN),
  }));

  const blocksReport = [];
  const violations = [];
  const sourceMaxByUrl = new Map();

  let externalMaxOverlap = 0;

  for (const ours of ourPrep) {
    let blockMax = 0;
    let worst = null;
    for (const src of srcPrep) {
      const j = jaccard(ours.shingles, src.shingles);
      const c = containment(ours.shingles, src.shingles);
      const overlap = Math.max(j, c);
      const prev = sourceMaxByUrl.get(src.url) || 0;
      if (overlap > prev) sourceMaxByUrl.set(src.url, overlap);
      if (overlap > blockMax) {
        blockMax = overlap;
        worst = { url: src.url, title: src.title, jaccard: j, containment: c };
      }
      if (overlap > maxOverlap) {
        violations.push({
          blockId: ours.id,
          h2: ours.h2,
          url: src.url,
          jaccard: j,
          containment: c,
        });
      }
    }
    if (blockMax > externalMaxOverlap) externalMaxOverlap = blockMax;
    blocksReport.push({
      id: ours.id,
      h2: ours.h2,
      maxOverlap: blockMax,
      worstSource: worst,
    });
  }

  const externalSources = Array.from(sourceMaxByUrl.entries())
    .map(([url, mx]) => {
      const meta = srcPrep.find((s) => s.url === url) || {};
      return { url, title: meta.title || '', maxOverlapAcrossBlocks: mx };
    })
    .sort((a, b) => b.maxOverlapAcrossBlocks - a.maxOverlapAcrossBlocks);

  return {
    blocks: blocksReport,
    externalMaxOverlap,
    externalSources,
    violations,
  };
}

// ── A3.2. Внутренний детектор дублей абзацев ───────────────────────

/**
 * findInternalDuplicates — попарное косинусное сходство абзацев статьи.
 * Используется TF-IDF из semanticSimilarity (общая инфраструктура).
 * При превышении maxCosine пара попадает в violations.
 *
 * Политика «оставить более ранний абзац» применяется на стороне
 * вызывающего pipeline-кода — здесь только детектор и отчёт.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.maxCosine=0.92]
 * @param {number} [opts.minChars=120]  игнорируем короткие абзацы
 * @returns {{
 *   pairs: Array<{ aIndex, bIndex, cosine, aSnippet, bSnippet }>,
 *   maxCosine: number,
 *   paragraphCount: number,
 * }}
 */
function findInternalDuplicates(html, opts = {}) {
  const maxCosine = typeof opts.maxCosine === 'number' ? opts.maxCosine : 0.92;
  const minChars = opts.minChars || 120;

  const allParas = splitIntoParagraphs(html || '');
  const paragraphs = allParas.filter((p) => p.text.length >= minChars);

  if (paragraphs.length < 2) {
    return { pairs: [], maxCosine: 0, paragraphCount: paragraphs.length };
  }

  // Строим IDF на базе самих абзацев. Для пары абзац-абзац IDF играет
  // роль «не учитывай слова, встречающиеся везде». При маленьком N (всего
  // несколько параграфов) cosine может быть слегка завышен — поэтому
  // порог по умолчанию 0.92, а не 0.85.
  const tokensList = paragraphs.map((p) => tokenize(p.text));

  // Локальный IDF (без зависимости от внутренних helpers semanticSimilarity).
  const idf = new Map();
  const N = tokensList.length;
  for (const toks of tokensList) {
    const seen = new Set(toks);
    for (const t of seen) {
      idf.set(t, (idf.get(t) || 0) + 1);
    }
  }
  for (const [t, df] of idf) {
    idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  function tfidfVec(toks) {
    const vec = new Map();
    if (!toks.length) return vec;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      const w = (f / toks.length) * (idf.get(t) || 0);
      if (w > 0) vec.set(t, w);
    }
    return vec;
  }

  const vecs = tokensList.map(tfidfVec);

  const pairs = [];
  let max = 0;
  for (let i = 0; i < vecs.length; i += 1) {
    for (let j = i + 1; j < vecs.length; j += 1) {
      const c = cosineSimilarity(vecs[i], vecs[j]);
      if (c > max) max = c;
      if (c >= maxCosine) {
        pairs.push({
          aIndex: paragraphs[i].index,
          bIndex: paragraphs[j].index,
          cosine: c,
          aSnippet: paragraphs[i].text.slice(0, 140),
          bSnippet: paragraphs[j].text.slice(0, 140),
        });
      }
    }
  }

  return { pairs, maxCosine: max, paragraphCount: paragraphs.length };
}

// ── Сборный отчёт для task.plagiarism ──────────────────────────────

/**
 * buildPlagiarismReport — собирает финальный отчёт по структуре,
 * описанной в плане A3.3.
 *
 * @param {object} args
 * @param {ReturnType<typeof compareTextsAgainstSources>} [args.external]
 * @param {ReturnType<typeof findInternalDuplicates>}     [args.internal]
 * @returns {object}
 */
function buildPlagiarismReport({ external, internal } = {}) {
  return {
    externalMaxOverlap: external ? external.externalMaxOverlap : 0,
    externalSources: external ? external.externalSources : [],
    externalViolations: external ? external.violations : [],
    internalDuplicatePairs: internal ? internal.pairs : [],
    internalMaxCosine: internal ? internal.maxCosine : 0,
  };
}

module.exports = {
  // shingles
  shingleSet,
  jaccard,
  containment,
  compareTextsAgainstSources,
  // internal cosine
  findInternalDuplicates,
  // assembly
  buildPlagiarismReport,
  // helper exports for tests
  _internal: { normalizeForShingles },
};
