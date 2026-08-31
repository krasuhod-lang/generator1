#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../../frontend/src/views/InfoArticlePage.vue');
const source = fs.readFileSync(file, 'utf8');

assert.match(source, /const ARTICLE_CONTENT_FIELDS = Object\.freeze\(\[/);
assert.match(source, /'article_html'/);
assert.match(source, /'article_html_with_schema'/);
assert.match(source, /article_plain/);
assert.match(source, /const articleSourceHtml = computed\(/);
assert.match(source, /const sanitizedHtml = computed\(/);
assert.match(source, /return plainTextToHtml\(plain\);/);
assert.match(source, /const hasResult = computed\(\(\) => Boolean\(articleSourceHtml\.value\.trim\(\) \|\| String\(selectedTask\.value\?\.article_plain \|\| ''\)\.trim\(\)\)\);/);
assert.match(source, /selectedTask\.status === 'done'/);
assert.match(source, /Обновить результат/);

console.log('test-blog-result-viewer-contract.js: all assertions passed');
