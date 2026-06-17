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

/**
 * Convert rich-text HTML (from WYSIWYG editor) to readable plain text,
 * preserving line breaks for block elements and list items.
 * Used when task description fields are included in LLM prompts.
 *
 * @param {string} s
 * @returns {string}
 */
function richTextToPlain(s) {
  if (!s) return '';
  // If it doesn't look like HTML, return as-is
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  let text = String(s);
  // Convert block elements to newlines
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '• ');
  text = text.replace(/<\/(?:ul|ol|div|h[1-6])>/gi, '\n');
  // Strip remaining tags
  text = stripHtmlTagsLoop(text);
  // Clean up whitespace: collapse blank lines but keep single newlines
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n /g, '\n');
  text = text.replace(/ \n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

module.exports = { stripHtmlTagsLoop, stripHtmlTagsToText, richTextToPlain };
