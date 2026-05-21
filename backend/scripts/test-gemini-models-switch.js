/* eslint-disable no-console */
'use strict';

/**
 * test-gemini-models-switch.js — опциональный «живой» smoke-тест:
 * на каждую зарегистрированную gemini-копирайтинговую модель делает
 * один маленький JSON-вызов и проверяет:
 *   • usage.model совпадает с запрошенной моделью;
 *   • text парсится как валидный JSON;
 *   • tokensIn > 0 и tokensOut > 0.
 *
 * Запуск:
 *   GEMINI_API_KEY=... GEMINI_PROXY_URL=... \
 *     node backend/scripts/test-gemini-models-switch.js
 *
 * Если ключ / прокси не заданы — скрипт выходит с кодом 0 и сообщением
 * «skipped». Это позволяет безопасно держать его в CI.
 */

const {
  GEMINI_COPYWRITING_MODELS,
} = require('../src/services/llm/geminiModels');

(async () => {
  const hasKey   = !!process.env.GEMINI_API_KEY;
  const hasProxy = !!(process.env.GEMINI_PROXY_URL || process.env.GEMINI_PROXY_HOST);
  if (!hasKey || !hasProxy) {
    console.log('=== test-gemini-models-switch: SKIPPED ===');
    console.log('  GEMINI_API_KEY    =', hasKey   ? '✓' : '— (missing)');
    console.log('  GEMINI_PROXY_URL  =', hasProxy ? '✓' : '— (missing)');
    console.log('  This is a live network test; set both env vars to run it.');
    process.exit(0);
  }

  const { callGemini } = require('../src/services/llm/gemini.adapter');

  let failed = 0;
  let passed = 0;
  function ok(name, cond, details) {
    if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
    else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
  }

  const SYSTEM = 'You are a strict REST API. Output ONLY valid JSON.';
  const USER   = 'Respond with exactly: {"ok":true,"model_name":"<echo back model name you are>"}';

  for (const { value: model, label } of GEMINI_COPYWRITING_MODELS) {
    console.log(`\n--- Testing ${label} (${model}) ---`);
    try {
      const t0 = Date.now();
      const res = await callGemini(SYSTEM, USER, {
        model,
        maxTokens: 256,
        temperature: 0.0,
        timeoutMs: 120_000,
      });
      const ms = Date.now() - t0;

      ok(`${model}: usage.model echoes requested model`,
         res.model === model,
         `got "${res.model}"`);
      ok(`${model}: tokensIn > 0`,  res.tokensIn  > 0, `tokensIn=${res.tokensIn}`);
      ok(`${model}: tokensOut > 0`, res.tokensOut > 0, `tokensOut=${res.tokensOut}`);

      try {
        const parsed = JSON.parse(res.text);
        ok(`${model}: returns valid JSON`, typeof parsed === 'object' && parsed !== null);
        ok(`${model}: has "ok":true field`, parsed.ok === true);
      } catch (e) {
        ok(`${model}: returns valid JSON`, false, `parse error: ${e.message}; raw: ${(res.text || '').slice(0, 120)}`);
      }

      console.log(`  ⏱  ${ms}ms, ${res.tokensIn}↑ ${res.tokensOut}↓ токенов` +
        (res.thoughtsTokens ? ` (thoughts: ${res.thoughtsTokens})` : ''));
    } catch (e) {
      failed += 1;
      console.log(`  ❌ ${model}: call threw — ${e.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
