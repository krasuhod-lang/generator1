'use strict';

/**
 * stripExpertBlockquotes — удаляет <blockquote> элементы из HTML.
 * Используется для обеспечения правила «экспертное мнение строго 1 раз на всю статью».
 *
 * @param {string} html — HTML-контент блока
 * @returns {string} — HTML без blockquote
 */
function stripExpertBlockquotes(html) {
  return html
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * stripNoDataMarkers — удаляет все вхождения маркера [NO_DATA] из HTML-контента.
 * Если после удаления маркера абзац или элемент списка становится пустым, удаляет его целиком.
 *
 * @param {string} html — HTML-контент блока
 * @returns {string} — HTML без маркеров [NO_DATA]
 */
function stripNoDataMarkers(html) {
  if (!html) return html;

  let result = html;

  // Remove [NO_DATA] markers (with various brackets/formatting)
  result = result.replace(/\[NO[_\s]?DATA\]/gi, '');

  // Remove empty HTML elements that may result from stripping markers
  result = result.replace(/<p>\s*<\/p>/gi, '');
  result = result.replace(/<li>\s*<\/li>/gi, '');
  result = result.replace(/<td>\s*<\/td>/gi, '');

  // Clean up excessive whitespace
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

module.exports = { stripExpertBlockquotes, stripNoDataMarkers };
