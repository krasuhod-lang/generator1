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
const DEFAULT_PAGES = 10;

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
 * Найти позицию домена проекта в Яндекс-выдаче.
 *
 * @param {string} keyword
 * @param {object} opts
 * @param {string} opts.domain   — целевой домен (без протокола/www).
 * @param {string} [opts.lr]     — Яндекс-регион (lr).
 * @param {number} [opts.pages]  — сколько страниц снимать (по умолчанию 10).
 * @returns {Promise<{position:(number|null),foundUrl:(string|null),snippet:(string|null),checked:number}>}
 */
async function fetchYandexPosition(keyword, opts = {}) {
  const target = normalizeHost(opts.domain);
  const docs = await fetchYandexSerp(keyword, {
    lr: opts.lr || '',
    pages: opts.pages || DEFAULT_PAGES,
  });
  return _findPosition(docs, target);
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
 * @param {number} [opts.pages]  — страниц для снятия.
 */
async function fetchGooglePosition(keyword, opts = {}) {
  const target = normalizeHost(opts.domain);
  const docs = await fetchGoogleSerp(keyword, {
    lr: opts.lr || '',
    loc: opts.loc || '',
    device: opts.device || '',
    pages: opts.pages || DEFAULT_PAGES,
  });
  return _findPosition(docs, target);
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
