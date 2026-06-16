'use strict';

/**
 * positionTracker/xmlstockSerp.js
 *
 * Тонкая обёртка над xmlstockClient: получает ТОП-100 для запроса и ищет
 * первую позицию, где встречается домен проекта (точное совпадение хоста +
 * любые поддомены). Возвращает { position, foundUrl, snippet }.
 *
 * Транзиентный поллинг XMLStock («Запрос ещё не обработан») уже реализован
 * в xmlstockClient — сюда дополнительной логики добавлять не нужно.
 */

const {
  fetchYandexSerp, fetchGoogleSerp,
} = require('../metaTags/xmlstockClient');

// Берём ТОП-100 = 10 страниц по 10 результатов; обычно хватает.
// При page-by-page поиске мы останавливаемся раньше, как только домен найден.
const DEFAULT_PAGES = 10;
// Размер «батча» страниц (если домен не найден за первый батч — добираем).
// 3 страницы = ТОП-30, что покрывает ~95% реальных позиций.
const FAST_BATCH_PAGES = 3;

/**
 * Нормализует домен/хост: убирает протокол, www., путь, query, port, точку
 * в конце и приводит к нижнему регистру. На пустом/некорректном входе
 * возвращает пустую строку.
 */
function normalizeHost(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  // Срезаем протокол.
  s = s.replace(/^https?:\/\//, '');
  // Срезаем путь/quеry.
  s = s.split('/')[0].split('?')[0].split('#')[0];
  // Срезаем порт.
  s = s.split(':')[0];
  // Срезаем www.
  s = s.replace(/^www\./, '');
  // Финальная точка.
  s = s.replace(/\.$/, '');
  return s;
}

function hostOfUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`);
    return normalizeHost(u.hostname);
  } catch (_) {
    return normalizeHost(String(url));
  }
}

/**
 * Совпадает ли host выдачи с целевым доменом проекта: точное совпадение
 * либо поддомен (sub.example.com ⊂ example.com).
 */
function hostMatches(serpHost, targetHost) {
  if (!serpHost || !targetHost) return false;
  if (serpHost === targetHost) return true;
  return serpHost.endsWith('.' + targetHost);
}

/**
 * Постранично снимает выдачу и останавливается, как только найден целевой
 * домен. Это критично для скорости: при типичной позиции 5–20 нам не нужно
 * скачивать все 10 страниц XMLStock (каждая ~1–3 c).
 *
 * @param {(args:{startPage:number,pages:number})=>Promise<Array>} pageFetcher
 * @param {string} targetHost
 * @param {number} maxPages          максимальное число страниц (TOP-N/10).
 */
async function _findPositionStreamed(pageFetcher, targetHost, maxPages) {
  const accumulated = [];
  let positionOffset = 0;
  let page = 0;
  // Первый батч — несколько страниц, чтобы амортизировать задержку XMLStock
  // транзиентных ошибок; затем по одной.
  while (page < maxPages) {
    const batchSize = page === 0 ? Math.min(FAST_BATCH_PAGES, maxPages) : 1;
    let docs;
    try {
      docs = await pageFetcher({ startPage: page, pages: batchSize });
    } catch (err) {
      if (accumulated.length === 0) throw err;
      break;
    }
    const list = Array.isArray(docs) ? docs : [];
    // Ищем в текущем батче — если найдено, сразу выходим.
    for (let i = 0; i < list.length; i += 1) {
      const d = list[i] || {};
      const h = hostOfUrl(d.url);
      if (hostMatches(h, targetHost)) {
        return {
          position: positionOffset + i + 1,
          foundUrl: d.url || null,
          snippet: d.snippet || d.title || null,
          checked: positionOffset + list.length,
        };
      }
    }
    positionOffset += list.length;
    accumulated.push(...list);
    page += batchSize;
    // Если последний батч пришёл пустым — дальше документов не будет.
    if (list.length === 0) break;
  }
  return { position: null, foundUrl: null, snippet: null, checked: positionOffset };
}

/**
 * Найти позицию домена проекта в Яндекс-выдаче.
 *
 * @param {string} keyword
 * @param {object} opts
 * @param {string} opts.domain   — целевой домен (без протокола/www).
 * @param {string} [opts.lr]     — Яндекс-регион (lr).
 * @param {number} [opts.pages]  — макс. страниц для снятия (TOP-N/10), по умолчанию 10.
 * @returns {Promise<{position:(number|null),foundUrl:(string|null),snippet:(string|null),checked:number}>}
 */
async function fetchYandexPosition(keyword, opts = {}) {
  const target = normalizeHost(opts.domain);
  const maxPages = opts.pages || DEFAULT_PAGES;
  return _findPositionStreamed(
    ({ startPage, pages }) => fetchYandexSerp(keyword, {
      lr: opts.lr || '',
      startPage,
      pages,
    }),
    target,
    maxPages,
  );
}

/**
 * Найти позицию домена в Google-выдаче.
 *
 * @param {string} keyword
 * @param {object} opts
 * @param {string} opts.domain   — целевой домен.
 * @param {string} [opts.loc]    — Google-локация ("Moscow,Moscow,Russia").
 * @param {string} [opts.lr]     — Яндекс-регион (если поддерживается аккаунтом).
 * @param {string} [opts.device] — desktop|mobile.
 * @param {number} [opts.pages]  — макс. страниц для снятия (TOP-N/10).
 */
async function fetchGooglePosition(keyword, opts = {}) {
  const target = normalizeHost(opts.domain);
  const maxPages = opts.pages || DEFAULT_PAGES;
  return _findPositionStreamed(
    ({ startPage, pages }) => fetchGoogleSerp(keyword, {
      lr: opts.lr || '',
      loc: opts.loc || '',
      device: opts.device || '',
      startPage,
      pages,
    }),
    target,
    maxPages,
  );
}

function _findPosition(docs, targetHost) {
  const list = Array.isArray(docs) ? docs : [];
  for (let i = 0; i < list.length; i += 1) {
    const d = list[i] || {};
    const h = hostOfUrl(d.url);
    if (hostMatches(h, targetHost)) {
      return {
        position: i + 1,
        foundUrl: d.url || null,
        snippet:  d.snippet || d.title || null,
        checked:  list.length,
      };
    }
  }
  return { position: null, foundUrl: null, snippet: null, checked: list.length };
}

module.exports = {
  fetchYandexPosition,
  fetchGooglePosition,
  normalizeHost,
  hostOfUrl,
  hostMatches,
  _findPosition,
};
