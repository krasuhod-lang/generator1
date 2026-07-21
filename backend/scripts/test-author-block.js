'use strict';

/**
 * test-author-block.js — юнит-тесты видимого блока «Об авторе» (Задача 2).
 * Запуск: node backend/scripts/test-author-block.js
 */

const assert = require('assert');
const { buildAuthorBlock } = require('../src/services/seo/authorBlock.service');
const { buildArticleJsonLd } = require('../src/services/seo/geoSchema');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

test('без имени автора → пустой блок (fail-open, BC)', () => {
  const r = buildAuthorBlock({ persona: {}, company: { company_name: 'ACME' } });
  assert.strictEqual(r.html, '');
  assert.deepStrictEqual(r.sameAs, []);
  assert.strictEqual(r.author, null);
});

test('строит видимый HTML с именем, ролью и bio', () => {
  const r = buildAuthorBlock({
    persona: { display_name: 'Анна Воронова', role: 'эксперт', bio_short: 'Практик ниши.' },
  });
  assert.ok(/<section class="author-bio"/.test(r.html));
  assert.ok(r.html.includes('Анна Воронова'));
  assert.ok(r.html.includes('эксперт'));
  assert.ok(r.html.includes('Практик ниши.'));
  assert.ok(/itemtype="https:\/\/schema.org\/Person"/.test(r.html));
});

test('привязка к сущности компании (worksFor + ссылка)', () => {
  const r = buildAuthorBlock({
    persona: { name: 'Иван' },
    company: { company_name: 'ACME', company_url: 'https://acme.example' },
  });
  assert.ok(/itemprop="worksFor"/.test(r.html));
  assert.ok(r.html.includes('ACME'));
  assert.ok(r.html.includes('href="https://acme.example"'));
  assert.ok(r.sameAs.includes('https://acme.example'));
});

test('sameAs: соцпрофили + сайт, дедупликация', () => {
  const r = buildAuthorBlock({
    persona: { name: 'Иван' },
    company: {
      company_name: 'ACME',
      company_url: 'https://acme.example',
      social_links: ['https://t.me/acme', 'https://t.me/acme', 'https://vk.com/acme'],
    },
  });
  assert.deepStrictEqual(r.sameAs, ['https://t.me/acme', 'https://vk.com/acme', 'https://acme.example']);
  assert.ok(r.html.includes('Telegram'));
  assert.ok(r.html.includes('VK'));
});

test('XSS: имя и bio экранируются', () => {
  const r = buildAuthorBlock({
    persona: { name: '<script>alert(1)</script>', role: 'a"b', bio_short: '<img src=x onerror=y>' },
  });
  assert.ok(!r.html.includes('<script>'));
  assert.ok(!r.html.includes('<img'));
  assert.ok(r.html.includes('&lt;script&gt;'));
});

test('невалидный URL соцпрофиля отбрасывается', () => {
  const r = buildAuthorBlock({
    persona: { name: 'Иван' },
    company: { company_name: 'ACME', social_links: ['javascript:alert(1)', 'ftp://x', 'https://ok.example'] },
  });
  assert.deepStrictEqual(r.sameAs, ['https://ok.example']);
});

test('author-выход пригоден для buildArticleJsonLd + sameAs', () => {
  const r = buildAuthorBlock({
    persona: { name: 'Иван', role: 'эксперт' },
    company: { company_name: 'ACME', company_url: 'https://acme.example', social_links: ['https://t.me/acme'] },
  });
  const jsonld = buildArticleJsonLd({
    headline: 'Заголовок',
    author: { name: r.author.name, jobTitle: r.author.jobTitle, sameAs: r.sameAs },
  });
  assert.strictEqual(jsonld.author['@type'], 'Person');
  assert.strictEqual(jsonld.author.name, 'Иван');
  assert.ok(Array.isArray(jsonld.author.sameAs));
  assert.ok(jsonld.author.sameAs.includes('https://t.me/acme'));
});

test('brand_name/target_site_url как fallback company-полей', () => {
  const r = buildAuthorBlock({
    persona: { name: 'Иван' },
    company: { brand_name: 'BrandX', target_site_url: 'https://brandx.example' },
  });
  assert.ok(r.html.includes('BrandX'));
  assert.ok(r.sameAs.includes('https://brandx.example'));
});

test('дата обновления рендерится', () => {
  const r = buildAuthorBlock({ persona: { name: 'Иван' }, dateModified: '2026-07-21' });
  assert.ok(r.html.includes('Обновлено: 2026-07-21'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
