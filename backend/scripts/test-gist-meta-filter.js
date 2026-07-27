'use strict';

/**
 * Smoke-тесты GIST Meta Filter Pipeline (Задача D) — детерминированные части
 * без сети/LLM: кириллические лимиты, template-level conflict (Step 8.11),
 * контракты промптов и экспорт generateLinkArticleMeta.
 *
 * Запуск: node scripts/test-gist-meta-filter.js
 */

const assert = require('assert');
const {
  runGistMetaPipeline,
  generateLinkArticleMeta,
  checkTemplateLevelConflict,
  _pickBestPairAttempt,
  _buildCompetitorNoiseBlock,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX,
  DESC_MOBILE_MIN, DESC_MOBILE_MAX,
  TITLE_FACT_WINDOW, DESC_FACT_WINDOW,
} = require('../src/services/metaTags/gistMetaFilter');
const prompts = require('../src/services/metaTags/gistMetaPrompts');
const lengthConfig = require('../src/services/metaTags/lengthConfig');
const metaGenerator = require('../src/services/metaTags/metaGenerator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    failed += 1;
  }
}

test('кириллические коридоры: Title цель 60–70 (max 80), Desc цель 150–170 (max 190), mobile 90–105', () => {
  assert.strictEqual(TITLE_MIN, 60);
  assert.strictEqual(TITLE_MAX, 80);
  assert.strictEqual(DESC_MIN, 150);
  assert.strictEqual(DESC_MAX, 190);
  assert.strictEqual(DESC_MOBILE_MIN, 90);
  assert.strictEqual(DESC_MOBILE_MAX, 105);
  assert.strictEqual(TITLE_FACT_WINDOW, 35);
  assert.strictEqual(DESC_FACT_WINDOW, 90);
});

test('lengthConfig — единая точка правды для длин', () => {
  assert.strictEqual(lengthConfig.TITLE_TARGET_MIN, 60);
  assert.strictEqual(lengthConfig.TITLE_TARGET_MAX, 70);
  assert.strictEqual(lengthConfig.DESC_TARGET_MIN, 150);
  assert.strictEqual(lengthConfig.DESC_TARGET_MAX, 170);
  assert.ok(lengthConfig.TITLE_TARGET_MAX <= lengthConfig.TITLE_MAX);
  assert.ok(lengthConfig.DESC_TARGET_MAX <= lengthConfig.DESC_MAX);
  const ranges = lengthConfig.describeLengthRanges();
  assert.strictEqual(ranges.title.target_min, 60);
  assert.strictEqual(ranges.title.hard_max, 80);
  assert.strictEqual(ranges.description.target_max, 170);
  assert.strictEqual(ranges.description.hard_max, 190);
  assert.strictEqual(ranges.description_mobile.target_min, 90);
});

test('metaGenerator использует те же кириллические лимиты', () => {
  assert.strictEqual(metaGenerator.TITLE_MIN, TITLE_MIN);
  assert.strictEqual(metaGenerator.TITLE_MAX, TITLE_MAX);
  assert.strictEqual(metaGenerator.DESC_MIN, DESC_MIN);
  assert.strictEqual(metaGenerator.DESC_MAX, DESC_MAX);
});

test('Step 8.11: доминирующий фактор в >70% title → conflict', () => {
  const titles = [
    'Ковролин с защитой от влаги — гарантия 5 лет',
    'Линолеум с защитой от влаги для кухни | 2 мм',
    'Ламинат с защитой от влаги 33 класс — замер 0 ₽',
    'Паркет с защитой от влаги — монтаж за 1 день',
  ];
  const res = checkTemplateLevelConflict(titles);
  assert.strictEqual(res.passed, false);
  assert.ok(res.dominant_factor, 'dominant_factor должен быть найден');
  assert.ok(res.share > 0.7, `share=${res.share}`);
});

test('Step 8.11: варьирующийся атрибут — конфликта нет', () => {
  const titles = [
    'Ковролин из шерсти — ворс 8 мм, сертификат ЕАС',
    'Линолеум 43 класса для склада | нагрузка 500 кг',
    'Ламинат с фаской 4V — монтаж без клея за день',
    'Паркет из дуба 15 мм — укладка ёлочкой',
  ];
  const res = checkTemplateLevelConflict(titles);
  assert.strictEqual(res.passed, true);
  assert.strictEqual(res.dominant_factor, null);
});

test('Step 8.11: меньше 3 title — проверка не применяется', () => {
  const res = checkTemplateLevelConflict(['Один тайтл', 'Второй тайтл']);
  assert.strictEqual(res.passed, true);
});

test('промпты: 4 DSPy-модуля с ключевыми шагами и контрактами', () => {
  assert.match(prompts.CANDIDATE_GENERATOR_SYSTEM, /Step 8\.1/);
  assert.match(prompts.CANDIDATE_GENERATOR_SYSTEM, /Step 8\.4/);
  assert.match(prompts.CANDIDATE_GENERATOR_SYSTEM, /failure_mode/);
  assert.match(prompts.CANDIDATE_GENERATOR_SYSTEM, /quantifiable/);
  assert.match(prompts.FILTER_RANKER_SYSTEM, /Step 8\.5b/);
  assert.match(prompts.FILTER_RANKER_SYSTEM, /fallback_supercategory/);
  assert.match(prompts.FILTER_RANKER_SYSTEM, /manual_review_required/);
  assert.match(prompts.FILTER_RANKER_SYSTEM, /intent_specificity/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /60–70 символов/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /150–170 символов/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /максимум — 80 символов/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /максимум —\s*\n?\s*190/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /в первых 35 символах/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /НАЧИНАЕТСЯ с главного поискового запроса/);
  // v4.1: блок LSI переформулирован как приоритеты (анти-стаффинг), см. Шаг 6 ТЗ.
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /LSI — ПРИОРИТЕТЫ, А НЕ ОБЯЗАТЕЛЬСТВА/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /ВАЖНЕЕ 100% покрытия LSI/);
  assert.match(prompts.CANDIDATE_GENERATOR_SYSTEM, /главным поисковым запросом/);
  assert.match(prompts.CONFLICT_CHECKER_SYSTEM, /Step 8\.9/);
  assert.match(prompts.CONFLICT_CHECKER_SYSTEM, /Step 8\.10/);
  assert.match(prompts.CONFLICT_CHECKER_SYSTEM, /replaceability_check/);
});

test('антипаттерны (§7) зафиксированы в промптах', () => {
  assert.match(prompts.ANTI_PATTERNS, /абстрактные слова/);
  assert.match(prompts.ANTI_PATTERNS, /всей категории/);
  assert.match(prompts.ANTI_PATTERNS, /CTA-паттерна/);
  assert.match(prompts.ANTI_PATTERNS, /standalone/);
});

test('checkLsiUsage: нормализованные LSI (стеммы) засчитываются по словоформам текста', () => {
  const { checkLsiUsage } = require('../src/services/metaTags/semantics');
  // LSI приходят уже нормализованными из extractSemantics: «дебетов», «покупк».
  // Повторный стемминг («дебетов» → «дебет») не должен ломать сверку со
  // словоформой из текста («дебетовая» → «дебетов»).
  const text = 'Дебетовая карта банка: кешбэк 10% на покупки, бонусы за банковские операции картой';
  const res = checkLsiUsage(text, ['дебетов', 'карт', 'бонус', 'покупк', 'банковск', 'кешбэк']);
  assert.deepStrictEqual(res.missed_lsi, [], `missed: ${res.missed_lsi.join(', ')}`);
  assert.strictEqual(res.used_lsi.length, 6);
});

test('checkLsiUsage: реально отсутствующие LSI попадают в missed', () => {
  const { checkLsiUsage } = require('../src/services/metaTags/semantics');
  const res = checkLsiUsage('Дебетовая карта банка', ['кешбэк', 'карт']);
  assert.deepStrictEqual(res.missed_lsi, ['кешбэк']);
  assert.deepStrictEqual(res.used_lsi, ['карт']);
});

test('экспорт: runGistMetaPipeline / generateLinkArticleMeta — функции', () => {
  assert.strictEqual(typeof runGistMetaPipeline, 'function');
  assert.strictEqual(typeof generateLinkArticleMeta, 'function');
  assert.strictEqual(typeof metaGenerator.generateDrMaxMeta, 'function');
  const gist = require('../src/services/metaTags/gistMetaFilter');
  assert.strictEqual(typeof gist.runResilientMetaPipeline, 'function');
});


test('best-of: прошедшая проверки попытка выигрывает у более кликабельной', () => {
  const best = _pickBestPairAttempt([
    { id: 'a', passed: false, ctrScore: 90 },
    { id: 'b', passed: true, ctrScore: 61 },
  ]);
  assert.strictEqual(best.id, 'b');
});

test('best-of: при равном статусе выигрывает CTR-скор, а не порядок', () => {
  const best = _pickBestPairAttempt([
    { id: 'first', passed: true, ctrScore: 78 },
    { id: 'last', passed: true, ctrScore: 55 },
  ]);
  assert.strictEqual(best.id, 'first');
});

test('best-of: единственная/пустая серия попыток не ломает выбор', () => {
  assert.strictEqual(_pickBestPairAttempt([]), null);
  assert.strictEqual(_pickBestPairAttempt(null), null);
  const only = _pickBestPairAttempt([{ id: 'x', passed: false, ctrScore: 10 }]);
  assert.strictEqual(only.id, 'x');
});

test('COMPETITOR_NOISE: клише запрещены, лексика ниши разрешена как обычные слова', () => {
  const block = _buildCompetitorNoiseBlock({
    competitor_cliches: ['индивидуальный подход к каждому'],
    niche_lexicon: ['кредит наличными'],
    cta_patterns: ['узнайте'],
    dominant_title_pattern: 'plain',
  });
  assert.match(block, /ЗАПРЕЩЕНО повторять: индивидуальный подход/);
  assert.match(block, /Частотная лексика ниши.*кредит наличными/);
  assert.match(block, /НЕ как дифференциатор/);
});

test('COMPETITOR_NOISE: пустой анализ не даёт пустого блока', () => {
  assert.strictEqual(_buildCompetitorNoiseBlock(null), '');
  assert.strictEqual(_buildCompetitorNoiseBlock({ competitor_cliches: [], niche_lexicon: [] }), '');
});

test('PAIR_ASSEMBLER: запрет мета-речи и few-shot «плохо → хорошо»', () => {
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /мета-речь/i);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /мы не выдаём/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /отсеиваем рекламный шум/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /ПРИМЕРЫ «ПЛОХО → ХОРОШО»/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /ПРАВИЛА ПОД ИНТЕНТ/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /SERP_INTENT/);
  // Структура «что получает → чем подтверждается → одно действие».
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /что человек получает/);
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /ОДНО действие в конце/);
  // Гвард по цене должен быть в самом промпте, а не только в пост-валидации.
  assert.match(prompts.PAIR_ASSEMBLER_SYSTEM, /price_data = null/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
