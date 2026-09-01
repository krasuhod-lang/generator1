'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const dictionary = fs.readFileSync(path.join(root, 'frontend/src/data/yandexRegionsRu.js'), 'utf8');
const relevance = fs.readFileSync(path.join(root, 'frontend/src/views/RelevancePage.vue'), 'utf8');
const crawler = fs.readFileSync(path.join(root, 'frontend/src/views/SiteCrawlerPage.vue'), 'utf8');

const entries = [...dictionary.matchAll(/\{ code: '([^']+)', name: '([^']*)', group: '([^']+)', level: '([^']+)', parentCode:/g)];
const codes = entries.map(([, code]) => code);
const cities = entries.filter(([, , , , level]) => level === 'city');
const regions = entries.filter(([, , , , level]) => level === 'region');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(entries.length >= 1300, `expected >=1300 Russia LR entries, got ${entries.length}`);
assert(cities.length >= 1100, `expected >=1100 Russian city entries, got ${cities.length}`);
assert(regions.length >= 80, `expected >=80 Russian region entries, got ${regions.length}`);
assert(new Set(codes).size === codes.length, 'LR codes must be unique');
assert(dictionary.includes("export const YANDEX_REGIONS_RU = YANDEX_REGIONS;"), 'compatibility export missing');
assert(dictionary.includes('export function searchRegions('), 'searchRegions helper missing');
assert(relevance.includes("import { YANDEX_REGIONS, findRegionByCode, regionParentLabel }"), 'RelevancePage must use full dictionary');
assert(!relevance.includes('YANDEX_REGIONS.slice(0, 200)'), 'RelevancePage must not cap the full dictionary at 200');
assert(!crawler.includes('YANDEX_REGIONS.slice(0, 200)'), 'SiteCrawlerPage must not cap the shared dictionary at 200');
assert(relevance.includes("r.level === 'city' && regionParentLabel(r)"), 'city parent region label missing in relevance selector');

console.log(`Russian LR selector contract passed: ${entries.length} entries, ${cities.length} cities, ${regions.length} regions`);
