'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { importLinksXlsx, importLinksCsv } = require('../src/services/projects/linkStrategy/linksImporter');
const { auditLinks } = require('../src/services/projects/linkStrategy/linkAuditor');

async function buildWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Служебный лист').addRow(['не таблица ссылок']);
  const sheet = workbook.addWorksheet('Таблица');
  sheet.addRow(['Страница назначения', 'Входящие ссылки', 'Сайты со ссылками на ресурс']);
  sheet.addRow(['https://nvsk.net/', 187, 96]);
  sheet.addRow(['https://nvsk.net/vodonagrevateli/', '18', '11']);
  sheet.addRow(['https://nvsk.net/empty/', 0, 0]);
  return workbook.xlsx.writeBuffer();
}

async function buildTopLinkingSitesWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Таблица').addRows([
    ['Сайт', 'Страницы со ссылками на ресурс', 'Страницы назначения'],
    ['naumen.ru', 12834, 7],
    ['great-experience-good24.com', 14, 2],
  ]);
  return workbook.xlsx.writeBuffer();
}

async function main() {
  const buffer = await buildWorkbook();
  const parsed = await importLinksXlsx(buffer);
  assert.strictEqual(parsed.format, 'xlsx');
  assert.strictEqual(parsed.sheet, 'Таблица');
  assert.strictEqual(parsed.type, 'pages');
  assert.strictEqual(parsed.count, 3);
  assert.deepStrictEqual(parsed.rows[0], {
    target_page: 'https://nvsk.net/', links: 187, referring_sites: 96,
  });
  assert.deepStrictEqual(parsed.rows[1], {
    target_page: 'https://nvsk.net/vodonagrevateli/', links: 18, referring_sites: 11,
  });
  assert.strictEqual(parsed.rows[2].links, 0);
  assert.strictEqual(parsed.rows[2].referring_sites, 0);

  const sites = await importLinksXlsx(await buildTopLinkingSitesWorkbook());
  assert.strictEqual(sites.format, 'xlsx');
  assert.strictEqual(sites.sheet, 'Таблица');
  assert.strictEqual(sites.type, 'sites');
  assert.strictEqual(sites.count, 2);
  assert.deepStrictEqual(sites.rows[0], { donor: 'naumen.ru', links: 12834, target_pages: 7 });
  assert.deepStrictEqual(sites.rows[1], { donor: 'great-experience-good24.com', links: 14, target_pages: 2 });

  const csv = importLinksCsv('Страница назначения,Входящие ссылки,Сайты со ссылками на ресурс\nhttps://x.ru/,4,2\n');
  assert.strictEqual(csv.type, 'pages');
  assert.deepStrictEqual(csv.rows[0], { target_page: 'https://x.ru/', links: 4, referring_sites: 2 });

  const audit = auditLinks({
    project: { name: 'Example', url: 'https://nvsk.net/', gsc_site_url: 'https://nvsk.net/' },
    links: { pages: parsed.rows, anchors: [], sites: sites.rows },
    topPages: [
      { key: 'https://nvsk.net/', clicks: 10, impressions: 100 },
      { key: 'https://nvsk.net/empty/', clicks: 8, impressions: 80 },
    ],
  });
  assert.deepStrictEqual(audit.target_page_totals, {
    target_pages: 3, incoming_links: 205, referring_sites: 107,
  });
  assert.strictEqual(audit.linked_count, 2);
  assert.ok(audit.orphans.some((row) => row.url === 'https://nvsk.net/empty/'));
  assert.deepStrictEqual(audit.donor_totals, {
    donors: 2, incoming_link_pages: 12848, target_pages: 9,
  });
  assert.strictEqual(audit.donors[0].target_pages, 7);
  assert.ok(audit.donors[0].coverage_score > 0);

  const repoPath = path.join(__dirname, '../src/services/projects/linkStrategy/linksRepo.js');
  const repoSource = fs.readFileSync(repoPath, 'utf8');
  assert.match(repoSource, /referring_sites/);
  assert.match(repoSource, /target_pages/);

  console.log('gsc xlsx import regression: 18/18 passed');
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
