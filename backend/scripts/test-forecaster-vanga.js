'use strict';

/**
 * Smoke-test «Ванги» — лаконичного Gemini бизнес-саммари прогноза.
 *
 *   • Без GEMINI_API_KEY runVangaSummary возвращает { verdict:'skipped' }
 *     и НЕ бросает — пайплайн прогнозирования не прерывается.
 *   • Конфиг vanga задаёт cost-control лимиты (maxChars/maxWords/maxTokens).
 *
 * Запуск: `node backend/scripts/test-forecaster-vanga.js`
 * Без сетевых вызовов.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

async function main() {
  delete process.env.GEMINI_API_KEY;
  const { runVangaSummary } = require('../src/services/forecaster/deepseekAnalyzer');
  const { getForecasterConfig } = require('../src/services/forecaster/config');

  console.log('=== vanga config (cost control) ===');
  const cfg = getForecasterConfig().vanga;
  ok('vanga config exists', !!cfg);
  ok('vanga maxChars = 800', cfg.maxChars === 800, String(cfg.maxChars));
  ok('vanga maxWords = 150', cfg.maxWords === 150, String(cfg.maxWords));
  ok('vanga maxTokens ограничен (≤ 600)', cfg.maxTokens <= 600, String(cfg.maxTokens));

  console.log('\n=== graceful skip без API-ключа ===');
  const r = await runVangaSummary({
    unifiedForecast: { verdict: 'ok', horizon: 12, summary: { annual: { value: 1000 } }, params: {}, explain: {} },
    targetUrl: 'https://example.com',
  });
  ok('verdict = skipped', r.verdict === 'skipped', JSON.stringify(r));
  ok('reason = no_api_key', r.reason === 'no_api_key', r.reason);

  console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
