'use strict';

/**
 * Research provider router.
 *
 * The application supports only DeepSeek and Gemini for this research path.
 * DeepSeek is the primary structured analyst; Gemini is a fallback when DeepSeek
 * is unavailable or returns an invalid response.
 *
 * Important limitation: neither adapter is a web-search API. The prompts must
 * treat supplied SERP/competitor/article evidence as the source of truth and
 * must not invent fresh statistics or citations.
 */

const { callLLM } = require('./callLLM');
const { getIntegrationSecretInfo } = require('../integrations/integrationVault');

const ALLOWED_PROVIDERS = new Set(['deepseek', 'gemini']);

function _isConfigured(provider) {
  if (provider === 'deepseek') {
    return Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());
  }
  if (provider === 'gemini') {
    return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  }
  return false;
}

function _normalizeProvider(value, fallback) {
  const provider = String(value || '').trim().toLowerCase();
  return ALLOWED_PROVIDERS.has(provider) ? provider : fallback;
}

function getResearchProviderOrder() {
  const primary = _normalizeProvider(
    process.env.RESEARCH_PRIMARY_PROVIDER,
    'deepseek',
  );
  const fallback = _normalizeProvider(
    process.env.RESEARCH_FALLBACK_PROVIDER,
    primary === 'deepseek' ? 'gemini' : 'deepseek',
  );
  return [...new Set([primary, fallback])];
}

function hasResearchProvider() {
  return getResearchProviderOrder().some(_isConfigured);
}

async function hasResearchProviderAsync() {
  for (const provider of getResearchProviderOrder()) {
    const envName = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GEMINI_API_KEY';
    const info = await getIntegrationSecretInfo(envName);
    if (info.configured) return true;
  }
  return false;
}

/**
 * Calls one structured research provider at a time.
 *
 * @returns {Promise<{raw: object, provider: string}|null>}
 */
async function callResearchProvider({
  system,
  prompt,
  callOptions = {},
  callLabel = 'Research',
  log = null,
  callFn = callLLM,
  getSecretInfoFn = getIntegrationSecretInfo,
} = {}) {
  if (!String(system || '').trim() || !String(prompt || '').trim()) return null;

  let lastError = null;
  for (const provider of getResearchProviderOrder()) {
    const envName = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GEMINI_API_KEY';
    const configured = (await getSecretInfoFn(envName)).configured;
    if (!configured) {
      if (typeof log === 'function') {
        log(`${callLabel}: ${provider} пропущен — ключ не задан`, 'warn');
      }
      continue;
    }

    try {
      const configuredRetries = Number(callOptions.retries);
      const retries = Number.isFinite(configuredRetries)
        ? Math.max(0, Math.min(2, Math.floor(configuredRetries)))
        : 1;
      const raw = await callFn(provider, system, prompt, {
        ...callOptions,
        retries,
        temperature: callOptions.temperature ?? 0.2,
        callLabel: `${callLabel} (${provider})`,
      });
      return { raw, provider };
    } catch (error) {
      lastError = error;
      if (typeof log === 'function') {
        log(`${callLabel}: ${provider} failed — ${error.message}; `
          + 'переход к следующему доступному провайдеру', 'warn');
      }
    }
  }

  if (typeof log === 'function' && lastError) {
    log(`${callLabel}: DeepSeek/Gemini research недоступен после fallback`, 'warn');
  }
  return null;
}

module.exports = {
  callResearchProvider,
  getResearchProviderOrder,
  hasResearchProvider,
  hasResearchProviderAsync,
  isResearchProviderConfigured: _isConfigured,
};
