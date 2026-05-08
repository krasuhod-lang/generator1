'use strict';

/**
 * test-fact-check.js — юнит-тесты для factCheck.service.js (Phase 1, P0-1).
 *
 * Всё в памяти, без сети, без БД. Покрывает:
 *   • stripHtml: удаление тегов, code/pre/script, замена </p>/</li>/<br> на разделитель
 *   • splitSentences: уважение сокращений ("г.", "т. н.", "руб.")
 *   • extractFactTokens: процент, год, валюта, единица, голое число
 *   • дедуп токенов в одном предложении (50% дважды → один токен)
 *   • кросс-категорийный матч (number↔unit) и точное совпадение в категории
 *   • extractClaims: фильтр по claim-сигналам, по длине, дедуп, MAX_CLAIMS
 *   • verifyClaims: supported / partial / unsupported, supportedBy с источниками
 *   • summarizeFactCheck: verdict pass/review/fail/na, byKind, supportedPct
 *   • runFactCheck (фасад): корректные top_unsupported / top_partial
 *
 * Запуск:  node backend/scripts/test-fact-check.js
 */

const assert = require('assert');
const path   = require('path');

const {
  runFactCheck,
  extractClaims,
  verifyClaims,
  summarizeFactCheck,
  stripHtml,
  splitSentences,
  extractFactTokens,
  _tokensInText,
  _matchToken,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'factCheck.service'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
  }
}

// ── Test 1: stripHtml ────────────────────────────────────────────────

console.log('\n=== Test 1: stripHtml ===');
check('strips tags, preserves text', () => {
  const out = stripHtml('<p>Hello <b>world</b>!</p>');
  // Точная позиция «.»/«!» зависит от порядка замен, но важно:
  // (1) теги ушли, (2) текст «Hello world» сохранился, (3) появился разделитель.
  assert.ok(out.includes('Hello'),  `lost "Hello": ${out}`);
  assert.ok(out.includes('world'),  `lost "world": ${out}`);
  assert.ok(/[.!?]/.test(out),      `no sentence delimiter: ${out}`);
  assert.ok(!/<[^>]*>/.test(out),   `tags leaked: ${out}`);
});
check('removes <script>/<style>/<code>/<pre> entirely', () => {
  const out = stripHtml('<p>Visible</p><script>var x=42;</script><style>.a{}</style><code>code123</code>');
  assert.ok(out.includes('Visible'));
  assert.ok(!out.includes('42'),    `script content leaked: ${out}`);
  assert.ok(!out.includes('code123'), 'code content leaked');
});
check('replaces block ends with sentence delimiter', () => {
  const out = stripHtml('<li>Один</li><li>Два</li><li>Три</li>');
  // splitSentences потом разрежет на 3.
  assert.strictEqual(splitSentences(out).length, 3);
});
check('decodes basic HTML entities', () => {
  const out = stripHtml('Цена&nbsp;100&nbsp;руб.&hellip;');
  assert.ok(out.includes('100 руб'),    `nbsp not decoded: ${out}`);
  assert.ok(out.includes('…'),          `hellip not decoded: ${out}`);
});
check('does NOT double-decode &amp;lt; into <', () => {
  // Регрессия на CodeQL js/double-escaping. Если &amp; декодируется РАНЬШЕ
  // &lt;, то "&amp;lt;" → "&lt;" → "<" (двойное декодирование, неверно).
  // Корректный порядок: &amp; декодируем В ПОСЛЕДНЮЮ ОЧЕРЕДЬ. Тогда:
  //   "&amp;lt;"   — после прохода &lt;/&gt;/etc. остаётся "&amp;lt;" (этап
  //                  &lt; уже прошёл), затем &amp; превращается в "&", итого "&lt;"
  //   "&amp;"      — превращается в "&"
  //   "&lt;tag&gt;" — декодируется обычным образом в "<tag>"
  // Все три ассерта НЕ противоречат друг другу — они проверяют разные
  // подстроки одного и того же входа.
  const out = stripHtml('A &amp;lt; B и обычный &amp; ещё &lt;tag&gt;');
  assert.ok(out.includes('&lt;'),       `double-decoding (lost literal &lt;): ${out}`);
  assert.ok(out.includes('&'),          `lost ampersand: ${out}`);
  assert.ok(out.includes('<tag>'),      `single-decoded &lt;tag&gt; missing: ${out}`);
});
check('strips </script > with whitespace before >', () => {
  // CodeQL js/bad-tag-filter: closing tag may include whitespace.
  const out = stripHtml('<p>Visible</p><script>var leak=42;</script  ><p>Tail</p>');
  assert.ok(out.includes('Visible'));
  assert.ok(out.includes('Tail'));
  assert.ok(!out.includes('leak'),  `script with trailing space leaked: ${out}`);
  assert.ok(!out.includes('42'),    `script content leaked: ${out}`);
});

// ── Test 2: splitSentences ───────────────────────────────────────────

console.log('\n=== Test 2: splitSentences ===');
check('basic split', () => {
  assert.deepStrictEqual(
    splitSentences('Один. Два. Три.'),
    ['Один.', 'Два.', 'Три.'],
  );
});
check('respects "г." abbreviation', () => {
  // «г.» — сокращение «года/город», не должно дробить.
  const s = splitSentences('В 2020 г. начали продажи. Затем 2021 г. — расширение.');
  assert.strictEqual(s.length, 2, `got ${JSON.stringify(s)}`);
});
check('respects "руб." abbreviation', () => {
  const s = splitSentences('Цена 100 руб. в первый месяц. Затем 150 руб. постоянно.');
  assert.strictEqual(s.length, 2);
});
check('!? terminate sentences too', () => {
  const s = splitSentences('Что? Когда! Где?');
  assert.strictEqual(s.length, 3);
});

// ── Test 3: extractFactTokens ────────────────────────────────────────

console.log('\n=== Test 3: extractFactTokens ===');
check('percent (digit + %)', () => {
  const t = extractFactTokens('доля рынка 50%');
  assert.deepStrictEqual(t.map((x) => `${x.kind}|${x.value}`), ['percent|50']);
});
check('percent словом ("50 процентов")', () => {
  const t = extractFactTokens('охват 50 процентов аудитории');
  assert.ok(t.some((x) => x.kind === 'percent' && x.value === 50));
});
check('year', () => {
  const t = extractFactTokens('запуск в 2020 году');
  assert.ok(t.some((x) => x.kind === 'year' && x.value === 2020));
});
check('currency RUB', () => {
  const t = extractFactTokens('цена 1500 руб');
  assert.ok(t.some((x) => x.kind === 'currency' && x.value === 1500));
});
check('currency USD', () => {
  const t = extractFactTokens('цена $99');
  assert.ok(t.some((x) => x.kind === 'currency' && x.value === 99));
});
check('unit kg', () => {
  const t = extractFactTokens('вес 2.5 кг');
  assert.ok(t.some((x) => x.kind === 'unit' && x.value === 2.5));
});
check('unit «градусов»', () => {
  const t = extractFactTokens('температура 38 градусов');
  assert.ok(t.some((x) => x.kind === 'unit' && x.value === 38));
});
check('plain number ≥3 in absence of category', () => {
  const t = extractFactTokens('программа из 12 шагов проверена практикой');
  // 12 не подпадает под percent/year/currency/unit — должно остаться как number.
  assert.ok(t.some((x) => x.kind === 'number' && x.value === 12), `got ${JSON.stringify(t)}`);
});
check('skips tiny numbers (<3)', () => {
  const t = extractFactTokens('ровно 1 раз и 2 пункта');
  assert.strictEqual(t.length, 0);
});
check('dedupes same kind|value within sentence', () => {
  const t = extractFactTokens('50% и снова 50% повторяем');
  const percents = t.filter((x) => x.kind === 'percent');
  assert.strictEqual(percents.length, 1);
});
check('does NOT double-count 50% as both percent and number', () => {
  const t = extractFactTokens('доля 50% по результатам года');
  const fifties = t.filter((x) => x.value === 50);
  assert.strictEqual(fifties.length, 1, `expected one token for 50, got ${JSON.stringify(fifties)}`);
  assert.strictEqual(fifties[0].kind, 'percent');
});
check('handles thousands separator (1 200 руб)', () => {
  const t = extractFactTokens('цена 1 200 руб');
  assert.ok(t.some((x) => x.kind === 'currency' && x.value === 1200), `got ${JSON.stringify(t)}`);
});

// ── Test 4: _matchToken / _tokensInText ──────────────────────────────

console.log('\n=== Test 4: _matchToken / _tokensInText ===');
check('exact category|value match', () => {
  const idx = _tokensInText('покрытие достигает 50%');
  assert.ok(_matchToken({ kind: 'percent', value: 50 }, idx));
});
check('different category, same value → no match (strict)', () => {
  const idx = _tokensInText('вес 50 кг');
  assert.ok(!_matchToken({ kind: 'percent', value: 50 }, idx));
});
check('"number" token matches any category with same value', () => {
  const idx = _tokensInText('запуск в 2020 году');
  // year|2020 в idx; число 2020 без категории должно матчиться.
  assert.ok(_matchToken({ kind: 'number', value: 2020 }, idx));
});
check('no match when value missing', () => {
  const idx = _tokensInText('ничего конкретного, общие слова');
  assert.ok(!_matchToken({ kind: 'percent', value: 50 }, idx));
});

// ── Test 5: extractClaims ────────────────────────────────────────────

console.log('\n=== Test 5: extractClaims ===');
check('keeps only sentences with claim signals', () => {
  const html = `
    <p>Это просто описание без чисел и фактов.</p>
    <p>В 2023 году выручка достигла 1 200 000 руб.</p>
    <p>Просто общие слова о пользе продукта.</p>
    <p>Эффективность подтверждена для 75% пациентов.</p>
  `;
  const claims = extractClaims(html);
  assert.strictEqual(claims.length, 2, `got ${claims.length}: ${JSON.stringify(claims.map((c)=>c.text))}`);
  assert.ok(claims[0].kinds.includes('year') || claims[0].kinds.includes('currency'));
  assert.ok(claims.some((c) => c.kinds.includes('percent')));
});
check('skips too-short sentences (< MIN_CLAIM_CHARS=30)', () => {
  const html = `<p>50%.</p><p>В 2020 году компания выпустила новый продукт с долей 25% на рынке.</p>`;
  const claims = extractClaims(html);
  assert.strictEqual(claims.length, 1);
  assert.ok(claims[0].text.includes('2020'));
});
check('dedupes identical claims (case-insensitive, punct-insensitive)', () => {
  const html = `
    <p>Снижение веса на 15% за 30 дней по данным исследования.</p>
    <p>Снижение веса на 15% за 30 дней по данным исследования.</p>
    <p>СНИЖЕНИЕ веса НА 15%, за 30 дней по данным исследования!</p>
  `;
  const claims = extractClaims(html);
  assert.strictEqual(claims.length, 1, `dedup failed: ${JSON.stringify(claims.map((c)=>c.text))}`);
});

// ── Test 6: verifyClaims ─────────────────────────────────────────────

console.log('\n=== Test 6: verifyClaims ===');

const evidenceFixture = {
  evidence: [
    {
      url: 'https://a.ru/x', h1: 'Источник A', serp_position: 1,
      snippets: [
        { text: 'Исследование показало, что 75% пациентов отметили улучшение в 2023 году.', score: 1.5, position: 0 },
        { text: 'Средняя цена курса составляет 1500 руб.', score: 1.0, position: 1 },
      ],
    },
    {
      url: 'https://b.ru/y', h1: 'Источник B', serp_position: 2,
      snippets: [
        { text: 'В 2020 году рынок вырос на 10%.', score: 0.9, position: 0 },
      ],
    },
  ],
};

check('supported: claim полностью покрыт одним сниппетом', () => {
  const claim = {
    id: 1, text: 'В 2023 году 75% пациентов получили улучшение по результатам исследования.',
    kinds: ['percent', 'year'],
    tokens: [{ kind: 'percent', value: 75 }, { kind: 'year', value: 2023 }],
  };
  const [r] = verifyClaims([claim], evidenceFixture);
  assert.strictEqual(r.status, 'supported', `got ${r.status}; matched=${r.matchedTokenCount}/${r.totalTokenCount}`);
  assert.strictEqual(r.matchedTokenCount, 2);
  assert.ok(r.supportedBy.length >= 1);
  assert.strictEqual(r.supportedBy[0].url, 'https://a.ru/x');
});
check('partial: токены есть в evidence, но в РАЗНЫХ сниппетах', () => {
  const claim = {
    id: 2, text: 'В 2023 году 10% покупателей выбрали наш продукт по итогам исследования.',
    kinds: ['percent', 'year'],
    tokens: [{ kind: 'percent', value: 10 }, { kind: 'year', value: 2023 }],
  };
  // 2023 есть в a/x[0]; 10% есть в b/y[0]. Ни один сниппет не покрывает оба.
  const [r] = verifyClaims([claim], evidenceFixture);
  assert.strictEqual(r.status, 'partial', `got ${r.status}; matched=${r.matchedTokenCount}/${r.totalTokenCount}`);
  assert.ok(r.matchedTokenCount >= 1 && r.matchedTokenCount < r.totalTokenCount);
  assert.ok(r.supportedBy.length >= 2, 'обе разные строки должны попасть в supportedBy');
});
check('unsupported: ни одного совпадающего токена', () => {
  const claim = {
    id: 3, text: 'В 1999 году доля рынка составила ровно 88% по нашим внутренним данным.',
    kinds: ['percent', 'year'],
    tokens: [{ kind: 'percent', value: 88 }, { kind: 'year', value: 1999 }],
  };
  const [r] = verifyClaims([claim], evidenceFixture);
  assert.strictEqual(r.status, 'unsupported');
  assert.strictEqual(r.matchedTokenCount, 0);
  assert.deepStrictEqual(r.supportedBy, []);
});
check('empty evidence → all claims unsupported', () => {
  const claims = [{
    id: 1, text: 'Какое-то утверждение про 50% и 2020 год для проверки.',
    kinds: ['percent', 'year'],
    tokens: [{ kind: 'percent', value: 50 }, { kind: 'year', value: 2020 }],
  }];
  const out = verifyClaims(claims, { evidence: [] });
  assert.strictEqual(out[0].status, 'unsupported');
});
check('supportedBy sorted by matchedTokens.length desc + capped', () => {
  const ev = {
    evidence: [
      { url: 'weak.ru', snippets: [{ text: '50%' }] },                 // 1 token match
      { url: 'strong.ru', snippets: [{ text: '50% в 2020 году' }] },   // 2 token match
      { url: 'med.ru',  snippets: [{ text: '2020' }] },                // 1 token match
    ],
  };
  const [r] = verifyClaims([{
    id: 1, text: 'В 2020 году 50% рынка.',
    kinds: ['percent', 'year'],
    tokens: [{ kind: 'percent', value: 50 }, { kind: 'year', value: 2020 }],
  }], ev, { maxSourcesPerClaim: 2 });
  assert.strictEqual(r.status, 'supported');
  assert.strictEqual(r.supportedBy.length, 2);
  assert.strictEqual(r.supportedBy[0].url, 'strong.ru');
});

// ── Test 7: summarizeFactCheck ───────────────────────────────────────

console.log('\n=== Test 7: summarizeFactCheck ===');
check('verdict=na for empty list', () => {
  const s = summarizeFactCheck([]);
  assert.strictEqual(s.verdict, 'na');
  assert.strictEqual(s.total, 0);
});
check('verdict=pass when supportedPct ≥ 70 and unsupported ≤ 5', () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    status: i < 8 ? 'supported' : (i === 8 ? 'partial' : 'unsupported'),
    kinds: ['percent'],
  }));
  const s = summarizeFactCheck(results);
  assert.strictEqual(s.supported, 8);
  assert.strictEqual(s.partial, 1);
  assert.strictEqual(s.unsupported, 1);
  assert.strictEqual(s.supportedPct, 80);
  assert.strictEqual(s.verdict, 'pass');
});
check('verdict=review when supportedPct in [40, 70)', () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    status: i < 5 ? 'supported' : 'unsupported',
    kinds: [],
  }));
  const s = summarizeFactCheck(results);
  assert.strictEqual(s.verdict, 'review');
});
check('verdict=fail when unsupported > 5 even at 70%+', () => {
  const results = Array.from({ length: 30 }, (_, i) => ({
    status: i < 22 ? 'supported' : 'unsupported',  // 22/30=73%, but 8 unsupported
    kinds: [],
  }));
  const s = summarizeFactCheck(results);
  assert.ok(s.supportedPct > 70);
  assert.ok(s.unsupported > 5);
  assert.notStrictEqual(s.verdict, 'pass');
});
check('verdict=fail at 0%', () => {
  const s = summarizeFactCheck([{ status: 'unsupported', kinds: [] }]);
  assert.strictEqual(s.verdict, 'fail');
});
check('byKind tallies are correct', () => {
  const results = [
    { status: 'supported',   kinds: ['percent'] },
    { status: 'supported',   kinds: ['year', 'percent'] },
    { status: 'unsupported', kinds: ['currency'] },
  ];
  const s = summarizeFactCheck(results);
  assert.strictEqual(s.byKind.percent, 2);
  assert.strictEqual(s.byKind.year, 1);
  assert.strictEqual(s.byKind.currency, 1);
  assert.strictEqual(s.byKind.unit, 0);
});

// ── Test 8: runFactCheck (фасад) ─────────────────────────────────────

console.log('\n=== Test 8: runFactCheck (high-level facade) ===');
check('end-to-end: HTML + evidence → отчёт с summary, top_unsupported, top_partial', () => {
  const html = `
    <h2>Результаты</h2>
    <p>В 2023 году улучшение отметили 75% пациентов по данным исследования.</p>
    <p>В 1999 году выдуманная доля 88% по нашим закрытым данным.</p>
    <p>Программа разработана с заботой о клиенте и проверена практикой.</p>
    <p>Цена курса начинается от 1500 руб за один сеанс терапии.</p>
  `;
  const report = runFactCheck(html, evidenceFixture);
  assert.ok(report.summary);
  assert.ok(report.summary.total >= 3, `expected ≥3 claims, got ${report.summary.total}`);
  assert.ok(report.top_unsupported.length >= 1, 'should flag the 1999/88% fabrication');
  assert.ok(report.top_unsupported.some((c) => c.text.includes('1999')));
  assert.ok(Array.isArray(report.results));
  assert.ok(typeof report.generated_at === 'string');
});
check('end-to-end: пустой evidence → все претенденты в top_unsupported', () => {
  const html = `<p>В 2020 году рост составил 30% по нашим данным.</p>`;
  const report = runFactCheck(html, { evidence: [] });
  assert.strictEqual(report.summary.unsupported, 1);
  assert.strictEqual(report.summary.verdict, 'fail');
});
check('end-to-end: HTML без фактологии → verdict=na', () => {
  const html = `<p>Просто общие слова без чисел и фактологии для проверки.</p>`;
  const report = runFactCheck(html, evidenceFixture);
  assert.strictEqual(report.summary.total, 0);
  assert.strictEqual(report.summary.verdict, 'na');
});

console.log('\n' + '─'.repeat(60));
if (_pass === _cases) {
  console.log(`✅ All ${_cases} factCheck tests passed`);
  process.exit(0);
} else {
  console.log(`❌ ${_cases - _pass}/${_cases} factCheck tests failed`);
  process.exit(1);
}
