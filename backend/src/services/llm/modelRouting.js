'use strict';

const GEMINI_MODELS = new Set(['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash']);
const OPENAI_MODELS = new Set(['gpt-5-mini', 'gpt-5', 'gpt-5.5']);
const PROVIDERS = new Set(['gemini', 'grok', 'openai']);
const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_OPENAI_MODEL = 'gpt-5';

function normalizeProvider(value, fallback = DEFAULT_PROVIDER) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : fallback;
}

function normalizeOpenAiModel(value, fallback = DEFAULT_OPENAI_MODEL) {
  const model = String(value || '').trim().toLowerCase();
  return OPENAI_MODELS.has(model) ? model : fallback;
}

function normalizeModel(provider, value) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === 'openai') return normalizeOpenAiModel(value);
  if (normalizedProvider === 'gemini') {
    const model = String(value || '').trim().toLowerCase();
    return GEMINI_MODELS.has(model)
      ? model
      : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  }
  // Grok adapter keeps its configured model/endpoint and historically did not
  // consume the Gemini model field. Never pass a stale Gemini ID to x.ai.
  if (normalizedProvider === 'grok') return null;
  return String(value || '').trim().slice(0, 160) || null;
}

function resolveTaskModel(task, fallbackProvider = DEFAULT_PROVIDER) {
  const provider = normalizeProvider(task?.llm_provider, fallbackProvider);
  const requestedModel = task?.llm_model || task?.gemini_model || '';
  return { provider, model: normalizeModel(provider, requestedModel) };
}

function providerForModel(model, fallback = DEFAULT_PROVIDER) {
  const value = String(model || '').trim().toLowerCase();
  if (OPENAI_MODELS.has(value) || /^gpt-5(?:\.|$)/.test(value)) return 'openai';
  if (GEMINI_MODELS.has(value) || value.startsWith('gemini-')) return 'gemini';
  return normalizeProvider(fallback);
}

function isGeminiProvider(provider) {
  return normalizeProvider(provider) === 'gemini';
}

function isOpenAiProvider(provider) {
  return normalizeProvider(provider) === 'openai';
}

function modelChoices() {
  return {
    providers: ['gemini', 'openai', 'grok'],
    gemini: [...GEMINI_MODELS],
    openai: [...OPENAI_MODELS],
  };
}

module.exports = {
  GEMINI_MODELS,
  OPENAI_MODELS,
  PROVIDERS,
  DEFAULT_PROVIDER,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  normalizeProvider,
  normalizeOpenAiModel,
  normalizeModel,
  resolveTaskModel,
  providerForModel,
  isGeminiProvider,
  isOpenAiProvider,
  modelChoices,
};
