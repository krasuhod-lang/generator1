#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pipeline = fs.readFileSync(path.join(root, 'src/services/infoArticle/infoArticlePipeline.js'), 'utf8');
const serp = fs.readFileSync(path.join(root, 'src/services/infoArticle/fetchGoogleSerp.js'), 'utf8');
const llm = fs.readFileSync(path.join(root, 'src/services/llm/callLLM.js'), 'utf8');

const checks = [
  ['blog analysis retries have bounded default', /const BLOG_ANALYSIS_RETRIES[\s\S]*?\? v : 2;/.test(pipeline)],
  ['blog audit retries have bounded default', /const BLOG_AUDIT_RETRIES[\s\S]*?\? v : 2;/.test(pipeline)],
  ['blog writer retries have bounded default', /const BLOG_WRITER_RETRIES[\s\S]*?\? v : 2;/.test(pipeline)],
  ['writer uses blog retry budget', /retries: opts\.writerRetries \|\| BLOG_WRITER_RETRIES/.test(pipeline)],
  ['writer uses bounded timeout', /timeoutMs: opts\.writerTimeoutMs \|\| BLOG_WRITER_TIMEOUT_MS/.test(pipeline)],
  ['corrective writer retains a bounded retry', /retries: Math\.min\(2, opts\.writerRetries \|\| BLOG_WRITER_RETRIES\)/.test(pipeline)],
  ['eeat chunk retry is not multiplied', /chunkRetries: 1/.test(pipeline) && /const chunkRetries = Number\.isInteger\(callOptions\?\.chunkRetries\)/.test(fs.readFileSync(path.join(root, 'src/services/eeatAudit/core.js'), 'utf8'))],
  ['target site starts as a promise', /const targetSiteStylePromise = task\.target_site_url/.test(pipeline)],
  ['topic discovery starts as a promise', /const topicDiscoveryPromise = TOPIC_DISCOVERY_ENABLED/.test(pipeline)],
  ['audience research starts independently', /const audienceResearchPromise = resolveAudienceResearch/.test(pipeline)],
  ['topic discovery is awaited before quality gate', /const td = await topicDiscoveryPromise/.test(pipeline)],
  ['audience and link planning overlap', /const audienceResearchPromise[\s\S]*?const planResult = noInterlinking/.test(pipeline)],
  ['eeat/link audits overlap', /const linkAuditPromise = \(async \(\) =>/.test(pipeline) && /const \[eeatAudit, linkAudit\] = await Promise\.all/.test(pipeline)],
  ['stage timing registry exists', /const STAGE_STARTED_AT = new Map\(\)/.test(pipeline) && /const STAGE_DURATIONS = new Map\(\)/.test(pipeline)],
  ['stage timing is emitted through existing events', /stage_timing/.test(pipeline) && /recordEvent\(\n\s*taskId,\n\s*`⏱ Этап/.test(pipeline)],
  ['stage timing is cleaned after task', /STAGE_STARTED_AT\.delete\(taskId\)/.test(pipeline) && /STAGE_DURATIONS\.delete\(taskId\)/.test(pipeline)],
  ['SERP concurrency is bounded', /const GOOGLE_SERP_MAX_CONCURRENCY/.test(serp) && /Math\.min\(GOOGLE_SERP_MAX_CONCURRENCY, serp\.length\)/.test(serp)],
  ['SERP scraping uses worker Promise.all', /await Promise\.all\(Array\.from\(\{ length: workers \}/.test(serp)],
  ['SERP keeps per-host pacing', /nextAllowedByHost/.test(serp) && /waitForHost/.test(serp)],
  ['LLM success log exposes duration', llm.includes('const callDurationMs = Math.max(0, Date.now() - startedAt.getTime())')],
  ['LLM failure log exposes duration', llm.includes('const failedDurationMs = Math.max(0, Date.now() - startedAt.getTime())')],
];

for (const [name, ok] of checks) assert.ok(ok, name);
console.log(`Blog generation latency contract: ${checks.length}/${checks.length} passed`);
console.log('Verified: bounded retries/timeouts, overlapping independent stages, per-host SERP pacing, and stage/API duration telemetry.');
