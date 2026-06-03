'use strict';

/**
 * categoryLead/facetOptimizer.js — ПРОХОД 2: семантический оптимизатор
 * фасетной навигации.
 *
 * Вход:  категория + текущие фильтры + семантическое ядро (GSC/SERP/ручное).
 * Выход: таблица предложений (Rename/New/Merge/Delete + приоритет индексации) +
 *        Топ-3 рекомендации + список фильтров под noindex.
 */

const { callGemini } = require('../llm/gemini.adapter');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');
const { loadCategoryLeadPrompt, fillTemplate } = require('../../prompts/categoryLead');
const { parseLlmJson } = require('./jsonParse');
const { getCategoryLeadConfig } = require('./config');

const SYSTEM_INSTRUCTION =
  'Ты — Senior E-commerce SEO Architect. Отвечай строго валидным JSON по схеме '
  + 'из инструкции, без markdown-обёрток и пояснений. Внутри строк используй '
  + "одинарные кавычки (').";

const VALID_ACTIONS = ['Rename', 'New', 'Merge', 'Delete'];
const VALID_PRIORITY = ['High', 'Med', 'Low'];

function _str(v) { return typeof v === 'string' ? v.trim() : ''; }
function _asArray(v) { return Array.isArray(v) ? v : []; }

function _normAction(v) {
  const s = _str(v);
  const hit = VALID_ACTIONS.find((a) => a.toLowerCase() === s.toLowerCase());
  return hit || 'Rename';
}

function _normPriority(v) {
  const s = _str(v).toLowerCase();
  if (s.startsWith('h')) return 'High';
  if (s.startsWith('l')) return 'Low';
  if (s.startsWith('m')) return 'Med';
  return 'Med';
}

/** Нормализует ответ модели к стабильной форме. */
function normalizeFacetResult(parsed) {
  const r = parsed && typeof parsed === 'object' ? parsed : {};
  const rows = _asArray(r.rows)
    .map((row) => (row && typeof row === 'object' ? {
      current: _str(row.current),
      seo_name: _str(row.seo_name),
      action: _normAction(row.action),
      reason: _str(row.reason),
      index_priority: _normPriority(row.index_priority),
    } : null))
    .filter((row) => row && (row.current || row.seo_name));

  return {
    rows,
    top_recommendations: _asArray(r.top_recommendations).map(_str).filter(Boolean).slice(0, 5),
    noindex_list: _asArray(r.noindex_list).map(_str).filter(Boolean),
  };
}

/**
 * generateFacetOptimization — основной вход прохода 2.
 *
 * @param {object} args
 * @param {string} args.category
 * @param {string} args.filtersText      — текущие фильтры (renderFiltersForPrompt)
 * @param {string} args.semanticCoreText — семантическое ядро / интенты
 * @param {object} [args.options]        — { gemini_model }
 * @returns {Promise<{result:object, meta:object}>}
 */
async function generateFacetOptimization({ category, filtersText, semanticCoreText, options = {} }) {
  const cfg = getCategoryLeadConfig().llm;
  const template = loadCategoryLeadPrompt('facetOptimizer');
  if (!template) throw new Error('categoryLead: facet_optimizer prompt не загружен');

  const userPrompt = fillTemplate(template, {
    CATEGORY: category,
    FILTERS: filtersText,
    SEMANTIC_CORE: semanticCoreText,
  });

  const callRes = await callGemini(SYSTEM_INSTRUCTION, userPrompt, {
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    model: normalizeGeminiCopywritingModel(options.gemini_model),
  });

  const parsed = parseLlmJson(callRes.text);
  const result = normalizeFacetResult(parsed);

  return {
    result,
    meta: {
      model: callRes.model || '',
      tokensIn: callRes.tokensIn || 0,
      tokensOut: callRes.tokensOut || 0,
      thoughtsTokens: callRes.thoughtsTokens || 0,
      cachedTokens: callRes.cachedTokens || 0,
    },
  };
}

module.exports = {
  generateFacetOptimization,
  normalizeFacetResult,
  VALID_ACTIONS,
  VALID_PRIORITY,
};
