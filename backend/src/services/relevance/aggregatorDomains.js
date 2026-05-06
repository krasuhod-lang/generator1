'use strict';

/**
 * Список «агрегаторов» / маркетплейсов / больших площадок, которые
 * обычно не являются информационным конкурентом для статей и услуг,
 * но почти всегда занимают ТОП Яндекса (Avito, hh.ru, Ozon, …).
 *
 * Если пользователь поставил чекбокс «Исключить агрегаторы» — эти
 * домены отфильтровываются ДО парсинга, чтобы они:
 *   а) не размывали словарь корпуса (своими «доставка / отзыв / товар»);
 *   б) не вытесняли реальных информационных конкурентов из выборки.
 *
 * Список «зашит» внутри + расширяется через env `RELEVANCE_AGGREGATOR_DOMAINS`
 * (запятая/перенос строки/пробел как разделители). Базовый список
 * сознательно консервативный: только бесспорные агрегаторы.
 */

const DEFAULT_AGGREGATORS = [
  // классифайды
  'avito.ru',
  'youla.ru',
  // job
  'hh.ru',
  'rabota.ru',
  'superjob.ru',
  'zarplata.ru',
  // e-commerce
  'ozon.ru',
  'wildberries.ru',
  'wb.ru',
  'aliexpress.ru',
  'aliexpress.com',
  'market.yandex.ru',
  'lemana.pro',
  'leroymerlin.ru',
  'mvideo.ru',
  'eldorado.ru',
  'dns-shop.ru',
  'citilink.ru',
  // services / aggregators
  'profi.ru',
  'youdo.com',
  'yandex.uslugi',
  'uslugi.yandex.ru',
  'tiu.ru',
  'pulscen.ru',
  'flagma.ru',
  // travel/hotel/restaurant aggregators
  'booking.com',
  'tripadvisor.ru',
  'tripadvisor.com',
  'tutu.ru',
  // блог-платформы / UGC
  'dzen.ru',
  'zen.yandex.ru',
  'vc.ru',
  'habr.com',
  'pikabu.ru',
  'fishki.net',
  // соц.сети
  'vk.com',
  'ok.ru',
  // справочники
  '2gis.ru',
  'yell.ru',
  // рефераты/Q&A
  'otvet.mail.ru',
  'sprashivalka.com',
  'fb.ru',
];

function _envExtras() {
  const raw = String(process.env.RELEVANCE_AGGREGATOR_DOMAINS || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,\n\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function _loadList() {
  const set = new Set();
  for (const d of DEFAULT_AGGREGATORS) set.add(d.toLowerCase());
  for (const d of _envExtras()) set.add(d);
  return set;
}

const _CACHED = _loadList();

function _hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/**
 * @param {string} url
 * @returns {boolean} true, если URL принадлежит агрегатору из списка.
 */
function isAggregator(url) {
  const host = _hostOf(url);
  if (!host) return false;
  if (_CACHED.has(host)) return true;
  // субдомены: «job.hh.ru» тоже считаем за hh.ru
  for (const d of _CACHED) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * Разделяет SERP-список на «оставленные» и «отфильтрованные» агрегаторы.
 * Используется в pipeline.js, когда `exclude_aggregators=true`.
 */
function splitBySerp(serp) {
  const kept = [];
  const removed = [];
  for (const item of (serp || [])) {
    const url = item?.url;
    if (!url) continue;
    if (isAggregator(url)) {
      removed.push({ url, host: _hostOf(url), reason: 'aggregator' });
    } else {
      kept.push(item);
    }
  }
  return { kept, removed };
}

module.exports = {
  isAggregator,
  splitBySerp,
  DEFAULT_AGGREGATORS,
};
