'use strict';

/**
 * stripHtmlTags — utilities for safely stripping HTML tags from a string.
 *
 * A single-pass `replace(/<[^>]+>/g, '')` is incomplete (CodeQL
 * `js/incomplete-multi-character-sanitization`): malformed or nested tags
 * such as `<<script>` or `<scri<script>pt>` can survive one pass and
 * re-form a tag after substitution.  `stripHtmlTagsLoop` iterates until
 * the string is stable (≤ 5 passes — empirical upper bound far above
 * realistic adversarial inputs).
 *
 * These helpers are used for plain-text extraction (audits, tokenization,
 * coverage measurement). The output is NEVER inserted back into the DOM —
 * actual rendering still goes through DOMPurify on the frontend. The loop
 * variant is preferred everywhere a stripped string may incidentally end
 * up in a string-search comparison or similar, to satisfy the analyzer.
 */

const TAG_RE_REPLACE = /<[^>]*>/g;
const MAX_PASSES = 5;

/**
 * Loop-strip HTML tags from `s`, replacing each match with `replacement`
 * (default empty string). Returns a string with no remaining `<…>` tokens.
 *
 * @param {string} s
 * @param {string} [replacement='']
 * @returns {string}
 */
function stripHtmlTagsLoop(s, replacement = '') {
  let prev = String(s == null ? '' : s);
  for (let i = 0; i < MAX_PASSES; i += 1) {
    const next = prev.replace(TAG_RE_REPLACE, replacement);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/**
 * Loop-strip HTML tags AND collapse whitespace runs to single spaces.
 * Convenient for tokenization / coverage measurement on article HTML.
 *
 * @param {string} s
 * @returns {string}
 */
function stripHtmlTagsToText(s) {
  return stripHtmlTagsLoop(s, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { stripHtmlTagsLoop, stripHtmlTagsToText };
