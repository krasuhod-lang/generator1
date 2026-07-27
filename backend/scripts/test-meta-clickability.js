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
  buildPageAngle, buildMissingNodes, buildAvoidPatterns, enrichMetaInputs,
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

  const snippetAnalysis = { competitor_cliches: ['лучшие цены в городе'], competitor_noise: ['лучшие цены в городе'] };
  const nodes = buildMissingNodes({ inputs, semantics, ctrAnalysis });
  check('missingNodes не пустые', nodes.length > 0);
  check('missingNodes ≤ 8', nodes.length <= 8);
  check('в missingNodes попали уникальные LSI',
    nodes.some((n) => n.includes('теплопакет')));
  check('в missingNodes попал пробел по цене',
    nodes.some((n) => n.includes('12 000')));
  // Ключевая правка: анти-паттерны и штампы ТОПа — это НЕ факты-кандидаты,
  // иначе LLM берёт «отсеиваем рекламный шум» в текст описания.
  check('анти-паттернов НЕТ среди missingNodes',
    !nodes.some((n) => n.includes('Анти-паттерны') || n.includes('Штампы ТОПа')));
  check('запретов на повтор фраз конкурентов НЕТ среди missingNodes',
    !nodes.some((n) => n.toLowerCase().includes('не повторя')));

  const avoid = buildAvoidPatterns({ ctrAnalysis, snippetAnalysis });
  check('avoidPatterns не пустые', avoid.length > 0);
  check('в avoidPatterns попали анти-паттерны ТОПа',
    avoid.some((n) => n.includes('Анти-паттерны')));
  check('в avoidPatterns попали клише конкурентов',
    avoid.some((n) => n.includes('лучшие цены в городе')));

  const enriched = enrichMetaInputs({
    keyword: 'пластиковые окна', inputs, semantics, ctrAnalysis,
  });
  check('enrichMetaInputs проставил pageAngle', !!enriched.pageAngle);
  check('enrichMetaInputs проставил missingNodes', (enriched.missingNodes || []).length > 0);
  check('enrichMetaInputs проставил avoidPatterns', Array.isArray(enriched.avoidPatterns));

  const preset = enrichMetaInputs({
    keyword: 'пластиковые окна',
    inputs: { ...inputs, pageAngle: 'ручной угол', missingNodes: ['ручной узел'] },
    semantics, ctrAnalysis,
  });
  check('явно заданные pageAngle/missingNodes не перетираются',
    preset.pageAngle === 'ручной угол' && preset.missingNodes[0] === 'ручной узел');
}

// ── §8: слияние расхода при автоперегенерации ─────────────────────
{
  console.log('\n§8 — mergeUsageMeta (расход обеих версий):');
  const { mergeUsageMeta } = require('../src/services/metaTags/metaStages');

  const merged = mergeUsageMeta(
    { tokensIn: 1000, tokensOut: 300, thoughtsTokens: 50, cachedTokens: 10, attempts: 2, model: 'a', provider: 'gemini' },
    { tokensIn: 900, tokensOut: 250, thoughtsTokens: 40, cachedTokens: 5, attempts: 1, model: 'b', provider: 'gemini' },
  );
  check('токены обеих версий суммируются',
    merged.tokensIn === 1900 && merged.tokensOut === 550);
  check('thoughts/cached/attempts суммируются',
    merged.thoughtsTokens === 90 && merged.cachedTokens === 15 && merged.attempts === 3);
  check('провайдер сохраняется, если он один', merged.provider === 'gemini');
  check('модель берётся от последнего прогона', merged.model === 'b');

  const mixed = mergeUsageMeta(
    { tokensIn: 10, tokensOut: 5, provider: 'gemini' },
    { tokensIn: 20, tokensOut: 5, provider: 'deepseek' },
  );
  check('разные провайдеры → mixed', mixed.provider === 'mixed');

  const noCost = mergeUsageMeta({ tokensIn: 10 }, { tokensOut: 5 });
  check('без costUsd поле остаётся пустым (стоимость посчитает фасад)',
    noCost.costUsd === undefined);

  const oneSide = mergeUsageMeta(undefined, { tokensIn: 7, tokensOut: 3 });
  check('пустой первый прогон не ломает слияние',
    oneSide.tokensIn === 7 && oneSide.tokensOut === 3);
}


// ── §9: CTA-лексикон, price-guard и стоп-слова ────────────────────
{
  console.log('\n§9 — CTA-лексикон (ложные −15 баллов и лишние перегенерации):');

  // Реальные дескрипшены из фидбека: раньше hasCta() возвращал false и
  // сниппет терял 15 баллов CTR-скора, уходя на перегенерацию впустую.
  const ctaPositives = [
    'Сравните условия по 40 программам.',
    'Сравнить условия.',
    'Подберите программу под свой бюджет.',
    'Заполните одну анкету на все банки.',
    'Оцените шансы на одобрение.',
    'Проверьте требования банка.',
    'Читайте разбор условий.',
    'Изучите таблицу ставок.',
    'Рассчитайте платёж в калькуляторе.',
    'Оформите заявку онлайн.',
    'Смотрите подробные условия.',
    'Узнать сумму переплаты.',
  ];
  ctaPositives.forEach((text) => {
    check(`hasCta: «${text}»`, hasCta(text) === true);
  });

  // Ложных срабатываний быть не должно: однокоренные существительные и
  // прошедшее время — это не призыв к действию.
  const ctaNegatives = [
    'Оценка залога проводится банком.',
    'Кредиты без проверок кредитной истории.',
    'Наш помощник сравнил предложения Москвы.',
    'Сравнение условий по 40 банкам в одной таблице.',
    'Программа подбора работает по 12 параметрам.',
    'Оформление занимает один день.',
  ];
  ctaNegatives.forEach((text) => {
    check(`hasCta НЕ срабатывает: «${text}»`, hasCta(text) === false);
  });
}

{
  console.log('\n§9 — price-guard: границы слова (цена ≠ оценка/процент):');
  const { findHardViolations } = require('../src/services/metaTags/metaGenerator');

  const noPrice = { price_data: null };
  const falsePositives = [
    'Кредиты без оценки прошлого и лишних проверок заёмщика.',
    'Сравнение по проценту одобрения и сроку рассмотрения.',
    'Ценность сервиса — в прозрачности условий отбора.',
    'Рубрика с разбором программ господдержки.',
    'Оценить шансы можно за минуту.',
  ];
  falsePositives.forEach((desc) => {
    const v = findHardViolations({ title: 'Кредиты', description: desc }, noPrice);
    check(`price-guard молчит: «${desc.slice(0, 42)}…»`,
      !v.some((x) => /price_data/i.test(x)));
  });

  const realViolations = [
    'Цена подбора — 0 рублей для заёмщика.',
    'Стоимость обслуживания карты указана в таблице.',
    'Программы от 3000 ₽ в месяц.',
  ];
  realViolations.forEach((desc) => {
    const v = findHardViolations({ title: 'Кредиты', description: desc }, noPrice);
    check(`price-guard ловит: «${desc.slice(0, 42)}…»`,
      v.some((x) => /price_data/i.test(x)));
  });
}

{
  console.log('\n§9 — стоп-слова стеммируются (котор/можн/лет не попадают в LSI):');
  const { normalizeWord, STOP_WORDS } = require('../src/services/metaTags/semantics');

  ['который', 'которые', 'можно', 'лучший', 'больше', 'также', 'наш', 'нужно'].forEach((w) => {
    check(`стоп-слово отсеивается после стемминга: «${w}»`,
      STOP_WORDS.has(normalizeWord(w)));
  });
  ['кредит', 'ставка', 'заёмщик', 'одобрение', 'студент'].forEach((w) => {
    check(`значимое слово НЕ считается стоп-словом: «${w}»`,
      !STOP_WORDS.has(normalizeWord(w)));
  });
}


// ── §10: человеческие заметки пост-валидации ──────────────────────
{
  console.log('\n§10 — metaNotes: русификация причин и группировка заметок:');
  const { humanizeReviewReason, classifyNotes } = require('../src/services/metaTags/metaNotes');

  // Реальный дамп ranker'а из фидбека: в UI он бесполезен.
  const raw = 'No candidate passed all GIST Meta Filter tests (concreteness, '
    + 'decision_relevance, replaceability, verifiability). The only surviving '
    + 'candidate (missing_node) failed replaceability. Fallback sequence did not '
    + 'yield a valid GIST factor: relax_verifiability requires '
    + 'concreteness+decision_relevance+replaceability all 1, no candidate '
    + 'qualifies; no supercategory or structural facts available. Manual review required.';
  const human = humanizeReviewReason(raw);
  check('английский дамп ranker\'а переведён', /[а-яё]/i.test(human));
  check('в переводе нет сырых английских терминов',
    !/replaceability|relax_verifiability|supercategory/i.test(human));
  check('перевод объясняет, что делать', human.includes('Что делать'));
  check('перевод короче исходного дампа', human.length < raw.length);

  check('русская причина остаётся как есть',
    humanizeReviewReason('Ни один кандидат не прошёл отбор') === 'Ни один кандидат не прошёл отбор');
  check('пустая причина → пустая строка', humanizeReviewReason(null) === '');
  check('незнакомая английская причина помечается технической',
    /техническая причина/.test(humanizeReviewReason('weird ranker output')));

  const report = classifyNotes([
    '⚠️ Guard: price_data отсутствует: запрещены цена, стоимость, руб и ₽.',
    'Рекомендация: не использованы LSI приоритета 1: ставка.',
    'CTR-скор первой версии 50/100 — выполнена перегенерация (итог 63/100).',
    '⚠️ Пара не прошла все проверки за отведённые попытки — требуется ручная правка.',
  ]);
  check('ошибки отделены от остального', report.errors.length === 2);
  check('рекомендации отделены', report.recommendations.length === 1
    && report.recommendations[0].startsWith('Рекомендация'));
  check('информационные заметки — в warnings', report.warnings.length === 1);
  check('плоский список сохранён для совместимости', report.all.length === 4);
  check('пустой вход не ломает группировку',
    classifyNotes(null).errors.length === 0 && classifyNotes(null).all.length === 0);
}

// ── §11: competitor_noise — клише против лексики ниши ─────────────
{
  console.log('\n§11 — snippetAnalyzer: клише (запрет) vs лексика ниши (можно):');
  const { analyzeSnippets } = require('../src/services/metaTags/snippetAnalyzer');

  // «кредит наличными» встречается у 2 из 6 — это лексика ниши, а не клише,
  // и запрещать её нельзя: без неё дескрипшен теряет смысл.
  const serp = [
    { title: 'Кредит наличными в Москве', snippet: 'Кредит наличными на любые цели. Индивидуальный подход к каждому клиенту.' },
    { title: 'Кредит наличными онлайн', snippet: 'Кредит наличными без справок. Индивидуальный подход к каждому клиенту.' },
    { title: 'Взять кредит в банке', snippet: 'Ставка от 5%. Индивидуальный подход к каждому клиенту.' },
    { title: 'Кредиты для всех', snippet: 'Оформите заявку онлайн за 5 минут.' },
    { title: 'Займы и кредиты', snippet: 'Оформите заявку онлайн и получите решение.' },
    { title: 'Потребительский кредит', snippet: 'Срок до 7 лет, сумма до 5 млн.' },
  ];
  const res = analyzeSnippets(serp);
  check('analyzeSnippets вернул competitor_cliches', Array.isArray(res.competitor_cliches));
  check('analyzeSnippets вернул niche_lexicon', Array.isArray(res.niche_lexicon));
  check('competitor_noise остаётся синонимом клише (обратная совместимость)',
    JSON.stringify(res.competitor_noise) === JSON.stringify(res.competitor_cliches));
  const cliches = res.competitor_cliches.join(' | ').toLowerCase();
  check('клише из 3+ сниппетов попало в запрет', cliches.includes('индивидуальный подход'));
  check('фраза из 2 сниппетов НЕ попала в жёсткий запрет',
    !cliches.includes('кредит наличными'));
}

console.log(`\n✅ Все проверки пройдены: ${passed}`);
