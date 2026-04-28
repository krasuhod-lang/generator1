'use strict';

/**
 * test-info-article-link-planner.js — детерминированные smoke-тесты для
 * семантического планировщика перелинковки (без DB / LLM).
 *
 * Покрывает:
 *  • TF-IDF / cosine / Jaccard ранжирование shortlist'а;
 *  • post-валидатор (min/max ссылок на H2, MAX_REPEATS_PER_URL,
 *    MIN_SEMANTIC_SCORE, anchor sanitization, role primary/supporting);
 *  • auditHtmlAgainstPlan (coverage, misplacements, extras, density).
 *
 * Run:  node backend/scripts/test-info-article-link-planner.js
 */

const assert = require('assert');
const path   = require('path');

// Изолируем требуемые env (детерминируем пороги для теста).
process.env.INFO_ARTICLE_MAX_LINKS_PER_H2  = '2';
process.env.INFO_ARTICLE_MIN_LINKS_PER_H2  = '1';
process.env.INFO_ARTICLE_MAX_REPEATS_PER_URL = '2';
process.env.INFO_ARTICLE_MIN_SEMANTIC_SCORE = '0.05';

const sp = require(path.join('..', 'src', 'services', 'infoArticle', 'semanticLinkPlanner'));
const {
  computeShortlists,
  postValidate,
  auditHtmlAgainstPlan,
  isCleanAnchor,
  fallbackAnchor,
} = sp;

function ok(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('test-info-article-link-planner');

// ── 1. computeShortlists: ssемантически правильные топ-1 матчи ─────
ok('computeShortlists — semantic matches surface relevant H1s', () => {
  const outline = {
    sections: [
      { index: 1, h2: 'Юридические требования к ВНЖ Португалии',
        descriptor: 'Какие документы нужны для подачи на резидентство',
        jtbd_cluster: 'understand_legal_basis',
        lsi_focus: ['внж португалии', 'документы', 'резидентство'] },
      { index: 2, h2: 'Стоимость переезда в Лиссабон',
        descriptor: 'Бюджет аренды, продуктов, школ',
        jtbd_cluster: 'plan_budget',
        lsi_focus: ['аренда лиссабон', 'бюджет переезда', 'школы для детей'] },
      { index: 3, h2: 'Языковая адаптация',
        descriptor: 'Курсы португальского для взрослых',
        jtbd_cluster: 'language_adaptation',
        lsi_focus: ['курсы португальского', 'a2 уровень', 'разговорный'] },
    ],
  };
  const links = [
    { url: 'https://immigro.pt/vnzh-portugalii',     h1: 'Получение ВНЖ Португалии под ключ' },
    { url: 'https://immigro.pt/relocation-budget',   h1: 'Расчёт бюджета переезда в Лиссабон' },
    { url: 'https://immigro.pt/portuguese-courses',  h1: 'Курсы португальского языка А1–B2' },
    { url: 'https://immigro.pt/business',            h1: 'Регистрация бизнеса в Португалии' },
    { url: 'https://immigro.pt/medicine',            h1: 'Медицинская страховка для переезда' },
  ];
  const { shortlistByH2 } = computeShortlists({ outline, links });
  // H2 #1 → top is "ВНЖ Португалии"
  assert.strictEqual(shortlistByH2[1][0].url, 'https://immigro.pt/vnzh-portugalii');
  // H2 #2 → top is "бюджет переезда"
  assert.strictEqual(shortlistByH2[2][0].url, 'https://immigro.pt/relocation-budget');
  // H2 #3 → top is "курсы португальского"
  assert.strictEqual(shortlistByH2[3][0].url, 'https://immigro.pt/portuguese-courses');
});

// ── 2. anchor sanitization ─────────────────────────────────────────
ok('isCleanAnchor — accepts natural Russian phrases, rejects junk', () => {
  assert.ok(isCleanAnchor('купить внж португалии'));
  assert.ok(isCleanAnchor('расчёт бюджета переезда'));
  assert.ok(!isCleanAnchor('здесь'));
  assert.ok(!isCleanAnchor('тут'));
  assert.ok(!isCleanAnchor('по ссылке'));
  assert.ok(!isCleanAnchor('Click here'));
  assert.ok(!isCleanAnchor('https://example.com/page'));
  assert.ok(!isCleanAnchor('<script>alert(1)</script>'));
  assert.ok(!isCleanAnchor('а'));
});

ok('fallbackAnchor — derives a 2–4 word anchor from H1', () => {
  const a = fallbackAnchor('Получение ВНЖ Португалии под ключ');
  assert.ok(a.length >= 4 && a.length <= 80, `unexpected anchor: "${a}"`);
});

// ── 3. postValidate: 1–2 на H2, MAX_REPEATS_PER_URL, MIN_SCORE ────
ok('postValidate — enforces min 1 / max 2 links per H2 and per-URL repeats', () => {
  const sectionMeta = [
    { index: 1, h2: 'Section A' },
    { index: 2, h2: 'Section B' },
    { index: 3, h2: 'Section C' },
  ];
  const shortlistByH2 = {
    1: [{ url: 'https://x.com/a', h1: 'A page', score: 0.6 }, { url: 'https://x.com/b', h1: 'B page', score: 0.3 }],
    2: [{ url: 'https://x.com/a', h1: 'A page', score: 0.55 }, { url: 'https://x.com/c', h1: 'C page', score: 0.2 }],
    3: [{ url: 'https://x.com/a', h1: 'A page', score: 0.5 }, { url: 'https://x.com/d', h1: 'D page', score: 0.25 }],
  };
  // LLM "хочет" 3 раза вставить /a — а MAX_REPEATS=2.
  const link_plan = [
    { h2_index: 1, picks: [{ url: 'https://x.com/a', anchor_text: 'купить услугу А', semantic_score: 0.6 }] },
    { h2_index: 2, picks: [{ url: 'https://x.com/a', anchor_text: 'продукт А',       semantic_score: 0.55 }] },
    { h2_index: 3, picks: [{ url: 'https://x.com/a', anchor_text: 'наша услуга А',   semantic_score: 0.5 }] },
  ];
  const out = postValidate({ link_plan, shortlistByH2, sectionMeta });
  // /a usage capped at 2.
  assert.ok((out.url_usage_count['https://x.com/a'] || 0) <= 2, JSON.stringify(out.url_usage_count));
  // Каждый h2 покрыт ≥ 1 ссылкой (3-й auto-filled).
  for (const p of out.link_plan) assert.ok(p.picks.length >= 1, `H2 ${p.h2_index} empty`);
  // Issues содержит url_overused и/или auto_filled.
  assert.ok(out.audit.issues.some((i) => i.kind === 'url_overused'));
  assert.ok(out.audit.issues.some((i) => i.kind === 'auto_filled'));
});

ok('postValidate — replaces blacklisted anchor like «здесь» with fallback', () => {
  const sectionMeta = [{ index: 1, h2: 'Section X' }];
  const shortlistByH2 = { 1: [{ url: 'https://x.com/a', h1: 'Курсы португальского языка', score: 0.6 }] };
  const link_plan = [{ h2_index: 1, picks: [{ url: 'https://x.com/a', anchor_text: 'здесь', semantic_score: 0.6 }] }];
  const out = postValidate({ link_plan, shortlistByH2, sectionMeta });
  const anchor = out.link_plan[0].picks[0].anchor_text;
  assert.notStrictEqual(anchor, 'здесь');
  assert.ok(isCleanAnchor(anchor), `bad replacement anchor: "${anchor}"`);
  assert.ok(out.audit.issues.some((i) => i.kind === 'anchor_replaced'));
});

ok('postValidate — drops invalid LLM-invented URL', () => {
  const sectionMeta = [{ index: 1, h2: 'S' }];
  const shortlistByH2 = { 1: [{ url: 'https://x.com/a', h1: 'A', score: 0.6 }] };
  const link_plan = [{ h2_index: 1, picks: [{ url: 'https://invented.com/fake', anchor_text: 'фейковая ссылка', semantic_score: 0.6 }] }];
  const out = postValidate({ link_plan, shortlistByH2, sectionMeta });
  assert.ok(out.audit.issues.some((i) => i.kind === 'invalid_url'));
  // post-validator должен подставить из shortlist.
  assert.strictEqual(out.link_plan[0].picks[0].url, 'https://x.com/a');
});

ok('postValidate — first pick gets role=primary, second gets role=supporting', () => {
  const sectionMeta = [{ index: 1, h2: 'S' }];
  const shortlistByH2 = { 1: [
    { url: 'https://x.com/a', h1: 'A page about topic', score: 0.7 },
    { url: 'https://x.com/b', h1: 'B page another topic', score: 0.6 },
  ] };
  const link_plan = [{ h2_index: 1, picks: [
    { url: 'https://x.com/a', anchor_text: 'первая ссылка важная', semantic_score: 0.7 },
    { url: 'https://x.com/b', anchor_text: 'вторая ссылка поддержка', semantic_score: 0.6 },
  ] }];
  const out = postValidate({ link_plan, shortlistByH2, sectionMeta });
  assert.strictEqual(out.link_plan[0].picks[0].role, 'primary');
  assert.strictEqual(out.link_plan[0].picks[1].role, 'supporting');
});

// ── 4. auditHtmlAgainstPlan: ground-truth post-render check ────────
ok('auditHtmlAgainstPlan — pass when all links inserted correctly', () => {
  const html = `
    <h1>Title</h1>
    <h2>Юридические требования</h2>
    <p>Подробнее в нашем материале о <a href="https://x.com/vnzh">получении ВНЖ</a> с пошаговым планом.</p>
    <h2>Стоимость переезда</h2>
    <p>Мы рассчитали бюджет в нашем <a href="https://x.com/budget">калькуляторе бюджета</a>.</p>
  `;
  const link_plan = [
    { h2_index: 1, h2_text: 'Юридические требования',
      picks: [{ url: 'https://x.com/vnzh',   anchor_text: 'получении ВНЖ' }] },
    { h2_index: 2, h2_text: 'Стоимость переезда',
      picks: [{ url: 'https://x.com/budget', anchor_text: 'калькуляторе бюджета' }] },
  ];
  const r = auditHtmlAgainstPlan({ html, link_plan });
  assert.strictEqual(r.coverage_pct, 100);
  assert.strictEqual(r.misplacements.length, 0);
  assert.strictEqual(r.extras.length, 0);
  assert.strictEqual(r.verdict, 'pass');
});

ok('auditHtmlAgainstPlan — flags misplacement when link is in wrong H2', () => {
  const html = `
    <h1>T</h1>
    <h2>A</h2>
    <p>Text with <a href="https://x.com/budget">бюджет</a>.</p>
    <h2>B</h2>
    <p>Text with <a href="https://x.com/vnzh">ВНЖ</a>.</p>
  `;
  const link_plan = [
    { h2_index: 1, h2_text: 'A', picks: [{ url: 'https://x.com/vnzh',   anchor_text: 'ВНЖ' }] },
    { h2_index: 2, h2_text: 'B', picks: [{ url: 'https://x.com/budget', anchor_text: 'бюджет' }] },
  ];
  const r = auditHtmlAgainstPlan({ html, link_plan });
  assert.strictEqual(r.misplacements.length, 2);
  assert.notStrictEqual(r.verdict, 'pass');
});

ok('auditHtmlAgainstPlan — flags extras (anchors not in plan, on planned host)', () => {
  const html = `
    <h1>T</h1>
    <h2>A</h2>
    <p>Text <a href="https://x.com/vnzh">ВНЖ</a> + extra <a href="https://x.com/extra">extra</a>.</p>
  `;
  const link_plan = [
    { h2_index: 1, h2_text: 'A', picks: [{ url: 'https://x.com/vnzh', anchor_text: 'ВНЖ' }] },
  ];
  const r = auditHtmlAgainstPlan({ html, link_plan });
  assert.strictEqual(r.extras.length, 1);
});

ok('auditHtmlAgainstPlan — coverage drops when planned link missing', () => {
  const html = `
    <h1>T</h1>
    <h2>A</h2><p>No links here.</p>
    <h2>B</h2><p>No links either.</p>
  `;
  const link_plan = [
    { h2_index: 1, h2_text: 'A', picks: [{ url: 'https://x.com/a', anchor_text: 'a' }] },
    { h2_index: 2, h2_text: 'B', picks: [{ url: 'https://x.com/b', anchor_text: 'b' }] },
  ];
  const r = auditHtmlAgainstPlan({ html, link_plan });
  assert.strictEqual(r.coverage_pct, 0);
  assert.strictEqual(r.missing.length, 2);
});

ok('auditHtmlAgainstPlan — flags repeat violations beyond MAX_REPEATS_PER_URL=2', () => {
  const html = `
    <h1>T</h1>
    <h2>A</h2><p><a href="https://x.com/a">a1</a></p>
    <h2>B</h2><p><a href="https://x.com/a">a2</a></p>
    <h2>C</h2><p><a href="https://x.com/a">a3</a></p>
  `;
  const link_plan = [
    { h2_index: 1, h2_text: 'A', picks: [{ url: 'https://x.com/a', anchor_text: 'a1' }] },
    { h2_index: 2, h2_text: 'B', picks: [{ url: 'https://x.com/a', anchor_text: 'a2' }] },
    { h2_index: 3, h2_text: 'C', picks: [{ url: 'https://x.com/a', anchor_text: 'a3' }] },
  ];
  const r = auditHtmlAgainstPlan({ html, link_plan });
  assert.ok(r.repeat_violations.length >= 1);
});

console.log(process.exitCode ? 'FAILED' : 'OK');
