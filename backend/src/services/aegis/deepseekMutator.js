'use strict';

/**
 * aegis/deepseekMutator — Модуль 2.3 (Мутация Кода).
 *
 * По решению владельца продукта: ВМЕСТО Claude 4.5 Opus используем
 * DeepSeek-V4-Pro (тот же провайдер, что и для критика-аудитора).
 *
 * Сценарий: scraper.js фиксирует ≥N (config) подряд провалов на
 * домене. analyzer.py собирает DOM-снимок + старый код парсера.
 * mutator вызывает DeepSeek с системным промптом «ты — senior
 * Python/JS инженер, проанализируй diff и верни unified-diff».
 *
 * Безопасность:
 *   - Allowlist путей (только parser/relevance) — соблюдается на
 *     этапе applyPatch (см. checkPathAllowed).
 *   - Blocklist (llm/, metrics/, aegis/, migrations/, brain_state/,
 *     .github/workflows/) — жёсткий запрет.
 *   - requireHumanReview — по умолчанию true (PR создаётся в draft).
 *
 * Графейс-деградирует: если AEGIS_SELFMUTATE_ENABLED=false или
 * DEEPSEEK_API_KEY не настроен → возвращает { ok:false, reason }.
 */

const path = require('path');
const { getAegisFlags } = require('./featureFlags');

let _deepseekAdapter = null;
function _loadDeepseek() {
  if (!_deepseekAdapter) {
    _deepseekAdapter = require('../llm/deepseek.adapter');
  }
  return _deepseekAdapter;
}

const SYSTEM_PROMPT = [
  'Ты — senior software engineer (Python + Node.js), специализирующийся',
  'на адаптации HTML-парсеров (scrapers) к изменившейся вёрстке доноров.',
  '',
  'ЖЁСТКИЕ ПРАВИЛА:',
  '1. Возвращай ТОЛЬКО unified-diff (формат `git diff`) с минимально',
  '   возможным изменением — никаких рефакторингов вне зоны падения.',
  '2. НИКАКИХ изменений в backend/src/services/llm/**, backend/src/services/metrics/**,',
  '   backend/src/services/aegis/**, migrations/**, brain_state/**, .github/workflows/**.',
  '   Если требуемое исправление лежит вне разрешённой зоны — ответь',
  '   JSON-ом {"abort": true, "reason": "out_of_scope"}.',
  '3. Если уверенность <70%, ответь {"abort": true, "reason": "low_confidence"}.',
  '4. Не добавляй новые зависимости (никаких новых import/require).',
  '5. Сохрани все существующие тесты «зелёными» — твой diff должен',
  '   проходить pytest и npm run lint.',
  '',
  'ВЫХОД: либо unified-diff в ```diff блоке, либо abort JSON.',
].join('\n');

/**
 * isPathAllowed(filePath) — проверка allowlist/blocklist.
 *
 * @param {string} filePath — относительно корня репо (например,
 *                            "backend/src/services/parser/scraper.js")
 */
function isPathAllowed(filePath) {
  const cfg = getAegisFlags().selfmutate;
  const norm = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  // Блок-лист всегда побеждает.
  for (const b of cfg.blocklistPaths) {
    if (norm.startsWith(b)) return { allowed: false, reason: `blocklisted:${b}` };
  }
  // Allowlist должен явно совпасть.
  for (const a of cfg.allowlistPaths) {
    if (norm.startsWith(a)) return { allowed: true };
  }
  return { allowed: false, reason: 'not_in_allowlist' };
}

/**
 * proposePatch({ filePath, oldCode, errorContext, domSnippet? }) — основной API.
 *
 * @returns {Promise<{
 *   ok:boolean, reason?:string, requireHumanReview:boolean,
 *   abort?:boolean, abortReason?:string,
 *   diff?:string, cost_usd?:number, tokens?:object
 * }>}
 */
async function proposePatch({ filePath, oldCode, errorContext, domSnippet = '' } = {}) {
  const cfg = getAegisFlags().selfmutate;
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { ok: false, reason: 'deepseek_key_missing' };

  const pathCheck = isPathAllowed(filePath);
  if (!pathCheck.allowed) {
    return { ok: false, reason: `path_forbidden:${pathCheck.reason}` };
  }

  const userPrompt = [
    `[FILE_PATH] ${filePath}`,
    '[ERROR_CONTEXT]',
    String(errorContext || '').slice(0, 4000),
    '',
    '[OLD_CODE]',
    '```',
    String(oldCode || '').slice(0, 12000),
    '```',
    '',
    '[NEW_DOM_SNIPPET]',
    String(domSnippet || '').slice(0, 6000),
    '',
    '[INSTRUCTION] Предложи минимальный патч (unified-diff) или abort JSON.',
  ].join('\n');

  let response;
  try {
    const { callDeepSeek } = _loadDeepseek();
    response = await callDeepSeek(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.1,
      maxTokens:   6000,
      timeoutMs:   120000,
    });
  } catch (err) {
    return { ok: false, reason: 'llm_error', error: err.message };
  }

  const raw = String((response && response.text) || '');
  const tokens = (response && response.usage) || {};

  // Попытка распарсить abort-JSON.
  const abortMatch = raw.match(/\{\s*"abort"\s*:\s*true[\s\S]*?\}/);
  if (abortMatch) {
    let parsed = {};
    try { parsed = JSON.parse(abortMatch[0]); } catch (_e) { /* ignore */ }
    return {
      ok: true,
      abort: true,
      abortReason: parsed.reason || 'unspecified',
      requireHumanReview: cfg.requireHumanReview,
      tokens,
    };
  }

  // Извлекаем diff-блок.
  const diffMatch = raw.match(/```diff\s*([\s\S]+?)```/);
  const diff = diffMatch ? diffMatch[1].trim() : raw.trim();
  if (!diff || !diff.includes('@@')) {
    return { ok: false, reason: 'no_valid_diff', requireHumanReview: cfg.requireHumanReview, tokens };
  }

  return {
    ok: true,
    requireHumanReview: cfg.requireHumanReview,
    diff,
    cost_usd: tokens.cost_usd || null,
    tokens,
  };
}

module.exports = { proposePatch, isPathAllowed, SYSTEM_PROMPT };
