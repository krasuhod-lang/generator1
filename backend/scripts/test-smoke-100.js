'use strict';

/**
 * Smoke-100: запускает по 100 случайных прогонов всех новых модулей PR-3..PR-5
 * с псевдослучайными входами, чтобы выловить редкие крэши/edge-cases.
 *
 * Покрытие:
 *   - cachePolicy: 100 разных брендов → нормализация устойчива
 *   - responseCache.buildKey: 100 пар (brand, prompt) → уникальные ключи
 *   - serpEvidence._cacheKey: 100 (brand, query) → уникальные ключи
 *   - lsiDensity.checkLsiOverdose: 100 случайных html-документов + LSI наборов
 *   - personas.pickPersonaFor: 100 случайных задач → детерминизм + покрытие
 *
 * НИКАКИХ внешних вызовов (SERP, LLM, БД) — только модули in-memory.
 *
 * Запуск: node scripts/test-smoke-100.js
 */

const assert = require('assert');

const { getCachePolicy, normalizeBrand } = require('../src/services/llm/cachePolicy');
const cache  = require('../src/services/llm/responseCache');
const serp   = require('../src/services/infoArticle/serpEvidence.service');
const lsi    = require('../src/services/infoArticle/lsiDensity.service');
const personas = require('../src/prompts/infoArticle/personas');

const ITERS = 100;
const failures = [];

function check(label, fn) {
  try { fn(); } catch (e) {
    failures.push({ label, err: e.message });
  }
}

// ── 1) cachePolicy + normalizeBrand устойчивы ─────────────────────────
{
  const seen = new Set();
  for (let i = 0; i < ITERS; i += 1) {
    const brand = `Бренд ${i}_${Math.random().toString(36).slice(2, 6)}`;
    check(`normalizeBrand[${i}]`, () => {
      const n = normalizeBrand(brand);
      assert.ok(n && typeof n === 'string', 'non-empty string');
      assert.strictEqual(n, n.toLowerCase().trim(), 'normalized form');
      seen.add(n);
    });
  }
  console.log(`✓ normalizeBrand: ${ITERS} inputs → ${seen.size} unique normalized forms`);
}

// ── 2) responseCache.buildKey уникальность и стабильность ────────────
{
  const keys = new Set();
  for (let i = 0; i < ITERS; i += 1) {
    const k = cache.buildKey({
      adapter: ['gemini', 'grok', 'deepseek'][i % 3],
      system: `sys ${i}`,
      prompt: `prompt iteration #${i} с разным контентом каждый раз ${Math.random()}`,
      temperature: 0.1 + (i % 9) * 0.1,
      maxTokens:   1024 + i,
      brand:       `Brand-${i % 17}`,
    });
    check(`buildKey[${i}] format`, () => {
      assert.ok(k.startsWith('llmcache:v2:b='), 'v2 brand-aware prefix');
      assert.ok(k.length > 80, 'reasonable length');
    });
    keys.add(k);
  }
  assert.strictEqual(keys.size, ITERS, 'all 100 keys are unique');
  console.log(`✓ responseCache.buildKey: ${ITERS} → ${keys.size} unique keys`);
}

// ── 3) serpEvidence._cacheKey — brand-aware ───────────────────────────
{
  const keys = new Set();
  for (let i = 0; i < ITERS; i += 1) {
    const k = serp._cacheKey({
      query: `какой-то поисковый запрос #${i}`,
      region: `213_${i % 5}`,
      topN: 5, topK: 5, maxChars: 1500,
      brand: `B${i % 13}`,
    });
    keys.add(k);
  }
  // Из-за brand%13 будет ~ collision; но всего вариаций (query × brand) = 100,
  // поэтому keys.size близко к 100. Минимум — 85, на случай редких хэш-коллизий.
  assert.ok(keys.size >= 85, `expected ≥85 unique, got ${keys.size}`);
  console.log(`✓ serpEvidence._cacheKey: ${ITERS} → ${keys.size} unique keys`);
}

// ── 4) lsiDensity.checkLsiOverdose — устойчивость к случайным входам ──
{
  // Берём 6 «реальных» базовых текстов и генерируем вариации.
  const baseTexts = [
    'Кофе обжаривают на разных степенях для разного вкуса и аромата напитка в чашке у каждого любителя дома и в ресторане каждый день.',
    'Растительные удобрения помогают растениям расти лучше и быстрее на огороде и в саду у садоводов по всей стране в каждом регионе.',
    'Сварочные работы требуют соблюдения техники безопасности и правил эксплуатации оборудования на каждом производстве при работе с металлом.',
    'Туристические маршруты выбираются с учётом сезона и физической подготовки участников группы на природе в горах в лесу и у воды.',
    'Финансовое планирование начинается с анализа доходов и расходов семьи за прошлый период в течение года или нескольких месяцев или недели.',
    'Бухгалтерский учёт ведётся в соответствии с законодательством и внутренними регламентами компании для каждой операции и каждой проводки в день.',
  ];
  const baseTerms = [
    ['кофе', 'обжарка', 'аромат'],
    ['удобрение', 'растения', 'огород'],
    ['сварка', 'безопасность', 'металл'],
    ['маршрут', 'природа', 'горы'],
    ['финансы', 'планирование', 'расходы'],
    ['бухгалтерия', 'учёт', 'операция'],
  ];
  const verdicts = { pass: 0, review: 0, fail: 0, na: 0 };
  const statuses = { good: 0, low: 0, overdose: 0, too_short: 0 };

  for (let i = 0; i < ITERS; i += 1) {
    const idx = i % baseTexts.length;
    const base = baseTexts[idx];
    // Различные конфигурации: 1-3 H2, переменное число повторов текста
    const sections = (i % 3) + 1;
    const repeats  = (i % 4) + 1;
    let html = '';
    for (let s = 0; s < sections; s += 1) {
      html += `<h2>Раздел ${s + 1}</h2><p>${Array(repeats).fill(base).join(' ')}</p>`;
    }
    check(`overdose[${i}]`, () => {
      const v = lsi.checkLsiOverdose(html, baseTerms[idx]);
      assert.ok(['pass', 'review', 'fail', 'na'].includes(v.verdict),
        `verdict invalid: ${v.verdict}`);
      assert.ok(Array.isArray(v.per_section));
      assert.ok(typeof v.sections_total === 'number');
      verdicts[v.verdict] += 1;
      for (const ps of v.per_section) {
        statuses[ps.status] = (statuses[ps.status] || 0) + 1;
      }
    });
  }
  console.log(`✓ lsiDensity.checkLsiOverdose: ${ITERS} runs, verdicts =`, verdicts);
  console.log(`  per-section statuses =`, statuses);
}

// ── 5) personas.pickPersonaFor + buildPersonaSystemBlock ──────────────
{
  const dist = new Map();
  for (let i = 0; i < ITERS; i += 1) {
    const topic  = `Тема о ${['А','Б','В','Г','Д'][i % 5]} ${i}`;
    const brand  = `Бренд-${i % 23}`;
    const region = `213_${i % 7}`;
    check(`persona[${i}] determinism`, () => {
      const k1 = personas.pickPersonaFor({ topic, brand, region });
      const k2 = personas.pickPersonaFor({ topic, brand, region });
      assert.strictEqual(k1, k2, 'deterministic');
      const built = personas.buildPersonaSystemBlock({ topic, brand, region });
      assert.strictEqual(built.key, k1);
      assert.ok(built.block.length > 500, 'block substantial');
      assert.ok(/ANTI-HALLUCINATION HARD RULES/.test(built.block));
      dist.set(k1, (dist.get(k1) || 0) + 1);
    });
  }
  // Распределение: ожидаем минимум 5 из 7 персон на 100 случайных входах.
  assert.ok(dist.size >= 5, `expected ≥5 personas, got ${dist.size}`);
  console.log(`✓ personas: ${ITERS} runs, ${dist.size}/7 personas hit, dist =`,
    Object.fromEntries(dist));
}

// ── 6) sweeper не падает ─────────────────────────────────────────────
{
  for (let i = 0; i < 10; i += 1) serp._sweepExpired();
  serp._stopSweeper();
  console.log('✓ serpEvidence sweeper: 10 invocations + stop OK');
}

if (failures.length) {
  console.error(`\n❌ ${failures.length} failures out of ${ITERS * 4 + 30} checks:`);
  for (const f of failures.slice(0, 20)) {
    console.error(`  - [${f.label}] ${f.err}`);
  }
  process.exit(1);
}

console.log('\n✅ test-smoke-100: ALL CHECKS PASSED');
