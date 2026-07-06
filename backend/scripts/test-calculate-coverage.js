'use strict';

/**
 * test-calculate-coverage — проверяет, что охват LSI считается по словоформам.
 *
 * Запуск: node backend/scripts/test-calculate-coverage.js
 */

const assert = require('assert');
const { calculateCoverage } = require('../src/utils/calculateCoverage');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('calculateCoverage — покрытие по словоформам:');

// 1) Многословная фраза в другой словоформе должна засчитываться.
{
  const html = '<p>Мы устанавливаем металлических дверей по всей стране.</p>';
  const res = calculateCoverage(html, ['металлические двери']);
  check('фраза «металлические двери» покрыта формой «металлических дверей»',
    res.covered.includes('металлические двери') && res.percent === 100);
}

// 1b) Короткое слово в другой словоформе (окно/окна) засчитывается.
{
  const html = '<p>В доме поставили новые окна и покрасили стены.</p>';
  const res = calculateCoverage(html, ['окно']);
  check('короткое слово «окно» покрыто формой «окна»',
    res.covered.includes('окно') && res.percent === 100);
}

// 2) Одиночное слово в другой словоформе (длинный корень) засчитывается.
{
  const html = '<p>Качественная установка и обслуживание оборудования.</p>';
  const res = calculateCoverage(html, ['установки', 'оборудование']);
  check('одиночные слова «установки»/«оборудование» покрыты словоформами',
    res.percent === 100);
}

// 3) Отсутствующее слово не засчитывается (missing).
{
  const html = '<p>Пластиковые окна и двери.</p>';
  const res = calculateCoverage(html, ['ламинат']);
  check('отсутствующее слово «ламинат» помечено missing',
    res.missing.includes('ламинат') && res.percent === 0);
}

// 4) Нет ложного совпадения по подстроке внутри другого слова.
{
  const html = '<p>Гражданский кодекс регулирует отношения.</p>';
  const res = calculateCoverage(html, ['код']);
  check('«код» НЕ находится внутри «кодекс» (нет ложного покрытия)',
    res.missing.includes('код') && res.percent === 0);
}

// 5) Процент считается как доля покрытых от всех целевых.
{
  const html = '<p>Только про окна тут, ничего больше.</p>';
  const res = calculateCoverage(html, ['окна', 'двери', 'балконы', 'лоджии']);
  check('процент = covered/total (1 из 4 = 25%)',
    res.covered.length === 1 && res.percent === 25);
}

// 6) Пустой список LSI → 100% (нечего покрывать).
{
  const res = calculateCoverage('<p>текст</p>', []);
  check('пустой набор LSI → 100%', res.percent === 100);
}

// 7) Фраза, слова которой есть, но НЕ подряд — не считается покрытой.
{
  const html = '<p>Двери большие, а рядом стоят металлические стеллажи.</p>';
  const res = calculateCoverage(html, ['металлические двери']);
  check('разрозненные слова фразы не дают ложное покрытие',
    res.missing.includes('металлические двери') && res.percent === 0);
}

console.log(`\nВсе тесты пройдены: ${passed}/${passed}`);
