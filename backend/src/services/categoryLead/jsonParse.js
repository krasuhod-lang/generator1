'use strict';

/**
 * categoryLead/jsonParse.js — устойчивый парсер JSON-ответов LLM для
 * инструмента categoryLead. Повторяет логику metaGenerator.parseMetaJson:
 * снимает markdown-обёртки, берёт срез { … }, чинит обрыв через autoCloseJSON.
 *
 * Дополнительно вырезает ПЕРВЫЙ сбалансированный JSON-объект (с учётом строк и
 * экранирования), а не срез до последней «}». Это устраняет ошибку
 * «Unexpected non-whitespace character after JSON», когда модель дописывает
 * текст/повторный объект после закрывающей скобки.
 */

const { autoCloseJSON } = require('../../utils/autoCloseJSON');

/**
 * extractFirstJsonObject — возвращает подстроку первого сбалансированного
 * объекта `{ … }`, корректно пропуская скобки внутри строк и экранирование.
 * Если объект не закрыт (обрыв на полпути), возвращает хвост от первой «{».
 *
 * @param {string} t
 * @returns {string|null}
 */
function extractFirstJsonObject(t) {
  const start = t.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < t.length; i++) {
    const ch = t[i];

    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }

    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return t.substring(start, i + 1);
    }
  }

  // Объект не закрылся — отдаём хвост, autoCloseJSON попробует восстановить.
  return t.substring(start);
}

function parseLlmJson(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) throw new Error('LLM вернул пустой ответ');

  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Первый сбалансированный объект — отсекает мусор/повторы после «}».
  const firstObj = extractFirstJsonObject(stripped);
  if (firstObj) {
    try { return JSON.parse(firstObj); } catch (_) { /* fallback */ }
    try { return JSON.parse(autoCloseJSON(firstObj)); } catch (_) { /* fallback */ }
  }

  // Запасной путь: срез { … } до последней «}» + autoCloseJSON.
  let t = stripped;
  const fb = t.indexOf('{');
  const lb = t.lastIndexOf('}');
  if (fb !== -1 && lb > fb) t = t.substring(fb, lb + 1);

  try { return JSON.parse(t); } catch (_) { /* fallback */ }
  try { return JSON.parse(autoCloseJSON(t)); } catch (e) {
    const snippet = raw.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(`LLM вернул не-JSON ответ: ${e.message}. Фрагмент: «${snippet}»`);
  }
}

module.exports = { parseLlmJson, extractFirstJsonObject };
