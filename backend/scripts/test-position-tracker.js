'use strict';

/**
 * Smoke-tests for positionTracker module.
 *
 *  • analytics pure helpers (classifyDelta, deltaPosition, summarizeRows,
 *    pickMovers, groupSeries) on synthetic data.
 *  • xmlstockSerp host-matching logic (subdomains, www, protocol stripping).
 *  • runner: end-to-end against an in-memory DB stub + mocked checkFn —
 *    проверяем, что run создаётся, results пишутся, прогресс инкрементируется.
 *
 * Запуск:  node backend/scripts/test-position-tracker.js
 */

const assert = require('assert');

// ── Стаб БД до загрузки модулей, использующих pg-pool ─────────────────
const dbState = {
  projects: new Map(),     // id -> {…}
  keywords: new Map(),     // id -> {…, project_id}
  runs: new Map(),         // id -> {…}
  results: [],             // {run_id, keyword_id, engine, …}
  lastRunId: 0,
};

function _uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const dbStub = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    // SELECT project
    if (/FROM position_projects WHERE id =/.test(s)) {
      const p = dbState.projects.get(params[0]);
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
    }
    // SELECT active keywords
    if (/FROM position_keywords WHERE project_id = \$1 AND is_active = TRUE/.test(s)) {
      const arr = [...dbState.keywords.values()]
        .filter((k) => k.project_id === params[0] && k.is_active);
      return { rows: arr.map((k) => ({ id: k.id, query: k.query, target_url: k.target_url })) };
    }
    // INSERT run
    if (/INSERT INTO position_runs/.test(s)) {
      const id = _uid('run');
      const run = {
        id, project_id: params[0], engine: params[1],
        status: 'queued', keywords_total: params[2],
        keywords_done: 0, started_at: new Date(),
      };
      dbState.runs.set(id, run);
      return { rows: [run], rowCount: 1 };
    }
    // mark processing
    if (/UPDATE position_runs SET status = 'processing'/.test(s)) {
      const r = dbState.runs.get(params[0]); if (r) r.status = 'processing';
      return { rowCount: 1 };
    }
    // bump done
    if (/UPDATE position_runs SET keywords_done = keywords_done \+ 1/.test(s)) {
      const r = dbState.runs.get(params[0]); if (r) r.keywords_done += 1;
      return { rowCount: 1 };
    }
    // finish run
    if (/UPDATE position_runs SET status = \$2, error = \$3, finished_at = NOW\(\)/.test(s)) {
      const r = dbState.runs.get(params[0]);
      if (r) { r.status = params[1]; r.error = params[2]; r.finished_at = new Date(); }
      return { rowCount: 1 };
    }
    // insert result
    if (/INSERT INTO position_results/.test(s)) {
      const [run_id, project_id, keyword_id, engine, position, found_url, serp_snippet] = params;
      // unique on (run_id, keyword_id, engine) — emulate ON CONFLICT DO NOTHING
      if (!dbState.results.find((r) => r.run_id === run_id && r.keyword_id === keyword_id && r.engine === engine)) {
        dbState.results.push({ run_id, project_id, keyword_id, engine, position, found_url, serp_snippet });
      }
      return { rowCount: 1 };
    }
    // last_run_at update
    if (/UPDATE position_projects SET last_run_at = NOW\(\)/.test(s)) {
      const p = dbState.projects.get(params[0]);
      if (p) p.last_run_at = new Date();
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

// Подменяем модуль БД ДО require'а тестируемых модулей.
require.cache[require.resolve('../src/config/db')] = { exports: dbStub };

const analytics = require('../src/services/positionTracker/analytics');
const xmlstock  = require('../src/services/positionTracker/xmlstockSerp');
const { runPositionRun } = require('../src/services/positionTracker/runner');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`✔ ${name}`); },
    (err) => { console.error(`✖ ${name}\n  ${err.message}`); process.exitCode = 1; },
  );
}

(async () => {
  // ── classifyDelta ──────────────────────────────────────────────────
  await test('classifyDelta: rise (15→7) → up', () => {
    assert.strictEqual(analytics.classifyDelta(15, 7), 'up');
  });
  await test('classifyDelta: drop (3→12) → down', () => {
    assert.strictEqual(analytics.classifyDelta(3, 12), 'down');
  });
  await test('classifyDelta: equal → flat', () => {
    assert.strictEqual(analytics.classifyDelta(8, 8), 'flat');
  });
  await test('classifyDelta: NULL→pos → up', () => {
    assert.strictEqual(analytics.classifyDelta(null, 25), 'up');
  });
  await test('classifyDelta: pos→NULL → down', () => {
    assert.strictEqual(analytics.classifyDelta(15, null), 'down');
  });
  await test('classifyDelta: NULL→NULL → flat', () => {
    assert.strictEqual(analytics.classifyDelta(null, null), 'flat');
  });
  await test('classifyDelta: threshold=2 → small move = flat', () => {
    assert.strictEqual(analytics.classifyDelta(10, 11, 2), 'flat');
    assert.strictEqual(analytics.classifyDelta(10, 13, 2), 'down');
  });

  // ── deltaPosition ──────────────────────────────────────────────────
  await test('deltaPosition: 15→7 = -8', () => {
    assert.strictEqual(analytics.deltaPosition(15, 7), -8);
  });
  await test('deltaPosition: NULL→25 = -100', () => {
    assert.strictEqual(analytics.deltaPosition(null, 25), -100);
  });
  await test('deltaPosition: 5→NULL = +100', () => {
    assert.strictEqual(analytics.deltaPosition(5, null), 100);
  });
  await test('deltaPosition: NULL→NULL = null', () => {
    assert.strictEqual(analytics.deltaPosition(null, null), null);
  });

  // ── summarizeRows ──────────────────────────────────────────────────
  await test('summarizeRows: counts top3/top10/top30 + up/down/flat', () => {
    const pairs = [
      { keyword_id: 'a', prev: { position: 12 }, curr: { position: 5 } },   // up, top10
      { keyword_id: 'b', prev: { position: 3 },  curr: { position: 22 } },  // down, top30
      { keyword_id: 'c', prev: { position: 8 },  curr: { position: 8 } },   // flat, top10
      { keyword_id: 'd', prev: { position: null }, curr: { position: 2 } }, // up, top3
      { keyword_id: 'e', prev: { position: 50 }, curr: { position: null } },// down, none
    ];
    const s = analytics.summarizeRows(pairs);
    assert.strictEqual(s.keywords_total, 5);
    assert.strictEqual(s.up, 2);
    assert.strictEqual(s.down, 2);
    assert.strictEqual(s.flat, 1);
    assert.strictEqual(s.top3, 1);
    assert.strictEqual(s.top10, 3);
    assert.strictEqual(s.top30, 4);
    assert.strictEqual(s.keywords_in_top, 4);
    assert.ok(s.avg_position > 0);
  });

  // ── pickMovers ─────────────────────────────────────────────────────
  await test('pickMovers up returns biggest gains, sorted', () => {
    const pairs = [
      { keyword_id: 'a', query: 'A', prev: { position: 20 }, curr: { position: 5 } },  // -15
      { keyword_id: 'b', query: 'B', prev: { position: 30 }, curr: { position: 28 } }, // -2
      { keyword_id: 'c', query: 'C', prev: { position: 5 },  curr: { position: 12 } }, // +7 (down)
    ];
    const ups = analytics.pickMovers(pairs, 'up', 5);
    assert.strictEqual(ups.length, 2);
    assert.strictEqual(ups[0].keyword_id, 'a');
    assert.strictEqual(ups[1].keyword_id, 'b');
  });
  await test('pickMovers down returns biggest losses', () => {
    const pairs = [
      { keyword_id: 'a', query: 'A', prev: { position: 5 },  curr: { position: 25 } },
      { keyword_id: 'b', query: 'B', prev: { position: 10 }, curr: { position: 12 } },
      { keyword_id: 'c', query: 'C', prev: { position: null }, curr: { position: 2 } },
    ];
    const downs = analytics.pickMovers(pairs, 'down', 5);
    assert.strictEqual(downs.length, 2);
    assert.strictEqual(downs[0].keyword_id, 'a');
  });

  // ── groupSeries ────────────────────────────────────────────────────
  await test('groupSeries aggregates avg/best/worst per bucket', () => {
    const rows = [
      { keyword_id: 'k1', bucket: '2026-W01', position: 5 },
      { keyword_id: 'k1', bucket: '2026-W01', position: 9 },
      { keyword_id: 'k1', bucket: '2026-W02', position: 3 },
      { keyword_id: 'k1', bucket: '2026-W02', position: null },
    ];
    const out = analytics.groupSeries(rows);
    const k1 = out.get('k1');
    assert.strictEqual(k1.get('2026-W01').avg, 7);
    assert.strictEqual(k1.get('2026-W01').best, 5);
    assert.strictEqual(k1.get('2026-W01').worst, 9);
    // NULL agregating with effectivePosition=101: avg = (3+101)/2 = 52
    assert.strictEqual(k1.get('2026-W02').avg, 52);
    assert.strictEqual(k1.get('2026-W02').best, 3);
    assert.strictEqual(k1.get('2026-W02').hasReal, true);
  });

  // ── xmlstockSerp host matching ─────────────────────────────────────
  await test('normalizeHost strips proto, www, path, port', () => {
    assert.strictEqual(xmlstock.normalizeHost('https://www.example.com:8080/path?q=1'), 'example.com');
    assert.strictEqual(xmlstock.normalizeHost('Example.COM/'), 'example.com');
    assert.strictEqual(xmlstock.normalizeHost(''), '');
  });
  await test('hostMatches matches subdomain', () => {
    assert.strictEqual(xmlstock.hostMatches('shop.example.com', 'example.com'), true);
    assert.strictEqual(xmlstock.hostMatches('example.com', 'example.com'), true);
    assert.strictEqual(xmlstock.hostMatches('badexample.com', 'example.com'), false);
    assert.strictEqual(xmlstock.hostMatches('', 'example.com'), false);
  });
  await test('_findPosition returns first match', () => {
    const docs = [
      { url: 'https://other.com/a', title: '', snippet: '' },
      { url: 'https://shop.example.com/page', title: 'T', snippet: 'S' },
      { url: 'https://example.com/foo', title: '', snippet: '' },
    ];
    const r = xmlstock._findPosition(docs, 'example.com');
    assert.strictEqual(r.position, 2);
    assert.strictEqual(r.foundUrl, 'https://shop.example.com/page');
    assert.strictEqual(r.snippet, 'S');
  });
  await test('_findPosition returns null when not found', () => {
    const r = xmlstock._findPosition([{ url: 'https://other.com' }], 'example.com');
    assert.strictEqual(r.position, null);
    assert.strictEqual(r.foundUrl, null);
  });

  // ── runner end-to-end with mocked checkFn ──────────────────────────
  await test('runPositionRun creates run + writes results + bumps progress', async () => {
    const projectId = _uid('prj');
    dbState.projects.set(projectId, {
      id: projectId, user_id: 'u1', name: 'Test', domain: 'example.com',
      engine: 'yandex', geo_lr: '213', geo_loc: '', device: 'desktop',
    });
    const k1 = _uid('kw'); const k2 = _uid('kw'); const k3 = _uid('kw');
    dbState.keywords.set(k1, { id: k1, project_id: projectId, query: 'купить телефон', is_active: true, target_url: null });
    dbState.keywords.set(k2, { id: k2, project_id: projectId, query: 'смартфон', is_active: true, target_url: null });
    dbState.keywords.set(k3, { id: k3, project_id: projectId, query: 'неактивный', is_active: false, target_url: null });

    const calls = [];
    const checkFn = async (engine, project, kw) => {
      calls.push({ engine, q: kw.query });
      if (kw.query === 'купить телефон') return { position: 5,  foundUrl: 'https://example.com/phones', snippet: 's', checked: 100 };
      if (kw.query === 'смартфон')      return { position: 27, foundUrl: 'https://example.com/p', snippet: 's', checked: 100 };
      return { position: null, foundUrl: null, snippet: null, checked: 100 };
    };

    const summary = await runPositionRun(projectId, { checkFn, concurrency: 2 });
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].engine, 'yandex');
    assert.strictEqual(summary[0].ok, 2);
    assert.strictEqual(summary[0].error, 0);
    assert.strictEqual(calls.length, 2, 'inactive keyword must be skipped');

    const run = dbState.runs.get(summary[0].run_id);
    assert.strictEqual(run.status, 'done');
    assert.strictEqual(run.keywords_done, 2);
    assert.strictEqual(run.keywords_total, 2);

    const myResults = dbState.results.filter((r) => r.run_id === run.id);
    assert.strictEqual(myResults.length, 2);
    const k1res = myResults.find((r) => r.keyword_id === k1);
    assert.strictEqual(k1res.position, 5);
    assert.strictEqual(k1res.found_url, 'https://example.com/phones');
  });

  await test('runPositionRun engine="both" creates 2 runs', async () => {
    const projectId = _uid('prj');
    dbState.projects.set(projectId, {
      id: projectId, user_id: 'u1', name: 'X', domain: 'site.ru',
      engine: 'both', geo_lr: '', geo_loc: '', device: 'desktop',
    });
    const k = _uid('kw');
    dbState.keywords.set(k, { id: k, project_id: projectId, query: 'q', is_active: true, target_url: null });
    const summary = await runPositionRun(projectId, {
      checkFn: async (engine) => ({ position: engine === 'yandex' ? 3 : 12, foundUrl: 'u', snippet: '', checked: 10 }),
    });
    assert.strictEqual(summary.length, 2);
    assert.deepStrictEqual(summary.map((s) => s.engine).sort(), ['google', 'yandex']);
  });

  await test('runPositionRun handles per-keyword check errors gracefully', async () => {
    const projectId = _uid('prj');
    dbState.projects.set(projectId, {
      id: projectId, user_id: 'u1', name: 'X', domain: 'site.ru',
      engine: 'yandex', geo_lr: '', geo_loc: '', device: 'desktop',
    });
    const ok = _uid('kw'); const bad = _uid('kw');
    dbState.keywords.set(ok,  { id: ok,  project_id: projectId, query: 'ok',  is_active: true, target_url: null });
    dbState.keywords.set(bad, { id: bad, project_id: projectId, query: 'bad', is_active: true, target_url: null });
    const summary = await runPositionRun(projectId, {
      checkFn: async (_e, _p, kw) => {
        if (kw.query === 'bad') throw new Error('XMLStock quota');
        return { position: 4, foundUrl: 'u', snippet: '', checked: 10 };
      },
    });
    assert.strictEqual(summary[0].ok, 1);
    assert.strictEqual(summary[0].error, 1);
    const run = dbState.runs.get(summary[0].run_id);
    assert.strictEqual(run.status, 'done', 'run must finish even with per-keyword errors');
    assert.strictEqual(run.keywords_done, 2);
  });

  console.log(`\n${passed} tests passed.`);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
