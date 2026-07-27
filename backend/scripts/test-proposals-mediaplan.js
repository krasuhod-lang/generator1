'use strict';

/**
 * Тесты медиа-плана КП («Фронт работ»):
 *  - buildMediaPlan: свёртка «строка на месяц» → «работа × месяцы»,
 *    группировка по модулям, счётчики, защита от месяцев вне горизонта;
 *  - detectRecurrence / recurrenceLabel: разово / ежемесячно / через месяц / график;
 *  - экспорт PDF и XLSX собирается без ошибок и содержит лист «Медиа-план».
 *
 * Запуск: node backend/scripts/test-proposals-mediaplan.js
 */

const assert = require('assert');
const ExcelJS = require('exceljs');

const {
  buildMediaPlan,
  detectRecurrence,
  recurrenceLabel,
} = require('../src/services/proposals/mediaPlan');
const {
  buildProposalPdf,
  buildProposalXlsx,
  buildPricingTotals,
} = require('../src/services/proposals/exportService');

let passed = 0;
const pending = [];

function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n      ${e.message}`); process.exitCode = 1; }
}
function testAsync(name, fn) {
  pending.push(
    fn().then(
      () => { console.log(`  ok  ${name}`); passed++; },
      (e) => { console.error(`  FAIL ${name}\n      ${e.message}`); process.exitCode = 1; },
    ),
  );
}

const TASKS = [
  { module_id: 1, module_name: 'Технический аудит', task_id: '1.1', task_title: 'Аудит индексации', task_description: 'Проверка robots/sitemap', priority: 'high', tool: 'Screaming Frog', month: 1 },
  { module_id: 1, module_name: 'Технический аудит', task_id: '1.2', task_title: 'Скорость загрузки', task_description: '', priority: 'medium', tool: '', month: 1 },
  { module_id: 1, module_name: 'Технический аудит', task_id: '1.2', task_title: 'Скорость загрузки', task_description: 'CWV', priority: 'medium', tool: 'PSI', month: 3 },
  { module_id: 2, module_name: 'Контент', task_id: '2.1', task_title: 'Публикация статей', task_description: '4 статьи в месяц', priority: 'high', tool: '', month: 1 },
  { module_id: 2, module_name: 'Контент', task_id: '2.1', task_title: 'Публикация статей', task_description: '4 статьи в месяц', priority: 'high', tool: '', month: 2 },
  { module_id: 2, module_name: 'Контент', task_id: '2.1', task_title: 'Публикация статей', task_description: '4 статьи в месяц', priority: 'high', tool: '', month: 3 },
];

const PRICING = [
  { item_name: 'SEO-сопровождение', base_budget: 90000, additional_budget: null, additional_note: null, month: 1, currency: 'RUB' },
  { item_name: 'SEO-сопровождение', base_budget: 90000, additional_budget: 20000, additional_note: 'Ссылки', month: 2, currency: 'RUB' },
  { item_name: 'Разработка', base_budget: 30000, additional_budget: null, additional_note: null, month: null, currency: 'RUB' },
];

test('buildMediaPlan: строки схлопываются в уникальные работы', () => {
  const plan = buildMediaPlan(TASKS, 3);
  assert.strictEqual(plan.total_tasks, 3);
  assert.strictEqual(plan.total_slots, 6);
  assert.deepStrictEqual(plan.months, [1, 2, 3]);
});

test('buildMediaPlan: месяцы работы собираются в массив', () => {
  const plan = buildMediaPlan(TASKS, 3);
  const speed = plan.rows.find((r) => r.task_id === '1.2');
  assert.deepStrictEqual(speed.months, [1, 3]);
  const content = plan.rows.find((r) => r.task_id === '2.1');
  assert.deepStrictEqual(content.months, [1, 2, 3]);
  assert.strictEqual(content.recurrence, 'monthly');
});

test('buildMediaPlan: описание/инструмент подхватываются из любой строки-месяца', () => {
  const plan = buildMediaPlan(TASKS, 3);
  const speed = plan.rows.find((r) => r.task_id === '1.2');
  assert.strictEqual(speed.task_description, 'CWV');
  assert.strictEqual(speed.tool, 'PSI');
});

test('buildMediaPlan: группировка по модулям', () => {
  const plan = buildMediaPlan(TASKS, 3);
  assert.strictEqual(plan.modules.length, 2);
  assert.strictEqual(plan.modules[0].module_name, 'Технический аудит');
  assert.strictEqual(plan.modules[0].rows.length, 2);
  assert.strictEqual(plan.modules[1].rows.length, 1);
});

test('buildMediaPlan: счётчики по месяцам', () => {
  const plan = buildMediaPlan(TASKS, 3);
  assert.deepStrictEqual(plan.counts_by_month, { 1: 3, 2: 1, 3: 2 });
});

test('buildMediaPlan: задачи вне горизонта не теряются', () => {
  const plan = buildMediaPlan([...TASKS, { module_id: 3, module_name: 'Ссылки', task_id: '3.1', task_title: 'Аутрич', month: 6 }], 3);
  assert.strictEqual(plan.horizon, 6);
  assert.deepStrictEqual(plan.months, [1, 2, 3, 4, 5, 6]);
  assert.ok(plan.rows.some((r) => r.task_id === '3.1' && r.months.includes(6)));
});

test('buildMediaPlan: пустой список задач', () => {
  const plan = buildMediaPlan([], 3);
  assert.strictEqual(plan.total_tasks, 0);
  assert.deepStrictEqual(plan.rows, []);
  assert.deepStrictEqual(plan.modules, []);
});

test('buildMediaPlan: работы без модуля собираются в одну группу', () => {
  const plan = buildMediaPlan([
    { module_id: null, module_name: null, task_id: '', task_title: 'Без модуля 1', month: 1 },
    { module_id: null, module_name: '', task_id: '', task_title: 'Без модуля 2', month: 2 },
    { module_id: 5, module_name: 'Аналитика', task_id: '5.1', task_title: 'Отчётность', month: 1 },
  ], 3);
  const other = plan.modules.filter((m) => m.module_name === 'Прочие работы');
  assert.strictEqual(other.length, 1, `ожидалась одна группа «Прочие работы», получено ${other.length}`);
  assert.strictEqual(other[0].rows.length, 2);
  assert.strictEqual(plan.modules.length, 2);
});

test('detectRecurrence: разово / ежемесячно / через месяц / график', () => {
  assert.strictEqual(detectRecurrence([2], 3), 'once');
  assert.strictEqual(detectRecurrence([1, 2, 3], 3), 'monthly');
  assert.strictEqual(detectRecurrence([1, 3, 5], 6), 'every_2_months');
  assert.strictEqual(detectRecurrence([1, 2, 5], 6), 'custom');
});

test('recurrenceLabel: человекочитаемые подписи', () => {
  assert.strictEqual(recurrenceLabel([2], 3), 'Разово · М2');
  assert.strictEqual(recurrenceLabel([1, 2, 3], 3), 'Ежемесячно');
  assert.strictEqual(recurrenceLabel([1, 2, 5], 6), 'М1, М2, М5');
});

test('buildPricingTotals: основной + доп. бюджет', () => {
  const totals = buildPricingTotals(PRICING);
  assert.strictEqual(totals.base, 210000);
  assert.strictEqual(totals.add, 20000);
  assert.strictEqual(totals.grand, 230000);
  assert.strictEqual(totals.byMonth.get('total').base, 30000);
});

const PROPOSAL = {
  title: 'SEO-продвижение example.ru',
  client: 'ООО «Пример»',
  manager: 'Иван Иванов',
  horizon: 3,
  start_date: '2026-08-01',
  created_at: '2026-07-27',
  tasks: TASKS,
  pricing: PRICING,
};

testAsync('buildProposalPdf: собирается валидный PDF', async () => {
  const buf = await buildProposalPdf(PROPOSAL);
  assert.ok(Buffer.isBuffer(buf), 'ожидался Buffer');
  assert.ok(buf.length > 1000, `слишком маленький PDF: ${buf.length} байт`);
  assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
});

testAsync('buildProposalXlsx: лист «Медиа-план» с отметками месяцев', async () => {
  const buf = await buildProposalXlsx(PROPOSAL);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Медиа-план');
  assert.ok(ws, 'лист «Медиа-план» не найден');
  // Шапка: Модуль, Задача, Описание, Периодичность + 3 месяца
  assert.strictEqual(ws.getRow(1).getCell(4).value, 'Периодичность');
  assert.strictEqual(ws.getRow(1).getCell(7).value, 'Месяц 3');
  // 3 уникальные работы
  assert.strictEqual(ws.rowCount, 4);
  const contentRow = [2, 3, 4].map((i) => ws.getRow(i)).find((r) => String(r.getCell(2).value).includes('Публикация статей'));
  assert.ok(contentRow, 'строка «Публикация статей» не найдена');
  assert.strictEqual(contentRow.getCell(4).value, 'Ежемесячно');
  assert.strictEqual(contentRow.getCell(5).value, '✓');
  assert.strictEqual(contentRow.getCell(7).value, '✓');
});

testAsync('buildProposalXlsx: пустое КП не падает', async () => {
  const buf = await buildProposalXlsx({ title: 'Пустое КП', horizon: 3, tasks: [], pricing: [] });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} проверок пройдено${process.exitCode ? ' (есть ошибки)' : ''}`);
});
