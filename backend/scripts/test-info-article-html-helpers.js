'use strict';

/**
 * test-info-article-html-helpers.js — детерминированные smoke-тесты для
 * HTML-хелперов info-article pipeline (без DB / LLM):
 *   • embedImages — встраивание cover-изображения после <h1>;
 *   • injectMissingLinks — многоуровневый fallback (p → li → новый <p>) для
 *     гарантии вставки коммерческих ссылок при любой структуре writer'а.
 *
 * Run:  node backend/scripts/test-info-article-html-helpers.js
 */

const assert = require('assert');
const path   = require('path');

// Заглушка для backend/src/config/db: pipeline-модуль импортирует её на верхнем
// уровне, и мы не хотим открывать реальное Postgres-соединение в smoke-тесте.
require.cache[require.resolve(path.join('..', 'src', 'config', 'db'))] = {
  id:       require.resolve(path.join('..', 'src', 'config', 'db')),
  filename: require.resolve(path.join('..', 'src', 'config', 'db')),
  loaded:   true,
  exports:  { query: async () => ({ rows: [] }) },
};

const { _internal } = require(path.join('..', 'src', 'services', 'infoArticle', 'infoArticlePipeline'));
const { embedImages, injectMissingLinks } = _internal;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── embedImages ──────────────────────────────────────────────────────

test('embedImages — embeds cover figure right after </h1>', () => {
  const html = '<h1>Заголовок</h1>\n<p>Первый абзац.</p>';
  const out = embedImages(html, [
    { status: 'done', image_base64: 'AAAA', mime_type: 'image/png', alt_ru: 'Обложка' },
  ]);
  assert.ok(/<figure class="info-article-cover">/.test(out), 'figure inserted');
  assert.ok(/<img src="data:image\/png;base64,AAAA" alt="Обложка" \/>/.test(out), 'data:base64 src present');
  // Положение: figure после </h1> и до <p>.
  const idxH1End  = out.indexOf('</h1>');
  const idxFigure = out.indexOf('<figure');
  const idxP      = out.indexOf('<p>');
  assert.ok(idxH1End < idxFigure && idxFigure < idxP, 'figure is between </h1> and <p>');
});

test('embedImages — prepends figure when no <h1> in html', () => {
  const html = '<p>Без заголовка.</p>';
  const out = embedImages(html, [
    { status: 'done', image_base64: 'BBBB', mime_type: 'image/jpeg', alt_ru: '' },
  ]);
  assert.ok(out.startsWith('<figure'), 'figure prepended at the very top');
  assert.ok(/data:image\/jpeg;base64,BBBB/.test(out));
});

test('embedImages — does NOT embed when there is no successful image', () => {
  const html = '<h1>X</h1><p>Y</p>';
  assert.strictEqual(embedImages(html, []), '<h1>X</h1><p>Y</p>');
  assert.strictEqual(
    embedImages(html, [{ status: 'error', image_base64: null }]),
    '<h1>X</h1><p>Y</p>',
  );
});

test('embedImages — does NOT double-embed when writer already inserted <img>', () => {
  const html = '<h1>X</h1><p>Текст с <img src="x.png"/></p>';
  const out = embedImages(html, [{ status: 'done', image_base64: 'CC', mime_type: 'image/png', alt_ru: '' }]);
  assert.strictEqual((out.match(/<img\b/g) || []).length, 1, 'still exactly one <img>');
});

test('embedImages — strips leftover IMAGE_SLOT placeholders + empty <p></p>', () => {
  const html = '<h1>Z</h1>\n<!-- IMAGE_SLOT_1 -->\n<p></p>\n<p>Текст.</p>';
  const out = embedImages(html, []);
  assert.ok(!/IMAGE_SLOT_/.test(out));
  assert.ok(!/<p>\s*<\/p>/.test(out));
});

test('embedImages — escapes alt_ru to prevent attribute injection', () => {
  const html = '<h1>X</h1><p>Y</p>';
  const out = embedImages(html, [{
    status: 'done', image_base64: 'AA', mime_type: 'image/png',
    alt_ru: '"><script>alert(1)</script>',
  }]);
  assert.ok(!/<script>/.test(out), 'no raw <script>');
  assert.ok(/alt="&quot;&gt;&lt;script&gt;/.test(out), 'alt is HTML-escaped');
});

// ── injectMissingLinks ───────────────────────────────────────────────

test('injectMissingLinks — inserts " (см. также <a>…</a>)" inside first <p> of section', () => {
  const html =
    '<h1>T</h1>' +
    '<h2>Секция 1</h2><p>Один абзац.</p>' +
    '<h2>Секция 2</h2><p>Второй.</p>';
  const missing = [{ h2_index: 1, url: 'https://x.com/a', anchor_text: 'купить услугу' }];
  const r = injectMissingLinks(html, missing);
  assert.strictEqual(r.injected, 1);
  assert.strictEqual(r.skipped.length, 0);
  assert.ok(/<p>Один абзац\. \(см\. также <a href="https:\/\/x\.com\/a">купить услугу<\/a>\)<\/p>/.test(r.html));
  // Section 2 untouched
  assert.ok(/<h2>Секция 2<\/h2><p>Второй\.<\/p>/.test(r.html));
});

test('injectMissingLinks — fallback to <li> when section has only a list', () => {
  const html =
    '<h2>Только список</h2><ul><li>Элемент один</li><li>Элемент два</li></ul>' +
    '<h2>Следующая</h2><p>x</p>';
  const r = injectMissingLinks(html, [{ h2_index: 1, url: 'https://x.com/b', anchor_text: 'пример анкора' }]);
  assert.strictEqual(r.injected, 1);
  assert.strictEqual(r.skipped.length, 0);
  assert.ok(/<li>Элемент один \(см\. также <a href="https:\/\/x\.com\/b">пример анкора<\/a>\)<\/li>/.test(r.html));
});

test('injectMissingLinks — fallback to new <p> when section has neither <p> nor <li>', () => {
  // Раньше такая секция давала skipped=no_paragraph_in_section и ссылка терялась.
  const html =
    '<h2>Пустая секция</h2><blockquote>цитата</blockquote>' +
    '<h2>Дальше</h2><p>x</p>';
  const r = injectMissingLinks(html, [{ h2_index: 1, url: 'https://x.com/c', anchor_text: 'смотреть цены' }]);
  assert.strictEqual(r.injected, 1);
  assert.strictEqual(r.skipped.length, 0);
  // Новый <p> вставлен ВНУТРИ секции 1, до <h2>Дальше</h2>.
  const segMatch = /<h2>Пустая секция<\/h2>([\s\S]*?)<h2>Дальше<\/h2>/.exec(r.html);
  assert.ok(segMatch, 'section 1 still bounded by <h2>Дальше');
  assert.ok(/<p>См\. также: <a href="https:\/\/x\.com\/c">смотреть цены<\/a>\.<\/p>/.test(segMatch[1]));
});

test('injectMissingLinks — handles multiple missing links in same H2 (offset-safe)', () => {
  const html = '<h2>S</h2><p>Текст.</p>';
  const r = injectMissingLinks(html, [
    { h2_index: 1, url: 'https://x.com/1', anchor_text: 'анкор один' },
    { h2_index: 1, url: 'https://x.com/2', anchor_text: 'анкор два' },
  ]);
  assert.strictEqual(r.injected, 2);
  assert.ok(/анкор один/.test(r.html));
  assert.ok(/анкор два/.test(r.html));
  // Оба внутри одного <p>.
  assert.strictEqual((r.html.match(/<\/p>/g) || []).length, 1);
});

test('injectMissingLinks — escapes URL and anchor (no XSS)', () => {
  const html = '<h2>S</h2><p>x</p>';
  const r = injectMissingLinks(html, [{
    h2_index: 1,
    url:         'https://x.com/?q=<script>',
    anchor_text: '"><img onerror=alert(1)>',
  }]);
  // Никакого исполняемого <script> или <img>-тега в выходе не появилось:
  // angle-brackets экранированы, поэтому всё, что выглядело как тег во
  // входных данных, превращается в безобидный текстовый контент анкора.
  assert.ok(!/<script\b/i.test(r.html), 'no executable <script> tag');
  assert.ok(!/<img\b/i.test(r.html), 'no executable <img> tag');
  // href атрибут — экранирован.
  assert.ok(/href="https:\/\/x\.com\/\?q=&lt;script&gt;"/.test(r.html));
  // Угловые скобки в тексте анкора — экранированы.
  assert.ok(/&quot;&gt;&lt;img onerror=alert\(1\)&gt;/.test(r.html));
});

test('injectMissingLinks — h2_index out of range goes to skipped (not injected)', () => {
  const html = '<h2>Only one</h2><p>x</p>';
  const r = injectMissingLinks(html, [{ h2_index: 99, url: 'https://x.com/z', anchor_text: 'анкор' }]);
  assert.strictEqual(r.injected, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].reason, 'h2_index_out_of_range');
});

test('injectMissingLinks — empty missing[] = no-op', () => {
  const html = '<h2>X</h2><p>y</p>';
  const r = injectMissingLinks(html, []);
  assert.strictEqual(r.html, html);
  assert.strictEqual(r.injected, 0);
});

// ── runner ───────────────────────────────────────────────────────────

(async () => {
  console.log('test-info-article-html-helpers');
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    }
  }
  if (failed) {
    console.error(`\nFAILED ${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log('OK');
  // pipeline-модуль на require тянет адаптеры (gemini/grok), которые
  // могут держать event-loop живым (idle proxy keep-alive). Явно завершаем
  // процесс, чтобы npm-пайплайны / CI не висели после успешных тестов.
  process.exit(0);
})();
