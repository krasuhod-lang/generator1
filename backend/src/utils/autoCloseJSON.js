'use strict';

/**
 * autoCloseJSON — восстановление обрванного JSON.
 * Перенесено из index.html без изменений.
 *
 * Закрывает незакрытые строки, объекты и массивы,
 * убирает trailing comma перед закрытием.
 *
 * @param {string} str — сырой (возможно обрванный) JSON-текст
 * @returns {string}   — JSON-текст с закрытыми скобками
 */
function autoCloseJSON(str) {
  let t = String(str || '');
  let inString = false;
  let escapeNext = false;
  const stack = [];
  let normalized = '';

  // Scan once so trailing commas are removed only outside strings. A regex
  // would corrupt legitimate text such as ",}" inside a quoted HTML value.
  for (let i = 0; i < t.length; i += 1) {
    const char = t[i];

    if (escapeNext) {
      normalized += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\' && inString) {
      normalized += char;
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      normalized += char;
      inString = !inString;
      continue;
    }

    if (!inString && char === ',') {
      let j = i + 1;
      while (j < t.length && /\s/.test(t[j])) j += 1;
      if (t[j] === '}' || t[j] === ']') continue;
    }

    normalized += char;
    if (!inString) {
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (char === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }

  t = normalized;

  // A truncation immediately after a backslash leaves an invalid escape. Turn
  // that dangling slash into a valid literal slash before closing the string.
  if (inString && escapeNext) t += '\\';
  if (inString) t += '"';

  while (stack.length) t += (stack.pop() === '{') ? '}' : ']';
  return t;
}

/**
 * extractBalancedJson — вырезает первое СБАЛАНСИРОВАННОЕ JSON-значение
 * (объект {} или массив []) из сырого текста LLM.
 *
 * Строко-осознанный сканер: скобки внутри строк не учитываются. Позволяет
 * игнорировать любой «мусор», который модель дописала ПОСЛЕ закрывающей
 * скобки (в т.ч. второй JSON-блок или пояснения с фигурными скобками) —
 * именно такой хвост даёт ошибку JSON.parse
 * «Unexpected non-whitespace character after JSON at position N».
 *
 * @param {string} text — сырой текст ответа LLM
 * @returns {string|null} — первый сбалансированный JSON-фрагмент или null,
 *   если значение не найдено / не закрыто (обрыв по MAX_TOKENS)
 */
function extractBalancedJson(text) {
  const t = String(text || '');
  const fb  = t.indexOf('{');
  const fab = t.indexOf('[');
  let start = -1;
  if (fb !== -1 && fab !== -1)      start = Math.min(fb, fab);
  else if (fb !== -1)                start = fb;
  else if (fab !== -1)               start = fab;
  if (start === -1) return null;

  let inString  = false;
  let escapeNext = false;
  let depth = 0;
  for (let i = start; i < t.length; i += 1) {
    const char = t[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (char === '\\') escapeNext = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return t.substring(start, i + 1);
    }
  }
  return null; // значение не закрыто (обрыв по MAX_TOKENS)
}

module.exports = { autoCloseJSON, extractBalancedJson };
