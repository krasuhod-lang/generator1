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
  const { expertOpinionUsed = true, brandFacts = '', structureLimits, charLimits } = opts;
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
  if (structureLimits) {
    if (h3Count > structureLimits.maxH3PerSection) {
      issues.push(`Слишком много H3: ${h3Count} (макс ${structureLimits.maxH3PerSection})`);
    }
    if (h3Count < structureLimits.minH3PerSection) {
      issues.push(`Слишком мало H3: ${h3Count} (мин ${structureLimits.minH3PerSection})`);
    }
  } else if (h3Count < 1) {
    issues.push('Нет подзаголовков H3 — текст плохо структурирован');
  }

  if (charLimits) {
    if (charCount > charLimits.maxChars) {
      issues.push(`Превышен лимит символов: ${charCount} (макс ${charLimits.maxChars})`);
    }
    if (charCount < charLimits.minChars) {
      issues.push(`Недостаточно символов: ${charCount} (мин ${charLimits.minChars})`);
    }
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

  // Проверка лишнего blockquote (если экспертное мнение уже использовано в другом блоке)
  if (expertOpinionUsed && hasBlockquote) {
    issues.push('Лишний <blockquote> — экспертное мнение уже использовано в другом блоке (строго 1 раз на статью)');
  }

  // Проверка упоминания бренда из BRAND_FACTS
  if (brandFacts && typeof brandFacts === 'string' && brandFacts !== 'Нет данных') {
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

/**
 * getStructureLimits — возвращает лимиты секций и H3 на основе общего объёма символов.
 * @param {number} totalChars — общее количество символов контента
 * @returns {{ maxSections: number, minSections: number, minH3PerSection: number, maxH3PerSection: number }}
 */
function getStructureLimits(totalChars) {
  if (totalChars < 3000)       return { minSections: 3, maxSections: 4,  minH3PerSection: 2, maxH3PerSection: 3 };
  if (totalChars <= 5000)      return { minSections: 4, maxSections: 5,  minH3PerSection: 2, maxH3PerSection: 3 };
  if (totalChars <= 7000)      return { minSections: 4, maxSections: 5,  minH3PerSection: 2, maxH3PerSection: 4 };
  if (totalChars <= 10000)     return { minSections: 5, maxSections: 6,  minH3PerSection: 2, maxH3PerSection: 4 };
  if (totalChars <= 15000)     return { minSections: 6, maxSections: 8,  minH3PerSection: 3, maxH3PerSection: 5 };
  /* > 15000 */                return { minSections: 7, maxSections: 10, minH3PerSection: 3, maxH3PerSection: 5 };
}

module.exports = { checkObjectiveMetrics, getStructureLimits };
