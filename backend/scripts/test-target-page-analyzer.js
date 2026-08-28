'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildTargetPageCandidates,
  scrapeTargetPageWithFallback,
} = require('../src/services/parser/targetPageAnalyzer');

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/services/parser/targetPageAnalyzer.js'),
  'utf8',
);
const orchestrator = fs.readFileSync(
  path.resolve(__dirname, '../src/services/pipeline/orchestrator.js'),
  'utf8',
);

const candidates = buildTargetPageCandidates('https://napitki-store.ru/');
assert.strictEqual(candidates.length, 3);
assert.strictEqual(new Set(candidates).size, 3);
assert.ok(candidates.includes('https://napitki-store.ru/'));
assert.ok(candidates.includes('http://napitki-store.ru/'));
assert.ok(candidates.includes('https://www.napitki-store.ru/'));
assert.deepStrictEqual(buildTargetPageCandidates('not-a-url'), []);
assert.match(source, /TARGET_PAGE_MAX_CANDIDATES\s*=\s*3/);
assert.match(source, /pageData\s*=\s*await scrapeTargetPageWithFallback/);
assert.match(source, /scrapeTargetPageWithFallback/);
assert.match(source, /fallback \$\{i \+ 1\}\/\$\{candidates\.length\}/);
assert.match(orchestrator, /Target Page Analysis ошибка: \$\{e\.message\} — продолжаем без анализа/);
assert.strictEqual(typeof scrapeTargetPageWithFallback, 'function');

console.log('target page analyzer fallback: 11/11 checks passed');
