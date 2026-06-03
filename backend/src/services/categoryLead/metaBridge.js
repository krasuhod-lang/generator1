'use strict';

/**
 * categoryLead/metaBridge.js — [D] МОСТ К ИНСТРУМЕНТУ МЕТА-ТЕГОВ.
 *
 * Не генерирует мету сам (по принципу DRY) — формирует «виртуальные ключи»
 * вида «<Категория> + <SEO-значение фильтра>» из High-приоритетных строк
 * Прохода 2. Эти ключи пользователь одной кнопкой отправляет в существующий
 * /api/meta-tags, где работают выверенные DrMax-правила.
 *
 * Также собирает:
 *   • category_meta_draft — черновик меты самой категории (из Прохода 1);
 *   • noindex_recommendations — какие фасеты закрыть от индексации (из Прохода 2).
 */

const { getCategoryLeadConfig } = require('./config');

function _str(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * buildVirtualKeys — из строк фасет-оптимизатора собирает ключи для меты.
 * Берём строки с приоритетом из config.metaBridge.priorityForKeys (по умолч.
 * только High) и действием НЕ Delete (удаляемые/мусорные не индексируем).
 *
 * @param {string} category
 * @param {Array}  facetRows — result.rows из facetOptimizer
 * @returns {string[]} уникальные виртуальные ключи
 */
function buildVirtualKeys(category, facetRows) {
  const cfg = getCategoryLeadConfig().metaBridge;
  const cat = _str(category);
  const rows = Array.isArray(facetRows) ? facetRows : [];
  const keys = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row) continue;
    const priority = _str(row.index_priority);
    if (!cfg.priorityForKeys.includes(priority)) continue;
    if (_str(row.action) === 'Delete') continue;

    // Значение для ключа: предпочитаем SEO-название, иначе текущее.
    const value = _str(row.seo_name) || _str(row.current);
    if (!value) continue;

    // Если SEO-значение содержит «Группа: значение» — берём правую часть.
    const colon = value.lastIndexOf(':');
    const tail = colon !== -1 ? value.slice(colon + 1).trim() : value;

    const key = cat ? `${cat} ${tail}`.replace(/\s+/g, ' ').trim() : tail;
    const k = key.toLowerCase();
    if (!key || seen.has(k)) continue;
    seen.add(k);
    keys.push(key);
    if (keys.length >= cfg.maxVirtualKeys) break;
  }

  return keys;
}

/**
 * buildMetaBridge — итоговый блок «мета» задачи.
 *
 * @param {object} args
 * @param {string} args.category
 * @param {object} args.leadResult  — result из leadGenerator (category_meta_draft)
 * @param {object} args.facetResult — result из facetOptimizer (rows, noindex_list)
 * @returns {object}
 */
function buildMetaBridge({ category, leadResult, facetResult }) {
  const lead = leadResult || {};
  const facet = facetResult || {};

  return {
    category_meta_draft: lead.category_meta_draft || { title: '', description: '', h1: '' },
    virtual_keys: buildVirtualKeys(category, facet.rows),
    noindex_recommendations: Array.isArray(facet.noindex_list) ? facet.noindex_list : [],
    // Подсказка для UI: эти ключи можно отправить в POST /api/meta-tags.
    meta_tags_payload_hint: {
      endpoint: '/api/meta-tags',
      field: 'keywords',
    },
  };
}

module.exports = { buildVirtualKeys, buildMetaBridge };
