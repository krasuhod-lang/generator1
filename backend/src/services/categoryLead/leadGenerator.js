'use strict';

/**
 * categoryLead/leadGenerator.js — ПРОХОД 1: навигационный Lead-text.
 *
 * Вход:  категория + список фильтров (сущности) + кластеры интентов/вопросы.
 * Выход: 2–3 абзаца (классификация / решение болей / призыв к навигации) +
 *        UX-обоснование + анкоры на подкатегории + JSON-LD + черновик меты.
 *
 * Использует общий callGemini-адаптер (прокси, JSON-strict guard, ретраи) —
 * тот же стек, что и metaGenerator (Stage 3/5/6 пайплайна).
 */

const { callGemini } = require('../llm/gemini.adapter');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');
const { loadCategoryLeadPrompt, fillTemplate } = require('../../prompts/categoryLead');
const { parseLlmJson } = require('./jsonParse');
const { getCategoryLeadConfig } = require('./config');

const SYSTEM_INSTRUCTION =
  'Ты — Senior UX-SEO Strategist. Отвечай строго валидным JSON по схеме из '
  + 'инструкции, без markdown-обёрток и пояснений. Внутри строк используй '
  + "одинарные кавычки (').";

const LEAD_MIN_PARAGRAPHS = 2;

function _asArray(v) { return Array.isArray(v) ? v : []; }
function _str(v) { return typeof v === 'string' ? v.trim() : ''; }

/** Нормализует ответ модели к стабильной форме (защита от пропусков полей). */
function normalizeLeadResult(parsed) {
  const r = parsed && typeof parsed === 'object' ? parsed : {};
  const paragraphs = _asArray(r.paragraphs).map(_str).filter(Boolean);
  const meta = r.category_meta_draft && typeof r.category_meta_draft === 'object'
    ? r.category_meta_draft : {};

  return {
    lead_text_html: _str(r.lead_text_html)
      || paragraphs.map((p) => `<p>${p}</p>`).join(''),
    paragraphs,
    anchor_suggestions: _asArray(r.anchor_suggestions)
      .map((a) => (a && typeof a === 'object'
        ? {
          anchor: _str(a.anchor),
          target_hint: _str(a.target_hint),
          based_on_filter: _str(a.based_on_filter),
        }
        : { anchor: _str(a), target_hint: '', based_on_filter: '' }))
      .filter((a) => a.anchor),
    json_ld: (r.json_ld && typeof r.json_ld === 'object') ? r.json_ld : null,
    json_ld_blocks: (() => {
      const blocks = (r.json_ld_blocks && typeof r.json_ld_blocks === 'object') ? r.json_ld_blocks : {};
      const breadcrumbs = _asArray(blocks.breadcrumb_items)
        .map((b) => (b && typeof b === 'object'
          ? { name: _str(b.name), url: _str(b.url) }
          : null))
        .filter((b) => b && b.name);
      const aboutEntities = _asArray(blocks.item_list_about).map(_str).filter(Boolean);
      const faqItems = _asArray(blocks.faq_items)
        .map((f) => (f && typeof f === 'object'
          ? { q: _str(f.q), a: _str(f.a) }
          : null))
        .filter((f) => f && f.q && f.a);
      return { breadcrumb_items: breadcrumbs, item_list_about: aboutEntities, faq_items: faqItems };
    })(),
    category_meta_draft: {
      title: _str(meta.title),
      description: _str(meta.description),
      h1: _str(meta.h1),
    },
    ux_rationale: _str(r.ux_rationale),
    used_filter_entities: _asArray(r.used_filter_entities).map(_str).filter(Boolean),
  };
}

/**
 * generateLeadText — основной вход прохода 1.
 *
 * @param {object} args
 * @param {string} args.category
 * @param {string} args.filtersText  — отрендеренный список фильтров (renderFiltersForPrompt)
 * @param {string} args.intentsText  — отрендеренные интенты/вопросы (renderIntentsForPrompt)
 * @param {object} [args.options]    — { gemini_model }
 * @returns {Promise<{result:object, meta:object}>}
 */
async function generateLeadText({ category, filtersText, intentsText, options = {} }) {
  const cfg = getCategoryLeadConfig().llm;
  const template = loadCategoryLeadPrompt('leadText');
  if (!template) throw new Error('categoryLead: lead_text prompt не загружен');

  const userPrompt = fillTemplate(template, {
    CATEGORY: category,
    FILTERS: filtersText,
    INTENTS: intentsText,
    YEAR: String(new Date().getFullYear()),
  });

  const callRes = await callGemini(SYSTEM_INSTRUCTION, userPrompt, {
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    model: normalizeGeminiCopywritingModel(options.gemini_model),
  });

  const parsed = parseLlmJson(callRes.text);
  const result = normalizeLeadResult(parsed);

  if (result.paragraphs.length < LEAD_MIN_PARAGRAPHS && !result.lead_text_html) {
    throw new Error('categoryLead: модель вернула пустой lead-text');
  }

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

module.exports = { generateLeadText, normalizeLeadResult };
