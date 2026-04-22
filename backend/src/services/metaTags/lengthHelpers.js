'use strict';

/**
 * Хелперы для аккуратной обрезки Title/Description под лимит длины.
 * Полностью переносят логику из beta-версии Title-v25.html.
 */

/** Обрезает строку до последнего целого слова (без многоточия). */
function trimToLastWord(str, maxLen) {
  const s = String(str || '');
  if (s.length <= maxLen) return s;
  let trimmed = s.substring(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > 0) trimmed = trimmed.substring(0, lastSpace);
  return trimmed;
}

/**
 * Обрезает до последнего завершённого предложения (. ! ?) в пределах maxLen.
 * Если такого знака нет — обрезает до последнего слова, БЕЗ дописывания точки
 * (чтобы не получить артефакты типа «Закажите.»).
 */
function trimToLastSentence(str, maxLen) {
  const s = String(str || '');
  if (s.length <= maxLen) return s;
  let trimmed = s.substring(0, maxLen);
  const lastPunctuation = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
  );
  if (lastPunctuation > 0) {
    trimmed = trimmed.substring(0, lastPunctuation + 1);
  } else {
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 0) trimmed = trimmed.substring(0, lastSpace);
  }
  return trimmed;
}

module.exports = { trimToLastWord, trimToLastSentence };
