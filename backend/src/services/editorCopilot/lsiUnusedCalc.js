'use strict';

const { calculateCoverage } = require('../../utils/calculateCoverage');

/**
 * computeLsiUnused — определяет, какие LSI-слова из исходного списка задачи
 * НЕ покрыты в текущем тексте статьи. Использует ту же `calculateCoverage`,
 * что и unusedInputsReporter / Stage 6, чтобы оценка была согласованной.
 *
 * @param {string|string[]} lsiInput — task.input_raw_lsi (\n-разделённое) или массив
 * @param {string}          html     — полный текущий HTML статьи (full_html_edited ?? full_html)
 * @returns {{ all: string[], used: string[], unused: string[], coveragePercent: number }}
 */
function computeLsiUnused(lsiInput, html) {
  const all = parseLsi(lsiInput);
  if (!all.length) {
    return { all: [], used: [], unused: [], coveragePercent: 100 };
  }
  const cov = calculateCoverage(html || '', all);
  return {
    all,
    used:            cov.covered,
    unused:          cov.missing,
    coveragePercent: cov.percent,
  };
}

function parseLsi(input) {
  if (Array.isArray(input)) {
    return input.map(s => String(s || '').trim()).filter(Boolean);
  }
  return String(input || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = { computeLsiUnused };
