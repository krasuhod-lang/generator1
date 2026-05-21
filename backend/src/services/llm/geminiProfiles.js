'use strict';

/**
 * geminiProfiles.js — индивидуальные параметры генерации/валидации
 * для каждой Gemini-копирайтинговой модели.
 *
 * Reasoning-модель `gemini-3.1-pro-preview` и быстрая `gemini-3.5-flash`
 * ведут себя по-разному:
 *   • Pro даёт более длинные, дисциплинированные ответы → выше maxTokens,
 *     ниже число ретраев (модель и так с первого раза попадает в JSON).
 *   • Flash короче и менее дисциплинирована → ниже maxTokens, ниже
 *     temperature (детерминированнее), выше число ретраев self-correction
 *     и assertion-валидаций, усиленный JSON-strict guard.
 *
 * Профиль — единый «DSPy-style» адаптер. Применяется автоматически
 * в `callGemini` (если опции не заданы пользователем явно), а также
 * в self-correction петлях (tasks.controller, metaGenerator, streamRunner)
 * и assertion-валидаторе.
 *
 * Конфигурация хранится в коде через deepFreeze — НЕ читается из env
 * (см. memory «env configuration» — .env.example менять запрещено).
 */

const { DEFAULT_GEMINI_COPYWRITING_MODEL } = require('./geminiModels');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

/**
 * Профили моделей. Ключ — value из GEMINI_COPYWRITING_MODELS.
 *
 * Поля профиля:
 *   • temperature              — дефолтная температура генерации
 *   • maxTokens                — дефолтный лимит выходных токенов
 *   • jsonStrictGuardLevel     — 'soft' | 'strict' (управляет агрессивностью
 *                                 system-промпта на «только валидный JSON»)
 *   • assertionMaxRetries      — лимит повторов в assertions.js при провале
 *                                 типизированной схемы
 *   • selfCorrectionMaxRetries — лимит self-correction (DSPy-style retry
 *                                 с feedback) в tasks.controller / metaGenerator /
 *                                 streamRunner
 *   • streamFallbackTimeoutMs  — таймаут не-стримингового fallback в editorCopilot
 */
const PROFILES = deepFreeze({
  'gemini-3.1-pro-preview': {
    temperature:              0.4,
    maxTokens:                16384,
    jsonStrictGuardLevel:     'soft',
    assertionMaxRetries:      2,
    selfCorrectionMaxRetries: 2,
    streamFallbackTimeoutMs:  300_000,
  },
  'gemini-3.5-flash': {
    temperature:              0.3,
    maxTokens:                12288,
    jsonStrictGuardLevel:     'strict',
    assertionMaxRetries:      3,
    selfCorrectionMaxRetries: 3,
    streamFallbackTimeoutMs:  180_000,
  },
});

const DEFAULT_PROFILE = PROFILES[DEFAULT_GEMINI_COPYWRITING_MODEL] || PROFILES['gemini-3.1-pro-preview'];

/**
 * Возвращает immutable профиль для указанной модели.
 * Если модель неизвестна — возвращает профиль дефолтной модели.
 *
 * @param {string} model — value из GEMINI_COPYWRITING_MODELS
 * @returns {Readonly<object>}
 */
function getGeminiProfile(model) {
  if (!model || typeof model !== 'string') return DEFAULT_PROFILE;
  return PROFILES[model] || DEFAULT_PROFILE;
}

/**
 * Возвращает усиленный JSON-strict guard для модели с jsonStrictGuardLevel='strict'
 * (Flash) или базовый — для 'soft' (Pro). Используется в callGemini.
 *
 * Base guard формулирует REST-контракт; strict-вариант добавляет ещё две
 * директивы, которые на практике помогают Flash избегать markdown-обёрток
 * и trailing-комментариев.
 *
 * @param {string} model
 * @returns {string}
 */
function buildJsonStrictGuard(model) {
  const base =
    'You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. ' +
    'Never use trailing commas. CRITICAL RULES: ' +
    '1) NEVER use double quotes inside string values (use single quotes \'\' instead). ' +
    '2) Always enclose JSON keys in double quotes. ' +
    '3) NEVER use unescaped newlines inside string values.';
  const profile = getGeminiProfile(model);
  if (profile.jsonStrictGuardLevel !== 'strict') return base;
  return base +
    ' 4) DO NOT prefix or suffix the JSON with any explanation, code-fence, or markdown.' +
    ' 5) The very first character of your response MUST be `{` or `[`,' +
    ' the very last character MUST be `}` or `]`. No whitespace, no comments.';
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  getGeminiProfile,
  buildJsonStrictGuard,
};
