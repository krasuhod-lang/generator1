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
const { resolveRegionLr, seasonalityDateRange, normalizeDevice, _normalizeResult, _rowFromHistory, _resolverFromEnddate, _isWrongDatesError, _datesFromErrorMessage, _snapRangeToFullMonths } = require('../src/services/forecaster/arsenkinClient');

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
    // Окно на 7 июля 2026 (день < лага публикации) → enddate 2026-05-31, endMonth=5.
    const resolveMonth = _monthYearResolver('month', new Date(2026, 6, 7));
    const rows = _normalizeResult({
      json: { status: 'ok', data: [
        { query: 'летние шины', seasonal: [
          { month: '05', count: 500 },  // idx 0 ≠ июнь → legacy: ≤5 → 2026-05
          { month: '07', count: 200 },  // idx 1 = июль от startdate → 2024-07
        ] },
      ] },
      text: '',
      resolveMonth,
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].phrase, 'летние шины');
    assert.strictEqual(rows[0].byPeriod['2026-05'], 500);
    assert.strictEqual(rows[0].byPeriod['2024-07'], 200);
    assert.strictEqual(rows[0].total, 700);
  });
  test('24-месячный ordered seasonal: month-only маппится по индексу от startdate', () => {
    const { _resolverFromRange } = require('../src/services/forecaster/arsenkinClient');
    const seasonal = [];
    for (let i = 0; i < 24; i++) seasonal.push({ month: String(((6 + i) % 12) + 1).padStart(2, '0'), count: i + 1 });
    const rows = _normalizeResult({
      json: { data: [{ query: 'окна', seasonal }] },
      text: '',
      resolveMonth: _resolverFromRange('2024-07-01', '2026-06-30'),
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].byPeriod['2024-07'], 1);
    assert.strictEqual(rows[0].byPeriod['2025-07'], 13);
    assert.strictEqual(rows[0].byPeriod['2026-06'], 24);
    assert.strictEqual(Object.keys(rows[0].byPeriod).length, 24);
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

  test('_periodFromAny: расширенные форматы ключей от Арсенкина', () => {
    const { _periodFromAny } = require('../src/services/forecaster/arsenkinClient');
    // ISO / варианты разделителей
    assert.strictEqual(_periodFromAny('2025-06'),      '2025-06');
    assert.strictEqual(_periodFromAny('2025.06'),      '2025-06');
    assert.strictEqual(_periodFromAny('2025/6'),       '2025-06');
    // Полная дата — сворачиваем в месяц
    assert.strictEqual(_periodFromAny('2025-06-01'),   '2025-06');
    assert.strictEqual(_periodFromAny('2025.06.15'),   '2025-06');
    // DD.MM.YYYY
    assert.strictEqual(_periodFromAny('01.06.2025'),   '2025-06');
    assert.strictEqual(_periodFromAny('15-06-2025'),   '2025-06');
    // MM.YYYY
    assert.strictEqual(_periodFromAny('06.2025'),      '2025-06');
    assert.strictEqual(_periodFromAny('6/2025'),       '2025-06');
    // YYYYMM без разделителя
    assert.strictEqual(_periodFromAny('202506'),       '2025-06');
    // Русские месяцы + год
    assert.strictEqual(_periodFromAny('Январь 2024'),  '2024-01');
    assert.strictEqual(_periodFromAny('янв.24'),       '2024-01');
    assert.strictEqual(_periodFromAny('сен 2025'),     '2025-09');
    assert.strictEqual(_periodFromAny("май'25"),       '2025-05');
    // Английские месяцы + год
    assert.strictEqual(_periodFromAny('Jan 2024'),     '2024-01');
    assert.strictEqual(_periodFromAny('Jan-24'),       '2024-01');
    assert.strictEqual(_periodFromAny('Sept 2025'),    '2025-09');
    // Unix-timestamp (сек и мс)
    // 1717200000 → 2024-06-01 00:00:00 UTC
    assert.strictEqual(_periodFromAny(1717200000),      '2024-06');
    assert.strictEqual(_periodFromAny(1717200000 * 1000), '2024-06');
    // Отрицательные кейсы
    assert.strictEqual(_periodFromAny('2025'),         null);   // только год
    assert.strictEqual(_periodFromAny('13'),           null);   // не месяц
    assert.strictEqual(_periodFromAny(''),             null);
    assert.strictEqual(_periodFromAny(null),           null);
  });

  test('history-массив с расширенными форматами ключей', () => {
    const r = _rowFromHistory('окна', [
      { month: '2025-06-01', count: 10 },   // полная дата
      { month: '07.2025',    count: 20 },   // MM.YYYY
      { month: 'Август 2025', count: 30 },  // русский месяц
      { month: 'Sep-2025',   count: 40 },   // английский месяц
    ]);
    assert.deepStrictEqual(r.byPeriod, {
      '2025-06': 10, '2025-07': 20, '2025-08': 30, '2025-09': 40,
    });
    assert.strictEqual(r.total, 100);
  });

  test('history-объект с русскими названиями месяцев', () => {
    const r = _rowFromHistory('окна', {
      'Январь 2024': 100,
      'Февраль 2024': 200,
      'Март 2024': 300,
    });
    assert.strictEqual(r.byPeriod['2024-01'], 100);
    assert.strictEqual(r.byPeriod['2024-02'], 200);
    assert.strictEqual(r.byPeriod['2024-03'], 300);
    assert.strictEqual(r.total, 600);
  });

  test('envelope TASK_RESULT: seasonal с полной датой YYYY-MM-DD', () => {
    const rows = _normalizeResult({
      json: {
        code: 'TASK_RESULT',
        result: {
          type: 3,
          queries: ['окна'],
          seasonal: [[
            { month: '2025-01-01', count: 100 },
            { month: '2025-02-01', count: 200 },
            { month: '2025-03-01', count: 300 },
          ]],
        },
      },
      text: '',
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].byPeriod['2025-01'], 100);
    assert.strictEqual(rows[0].byPeriod['2025-02'], 200);
    assert.strictEqual(rows[0].byPeriod['2025-03'], 300);
    assert.strictEqual(Object.keys(rows[0].byPeriod).length, 3);
  });

  // ── реальный envelope Арсенкина: {code:"TASK_RESULT", result:{…}} ──
  test('envelope TASK_RESULT: queries[] + параллельный seasonal[] по индексу', () => {
    const rows = _normalizeResult({
      json: {
        code: 'TASK_RESULT',
        task_id: 30558137,
        result: {
          type: 3,
          task_id: '30558137',
          queries: ['укрывной материал', 'конский навоз москва'],
          seasonal: [
            [{ month: '2025-01', count: 100 }, { month: '2025-02', count: 200 }],
            [{ month: '2025-01', count: 5 }, { month: '2025-02', count: 7 }],
          ],
        },
      },
      text: '',
    });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].phrase, 'укрывной материал');
    assert.strictEqual(rows[0].byPeriod['2025-02'], 200);
    assert.strictEqual(rows[1].phrase, 'конский навоз москва');
    assert.strictEqual(rows[1].total, 12);
  });
  test('envelope TASK_RESULT: массив per-query объектов в result.data', () => {
    const rows = _normalizeResult({
      json: {
        code: 'TASK_RESULT',
        task_id: 1,
        result: {
          type: 3,
          queries: ['окна пвх'],
          data: [{ query: 'окна пвх', seasonal: [{ month: '2025-03', count: 42 }] }],
        },
      },
      text: '',
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].phrase, 'окна пвх');
    assert.strictEqual(rows[0].byPeriod['2025-03'], 42);
  });
  test('envelope TASK_RESULT: карта фраза→история в result.data', () => {
    const rows = _normalizeResult({
      json: {
        result: {
          type: 3,
          queries: ['балкон'],
          data: { 'балкон': { '2025-04': 10, '2025-05': 20 } },
        },
      },
      text: '',
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].byPeriod['2025-05'], 20);
  });
  test('envelope TASK_RESULT: month-only seasonal через resolveMonth', () => {
    const { _monthYearResolver } = require('../src/services/forecaster/arsenkinClient');
    const resolveMonth = _monthYearResolver('month', new Date(2026, 6, 7)); // enddate 2026-05 (лаг публикации)
    const rows = _normalizeResult({
      json: {
        result: {
          type: 3,
          queries: ['шины'],
          seasonal: [[{ month: '05', count: 5 }, { month: '07', count: 3 }]],
        },
      },
      text: '',
      resolveMonth,
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].byPeriod['2026-05'], 5);
    assert.strictEqual(rows[0].byPeriod['2024-07'], 3); // idx 1 = июль от startdate 2024-06
  });
  test('envelope без сезонных данных (только queries) → []', () => {
    // Реальный кейс из бага: type=2 (парсинг фраз) вместо type=3 (сезонность).
    const rows = _normalizeResult({
      json: {
        code: 'TASK_RESULT',
        task_id: 30558137,
        result: { type: 2, task_id: '30558137', queries: ['a', 'b', 'c'] },
      },
      text: '',
    });
    assert.deepStrictEqual(rows, []);
  });
  test('служебные ключи envelope не превращаются в фразы', () => {
    const rows = _normalizeResult({
      json: { result: { type: 3, task_id: '1', status: 'ok', code: 'X' } },
      text: '',
    });
    assert.deepStrictEqual(rows, []);
  });
});

// ── arsenkinClient.seasonalityDateRange ────────────────────────────
group('arsenkinClient.seasonalityDateRange', () => {
  test('month: начало месяца (день < лага) — окно заканчивается на месяц раньше', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 7)); // 7 июля 2026 (< 20-го)
    assert.strictEqual(r.startdate, '2024-06-01'); // «сегодня минус 2 года»
    assert.strictEqual(r.enddate, '2026-05-31');   // июнь ещё не опубликован
  });
  test('month: после лага публикации — окно до конца прошлого месяца', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 25)); // 25 июля 2026 (≥ 20-го)
    assert.strictEqual(r.startdate, '2024-07-01');
    assert.strictEqual(r.enddate, '2026-06-30');
  });
  test('month: границы года', () => {
    const r = seasonalityDateRange('month', new Date(2026, 0, 15)); // 15 января 2026 (< 20-го)
    assert.strictEqual(r.startdate, '2023-12-01');
    assert.strictEqual(r.enddate, '2025-11-30');
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
  test('monthOffset=1: окно сжато на месяц с обеих сторон поверх лага', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 7), 1); // 7 июля 2026, сжатие 1 мес
    assert.strictEqual(r.startdate, '2024-07-01'); // startdate ВПЕРЁД (не за ретеншен)
    assert.strictEqual(r.enddate, '2026-04-30');   // enddate назад (лаг публикации)
  });
  test('monthOffset=2: окно сжато на два месяца с обеих сторон', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 7), 2);
    assert.strictEqual(r.startdate, '2024-08-01');
    assert.strictEqual(r.enddate, '2026-03-31');
  });
  test('monthOffset: границы года (сжатие через январь)', () => {
    const r = seasonalityDateRange('month', new Date(2026, 1, 5), 2); // 5 февраля 2026 (< 20-го)
    assert.strictEqual(r.startdate, '2024-03-01');
    assert.strictEqual(r.enddate, '2025-10-31');
  });
  test('monthOffset: короткая история не даёт пустого окна (минимум 1 месяц)', () => {
    const r = seasonalityDateRange('month', new Date(2026, 6, 7), 3, 4); // hm=4, off=3
    assert.strictEqual(r.startdate, '2026-02-01');
    assert.strictEqual(r.enddate, '2026-02-28');
  });
  test('monthOffset по умолчанию 0 = без сдвига', () => {
    const a = seasonalityDateRange('month', new Date(2026, 6, 7));
    const b = seasonalityDateRange('month', new Date(2026, 6, 7), 0);
    assert.deepStrictEqual(a, b);
  });
});

// ── arsenkinClient._isWrongDatesError ──────────────────────────────
group('arsenkinClient._isWrongDatesError', () => {
  test('распознаёт код WRONG_WORDSTAT_DATES', () => {
    const err = new Error('Arsenkin API: HTTP 422 — {"code":"WRONG_WORDSTAT_DATES","msg":"..."}');
    assert.strictEqual(_isWrongDatesError(err), true);
  });
  test('распознаёт русский текст «период не подходит»', () => {
    assert.strictEqual(_isWrongDatesError(new Error('Указанный период не подходит для этого запроса')), true);
  });
  test('другие ошибки не трогает', () => {
    assert.strictEqual(_isWrongDatesError(new Error('Arsenkin API: HTTP 429 Too Many Requests')), false);
    assert.strictEqual(_isWrongDatesError(null), false);
  });
});

// ── arsenkinClient._datesFromErrorMessage / _snapRangeToFullMonths ─
// Сервер Арсенкина в msg ошибки WRONG_WORDSTAT_DATES подсказывает допустимый
// период — клиент должен уметь его извлечь и выровнять на полные месяцы.
group('arsenkinClient._datesFromErrorMessage', () => {
  test('извлекает ISO-даты YYYY-MM-DD', () => {
    const err = new Error('Arsenkin API: HTTP 422 — WRONG_WORDSTAT_DATES — Указанный период не подходит. Выберите период с 2024-08-01 по 2026-04-30');
    assert.deepStrictEqual(_datesFromErrorMessage(err), { startdate: '2024-08-01', enddate: '2026-04-30' });
  });
  test('извлекает русский формат DD.MM.YYYY', () => {
    const err = new Error('Указанный период не подходит для этого запроса. Выберите период с 01.08.2024 по 30.04.2026');
    assert.deepStrictEqual(_datesFromErrorMessage(err), { startdate: '2024-08-01', enddate: '2026-04-30' });
  });
  test('даты в обратном порядке упорядочиваются', () => {
    const err = new Error('доступно до 30.04.2026, начиная с 01.08.2024');
    assert.deepStrictEqual(_datesFromErrorMessage(err), { startdate: '2024-08-01', enddate: '2026-04-30' });
  });
  test('без дат в сообщении → null', () => {
    assert.strictEqual(_datesFromErrorMessage(new Error('Указанный период не подходит для этого запроса')), null);
    assert.strictEqual(_datesFromErrorMessage(null), null);
  });
  test('одна дата → null (нужен диапазон)', () => {
    assert.strictEqual(_datesFromErrorMessage(new Error('данные доступны с 01.08.2024')), null);
  });
});

group('arsenkinClient._snapRangeToFullMonths', () => {
  test('startdate → 1-е число, enddate → последний день месяца', () => {
    assert.deepStrictEqual(
      _snapRangeToFullMonths({ startdate: '2024-08-15', enddate: '2026-04-10' }),
      { startdate: '2024-08-01', enddate: '2026-04-30' },
    );
  });
  test('февраль: последний день 28/29', () => {
    assert.deepStrictEqual(
      _snapRangeToFullMonths({ startdate: '2024-02-05', enddate: '2026-02-05' }),
      { startdate: '2024-02-01', enddate: '2026-02-28' },
    );
  });
  test('уже полные месяцы не меняются', () => {
    assert.deepStrictEqual(
      _snapRangeToFullMonths({ startdate: '2024-08-01', enddate: '2026-04-30' }),
      { startdate: '2024-08-01', enddate: '2026-04-30' },
    );
  });
  test('битый/пустой диапазон → null', () => {
    assert.strictEqual(_snapRangeToFullMonths(null), null);
    assert.strictEqual(_snapRangeToFullMonths({ startdate: 'oops', enddate: '2026-04-30' }), null);
    assert.strictEqual(_snapRangeToFullMonths({ startdate: '2026-04-01', enddate: '2026-04-30' }) == null, false);
  });
  test('start после end → null', () => {
    assert.strictEqual(_snapRangeToFullMonths({ startdate: '2026-05-01', enddate: '2026-04-30' }), null);
  });
});

// ── arsenkinClient._resolverFromEnddate ────────────────────────────
// После сдвига окна назад год месяцев должен восстанавливаться по фактическому
// enddate задачи, а не по «сегодня».
group('arsenkinClient._resolverFromEnddate', () => {
  test('enddate 2026-05-31: месяцы ≤5 → 2026, остальные → 2025', () => {
    const resolve = _resolverFromEnddate('2026-05-31');
    assert.strictEqual(resolve(5), '2026-05');
    assert.strictEqual(resolve(6), '2025-06');
    assert.strictEqual(resolve(12), '2025-12');
  });
  test('пустой/битый enddate → () => null', () => {
    assert.strictEqual(_resolverFromEnddate('')(3), null);
    assert.strictEqual(_resolverFromEnddate('нет даты')(3), null);
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
