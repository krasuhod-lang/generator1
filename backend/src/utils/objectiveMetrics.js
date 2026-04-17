'use strict';

/**
 * stripTags — многопроходная очистка HTML-тегов.
 * Используется только для подсчёта метрик (не для вывода / санитизации пользовательского контента).
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  let result = html;
  // Multi-pass to handle nested/malformed tags
  let prev = '';
  while (prev !== result) {
    prev = result;
    result = result.replace(/<[^>]+>/g, ' ');
  }
  return result;
}

/**
 * objectiveMetrics — программные (не LLM) метрики качества HTML-блока.
 * Используются в orchestrator.js для дополнительной проверки:
 * если объективные метрики не проходят — Stage 5 рефайн запускается
 * даже при высоком PQ-score от LLM.
 *
 * @param {string} html — HTML-контент блока
 * @param {object} [opts] — дополнительные параметры
 * @param {boolean} [opts.expertOpinionUsed=true] — было ли уже использовано экспертное мнение
 * @param {string}  [opts.brandFacts=''] — факты о бренде для проверки упоминания
 * @returns {{ passed: boolean, issues: string[], metrics: object }}
 */
function checkObjectiveMetrics(html, opts = {}) {
  const { expertOpinionUsed = true, brandFacts = '' } = opts;
  const issues = [];
  const text = stripTags(html).replace(/\s+/g, ' ').trim();

  // Структурные проверки
  const h3Count       = (html.match(/<h3[\s>]/gi) || []).length;
  const hasList       = /<(ul|ol)[\s>]/i.test(html);
  const hasBlockquote = /<blockquote[\s>]/i.test(html);
  const hasTable      = /<table[\s>]/i.test(html);
  const hasLinks      = /<a\s/i.test(html);
  const paragraphCount = (html.match(/<p[\s>]/gi) || []).length;

  // Текстовые проверки
  const charCount = text.length;

  // Проверка длинных абзацев (>500 символов чистого текста = стена текста)
  const paragraphMatches = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  let longParagraphs = 0;
  for (const p of paragraphMatches) {
    const pText = stripTags(p).trim();
    if (pText.length > 500) longParagraphs++;
  }

  // Метрики
  const metrics = {
    h3_count:         h3Count,
    has_list:         hasList,
    has_blockquote:   hasBlockquote,
    has_table:        hasTable,
    has_links:        hasLinks,
    paragraph_count:  paragraphCount,
    char_count:       charCount,
    long_paragraphs:  longParagraphs,
  };

  // Валидация
  if (h3Count < 1) {
    issues.push('Нет подзаголовков H3 — текст плохо структурирован');
  }

  if (!hasList && !hasTable) {
    issues.push('Нет списков и таблиц — текст трудно сканировать');
  }

  if (hasLinks) {
    issues.push('Найдены <a> ссылки — запрещены');
  }

  if (longParagraphs > 0) {
    issues.push(`${longParagraphs} длинных абзацев (>500 символов) — стена текста`);
  }

  if (paragraphCount < 2) {
    issues.push('Менее 2 абзацев — слишком мало структуры');
  }

  // Проверка наличия blockquote (если экспертное мнение ещё не использовано)
  if (!expertOpinionUsed && !hasBlockquote) {
    issues.push('Нет <blockquote> с экспертным мнением — необходимо для Expertise E-E-A-T');
  }

  // Проверка упоминания бренда из BRAND_FACTS
  if (brandFacts && brandFacts !== 'Нет данных') {
    const brandToken = brandFacts.split(/[\s,.:;]+/).find(w => w.length > 3);
    if (brandToken && !text.toLowerCase().includes(brandToken.toLowerCase())) {
      issues.push(`Бренд "${brandToken}" не упомянут — необходимо для Authoritativeness E-E-A-T`);
    }
  }

  return {
    passed:  issues.length === 0,
    issues,
    metrics,
  };
}

module.exports = { checkObjectiveMetrics };
