/* eslint-disable no-console */
'use strict';

/**
 * test-gemini-profiles.js — оффлайн-проверка DSPy-профилей моделей.
 *
 *   • Профиль выбирается по модели.
 *   • Неизвестная модель → дефолтный профиль.
 *   • Усиленный JSON-guard для 'strict'-моделей (Flash).
 *   • Profile подставляется в callGemini как дефолтное значение,
 *     но explicit override побеждает (через моки axios).
 */

const assert = require('assert');
const Module = require('module');

const {
  PROFILES,
  DEFAULT_PROFILE,
  getGeminiProfile,
  buildJsonStrictGuard,
} = require('../src/services/llm/geminiProfiles');

let failed = 0;
let passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

console.log('\n=== test-gemini-profiles ===\n');

// ── 1. Структура профилей ────────────────────────────────────────────
ok('Pro profile exists', !!PROFILES['gemini-3.1-pro-preview']);
ok('Flash profile exists', !!PROFILES['gemini-3.5-flash']);

const pro   = getGeminiProfile('gemini-3.1-pro-preview');
const flash = getGeminiProfile('gemini-3.5-flash');

ok('Pro: temperature is 0.4', pro.temperature === 0.4);
ok('Flash: temperature is 0.3 (more deterministic)', flash.temperature === 0.3);
ok('Pro: maxTokens 16384', pro.maxTokens === 16384);
ok('Flash: maxTokens 12288 (smaller)', flash.maxTokens === 12288);
ok('Pro: jsonStrictGuardLevel = soft', pro.jsonStrictGuardLevel === 'soft');
ok('Flash: jsonStrictGuardLevel = strict', flash.jsonStrictGuardLevel === 'strict');
ok('Pro: selfCorrectionMaxRetries = 2', pro.selfCorrectionMaxRetries === 2);
ok('Flash: selfCorrectionMaxRetries = 3 (more retries)', flash.selfCorrectionMaxRetries === 3);
ok('Pro: assertionMaxRetries = 2', pro.assertionMaxRetries === 2);
ok('Flash: assertionMaxRetries = 3', flash.assertionMaxRetries === 3);

// ── 2. Неизвестная модель → дефолт ───────────────────────────────────
ok('unknown model returns DEFAULT_PROFILE',
   getGeminiProfile('gemini-99-ultra') === DEFAULT_PROFILE);
ok('null returns DEFAULT_PROFILE', getGeminiProfile(null) === DEFAULT_PROFILE);
ok('undefined returns DEFAULT_PROFILE', getGeminiProfile(undefined) === DEFAULT_PROFILE);
ok('empty string returns DEFAULT_PROFILE', getGeminiProfile('') === DEFAULT_PROFILE);

// ── 3. Immutability (deepFreeze) ─────────────────────────────────────
try {
  pro.temperature = 9;
  ok('profile is frozen (mutation thrown or ignored)',
     pro.temperature === 0.4);
} catch (_) {
  ok('profile is frozen (mutation threw)', true);
}

// ── 4. JSON-strict guard ────────────────────────────────────────────
{
  const softGuard   = buildJsonStrictGuard('gemini-3.1-pro-preview');
  const strictGuard = buildJsonStrictGuard('gemini-3.5-flash');
  ok('soft guard has CRITICAL RULES', /CRITICAL RULES/.test(softGuard));
  ok('soft guard has only rules 1-3', !/4\)/.test(softGuard));
  ok('strict guard adds rules 4-5', /4\).+5\)/s.test(strictGuard));
  ok('strict guard mentions «first character»', /first character/.test(strictGuard));
  ok('strict guard mentions «last character»', /last character/.test(strictGuard));
  ok('unknown model uses default guard', buildJsonStrictGuard('xxx') === softGuard);
}

// ── 5. callGemini auto-applies profile when options omitted ─────────
// Перехватываем axios.post через require-cache, чтобы не делать сеть.
{
  const captured = [];
  const fakeResponse = {
    status: 200,
    data: {
      candidates: [{
        content: { parts: [{ text: '{"ok":true}' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  };
  const fakeAxios = {
    post: async (_url, payload, _cfg) => {
      captured.push({ payload });
      return fakeResponse;
    },
    get: async () => ({ status: 200, data: {} }),
    delete: async () => ({ status: 200, data: {} }),
  };

  // Подменяем модуль axios в require cache ДО загрузки gemini.adapter.
  const axiosPath = require.resolve('axios');
  delete require.cache[axiosPath];
  require.cache[axiosPath] = {
    id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios,
  };
  // Также сбрасываем gemini.adapter из кэша, чтобы он подобрал моки.
  const adapterPath = require.resolve('../src/services/llm/gemini.adapter');
  delete require.cache[adapterPath];

  // API-ключ и прокси нужны — задаём фиктивные значения, axios всё равно
  // замокан выше, реального сетевого вызова не будет.
  process.env.GEMINI_API_KEY = 'fake-key-for-tests';
  process.env.GEMINI_PROXY_URL = 'http://user:pass@127.0.0.1:9';

  const { callGemini } = require('../src/services/llm/gemini.adapter');

  (async () => {
    captured.length = 0;
    await callGemini('sys', 'usr', { model: 'gemini-3.5-flash' });
    const cfg = captured[0].payload.generationConfig;
    ok('Flash: callGemini auto-applies temperature=0.3',
       cfg.temperature === 0.3);
    ok('Flash: callGemini auto-applies maxOutputTokens=12288',
       cfg.maxOutputTokens === 12288);

    captured.length = 0;
    await callGemini('sys', 'usr', { model: 'gemini-3.1-pro-preview' });
    const cfg2 = captured[0].payload.generationConfig;
    ok('Pro: callGemini auto-applies temperature=0.4',
       cfg2.temperature === 0.4);
    ok('Pro: callGemini auto-applies maxOutputTokens=16384',
       cfg2.maxOutputTokens === 16384);

    captured.length = 0;
    await callGemini('sys', 'usr', { model: 'gemini-3.5-flash', temperature: 0.9, maxTokens: 5000 });
    const cfg3 = captured[0].payload.generationConfig;
    ok('explicit temperature overrides profile',
       cfg3.temperature === 0.9);
    ok('explicit maxTokens overrides profile',
       cfg3.maxOutputTokens === 5000);

    captured.length = 0;
    await callGemini('sys', 'usr', { model: 'gemini-3.5-flash' });
    const sysInstr = captured[0].payload.systemInstruction?.parts?.[0]?.text || '';
    ok('Flash: systemInstruction contains strict-level rule 4',
       /4\)/.test(sysInstr));

    captured.length = 0;
    await callGemini('sys', 'usr', { model: 'gemini-3.1-pro-preview' });
    const sysInstr2 = captured[0].payload.systemInstruction?.parts?.[0]?.text || '';
    ok('Pro: systemInstruction does NOT contain rule 4',
       !/4\)/.test(sysInstr2));

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })().catch((e) => {
    console.error('FATAL', e);
    process.exit(2);
  });
}
