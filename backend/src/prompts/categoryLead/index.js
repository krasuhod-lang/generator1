'use strict';

/**
 * categoryLead/prompts/index.js — загрузчик промптов инструмента
 * «Lead-text + Фасетный SEO-оптимизатор» (тонкая обёртка над fs, по образцу
 * prompts/infoArticle/index.js).
 *
 * Дополнительно регистрирует оба промпта в promptRegistry для программной
 * валидации {{VARS}} и версионирования (DSPy-inspired).
 */

const fs   = require('fs');
const path = require('path');

const PROMPT_DIR = __dirname;

function readPromptFile(filename) {
  try {
    return fs.readFileSync(path.join(PROMPT_DIR, filename), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[categoryLead/prompts] Failed to read ${filename}: ${err.message}`);
    return '';
  }
}

const PROMPTS = {
  leadText:      readPromptFile('lead_text.txt'),
  facetOptimizer: readPromptFile('facet_optimizer.txt'),
};

// Регистрация в promptRegistry (best-effort — не критично для работы).
try {
  const { registerPrompt } = require('../promptRegistry');
  if (PROMPTS.leadText) {
    registerPrompt('categoryLead.leadText', {
      prompt: PROMPTS.leadText,
      version: '1.0.0',
      inputVars: ['CATEGORY', 'FILTERS', 'INTENTS', 'YEAR'],
      metadata: { module: 'categoryLead', pass: 1 },
    });
  }
  if (PROMPTS.facetOptimizer) {
    registerPrompt('categoryLead.facetOptimizer', {
      prompt: PROMPTS.facetOptimizer,
      version: '1.0.0',
      inputVars: ['CATEGORY', 'FILTERS', 'SEMANTIC_CORE'],
      metadata: { module: 'categoryLead', pass: 2 },
    });
  }
} catch (_) { /* registry optional */ }

function loadCategoryLeadPrompt(name) {
  return PROMPTS[name] || '';
}

/** Подставляет {{VAR}} значениями из map. Безопасно: глобальная замена строкой. */
function fillTemplate(template, vars) {
  let out = String(template || '');
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{{${k}}}`).join(String(v == null ? '' : v));
  }
  return out;
}

module.exports = { PROMPTS, loadCategoryLeadPrompt, fillTemplate };
