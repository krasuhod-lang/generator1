'use strict';

/**
 * reports/modules/ctrBenchmarks.js — эталонные CTR по позиции (ТЗ §5.2).
 *
 * Бенчмарки CTR заданы в долях (не в процентах) по диапазонам позиций,
 * отдельно для Google и Яндекса. Используются детектором «CTR Gap»
 * (ctrGap.js) и оценкой Content Health (contentHealth.js).
 *
 * Все функции чистые — без обращений к БД/сети, поэтому их легко тестировать
 * (см. backend/scripts/test-report-modules.js).
 */

// [maxPosInclusive, googleCtr, yandexCtr]; строки отсортированы по позиции.
const BENCHMARK_TABLE = [
  [1, 0.285, 0.352],
  [2, 0.157, 0.181],
  [3, 0.110, 0.124],
  [5, 0.070, 0.081], // 4–5
  [7, 0.045, 0.050], // 6–7
  [10, 0.032, 0.035], // 8–10
  [15, 0.022, 0.024], // 11–15
];

// Для позиций ниже последней строки таблицы используем затухающий «хвост».
const TAIL_GOOGLE = 0.012;
const TAIL_YANDEX = 0.013;

function _engine(input) {
  const e = String(input || 'google').toLowerCase();
  if (e === 'yandex' || e === 'ym' || e === 'yandex_webmaster') return 'yandex';
  return 'google';
}

/**
 * Эталонный CTR (доля 0..1) для средней позиции и поисковика.
 * Позиция округляется вверх до целого диапазона таблицы; значения <1 → позиция 1.
 */
function getCtrBenchmark(position, engine = 'google') {
  const pos = Number(position);
  const isYandex = _engine(engine) === 'yandex';
  if (!Number.isFinite(pos) || pos <= 0) {
    return isYandex ? BENCHMARK_TABLE[0][2] : BENCHMARK_TABLE[0][1];
  }
  for (const [maxPos, gctr, yctr] of BENCHMARK_TABLE) {
    if (pos <= maxPos) return isYandex ? yctr : gctr;
  }
  return isYandex ? TAIL_YANDEX : TAIL_GOOGLE;
}

module.exports = {
  getCtrBenchmark,
  BENCHMARK_TABLE,
  _engine,
};
