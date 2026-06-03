#!/usr/bin/env node
'use strict';

/**
 * Smoke-tests for aegis/algoWatcher (B5) и aegis/serpOutcomeTracker (B1).
 * Покрытие — pure functions: parseFeed, classify, computeReward.
 * Сетевые вызовы и БД не требуются.
 */

const assert = require('assert');

const aw = require('../src/services/aegis/algoWatcher');
const t  = require('../src/services/aegis/serpOutcomeTracker');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); passed++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); failed++; }
}

// ── parseFeed ─────────────────────────────────────────────────────────
test('parseFeed: RSS 2.0 channel/item', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>March 2024 core update</title><link>https://x/y</link>
    <description>core ranking system</description>
    <pubDate>Wed, 15 Mar 2024 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = aw.parseFeed(xml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'March 2024 core update');
  assert.strictEqual(items[0].url,   'https://x/y');
  assert.ok(items[0].published_at.startsWith('2024-03-15'));
});

test('parseFeed: Atom entry with link href', () => {
  const xml = `<feed><entry>
    <title>Spam update</title>
    <link href="https://x/spam" rel="alternate"/>
    <summary>spam update guidance</summary>
    <updated>2025-01-01T00:00:00Z</updated>
  </entry></feed>`;
  const items = aw.parseFeed(xml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].url, 'https://x/spam');
});

test('parseFeed: CDATA stripping + entity decoding', () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[E-E-A-T &amp; ranking]]></title>
    <link>https://x/eeat</link>
    <description><![CDATA[<p>hello & world</p>]]></description>
  </item></channel></rss>`;
  const [it] = aw.parseFeed(xml);
  assert.strictEqual(it.title, 'E-E-A-T & ranking');
  assert.ok(!/<p>/.test(it.summary), 'HTML stripped');
});

test('parseFeed: empty / garbage → []', () => {
  assert.deepStrictEqual(aw.parseFeed(''), []);
  assert.deepStrictEqual(aw.parseFeed('not xml at all'), []);
  assert.deepStrictEqual(aw.parseFeed(null), []);
});

// ── classify ──────────────────────────────────────────────────────────
test('classify: core_update sets severity ≥ 0.8', () => {
  const r = aw.classify('March 2024 Core Update finished', 'core ranking system change');
  assert.ok(r.tags.includes('core_update'));
  assert.ok(r.severity >= 0.8, `severity ${r.severity}`);
});

test('classify: helpful_content sets ≥ 0.6', () => {
  const r = aw.classify('Helpful content system update', '');
  assert.ok(r.tags.includes('helpful_content'));
  assert.ok(r.severity >= 0.6);
});

test('classify: no match → empty tags low severity', () => {
  const r = aw.classify('Random product news', 'nothing relevant here');
  assert.deepStrictEqual(r.tags, []);
  assert.ok(r.severity <= 0.2);
});

test('classify: multi-tag (core + eeat)', () => {
  const r = aw.classify('Core update affects E-E-A-T signals', 'experience expertise core ranking');
  assert.ok(r.tags.includes('core_update'));
  assert.ok(r.tags.includes('eeat'));
});

// ── computeReward ─────────────────────────────────────────────────────
test('computeReward: pos=1 → high reward', () => {
  const r = t.computeReward({ avgPosition: 1, inTop3: 1, inTop10: 1, deltaClicks: 100 });
  assert.ok(r > 0.9, `reward ${r}`);
});

test('computeReward: pos=50, no top, no clicks → low', () => {
  const r = t.computeReward({ avgPosition: 50, inTop3: 0, inTop10: 0, deltaClicks: 0 });
  assert.ok(r < 0.1, `reward ${r}`);
});

test('computeReward: monotonicity (pos=1 > pos=10 > pos=30)', () => {
  const a = t.computeReward({ avgPosition: 1,  inTop3: 1, inTop10: 1, deltaClicks: 10 });
  const b = t.computeReward({ avgPosition: 10, inTop3: 0, inTop10: 1, deltaClicks: 10 });
  const c = t.computeReward({ avgPosition: 30, inTop3: 0, inTop10: 0, deltaClicks: 10 });
  assert.ok(a > b && b > c, `not monotonic: ${a} ${b} ${c}`);
});

test('computeReward: clamped to [0, 1]', () => {
  const r1 = t.computeReward({ avgPosition: -5, inTop3: 99, inTop10: 99, deltaClicks: 1e6 });
  const r2 = t.computeReward({ avgPosition: 999, inTop3: -1, inTop10: -1, deltaClicks: -1e6 });
  assert.ok(r1 >= 0 && r1 <= 1);
  assert.ok(r2 >= 0 && r2 <= 1);
});

test('computeReward: missing metrics → finite', () => {
  const r = t.computeReward({});
  assert.ok(Number.isFinite(r));
  assert.ok(r >= 0 && r <= 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
