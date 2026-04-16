/**
 * Simple fact-checking utility.
 * Compares claims against known data and flags potential issues.
 */

/**
 * Check an array of claims against a knowledge context.
 *
 * @param {string[]} claims – statements to verify
 * @param {string} context – reference text with known-good information
 * @returns {{ verified: string[], unverified: string[], score: number }}
 */
function checkFacts(claims, context) {
  if (!claims || claims.length === 0) {
    return { verified: [], unverified: [], score: 0 };
  }
  if (!context) {
    return { verified: [], unverified: [...claims], score: 0 };
  }

  const lowerContext = context.toLowerCase();
  const verified = [];
  const unverified = [];

  for (const claim of claims) {
    if (!claim) continue;

    // Extract key terms from the claim (words > 3 chars)
    const terms = claim
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    // A claim is "verified" if most key terms appear in the context
    const matches = terms.filter((t) => lowerContext.includes(t));
    const ratio = terms.length > 0 ? matches.length / terms.length : 0;

    if (ratio >= 0.6) {
      verified.push(claim);
    } else {
      unverified.push(claim);
    }
  }

  const total = verified.length + unverified.length;
  const score = total > 0 ? Math.round((verified.length / total) * 100) : 0;

  return { verified, unverified, score };
}

/**
 * Extract numeric claims from text (dates, percentages, statistics).
 *
 * @param {string} text
 * @returns {string[]} – extracted numeric claim fragments
 */
function extractNumericClaims(text) {
  if (!text) return [];

  const patterns = [
    /\d{4}\s*(?:год|year|г\.)/gi,
    /\d+[.,]?\d*\s*%/g,
    /\d+[.,]?\d*\s*(?:млн|млрд|тыс|million|billion|thousand)/gi,
    /(?:в|около|более|менее|свыше)\s+\d+/gi,
  ];

  const claims = new Set();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach((m) => claims.add(m.trim()));
    }
  }

  return [...claims];
}

module.exports = { checkFacts, extractNumericClaims };
