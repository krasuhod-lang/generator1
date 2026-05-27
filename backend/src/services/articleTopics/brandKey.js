'use strict';

/**
 * brandKey — нормализация brand_hint в стабильный ключ для дедупа.
 *
 * Цель: «Brand Х», «brand x», «БРЕНД Х  »  → один и тот же brand_key.
 * Алгоритм:
 *   1) lowercase
 *   2) транслитерация кириллицы (ГОСТ-like, упрощённая)
 *   3) удаление всего, кроме [a-z0-9 -_]
 *   4) collapse whitespace → '-'
 *   5) trim
 *
 * Используется в:
 *   • article_topics_brand_history.brand_key
 *   • topicDuplicateDetector (lookup истории)
 *   • articleTopicsPipeline (insert после успешного парсинга)
 */

const CYRILLIC_MAP = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
  // украинские/белорусские частые
  і: 'i', ї: 'i', є: 'e', ў: 'u', ґ: 'g',
});

function transliterate(s) {
  let out = '';
  for (const ch of String(s)) {
    if (Object.prototype.hasOwnProperty.call(CYRILLIC_MAP, ch)) {
      out += CYRILLIC_MAP[ch];
    } else {
      out += ch;
    }
  }
  return out;
}

function normalizeBrandKey(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase();
  s = transliterate(s);
  // оставляем латиницу/цифры/пробел/дефис/подчёркивание
  s = s.replace(/[^a-z0-9 _-]+/g, ' ');
  // collapse whitespace
  s = s.replace(/\s+/g, '-');
  // collapse multiple dashes
  s = s.replace(/-+/g, '-');
  // trim leading/trailing dashes/underscores
  s = s.replace(/^[-_]+|[-_]+$/g, '');
  return s.slice(0, 120);
}

/**
 * canonTitle — каноникализация заголовка/H1 темы для exact-сравнения.
 * Алгоритм:
 *   • lowercase
 *   • удалить пунктуацию и спецсимволы (всё кроме букв/цифр + пробел)
 *   • collapse whitespace
 *   • trim
 *
 * Сохраняем кириллицу — это нужно для Jaccard/trigram, чтобы не терять смысл.
 */
function canonTitle(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase();
  // нормализация unicode (одна форма)
  try { s = s.normalize('NFKC'); } catch (_) { /* ignore */ }
  // оставляем буквы, цифры и пробелы
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 500);
}

module.exports = { normalizeBrandKey, canonTitle, transliterate };
