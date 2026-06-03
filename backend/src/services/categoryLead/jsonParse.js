'use strict';

/**
 * categoryLead/jsonParse.js — устойчивый парсер JSON-ответов LLM для
 * инструмента categoryLead. Повторяет логику metaGenerator.parseMetaJson:
 * снимает markdown-обёртки, берёт срез { … }, чинит обрыв через autoCloseJSON.
 */

const { autoCloseJSON } = require('../../utils/autoCloseJSON');

function parseLlmJson(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) throw new Error('LLM вернул пустой ответ');

  let t = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = t.indexOf('{');
  const lb = t.lastIndexOf('}');
  if (fb !== -1 && lb > fb) t = t.substring(fb, lb + 1);

  try { return JSON.parse(t); } catch (_) { /* fallback */ }
  try { return JSON.parse(autoCloseJSON(t)); } catch (e) {
    const snippet = raw.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(`LLM вернул не-JSON ответ: ${e.message}. Фрагмент: «${snippet}»`);
  }
}

module.exports = { parseLlmJson };
