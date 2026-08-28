'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const realtime = read('backend/src/services/llm/realtimeResearch.js');
const qwen = read('backend/src/services/llm/qwenAgent.adapter.js');
const blog = read('backend/src/services/infoArticle/infoArticlePipeline.js');
const link = read('backend/src/services/linkArticle/linkArticlePipeline.js');

assert.match(realtime, /runQwenResearchAgent/);
assert.match(realtime, /CONTENT_QWEN_RESEARCH_ENABLED\s*\|\|\s*'true'/);
assert.match(realtime, /source_url/);
assert.match(realtime, /speaker/);
assert.match(realtime, /qwenResearch\s*=\s*normalizeResearch/);
assert.match(realtime, /callResearchProvider/);
assert.match(realtime, /research_provider/);
assert.match(qwen, /pipeline\s*=\s*'seo'/);
assert.match(qwen, /stageName\s*=\s*'stage0'/);
assert.match(qwen, /callLabel\s*=\s*'Stage 0 Qwen Research Agent'/);

for (const [name, source, pipeline] of [
  ['blog', blog, 'info_article'],
  ['link article', link, 'link_article'],
]) {
  assert.match(source, /runRealtimeResearch\(\{/s, `${name} must use shared research helper`);
  assert.match(source, /targetUrl:/, `${name} must pass target URL to research`);
  assert.match(source, /taskId,/, `${name} must pass taskId to research`);
  assert.match(source, new RegExp(`pipeline:\\s*'${pipeline}'`), `${name} must preserve pipeline attribution`);
  assert.match(source, /Research Evidence \(\$\{realtimeResearch\.research_provider/, `${name} log must expose actual provider`);
}

console.log('blog/link Qwen research contract: 14/14 checks passed');
process.exit(0);
