#!/usr/bin/env node
/**
 * Source-level regression for the project task deep-link.
 * The project task list must open InfoArticlePage through ?open=<id> because
 * the router exposes /info-article, while InfoArticlePage loads the detail
 * from route.query.open.
 */

const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../../frontend/src/views/ProjectDetailPage.vue');
const source = fs.readFileSync(file, 'utf8');

if (!source.includes("if (t.type === 'info_article')")) {
  throw new Error('info_article deep-link branch is missing');
}
if (!source.includes("return { path: '/info-article', query: { open: String(t.id) } }")) {
  throw new Error('blog task must use /info-article?open=<id>');
}
if (source.includes("return '/info-article/' + t.id")) {
  throw new Error('legacy /info-article/:id link must not be restored');
}

console.log('blog task link contract: OK');
