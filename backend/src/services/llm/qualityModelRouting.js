'use strict';

const { getIntegrationSecretInfo } = require('../integrations/integrationVault');

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro';
const DEFAULT_OPENAI_MODELS = Object.freeze({
  block: 'gpt-5',
  reAudit: 'gpt-5',
  global: 'gpt-5.5',
  stage8: 'gpt-5',
});
const OPENAI_MODEL_RE = /^gpt-5(?:\.\d+)?(?:-.+)?$/i;

function configuredProvider() {
  const value = String(process.env.SEO_QUALITY_PROVIDER || process.env.SEO_AUDIT_PROVIDER || '').trim().toLowerCase();
  return value === 'deepseek' || value === 'openai' ? value : null;
}

function configuredOpenAiModel(stage) {
  const stageKey = stage === 'global'
    ? process.env.SEO_GLOBAL_AUDIT_OPENAI_MODEL
    : stage === 'stage8'
      ? process.env.SEO_STAGE8_OPENAI_MODEL
      : process.env.SEO_QUALITY_OPENAI_MODEL;
  const candidate = String(stageKey || '').trim().toLowerCase();
  return OPENAI_MODEL_RE.test(candidate) ? candidate : DEFAULT_OPENAI_MODELS[stage] || DEFAULT_OPENAI_MODELS.block;
}

function configuredDeepSeekModel() {
  const candidate = String(process.env.SEO_AUDIT_MODEL || '').trim();
  return candidate.startsWith('deepseek-') ? candidate : DEFAULT_DEEPSEEK_MODEL;
}

/**
 * Pure route decision. Keeping this separate makes provider choice testable
 * without touching the vault or an external API.
 */
function selectQualityRoute({ stage = 'block', openaiConfigured = false, providerOverride = configuredProvider() } = {}) {
  const forcedProvider = providerOverride === 'deepseek' || providerOverride === 'openai'
    ? providerOverride
    : null;

  if (forcedProvider === 'deepseek') {
    return { provider: 'deepseek', model: configuredDeepSeekModel(), source: 'forced_deepseek' };
  }
  if ((forcedProvider === 'openai' || openaiConfigured) && openaiConfigured) {
    return { provider: 'openai', model: configuredOpenAiModel(stage), source: forcedProvider === 'openai' ? 'forced_openai' : 'vault_openai' };
  }
  return {
    provider: 'deepseek',
    model: configuredDeepSeekModel(),
    source: forcedProvider === 'openai' ? 'openai_unconfigured_fallback' : 'deepseek_fallback',
  };
}

async function resolveQualityRoute({ stage = 'block' } = {}) {
  let openaiConfigured = false;
  try {
    const info = await getIntegrationSecretInfo('OPENAI_API_KEY');
    openaiConfigured = Boolean(info?.configured);
  } catch (error) {
    // A vault read failure must not make the quality audit unavailable. The
    // existing DeepSeek route remains the safe fallback.
    openaiConfigured = false;
  }
  return selectQualityRoute({ stage, openaiConfigured });
}

/**
 * Execute a quality call on the selected provider. A configured but unhealthy
 * OpenAI key gets one controlled DeepSeek fallback; it never creates a retry
 * loop or repeats the original large prompt more than once per provider.
 */
async function callQualityModel({ callLLM, route, system, prompt, options, log }) {
  const invoke = (provider, model, extraOptions = {}) => callLLM(
    provider,
    system,
    prompt,
    { ...options, ...extraOptions, model },
  );

  try {
    return await invoke(route.provider, route.model);
  } catch (error) {
    if (route.provider !== 'openai') throw error;
    if (typeof log === 'function') {
      log(`Quality route ${route.model} failed (${error.message}); one bounded fallback to ${DEFAULT_DEEPSEEK_MODEL}`, 'warn');
    }
    return invoke('deepseek', DEFAULT_DEEPSEEK_MODEL, {
      retries: Math.min(1, Math.max(0, Number(options?.retries) || 0)),
      repairOnJsonError: true,
      repairMaxTokens: Math.min(4096, Math.max(1024, Number(options?.repairMaxTokens) || 4096)),
      callLabel: `${options?.callLabel || 'quality'} [DeepSeek fallback]`,
    });
  }
}

module.exports = {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENAI_MODELS,
  selectQualityRoute,
  resolveQualityRoute,
  callQualityModel,
  _internal: { OPENAI_MODEL_RE, configuredProvider, configuredOpenAiModel, configuredDeepSeekModel },
};
