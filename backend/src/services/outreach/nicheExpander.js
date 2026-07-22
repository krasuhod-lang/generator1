'use strict';
/**
 * nicheExpander — определяет нишу бизнеса по запросу и генерирует
 * список serpB2b-задач для мультигео сбора.
 *
 * Использует DeepSeek (дешёвый, быстрый) через существующий callLLM.
 */
const { callLLM } = require('../llm/callLLM');

// Маппинг городов → Яндекс lr-коды (расширить при необходимости)
const CITY_TO_LR = {
  'Москва': '213', 'Санкт-Петербург': '2', 'Краснодар': '35',
  'Екатеринбург': '54', 'Новосибирск': '65', 'Казань': '43',
  'Нижний Новгород': '47', 'Ростов-на-Дону': '39', 'Уфа': '172',
  'Самара': '51', 'Пермь': '50', 'Омск': '66', 'Челябинск': '56',
  'Воронеж': '193', 'Волгоград': '38', 'Красноярск': '62',
  'Тюмень': '55', 'Иркутск': '63', 'Хабаровск': '76', 'Владивосток': '75',
  'Барнаул': '197', 'Ярославль': '16', 'Тольятти': '51',
  'Ставрополь': '36', 'Астрахань': '37', 'Пенза': '49', 'Липецк': '48',
  'Тула': '15', 'Киров': '46', 'Чебоксары': '45', 'Рязань': '10',
  'Томск': '67', 'Кемерово': '64', 'Набережные Челны': '43',
};

const SYSTEM_PROMPT = `Ты — SEO-аналитик. Тебе дают поисковый запрос.
Определи нишу бизнеса и сгенерируй запросы для поиска конкурентов в этой нише.

Верни ТОЛЬКО JSON без markdown:
{
  "niche": "короткое название ниши (1-3 слова)",
  "business_type": "B2B" | "B2C" | "mixed",
  "queries": ["запрос 1 для поиска конкурентов", "запрос 2", "запрос 3"],
  "niche_description": "1-2 предложения описания ниши для персонализации письма"
}

Правила для queries:
- Запросы должны находить САЙТЫ КОМПАНИЙ в этой нише (не статьи, не форумы)
- Используй коммерческие запросы: "услуги", "цены", "заказать", "купить"
- 3 разных варианта запроса`;

async function analyzeNiche(keyword) {
  const result = await callLLM('deepseek', SYSTEM_PROMPT, keyword, {
    retries: 2, temperature: 0.3, maxTokens: 500,
    callLabel: 'outreach.nicheExpander',
  });
  return result;
}

/**
 * Генерирует список параметров для serpB2b-задач по городам.
 * @param {object} params
 * @param {string} params.keyword — исходный запрос
 * @param {string[]} params.cities — список городов
 * @param {string} params.searchEngine — 'yandex' | 'google'
 * @param {number} params.depthPages — глубина SERP
 * @returns {Promise<{analysis: object, serpTasks: object[]}>}
 */
async function expandNicheToGeo({ keyword, cities, searchEngine = 'yandex', depthPages = 3 }) {
  const analysis = await analyzeNiche(keyword);
  const serpTasks = [];

  for (const city of cities) {
    const lr = CITY_TO_LR[city] || '';
    // Берём первые 2 запроса из analysis.queries для каждого города
    const queries = (analysis.queries || [keyword]).slice(0, 2);
    for (const query of queries) {
      serpTasks.push({
        name: `[Outreach] ${analysis.niche} — ${city}`,
        query: `${query} ${city}`,
        search_engine: searchEngine,
        depth_pages: depthPages,
        region: lr,
        _city: city,
        _niche: analysis.niche,
      });
    }
  }

  return { analysis, serpTasks };
}

module.exports = { expandNicheToGeo, analyzeNiche, CITY_TO_LR };
