#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const controller = fs.readFileSync(path.join(root, 'backend/src/controllers/audit.controller.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations/145_professional_audit_fields.sql'), 'utf8');
const durable = fs.readFileSync(path.join(root, 'backend/src/services/tasks/durableSchema.js'), 'utf8');
const pageParser = fs.readFileSync(path.join(root, 'audit/app/page_parser.py'), 'utf8');
const crawler = fs.readFileSync(path.join(root, 'audit/app/crawler.py'), 'utf8');

for (const field of ['final_url', 'fetch_status', 'parse_status', 'fetch_attempts', 'content_type', 'x_robots_tag', 'title_count', 'canonical_count', 'has_viewport']) {
  assert(migration.includes(`ADD COLUMN IF NOT EXISTS ${field}`), `migration missing ${field}`);
  assert(durable.includes(`ADD COLUMN IF NOT EXISTS ${field}`), `durable schema missing ${field}`);
  assert(controller.includes(field), `controller missing ${field}`);
}
assert(controller.includes('headers: await _authHeaders()'), 'audit report must await internal auth headers');
for (const column of ['Код правила', 'Уверенность', 'Доказательство', 'Content-Type', 'Parse status']) {
  assert(controller.includes(column), `export missing ${column}`);
}
for (const signal of ['title_count', 'meta_description_count', 'canonical_count', 'html_lang', 'has_viewport']) {
  assert(pageParser.includes(signal), `parser missing ${signal}`);
}
for (const signal of ['parse_status', 'crawl_stats', 'content_type', 'fetch_attempts']) {
  assert(crawler.includes(signal), `crawler missing ${signal}`);
}
console.log('audit professional contract: OK');
