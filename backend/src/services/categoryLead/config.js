'use strict';

/**
 * categoryLead/config.js — конфигурация инструмента
 * «Lead-text + Фасетный SEO-оптимизатор».
 *
 * Значения зашиты прямо в код намеренно, по требованию владельца продукта
 * (см. memory «env configuration»): никакого чтения из process.env здесь нет.
 * Чтобы поменять лимиты, число интентов или модель — отредактируй поле и
 * перезапусти backend.
 */

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

const CATEGORY_LEAD_CONFIG = deepFreeze({
  // ── Входные лимиты (защита от мусора и переплаты за LLM) ──────────
  limits: {
    categoryLen:    200,   // длина названия категории
    maxFilterGroups: 40,   // групп фильтров на задачу
    maxFilterValues: 60,   // значений внутри одной группы
    filterLabelLen:  120,  // длина названия группы/значения
    maxQuestions:    50,   // ручных вопросов/интентов
    questionLen:     300,  // длина одного вопроса
    maxSemanticCore: 500,  // строк семантического ядра (GSC/ручное)
  },

  // ── Сбор интентов из GSC ─────────────────────────────────────────
  // Запросы страницы сортируются по ПОКАЗАМ (impressions), берётся топ-N,
  // классифицируются через projects/commercialIntent.classifyQuery и
  // группируются в кластеры. (См. постановку: «сортирую по показам».)
  intents: {
    topByImpressions: 100,  // сколько запросов брать из выгрузки
    maxClusters:      8,    // максимум кластеров интентов в итоге
    minClusterSize:   1,    // минимум запросов в кластере
    sampleQueriesPerCluster: 5, // примеров запросов на кластер (для промпта)
  },

  // ── Парсер фильтров со страницы категории ────────────────────────
  parser: {
    fetchTimeoutMs: 20000,
    maxHtmlBytes:   4 * 1024 * 1024, // 4 МБ — отсекаем гигантские SPA-дампы
    // CSS-селекторы-кандидаты на контейнеры фасетной навигации.
    // Порядок не важен — собираем объединение, потом дедуплицируем.
    facetSelectors: [
      '[class*="filter" i]', '[id*="filter" i]',
      '[class*="facet" i]',  '[id*="facet" i]',
      '[data-filter]', '[data-facet]',
      'aside [class*="catalog" i]', '.sidebar',
    ],
    valueSelectors: [
      'input[type="checkbox"]', 'input[type="radio"]',
      'label', 'a[rel="nofollow"]', 'li a',
    ],
  },

  // ── LLM (тот же стек, что и metaGenerator: callGemini) ────────────
  llm: {
    temperature: 0.4,
    maxTokens:   8192,
    timeoutMs:   90000,
  },

  // ── Мост к инструменту мета-тегов ────────────────────────────────
  // High-приоритетные фасеты превращаются в «виртуальные ключи»
  // «<Категория> + <SEO-значение>», которые можно отправить в /api/meta-tags.
  metaBridge: {
    maxVirtualKeys: 50,
    priorityForKeys: ['High'], // какие приоритеты индексации брать в ключи
  },
});

function getCategoryLeadConfig() {
  return CATEGORY_LEAD_CONFIG;
}

module.exports = { getCategoryLeadConfig, deepFreeze };
