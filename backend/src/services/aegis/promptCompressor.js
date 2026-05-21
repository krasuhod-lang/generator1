'use strict';

/**
 * aegis/promptCompressor — LLMLingua-style extractive context compression.
 *
 * Чистая JS-реализация без LLM (детерминированная). Цель: не превысить
 * targetTokens, но сохранить смысл — оставить предложения с высоким
 * IDF-score, числами, именами собственными, заголовками; выкинуть
 * стоп-слова и общие фразы.
 *
 * Алгоритм:
 *   1. tokenize → sentences (по [.!?…] с пробелом или \n).
 *   2. score(sentence):
 *        + log(1+|numerics|) * 2          (числа критичны для фактчека)
 *        + |proper_nouns| * 1.5           (имена собственные)
 *        + sum_of_IDF(token in sentence)  (редкие термины)
 *        + bonus 5 if начинается с заголовка (#, *, цифра+.)
 *        - 0.1 * len_in_chars             (lightly penalize length)
 *   3. сортируем по score desc; keepTopRatio долю всегда оставляем.
 *   4. далее жадно добираем предложения пока не уложимся в targetTokens.
 *   5. восстанавливаем порядок (по индексу в исходном тексте).
 *
 * Без LLM-вызовов: подходит для системных промптов / KB / контекста
 * GraphRAG, где нужна детерминированность.
 */

const STOP_RU = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так',
  'его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было',
  'вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг',
  'ли','если','уже','или','ни','быть','был','него','до','вас','нибудь','опять','уж',
  'вам','ведь','там','потом','себя','ничего','ей','может','они','тут','где','есть',
  'надо','ней','для','мы','тебя','их','чем','была','сам','чтоб','без','будто',
  'чего','раз','тоже','себе','под','будет','ж','тогда','кто','этот','того','потому',
  'этого','какой','совсем','ним','здесь','этом','один','почти','мой','тем','чтобы',
  'нее','сейчас','были','куда','зачем','всех','никогда','можно','при','наконец',
  'два','об','другой','хоть','после','над','больше','тот','через','эти','нас','про',
  'всего','них','какая','много','разве','три','эту','моя','впрочем','хорошо','свою',
  'этой','перед','иногда','лучше','чуть','том','нельзя','такой','им','более','всегда',
  'конечно','всю','между','а','или','но',
]);
const STOP_EN = new Set([
  'the','a','an','of','to','in','and','or','but','for','with','on','at','by','from',
  'is','are','was','were','be','been','being','it','its','this','that','these','those',
  'i','you','he','she','we','they','them','his','her','our','their','my','me','us',
  'as','if','then','than','so','do','does','did','have','has','had','not','no','yes',
  'can','could','will','would','should','may','might','must','shall',
]);

const PROPER_RE = /\b[A-ZА-ЯЁ][a-zа-яё]{2,}\b/g;
const NUMERIC_RE = /\b\d+([.,]\d+)?(%|млн|тыс|млрд|руб|usd|eur|kb|mb|gb|тб|ч|сек|мин|км|м|°|шт)?\b/giu;
const TOKEN_RE  = /[\p{L}\p{N}]+/gu;
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+|\n+/u;

function _isStop(token) {
  const t = token.toLowerCase();
  return STOP_RU.has(t) || STOP_EN.has(t);
}

/** estimateTokens — грубая оценка ≈ chars/4 (LLM-универсальная). */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function _splitSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = t.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  return parts;
}

function _tokens(sentence) {
  const m = String(sentence).match(TOKEN_RE);
  return m || [];
}

/**
 * buildIdf(sentences) — Map<token_lower, idf>.
 * idf = log( (N+1) / (df+1) ) + 1
 */
function buildIdf(sentences) {
  const N = sentences.length;
  const df = new Map();
  for (const s of sentences) {
    const seen = new Set();
    for (const tok of _tokens(s)) {
      const lt = tok.toLowerCase();
      if (_isStop(lt)) continue;
      if (lt.length < 2) continue;
      if (!seen.has(lt)) { seen.add(lt); df.set(lt, (df.get(lt) || 0) + 1); }
    }
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 1)) + 1);
  return idf;
}

function _scoreSentence(sentence, idf) {
  const proper  = sentence.match(PROPER_RE) || [];
  const numeric = sentence.match(NUMERIC_RE) || [];
  let idfSum = 0;
  for (const tok of _tokens(sentence)) {
    const lt = tok.toLowerCase();
    if (_isStop(lt)) continue;
    idfSum += idf.get(lt) || 0;
  }
  const trimmed = sentence.trim();
  const headerBonus = /^(#{1,6}\s|\*+\s|\d+[\.\)]\s|[A-ZА-ЯЁ]{4,})/.test(trimmed) ? 5 : 0;
  const lenPenalty  = trimmed.length * 0.01;
  return (
    Math.log(1 + numeric.length) * 2 +
    proper.length * 1.5 +
    idfSum +
    headerBonus -
    lenPenalty
  );
}

/**
 * compressPrompt(text, opts?) — основной API.
 *
 * @param {string} text — текст для сжатия (system или user message).
 * @param {{ targetTokens?:number, keepTopRatio?:number,
 *           minTokensToCompress?:number, alwaysKeepPrefix?:number }} [opts]
 *
 * @returns {{
 *   text: string,                  // сжатый текст
 *   original_tokens: number,
 *   compressed_tokens: number,
 *   compression_ratio: number,     // 0..1
 *   sentences_kept: number,
 *   sentences_dropped: number,
 *   skipped: boolean,              // если ниже minTokensToCompress
 * }}
 */
function compressPrompt(text, opts = {}) {
  const { getAegisFlags } = require('./featureFlags');
  const cfg = getAegisFlags().compress;
  const targetTokens        = Number.isFinite(opts.targetTokens) ? opts.targetTokens : cfg.targetTokens;
  const keepTopRatio        = Number.isFinite(opts.keepTopRatio) ? opts.keepTopRatio : cfg.keepTopRatio;
  const minTokensToCompress = Number.isFinite(opts.minTokensToCompress) ? opts.minTokensToCompress : cfg.minTokensToCompress;
  const alwaysKeepPrefix    = Number.isFinite(opts.alwaysKeepPrefix) ? opts.alwaysKeepPrefix : 200;

  const src = String(text || '');
  const originalTokens = estimateTokens(src);
  if (originalTokens <= minTokensToCompress || originalTokens <= targetTokens) {
    return {
      text: src,
      original_tokens: originalTokens,
      compressed_tokens: originalTokens,
      compression_ratio: 1,
      sentences_kept: -1,
      sentences_dropped: 0,
      skipped: true,
    };
  }

  // Префикс (первые N токенов) всегда сохраняем — обычно туда кладут
  // главную инструкцию системного промпта.
  const prefixChars = alwaysKeepPrefix * 4;
  const prefix = src.slice(0, prefixChars);
  const tail   = src.slice(prefixChars);

  const sentences = _splitSentences(tail);
  if (!sentences.length) {
    return {
      text: src,
      original_tokens: originalTokens,
      compressed_tokens: originalTokens,
      compression_ratio: 1,
      sentences_kept: 0,
      sentences_dropped: 0,
      skipped: true,
    };
  }

  const idf = buildIdf(sentences);
  const scored = sentences.map((s, i) => ({
    i, s,
    score: _scoreSentence(s, idf),
    tokens: estimateTokens(s) + 1,  // +1 for separator
  }));

  const sortedByScore = [...scored].sort((a, b) => b.score - a.score);

  const keptIndices = new Set();
  const minKeep = Math.max(1, Math.ceil(sentences.length * keepTopRatio));
  // Top-K по score — обязательно.
  for (let i = 0; i < minKeep && i < sortedByScore.length; i += 1) {
    keptIndices.add(sortedByScore[i].i);
  }

  // Доступный бюджет для tail (за вычетом префикса).
  let budget = targetTokens - estimateTokens(prefix);
  if (budget < 0) budget = 0;
  let used = 0;
  for (const idx of keptIndices) used += scored[idx].tokens;

  // Жадно добираем по score, пока влезает.
  for (const item of sortedByScore) {
    if (keptIndices.has(item.i)) continue;
    if (used + item.tokens > budget) continue;
    keptIndices.add(item.i);
    used += item.tokens;
  }

  // Восстанавливаем порядок.
  const orderedKept = [...keptIndices].sort((a, b) => a - b).map((i) => scored[i].s);
  const compressed = prefix + (orderedKept.length ? ' ' + orderedKept.join(' ') : '');
  const compressedTokens = estimateTokens(compressed);

  return {
    text: compressed,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    compression_ratio: originalTokens > 0 ? compressedTokens / originalTokens : 1,
    sentences_kept: keptIndices.size,
    sentences_dropped: sentences.length - keptIndices.size,
    skipped: false,
  };
}

module.exports = {
  compressPrompt,
  estimateTokens,
  buildIdf,
  // exposed for tests:
  _splitSentences,
  _scoreSentence,
};
