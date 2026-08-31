#!/usr/bin/env node
/**
 * Source-level regression for authenticated article detail responses.
 * User-owned mutable results must not be served as conditional 304 responses.
 */

const fs = require('fs');
const path = require('path');

const controllers = [
  { name: 'blog', file: 'infoArticle.controller.js' },
  { name: 'link', file: 'linkArticle.controller.js' },
];

for (const controller of controllers) {
  const file = path.resolve(__dirname, '../src/controllers', controller.file);
  const source = fs.readFileSync(file, 'utf8');
  const detailStart = source.indexOf('async function get');
  const detailEnd = source.indexOf('\n// ─── DELETE', detailStart);
  const detail = detailStart >= 0 && detailEnd >= 0
    ? source.slice(detailStart, detailEnd)
    : source;

  if (!detail.includes("'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'")) {
    throw new Error(`${controller.name}: detail endpoint must disable cache revalidation`);
  }
  if (!detail.includes('return res.status(200).json({ task:')) {
    throw new Error(`${controller.name}: detail endpoint must return an explicit 200 JSON response`);
  }
}

console.log('article detail cache contract: OK');
