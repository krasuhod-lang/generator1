'use strict';

const { russianStem } = require('./russianStem');

/**
 * calculateCoverage — подсчёт покрытия (охвата) LSI-слов / N-грамм в HTML.
 *
 * Смысл метрики: LSI-набор берётся из анализа конкурентов (ТОП выдачи), а
 * покрытие показывает, какой % этих важных слов реально присутствует на нашей
 * странице — то есть это сравнение нашего документа с конкурентами, выраженное
 * в процентах.
 *
 * Ключевая особенность: слово считается покрытым, если оно встречается на
 * странице В ЛЮБОЙ СЛОВОФОРМЕ (напр. LSI «пластиковые окна» покрывается
 * текстом «пластиковых окон»). Для этого и целевые слова, и текст страницы
 * приводятся к стеммам ПОСЛОВНО, а не как одна строка, и сравниваются по
 * границам слов (а не подстрокой — чтобы «код» не находился внутри «кодекс»).
 *
 * Вместо DOMParser используем простую замену тегов — в Node.js нет
 * встроенного DOM, а тянуть jsdom только ради strip-тегов избыточно.
 *
 * @param {string}   htmlContent  — HTML-текст блока / всей страницы
 * @param {string[]} targetWords  — список LSI-слов или N-грамм для проверки
 * @returns {{ covered: string[], missing: string[], percent: number }}
 */

// Токены: латиница / кириллица / цифры. «ё» нормализуем к «е» заранее.
const TOKEN_RE = /[a-zа-я0-9]+/g;

// Минимальная длина общего префикса двух стеммов, чтобы счесть их одной
// словоформой при неполном стемминге (напр. «пластиковый» / «пластиковых»).
// 5 символов — компромисс: ловит длинные словоформы, но не роняет короткие
// корни в ложные совпадения («код» ⊄ «кодекс»: общий префикс лишь 3).
const MIN_FUZZY_PREFIX = 5;

function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(TOKEN_RE) || [];
}

/**
 * _coverStem — стемм для сравнения словоформ. Базовый russianStem не трогает
 * короткие слова с беглыми/односимвольными окончаниями (окно/окна, двери), из-за
 * чего словоформы одного слова не совпадали. Дополнительно срезаем один хвостовой
 * гласный у достаточно длинного стемма — это унифицирует такие формы, не роняя
 * короткие корни в ложные совпадения.
 */
function _coverStem(word) {
  let s = russianStem(word);
  if (s.length >= 4 && /[аеиоуыэюяй]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * Совпадают ли два стемма как одна словоформа.
 * Точное равенство ИЛИ один — префикс другого при достаточной длине общего
 * префикса (страховка от слабого стеммера на коротких окончаниях).
 */
function _stemsMatch(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < MIN_FUZZY_PREFIX) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function calculateCoverage(htmlContent, targetWords) {
  if (!targetWords || !targetWords.length) {
    return { covered: [], missing: [], percent: 100 };
  }

  // Снимаем HTML-теги для получения чистого текста. Сущности (&amp; и т.п.)
  // не раскодируем: дальше мы всё равно токенизируем только буквы/цифры,
  // поэтому entity-декодирование избыточно (и опасно двойным раскодированием).
  const plainText = String(htmlContent || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');

  // Пословные стеммы страницы (сохраняя порядок — для проверки фраз) и
  // множество стеммов (для быстрой проверки одиночных слов).
  const pageStems = _tokenize(plainText).map(_coverStem);
  const pageStemSet = new Set(pageStems);

  const covered = [];
  const missing = [];

  for (const word of targetWords) {
    const parts = _tokenize(word).map(_coverStem).filter(Boolean);
    let found = false;

    if (parts.length === 1) {
      // Одиночное слово: покрыто, если его стемм есть среди стеммов страницы.
      const s = parts[0];
      if (pageStemSet.has(s)) {
        found = true;
      } else {
        for (const ps of pageStemSet) {
          if (_stemsMatch(s, ps)) { found = true; break; }
        }
      }
    } else if (parts.length > 1) {
      // Многословная фраза: покрыта, если пословная последовательность стеммов
      // встречается на странице подряд (порядок важен, но каждое слово — в
      // любой словоформе).
      const n = parts.length;
      for (let i = 0; i + n <= pageStems.length; i += 1) {
        let ok = true;
        for (let j = 0; j < n; j += 1) {
          if (!_stemsMatch(parts[j], pageStems[i + j])) { ok = false; break; }
        }
        if (ok) { found = true; break; }
      }
    }

    if (found) covered.push(word);
    else        missing.push(word);
  }

  const percent = targetWords.length > 0
    ? Math.round((covered.length / targetWords.length) * 100)
    : 100;

  return { covered, missing, percent };
}

module.exports = { calculateCoverage };
