'use strict';

/**
 * contentPolicy — реестр редактируемых правил контента (V6 «Prompt & Policy Registry»).
 *
 * Позволяет менять stop-фразы, banned formulations, YMYL-флаги и пороги
 * quality gate БЕЗ деплоя — через таблицу content_policy_rules
 * (migration 097). Пока таблица пуста или БД недоступна — используется
 * захардкоженный fallback из defaults.js (в т.ч. исторический STOP_PHRASES
 * из services/pipeline/stage5.js).
 *
 * Архитектура доступа:
 *   • refresh()             — async, подтягивает active-правила из БД в кэш.
 *   • getStopPhrasesSync()  — sync, отдаёт кэш ∪ defaults (для sync-хотпасов
 *                             вроде stage5.checkAntiWater — без await).
 *   • getThresholds()       — sync, defaults ⊕ DB-override.
 *   • isYmylNiche(text)     — sync, эвристика по ключевым словам.
 *
 * Кэш процессный, с TTL. Ошибки БД проглатываются (graceful degradation):
 * реестр НИКОГДА не должен ломать генерацию — только обогащать её правилами.
 */

const {
  DEFAULT_STOP_PHRASES,
  DEFAULT_BANNED_FORMULATIONS,
  DEFAULT_YMYL_KEYWORDS,
  DEFAULT_THRESHOLDS,
  DEFAULT_VALUE_ADD_CATALOG,
} = require('./defaults');

const CACHE_TTL_MS = (() => {
  const v = parseInt(process.env.CONTENT_POLICY_CACHE_TTL_MS, 10);
  return Number.isFinite(v) && v >= 1000 ? v : 60000; // 60s по умолчанию
})();

// Процессный кэш DB-правил. null → ещё ни разу не грузили.
let _cache = null;      // { stopPhrases:[], banned:[], ymyl:[], thresholds:{}, valueAdds:[] }
let _cacheAt = 0;

function _emptyCache() {
  return {
    stopPhrases: [],
    banned:      [],
    ymyl:        [],
    thresholds:  {},
    valueAdds:   [],
  };
}

/**
 * _mergeUnique — объединяет defaults + extra без дублей (case-insensitive для строк).
 * @param {string[]} base
 * @param {string[]} extra
 * @returns {string[]}
 */
function _mergeUnique(base, extra) {
  const out = [];
  const seen = new Set();
  for (const arr of [base, extra]) {
    for (const item of (arr || [])) {
      const s = String(item || '').trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * refresh — асинхронно перечитывает active-правила из content_policy_rules.
 * Безопасно вызывать многократно: пропускает работу, если кэш свежий.
 * @param {object} [opts]
 * @param {boolean} [opts.force] — игнорировать TTL
 * @param {object}  [opts.db]    — pg-клиент (по умолчанию config/db)
 * @returns {Promise<object>} кэш-объект
 */
async function refresh(opts = {}) {
  const now = Date.now();
  if (!opts.force && _cache && (now - _cacheAt) < CACHE_TTL_MS) {
    return _cache;
  }

  const next = _emptyCache();
  try {
    const db = opts.db || require('../../config/db');
    const { rows } = await db.query(
      `SELECT rule_type, payload
         FROM content_policy_rules
        WHERE active = TRUE AND scope = 'global'`,
    );
    for (const r of rows) {
      const p = r.payload || {};
      switch (r.rule_type) {
        case 'stop_phrase':
          if (p.phrase) next.stopPhrases.push(String(p.phrase));
          if (Array.isArray(p.phrases)) next.stopPhrases.push(...p.phrases.map(String));
          break;
        case 'banned_formulation':
          if (p.phrase) next.banned.push(String(p.phrase));
          if (Array.isArray(p.phrases)) next.banned.push(...p.phrases.map(String));
          break;
        case 'ymyl_flag':
          if (p.keyword) next.ymyl.push(String(p.keyword));
          if (Array.isArray(p.keywords)) next.ymyl.push(...p.keywords.map(String));
          break;
        case 'threshold':
          Object.assign(next.thresholds, p);
          break;
        case 'value_add_catalog':
          if (Array.isArray(p.items)) next.valueAdds.push(...p.items.map(String));
          break;
        default:
          break;
      }
    }
    _cache = next;
    _cacheAt = now;
  } catch (e) {
    // БД недоступна / таблицы ещё нет — работаем на defaults.
    // Кэшируем пустой результат на короткий срок, чтобы не долбить БД.
    _cache = next;
    _cacheAt = now;
  }
  return _cache;
}

/** Сбросить кэш (для тестов). */
function _resetCache() { _cache = null; _cacheAt = 0; }

/** Внедрить кэш напрямую (для тестов, без БД). */
function _setCacheForTest(partial) {
  _cache = Object.assign(_emptyCache(), partial || {});
  _cacheAt = Date.now();
}

// ── Sync-аксессоры (defaults ∪ кэш) ───────────────────────────────────

/** @returns {string[]} defaults ∪ DB stop-фразы */
function getStopPhrasesSync() {
  return _mergeUnique(DEFAULT_STOP_PHRASES, _cache ? _cache.stopPhrases : []);
}

/** @returns {string[]} defaults ∪ DB banned formulations */
function getBannedFormulationsSync() {
  return _mergeUnique(DEFAULT_BANNED_FORMULATIONS, _cache ? _cache.banned : []);
}

/** @returns {string[]} defaults ∪ DB YMYL ключевые слова */
function getYmylKeywordsSync() {
  return _mergeUnique(DEFAULT_YMYL_KEYWORDS, _cache ? _cache.ymyl : []);
}

/** @returns {string[]} defaults ∪ DB value-add каталог */
function getValueAddCatalogSync() {
  return _mergeUnique(DEFAULT_VALUE_ADD_CATALOG, _cache ? _cache.valueAdds : []);
}

/**
 * getThresholds — DEFAULT_THRESHOLDS ⊕ DB-override.
 * @param {object} [override] — inline-override (наивысший приоритет)
 * @returns {object}
 */
function getThresholds(override = {}) {
  return Object.assign(
    {},
    DEFAULT_THRESHOLDS,
    (_cache && _cache.thresholds) || {},
    override || {},
  );
}

/**
 * isYmylNiche — эвристика: содержит ли текст (ниша/тема/заголовок) YMYL-маркеры.
 * @param {string} text
 * @returns {boolean}
 */
function isYmylNiche(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  return getYmylKeywordsSync().some((kw) => s.includes(String(kw).toLowerCase()));
}

module.exports = {
  refresh,
  getStopPhrasesSync,
  getBannedFormulationsSync,
  getYmylKeywordsSync,
  getValueAddCatalogSync,
  getThresholds,
  isYmylNiche,
  // exposed for tests
  _resetCache,
  _setCacheForTest,
  _mergeUnique,
};
