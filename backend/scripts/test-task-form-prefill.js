'use strict';

/**
 * Тесты предзаполнения формы «СЕО-текст» из контекста проекта.
 *
 * Покрывает баги, из-за которых поля «Целевая аудитория», «Ограничения
 * проекта», «Приоритетные типы страниц», «Особенности ниши» и «Факты,
 * цифры, доказательства» оставались пустыми:
 *   1) маппинг контекста проекта в поля формы (buildTaskFormPrefill);
 *   2) «визуально пустые» rich-text значения (`<p></p>`, одинокий «• »),
 *      которые считались заполненными и блокировали автозаполнение.
 *
 * Запуск: node backend/scripts/test-task-form-prefill.js
 */

const assert = require('node:assert');
const { buildTaskFormPrefill } = require('../src/services/projects/taskFormPrefill');
const { isBlankRichText } = require('../src/utils/stripHtmlTags');
const { missingDerivableFields, DERIVABLE_FIELDS } = require('../src/services/tz/tzFieldDeriver');
const { salvageJsonStrings } = require('../src/utils/salvageJson');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

const FULL_CTX = {
  project: {
    id: 'p1',
    name: 'Клиника Аврора',
    site_url: 'https://avrora.example',
    region: 'Москва',
    niche: 'стоматология',
    audience: 'Взрослые 30–55 лет, ищут импланты «под ключ», боятся боли и скрытых доплат.',
    default_year: 2026,
    default_currency: 'RUB',
    pricing_notes: 'Имплант под ключ от 45 000 ₽',
    content_criteria: {
      stop_words: ['лучший', 'дешёвый'],
      required_disclaimers: ['Есть противопоказания, необходима консультация врача'],
      year_policy: 'omit',
      notes: 'Не обещать конкретных сроков лечения',
    },
  },
  brand: { name: 'Аврора', facts: ['20 лет на рынке', '12 врачей с сертификатами'], tone: 'экспертный, спокойный' },
  market: { competitors: ['zub.example', 'smile.example'], top_intent: 'transactional', brand_share: 0.42 },
  signals: {
    gsc: { top_intent: 'transactional', commercial_share: 0.71, brand_share: 0.42 },
    ydx: { top_intent: 'commercial', commercial_share: 0.6 },
    striking_distance: [
      { query: 'импланты под ключ', position: 13, page: 'https://avrora.example/implanty' },
      { query: 'импланты цена', position: 15, page: 'https://avrora.example/implanty' },
    ],
  },
};

console.log('\n§1 buildTaskFormPrefill — полный контекст');

test('заполняет все пять описательных полей + регион и бренд', () => {
  const pf = buildTaskFormPrefill(FULL_CTX);
  assert.strictEqual(pf.input_region, 'Москва');
  assert.strictEqual(pf.input_brand_name, 'Аврора');
  assert.ok(pf.input_target_audience.includes('импланты'), 'ЦА взята из проекта');
  assert.ok(pf.input_niche_features.includes('стоматология'), 'ниша попала в особенности');
  assert.ok(pf.input_project_limits.includes('лучший'), 'стоп-слова попали в ограничения');
  assert.ok(pf.input_page_priorities.trim(), 'приоритетные типы страниц не пустые');
  assert.ok(pf.input_brand_facts.includes('20 лет на рынке'), 'факты бренда попали в поле');
});

test('ограничения включают дисклеймеры, year_policy, тон и заметки', () => {
  const limits = buildTaskFormPrefill(FULL_CTX).input_project_limits;
  assert.ok(limits.includes('противопоказания'), 'дисклеймер');
  assert.ok(limits.includes('year_policy=omit'), 'политика года');
  assert.ok(limits.includes('экспертный'), 'тон бренда');
  assert.ok(limits.includes('сроков лечения'), 'редакционные заметки');
});

test('приоритетные страницы учитывают интент и striking distance', () => {
  const pages = buildTaskFormPrefill(FULL_CTX).input_page_priorities;
  assert.ok(/коммерческие страницы/i.test(pages), 'подсказка по транзакционному интенту');
  assert.ok(pages.includes('/implanty'), 'страница из striking distance');
  assert.strictEqual((pages.match(/implanty/g) || []).length, 1, 'дубликаты страниц схлопнуты');
});

test('факты бренда содержат цены, год и валюту', () => {
  const facts = buildTaskFormPrefill(FULL_CTX).input_brand_facts;
  assert.ok(facts.includes('45 000'), 'ценовой ориентир');
  assert.ok(facts.includes('2026'), 'актуальный год');
  assert.ok(facts.includes('RUB'), 'валюта');
});

console.log('\n§2 buildTaskFormPrefill — граничные случаи');

test('пустой/битый контекст → пустые строки, без исключений', () => {
  for (const ctx of [null, undefined, {}, { project: null }, 'строка', 42]) {
    const pf = buildTaskFormPrefill(ctx);
    assert.strictEqual(typeof pf, 'object');
    for (const v of Object.values(pf)) assert.strictEqual(v, '');
  }
});

test('минимальный проект (только имя и ЦА) не выдумывает данные', () => {
  const pf = buildTaskFormPrefill({
    project: { id: 'p2', name: 'Ромашка', audience: 'Малый бизнес' },
    brand: { name: null, facts: [] },
  });
  assert.strictEqual(pf.input_target_audience, 'Малый бизнес');
  assert.strictEqual(pf.input_brand_name, 'Ромашка', 'бренд берётся из имени проекта');
  assert.strictEqual(pf.input_niche_features, '');
  assert.strictEqual(pf.input_project_limits, '');
  assert.strictEqual(pf.input_page_priorities, '');
  assert.strictEqual(pf.input_brand_facts, '');
});

test('brand_share нормализуется: 0.42 и 42 читаются одинаково', () => {
  const asFraction = buildTaskFormPrefill({
    project: { id: 'p3', name: 'X' }, market: { brand_share: 0.42 },
  }).input_niche_features;
  const asPercent = buildTaskFormPrefill({
    project: { id: 'p3', name: 'X' }, market: { brand_share: 42 },
  }).input_niche_features;
  assert.ok(asFraction.includes('42%'), `ожидали 42%, получили: ${asFraction}`);
  assert.ok(asPercent.includes('42%'), `ожидали 42%, получили: ${asPercent}`);
  assert.ok(/брендовый/.test(asFraction) && /брендовый/.test(asPercent),
    'вывод про брендовый спрос одинаков для доли и процента');
});

test('значения обрезаются по лимиту поля', () => {
  const pf = buildTaskFormPrefill({
    project: { id: 'p4', name: 'X', audience: 'а'.repeat(9000) },
  });
  assert.ok(pf.input_target_audience.length <= 4000, 'ЦА обрезана');
});

console.log('\n§3 isBlankRichText — «визуально пустые» поля');

test('пустой TipTap и одинокий маркер считаются пустыми', () => {
  for (const v of [null, undefined, '', '   ', '<p></p>', '<p><br></p>', '• ', '•', '<ul><li></li></ul>', '<p>&nbsp;</p>']) {
    assert.strictEqual(isBlankRichText(v), true, `ожидали blank для ${JSON.stringify(v)}`);
  }
});

test('реальный контент пустым не считается', () => {
  for (const v of ['<p>Взрослые 30–55 лет</p>', '• Опыт 20 лет', 'текст', '<img src="x.png">']) {
    assert.strictEqual(isBlankRichText(v), false, `ожидали НЕ blank для ${JSON.stringify(v)}`);
  }
});

console.log('\n§4 tzFieldDeriver — какие поля дожимать');

test('пустые/отсутствующие поля ТЗ попадают в список на вывод', () => {
  assert.deepStrictEqual(missingDerivableFields({}), DERIVABLE_FIELDS);
  assert.deepStrictEqual(
    missingDerivableFields({ target_audience: '  ', niche_features: [], constraints: ['   '] }),
    DERIVABLE_FIELDS,
  );
});

test('заполненные поля не переписываются', () => {
  const missing = missingDerivableFields({
    target_audience: 'Владельцы квартир',
    niche_features: ['высокая конкуренция'],
  });
  assert.ok(!missing.includes('target_audience'));
  assert.ok(!missing.includes('niche_features'));
  assert.ok(missing.includes('constraints'));
  assert.ok(missing.includes('priority_page_types'));
});

console.log('\n§5 salvageJsonStrings — обрезанный ответ LLM');

const KEYS = ['target_audience', 'niche_features', 'brand_facts', 'project_constraints', 'priority_page_types'];

test('целый JSON разбирается как есть', () => {
  const raw = JSON.stringify({
    target_audience: 'Владельцы квартир',
    niche_features: 'Высокая конкуренция',
    brand_facts: 'Боли: цена\nВозражения: сроки',
    project_constraints: 'Не обещать гарантий',
    priority_page_types: 'Коммерческие страницы',
  });
  const out = salvageJsonStrings(raw, KEYS);
  assert.strictEqual(out.target_audience, 'Владельцы квартир');
  assert.ok(out.brand_facts.includes('\n'), 'экранированный перенос строки раскодирован');
  assert.strictEqual(out.priority_page_types, 'Коммерческие страницы');
});

test('обрезанный ответ: забираем всё, что модель успела написать', () => {
  const raw = '{"target_audience":"Владельцы квартир","niche_features":"YMYL-ниша","brand_facts":"Боли: цена и сроки, клиенты боятся скрытых доплат';
  const out = salvageJsonStrings(raw, KEYS);
  assert.strictEqual(out.target_audience, 'Владельцы квартир');
  assert.strictEqual(out.niche_features, 'YMYL-ниша');
  assert.ok(out.brand_facts.startsWith('Боли:'), 'незакрытое значение тоже спасено');
  assert.ok(!('project_constraints' in out), 'чего нет — не выдумываем');
});

test('мусор и пустота → null', () => {
  assert.strictEqual(salvageJsonStrings('', KEYS), null);
  assert.strictEqual(salvageJsonStrings(null, KEYS), null);
  assert.strictEqual(salvageJsonStrings('Извините, не могу помочь', KEYS), null);
  assert.strictEqual(salvageJsonStrings('{"target_audience":"   "}', KEYS), null);
});

console.log(failed ? `\n${failed} тест(ов) упало` : '\nВсе тесты прошли');
if (failed) process.exitCode = 1;
