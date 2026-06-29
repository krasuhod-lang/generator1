'use strict';

/**
 * Тесты для модуля siteCrawler (задача 3).
 *
 * Не требует Postgres/сети: проверяем чистые функции
 * (urlNormalizer, robotsClient parse/isAllowed, treeBuilder, csv/tsv,
 *  ssrfGuard.isPrivateAddress, crawler._parseHtml, _mergeOptions).
 *
 * Запуск: node backend/scripts/test-site-crawler.js
 */

const assert = require('assert');

const urlN   = require('../src/services/siteCrawler/urlNormalizer');
const robots = require('../src/services/siteCrawler/robotsClient');
const tree   = require('../src/services/siteCrawler/treeBuilder');
const csv    = require('../src/services/siteCrawler/exporters/csv');
const ssrf   = require('../src/services/siteCrawler/ssrfGuard');
const crawler = require('../src/services/siteCrawler/crawler');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

// ───── urlNormalizer ─────
group('urlNormalizer', () => {
  test('basic absolute https', () => {
    assert.strictEqual(urlN.normalize('https://Example.com/Path/'), 'https://example.com/Path');
  });
  test('strips trailing slash (except root)', () => {
    assert.strictEqual(urlN.normalize('https://a.com/'),  'https://a.com/');
    assert.strictEqual(urlN.normalize('https://a.com/x/'),'https://a.com/x');
  });
  test('strips utm/fbclid params and sorts the rest', () => {
    const r = urlN.normalize('https://a.com/x?b=2&utm_source=x&a=1&fbclid=z');
    assert.strictEqual(r, 'https://a.com/x?a=1&b=2');
  });
  test('strips #fragment', () => {
    assert.strictEqual(urlN.normalize('https://a.com/x#frag'), 'https://a.com/x');
  });
  test('resolves relative against base', () => {
    assert.strictEqual(urlN.normalize('./about', 'https://a.com/foo/bar'),
      'https://a.com/foo/about');
    assert.strictEqual(urlN.normalize('/x', 'https://a.com/foo'), 'https://a.com/x');
  });
  test('rejects mailto/tel/javascript/data', () => {
    assert.strictEqual(urlN.normalize('mailto:a@b'),       null);
    assert.strictEqual(urlN.normalize('tel:+7'),           null);
    assert.strictEqual(urlN.normalize('javascript:void(0)'), null);
    assert.strictEqual(urlN.normalize('data:text/html,x'), null);
  });
  test('rejects non-http(s) and garbage', () => {
    assert.strictEqual(urlN.normalize('ftp://a.com/x'), null);
    assert.strictEqual(urlN.normalize(''), null);
    assert.strictEqual(urlN.normalize('   '), null);
    assert.strictEqual(urlN.normalize(null), null);
  });
  test('default ports stripped', () => {
    assert.strictEqual(urlN.normalize('http://a.com:80/x'),  'http://a.com/x');
    assert.strictEqual(urlN.normalize('https://a.com:443/x'),'https://a.com/x');
  });
  test('collapse double slashes in pathname', () => {
    assert.strictEqual(urlN.normalize('https://a.com//foo///bar'), 'https://a.com/foo/bar');
  });
  test('isLikelyNonHtml — true for .pdf/.jpg, false for /', () => {
    assert.strictEqual(urlN.isLikelyNonHtml('https://a.com/doc.pdf'), true);
    assert.strictEqual(urlN.isLikelyNonHtml('https://a.com/i.JPG'),   true);
    assert.strictEqual(urlN.isLikelyNonHtml('https://a.com/'),        false);
    assert.strictEqual(urlN.isLikelyNonHtml('https://a.com/x'),       false);
  });
  test('hostMatches — subdomains controlled by flag', () => {
    assert.strictEqual(urlN.hostMatches('a.com', 'a.com', false), true);
    assert.strictEqual(urlN.hostMatches('blog.a.com', 'a.com', false), false);
    assert.strictEqual(urlN.hostMatches('blog.a.com', 'a.com', true),  true);
    assert.strictEqual(urlN.hostMatches('a.org',   'a.com', true),  false);
  });
});

// ───── robotsClient ─────
group('robotsClient', () => {
  test('parse picks groups by user-agent', () => {
    const p = robots._parseRobots(`
      User-agent: *
      Disallow: /priv

      User-agent: EgidaSiteCrawler
      Disallow: /admin
    `);
    assert.strictEqual(p.groups.length, 2);
    const g = robots._selectGroup(p, 'EgidaSiteCrawler/1.0');
    assert.strictEqual(g.rules[0].pattern, '/admin');
  });
  test('isAllowed: empty rules → true', () => {
    assert.strictEqual(robots.isAllowed('/x', { groups: [] }), true);
  });
  test('isAllowed: Disallow blocks; longer Allow overrides', () => {
    const p = robots._parseRobots(`
      User-agent: *
      Disallow: /admin
      Allow:    /admin/public
    `);
    assert.strictEqual(robots.isAllowed('/admin/secret', p), false);
    assert.strictEqual(robots.isAllowed('/admin/public/x', p), true);
    assert.strictEqual(robots.isAllowed('/other', p), true);
  });
  test('isAllowed: wildcard * and anchor $', () => {
    const p = robots._parseRobots(`
      User-agent: *
      Disallow: /*.pdf$
      Allow:    /
    `);
    assert.strictEqual(robots.isAllowed('/foo.pdf', p), false);
    assert.strictEqual(robots.isAllowed('/foo.pdfx', p), true);
  });
  test('isAllowed: empty Disallow ⇒ no rule, allowed', () => {
    const p = robots._parseRobots(`User-agent: *\nDisallow:`);
    assert.strictEqual(robots.isAllowed('/anything', p), true);
  });
});

// ───── treeBuilder ─────
group('treeBuilder', () => {
  test('builds tree with virtual intermediate nodes', () => {
    const pages = [
      { url: 'https://a.com/',                title: 'Home' },
      { url: 'https://a.com/catalog/x',       title: 'X', http_status: 200 },
      { url: 'https://a.com/catalog/y',       title: 'Y', http_status: 200 },
      { url: 'https://a.com/blog/2024/post1', title: 'P1' },
    ];
    const { tree: t, byUrl } = tree.buildTree(pages, 'https://a.com');
    assert.ok(t);
    assert.strictEqual(t.children.length, 2); // blog + catalog (sorted alphabetically)
    const blog = t.children.find((c) => c.segment === 'blog');
    assert.ok(blog.isVirtual, 'blog был лишь промежуточным узлом');
    assert.strictEqual(blog.children[0].segment, '2024');
    assert.strictEqual(blog.children[0].children[0].title, 'P1');
    assert.ok(byUrl['https://a.com/catalog/x']);
  });
  test('flatten dumps DFS with depth/parent_url', () => {
    const pages = [
      { url: 'https://a.com/',     title: 'H', http_status: 200 },
      { url: 'https://a.com/x',    title: 'X', http_status: 200 },
    ];
    const { tree: t } = tree.buildTree(pages, 'https://a.com');
    const rows = tree.flatten(t);
    assert.ok(rows.length >= 2);
    const x = rows.find((r) => r.url === 'https://a.com/x');
    assert.strictEqual(x.depth, 1);
    assert.strictEqual(x.parent_url, 'https://a.com/');
  });
  test('skips pages from other hosts', () => {
    const pages = [
      { url: 'https://a.com/x' }, { url: 'https://b.com/y' },
    ];
    const { tree: t } = tree.buildTree(pages, 'https://a.com');
    assert.strictEqual(t.children.length, 1);
    assert.strictEqual(t.children[0].segment, 'x');
  });
});

// ───── csv/tsv exporters ─────
group('exporters/csv', () => {
  test('CSV: RFC4180 escaping + BOM + CRLF', () => {
    const out = csv.buildCsv([{ a: 'hi', b: 'co,mma' }, { a: 'with "qq"', b: 'line\nbreak' }]);
    assert.ok(out.startsWith('\ufeff'), 'BOM');
    assert.ok(out.includes('\r\n'), 'CRLF');
    assert.ok(out.includes('"co,mma"'));
    assert.ok(out.includes('"with ""qq"""'));
    assert.ok(out.includes('"line\nbreak"'));
  });
  test('CSV: пустой массив → только BOM+headers (если есть)', () => {
    const out = csv.buildCsv([], { headers: ['a', 'b'] });
    assert.strictEqual(out, '\ufeffa,b\r\n');
  });
  test('CSV: null/undefined → пустая ячейка', () => {
    const out = csv.buildCsv([{ a: null, b: undefined }]);
    assert.ok(out.includes('\r\n,\r\n') || out.endsWith(',\r\n'));
  });
  test('TSV: для буфера обмена, без BOM, экранирует только спец-символы', () => {
    const out = csv.buildTsv([{ a: 'x', b: 'y' }]);
    assert.ok(!out.startsWith('\ufeff'));
    assert.ok(out.includes('\t'));
    const esc = csv.buildTsv([{ a: 'has\ttab' }]);
    assert.ok(esc.includes('"has\ttab"'));
  });
});

// ───── ssrfGuard ─────
group('ssrfGuard', () => {
  test('isPrivateIpv4: 127/10/172.16/192.168 → true', () => {
    assert.strictEqual(ssrf.isPrivateIpv4('127.0.0.1'),    true);
    assert.strictEqual(ssrf.isPrivateIpv4('10.0.0.1'),     true);
    assert.strictEqual(ssrf.isPrivateIpv4('172.16.5.5'),   true);
    assert.strictEqual(ssrf.isPrivateIpv4('172.31.0.1'),   true);
    assert.strictEqual(ssrf.isPrivateIpv4('192.168.1.1'),  true);
    assert.strictEqual(ssrf.isPrivateIpv4('169.254.1.1'),  true);
    assert.strictEqual(ssrf.isPrivateIpv4('100.64.0.1'),   true);
    assert.strictEqual(ssrf.isPrivateIpv4('8.8.8.8'),      false);
    assert.strictEqual(ssrf.isPrivateIpv4('1.1.1.1'),      false);
  });
  test('isPrivateIpv6: ::1/fc/fd/fe80 → true; 2606:: → false', () => {
    assert.strictEqual(ssrf.isPrivateIpv6('::1'),    true);
    assert.strictEqual(ssrf.isPrivateIpv6('fd00::1'),true);
    assert.strictEqual(ssrf.isPrivateIpv6('fe80::1'),true);
    assert.strictEqual(ssrf.isPrivateIpv6('2606:4700:4700::1111'), false);
  });
  test('assertPublicHost: IP-host блокируется без DNS', async () => {
    let err;
    try { await ssrf.assertPublicHost('127.0.0.1'); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'SSRF_BLOCKED');
  });
});

// ───── crawler html parsing & options ─────
group('crawler', () => {
  test('_mergeOptions clamps to safe ranges', () => {
    const o = crawler._mergeOptions({ maxPages: 999999, concurrency: 999, maxDepth: -3 });
    assert.ok(o.maxPages <= 10000);
    assert.ok(o.concurrency <= 16);
    assert.strictEqual(o.maxDepth, 0); // -3 → clamp to min 0
  });
  test('_parseHtml: title/h1/description/canonical/robots', () => {
    const html = `
      <html><head>
        <title>Hello</title>
        <meta name="description" content="A page">
        <link rel="canonical" href="/canon">
        <meta name="robots" content="noindex">
      </head><body>
        <h1>Welcome!</h1>
        <a href="/x">x</a>
        <a href="https://other.com/y">y</a>
        <a href="mailto:a@b">skip</a>
      </body></html>`;
    const p = crawler._parseHtml(html, 'https://a.com/foo');
    assert.strictEqual(p.title,       'Hello');
    assert.strictEqual(p.h1,          'Welcome!');
    assert.strictEqual(p.description, 'A page');
    assert.strictEqual(p.canonical,   'https://a.com/canon');
    assert.strictEqual(p.robots,      'noindex');
    assert.ok(p.links.some((l) => l === 'https://a.com/x'));
    assert.ok(p.links.some((l) => l === 'https://other.com/y'));
    assert.ok(!p.links.some((l) => l && l.startsWith('mailto:')));
  });
  test('_parseHtml: missing fields → null safely', () => {
    const p = crawler._parseHtml('<html><body><p>no head</p></body></html>', 'https://a.com');
    assert.strictEqual(p.title,       null);
    assert.strictEqual(p.description, null);
    assert.strictEqual(p.canonical,   null);
    assert.strictEqual(p.h1,          null);
  });
});

(async () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
