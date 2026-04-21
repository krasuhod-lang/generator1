'use strict';

/**
 * strategyPrompts.js — загрузчик стратегических промтов Pre-Stage 0.
 *
 * Содержимое лежит в `backend/src/prompts/strategy/*.txt` (источник —
 * папка `promt/` в корне репозитория, перенесена сюда чтобы быть
 * частью deployment-артефакта Node-приложения, без зависимости от cwd).
 *
 * Все три промта запускаются один раз на задачу через DeepSeek
 * (см. `services/pipeline/preStage0.js`) и формируют объект
 * `STRATEGY_CONTEXT = { niche_map, opportunity_portfolio, demand_map }`,
 * который затем обогащает все последующие стадии.
 */

const fs   = require('fs');
const path = require('path');

const STRATEGY_DIR = path.join(__dirname, 'strategy');

/**
 * Безопасное чтение текстового промта.
 * Если файл по каким-то причинам отсутствует — возвращает пустую строку,
 * а Pre-Stage 0 деградирует gracefully (соответствующая часть STRATEGY_CONTEXT
 * будет null, остальные стадии продолжают работать).
 */
function readPromptFile(filename) {
  const full = path.join(STRATEGY_DIR, filename);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[strategyPrompts] Failed to read ${filename}: ${err.message}`);
    return '';
  }
}

const NICHE_LANDSCAPE_ANALYZER  = readPromptFile('01-niche-landscape-analyzer.txt');
const MARKET_OPPORTUNITY_FINDER = readPromptFile('02-market-opportunity-finder.txt');
const SEARCH_DEMAND_MAPPER      = readPromptFile('03-search-demand-mapper.txt');

const STRATEGY_PROMPTS = {
  nicheLandscapeAnalyzer:  NICHE_LANDSCAPE_ANALYZER,
  marketOpportunityFinder: MARKET_OPPORTUNITY_FINDER,
  searchDemandMapper:      SEARCH_DEMAND_MAPPER,
};

/**
 * isStrategyAvailable — проверяет, что все три промта прочитаны успешно
 * (минимум 1 КБ каждый — защита от пустых файлов).
 */
function isStrategyAvailable() {
  return Object.values(STRATEGY_PROMPTS).every(p => typeof p === 'string' && p.length > 1024);
}

module.exports = {
  STRATEGY_PROMPTS,
  isStrategyAvailable,
};
