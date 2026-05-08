'use strict';

/**
 * plagiarism.service — Phase 1 / P0-3 deterministic anti-plagiarism.
 *
 * Назначение: после того как writer сгенерировал финальный articleHtml,
 * сверяем его с собранными ранее SERP-evidence-сниппетами на предмет
 * текстовых заимствований (n-gram overlap). Цель — поймать ситуации
 * когда LLM «срисовала» абзац у конкурента (типичный паттерн при
 * grounding'е без явного запрета на копирование).
 *
 * Контракт без LLM:
 *   • быстро (<300 ms на статью среднего объёма + типичный evidence),
 *   • воспроизводимо (тот же вход → тот же отчёт),
 *   • без сети.
 *
 * Подход:
 *   1. tokenize(text) — нормализация: нижний регистр, пунктуация → пробел,
 *      коллапс пробелов, кириллица + латиница + цифры. Возвращаем массив
 *      токенов, БЕЗ удаления стоп-слов (для совпадения важна каждая словоформа).
 *
 *   2. buildNGramIndex(evidenceResult, n) — для каждого сниппета извлекаем
 *      все скользящие n-gram (n=5 по умолчанию), пропускаем те, что
 *      состоят ТОЛЬКО из стоп-слов (иначе любой текст «совпал» бы по
 *      «и не так уж и было»). Индекс: Map<ngramKey, Array<{url, snippetIndex}>>.
 *
 *   3. analyzeArticle(html, index, n) — split на предложения (через
 *      factCheck.splitSentences для консистентности), для каждого
 *      предложения greedy ищем максимальные совпадающие run'ы n-gram,
 *      считаем overlap_chars/overlap_pct и собираем источники-доноры.
 *
 *      Status предложения:
 *        — clean:        overlap_pct < SUSPICIOUS_THRESHOLD
 *        — suspicious:   overlap_pct ≥ SUSPICIOUS_THRESHOLD (default 30%)
 *        — plagiarism:   overlap_pct ≥ PLAGIARISM_THRESHOLD (default 60%)
 *
 *   4. summarizePlagiarism(perSentence) — агрегаты + verdict для статьи:
 *        — pass:    plagiarism=0 И overlap_pct_total < ARTICLE_REVIEW
 *        — review:  plagiarism ≤ 1 И overlap_pct_total < ARTICLE_FAIL
 *        — fail:    иначе (или plagiarism > 1)
 *
 * Не делает:
 *   • не модифицирует articleHtml,
 *   • не вызывает LLM / не делает сетевых запросов.
 */

// Reuse normalizers from factCheck (consistent stripHtml + sentence split).
const { stripHtml, splitSentences } = require('./factCheck.service');

// ── Параметры (env-overridable) ────────────────────────────────────

const N_GRAM_SIZE = Math.max(3, Math.min(10,
  parseInt(process.env.INFO_ARTICLE_PLAGIARISM_NGRAM, 10) || 5,
));

// Порог «слишком короткое предложение» — на коротких фразах overlap_pct
// неинформативен (5 слов: один общий 5-gram = 100%). Считаем такие
// предложения, но в summary они не идут в overlap_pct_total.
const MIN_SENTENCE_TOKENS = 8;

// Per-sentence пороги.
const SUSPICIOUS_THRESHOLD = Math.max(0.05, Math.min(0.95,
  parseFloat(process.env.INFO_ARTICLE_PLAGIARISM_SUSPICIOUS_PCT) || 0.30,
));
const PLAGIARISM_THRESHOLD = Math.max(SUSPICIOUS_THRESHOLD, Math.min(0.99,
  parseFloat(process.env.INFO_ARTICLE_PLAGIARISM_FAIL_PCT) || 0.60,
));

// Article-level пороги (на агрегированный overlap_pct_total).
const ARTICLE_REVIEW_PCT = 0.10;   // 10% «своего», но в сумме слишком много заимствований
const ARTICLE_FAIL_PCT   = 0.20;   // 20% — это уже «срисовано»

// Чтобы отчёт не разрастался: топ-N подозрительных предложений и
// макс число источников-доноров на предложение.
const MAX_TOP_SENTENCES = 30;
const MAX_DONORS_PER_SENTENCE = 3;

// ── Стоп-слова (минимальный набор RU+EN) ───────────────────────────
//
// Цель: отбросить n-gram'ы вида «и не так как у нас» — формальные
// совпадения функциональных слов, которые встретятся в любом тексте.
// Это НЕ полноценная лемматизация — нам важен dramat-эффект отбраковки
// «пустых» 5-gram, не аккуратность лингвистическая.

const STOP = new Set([
  // ru
  'и', 'в', 'на', 'с', 'со', 'по', 'к', 'у', 'о', 'об', 'от', 'до', 'из', 'за',
  'для', 'при', 'про', 'над', 'под', 'без', 'через', 'между', 'после', 'перед',
  'а', 'но', 'или', 'либо', 'же', 'ли', 'бы', 'не', 'ни', 'ну', 'да', 'нет',
  'это', 'то', 'тот', 'та', 'те', 'этот', 'эта', 'эти', 'там', 'тут', 'здесь',
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'мне', 'тебе', 'нам', 'вам',
  'его', 'её', 'их', 'нас', 'вас',
  'мой', 'твой', 'свой', 'наш', 'ваш', 'их', 'её',
  'есть', 'был', 'была', 'было', 'были', 'будет', 'будут', 'быть',
  'как', 'что', 'чтобы', 'если', 'когда', 'потому', 'поэтому', 'также', 'тоже',
  'уже', 'ещё', 'еще', 'только', 'вот', 'был', 'все', 'всё', 'всех',
  // en
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'with', 'by', 'at', 'from',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'if', 'so', 'not',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'us', 'them', 'my', 'your',
]);

// ── Tokenization ───────────────────────────────────────────────────

// Допустимые символы внутри токена: латиница + кириллица + цифры + дефис.
// Дефис оставляем, чтобы «топ-10», «эстетико-косметический» считались одним
// токеном. Остальное — разделители.
const TOKEN_RE = /[a-zа-яё0-9]+(?:-[a-zа-яё0-9]+)*/gi;

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    out.push(m[0]);
  }
  return out;
}

function isStop(token) {
  return STOP.has(token);
}

/**
 * Сборка n-gram из массива токенов. Каждый n-gram — строка вида
 * "tok1\u0001tok2\u0001..." (\u0001 — невидимый разделитель, не встречается
 * в нормальном тексте). Пропускаем n-gram, состоящие ТОЛЬКО из стоп-слов
 * (иначе общие фразы вроде «и в этом случае мы» дадут ложные совпадения).
 *
 * Возвращаем массив { key, startIdx } — startIdx нужен для реконструкции
 * длины «закрытого» отрезка в исходных токенах при greedy-объединении.
 */
function buildNGrams(tokens, n) {
  const out = [];
  if (!Array.isArray(tokens) || tokens.length < n) return out;
  for (let i = 0; i + n <= tokens.length; i += 1) {
    let allStop = true;
    for (let j = 0; j < n; j += 1) {
      if (!isStop(tokens[i + j])) { allStop = false; break; }
    }
    if (allStop) continue;
    out.push({ key: tokens.slice(i, i + n).join('\u0001'), startIdx: i });
  }
  return out;
}

// ── Index over evidence ────────────────────────────────────────────

/**
 * buildNGramIndex(evidenceResult, n?) → {
 *   index: Map<ngramKey, Array<{url, h1, snippetIndex}>>,
 *   stats: { snippets, ngrams, uniqueNgrams, n }
 * }
 *
 * Для одного и того же n-gram внутри одного сниппета НЕ дублируем
 * запись (нас интересует «есть/нет», а не количество).
 */
function buildNGramIndex(evidenceResult, n = N_GRAM_SIZE) {
  const index = new Map();
  let snippets = 0;
  let ngrams = 0;
  const evItems = (evidenceResult && Array.isArray(evidenceResult.evidence))
    ? evidenceResult.evidence : [];
  for (const it of evItems) {
    const url = it.url || '';
    const h1  = it.h1  || '';
    const snippetsArr = Array.isArray(it.snippets) ? it.snippets : [];
    for (let sIdx = 0; sIdx < snippetsArr.length; sIdx += 1) {
      snippets += 1;
      const text = (snippetsArr[sIdx] && snippetsArr[sIdx].text) || '';
      const tokens = tokenize(text);
      const ngs = buildNGrams(tokens, n);
      const seenInThisSnippet = new Set();
      for (const ng of ngs) {
        if (seenInThisSnippet.has(ng.key)) continue;
        seenInThisSnippet.add(ng.key);
        ngrams += 1;
        const arr = index.get(ng.key);
        const entry = { url, h1, snippetIndex: sIdx };
        if (arr) arr.push(entry);
        else index.set(ng.key, [entry]);
      }
    }
  }
  return {
    index,
    stats: { snippets, ngrams, uniqueNgrams: index.size, n },
  };
}

// ── Per-sentence overlap ───────────────────────────────────────────

/**
 * computeSentenceOverlap(sentence, indexInfo) → {
 *   text, tokens, matchedTokens, overlapPct, status, donors
 * }
 *
 * Greedy «жадное расширение» совпадений: идём по токенам слева направо,
 * на каждой позиции пытаемся найти n-gram в индексе; если есть —
 * расширяем «закрытый» отрезок вправо, пока следующий n-gram тоже в индексе.
 * Этот подход правильно считает длинные дословные цитаты как ОДИН
 * матч, а не как сумму перекрывающихся n-gram (что переоценило бы overlap).
 */
function computeSentenceOverlap(sentence, indexInfo) {
  const text = String(sentence || '');
  const tokens = tokenize(text);
  const totalTok = tokens.length;
  if (totalTok < indexInfo.stats.n) {
    return {
      text, tokens: totalTok, matchedTokens: 0,
      overlapPct: 0, status: 'clean', donors: [], shortSentence: true,
    };
  }
  const n = indexInfo.stats.n;
  const idx = indexInfo.index;

  // Карта: позиция начала покрытого диапазона → длина (в токенах).
  // Greedy: жадно расширяем максимальный run.
  const matched = new Uint8Array(totalTok); // 1 если токен в покрытом отрезке
  // Доноры: считаем, какие сниппеты участвовали в покрытии (по числу
  // распространённых n-gram); потом сортируем по убыванию и оставляем top-N.
  const donorScore = new Map();   // key=`url|sIdx` → matched_ngrams_count
  const donorMeta  = new Map();   // key=`url|sIdx` → { url, h1, snippetIndex }

  let i = 0;
  while (i + n <= totalTok) {
    // Проверяем, есть ли n-gram в индексе.
    const key = tokens.slice(i, i + n).join('\u0001');
    const matches = idx.get(key);
    if (!matches) {
      i += 1;
      continue;
    }
    // Жадно расширяем вправо: пока следующий n-gram тоже в индексе,
    // двигаемся на 1 токен вперёд.
    let end = i + n;     // exclusive
    let runNgrams = 1;
    for (const m of matches) {
      const k = `${m.url}|${m.snippetIndex}`;
      donorScore.set(k, (donorScore.get(k) || 0) + 1);
      if (!donorMeta.has(k)) donorMeta.set(k, m);
    }
    while (end < totalTok) {
      const nextKey = tokens.slice(end - n + 1, end + 1).join('\u0001');
      const nextMatches = idx.get(nextKey);
      if (!nextMatches) break;
      end += 1;
      runNgrams += 1;
      for (const m of nextMatches) {
        const k = `${m.url}|${m.snippetIndex}`;
        donorScore.set(k, (donorScore.get(k) || 0) + 1);
      }
    }
    // Помечаем токены [i .. end-1] как matched.
    for (let p = i; p < end; p += 1) matched[p] = 1;
    i = end;   // следующая итерация — после покрытого отрезка
    // runNgrams используется только в локальном анализе; на самом отчёте
    // не отражается, но оставляем переменную для ясности кода.
    void runNgrams;
  }

  let matchedCount = 0;
  for (let p = 0; p < totalTok; p += 1) if (matched[p]) matchedCount += 1;
  const overlapPct = totalTok ? matchedCount / totalTok : 0;

  // Топ-N доноров по числу совпавших n-gram.
  const donors = Array.from(donorScore.entries())
    .map(([k, score]) => ({ ...donorMeta.get(k), matchedNgrams: score }))
    .sort((a, b) => b.matchedNgrams - a.matchedNgrams)
    .slice(0, MAX_DONORS_PER_SENTENCE);

  let status = 'clean';
  if (overlapPct >= PLAGIARISM_THRESHOLD) status = 'plagiarism';
  else if (overlapPct >= SUSPICIOUS_THRESHOLD) status = 'suspicious';

  return {
    text, tokens: totalTok, matchedTokens: matchedCount,
    overlapPct: Math.round(overlapPct * 1000) / 1000,
    status, donors,
  };
}

// ── Article-level analysis & summary ──────────────────────────────

function analyzeArticle(html, indexInfo) {
  const plain = stripHtml(html);
  const sentences = splitSentences(plain);
  const out = [];
  for (const s of sentences) {
    out.push(computeSentenceOverlap(s, indexInfo));
  }
  return out;
}

function summarizePlagiarism(perSentence) {
  let totalSentences = 0, scoredSentences = 0;
  let cleanCount = 0, suspiciousCount = 0, plagiarismCount = 0;
  let totalTokens = 0, totalMatchedTokens = 0;
  for (const r of perSentence) {
    totalSentences += 1;
    if (r.shortSentence) continue;
    scoredSentences += 1;
    totalTokens += r.tokens;
    totalMatchedTokens += r.matchedTokens;
    if (r.status === 'plagiarism') plagiarismCount += 1;
    else if (r.status === 'suspicious') suspiciousCount += 1;
    else cleanCount += 1;
  }
  const overlapPctTotal = totalTokens > 0 ? totalMatchedTokens / totalTokens : 0;

  let verdict = 'pass';
  if (totalSentences === 0) {
    verdict = 'na';
  } else if (plagiarismCount > 1 || overlapPctTotal >= ARTICLE_FAIL_PCT) {
    verdict = 'fail';
  } else if (plagiarismCount === 1 || overlapPctTotal >= ARTICLE_REVIEW_PCT || suspiciousCount > 3) {
    verdict = 'review';
  }

  return {
    totalSentences,
    scoredSentences,
    cleanCount,
    suspiciousCount,
    plagiarismCount,
    overlapPctTotal: Math.round(overlapPctTotal * 1000) / 10,   // в процентах, 1 знак
    verdict,
    thresholds: {
      ngram_size: N_GRAM_SIZE,
      sentence_suspicious: SUSPICIOUS_THRESHOLD,
      sentence_plagiarism: PLAGIARISM_THRESHOLD,
      article_review_pct:  ARTICLE_REVIEW_PCT,
      article_fail_pct:    ARTICLE_FAIL_PCT,
      min_sentence_tokens: MIN_SENTENCE_TOKENS,
    },
  };
}

/**
 * runPlagiarismCheck(html, evidenceResult, opts?) → высокоуровневый фасад.
 * Возвращает компактный отчёт для сохранения в plagiarism_report JSONB.
 */
function runPlagiarismCheck(html, evidenceResult, opts = {}) {
  const n = (opts && opts.n) || N_GRAM_SIZE;
  const indexInfo = buildNGramIndex(evidenceResult, n);
  const perSentence = analyzeArticle(html, indexInfo);
  const summary = summarizePlagiarism(perSentence);

  // Топ-K самых проблемных предложений: сначала plagiarism, потом suspicious,
  // в каждой группе — по убыванию overlapPct. Включаем donors с дедупом по url.
  const ranked = perSentence
    .filter((r) => !r.shortSentence && (r.status === 'plagiarism' || r.status === 'suspicious'))
    .sort((a, b) => {
      // plagiarism > suspicious
      const wa = a.status === 'plagiarism' ? 2 : 1;
      const wb = b.status === 'plagiarism' ? 2 : 1;
      if (wb !== wa) return wb - wa;
      return b.overlapPct - a.overlapPct;
    })
    .slice(0, MAX_TOP_SENTENCES)
    .map((r) => ({
      text: r.text,
      tokens: r.tokens,
      matchedTokens: r.matchedTokens,
      overlapPct: r.overlapPct,
      status: r.status,
      donors: _dedupDonorsByUrl(r.donors),
    }));

  // Уникальные доноры по URL в целом по статье — кому «обязаны» совпадениями.
  const donorAggregate = new Map();
  for (const r of perSentence) {
    if (r.shortSentence) continue;
    for (const d of r.donors || []) {
      const cur = donorAggregate.get(d.url) || { url: d.url, h1: d.h1, sentences: 0, matchedNgrams: 0 };
      cur.sentences += 1;
      cur.matchedNgrams += d.matchedNgrams || 0;
      donorAggregate.set(d.url, cur);
    }
  }
  const topDonors = Array.from(donorAggregate.values())
    .sort((a, b) => b.matchedNgrams - a.matchedNgrams)
    .slice(0, 10);

  return {
    generated_at: new Date().toISOString(),
    summary,
    index_stats: indexInfo.stats,
    top_sentences: ranked,
    top_donors: topDonors,
  };
}

function _dedupDonorsByUrl(donors) {
  const seen = new Set();
  const out = [];
  for (const d of (donors || [])) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    out.push(d);
  }
  return out;
}

module.exports = {
  // Public API
  runPlagiarismCheck,
  buildNGramIndex,
  analyzeArticle,
  summarizePlagiarism,
  computeSentenceOverlap,
  // Helpers (exported for tests)
  tokenize,
  isStop,
  buildNGrams,
  // Constants
  N_GRAM_SIZE,
  SUSPICIOUS_THRESHOLD,
  PLAGIARISM_THRESHOLD,
  ARTICLE_REVIEW_PCT,
  ARTICLE_FAIL_PCT,
  MIN_SENTENCE_TOKENS,
};
