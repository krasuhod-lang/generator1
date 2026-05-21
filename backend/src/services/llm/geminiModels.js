'use strict';

const GEMINI_COPYWRITING_MODELS = Object.freeze([
  Object.freeze({
    value: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
  }),
  Object.freeze({
    value: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
  }),
]);

const DEFAULT_GEMINI_COPYWRITING_MODEL = GEMINI_COPYWRITING_MODELS[0].value;
const _ALLOWED = new Set(GEMINI_COPYWRITING_MODELS.map((m) => m.value));
const _ALIASES = new Map([
  ['3.1-pro-preview', 'gemini-3.1-pro-preview'],
  ['3.5-flash', 'gemini-3.5-flash'],
]);

function normalizeGeminiCopywritingModel(raw, fallback = DEFAULT_GEMINI_COPYWRITING_MODEL) {
  const fb = _ALLOWED.has(fallback) ? fallback : DEFAULT_GEMINI_COPYWRITING_MODEL;
  const value = raw == null ? '' : String(raw).trim().toLowerCase();
  if (!value) return fb;
  const normalized = _ALIASES.get(value) || value;
  return _ALLOWED.has(normalized) ? normalized : fb;
}

module.exports = {
  GEMINI_COPYWRITING_MODELS,
  DEFAULT_GEMINI_COPYWRITING_MODEL,
  normalizeGeminiCopywritingModel,
};
