'use strict';

/**
 * aegis/poisonFilter — детектор «отравленных» данных перед записью в
 * векторную базу (Этап 0: receptors → vectordb.index).
 *
 * Цель: блокировать злонамеренные паттерны, которые конкуренты могут
 * прятать на своих страницах, чтобы запутать LLM:
 *
 *   1. Hidden text — display:none / visibility:hidden / opacity:0 /
 *      font-size:0 / color=background, или off-screen (text-indent:-9999).
 *   2. Keyword stuffing — n-gram повторов больше keywordStuffMaxRepeat.
 *   3. Невидимые юникод-символы — ZWSP (U+200B), ZWNJ (U+200C),
 *      RLO/LRO (U+202E/202D), soft hyphen (U+00AD), BOM (U+FEFF).
 *   4. Numeric outliers — числа > X* медианы по корпусу ниши (опц.).
 *
 * Проверки — детерминированные, чистый JS, без deps. Работает и на
 * сыром HTML, и на чистом тексте; если передан HTML, hidden-проверка
 * включается, иначе пропускается.
 *
 * Использование:
 *   const { runPoisonCheck } = require('./poisonFilter');
 *   const verdict = runPoisonCheck({ html, text, nicheNumericMedian });
 *   if (verdict.blocked) skip(...);
 */

const HIDDEN_INLINE_STYLE_RE = /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.\d)|font-size\s*:\s*0(?:px)?|text-indent\s*:\s*-?\d{4,}px)[^"']*["']/gi;
const HIDDEN_ATTR_RE = /\bhidden\b(?=\s|=|>)/gi;
const ARIA_HIDDEN_RE = /aria-hidden\s*=\s*["']true["']/gi;

// Невидимые/опасные юникод-символы.
const INVISIBLE_CODEPOINTS = [
  0x200B, 0x200C, 0x200D, 0x200E, 0x200F,   // ZWSP / ZWNJ / ZWJ / LRM / RLM
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,   // bidi overrides
  0x2066, 0x2067, 0x2068, 0x2069,           // isolates
  0x00AD,                                    // soft hyphen
  0xFEFF,                                    // BOM
];
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CODEPOINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`, 'gu');

const HTML_TAG_RE = /<[^>]+>/g;
const NUMERIC_RE  = /\b\d+(?:[.,]\d+)?\b/g;
const TOKEN_RE    = /[\p{L}\p{N}]+/gu;

// Жёсткий cap на размер входа для регулярок с backreference (TAG_PAIR_RE).
// Защита от DoS на специально подготовленном гигантском HTML.
const MAX_INPUT_CHARS = 2_000_000;

function _stripHtml(html) {
  return String(html || '').replace(HTML_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

function _tokens(text) {
  const m = String(text || '').toLowerCase().match(TOKEN_RE);
  return m || [];
}

// ── 1. Hidden text ratio ───────────────────────────────────────────
function detectHiddenText(html) {
  let src = String(html || '');
  if (!src) return { has_html: false, ratio: 0, matches: 0, hidden_chars: 0 };
  // Защита от DoS: труним вход для регулярок с backreference.
  let truncated = false;
  if (src.length > MAX_INPUT_CHARS) {
    src = src.slice(0, MAX_INPUT_CHARS);
    truncated = true;
  }
  const fullChars = src.length || 1;

  let hiddenChars = 0;
  let matches = 0;

  // Найти всё, что внутри тегов с скрытым стилем/атрибутом.
  // Простая эвристика: <tag ...style="...display:none..."...>(text)</tag>
  // Без полноценного парсинга DOM — берём span между открывающим/закрывающим
  // тегом ближайшим. Достаточно для отбраковки.
  const TAG_PAIR_RE = /<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const m of src.matchAll(TAG_PAIR_RE)) {
    const attrs = m[2] || '';
    const inner = m[3] || '';
    let isHidden = false;
    if (HIDDEN_INLINE_STYLE_RE.test(attrs)) isHidden = true;
    HIDDEN_INLINE_STYLE_RE.lastIndex = 0;
    if (!isHidden && HIDDEN_ATTR_RE.test(attrs)) isHidden = true;
    HIDDEN_ATTR_RE.lastIndex = 0;
    if (!isHidden && ARIA_HIDDEN_RE.test(attrs)) isHidden = true;
    ARIA_HIDDEN_RE.lastIndex = 0;
    if (isHidden) {
      matches += 1;
      hiddenChars += _stripHtml(inner).length;
    }
  }
  return {
    has_html: true,
    matches,
    hidden_chars: hiddenChars,
    ratio: hiddenChars / fullChars,
    truncated,
  };
}

// ── 2. Keyword stuffing (n-gram repeats) ───────────────────────────
function detectKeywordStuffing(text, { ngramSize = 3, maxRepeat } = {}) {
  const { getAegisFlags } = require('./featureFlags');
  const limit = Number.isFinite(maxRepeat) ? maxRepeat : getAegisFlags().poison.keywordStuffMaxRepeat;
  const toks = _tokens(text);
  if (toks.length < ngramSize) return { offenders: [], max_repeat: 0 };
  const counts = new Map();
  for (let i = 0; i <= toks.length - ngramSize; i += 1) {
    const ng = toks.slice(i, i + ngramSize).join(' ');
    counts.set(ng, (counts.get(ng) || 0) + 1);
  }
  const offenders = [];
  let maxRepeatActual = 0;
  for (const [ng, c] of counts) {
    if (c > maxRepeatActual) maxRepeatActual = c;
    if (c > limit) offenders.push({ ngram: ng, count: c });
  }
  offenders.sort((a, b) => b.count - a.count);
  return { offenders: offenders.slice(0, 10), max_repeat: maxRepeatActual, threshold: limit };
}

// ── 3. Invisible unicode characters ────────────────────────────────
function detectInvisibleChars(text) {
  const src = String(text || '');
  if (!src) return { count: 0, ratio: 0 };
  const matches = src.match(INVISIBLE_RE);
  const count = matches ? matches.length : 0;
  return {
    count,
    ratio: count / src.length,
  };
}

// ── 4. Numeric outliers ────────────────────────────────────────────
function detectNumericOutliers(text, { median, multiplier } = {}) {
  const { getAegisFlags } = require('./featureFlags');
  const mult = Number.isFinite(multiplier) ? multiplier : getAegisFlags().poison.numericOutlierMultiplier;
  if (!Number.isFinite(median) || median <= 0) {
    return { outliers: [], median: median || null, multiplier: mult, skipped: true };
  }
  const matches = String(text || '').match(NUMERIC_RE) || [];
  const cutoffHi = median * mult;
  const cutoffLo = median / mult;
  const outliers = [];
  for (const raw of matches) {
    const v = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(v)) continue;
    if (v > cutoffHi || (v > 0 && v < cutoffLo)) {
      outliers.push({ value: v });
      if (outliers.length >= 20) break;
    }
  }
  return { outliers, median, multiplier: mult, skipped: false };
}

/**
 * runPoisonCheck({ html?, text?, nicheNumericMedian? }) — главный API.
 *
 * @returns {{
 *   blocked: boolean,
 *   verdict: 'clean'|'mark'|'drop',
 *   reasons: string[],
 *   details: { hidden, stuffing, invisible, outliers },
 * }}
 */
function runPoisonCheck({ html = null, text = null, nicheNumericMedian = null } = {}) {
  const { getAegisFlags } = require('./featureFlags');
  const cfg = getAegisFlags().poison;
  const cleanText = text != null ? String(text) : (html ? _stripHtml(html) : '');

  const hidden    = html ? detectHiddenText(html) : { has_html: false, ratio: 0, matches: 0, hidden_chars: 0 };
  const stuffing  = detectKeywordStuffing(cleanText);
  const invisible = detectInvisibleChars(cleanText);
  const outliers  = detectNumericOutliers(cleanText, { median: nicheNumericMedian });

  const reasons = [];
  if (hidden.ratio > cfg.hiddenTextMaxRatio) {
    reasons.push(`hidden_text ratio=${hidden.ratio.toFixed(3)} > ${cfg.hiddenTextMaxRatio}`);
  }
  if (stuffing.offenders.length) {
    reasons.push(`keyword_stuffing top=${stuffing.offenders[0].ngram} repeats=${stuffing.offenders[0].count}`);
  }
  if (invisible.ratio > cfg.invisibleCharMaxRatio) {
    reasons.push(`invisible_chars ratio=${invisible.ratio.toFixed(4)} > ${cfg.invisibleCharMaxRatio}`);
  }
  if (outliers.outliers.length) {
    reasons.push(`numeric_outliers count=${outliers.outliers.length}`);
  }

  const failed = reasons.length > 0;
  const verdict = failed ? cfg.onFail : 'clean';
  const blocked = failed && cfg.onFail === 'drop';

  return {
    blocked,
    verdict,
    reasons,
    details: { hidden, stuffing, invisible, outliers },
  };
}

module.exports = {
  runPoisonCheck,
  detectHiddenText,
  detectKeywordStuffing,
  detectInvisibleChars,
  detectNumericOutliers,
  // exposed for tests:
  INVISIBLE_CODEPOINTS,
};
