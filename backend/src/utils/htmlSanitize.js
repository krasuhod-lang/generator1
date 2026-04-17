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

module.exports = { stripExpertBlockquotes };
