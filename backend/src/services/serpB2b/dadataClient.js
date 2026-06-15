'use strict';

/**
 * Dadata API enrichment для serpB2b — получение точного полного наименования
 * юр. лица по ИНН.
 *
 * Endpoint: POST https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party
 * Headers : Authorization: Token <DADATA_API_KEY>
 *
 * Возвращает:
 *   • full_with_opf        — «ООО "Ромашка"», полная форма с ОПФ;
 *   • short_with_opf       — короткая форма «ООО Ромашка»;
 *   • status               — ACTIVE | LIQUIDATING | LIQUIDATED | BANKRUPT | REORGANIZING;
 *   • ogrn / kpp           — для досбора реквизитов;
 *   • management_name      — ФИО руководителя (если есть);
 *   • address              — юр. адрес.
 *
 * Гейтинг: если переменная окружения `DADATA_API_KEY` не задана —
 * `lookupByInn` сразу возвращает `null` (модуль работает в no-op-режиме,
 * пайплайн остаётся работоспособным).
 *
 * Кэширование: in-memory LRU-подобный Map с TTL 24 часа на ИНН — реквизиты
 * у юрлица не меняются между запусками одной задачи, повторные обращения
 * к API при множественных страницах одного сайта будут попадать в кэш.
 */

const axios = require('axios');
const { isValidInn } = require('./extractors');

const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 ч

const _cache = new Map(); // inn → { value, expiresAt }

function _getCached(inn) {
  const hit = _cache.get(inn);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    _cache.delete(inn);
    return undefined;
  }
  return hit.value;
}

function _setCached(inn, value) {
  _cache.set(inn, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // Защита от безграничного роста (на больших задачах — тысячи ИНН).
  if (_cache.size > 5000) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
}

function isDadataEnabled() {
  return Boolean(process.env.DADATA_API_KEY);
}

/**
 * Запрашивает у Dadata данные о юрлице/ИП по ИНН.
 *
 * @param {string} inn — 10 или 12 цифр; валидируется через isValidInn.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<{
 *   inn: string,
 *   name_full_with_opf: string|null,
 *   name_short_with_opf: string|null,
 *   ogrn: string|null,
 *   kpp: string|null,
 *   status: string|null,
 *   management_name: string|null,
 *   address: string|null,
 *   source: 'dadata'
 * } | null>}
 */
async function lookupByInn(inn, opts = {}) {
  if (!isDadataEnabled()) return null;
  const cleanInn = String(inn || '').replace(/\D+/g, '');
  if (!isValidInn(cleanInn)) return null;

  const cached = _getCached(cleanInn);
  if (cached !== undefined) return cached;

  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let resp;
  try {
    resp = await axios.post(
      DADATA_URL,
      { query: cleanInn },
      {
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Token ${process.env.DADATA_API_KEY}`,
        },
        // Не падаем на 4xx/5xx — обрабатываем status вручную.
        validateStatus: () => true,
      },
    );
  } catch (err) {
    // Сетевая ошибка / таймаут — возвращаем null, не валим пайплайн и
    // НЕ кэшируем (ретраймы при следующем сайте имеют смысл).
    // eslint-disable-next-line no-console
    console.warn(`[dadata] lookupByInn(${cleanInn}) failed: ${err.message}`);
    return null;
  }

  if (!resp || resp.status >= 400) {
    // 401/403 (битый ключ / превышен лимит) — лог + кэш null, чтобы не
    // долбить упавший API десятками запросов в рамках одной задачи.
    // eslint-disable-next-line no-console
    console.warn(
      `[dadata] HTTP ${resp ? resp.status : 'no-response'} for inn=${cleanInn}`,
    );
    _setCached(cleanInn, null);
    return null;
  }

  const suggestion = (resp.data && Array.isArray(resp.data.suggestions))
    ? resp.data.suggestions[0]
    : null;
  if (!suggestion || !suggestion.data) {
    _setCached(cleanInn, null);
    return null;
  }

  const d = suggestion.data;
  const value = {
    inn: cleanInn,
    name_full_with_opf:  d.name && (d.name.full_with_opf || d.name.full)   || null,
    name_short_with_opf: d.name && (d.name.short_with_opf || d.name.short) || null,
    ogrn: d.ogrn || null,
    kpp:  d.kpp || null,
    status: d.state && d.state.status ? d.state.status : null,
    management_name: d.management && d.management.name ? d.management.name : null,
    address: d.address && d.address.value ? d.address.value : null,
    source: 'dadata',
  };
  _setCached(cleanInn, value);
  return value;
}

// Для тестов — позволяем сбросить кэш.
function _resetCache() { _cache.clear(); }

module.exports = {
  isDadataEnabled,
  lookupByInn,
  _resetCache,
};
