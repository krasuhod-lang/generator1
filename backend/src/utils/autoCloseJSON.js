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
  let t = str.replace(/,\s*$/, '');
  let inString  = false;
  let escapeNext = false;
  const stack   = [];

  for (let i = 0; i < t.length; i++) {
    const char = t[i];

    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"')  { inString = !inString; continue; }

    if (!inString) {
      if      (char === '{' || char === '[') stack.push(char);
      else if (char === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (char === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }

  // Закрываем незакрытую строку
  if (inString) t += '"';

  // Закрываем незакрытые объекты/массивы в обратном порядке
  while (stack.length) {
    t += (stack.pop() === '{') ? '}' : ']';
  }

  return t;
}

module.exports = { autoCloseJSON };
