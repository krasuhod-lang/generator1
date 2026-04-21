'use strict';

/**
 * unusedInputsReporter.js — пост-аналитика после Stage 7.
 *
 * Сканирует финальный HTML страницы и сравнивает его с входными артефактами,
 * чтобы выявить, ЧТО из ТЗ и собранных данных НЕ было использовано в контенте.
 * Результат сохраняется в `tasks.unused_inputs` (миграция 006) и отправляется
 * во фронтенд через SSE — это и есть UI-блок «Ограничения проекта → не использовано».
 *
 * Не зависит от LLM: чистая JS-обработка на основе уже существующего
 * `calculateCoverage` (стемминг + нечёткое сравнение). Это исключает риск
 * добавления новых стоимостных вызовов и гарантирует детерминированный отчёт.
 *
 * Связь с другими модулями:
 *   - `calculateCoverage` (utils) — переиспользуется для LSI / n-грамм / фактов.
 *   - `russianStem`        (utils) — лёгкое сравнение фраз с морфологией.
 *   - `db`                  — UPDATE tasks SET unused_inputs = $1 ...
 *   - `sseManager.publish`  — событие `unused_inputs_report` для UI.
 */

const { calculateCoverage } = require('./calculateCoverage');

/**
 * Чистит HTML до plain-text в нижнем регистре (для подстрочного поиска коротких фраз).
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Извлекает список фраз из мультистрочного / списочного поля.
 * Поддерживает разделители: \n, • (bullet), точка с запятой.
 */
function splitListField(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n;]+|•+/)
    .map(s => s.replace(/^[-*\s]+/, '').trim())
    .filter(s => s.length >= 4); // отбрасываем мусор/одиночные символы
}

/**
 * Категория отчёта: каждый элемент списка проверяется на присутствие в HTML.
 * Возвращает структуру { items_total, items_unused: [...], coverage_percent }.
 */
function buildCategory(items, fullHtml, plainText) {
  const cleanItems = (items || []).map(s => String(s).trim()).filter(Boolean);
  if (!cleanItems.length) return { items_total: 0, items_unused: [], coverage_percent: 100 };

  // Для коротких терминов (≤ 3 слов) — стемминг через calculateCoverage.
  // Для длинных фраз — substring-проверка чистого текста (стемминг искажает фразы).
  const short = cleanItems.filter(s => s.split(/\s+/).length <= 3);
  const long  = cleanItems.filter(s => s.split(/\s+/).length >  3);

  const cov = calculateCoverage(fullHtml, short);
  const unusedShort = cov.missing;
  const unusedLong  = long.filter(phrase => {
    const needle = phrase.toLowerCase().trim();
    return needle.length > 0 && !plainText.includes(needle);
  });

  const itemsUnused = [...unusedShort, ...unusedLong];
  const used        = cleanItems.length - itemsUnused.length;

  return {
    items_total:      cleanItems.length,
    items_unused:     itemsUnused,
    coverage_percent: cleanItems.length > 0 ? Math.round((used / cleanItems.length) * 100) : 100,
  };
}

/**
 * Парсит LSI-список из task.input_raw_lsi (по строкам).
 */
function parseLSI(task) {
  return String(task.input_raw_lsi || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Парсит n-граммы из task.input_ngrams (через запятую).
 */
function parseNgrams(task) {
  return String(task.input_ngrams || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Парсит TF-IDF: возвращает только термины, которые в финале вышли в `underuse`.
 */
function parseTfIdfUnderused(task, tfIdfDensity) {
  if (!Array.isArray(tfIdfDensity)) return [];
  return tfIdfDensity
    .filter(t => t.status === 'underuse')
    .map(t => ({ term: t.term, expected_min: t.range_min, actual: t.actual_count }));
}

/**
 * Извлекает «факты конкурентов» из stage0Result.
 */
function parseCompetitorFacts(stage0Result) {
  const facts = (stage0Result?.competitor_facts || []).map(f => f?.fact).filter(Boolean);
  return facts;
}

/**
 * Извлекает trust-триггеры из stage0Result.
 */
function parseTrustTriggers(stage0Result) {
  return (stage0Result?.trust_triggers || []).map(t => t?.trigger).filter(Boolean);
}

/**
 * Извлекает FAQ-bank вопросы из stage0Result (вопросы — не ответы).
 */
function parseFaqQuestions(stage0Result) {
  return (stage0Result?.faq_bank || []).map(q => q?.question).filter(Boolean);
}

/**
 * Извлекает proof_assets из targetPageAnalysis (списком).
 * Поле может быть строкой или массивом — нормализуем.
 */
function parseProofAssets(targetPageAnalysis) {
  if (!targetPageAnalysis?.proof_assets) return [];
  const v = targetPageAnalysis.proof_assets;
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return splitListField(v);
}

/**
 * Извлекает «underexploited gaps» из STRATEGY_CONTEXT (Pre-Stage 0).
 */
function parseStrategyGaps(strategyContext) {
  const op = strategyContext?.opportunity_portfolio;
  if (!op) return [];
  const gaps = (op.underexploited_gaps || []).map(g => g?.gap).filter(Boolean);
  const wedges = (strategyContext?.niche_map?.wedge_opportunities || []).map(w => w?.wedge).filter(Boolean);
  // Объединяем и дедуплицируем
  return Array.from(new Set([...gaps, ...wedges]));
}

/**
 * buildUnusedInputsReport — главная функция модуля.
 *
 * @param {object} params
 * @param {object} params.task              — строка tasks (с input_* полями)
 * @param {string} params.fullHTML          — финальный HTML страницы
 * @param {object} [params.stage0Result]    — результат Stage 0
 * @param {object} [params.strategyContext] — результат Pre-Stage 0
 * @param {object} [params.targetPageAnalysis] — результат анализа целевой страницы
 * @param {Array}  [params.tfIdfDensity]    — массив из computeTfIdfDensity (Stage 7)
 * @returns {object} unusedInputsReport
 */
function buildUnusedInputsReport(params) {
  const {
    task,
    fullHTML,
    stage0Result       = null,
    strategyContext    = null,
    targetPageAnalysis = null,
    tfIdfDensity       = [],
  } = params;

  const plainText = htmlToText(fullHTML);

  const lsi               = buildCategory(parseLSI(task),                       fullHTML, plainText);
  const ngrams            = buildCategory(parseNgrams(task),                    fullHTML, plainText);
  const brandFacts        = buildCategory(splitListField(task.input_brand_facts),     fullHTML, plainText);
  const projectLimits     = buildCategory(splitListField(task.input_project_limits),  fullHTML, plainText);
  const competitorFacts   = buildCategory(parseCompetitorFacts(stage0Result),         fullHTML, plainText);
  const trustTriggers     = buildCategory(parseTrustTriggers(stage0Result),           fullHTML, plainText);
  const faqQuestions      = buildCategory(parseFaqQuestions(stage0Result),            fullHTML, plainText);
  const proofAssets       = buildCategory(parseProofAssets(targetPageAnalysis),       fullHTML, plainText);
  const strategicGaps     = buildCategory(parseStrategyGaps(strategyContext),         fullHTML, plainText);

  const tfIdfUnderused = parseTfIdfUnderused(task, tfIdfDensity);

  // Сводный счётчик «всего неиспользовано»
  const totalUnused =
    lsi.items_unused.length +
    ngrams.items_unused.length +
    brandFacts.items_unused.length +
    projectLimits.items_unused.length +
    competitorFacts.items_unused.length +
    trustTriggers.items_unused.length +
    faqQuestions.items_unused.length +
    proofAssets.items_unused.length +
    strategicGaps.items_unused.length +
    tfIdfUnderused.length;

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_unused_items: totalUnused,
      categories: {
        lsi:                lsi.items_unused.length,
        ngrams:             ngrams.items_unused.length,
        brand_facts:        brandFacts.items_unused.length,
        project_limits:     projectLimits.items_unused.length,
        competitor_facts:   competitorFacts.items_unused.length,
        trust_triggers:     trustTriggers.items_unused.length,
        faq_questions:      faqQuestions.items_unused.length,
        proof_assets:       proofAssets.items_unused.length,
        strategic_gaps:     strategicGaps.items_unused.length,
        tfidf_underused:    tfIdfUnderused.length,
      },
    },
    categories: {
      lsi,
      ngrams,
      brand_facts:      brandFacts,
      project_limits:   projectLimits,
      competitor_facts: competitorFacts,
      trust_triggers:   trustTriggers,
      faq_questions:    faqQuestions,
      proof_assets:     proofAssets,
      strategic_gaps:   strategicGaps,
      tfidf_underused:  { items_total: tfIdfUnderused.length, items_unused: tfIdfUnderused },
    },
  };
}

module.exports = {
  buildUnusedInputsReport,
  // Экспортируем хелперы для unit-тестов / повторного использования.
  htmlToText,
  splitListField,
  buildCategory,
};
