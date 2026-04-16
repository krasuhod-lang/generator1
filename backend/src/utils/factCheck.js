'use strict';

/**
 * factCheck — поиск потенциальных галлюцинаций в HTML-контенте.
 * Перенесено из index.html без изменений (адаптировано под Node.js).
 *
 * Извлекает числа из текстового содержимого и проверяет,
 * не выдумал ли LLM цифры, которых нет в фактах бренда.
 *
 * @param {string}   htmlContent  — HTML-текст проверяемого блока
 * @param {string[]} factsArray   — массив строк с фактами бренда
 * @param {string}   [brandFacts] — дополнительный текст фактов (brandFacts поле)
 * @param {string}   [rawLSI]     — LSI-список (числа из него считаются «безопасными»)
 * @returns {number[]} — массив «подозрительных» чисел (возможные галлюцинации)
 */
function factCheck(htmlContent, factsArray = [], brandFacts = '', rawLSI = '') {
  // Снимаем HTML-теги, оставляем только текст
  const textOnly = htmlContent.replace(/<[^>]+>/g, ' ');

  // Все числа в тексте (включая десятичные и разделённые запятой)
  const allNumbers = (textOnly.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));

  if (!factsArray.length && !brandFacts) return [];

  // Собираем «известные» числа из всех источников данных
  const knownNumbers = new Set();

  const factsText = factsArray.join(' ');
  const factsNums = (factsText.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));
  factsNums.forEach(n => knownNumbers.add(n));

  const brandText  = brandFacts + ' ' + rawLSI;
  const brandNums  = (brandText.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));
  brandNums.forEach(n => knownNumbers.add(n));

  // Числа, которые никогда не считаются галлюцинацией
  const safeNumbers = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 1000]);

  const hallucinations = [];

  for (const num of allNumbers) {
    // Пропускаем «безопасные» и годы
    if (safeNumbers.has(num))               continue;
    if (num >= 1900 && num <= 2100)         continue;

    if (!knownNumbers.has(num)) {
      // Допускаем погрешность ±5% относительно известных чисел
      let found = false;
      for (const kn of knownNumbers) {
        if (kn > 0 && Math.abs(num - kn) / kn < 0.05) { found = true; break; }
      }
      if (!found) hallucinations.push(num);
    }
  }

  return hallucinations;
}

module.exports = { factCheck };
