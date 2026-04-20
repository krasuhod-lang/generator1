'use strict';

/**
 * targetPageAnalyzer.js — анализатор целевой страницы и домена.
 *
 * Парсит контент целевой страницы (input_target_url) и отправляет
 * его на AI-анализ для определения:
 *   - целевая аудитория
 *   - особенности ниши
 *   - ограничения проекта
 *   - факты о бренде / продукте / услуге
 *
 * Результаты используются для автозаполнения пустых полей задачи
 * и для обогащения контекста генерации контента.
 */

const { scrapeUrl }    = require('./scraper');
const { callLLM }      = require('../llm/callLLM');

const TARGET_PAGE_ANALYSIS_PROMPT = `Ты — аналитик контента и SEO-эксперт. Проанализируй контент целевой страницы и домена, на котором будет размещён SEO-текст.

═══════════════════════════════════════════
ВХОДНЫЕ ДАННЫЕ
═══════════════════════════════════════════
URL целевой страницы: {{TARGET_URL}}
Контент страницы:
{{PAGE_CONTENT}}

═══════════════════════════════════════════
ЗАДАЧА
═══════════════════════════════════════════
На основании контента страницы определи:

1. TARGET_AUDIENCE (целевая аудитория):
   - Кто является целевым пользователем этого сайта/страницы?
   - Возраст, пол, доход, интересы, боли, потребности
   - Паттерны поведения, мотивация к покупке/обращению
   - Описание должно быть РАЗВЁРНУТЫМ (3-5 предложений)

2. NICHE_FEATURES (особенности ниши):
   - Какая это ниша? Её особенности?
   - YMYL / не-YMYL?
   - Сезонность? Локальная привязка?
   - Уровень конкуренции? Специфика рынка?
   - Каждая особенность — развёрнутое описание (1-2 предложения)

3. PROJECT_LIMITS (ограничения проекта):
   - Какие ограничения видны из контента? (мало контента, устаревший дизайн, нет доказательств экспертизы, отсутствие E-E-A-T сигналов и т.д.)
   - Что можно улучшить?

4. BRAND_FACTS (факты о бренде):
   - Название компании / бренда
   - Продукты / услуги
   - Конкретные цифры, факты, условия, цены (если есть на странице)
   - Лицензии, сертификаты, награды, опыт работы
   - Контактная информация, регион работы

5. SERVICE_DETAILS (детали услуг/продуктов):
   - Какие услуги/продукты предлагаются
   - Условия, цены, сроки
   - Уникальные преимущества (USP)

6. PROOF_ASSETS (доказательства доверия):
   - Отзывы, кейсы, портфолио
   - Лицензии, сертификаты
   - Публикации в СМИ, награды

═══════════════════════════════════════════
ФОРМАТ ОТВЕТА
═══════════════════════════════════════════
Верни строго JSON без markdown-обёрток:
{
  "target_audience": "развёрнутое описание целевой аудитории (3-5 предложений)",
  "niche_features": ["особенность 1 с развёрнутым описанием", "особенность 2..."],
  "project_limits": ["ограничение 1 с описанием", "ограничение 2..."],
  "brand_name": "название бренда или null",
  "brand_facts": "все конкретные факты, цифры, условия, найденные на странице (связный текст)",
  "service_details": "описание услуг/продуктов с условиями и ценами",
  "proof_assets": "доказательства доверия: отзывы, кейсы, лицензии и т.д.",
  "detected_region": "регион работы компании или null",
  "detected_business_type": "тип бизнеса (SaaS/e-commerce/услуги/etc) или null",
  "detected_site_type": "тип сайта (новый/растущий/зрелый/etc) или null"
}

ПРАВИЛА:
- Извлекай ТОЛЬКО то, что РЕАЛЬНО присутствует в контенте страницы.
- Если информации нет — пиши null, не придумывай.
- Для текстовых полей давай РАЗВЁРНУТЫЕ описания, не одно слово.
- СТРОГО JSON, никакого markdown, никакого текста вне JSON.`;

/**
 * analyzeTargetPage — анализирует целевую страницу и домен.
 *
 * @param {string}  targetUrl — URL целевой страницы
 * @param {object}  ctx       — { log, taskId, onTokens }
 * @returns {object|null}     — результат анализа или null при ошибке
 */
async function analyzeTargetPage(targetUrl, ctx) {
  const { log, taskId, onTokens } = ctx;

  if (!targetUrl || !targetUrl.trim()) {
    log('Target Page Analyzer: URL не указан — пропускаем', 'info');
    return null;
  }

  const url = targetUrl.trim();

  // Validate URL format
  try {
    new URL(url);
  } catch {
    log(`Target Page Analyzer: некорректный URL "${url}" — пропускаем`, 'warn');
    return null;
  }

  log(`Target Page Analyzer: парсинг целевой страницы ${url}...`, 'info');

  // Scrape the target page
  let pageData;
  try {
    pageData = await scrapeUrl(url, 25000);
  } catch (err) {
    log(`Target Page Analyzer: ошибка парсинга ${url}: ${err.message}`, 'warn');
    return null;
  }

  if (!pageData || !pageData.markdown || pageData.markdown.length < 100) {
    log(`Target Page Analyzer: недостаточно контента на ${url} (${(pageData?.markdown || '').length} символов)`, 'warn');
    return null;
  }

  log(`Target Page Analyzer: получен контент (${pageData.markdown.length} символов). Запуск AI-анализа...`, 'info');

  // Build the analysis prompt
  const pageContent = pageData.markdown.substring(0, 15000);
  const prompt = TARGET_PAGE_ANALYSIS_PROMPT
    .replace('{{TARGET_URL}}', url)
    .replace('{{PAGE_CONTENT}}', pageContent);

  try {
    const analysisResult = await callLLM(
      'deepseek',
      'Ты — аналитик контента. Анализируй контент страницы и возвращай структурированный JSON. СТРОГО из контента, без галлюцинаций.',
      prompt,
      {
        retries:     2,
        taskId,
        stageName:   'target_page_analysis',
        callLabel:   'Target Page Analysis',
        temperature: 0.2,
        log,
        onTokens,
      }
    );

    if (!analysisResult || typeof analysisResult !== 'object') {
      log('Target Page Analyzer: AI вернул некорректный результат', 'warn');
      return null;
    }

    log(
      `Target Page Analyzer: анализ завершён. ` +
      `Бренд: ${analysisResult.brand_name || 'не определён'}, ` +
      `Регион: ${analysisResult.detected_region || 'не определён'}, ` +
      `Тип бизнеса: ${analysisResult.detected_business_type || 'не определён'}`,
      'success'
    );

    return analysisResult;
  } catch (err) {
    log(`Target Page Analyzer: AI-анализ ошибка: ${err.message}`, 'warn');
    return null;
  }
}

module.exports = { analyzeTargetPage };
