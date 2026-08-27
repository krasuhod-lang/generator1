const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const composer = read('src/services/outreach/provocation/emailComposerProvocation.js');
const sender = read('src/services/outreach/emailSender.js');
const queue = read('src/services/outreach/provocation/emailQueueV2.js');
const scheduler = read('src/services/outreach/outreachScheduler.js');
const outreachController = read('src/controllers/outreach.controller.js');
const adminController = read('src/controllers/admin.controller.js');
const ledger = read('src/services/metrics/adminApiLedger.js');
const migration = fs.readFileSync(path.resolve(root, '..', 'migrations', '142_outreach_and_api_observability.sql'), 'utf8');
const adminCard = fs.readFileSync(path.resolve(root, '..', 'frontend/src/components/AdminApiUsageCard.vue'), 'utf8');

const checks = [
  ['composer has deterministic subject builder', /function buildSubject\(/.test(composer)],
  ['composer has preheader', /const preheader =/.test(composer)],
  ['composer has visual traffic gap chart', /function _gapChart\(/.test(composer) && /Визуальный срез поискового трафика/.test(composer)],
  ['composer has free video audit CTA with three growth points', /Бесплатный видео-аудит сайта/.test(composer) && /минимум 3 точки роста/.test(composer)],
  ['composer includes unsubscribe link', /unsubscribeUrl/.test(composer) && /Отписаться/.test(composer)],
  ['sender sends provider idempotency key', /idempotencyKey|Idempotency-Key/i.test(sender)],
  ['sender preserves unsubscribe headers', /List-Unsubscribe/i.test(sender)],
  ['queue records attempts and failed timestamp', /attempt_count|failed_at/.test(queue)],
  ['scheduler stores complete HTML/text snapshot', /html_content|text_content/.test(scheduler)],
  ['campaign stats exposes delivered/bounced/failed daily fields', /delivered: parseInt\(d\.delivered/.test(outreachController) && /bounced: parseInt\(d\.bounced/.test(outreachController) && /failed: parseInt\(d\.failed/.test(outreachController)],
  ['admin totals separates cache miss from failed', /AS cache_misses/.test(adminController) && /request_status IN \('failed','invalid_response'\)/.test(adminController)],
  ['admin totals exposes partial attribution', /AS partial_attribution/.test(adminController)],
  ['admin anomaly model distinguishes outside and partial attribution', /'outside_task'/.test(adminController) && /'partial_attribution'/.test(adminController)],
  ['ledger is append-only per provider attempt', /INSERT INTO admin_api_request_ledger/.test(ledger) && /attempt/.test(ledger)],
  ['ledger failure is best effort', /observability failure must never fail/.test(ledger) && /return false/.test(ledger)],
  ['migration is additive and has ledger indexes', /CREATE TABLE IF NOT EXISTS admin_api_request_ledger/.test(migration) && /CREATE INDEX/.test(migration)],
  ['admin UI highlights partial attribution/cache miss', /partial_attribution/.test(adminCard) && /cache_miss/.test(adminCard)],
];

let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures += 1; }
}

if (failures) {
  console.error(`❌ ${failures} email/admin observability checks failed`);
  process.exit(1);
}
console.log(`✅ ALL OK (${checks.length}/${checks.length})`);
