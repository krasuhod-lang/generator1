'use strict';

const { russianStem } = require('../../utils/russianStem');
const { normalizeTz } = require('./tzParser');

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTagTexts(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const text = stripHtml(m[1]);
    if (text) out.push(text);
  }
  return out;
}

function tokens(text, stem = true) {
  return (String(text || '').toLowerCase().match(/[а-яёa-z0-9]{3,}/g) || [])
    .map((w) => (stem ? russianStem(w) : w))
    .filter(Boolean);
}

function tokenOverlapScore(needle, haystack) {
  const n = [...new Set(tokens(needle))];
  if (!n.length) return 0;
  const h = new Set(tokens(haystack));
  let hits = 0;
  for (const t of n) if (h.has(t)) hits += 1;
  return hits / n.length;
}

function fuzzyPresent(needle, haystack, threshold = 0.7) {
  const n = String(needle || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const h = String(haystack || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n || !h) return { present: false, score: 0 };
  if (h.includes(n) || n.includes(h)) return { present: true, score: 1 };
  const score = tokenOverlapScore(n, h);
  return { present: score >= threshold, score };
}

function termPresent(term, text, lsiCheckFn) {
  if (typeof lsiCheckFn === 'function') {
    const custom = lsiCheckFn(term, text);
    if (typeof custom === 'boolean') return custom;
  }
  return fuzzyPresent(term, text, 0.7).present;
}

function checkTzCompliance({ tz, fullHtml, fullHTML, text, lsiCheckFn } = {}) {
  const normalizedTz = normalizeTz(tz);
  const html = String(fullHtml || fullHTML || '');
  const plainText = text ? String(text) : stripHtml(html);
  const lowerText = plainText.toLowerCase();
  const h1List = extractTagTexts(html, 'h1');
  const h2List = extractTagTexts(html, 'h2');

  const h1Match = normalizedTz.h1_required
    ? h1List.reduce((best, h1) => {
        const cur = fuzzyPresent(normalizedTz.h1_required, h1, 0.7);
        return cur.score > best.score ? { ...cur, actual: h1 } : best;
      }, { present: false, score: 0, actual: null })
    : { present: true, score: 1, actual: null, skipped: true };

  const h2RequiredPresent = normalizedTz.h2_required.map((required) => {
    const best = h2List.reduce((acc, h2) => {
      const cur = fuzzyPresent(required, h2, 0.7);
      return cur.score > acc.score ? { ...cur, matched_h2: h2 } : acc;
    }, { present: false, score: 0, matched_h2: null });
    return { required, ...best };
  });

  const wordCount = tokens(plainText, false).length;
  const minOk = normalizedTz.min_words == null || wordCount >= normalizedTz.min_words;
  const maxOk = normalizedTz.max_words == null || wordCount <= normalizedTz.max_words;
  const wordCountOk = minOk && maxOk;

  const lsiRequired = normalizedTz.lsi_required.map((term) => ({
    term,
    present: termPresent(term, plainText, lsiCheckFn),
  }));
  const lsiRequiredCoverage = lsiRequired.length
    ? lsiRequired.filter((x) => x.present).length / lsiRequired.length
    : 1;

  const forbiddenViolations = normalizedTz.lsi_forbidden.filter((term) => {
    const exact = lowerText.includes(String(term).toLowerCase());
    return exact || termPresent(term, plainText, lsiCheckFn);
  });

  const h2Share = h2RequiredPresent.length
    ? h2RequiredPresent.filter((x) => x.present).length / h2RequiredPresent.length
    : 1;

  const score = Math.round(
    (h1Match.present ? 20 : 0) +
    (30 * h2Share) +
    (wordCountOk ? 15 : 0) +
    (25 * lsiRequiredCoverage) +
    (forbiddenViolations.length ? 0 : 10)
  );

  const needsRewrite = [];
  if (!h1Match.present) needsRewrite.push('h1');
  if (h2RequiredPresent.some((x) => !x.present)) needsRewrite.push('h2_required');
  if (!wordCountOk) needsRewrite.push('word_count');
  if (lsiRequired.some((x) => !x.present)) needsRewrite.push('lsi_required');
  if (forbiddenViolations.length) needsRewrite.push('lsi_forbidden');

  return {
    h1_match: h1Match,
    h2_required_present: h2RequiredPresent,
    h2_required_share: Number(h2Share.toFixed(3)),
    word_count: wordCount,
    word_count_ok: wordCountOk,
    word_count_bounds: { min_words: normalizedTz.min_words, max_words: normalizedTz.max_words },
    lsi_required: lsiRequired,
    lsi_required_coverage: Number(lsiRequiredCoverage.toFixed(3)),
    lsi_forbidden_violations: forbiddenViolations,
    tz_compliance_score: score,
    needs_rewrite: needsRewrite,
  };
}

module.exports = {
  checkTzCompliance,
  _internal: { stripHtml, extractTagTexts, tokens, fuzzyPresent, tokenOverlapScore },
};
