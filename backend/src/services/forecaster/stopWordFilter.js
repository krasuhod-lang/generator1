'use strict';

/**
 * forecaster/stopWordFilter.js — фильтр стоп-слов для режима «список ключей».
 *
 * Требование владельца продукта: ПЕРЕД сбором сезонности через Арсенкин
 * из списка ключевых запросов исключаются фразы, содержащие стоп-слова
 * (бесплатно / скачать / торрент / авито / вакансии / фото / …).
 * Список — фиксированный, из ТЗ; редактируется прямо здесь.
 *
 * Матчинг:
 *   • фраза и стоп-слово нормализуются (lower, ё→е, схлопывание пробелов);
 *   • стоп-слово должно совпасть по ГРАНИЦАМ СЛОВ («вб» матчит «купить на вб»,
 *     но НЕ «вбить гвоздь»); многословные стоп-фразы («как сделать»,
 *     «без регистрации») матчатся как последовательность слов;
 *   • стоп-слова со словоформами («бесплатный», «пиратский», «взломанный»)
 *     матчатся по началу слова (stem*) — см. STEM_PREFIXES.
 *
 * API:
 *   filterKeywords(list) → {
 *     kept:     string[],                       // прошедшие фильтр
 *     excluded: [{ phrase, matched }],          // исключённые + чем матчнулись
 *   }
 */

// Точные стоп-слова/фразы (совпадение по границам слов)
const STOP_WORDS = [
  'бесплатно', 'даром', 'скачать', 'скачивание', 'торрент', 'torrent',
  'crack', 'кряк', 'взлом', 'пиратка', 'keygen', 'кейген',
  'без регистрации', 'без смс',
  'своими руками', 'самому', 'самостоятельно',
  'как сделать', 'как настроить', 'как починить', 'как установить',
  'как собрать', 'как разобрать',
  'чертеж', 'схема', 'инструкция', 'учебник',
  'реферат', 'курсовая', 'дипломная', 'доклад',
  'википедия', 'wiki', 'вики', 'форум', 'блог',
  'почему', 'что это',
  'авито', 'avito', 'озон', 'ozon', 'wildberries', 'wb', 'вб',
  'яндекс маркет', 'алиэкспресс', 'aliexpress',
  'vk', 'вк', 'вконтакте', 'юла', 'дром', 'drom', 'auto.ru', 'авто.ру',
  'вакансия', 'работа', 'работа в', 'зарплата', 'зп', 'оклад',
  'отзывы сотрудников', 'стажировка', 'собеседование', 'резюме', 'устроиться',
  'фото', 'видео', 'смотреть', 'онлайн', 'слушать',
  'mp3', 'mp4', 'pdf', 'fb2', 'epub',
];

// Стоп-слова со словоформами: матчим по началу слова
// («бесплатн» → бесплатный/бесплатная/бесплатные, «пиратск» → пиратский/пиратская…)
const STEM_PREFIXES = [
  'бесплатн',   // бесплатный, бесплатная, бесплатное…
  'пиратск',    // пиратский, пиратская…
  'взломан',    // взломанный, взломанная…
  'чертеж',     // чертежи, чертежей…
  'ваканси',    // вакансия, вакансии…
];

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

// Разбиваем фразу на «слова» (буквы/цифры/точка внутри домена auto.ru).
function _tokens(phrase) {
  return _norm(phrase).split(/[^a-zа-я0-9.]+/i).filter(Boolean);
}

// Прекомпилируем стоп-слова: одно-словные → Set, много-словные → массивы токенов.
const _singleStop = new Set();
const _multiStop = [];
for (const sw of STOP_WORDS) {
  const toks = _tokens(sw);
  if (toks.length === 1) _singleStop.add(toks[0]);
  else if (toks.length > 1) _multiStop.push({ raw: sw, toks });
}
const _stems = STEM_PREFIXES.map(_norm);

/**
 * Возвращает первое совпавшее стоп-слово либо null.
 */
function matchStopWord(phrase) {
  const toks = _tokens(phrase);
  if (toks.length === 0) return null;

  for (const t of toks) {
    if (_singleStop.has(t)) return t;
    for (const stem of _stems) {
      if (t.startsWith(stem)) return stem + '*';
    }
  }
  // много-словные стоп-фразы: последовательность токенов
  for (const ms of _multiStop) {
    const n = ms.toks.length;
    for (let i = 0; i + n <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (toks[i + j] !== ms.toks[j]) { ok = false; break; }
      }
      if (ok) return ms.raw;
    }
  }
  return null;
}

/**
 * Фильтрует список ключевых запросов, отбрасывая содержащие стоп-слова.
 * Дедуплицирует по нормализованной форме, пустые строки выкидывает.
 */
function filterKeywords(list) {
  const kept = [];
  const excluded = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const phrase = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const norm = _norm(phrase);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const matched = matchStopWord(phrase);
    if (matched) excluded.push({ phrase, matched });
    else kept.push(phrase);
  }
  return { kept, excluded };
}

module.exports = { filterKeywords, matchStopWord, STOP_WORDS, STEM_PREFIXES };
