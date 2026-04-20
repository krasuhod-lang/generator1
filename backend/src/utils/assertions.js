'use strict';

/**
 * assertions.js — DSPy-inspired Runtime Constraints for LLM outputs.
 *
 * Assertion functions return { passed: boolean, message: string }.
 * They are called after validateOutput() in the pipeline.
 * If an assertion fails, the caller should retry the LLM call with feedback.
 *
 * Max 2 assertion-retries per stage (mirroring DSPy Assert with backtrack).
 */

/**
 * assertMinLength — проверяет минимальную длину текста/HTML.
 *
 * @param {string} text
 * @param {number} min — минимальное количество символов
 * @returns {{ passed: boolean, message: string }}
 */
function assertMinLength(text, min) {
  // Strip tags by replacing angle brackets — avoids incomplete-sanitization issues
  const stripped = (text || '').replace(/</g, ' ').replace(/>/g, ' ');
  const len = stripped.trim().replace(/\s+/g, ' ').length;
  return {
    passed:  len >= min,
    message: len >= min
      ? `OK: length ${len} >= ${min}`
      : `FAIL: content too short (${len} chars, need >= ${min}). Expand the section with more specific details.`,
  };
}

/**
 * assertNoForbiddenPatterns — проверяет отсутствие запрещённых паттернов в HTML.
 *
 * @param {string} html
 * @param {string[]} patterns — массив запрещённых строк (case-insensitive)
 * @returns {{ passed: boolean, message: string, found: string[] }}
 */
function assertNoForbiddenPatterns(html, patterns) {
  if (!patterns || !patterns.length) return { passed: true, message: 'OK: no patterns to check', found: [] };
  const text  = (html || '').toLowerCase();
  const found = patterns.filter(p => text.includes(p.toLowerCase()));
  return {
    passed:  found.length === 0,
    message: found.length === 0
      ? 'OK: no forbidden patterns'
      : `FAIL: forbidden patterns found: ${found.join(', ')}. Remove them from the content.`,
    found,
  };
}

/**
 * assertH3Range — проверяет, что количество H3 находится в допустимом диапазоне.
 *
 * @param {string} html
 * @param {number} min — минимум H3 подзаголовков
 * @param {number} max — максимум H3 подзаголовков
 * @returns {{ passed: boolean, message: string, h3Count: number }}
 */
function assertH3Range(html, min, max) {
  const h3Count = (html || '').match(/<h3[\s>]/gi)?.length || 0;
  const passed  = h3Count >= min && h3Count <= max;
  return {
    passed,
    message: passed
      ? `OK: ${h3Count} H3 headings (range ${min}–${max})`
      : `FAIL: ${h3Count} H3 headings, expected ${min}–${max}. ${h3Count < min ? `Add ${min - h3Count} more H3 subsections.` : `Remove ${h3Count - max} excess H3 subsections.`}`,
    h3Count,
  };
}

/**
 * assertLSICoverage — проверяет минимальный процент покрытия LSI-терминов.
 *
 * @param {string}   html
 * @param {string[]} lsiTerms   — массив обязательных LSI-слов
 * @param {number}   minPercent — минимальный процент покрытия (0–100)
 * @returns {{ passed: boolean, message: string, coverage: number, missing: string[] }}
 */
function assertLSICoverage(html, lsiTerms, minPercent = 70) {
  if (!lsiTerms || !lsiTerms.length) {
    return { passed: true, message: 'OK: no LSI terms to check', coverage: 100, missing: [] };
  }
  // Strip tags by replacing angle brackets — avoids incomplete-sanitization issues
  const text    = (html || '').toLowerCase().replace(/</g, ' ').replace(/>/g, ' ');
  const covered = lsiTerms.filter(term => text.includes(term.toLowerCase()));
  const missing = lsiTerms.filter(term => !text.includes(term.toLowerCase()));
  const coverage = Math.round((covered.length / lsiTerms.length) * 100);
  const passed   = coverage >= minPercent;
  return {
    passed,
    message: passed
      ? `OK: LSI coverage ${coverage}% >= ${minPercent}%`
      : `FAIL: LSI coverage ${coverage}% < ${minPercent}%. Missing terms: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}. Naturally incorporate them into the content.`,
    coverage,
    missing,
  };
}

/**
 * assertNoHtmlLinks — проверяет отсутствие тегов <a> в HTML (правило Stage 3).
 *
 * @param {string} html
 * @returns {{ passed: boolean, message: string }}
 */
function assertNoHtmlLinks(html) {
  const hasLinks = /<a[\s>]/i.test(html || '');
  return {
    passed:  !hasLinks,
    message: hasLinks
      ? 'FAIL: HTML contains <a> tags which are BANNED. Remove all hyperlinks.'
      : 'OK: no <a> tags',
  };
}

/**
 * runAssertions — запускает набор assertions и собирает неудавшиеся.
 *
 * @param {Array<{ fn: Function, args: any[] }>} assertions
 * @returns {{ allPassed: boolean, failures: string[], results: object[] }}
 */
function runAssertions(assertions) {
  const results  = assertions.map(({ fn, args }) => fn(...args));
  const failures = results.filter(r => !r.passed).map(r => r.message);
  return {
    allPassed: failures.length === 0,
    failures,
    results,
  };
}

module.exports = {
  assertMinLength,
  assertNoForbiddenPatterns,
  assertH3Range,
  assertLSICoverage,
  assertNoHtmlLinks,
  runAssertions,
};
