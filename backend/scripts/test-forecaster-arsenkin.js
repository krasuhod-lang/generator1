'use strict';

/**
 * Тесты интеграции Арсенкина в «Прогнозатор»:
 *   • stopWordFilter — фильтр стоп-слов перед сбором сезонности,
 *   • arsenkinClient — resolveRegionLr + нормализация результата /get.
 *
 * Не требует Postgres/сети: все проверяемые функции чистые.
 *
 * Запуск: node backend/scripts/test-forecaster-arsenkin.js
 */

const assert = require('assert');
const { filterKeywords, matchStopWord } = require('../src/services/forecaster/stopWordFilter');
const { resolveRegionLr, seasonalityDateRange, normalizeDevice, _normalizeResult, _rowFromHistory } = require('../src/services/forecaster/arsenkinClient');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

// ── stopWordFilter ─────────────────────────────────────────────────
group('stopWordFilter.matchStopWord', () => {
  test('чистый коммерческий запрос проходит', () => {
    assert.strictEqual(matchStopWord('купить окна пвх москва'), null);
  });
  test('«бесплатно» матчится', () => {
    assert.strictEqual(matchStopWord('окна пвх бесплатно'), 'бесплатно');
  });
  test('словоформа «бесплатный» матчится по stem', () => {
    assert.strictEqual(matchStopWord('бесплатный замер окон'), 'бесплатн*');
  });
  test('«вб» по границе слова: «купить на вб» — да', () => {
    assert.ok(matchStopWord('купить на вб'));
  });
  test('«вб» НЕ матчит «вбить гвоздь»', () => {
    assert.strictEqual(matchStopWord('вбить гвоздь'), null);
  });
  test('«зп» НЕ матчит «запчасти»', () => {
    assert.strictEqual(matchStopWord('купить запчасти'), null);
  });
  test('многословная стоп-фраза «как сделать»', () => {
    assert.strictEqual(matchStopWord('как сделать окно'), 'как сделать');
  });
  test('«без регистрации»', () => {
    assert.strictEqual(matchStopWord('сервис без регистрации'), 'без регистрации');
  });
  test('домен auto.ru', () => {
    assert.strictEqual(matchStopWord('окна auto.ru'), 'auto.ru');
  });
  test('«отзывы сотрудников» матчится, просто «отзывы» — нет', () => {
    assert.ok(matchStopWord('компания отзывы сотрудников'));
    assert.strictEqual(matchStopWord('окна пвх отзывы'), null);
  });
  test('ё-нормализация: «чертёж» → чертеж*', () => {
    assert.ok(matchStopWord('чертёж окна'));
  });
  test('регистр не важен', () => {
    assert.ok(matchStopWord('Скачать ПРАЙС'));
  });
});

group('stopWordFilter.filterKeywords', () => {
  test('делит на kept/excluded + дедупликация', () => {
    const r = filterKeywords(['купить окна', 'Купить  окна', 'окна бесплатно', '', '  ']);
    assert.deepStrictEqual(r.kept, ['купить окна']);
    assert.strictEqual(r.excluded.length, 1);
    assert.strictEqual(r.excluded[0].phrase, 'окна бесплатно');
    assert.strictEqual(r.excluded[0].matched, 'бесплатно');
  });
  test('пустой вход → пустой выход', () => {
    const r = filterKeywords([]);
    assert.deepStrictEqual(r.kept, []);
    assert.deepStrictEqual(r.excluded, []);
  });
});

// ── arsenkinClient.resolveRegionLr ────────────────────────────────
group('arsenkinClient.resolveRegionLr', () => {
  test('пусто → Россия (225)', () => assert.strictEqual(resolveRegionLr(''), 225));
  test('«Москва» → 213', () => assert.strictEqual(resolveRegionLr('Москва'), 213));
  test('«СПб» → 2', () => assert.strictEqual(resolveRegionLr('СПб'), 2));
  test('числовой lr как есть', () => assert.strictEqual(resolveRegionLr('54'), 54));
  test('частичное вхождение «Москва и область»', () => assert.strictEqual(resolveRegionLr('Москва и область'), 213));
  test('неизвестный регион → 225', () => assert.strictEqual(resolveRegionLr('Урюпинск-сити'), 225));
});

// ── arsenkinClient._rowFromHistory / _normalizeResult ─────────────
group('arsenkinClient result normalization', () => {
  test('history-массив [{month,count}]', () => {
    const r = _rowFromHistory('окна', [
      { month: '2025-06', count: 100 },
      { month: '2025-07', count: 150 },
    ]);
    assert.deepStrictEqual(r.byPeriod, { '2025-06': 100, '2025-07': 150 });
    assert.strictEqual(r.total, 250);
  });
  test('history-объект {"YYYY-MM": n}', () => {
    const r = _rowFromHistory('окна', { '2025-06': 10, '06.2025': 999, '2025-07': 20 });
    assert.strictEqual(r.byPeriod['2025-07'], 20);
    assert.strictEqual(r.total >= 30, true);
  });
  test('JSON: data = массив items с history', () => {
    const rows = _normalizeResult({
      json: { data: [
        { phrase: 'окна пвх', history: [{ month: '2025-06', count: 5 }] },
        { query:  'балкон',   months: { '2025-06': 7 } },
      ] },
      text: '',
    });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].phrase, 'окна пвх');
    assert.strictEqual(rows[1].byPeriod['2025-06'], 7);
  });
  test('JSON: data = map фраза → {YYYY-MM: n}', () => {
    const rows = _normalizeResult({
      json: { data: { 'окна пвх': { '2025-01': 3, '2025-02': 4 } } },
      text: '',
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].total, 7);
  });
  test('fallback: CSV-строка через штатный парсер', () => {
    const csv = 'Фраза;2025-01;2025-02;2025-03\nокна пвх;10;20;30\nбалкон;1;2;3\n';
    const rows = _normalizeResult({ json: null, text: csv });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].byPeriod['2025-03'], 30);
  });
  test('пустой ответ → []', () => {
    assert.deepStrictEqual(_normalizeResult({ json: {}, text: '' }), []);
  });
  test('type=3 сезонность: ключ "seasonal" + month-only через resolveMonth', () => {
    const { _monthYearResolver } = require('../src/services/forecaster/arsenkinClient');
    // Окно на 7 июля 2026 → enddate 2026-06-30, endMonth=6.
    const resolveMonth = _monthYearResolver('month', new Date(2026, 6, 7));
    const rows = _normalizeResult({
      json: { status: 'ok', data: [
        { query: 'летние шины', seasonal: [
          { month: '05', count: 500 },  // ≤6 → 2026-05
          { month: '07', count: 200 },  // >6  → 2025-07
        ] },
      ] },
      text: '',
      resolveMonth,
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].phrase, 'летние шины');
    assert.strictEqual(rows[0].byPeriod['2026-05'], 500);
    assert.strictEqual(rows[0].byPeriod['2025-07'], 200);
    assert.strictEqual(rows[0].total, 700);
  });
  test('month-only БЕЗ resolveMonth → пустой byPeriod (не ломается)', () => {
    const rows = _normalizeResult({
      json: { data: [{ query: 'шины', seasonal: [{ month: '05', count: 5 }] }] },
      text: '',
    });
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].byPeriod, {});
  });
  test('точки с полной датой YYYY-MM-DD сворачиваются в месяц', () => {
    const r = _rowFromHistory('окна', [
      { date: '2025-06-01', value: 40 },
      { date: '2025-07-01', value: 60 },
    ]);
    assert.deepStrictEqual(r.byPeriod, { '2025-06': 40, '2025-07': 60 });
    assert.strictEqual(r.total, 100);
  });
});

// ── arsenkinClient.seasonalityDateRange ────────────────────────────
group('arsenkinClient.seasonalityDateRange', () => {
  test('month: последние 12 полных календарных месяцев', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 7)); // 7 июля 2026
    assert.strictEqual(r.startdate, '2025-07-01');
    assert.strictEqual(r.enddate, '2026-06-30');
  });
  test('month: границы года', () => {
    const r = seasonalityDateRange('month', new Date(2026, 0, 15)); // 15 января 2026
    assert.strictEqual(r.startdate, '2025-01-01');
    assert.strictEqual(r.enddate, '2025-12-31');
  });
  test('week: конец — воскресенье, старт — понедельник', () => {
    const r = seasonalityDateRange('week', new Date(2026, 6, 7)); // вторник 7 июля 2026
    assert.strictEqual(r.enddate, '2026-07-05');   // воскресенье
    assert.strictEqual(r.startdate, '2025-07-07'); // понедельник, 52 недели
  });
  test('day: окно ≤60 дней без текущего дня', () => {
    const r = seasonalityDateRange('day', new Date(2026, 6, 7));
    assert.strictEqual(r.enddate, '2026-07-06');
    assert.strictEqual(r.startdate, '2026-05-08');
  });
});

// ── arsenkinClient.normalizeDevice ─────────────────────────────────
// API принимает только «пустота или desktop/mobile»; пустая строка
// (или неизвестное значение) → поле device нужно ОПУСТИТЬ, иначе HTTP 422.
group('arsenkinClient.normalizeDevice', () => {
  test('пустая строка → "" (поле опускается)', () => {
    assert.strictEqual(normalizeDevice(''), '');
  });
  test('null/undefined → ""', () => {
    assert.strictEqual(normalizeDevice(null), '');
    assert.strictEqual(normalizeDevice(undefined), '');
  });
  test('desktop сохраняется', () => {
    assert.strictEqual(normalizeDevice('desktop'), 'desktop');
    assert.strictEqual(normalizeDevice(' Desktop '), 'desktop');
  });
  test('mobile сохраняется', () => {
    assert.strictEqual(normalizeDevice('mobile'), 'mobile');
  });
  test('phone/tablet сводятся к mobile', () => {
    assert.strictEqual(normalizeDevice('phone'), 'mobile');
    assert.strictEqual(normalizeDevice('tablet'), 'mobile');
  });
  test('неизвестное значение → "" (опускается, не шлём в API)', () => {
    assert.strictEqual(normalizeDevice('all'), '');
    assert.strictEqual(normalizeDevice('desktop1'), '');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
