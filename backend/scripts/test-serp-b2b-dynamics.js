'use strict';

/**
 * Tests for SERP B2B growth evaluator (keys.so dynamics), anti-bot
 * site-fetcher helpers and parsing statistics.
 *
 * Покрывает:
 *   • classifyTrend: ±10% — стагнация, минус — падение, плюс — рост;
 *   • _evaluateHistory: first vs last точка истории keys.so;
 *   • причины отсутствия динамики (not_found / no_history / rate_limited...)
 *     больше не проглатываются, а сохраняются в dynamics.errors;
 *   • fallback на общероссийскую базу msk, если в региональной базе
 *     keys.so домена нет (главная причина «динамика не у всех»);
 *   • enrichResultsWithDynamics собирает статистику покрытия;
 *   • siteFetcher: определение WAF-заглушек / пустых SPA-шеллов и
 *     резолв URL антибот-эскалации;
 *   • pipeline._buildParsingStats: сводная статистика парсинга.
 *
 * Запуск:  node backend/scripts/test-serp-b2b-dynamics.js
 */

const path = require('path');

// Подменяем pg/db, чтобы тесты не зависели от БД.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

// Мок keys.so-клиента — управляемый сценарий ответов по base.
const keysSoPath = require.resolve('../src/services/reports/keysSoClient');
const mockState = { calls: [], handler: null };
class KeysSoError extends Error {
  constructor(message, code = 'keys_so_error', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
require.cache[keysSoPath] = {
  exports: {
    getDomainDashboard: async (domain, opts = {}) => {
      mockState.calls.push({ domain, base: opts.base });
      if (!mockState.handler) throw new KeysSoError('no handler', 'not_found', 404);
      return mockState.handler(domain, opts.base);
    },
    getGoogleBase: (b) => (b === 'mns' ? 'gmns' : 'gru'),
    KeysSoError,
  },
};

process.env.KEYS_SO_API_KEY = process.env.KEYS_SO_API_KEY || 'test-key';

const growth = require('../src/services/serpB2b/growthEvaluator');
const {
  classifyTrend, evaluateDomainDynamics, enrichResultsWithDynamics,
  _evaluateHistory, _reasonFromError,
} = growth;
const {
  looksBlockedHtml, looksEmptyHtml, _resolveFetchHtmlUrl, _shouldEscalateOnError,
} = require('../src/services/serpB2b/siteFetcher');
const { _buildParsingStats } = require('../src/services/serpB2b/pipeline');

// Ускоряем троттлинг-паузы в тестах.
const _origSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => _origSetTimeout(fn, Math.min(ms || 0, 5), ...args);

let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const hist = (values) => values.map((v, i) => ({
  date: `2025-${String(i + 1).padStart(2, '0')}-01`,
  keywords_top50: v,
}));

async function main() {
  console.log('\n[serpB2b] classifyTrend (±10% = стагнация)');
  ok('+50% → growth', classifyTrend(100, 150).trend === 'growth');
  ok('-50% → decline', classifyTrend(100, 50).trend === 'decline');
  ok('+5% → stagnation', classifyTrend(100, 105).trend === 'stagnation');
  ok('-10% ровно → stagnation', classifyTrend(100, 90).trend === 'stagnation');
  ok('0→0 → stagnation', classifyTrend(0, 0).trend === 'stagnation');
  ok('0→N → growth', classifyTrend(0, 20).trend === 'growth');
  ok('null → null trend', classifyTrend(null, 5).trend === null);

  console.log('\n[serpB2b] _evaluateHistory');
  ok('история < 2 точек → null', _evaluateHistory(hist([100]), 'msk') === null);
  const ev = _evaluateHistory(hist([100, 120, 200]), 'msk');
  ok('first vs last: 100→200 = growth +100%',
    ev && ev.trend === 'growth' && ev.deviation_pct === 100, JSON.stringify(ev));
  ok('metric = keywords_top50', ev && ev.metric === 'keywords_top50');
  ok('months_tracked = 3', ev && ev.months_tracked === 3);

  console.log('\n[serpB2b] _reasonFromError');
  ok('404 → not_found', _reasonFromError(new KeysSoError('x', 'not_found', 404)) === 'not_found');
  ok('429 → rate_limited', _reasonFromError(new KeysSoError('x', 'http_error', 429)) === 'rate_limited');
  ok('401 → unauthorized', _reasonFromError(new KeysSoError('x', 'unauthorized', 401)) === 'unauthorized');
  ok('сеть → network', _reasonFromError(new Error('boom')) === 'network');

  console.log('\n[serpB2b] evaluateDomainDynamics: причины вместо тихого null');
  mockState.handler = () => { throw new KeysSoError('nope', 'not_found', 404); };
  mockState.calls = [];
  let d = await evaluateDomainDynamics('example.ru', { region: '213' });
  ok('объект возвращается даже без данных', d !== null && typeof d === 'object');
  ok('errors.yandex = not_found', d && d.errors && d.errors.yandex === 'not_found');
  ok('errors.google = not_found', d && d.errors && d.errors.google === 'not_found');
  ok('yandex/google = null', d && d.yandex === null && d.google === null);

  console.log('\n[serpB2b] fallback на msk при отсутствии в региональной базе');
  mockState.calls = [];
  mockState.handler = (domain, base) => {
    if (base === 'msk' || base === 'gru') return { history: hist([100, 150]) };
    throw new KeysSoError('nope', 'not_found', 404); // региональные базы пустые
  };
  d = await evaluateDomainDynamics('example.ru', { region: '65' }); // Новосибирск → nsk
  ok('регион nsk запрошен первым', mockState.calls[0] && mockState.calls[0].base === 'nsk');
  ok('после not_found — fallback на msk', mockState.calls.some((c) => c.base === 'msk'));
  ok('динамика получена из msk', d && d.yandex && d.yandex.base === 'msk');
  ok('trend по msk-истории = growth', d && d.yandex && d.yandex.trend === 'growth');
  ok('google получен из gru', d && d.google && d.google.base === 'gru');
  ok('errors пустой при успехе', !d.errors);

  console.log('\n[serpB2b] no_history: домен есть, истории мало');
  mockState.handler = () => ({ history: hist([100]) });
  d = await evaluateDomainDynamics('example.ru', { region: '213' });
  ok('errors.yandex = no_history', d && d.errors && d.errors.yandex === 'no_history');

  console.log('\n[serpB2b] enrichResultsWithDynamics: статистика покрытия');
  mockState.handler = (domain) => {
    if (domain === 'good.ru') return { history: hist([100, 200]) };
    throw new KeysSoError('nope', 'not_found', 404);
  };
  const rows = [
    { url: 'https://good.ru/', status: 'ok' },
    { url: 'https://missing.ru/', status: 'ok' },
    { url: 'https://broken.ru/', status: 'error' },
  ];
  const { stats } = await enrichResultsWithDynamics(rows, { region: '213' });
  ok('total = 3', stats.total === 3);
  ok('evaluated = 1', stats.evaluated === 1, JSON.stringify(stats));
  ok('with_yandex = 1', stats.with_yandex === 1);
  ok('no_data = 1', stats.no_data === 1);
  ok('skipped (error-строка) = 1', stats.skipped === 1);
  ok('reasons.not_found посчитаны', (stats.reasons.not_found || 0) >= 1);
  ok('error-строка получила dynamics = null', rows[2].dynamics === null);
  ok('good.ru получил динамику', rows[0].dynamics && rows[0].dynamics.yandex
    && rows[0].dynamics.yandex.trend === 'growth');

  console.log('\n[serpB2b] siteFetcher: WAF / SPA-детект и эскалация');
  ok('Cloudflare challenge → blocked',
    looksBlockedHtml('<html><title>Just a moment...</title></html>'));
  ok('DDoS-Guard → blocked', looksBlockedHtml('<html>ddos-guard check</html>'));
  ok('обычный HTML → not blocked',
    !looksBlockedHtml('<html><body><h1>ООО Ромашка — производство бетона</h1></body></html>'));
  ok('SPA-шелл без текста → empty',
    looksEmptyHtml('<html><body><div id="app"></div><script>boot()</script></body></html>'));
  const longText = 'Компания продаёт промышленное оборудование и комплектующие. '.repeat(20);
  ok('страница с текстом → not empty', !looksEmptyHtml(`<html><body><p>${longText}</p></body></html>`));
  ok('/fetch → /fetch_html', _resolveFetchHtmlUrl('http://fetcher:8001/fetch') === 'http://fetcher:8001/fetch_html');
  ok('/fetch_html остаётся', _resolveFetchHtmlUrl('http://fetcher:8001/fetch_html') === 'http://fetcher:8001/fetch_html');
  ok('корень → /fetch_html', _resolveFetchHtmlUrl('http://fetcher:8001') === 'http://fetcher:8001/fetch_html');
  ok('пусто → нет эскалации', _resolveFetchHtmlUrl('') === '');
  ok('403 эскалируется', _shouldEscalateOnError('http_403'));
  ok('timeout эскалируется', _shouldEscalateOnError('timeout'));
  ok('404 НЕ эскалируется', !_shouldEscalateOnError('http_404'));

  console.log('\n[serpB2b] pipeline._buildParsingStats');
  const pstats = _buildParsingStats([
    { status: 'ok', company_name: 'ООО Ромашка', inn: '7707083893', phones: ['+7'], emails: [], services: ['a'], fetch_engine: 'axios' },
    { status: 'ok', company_name: null, inn: null, phones: [], emails: ['a@b.ru'], services: [], fetch_engine: 'playwright' },
    { status: 'empty', phones: [], emails: [], services: [] },
    { status: 'error', phones: [], emails: [] },
  ]);
  ok('sites: 4 total / 2 ok / 1 empty / 1 error',
    pstats.sites.total === 4 && pstats.sites.ok === 2 && pstats.sites.empty === 1 && pstats.sites.error === 1);
  ok('contacts.with_inn = 1', pstats.contacts.with_inn === 1);
  ok('contacts.with_emails = 1', pstats.contacts.with_emails === 1);
  ok('contacts.complete = 1 (ИНН + телефон)', pstats.contacts.complete === 1);
  ok('fetch_engines: axios=2, playwright=1, failed=1',
    pstats.fetch_engines.axios === 2 && pstats.fetch_engines.playwright === 1
    && pstats.fetch_engines.failed === 1, JSON.stringify(pstats.fetch_engines));

  console.log(`\n${failed === 0 ? '✅ ALL OK' : `❌ ${failed} TEST(S) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
