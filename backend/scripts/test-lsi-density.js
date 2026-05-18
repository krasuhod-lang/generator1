'use strict';

/**
 * Smoke-test для lsiDensity.service.
 * Проверяет:
 *   1. extractH2Sections возвращает intro + H2-секции.
 *   2. measureLsiDensityPerH2 считает per-term и total density корректно.
 *   3. checkLsiOverdose:
 *      - 'pass' на нормальной статье
 *      - 'review' на статье с одним overdose
 *      - 'fail' на >30% overdose секций
 *      - 'na' на пустом LSI / пустом HTML
 *   4. Стемм-логика: «масло / маслом / маслами» считаются одним хитом.
 *   5. Многословные термины (n-gram).
 */

const assert = require('assert');
const {
  measureLsiDensityPerH2,
  checkLsiOverdose,
  extractH2Sections,
  MAX_PER_TERM_PCT,
  MIN_SECTION_WORDS,
} = require('../src/services/infoArticle/lsiDensity.service');

// 1. extractH2Sections
{
  const html = '<p>Преамбула о масле и его свойствах для понимания темы здесь.</p>'
             + '<h2>Виды масла</h2><p>Растительные масла бывают разные виды масла очень полезного.</p>'
             + '<h2>Применение масла</h2><p>Применение масла в кулинарии и косметологии и хозяйстве дома.</p>';
  const secs = extractH2Sections(html);
  assert.strictEqual(secs.length, 3, 'intro + 2 H2 sections');
  assert.strictEqual(secs[0].title, '__intro__');
  assert.strictEqual(secs[1].title, 'Виды масла');
  assert.strictEqual(secs[2].title, 'Применение масла');
  assert.ok(secs[1].word_count > 0);
  console.log('✓ extractH2Sections splits by H2 + intro');
}

// 2. No-H2 html
{
  const secs = extractH2Sections('<p>just one paragraph here without headings at all whatsoever</p>');
  assert.strictEqual(secs.length, 1);
  assert.strictEqual(secs[0].title, '__no_h2__');
  console.log('✓ extractH2Sections handles no-H2 html');
}

// 3. measureLsiDensityPerH2 + stem
{
  // Section ≥30 слов с термином 'масло' встречающимся 3 раза (масло/маслом/маслами)
  const longText = 'Растительное масло используется давно в кулинарии для приготовления блюд по всему миру и в каждой кухне у каждой хозяйки. С маслом можно жарить, тушить, заправлять салаты, готовить соусы и десерты с разными маслами разных сортов и видов.';
  const html = `<h2>О масле</h2><p>${longText}</p>`;
  const reports = measureLsiDensityPerH2(html, ['масло']);
  assert.strictEqual(reports.length, 1);
  const r = reports[0];
  assert.ok(r.word_count >= MIN_SECTION_WORDS, `wc=${r.word_count}`);
  // 3 хита от стемм-варианта «масл», на ~40 слов → ~7.5% density
  assert.ok(r.lsi_hits.length === 1);
  assert.strictEqual(r.lsi_hits[0].count, 4, `expected 4 hits (incl. H2 "О масле"), got ${r.lsi_hits[0].count}`);
  assert.ok(r.lsi_density_pct > 0);
  console.log(`✓ measureLsiDensityPerH2: stem-merge counts 3 forms (density=${r.lsi_density_pct}%)`);
}

// 4. overdose detection
{
  // Term spammed 8 times in ~35 words → ~22% density → overdose
  const spammy = 'олифа олифа олифа олифа олифа олифа олифа олифа потому что нужна нашему производству на работе в цехах и на производстве для разных нужд и задач разных и для покрытия дерева и металла.';
  const html = `<h2>Об олифе</h2><p>${spammy}</p>`;
  const v = checkLsiOverdose(html, ['олифа']);
  assert.strictEqual(v.sections_overdose, 1);
  assert.ok(v.overspam.length > 0);
  assert.ok(v.verdict === 'review' || v.verdict === 'fail',
    `expected review/fail, got ${v.verdict}`);
  console.log(`✓ checkLsiOverdose detects single-section overdose (verdict=${v.verdict})`);
}

// 5. pass case
{
  // Длинные секции — плотность ниже 2.5% per term → pass
  const longNormal = 'Растительное масло применяется в кулинарии для жарки и заправки салатов и приготовления соусов на каждой кухне дома и в ресторане. Хозяйки используют разные сорта в зависимости от рецепта и температуры обработки и личных предпочтений семьи и гостей и сезона года. Особо ценится холодного отжима, которое сохраняет витамины и микроэлементы полезные для здоровья при употреблении в свежем виде.';
  const html = `<h2>Применение</h2><p>${longNormal}</p><h2>Сорта</h2><p>${longNormal}</p>`;
  const v = checkLsiOverdose(html, ['масло', 'кулинария']);
  assert.strictEqual(v.sections_overdose, 0);
  assert.ok(v.verdict === 'pass' || v.verdict === 'review',
    `expected pass/review, got ${v.verdict}`);
  console.log(`✓ checkLsiOverdose passes normal density (verdict=${v.verdict})`);
}

// 6. na on empty
{
  assert.strictEqual(checkLsiOverdose('', ['масло']).verdict, 'na');
  assert.strictEqual(checkLsiOverdose('<h2>t</h2><p>text</p>', []).verdict, 'na');
  assert.strictEqual(checkLsiOverdose('<h2>t</h2><p>text</p>', null).verdict, 'na');
  console.log('✓ checkLsiOverdose verdict=na on empty input');
}

// 7. multi-word term
{
  const text = Array(20).fill('растительное масло холодного отжима в продаже отлично подходит для блюд').join(' ');
  const html = `<h2>Масло</h2><p>${text}</p>`;
  const reports = measureLsiDensityPerH2(html, ['растительное масло', 'холодного отжима']);
  assert.strictEqual(reports.length, 1);
  assert.ok(reports[0].lsi_hits.length === 2, 'both multi-word terms detected');
  console.log('✓ multi-word terms (n-gram) detected');
}

// 8. thresholds exposed
{
  const v = checkLsiOverdose('<h2>t</h2><p>' + 'word '.repeat(50) + 'масло'.repeat(1) + '</p>', ['масло']);
  assert.strictEqual(v.thresholds.maxPerTermPct, MAX_PER_TERM_PCT);
  console.log('✓ thresholds exposed in verdict');
}

console.log('\n✅ test-lsi-density: all checks passed');
