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

/**
 * stemWord — детерминированный лёгкий стеммер для русского/украинского/
 * белорусского. Отрезает наиболее частотные окончания и суффиксы,
 * чтобы «прокладка / прокладки / прокладок / прокладочный» давали
 * одну основу. Не требует внешних библиотек.
 *
 * Алгоритм (по убыванию длины суффикса):
 *   1) выраженные глагольные/прилагательные хвосты ("ование", "ального", ...)
 *   2) существительные мн./род. ("ами", "ями", "ов", "ев", "ей", "ах", "ях")
 *   3) одиночные окончания ("а","я","о","е","ы","и","у","ю","ь","ъ","й")
 * Минимальная длина основы — 3 символа (короче — возвращаем как есть).
 *
 * Английские слова стеммим по простейшему правилу Porter-lite:
 *   "ies"→"y", "ses"→"s", trailing "s", "ing", "ed"
 *
 * НЕ применяется к словам с цифрами или коротким (≤3) токенам.
 */
const _RU_LONG_SUFFIXES = [
  'ованиями', 'ированной', 'ированным', 'ированных', 'ировании',
  'ованиях', 'ировании', 'ованием', 'ованного', 'ированном',
  'ировал', 'ировать', 'ировано',
  'ального', 'альными', 'ального', 'альных', 'альном', 'альные',
  'ческого', 'ческими', 'ческих', 'ческие', 'ческой', 'ческая',
  'ование', 'овании', 'ованию', 'ованной', 'ованных',
  'ивший', 'ившая', 'ивших', 'ившие',
  'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ами', 'ями', 'ах', 'ях', 'ов', 'ев', 'ей', 'ие', 'ые', 'ая', 'яя',
  'ой', 'ей', 'ую', 'юю', 'ом', 'ем', 'ям',
  'ться', 'тся', 'ешь', 'ишь', 'ете', 'ите',
  // genitive plural fleeting vowel («прокладок», «лопаток»):
  'ок', 'ек',
];

const _RU_SHORT_SUFFIXES = ['а','я','о','е','у','ю','ы','и','ь','ъ','й'];

const _EN_SUFFIXES = ['ing', 'ies', 'ses', 'ed', 'es', 's'];

function _isCyrillic(w) {
  return /[а-яёіїєўґ]/i.test(w);
}

function stemWord(word) {
  if (!word) return '';
  let w = String(word).toLowerCase();
  if (w.length <= 3) return w;
  if (/\d/.test(w)) return w;
  if (_isCyrillic(w)) {
    // Двухпроходное стемминг: ловим формы вида «системы→систем→сист»,
    // чтобы выровнять с «систем→сист» (симметрия).
    for (let pass = 0; pass < 2; pass += 1) {
      let stripped = false;
      for (const suf of _RU_LONG_SUFFIXES) {
        if (w.length - suf.length >= 3 && w.endsWith(suf)) {
          w = w.slice(0, -suf.length);
          stripped = true;
          break;
        }
      }
      if (!stripped) {
        for (const suf of _RU_SHORT_SUFFIXES) {
          if (w.length - suf.length >= 3 && w.endsWith(suf)) {
            w = w.slice(0, -suf.length);
            stripped = true;
            break;
          }
        }
      }
      if (!stripped) break;
    }
    return w;
  }
  if (/[a-z]/.test(w)) {
    for (const suf of _EN_SUFFIXES) {
      if (w.length - suf.length >= 3 && w.endsWith(suf)) {
        let base = w.slice(0, -suf.length);
        if (suf === 'ies') base += 'y';
        return base;
      }
    }
  }
  return w;
}

/**
 * canonTitleStem — canon + поток стеммов, для fuzzy-сравнения по словоформам.
 * Возвращает строку из стеммов через пробел; сохраняет порядок.
 */
function canonTitleStem(raw) {
  const c = canonTitle(raw);
  if (!c) return '';
  return c.split(/\s+/).map(stemWord).filter(Boolean).join(' ');
}

module.exports = {
  normalizeBrandKey,
  canonTitle,
  canonTitleStem,
  stemWord,
  transliterate,
};
