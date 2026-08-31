'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../src/services/linkArticle/linkArticlePipeline.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('const finalWrite = await db.query(');
const end = source.indexOf("if (finalWrite.rowCount !== 1)", start);
assert.ok(start >= 0 && end > start, 'link finalWrite block must exist');
const block = source.slice(start, end);

assert.match(block, /WHERE id = \$1 AND execution_token = \$9::uuid/);
assert.doesNotMatch(block, /execution_token = \$10::uuid/);
assert.match(block, /\[\s*\n\s*taskId, finalHtml, finalPlain,/);
assert.match(block, /linkMetaTags \? JSON\.stringify\(linkMetaTags\) : null,\s*\n\s*executionToken,/);

const placeholders = [...block.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
const maxPlaceholder = Math.max(...placeholders);
assert.strictEqual(maxPlaceholder, 9, 'final link UPDATE must use exactly nine placeholders');

console.log('link article final-write contract: all assertions passed');
