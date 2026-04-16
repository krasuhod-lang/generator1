/**
 * Attempt to repair broken JSON from LLM responses.
 * Tries JSON.parse first, then attempts to close unclosed brackets/braces.
 *
 * @param {string} raw – raw string that should be JSON
 * @returns {string} – repaired JSON string (still needs JSON.parse by caller)
 */
function autoCloseJSON(raw) {
  if (!raw || typeof raw !== 'string') return '{}';

  let text = raw.trim();

  // Strip markdown code fences if present
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Try parsing as-is
  try {
    JSON.parse(text);
    return text;
  } catch (_e) {
    // Continue to repair
  }

  // Remove trailing commas before closing brackets
  text = text.replace(/,\s*([}\]])/g, '$1');

  // Count open vs close braces and brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  // Close unclosed strings
  if (inString) {
    text += '"';
  }

  // Remove trailing comma after closing the string
  text = text.replace(/,\s*$/, '');

  // Append missing closing brackets/braces
  while (openBrackets > 0) {
    text += ']';
    openBrackets--;
  }
  while (openBraces > 0) {
    text += '}';
    openBraces--;
  }

  // Final validation attempt
  try {
    JSON.parse(text);
  } catch (_e) {
    // Last resort: return empty object
    return '{}';
  }

  return text;
}

module.exports = { autoCloseJSON };
