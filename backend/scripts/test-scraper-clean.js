/* eslint-disable no-console */
'use strict';

/**
 * test-scraper-clean.js — детерминированный smoke-тест очистки HTML
 * в Stage 0 scraper (scrapeUrl Readability-ветка + Cheerio fallback).
 *
 * Запуск:  node backend/scripts/test-scraper-clean.js
 *
 * Никаких сетевых вызовов — используем in-process HTTP-сервер на 127.0.0.1
 * с заранее подготовленным «шумным» HTML.
 */

const http = require('http');
const assert = require('assert');

const { scrapeUrl, _stripFooterArtifacts, _stripDomNoise, _extractChrome } = require('../src/services/parser/scraper');

let failed = 0;
let passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

// ── HTML-фикстура с типичным мусором ─────────────────────────────────
const NOISY_HTML = `<!doctype html>
<html lang="ru">
<head>
  <title>Тестовая статья про SEO</title>
  <link rel="stylesheet" href="/style.css">
  <style>body{color:red}.cookie-banner{display:block}</style>
  <script>window.dataLayer=[];console.log('tracker')</script>
</head>
<body>
  <header><nav>Главная | О нас | Контакты</nav></header>

  <div class="cookie-banner" id="cookieNotice">
    Мы используем cookie для улучшения сервиса. Принять все.
  </div>

  <div class="popup-modal">Подпишитесь на нашу рассылку!</div>

  <article>
    <h1>Тестовая статья про SEO</h1>
    <p>Это важный полезный контент статьи о поисковой оптимизации.
       Здесь рассказывается о ключевых принципах продвижения сайтов
       в поисковых системах Google и Яндекс. Статья содержит реальные
       рекомендации, которые должны попасть в результат скрейпинга.</p>
    <h2>Подзаголовок</h2>
    <p>Второй важный параграф с дополнительной полезной информацией.
       Здесь снова идёт смысловое содержание, которое нужно сохранить
       после очистки HTML от мусора и баннеров.</p>
    <iframe src="https://ads.example.com/banner" width="300" height="250"></iframe>
    <ins class="adsbygoogle" style="display:block"></ins>
  </article>

  <aside class="related"><a href="#">Похожие статьи</a></aside>

  <div id="comments-section">
    <form><textarea>Ваш комментарий</textarea><button>Отправить</button></form>
  </div>

  <footer>
    <p>© 2024 Test Company. Все права защищены.</p>
    <a href="/privacy">Политика конфиденциальности</a>
  </footer>

  <noscript>Включите JavaScript</noscript>
</body>
</html>`;

const SMALL_HTML = `<!doctype html><html><head><title>Tiny</title></head>
<body><h1>Tiny</h1><p>Short.</p>
<footer><p>© 2025 X. Все права защищены.</p></footer></body></html>`;

function makeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  console.log('\n=== test-scraper-clean ===\n');

  // ── 0. _extractChrome unit (ТЗ п.6: шапка/подвал для коммерч. факторов) ──
  {
    const html = `<!doctype html><html><body>
      <header class="site-header"><a href="tel:+74950001122">+7 495 000-11-22</a>
        <a href="mailto:sale@shop.ru">sale@shop.ru</a></header>
      <article><h1>Товар</h1><p>Описание товара без контактов.</p></article>
      <footer class="site-footer">Доставка и оплата по всей России. ИНН 7700000000.
        <a href="https://t.me/shop">Telegram</a></footer>
    </body></html>`;
    const chrome = _extractChrome(html);
    ok('_extractChrome returns object', chrome && typeof chrome === 'object');
    ok('_extractChrome captures tel:', (chrome.tel || []).some((t) => /4950001122/.test(t.replace(/\D/g, ''))));
    ok('_extractChrome captures mailto:', (chrome.email || []).includes('sale@shop.ru'));
    ok('_extractChrome captures social link', (chrome.social || []).some((s) => /t\.me/.test(s)));
    ok('_extractChrome footer text has доставка/оплата', /доставк/i.test(chrome.text) && /оплат/i.test(chrome.text));
    ok('_extractChrome on empty html → null', _extractChrome('') === null);
  }

  // ── 1. _stripFooterArtifacts unit ─────────────────────────────────
  {
    const md = `# Title

Real content paragraph.

© 2024 Company. Все права защищены.
Политика конфиденциальности
Privacy Policy
Подпишитесь на нашу рассылку`;
    const cleaned = _stripFooterArtifacts(md);
    ok('_stripFooterArtifacts removes © line', !/©/.test(cleaned));
    ok('_stripFooterArtifacts removes «Все права защищены»', !/Все права защищены/i.test(cleaned));
    ok('_stripFooterArtifacts removes «Политика конфиденциальности»', !/Политика конфиденциальности/i.test(cleaned));
    ok('_stripFooterArtifacts removes Privacy Policy', !/Privacy Policy/i.test(cleaned));
    ok('_stripFooterArtifacts removes newsletter prompt', !/рассылку/i.test(cleaned));
    ok('_stripFooterArtifacts keeps real content', /Real content paragraph/.test(cleaned));
  }

  // ── 2. _stripDomNoise unit ────────────────────────────────────────
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(NOISY_HTML);
    _stripDomNoise(dom.window.document);
    const body = dom.window.document.body.innerHTML;
    ok('_stripDomNoise removes <script>', !/<script/i.test(body));
    ok('_stripDomNoise removes <style>', !/<style/i.test(body));
    ok('_stripDomNoise removes <iframe>', !/<iframe/i.test(body));
    ok('_stripDomNoise removes cookie-banner', !/cookie-banner/i.test(body));
    ok('_stripDomNoise removes adsbygoogle', !/adsbygoogle/i.test(body));
    ok('_stripDomNoise removes #comments-section', !/comments-section/i.test(body));
    ok('_stripDomNoise removes <noscript>', !/<noscript/i.test(body));
    ok('_stripDomNoise keeps <article>', /<article/i.test(body));
    ok('_stripDomNoise keeps real h1', /Тестовая статья про SEO/.test(body));
  }

  // ── 3. scrapeUrl end-to-end на in-process сервере ────────────────
  {
    const srv = await makeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(NOISY_HTML);
    });
    const { port } = srv.address();
    try {
      const result = await scrapeUrl(`http://127.0.0.1:${port}/`, 5000);
      const md = result.markdown || '';
      ok('scrapeUrl returns markdown', md.length > 50);
      ok('scrapeUrl markdown has main content', /полезный контент статьи|полезной информацией/.test(md));
      ok('scrapeUrl markdown has main title or h2', /Тестовая статья про SEO|Подзаголовок/.test(md));
      ok('scrapeUrl strips scripts', !/window\.dataLayer/.test(md) && !/console\.log/.test(md));
      ok('scrapeUrl strips styles', !/color:red/.test(md));
      ok('scrapeUrl strips cookie banner text', !/Мы используем cookie/.test(md));
      ok('scrapeUrl strips footer © line', !/©\s*2024/.test(md));
      ok('scrapeUrl strips «Все права защищены»', !/Все права защищены/i.test(md));
      ok('scrapeUrl strips iframe ads', !/ads\.example\.com|adsbygoogle/.test(md));
      ok('scrapeUrl strips comments form', !/Ваш комментарий/.test(md));
      ok('scrapeUrl strips noscript', !/Включите JavaScript/.test(md));
      ok('scrapeUrl strips nav links', !/Главная \| О нас \| Контакты/.test(md));
      ok('scrapeUrl strips «Подпишитесь на нашу рассылку»', !/Подпишитесь на нашу рассылку/.test(md));
      ok('scrapeUrl reports rawHtmlBytes>0', typeof result.rawHtmlBytes === 'number' && result.rawHtmlBytes > 0);
      ok('scrapeUrl cleanedBytes < rawHtmlBytes', (result.cleanedBytes || md.length) < result.rawHtmlBytes);
    } finally {
      srv.close();
    }
  }

  // ── 4. scrapeUrl на «маленьком» HTML — Readability падает,
  //     fallback Cheerio тоже чистит футер. ──────────────────────────
  {
    const srv = await makeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SMALL_HTML);
    });
    const { port } = srv.address();
    try {
      const result = await scrapeUrl(`http://127.0.0.1:${port}/`, 5000);
      const md = result.markdown || '';
      ok('fallback Cheerio: has Tiny', /Tiny/.test(md));
      ok('fallback Cheerio: strips © line', !/©\s*2025/.test(md));
      ok('fallback Cheerio: strips «Все права защищены»', !/Все права защищены/i.test(md));
    } finally {
      srv.close();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
