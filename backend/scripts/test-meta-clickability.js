'use strict';

/**
 * test-meta-clickability — юнит-тесты ТЗ «Максимальная кликабельность
 * мета-тегов» (SEO Genius v4.1):
 *   §5 CTA-safe сжатие длины (lengthHelpers + postValidate + _deterministicPairFix)
 *   §7 нормализация года (detectYear)
 *   §8 детерминированный CTR-скор сниппета
 *   §4 сборка pageAngle / missingNodes
 *
 * Без сети и без LLM. Запуск: node backend/scripts/test-meta-clickability.js
 */

const assert = require('assert');

const {
  splitCta, hasCta, compressPreservingCta,
} = require('../src/services/metaTags/lengthHelpers');
const { snippetCtrScore } = require('../src/services/metaTags/ctrScore');
const {
  buildPageAngle, buildMissingNodes, enrichMetaInputs,
} = require('../src/services/metaTags/metaContext');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CURRENT_YEAR = new Date().getFullYear();

// ── §5: CTA-safe сжатие ───────────────────────────────────────────
console.log('§5 — сжатие Description с сохранением CTA:');

{
  const desc = 'Монтаж вентиляции под ключ за 3 дня с гарантией 5 лет и '
    + 'проектом от инженера с допуском СРО, включая пусконаладку оборудования '
    + 'и обучение персонала на объекте заказчика. Закажите бесплатный расчёт.';
  check('исходная строка длиннее 190 симв.', desc.length > 190);

  const { body, cta } = splitCta(desc);
  check('CTA отделяется от тела', cta === 'Закажите бесплатный расчёт.' && body.length > 0);

  const res = compressPreservingCta(desc, 190);
  check('после сжатия ≤190 символов', res.text.length <= 190);
  check('CTA сохранён в конце', res.cta_preserved && /Закажите бесплатный расчёт\.$/.test(res.text));
}

{
  // Без CTA — деградируем до обычной обрезки, ничего не ломаем.
  const desc = 'A'.repeat(120) + '. ' + 'B'.repeat(120) + '.';
  const res = compressPreservingCta(desc, 190);
  check('без CTA сжатие всё равно укладывается в лимит', res.text.length <= 190);
  check('без CTA флаг cta_preserved=false', res.cta_preserved === false);
}

{
  const short = 'Ремонт квартир под ключ. Звоните.';
  const res = compressPreservingCta(short, 190);
  check('короткая строка не изменяется', res.text === short && res.cta_preserved === true);
  check('hasCta распознаёт побудительную конструкцию', hasCta(short) === true);
  check('hasCta не срабатывает на нейтральном тексте', hasCta('Просто описание услуги.') === false);
}

// postValidate: CTA не должен вылетать при обрезке.
{
  const { postValidate } = require('../src/services/metaTags/metaGenerator');
  const result = {
    title: 'T'.repeat(120),
    description: 'Устанавливаем окна за 1 день с гарантией 10 лет по договору '
      + 'с фиксированной ценой и бесплатным замером в удобное время, '
      + 'без предоплаты и скрытых доплат за монтаж и демонтаж старых рам, '
      + 'с вывозом мусора и уборкой помещения. Оставьте заявку сегодня.',
    h1: 'H1 страницы',
  };
  check('description для теста длиннее лимита', result.description.length > 190);
  postValidate(result, { brand: '' });
  check('postValidate: Title ≤ 80', result.title.length <= 80);
  check('postValidate: Description ≤ 190', result.description.length <= 190);
  check('postValidate: CTA сохранён', /Оставьте заявку сегодня\.$/.test(result.description));
}

// _deterministicPairFix (GIST-ветка) — та же гарантия.
{
  const { _deterministicPairFix } = require('../src/services/metaTags/gistMetaFilter');
  const pair = {
    title: 'Заголовок '.repeat(12),
    description: 'Поставляем промышленные насосы с ресурсом 40 000 часов и '
      + 'сервисом в 12 регионах, отгрузка со склада за сутки по договору поставки '
      + 'с фиксированной ценой на весь срок. Запишитесь на консультацию.',
    h1: 'H1',
  };
  _deterministicPairFix(pair, []);
  check('GIST-ветка: Title ≤ 80', pair.title.length <= 80);
  check('GIST-ветка: Description ≤ 190', pair.description.length <= 190);
  check('GIST-ветка: CTA сохранён', hasCta(pair.description));
}

// ── §7: нормализация года ─────────────────────────────────────────
console.log('\n§7 — detectYear (жёсткий форс актуального года):');
{
  // Загружаем через отдельный модуль, чтобы не тянуть сеть.
  const metaGenerator = require('../src/services/metaTags/metaGenerator');
  // detectYear не экспортируется наружу — проверяем через generateDrMaxMeta
  // нельзя (сеть), поэтому берём приватную функцию из module scope:
  const detectYear = metaGenerator.detectYear;
  check('detectYear экспортирован', typeof detectYear === 'function');

  check('пусто → текущий год', detectYear([], [], []) === String(CURRENT_YEAR));
  check('прошлый год → текущий', detectYear([`цены ${CURRENT_YEAR - 1}`], [], []) === String(CURRENT_YEAR));
  check('следующий год сохраняется',
    detectYear([`прайс ${CURRENT_YEAR + 1}`], [], []) === String(CURRENT_YEAR + 1));
  check('далёкий будущий год → currentYear + 1',
    detectYear(['тарифы 2099'], [], []) === String(CURRENT_YEAR + 1));
  check('исторический контекст → без года',
    detectYear([], [], [], { keyword: 'история завода в 1954 году' }) === '');
  check('год берётся из title конкурентов',
    detectYear([], [], [{ title: `Купить окна ${CURRENT_YEAR + 1}` }]) === String(CURRENT_YEAR + 1));
}

// ── §8: CTR-скор ──────────────────────────────────────────────────
console.log('\n§8 — snippetCtrScore (детерминированный):');
{
  const strong = snippetCtrScore({
    metas: {
      title: `Монтаж вентиляции в Москве за 3 дня — гарантия 5 лет | ${CURRENT_YEAR}`,
      description: 'Монтаж вентиляции под ключ за 3 дня, гарантия 5 лет по договору, '
        + 'проект от инженера с допуском СРО и фиксированная цена от 45 000 ₽. '
        + 'Закажите бесплатный расчёт.',
      h1: 'Монтаж вентиляции под ключ',
    },
    keyword: 'монтаж вентиляции',
    inputs: { toponym: 'Москва', current_year: String(CURRENT_YEAR) },
  });
  check('сильный сниппет получает высокий скор', strong.score >= 70);
  check('детерминированность: повтор даёт тот же результат',
    snippetCtrScore({
      metas: {
        title: `Монтаж вентиляции в Москве за 3 дня — гарантия 5 лет | ${CURRENT_YEAR}`,
        description: 'Монтаж вентиляции под ключ за 3 дня, гарантия 5 лет по договору, '
          + 'проект от инженера с допуском СРО и фиксированная цена от 45 000 ₽. '
          + 'Закажите бесплатный расчёт.',
        h1: 'Монтаж вентиляции под ключ',
      },
      keyword: 'монтаж вентиляции',
      inputs: { toponym: 'Москва', current_year: String(CURRENT_YEAR) },
    }).score === strong.score);

  const weak = snippetCtrScore({
    metas: {
      title: 'Услуги компании',
      description: 'Мы предлагаем услуги высокого качества.',
      h1: 'Услуги компании',
    },
    keyword: 'монтаж вентиляции',
    inputs: { toponym: 'Москва', brand: 'ВентПро' },
  });
  check('слабый сниппет получает низкий скор', weak.score < strong.score && weak.score < 60);
  check('слабый сниппет помечается needs_review', weak.needs_review === true);
  check('штраф за дубль H1=Title зафиксирован',
    weak.penalties.some((p) => p.name === 'h1_duplicate'));

  const stuffed = snippetCtrScore({
    metas: {
      title: 'Вентиляция вентиляция вентиляция вентиляция вентиляция вентиляция',
      description: 'Вентиляция вентиляция вентиляция вентиляция вентиляция вентиляция вентиляция.',
    },
    keyword: 'вентиляция',
  });
  check('переспам штрафуется',
    stuffed.penalties.some((p) => p.name === 'keyword_stuffing'));
}

// ── §4: pageAngle / missingNodes ──────────────────────────────────
console.log('\n§4 — обогащение inputs (pageAngle / missingNodes):');
{
  const ctrAnalysis = {
    serp_intent: { value: 'Commercial', commercial_frequency: 0.8, informational_frequency: 0.1 },
    patterns: {
      common_prefixes: ['Купить окна'],
      common_suffixes: ['недорого'],
      cta_frequency: 0.1,
      geo_frequency: 0.1,
      year_frequency: 0.1,
      exact_price_title_frequency: 0.0,
    },
  };
  const semantics = { differentiator_lsi: ['теплопакет', 'шумоизоляция'] };
  const inputs = {
    niche: 'пластиковые окна',
    toponym: 'Москва',
    brand: 'ОкнаПро',
    summary: 'Собственное производство, монтаж за 1 день',
    price_data: 'от 12 000 ₽',
    current_year: String(CURRENT_YEAR),
  };

  const angle = buildPageAngle({ keyword: 'пластиковые окна', inputs, ctrAnalysis });
  check('pageAngle содержит нишу', angle.includes('пластиковые окна'));
  check('pageAngle содержит интент', angle.includes('коммерческий'));
  check('pageAngle содержит регион и УТП',
    angle.includes('Москва') && angle.includes('монтаж за 1 день'));

  const nodes = buildMissingNodes({
    inputs, semantics, ctrAnalysis,
    snippetAnalysis: { competitor_noise: ['лучшие цены в городе'] },
  });
  check('missingNodes не пустые', nodes.length > 0);
  check('missingNodes ≤ 8', nodes.length <= 8);
  check('в missingNodes попали уникальные LSI',
    nodes.some((n) => n.includes('теплопакет')));
  check('в missingNodes попал пробел по цене',
    nodes.some((n) => n.includes('12 000')));
  check('в missingNodes попали анти-паттерны',
    nodes.some((n) => n.includes('Анти-паттерны')));

  const enriched = enrichMetaInputs({
    keyword: 'пластиковые окна', inputs, semantics, ctrAnalysis,
  });
  check('enrichMetaInputs проставил pageAngle', !!enriched.pageAngle);
  check('enrichMetaInputs проставил missingNodes', (enriched.missingNodes || []).length > 0);

  const preset = enrichMetaInputs({
    keyword: 'пластиковые окна',
    inputs: { ...inputs, pageAngle: 'ручной угол', missingNodes: ['ручной узел'] },
    semantics, ctrAnalysis,
  });
  check('явно заданные pageAngle/missingNodes не перетираются',
    preset.pageAngle === 'ручной угол' && preset.missingNodes[0] === 'ручной узел');
}

console.log(`\n✅ Все проверки пройдены: ${passed}`);
