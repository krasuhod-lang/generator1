'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const stage3 = fs.readFileSync(path.join(root, 'backend/src/services/pipeline/stage3.js'), 'utf8');
const stage4 = fs.readFileSync(path.join(root, 'backend/src/services/pipeline/stage4.js'), 'utf8');
const resultPage = fs.readFileSync(path.join(root, 'frontend/src/views/ResultPage.vue'), 'utf8');
const monitorPage = fs.readFileSync(path.join(root, 'frontend/src/views/MonitorPage.vue'), 'utf8');
const orchestrator = fs.readFileSync(path.join(root, 'backend/src/services/pipeline/orchestrator.js'), 'utf8');

assert.match(stage3, /coverage_source: 'faq_fallback'/);
assert.match(stage3, /coverage_source: 'recovery_fallback'/);
assert.match(stage3, /coverage_source: 'placeholder_fallback'/);
assert.doesNotMatch(stage3, /coverage_percentage: 50/);
assert.match(stage4, /const \{ calculateCoverage \} = require\('\.\.\/\.\.\/utils\/calculateCoverage'\);/);
assert.match(stage4, /const lsiCovPct = deterministicCoverage\?\.percent \?\? null;/);
assert.match(stage4, /audit LSI .*детерминированными/);
assert.match(stage4, /lsiCovPct:\s+deterministicCoverage\?\.percent \?\? null/);
assert.match(orchestrator, /const lsiMust = block\.lsi_must \|\| \[\];/);
assert.match(orchestrator, /const needsLsiRefinement = lsiCovPct != null && lsiCovPct < LSI_COVERAGE_TARGET;/);
assert.match(orchestrator, /if \(lsiMust\.length === 0\)/);
assert.match(orchestrator, /обязательные LSI отсутствуют — Stage 6 не применяется/);
assert.match(orchestrator, /lsiCoverageAfter = s6\.lsiCoverage;/);
assert.match(orchestrator, /const pqLabel = pqScore == null \? 'PQ n\/a'/);
assert.match(resultPage, /function coverageLabel\(value\)/);
assert.match(resultPage, /coverageLabel\(block\.lsi_coverage\)/);
assert.match(monitorPage, /lsi: null, pq: null/);
assert.match(monitorPage, /msg\.lsiCoverage \?\? null/);
assert.match(monitorPage, /coverageLabel\(b\.lsi\)/);

console.log('block metric contract: 19/19 checks passed');
