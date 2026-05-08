'use strict';

/**
 * lsiPipeline — многофазный подбор LSI-набора для статьи.
 *
 * Фазы:
 *   1) base extract: детерминированно извлекает «корни» из:
 *      - intents.entities[*].entity (high+medium importance);
 *      - intents.semantic_anchors;
 *      - intents.user_questions[*].question (стеммированные «значимые» леммы);
 *      - outline.sections[*].lsi_focus.
 *      Каждый исходный термин проходит через russianStem; группируем по
 *      стемму и берём наиболее «удобную» поверхностную форму (короткое
 *      словосочетание из 1–3 слов).
 *
 *   2) DeepSeek synthesis (Stage 2B): расширяем базу до important/supporting/banned
 *      с категоризацией. Промт включает base_lsi_seed как «нижний слой».
 *
 *   3) corrective retry: если coverage_self_audit.missed_seed_terms содержит
 *      термины, которые мы передавали в base_lsi_seed, делаем РОВНО ОДИН
 *      повторный вызов с prior_missed = эти термины. Это DSPy-стиль
 *      corrective retry, аналогичный editorCopilot/streamRunner.js.
 *
 * Возвращает финальный lsi_set (с гарантией не-пустоты для important).
 */

const { callLLM } = require('../llm/callLLM');
const { loadInfoArticlePrompt } = require('../../prompts/infoArticle');
const { russianStem } = require('../../utils/russianStem');
const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она',
  'так','его','но','да','ты','к','у','же','вы','за','бы','по','только','ее',
  'мне','было','вот','от','меня','еще','нет','о','из','ему','теперь','когда',
  'даже','ну','вдруг','ли','если','уже','или','ни','быть','был','него','до',
  'вас','нибудь','опять','уж','вам','ведь','там','потом','себя','ничего','ей',
  'может','они','тут','где','есть','надо','ней','для','мы','тебя','их','чем',
  'была','сам','чтоб','без','будто','чего','раз','тоже','себе','под','будет',
  'ж','тогда','кто','этот','того','потому','этого','какой','совсем','ним',
  'здесь','этом','один','почти','мой','тем','чтобы','нее','сейчас','были',
  'куда','зачем','всех','никогда','можно','при','наконец','два','об','другой',
  'хоть','после','над','больше','тот','через','эти','нас','про','всего','них',
  'какая','много','разве','три','эту','моя','впрочем','хорошо','свою','этой',
  'перед','иногда','лучше','чуть','том','нельзя','такой','им','более','всегда',
  'конечно','всю','между','всё','это','всю','моё','моя','моё','свой','свою',
  'наш','наша','наши','ваш','ваша','ваши','их','я','ты','мы','вы','он','она',
  'оно','они','сем','тех','такие','такая','такое','такие','чем-то','что-то',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .split(/[^а-яa-z0-9-]+/i)
    .filter((w) => w && w.length >= 3 && !STOPWORDS.has(w));
}

function stemKey(word) {
  if (/^[a-z0-9-]+$/i.test(word)) return word.toLowerCase();
  return russianStem(word);
}

/**
 * Phase 1: deterministic base seed.
 *   Returns an array of surface terms (1–3 words) deduped by stem-key,
 *   capped to max items.
 */
function extractBaseSeed({ intents, outline, max = 60 }) {
  const seedByStem = new Map();   // stem → { surface, score, count }

  const consider = (term, weight = 1) => {
    if (!term) return;
    const surface = String(term).trim().toLowerCase();
    if (!surface || surface.length < 3 || surface.length > 60) return;
    if (/^\d+$/.test(surface)) return;
    // Compute key = first significant token's stem (for multi-word terms — join stems).
    const tokens = tokenize(surface);
    if (!tokens.length) return;
    const key = tokens.map(stemKey).join('|');
    const prev = seedByStem.get(key);
    if (prev) {
      prev.score += weight;
      prev.count += 1;
      // Prefer shorter surface.
      if (surface.length < prev.surface.length) prev.surface = surface;
    } else {
      seedByStem.set(key, { surface, score: weight, count: 1 });
    }
  };

  if (intents && typeof intents === 'object') {
    for (const e of Array.isArray(intents.entities) ? intents.entities : []) {
      if (!e || !e.entity) continue;
      const w = e.importance === 'high' ? 3 : e.importance === 'medium' ? 2 : 1;
      consider(e.entity, w);
    }
    for (const a of Array.isArray(intents.semantic_anchors) ? intents.semantic_anchors : []) {
      consider(a, 2);
    }
    for (const q of Array.isArray(intents.user_questions) ? intents.user_questions : []) {
      const tokens = tokenize(q?.question || '').filter((t) => t.length >= 4);
      // Берём bigrams + triplets как кандидаты семантических анкоров.
      for (let i = 0; i < tokens.length - 1; i += 1) {
        consider(`${tokens[i]} ${tokens[i + 1]}`, 0.5);
      }
    }
  }

  if (outline && Array.isArray(outline.sections)) {
    for (const s of outline.sections) {
      for (const lf of Array.isArray(s?.lsi_focus) ? s.lsi_focus : []) consider(lf, 2);
      for (const me of Array.isArray(s?.must_include_entities) ? s.must_include_entities : []) consider(me, 1);
    }
  }

  return Array.from(seedByStem.values())
    .sort((a, b) => b.score - a.score || a.surface.length - b.surface.length)
    .slice(0, max)
    .map((x) => x.surface);
}

/**
 * Phase 2 + 3: synthesize via DeepSeek with optional corrective retry.
 *
 * @param {object} args
 * @param {string} args.adapter        — 'deepseek'
 * @param {object} args.task
 * @param {object} args.intents
 * @param {object} args.outline
 * @param {object} args.callContext    — { taskId, stageName, onLog, onTokens }
 * @returns {Promise<object>}          — { lsi_set, base_seed, corrective_used }
 */
async function synthesizeLsiSet({ adapter = 'deepseek', task, intents, outline, callContext = {} }) {
  const baseSeed = extractBaseSeed({ intents, outline, max: 50 });
  const system = loadInfoArticlePrompt('stage2bLsi');

  const buildUser = (priorMissed = []) => {
    const payload = {
      topic:         task.topic || '',
      region:        task.region || '',
      outline:       outline || {},
      intents:       intents || {},
      base_lsi_seed: baseSeed,
    };
    if (priorMissed.length) payload.prior_missed = priorMissed;
    return JSON.stringify(payload);
  };

  // --- 1st pass ---
  let result;
  try {
    result = await callLLM(adapter, system, buildUser(), {
      ...callContext,
      callLabel: 'Stage 2B LSI synth',
    });
  } catch (err) {
    // Fail soft: вернём базовый seed как important, чтобы не блокировать пайплайн.
    return {
      lsi_set: { important: baseSeed.slice(0, 25), supporting: [], banned: [], categories: {} },
      base_seed: baseSeed,
      corrective_used: false,
      llm_error: err.message,
    };
  }

  let lsi = sanitizeLsi(result, baseSeed);

  // --- 2nd corrective pass if needed ---
  const audit = result?.coverage_self_audit || {};
  const missedDeclared = Array.isArray(audit.missed_seed_terms) ? audit.missed_seed_terms.filter((s) => typeof s === 'string') : [];
  // Дополнительная программная проверка: какие из base_seed реально не попали в important?
  const importantStems = new Set(lsi.important.map((t) => stemKey(t)));
  const baseSeedStems  = baseSeed.map((t) => ({ surface: t, key: stemKey(t) }));
  const programMissed = baseSeedStems.filter((b) => !importantStems.has(b.key)).map((b) => b.surface);
  // Объединяем (преимущество — declared, дополняем program-detected).
  const missed = Array.from(new Set([...missedDeclared, ...programMissed])).slice(0, 12);

  let correctiveUsed = false;
  if (missed.length >= 3) {
    correctiveUsed = true;
    try {
      const result2 = await callLLM(adapter, system, buildUser(missed), {
        ...callContext,
        callLabel: 'Stage 2B LSI synth (corrective)',
      });
      const lsi2 = sanitizeLsi(result2, baseSeed);
      // Если 2-й проход дал больше important — заменяем.
      if (lsi2.important.length >= lsi.important.length) lsi = lsi2;
    } catch (_) { /* ignore — оставим первый результат */ }
  }

  return { lsi_set: lsi, base_seed: baseSeed, corrective_used: correctiveUsed };
}

function sanitizeLsi(raw, baseSeed) {
  const isStr = (s) => typeof s === 'string' && s.trim().length > 0;
  const norm = (a) => Array.from(new Set(
    (Array.isArray(a) ? a : [])
      .filter(isStr)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2 && s.length <= 60),
  ));
  const important  = norm(raw?.important);
  const supporting = norm(raw?.supporting).filter((s) => !important.includes(s));
  const banned     = norm(raw?.banned).filter((s) => !important.includes(s) && !supporting.includes(s));
  // Гарантируем минимум: если important пуст — возьмём топ-15 из base_seed.
  if (!important.length && Array.isArray(baseSeed) && baseSeed.length) {
    important.push(...baseSeed.slice(0, 15).map((s) => s.toLowerCase()));
  }
  const categories = (raw && typeof raw.categories === 'object' && raw.categories) ? raw.categories : {};
  return { important, supporting, banned, categories };
}

/**
 * Программное измерение coverage финального HTML против lsi_set.important
 * (используется в orchestrator для refine-loop триггера).
 */
function measureLsiCoverageInHtml(html, importantTerms) {
  if (!html || !Array.isArray(importantTerms) || !importantTerms.length) {
    return { coveredCount: 0, totalCount: importantTerms?.length || 0, coveragePct: 0, missing: [] };
  }
  // Iterative tag strip — устойчиво к нестед/малформ HTML
  // (CodeQL js/incomplete-multi-character-sanitization).
  const text = stripHtmlTagsToText(html).toLowerCase().replace(/[ёЁ]/g, 'е');
  const tokens = tokenize(text);
  const stemSet = new Set(tokens.map(stemKey));
  let covered = 0;
  const missing = [];
  for (const term of importantTerms) {
    const tStems = tokenize(term).map(stemKey);
    if (!tStems.length) continue;
    const hit = tStems.every((s) => stemSet.has(s));
    if (hit) covered += 1;
    else missing.push(term);
  }
  const total = importantTerms.length;
  return {
    coveredCount: covered,
    totalCount: total,
    coveragePct: total ? Math.round((covered / total) * 1000) / 10 : 0,
    missing,
  };
}

// ── Phase 2 / Б2: семантический коверидж (stem-bigram cosine) ─────────
//
// Подход: вместо точного string-match через стеммы (текущий
// `measureLsiCoverageInHtml` ниже = подстрока), считаем максимальный
// cosine-similarity LSI-термина с каждым предложением статьи. Если
// max ≥ threshold (по умолчанию 0.55) — термин «семантически покрыт».
//
// Контракт без LLM/embeddings: используем разреженные «embeddings» в виде
// мульти-сета stem-униграмм + stem-биграмм нормализованного предложения
// (та же tokenize+stemKey, что в Phase 1). Это:
//   • устойчиво к морфологии (стеммы);
//   • учитывает порядок (биграммы);
//   • не требует ML-модели и сети;
//   • даёт более мягкий матч, чем «все стеммы термина в любом месте текста».
//
// Гибрид-режим: substring-stem (быстрый) считается первым; покрытые им
// термины не требуют семантического матча. Для оставшихся «промахнутых»
// прогоняем семантический матч (медленнее, но число кандидатов меньше).
//
// Используется в orchestrator для понижения частоты ложных corrective-retry
// (Б2.2). Включается env'ом INFO_ARTICLE_LSI_SEMANTIC_ENABLED.

const LSI_SEMANTIC_COVERAGE_THRESHOLD = (() => {
  const v = parseFloat(process.env.LSI_SEMANTIC_COVERAGE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.55;
})();

/** Делит текст на «псевдо-предложения» по терминаторам .?! и абзацам. */
function splitSentencesPlain(text) {
  if (!text) return [];
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+(?=[А-ЯA-ZЁ«"'(\d])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);
}

/** Возвращает Map<stemBigramKey, count> — «embedding»-вектор из стеммов. */
function buildStemBigramVector(text) {
  const v = new Map();
  const tokens = tokenize(text);
  if (!tokens.length) return v;
  const stems = tokens.map(stemKey);
  // unigrams (вес 1)
  for (const s of stems) v.set(s, (v.get(s) || 0) + 1);
  // bigrams (вес 1)
  for (let i = 0; i < stems.length - 1; i += 1) {
    const k = `${stems[i]}|${stems[i + 1]}`;
    v.set(k, (v.get(k) || 0) + 1);
  }
  return v;
}

/** Cosine similarity двух Map<key, count>. */
function cosineMaps(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  if (!na || !nb) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, w] of small) {
    const w2 = big.get(k);
    if (w2) dot += w * w2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * measureLsiCoverageSemantic — гибрид substring+семантический матч.
 *
 * @param {string} html
 * @param {string[]} importantTerms
 * @param {object} [opts]
 * @param {number} [opts.threshold=LSI_SEMANTIC_COVERAGE_THRESHOLD] — порог cosine
 * @param {boolean} [opts.useSubstringPrecheck=true] — гибрид-режим
 * @returns {{
 *   coveredCount, totalCount, coveragePct, missing,
 *   substring_covered, semantic_covered,
 *   per_term: Array<{term, hit_kind, max_cosine, substring_hit}>,
 *   threshold,
 * }}
 */
function measureLsiCoverageSemantic(html, importantTerms, opts = {}) {
  const threshold = (typeof opts.threshold === 'number' && Number.isFinite(opts.threshold))
    ? opts.threshold : LSI_SEMANTIC_COVERAGE_THRESHOLD;
  const useSubstringPrecheck = opts.useSubstringPrecheck !== false;

  if (!html || !Array.isArray(importantTerms) || !importantTerms.length) {
    return {
      coveredCount: 0,
      totalCount: importantTerms?.length || 0,
      coveragePct: 0,
      missing: [],
      substring_covered: 0,
      semantic_covered:  0,
      per_term: [],
      threshold,
    };
  }

  const plain = stripHtmlTagsToText(html).toLowerCase().replace(/[ёЁ]/g, 'е');
  const sentences = splitSentencesPlain(plain);
  const tokens    = tokenize(plain);
  const stemSet   = new Set(tokens.map(stemKey));

  // pre-build sentence vectors lazily — только если нужен семантический проход.
  let sentenceVectors = null;

  let substringCovered = 0;
  let semanticCovered  = 0;
  const missing = [];
  const perTerm = [];

  for (const term of importantTerms) {
    const tStems = tokenize(term).map(stemKey);
    if (!tStems.length) {
      perTerm.push({ term, hit_kind: 'skipped', max_cosine: 0, substring_hit: false });
      continue;
    }

    // Phase 1: substring-stem precheck (быстро). Все стеммы термина должны
    // присутствовать где-то в статье.
    const substrHit = tStems.every((s) => stemSet.has(s));

    if (useSubstringPrecheck && substrHit) {
      substringCovered += 1;
      perTerm.push({ term, hit_kind: 'substring', max_cosine: 1.0, substring_hit: true });
      continue;
    }

    // Phase 2: семантический матч — максимальный cosine с предложениями.
    if (!sentenceVectors) {
      sentenceVectors = sentences.map(buildStemBigramVector);
    }
    const termVec = buildStemBigramVector(term);
    let maxCos = 0;
    for (const sv of sentenceVectors) {
      const c = cosineMaps(termVec, sv);
      if (c > maxCos) maxCos = c;
      if (maxCos >= 1) break;
    }
    if (maxCos >= threshold) {
      semanticCovered += 1;
      perTerm.push({
        term,
        hit_kind: 'semantic',
        max_cosine: Math.round(maxCos * 1000) / 1000,
        substring_hit: substrHit,
      });
    } else {
      missing.push(term);
      perTerm.push({
        term,
        hit_kind: 'miss',
        max_cosine: Math.round(maxCos * 1000) / 1000,
        substring_hit: substrHit,
      });
    }
  }

  const total = importantTerms.length;
  const covered = substringCovered + semanticCovered;
  return {
    coveredCount: covered,
    totalCount:   total,
    coveragePct:  total ? Math.round((covered / total) * 1000) / 10 : 0,
    missing,
    substring_covered: substringCovered,
    semantic_covered:  semanticCovered,
    per_term:          perTerm,
    threshold,
  };
}

module.exports = {
  extractBaseSeed,
  synthesizeLsiSet,
  sanitizeLsi,
  measureLsiCoverageInHtml,
  measureLsiCoverageSemantic,
  LSI_SEMANTIC_COVERAGE_THRESHOLD,
  // exports for tests
  _internal: { tokenize, stemKey, splitSentencesPlain, buildStemBigramVector, cosineMaps },
};
