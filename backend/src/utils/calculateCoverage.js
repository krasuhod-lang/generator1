'use strict';

const { russianStem } = require('./russianStem');

/**
 * calculateCoverage — подсчёт покрытия LSI/N-грамм в HTML-контенте.
 * Перенесено из index.html без изменений (адаптировано под Node.js).
 *
 * Вместо DOMParser используем простую замену тегов — в Node.js нет
 * встроенного DOM, а тянуть jsdom только ради strip-тегов избыточно.
 *
 * @param {string}   htmlContent  — HTML-текст блока / всей страницы
 * @param {string[]} targetWords  — список LSI-слов или N-грамм для проверки
 * @returns {{ covered: string[], missing: string[], percent: number }}
 */
function calculateCoverage(htmlContent, targetWords) {
  if (!targetWords || !targetWords.length) {
    return { covered: [], missing: [], percent: 100 };
  }

  // Снимаем HTML-теги для получения чистого текста
  const plainText = htmlContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .toLowerCase();

  // Стеммируем весь текст для нечёткого совпадения
  const stemmedText = plainText
    .split(/\s+/)
    .map(russianStem)
    .join(' ');

  const covered = [];
  const missing = [];

  for (const word of targetWords) {
    const wLower   = word.toLowerCase().trim();
    const wStemmed = russianStem(wLower);

    const found =
      plainText.includes(wLower) ||
      plainText.includes(wStemmed) ||
      stemmedText.includes(wStemmed) ||
      (
        wStemmed.length > 3 &&
        stemmedText.includes(wStemmed.substring(0, Math.ceil(wStemmed.length * 0.8)))
      );

    if (found) covered.push(word);
    else        missing.push(word);
  }

  const percent = targetWords.length > 0
    ? Math.round((covered.length / targetWords.length) * 100)
    : 100;

  return { covered, missing, percent };
}

module.exports = { calculateCoverage };
