'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const pipelinePath = path.join(root, 'backend/src/services/infoArticle/infoArticlePipeline.js');
const source = fs.readFileSync(pipelinePath, 'utf8');

assert.match(
  source,
  /let\s+\[eeatAudit,\s*linkAudit\]\s*=\s*await\s+Promise\.all\(\[/,
  'blog audit tuple must be mutable because refine and link injection update linkAudit',
);
assert.doesNotMatch(
  source,
  /const\s+\[eeatAudit,\s*linkAudit\]\s*=\s*await\s+Promise\.all\(\[/,
  'blog audit tuple must not be const',
);
assert.match(source, /linkAudit\s*=\s*noInterlinking\s*\?/s, 'refine re-audit must update linkAudit');
assert.match(source, /linkAudit\s*=\s*\{\s*\.\.\.reauditDet/s, 'post-injection re-audit must update linkAudit');
assert.match(source, /stage3_writer_refine/, 'refine stage contract must remain present');

console.log('info article refine contract: 5/5 checks passed');
console.log('Root cause fixed: mutable audit state survives refine and deterministic link injection.');

process.exit(0);
