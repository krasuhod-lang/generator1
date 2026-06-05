'use strict';

/**
 * test-projects-analyzer.js — smoke-тесты мультиисточниковой AI-аналитики:
 *   • llmAnalyst — выбор провайдера (Gemini ↔ DeepSeek) и доступность;
 *   • rankingFactors — детерминированный аудит факторов ранжирования;
 *   • ydxAnalyzer / synthesisAnalyzer — построение промптов и graceful-фолбэк
 *     при отсутствии LLM-ключей.
 *
 * Без сетевых вызовов: при отсутствии GEMINI/DEEPSEEK ключей runAnalyst
 * возвращает verdict:'skipped'. Запуск: node backend/scripts/test-projects-analyzer.js
 */

const assert = require('assert');

// Изолируем тест от реальных ключей окружения.
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

const llmAnalyst = require('../src/services/projects/llmAnalyst');
const {
  buildRankingFactors,
  renderRankingFactorsLines,
  _evaluateFactor,
} = require('../src/services/projects/rankingFactors');
const ydxAnalyzer = require('../src/services/projects/ydxAnalyzer');
const synthesisAnalyzer = require('../src/services/projects/synthesisAnalyzer');

let passed = 0; let failed = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}

console.log('## llmAnalyst.resolveProvider');
{
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  ok('no keys → provider null', llmAnalyst.resolveProvider() === null);
  ok('no keys → analystAvailable false', llmAnalyst.analystAvailable() === false);

  process.env.GEMINI_API_KEY = 'test-gemini';
  ok('gemini key → gemini', llmAnalyst.resolveProvider() === 'gemini');
  ok('gemini key → available', llmAnalyst.analystAvailable() === true);

  delete process.env.GEMINI_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek';
  ok('only deepseek → fallback deepseek', llmAnalyst.resolveProvider() === 'deepseek');

  delete process.env.DEEPSEEK_API_KEY;
  ok('cleared → provider null again', llmAnalyst.resolveProvider() === null);
}

console.log('## llmAnalyst.runAnalyst (no key → skipped, never throws)');
{
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  // Должен мягко вернуть skipped, а не бросить.
  (async () => {
    const r = await llmAnalyst.runAnalyst('sys', 'user', { kind: 'test' });
    ok('runAnalyst skipped without keys', r.verdict === 'skipped');
  })();
  ok('_stripFence strips markdown fence',
    llmAnalyst._stripFence('```markdown\n# Hi\n```') === '# Hi');
}

console.log('## rankingFactors.buildRankingFactors');
{
  const gsc = {
    commercial: {
      available: true,
      ctr_anomalies: [1, 2, 3, 4, 5, 6],
      striking_distance: [1, 2, 3, 4],
      cannibalization: [1, 2, 3],
    },
    page_decay: { available: true, decaying_count: 4 },
    eat: { available: true, avg_score: 45 },
    schema_audit: { available: true, summary: { missing_types: 4 } },
    link_audit: { available: true, recommendations: [1, 2], data_source: 'inferred' },
    breakdowns: { device: [
      { key: 'MOBILE', clicks: 60, position: 12 },
      { key: 'DESKTOP', clicks: 40, position: 8 },
    ] },
    geo_aeo: { available: true, aeo: { missing_schema: ['FAQPage'], recommendations: ['x'] } },
    blog_plan: { available: true, topics: [1, 2, 3, 4] },
    top_page_insights: { leaders: [{ url: 'x' }] },
  };
  const rf = buildRankingFactors(gsc, null);
  ok('available true', rf.available === true);
  ok('score is number 0..100', typeof rf.score === 'number' && rf.score >= 0 && rf.score <= 100);
  ok('has gaps array', Array.isArray(rf.gaps) && rf.gaps.length > 0);
  ok('factors cover full catalog', rf.factors.length >= 12);
  ok('ctr critical (6 anomalies)', rf.factors.find((f) => f.key === 'ctr').status === 'critical');
  ok('cannibalization critical (3)', rf.factors.find((f) => f.key === 'cannibalization').status === 'critical');
  ok('eat critical (45)', rf.factors.find((f) => f.key === 'eat').status === 'critical');
  ok('page_decay critical (4)', rf.factors.find((f) => f.key === 'page_decay').status === 'critical');
  ok('striking is gap', rf.factors.find((f) => f.key === 'striking').status === 'gap');
  ok('gaps sorted critical-first', rf.gaps[0].status === 'critical');
  ok('summary non-empty string', typeof rf.summary === 'string' && rf.summary.length > 0);

  // Полностью пустой снапшот → всё unknown, score null, нет gaps.
  const empty = buildRankingFactors({}, null);
  ok('empty snapshot available', empty.available === true);
  ok('empty → no gaps', empty.gaps.length === 0);
  ok('empty → score null', empty.score === null);

  // renderRankingFactorsLines
  const lines = renderRankingFactorsLines(rf);
  ok('render lines includes header', lines.some((l) => l.includes('ФАКТОРЫ РАНЖИРОВАНИЯ')));
  ok('render empty rf → []', renderRankingFactorsLines(null).length === 0);
}

console.log('## rankingFactors._evaluateFactor (graceful on missing data)');
{
  ok('unknown factor → null', _evaluateFactor('does_not_exist', {}, null) === null);
  ok('ctr without commercial → null', _evaluateFactor('ctr', {}, null) === null);
  const okCtr = _evaluateFactor('ctr', { commercial: { available: true, ctr_anomalies: [] } }, null);
  ok('ctr no anomalies → ok', okCtr && okCtr.status === 'ok');
}

console.log('## ydxAnalyzer._buildUserPrompt');
{
  const prompt = ydxAnalyzer._buildUserPrompt({
    project: { name: 'Тест', ydx_site_url: 'https://t.ru', audience_description: 'B2B' },
    range: { startDate: '2026-01-01', endDate: '2026-01-28' },
    performance: { totals: { clicks: 10, impressions: 100, ctr: 10, position: 5 }, series: [{ date: '2026-01-01', clicks: 1 }] },
    topQueries: [{ key: 'купить котёл', clicks: 5, impressions: 50, ctr: 10, position: 7 }],
    brandSplit: { available: true, branded: { clicks: 3 }, nonbranded: { clicks: 7 }, brand_tokens: ['тест'] },
    dspySuffix: 'DSPY-SUFFIX',
  });
  ok('mentions Яндекс metrics', prompt.includes('СУММАРНЫЕ МЕТРИКИ ЯНДЕКСА'));
  ok('includes top query', prompt.includes('купить котёл'));
  ok('includes brand split', prompt.includes('БРЕНД vs НЕБРЕНД'));
  ok('appends dspy suffix', prompt.includes('DSPY-SUFFIX'));
  ok('SYSTEM_PROMPT targets Yandex', /ЯНДЕКС/i.test(ydxAnalyzer.SYSTEM_PROMPT));
}

console.log('## synthesisAnalyzer (prompt + fallback)');
{
  const rf = buildRankingFactors({ commercial: { available: true, ctr_anomalies: [1, 2, 3, 4, 5, 6] } }, null);
  const prompt = synthesisAnalyzer._buildUserPrompt({
    project: { name: 'Тест', gsc_site_url: 'https://t.ru' },
    gscReport: 'GOOGLE REPORT',
    ydxReport: 'YANDEX REPORT',
    gscPerformance: { totals: { clicks: 100, impressions: 1000, ctr: 10, position: 5 } },
    ydxPerformance: { totals: { clicks: 50, impressions: 600, ctr: 8.3, position: 7 } },
    rankingFactors: rf,
    dspySuffix: 'SYNTH-DSPY',
  });
  ok('synthesis includes both reports', prompt.includes('GOOGLE REPORT') && prompt.includes('YANDEX REPORT'));
  ok('synthesis includes Google metrics', prompt.includes('Google: клики 100'));
  ok('synthesis includes Yandex metrics', prompt.includes('Яндекс: клики 50'));
  ok('synthesis includes ranking factors block', prompt.includes('ФАКТОРЫ РАНЖИРОВАНИЯ'));
  ok('synthesis appends dspy suffix', prompt.includes('SYNTH-DSPY'));

  // fallback markdown (LLM unavailable)
  const fb = synthesisAnalyzer._fallbackMarkdown(rf);
  ok('fallback markdown non-empty', typeof fb === 'string' && fb.includes('факторы ранжирования'));
  ok('fallback empty rf → empty string', synthesisAnalyzer._fallbackMarkdown(null) === '');

  // runSynthesis without keys → skipped but still returns fallback + ranking_factors
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  (async () => {
    const res = await synthesisAnalyzer.runSynthesis({
      project: { name: 'Тест' },
      gscReport: 'G', ydxReport: 'Y',
      gscPerformance: { totals: {} }, ydxPerformance: { totals: {} },
      rankingFactors: rf,
    });
    ok('runSynthesis skipped without keys', res.verdict === 'skipped');
    ok('runSynthesis still returns ranking_factors', res.ranking_factors === rf);
    ok('runSynthesis returns fallback markdown', typeof res.markdown === 'string' && res.markdown.length > 0);
  })();
}

// Дожидаемся async-проверок (микротаски) перед итогом.
setTimeout(() => {
  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}, 200);
