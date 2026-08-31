#!/usr/bin/env node
/**
 * Source-level regression for authenticated article list/detail responses.
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

  const listStart = source.indexOf('async function list');
  const listEnd = source.indexOf('\n// ─── POST', listStart);
  const list = listStart >= 0 && listEnd >= 0
    ? source.slice(listStart, listEnd)
    : source;

  for (const [name, block] of [['list', list], ['detail', detail]]) {
    if (!block.includes("'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'")) {
      throw new Error(`${controller.name} ${name}: endpoint must disable cache revalidation`);
    }
    for (const header of ["delete req.headers['if-none-match']", "delete req.headers['if-modified-since']"]) {
      if (!block.includes(header)) {
        throw new Error(`${controller.name} ${name}: endpoint must clear ${header} before JSON response`);
      }
    }
  }

  if (!detail.includes("return res.status(200).json({ task:")) {
    throw new Error(`${controller.name} detail: endpoint must return an explicit 200 JSON response`);
  }
  if (!list.includes('return res.status(200).json({')) {
    throw new Error(`${controller.name} list: endpoint must return an explicit 200 JSON response`);
  }
}

console.log('article list/detail cache contract: OK');
