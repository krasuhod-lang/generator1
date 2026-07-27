'use strict';

/**
 * Тест защиты аналитики прогнозатора от обрезанных ответов LLM.
 *
 *   • callAnalyticLLM повторяет вызов с удвоенным maxTokens, когда модель
 *     вернула finish_reason='length' / 'MAX_TOKENS' или пустой текст;
 *   • после исчерпания попыток ответ помечается truncated=true;
 *   • runDeepSeekAnalysis / DSPy-эксперты отдают verdict='error' с внятной
 *     причиной (truncated / empty_response / invalid_json) вместо пустого 'ok';
 *   • при валидном JSON поля нормализуются (verdict='ok').
 *
 * Запуск: `node backend/scripts/test-forecaster-analytic-llm.js`
 * Сетевых вызовов нет — адаптер DeepSeek подменяется заглушкой.
 */

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

// ── Заглушки LLM-адаптеров (без сети и без установки зависимостей) ───
// Кладём модули в require.cache ДО первого require аналитики, поэтому
// реальные adapters (axios, https-proxy-agent) не загружаются вовсе.
const adapterPath = require.resolve(path.join(__dirname, '../src/services/llm/deepseek.adapter'));
const geminiPath  = require.resolve(path.join(__dirname, '../src/services/llm/gemini.adapter'));

// Очередь сценариев ответов + журнал фактических maxTokens запросов.
let scripted = [];
const calls = [];

function _stubModule(modPath, exports) {
  const mod = new (require('module'))(modPath, null);
  mod.filename = modPath;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[modPath] = mod;
}

_stubModule(adapterPath, {
  DEEPSEEK_DEFAULT_MAX_TOKENS: 16000,
  isReasoningModel: () => false,
  callDeepSeek: async (_system, _user, options = {}) => {
    calls.push({ maxTokens: options.maxTokens });
    const next = scripted.shift() || { text: '', finishReason: 'length' };
    return {
      text: next.text || '',
      tokensIn: 100,
      tokensOut: 200,
      model: 'deepseek-v4-pro',
      cacheHitTokens: 0,
      finishReason: next.finishReason || 'stop',
    };
  },
});

_stubModule(geminiPath, {
  callGemini: async () => { throw new Error('gemini must not be called in this test'); },
});

function reset(scenarios) {
  scripted = scenarios.slice();
  calls.length = 0;
}

const VALID_SUMMARY = JSON.stringify({
  summary: 'Спрос стабилен, рост реалистичен на горизонте года.',
  demand_analysis: 'Сезонный пик приходится на осень.',
  traffic_analysis: 'ТОП-10 даёт кратный, но не ×10 рост.',
  leads_analysis: 'CR 2 % → ≈180 заявок в год.',
  bullets: ['  наблюдение 1  ', '', 'наблюдение 2'],
  ranking_factors: [
    { factor: 'E-E-A-T', status: 'gap', note: 'нет авторства' },
    { factor: 'Мусор', status: 'нечто', note: '' },
    'строка-мусор',
  ],
  pitfalls: ['высокая конкуренция'],
  works_alignment: 'Работы закрывают пробелы охвата.',
  recommendations: ['собрать hub-страницу'],
});

const VALID_PLANS = JSON.stringify([
  {
    cluster_centroid: 'пластиковые окна',
    content_units_target: 8,
    page_types: ['hub_pillar', 'commercial_landing'],
    internal_links_min: 10,
    expected_coverage_gain: 0.35,
    phases: [{ month: 1, milestone: 'структура', deliverables: ['ТЗ'] }],
  },
]);

async function main() {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  delete process.env.GEMINI_API_KEY;

  const { callAnalyticLLM, isTruncatedResponse, MAX_OUTPUT_TOKENS_CAP, TRUNCATION_RETRIES } =
    require('../src/services/forecaster/analyticLLM');
  const { runDeepSeekAnalysis, runClusterPlanner } =
    require('../src/services/forecaster/deepseekAnalyzer');
  const { getForecasterConfig } = require('../src/services/forecaster/config');

  console.log('=== isTruncatedResponse ===');
  ok('finish_reason=length → truncated', isTruncatedResponse({ text: '{', finishReason: 'length' }));
  ok('Gemini MAX_TOKENS → truncated', isTruncatedResponse({ text: '{', finishReason: 'MAX_TOKENS' }));
  ok('пустой текст → truncated', isTruncatedResponse({ text: '   ', finishReason: 'stop' }));
  ok('нормальный ответ → нет', !isTruncatedResponse({ text: '{"a":1}', finishReason: 'stop' }));

  console.log('\n=== ретрай с удвоением maxTokens ===');
  reset([
    { text: '', finishReason: 'length' },
    { text: VALID_SUMMARY, finishReason: 'stop' },
  ]);
  const retried = await callAnalyticLLM('sys', 'user', { maxTokens: 1000 });
  ok('было 2 вызова', calls.length === 2, JSON.stringify(calls));
  ok('первый вызов с исходным лимитом', calls[0].maxTokens === 1000, String(calls[0].maxTokens));
  ok('второй вызов с удвоенным лимитом', calls[1].maxTokens === 2000, String(calls[1].maxTokens));
  ok('итоговый ответ не помечен truncated', !retried.resp.truncated);
  ok('provider = deepseek', retried.provider === 'deepseek', retried.provider);

  console.log('\n=== исчерпание попыток → truncated ===');
  reset([
    { text: '', finishReason: 'length' },
    { text: '', finishReason: 'length' },
    { text: '', finishReason: 'length' },
    { text: VALID_SUMMARY, finishReason: 'stop' },
  ]);
  const exhausted = await callAnalyticLLM('sys', 'user', { maxTokens: 1000 });
  ok('вызовов = 1 + TRUNCATION_RETRIES', calls.length === TRUNCATION_RETRIES + 1, String(calls.length));
  ok('лимит рос до 4000', calls[calls.length - 1].maxTokens === 4000, String(calls[calls.length - 1].maxTokens));
  ok('resp.truncated = true', exhausted.resp.truncated === true);

  console.log('\n=== потолок лимита ===');
  reset([{ text: '', finishReason: 'length' }, { text: VALID_SUMMARY, finishReason: 'stop' }]);
  await callAnalyticLLM('sys', 'user', { maxTokens: MAX_OUTPUT_TOKENS_CAP });
  ok('на потолке ретраев нет', calls.length === 1, String(calls.length));

  console.log('\n=== runDeepSeekAnalysis: обрезка → error ===');
  reset([
    { text: '', finishReason: 'length' },
    { text: '', finishReason: 'length' },
    { text: '', finishReason: 'length' },
  ]);
  const dsTrunc = await runDeepSeekAnalysis({ sourceInfo: { filename: 'a.csv', rowsCount: 10 } });
  ok('verdict = error', dsTrunc.verdict === 'error', JSON.stringify(dsTrunc).slice(0, 200));
  ok('reason = truncated', dsTrunc.reason === 'truncated', dsTrunc.reason);
  ok('токены сохранены для учёта', dsTrunc.tokens_in === 100 && dsTrunc.tokens_out === 200);

  console.log('\n=== runDeepSeekAnalysis: не-JSON → invalid_json ===');
  reset([{ text: 'Извините, не могу ответить.', finishReason: 'stop' }]);
  const dsBad = await runDeepSeekAnalysis({ sourceInfo: { filename: 'a.csv', rowsCount: 10 } });
  ok('verdict = error', dsBad.verdict === 'error', JSON.stringify(dsBad).slice(0, 200));
  ok('reason = invalid_json', dsBad.reason === 'invalid_json', dsBad.reason);
  ok('raw_text сохранён', typeof dsBad.raw_text === 'string' && dsBad.raw_text.length > 0);

  console.log('\n=== runDeepSeekAnalysis: валидный JSON → ok ===');
  reset([{ text: VALID_SUMMARY, finishReason: 'stop' }]);
  const dsOk = await runDeepSeekAnalysis({ sourceInfo: { filename: 'a.csv', rowsCount: 10 } });
  ok('verdict = ok', dsOk.verdict === 'ok', JSON.stringify(dsOk).slice(0, 200));
  ok('summary заполнен', dsOk.summary.startsWith('Спрос стабилен'), dsOk.summary);
  ok('bullets очищены от пустых', dsOk.bullets.length === 2, JSON.stringify(dsOk.bullets));
  ok('bullets обрезаны по краям', dsOk.bullets[0] === 'наблюдение 1', dsOk.bullets[0]);
  ok('ranking_factors отфильтрованы', dsOk.ranking_factors.length === 2, JSON.stringify(dsOk.ranking_factors));
  ok('неизвестный status → gap', dsOk.ranking_factors[1].status === 'gap', dsOk.ranking_factors[1].status);
  ok('works_alignment заполнен', dsOk.works_alignment.length > 0);
  ok('raw_text пуст при успехе', dsOk.raw_text === null);

  console.log('\n=== ClusterPlanner ===');
  reset([{ text: '', finishReason: 'length' }, { text: '', finishReason: 'length' }, { text: '', finishReason: 'length' }]);
  const clusters = [{ centroid: 'окна', members_count: 5, total_demand_monthly: 2000, member_phrases: ['окна купить'] }];
  const planTrunc = await runClusterPlanner({ clusters });
  ok('verdict = error', planTrunc.verdict === 'error', JSON.stringify(planTrunc).slice(0, 200));
  ok('reason = truncated', planTrunc.reason === 'truncated', planTrunc.reason);

  reset([{ text: VALID_PLANS, finishReason: 'stop' }]);
  const planOk = await runClusterPlanner({ clusters });
  ok('verdict = ok', planOk.verdict === 'ok', JSON.stringify(planOk).slice(0, 200));
  ok('payload — массив планов', Array.isArray(planOk.payload) && planOk.payload.length === 1);
  ok('centroid прокинут', planOk.payload[0].cluster_centroid === 'пластиковые окна');

  console.log('\n=== лимиты в конфиге ===');
  const cfg = getForecasterConfig();
  assert.ok(cfg.deepseek.maxTokens >= 8000, 'deepseek.maxTokens');
  ok('deepseek.maxTokens ≥ 8000', cfg.deepseek.maxTokens >= 8000, String(cfg.deepseek.maxTokens));
  ok('report.maxTokens ≥ 8000', cfg.report.maxTokens >= 8000, String(cfg.report.maxTokens));
  const ex = cfg.advanced.experts;
  ok('эксперты ≥ 4000 токенов',
    ex.nicheStrategist.maxTokens >= 4000 && ex.opportunityHunter.maxTokens >= 4000 && ex.clusterPlanner.maxTokens >= 4000,
    JSON.stringify([ex.nicheStrategist.maxTokens, ex.opportunityHunter.maxTokens, ex.clusterPlanner.maxTokens]));
  ok('таймаут экспертов ≥ 120 c',
    ex.nicheStrategist.timeoutMs >= 120000 && ex.clusterPlanner.timeoutMs >= 120000,
    String(ex.nicheStrategist.timeoutMs));

  console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
