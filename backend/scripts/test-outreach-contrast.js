const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const outreach = read('frontend/src/views/OutreachPage.vue');
const campaign = read('frontend/src/views/OutreachCampaignPage.vue');

assert.match(outreach, /\.outreach-root[\s\S]*?color:\s*#f5f5f7;/, 'main outreach root must use light text on dark shell');
assert.match(outreach, /\.page-header h1[\s\S]*?color:\s*#ffffff;/, 'main outreach heading must be white');
assert.match(outreach, /\.subtitle[\s\S]*?color:\s*#b4b4bd;/, 'main outreach subtitle must be readable');
assert.match(outreach, /\.cc-title h3[\s\S]*?color:\s*#1d1d1f;/, 'campaign card title must remain dark on white card');
assert.match(campaign, /\.oc-root[\s\S]*?color:\s*#f5f5f7;/, 'campaign root must use light text on dark shell');
assert.match(campaign, /\.oc-title h1[\s\S]*?color:\s*#ffffff;/, 'campaign heading must be white');
assert.match(campaign, /\.oc-tab\s*\{[\s\S]*?color:\s*#b4b4bd;/, 'campaign tabs must be readable');
assert.match(campaign, /\.card-h[\s\S]*?color:\s*#1d1d1f;/, 'card headings must remain dark on white card');

console.log('outreach contrast regression: 8/8 checks passed');
