/**
 * Calculate LSI keyword coverage — what percentage of target keywords
 * appear in the content text.
 *
 * @param {string[]} keywords – list of target LSI keywords
 * @param {string} content – the content text to check
 * @returns {{ percentage: number, found: string[], missing: string[] }}
 */
function calculateCoverage(keywords, content) {
  if (!keywords || keywords.length === 0) {
    return { percentage: 0, found: [], missing: [] };
  }
  if (!content) {
    return { percentage: 0, found: [], missing: [...keywords] };
  }

  const lower = content.toLowerCase();
  const found = [];
  const missing = [];

  for (const kw of keywords) {
    if (!kw) continue;
    const normalised = kw.toLowerCase().trim();
    if (lower.includes(normalised)) {
      found.push(kw);
    } else {
      missing.push(kw);
    }
  }

  const total = found.length + missing.length;
  const percentage = total > 0 ? Math.round((found.length / total) * 100) : 0;

  return { percentage, found, missing };
}

module.exports = { calculateCoverage };
