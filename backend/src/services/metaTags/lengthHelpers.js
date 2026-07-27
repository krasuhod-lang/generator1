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

/**
 * Словарь побудительных конструкций (CTA). Синхронен с CTA_DEFS
 * snippetAnalyzer / CTA_PATTERNS serpCtrAnalyzer: по правилам DrMax CTA стоит
 * в самом конце Description, и именно он первым страдает от механической
 * обрезки — поэтому его нужно уметь отделять и возвращать на место.
 */
const CTA_RE = /(узна[йи]те|запис(?:ывайтесь|аться|итесь|ьтесь)|подробн\w*|закаж(?:ите|и|ем)|заказыв\w*|куп(?:ите|ить|и)\b|звон(?:ите|и)\b|оставьте?\s+заявк\w*|получ(?:ите|и)\b|выбер(?:ите|и)\b|скач(?:айте|ай)|оформ(?:ите|и)\b|приходите|обращайтесь|рассчита[йе]те|смотрите)/i;

/** Делит текст на предложения, сохраняя завершающую пунктуацию. */
function splitSentences(str) {
  const s = String(str || '').trim();
  if (!s) return [];
  const parts = s.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return (parts || [s]).map((p) => p.trim()).filter(Boolean);
}

/**
 * Отделяет CTA-хвост от «тела» описания.
 * CTA считается последнее предложение, содержащее побудительную конструкцию.
 *
 * @returns {{body:string, cta:string}} cta === '' если CTA не найден
 */
function splitCta(str) {
  const sentences = splitSentences(str);
  if (sentences.length < 2) {
    return { body: String(str || '').trim(), cta: '' };
  }
  const last = sentences[sentences.length - 1];
  if (!CTA_RE.test(last)) {
    return { body: String(str || '').trim(), cta: '' };
  }
  return {
    body: sentences.slice(0, -1).join(' ').trim(),
    cta: last.trim(),
  };
}

/** true, если строка содержит побудительную конструкцию (CTA). */
function hasCta(str) {
  return CTA_RE.test(String(str || ''));
}

/**
 * Детерминированное сжатие Description с сохранением CTA (ветка 2 стратегии
 * «умной обработки превышения длины»): CTA отделяется, тело обрезается по
 * последнему предложению/слову так, чтобы CTA поместился целиком, и
 * приклеивается обратно.
 *
 * Если CTA нет либо он сам длиннее лимита — деградируем до обычной обрезки
 * по последнему предложению (историческое поведение).
 *
 * @param {string} str    — исходное описание
 * @param {number} maxLen — жёсткий лимит символов
 * @returns {{text:string, cta_preserved:boolean}}
 */
function compressPreservingCta(str, maxLen) {
  const source = String(str || '').trim();
  if (source.length <= maxLen) {
    return { text: source, cta_preserved: hasCta(source) };
  }

  const { body, cta } = splitCta(source);
  // +1 на пробел между телом и CTA.
  if (cta && cta.length + 1 < maxLen) {
    const bodyBudget = maxLen - cta.length - 1;
    let newBody = trimToLastSentence(body, bodyBudget);
    if (!newBody.trim()) newBody = trimToLastWord(body, bodyBudget);
    newBody = newBody.replace(/[\s,;:—-]+$/, '').trim();
    if (newBody) {
      if (!/[.!?]$/.test(newBody)) newBody += '.';
      const merged = `${newBody} ${cta}`.trim();
      if (merged.length <= maxLen) {
        return { text: merged, cta_preserved: true };
      }
    }
    // Тело не помещается вовсе — оставляем один CTA, он ценнее обрывка.
    return { text: cta, cta_preserved: true };
  }

  const fallback = trimToLastSentence(source, maxLen);
  const text = fallback.trim() ? fallback : trimToLastWord(source, maxLen);
  return { text, cta_preserved: hasCta(text) };
}

module.exports = {
  trimToLastWord,
  trimToLastSentence,
  splitSentences,
  splitCta,
  hasCta,
  compressPreservingCta,
  CTA_RE,
};
