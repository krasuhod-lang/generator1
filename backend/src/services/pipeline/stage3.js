'use strict';

const { callLLM }           = require('../llm/callLLM');
const { SYSTEM_PROMPTS }    = require('../../prompts/systemPrompts');
const db                    = require('../../config/db');

/**
 * Веса типов блоков для пропорционального распределения символов.
 * Источник: v3.1 index.html (неизменно).
 */
const BLOCK_TYPE_WEIGHTS = {
  offer:     1.4,
  fit:       1.0,
  process:   1.3,
  pricing:   1.1,
  trust:     1.0,
  objection: 0.9,
  faq:       0.8,
};

/**
 * Stage 3: Генерация HTML-контента блок за блоком через Gemini.
 * Адаптер: gemini.
 *
 * @param {object}   task          — строка tasks из БД
 * @param {object}   ctx           — { log, progress, taskId }
 * @param {object[]} taxonomy      — массив блоков из Stage 2 (с routed LSI/n-grams)
 * @param {object}   stage0Result  — результат Stage 0
 * @param {object}   stage1Result  — результат Stage 1 (enriched из Stage 2)
 * @param {object}   stage2Raw     — сырой ответ taxonomy builder
 * @returns {Array<{ blockIndex:number, html:string, status:string }>}
 */
async function runStage3(task, ctx, taxonomy, stage0Result, stage1Result, stage2Raw) {
  const { log, progress, taskId, onTokens } = ctx;

  log('Stage 3: Генерация контента блоков...', 'info');

  const targetService = task.input_target_service;
  const region        = task.input_region        || 'Россия';
  const brandFacts    = task.input_brand_facts   || 'Нет данных';
  const nGrams        = task.input_ngrams        || '';
  const tfIdfData     = task.input_tfidf_weights || '[]';
  const authorName    = task.input_author_name   || 'Эксперт';
  const minChars      = parseInt(task.input_min_chars) || 800;
  const maxChars      = parseInt(task.input_max_chars) || 3500;
  const totalTarget   = Math.floor((minChars + maxChars) / 2);

  // Строим контекст для шаблонов
  const s3stage1Json = JSON.stringify(stage1Result);
  const s3stage2Json = JSON.stringify(stage2Raw || {});

  // Сжатые сигналы из Stage 0
  const stage0Signals   = stage0Result ? JSON.stringify({
    content_gaps:              stage0Result.content_gaps              || [],
    white_space_opportunities: stage0Result.white_space_opportunities || [],
    search_intents:            stage0Result.search_intents            || [],
    niche_segments:            stage0Result.niche_segments            || [],
  }).substring(0, 6000) : 'Нет данных';

  const competitorsData = stage0Result ? JSON.stringify({
    competitor_facts: stage0Result.competitor_facts || [],
    trust_triggers:   stage0Result.trust_triggers   || [],
    dominant_formats: stage0Result.dominant_formats || [],
    faq_bank:         (stage0Result.faq_bank || []).slice(0, 10),
  }).substring(0, 6000) : 'Нет данных';

  const competitorFactsStr = stage0Result
    ? (stage0Result.competitor_facts || []).map(f => f.fact).join('; ').substring(0, 2000)
    : 'Нет данных';

  // Пропорциональные веса блоков
  const blockWeights = taxonomy.map(b => BLOCK_TYPE_WEIGHTS[b.type] || 1.0);
  const weightSum    = blockWeights.reduce((s, w) => s + w, 0);

  const results = [];
  let expertOpinionUsed = false;
  let previousContext   = '';

  for (let i = 0; i < taxonomy.length; i++) {
    const block = taxonomy[i];

    log(`Генерация блока [${i + 1}/${taxonomy.length}]: ${block.h2}...`, 'info');

    // Char count для этого блока
    const blockTargetChars = Math.round(totalTarget * (blockWeights[i] / weightSum)) || 1500;
    const blockMinChars    = Math.round(minChars    * (blockWeights[i] / weightSum)) || 600;
    const blockMaxChars    = Math.round(maxChars    * (blockWeights[i] / weightSum)) || 2500;

    // Роутированные n-граммы блока (или global если не роутированы)
    const blockNgrams = (block.ngrams_must && block.ngrams_must.length)
      ? block.ngrams_must.join(', ')
      : nGrams;

    // Подставляем все плейсхолдеры Stage 3
    const s3prompt = SYSTEM_PROMPTS.stage3
      .replace('{{PAGE_H1}}',            () => targetService)
      .replace('{{TARGET_SERVICE}}',     () => targetService)
      .replace('{{MAIN_QUERY}}',         () => targetService)
      .replace('{{REGION}}',             () => region)
      .replace('{{AUDIENCE}}',           () => 'Широкая аудитория')
      .replace('{{CURRENT_SECTION_JSON}}',() => JSON.stringify(block))
      .replace('{{STAGE1_JSON}}',        () => s3stage1Json)
      .replace('{{STAGE2_JSON}}',        () => s3stage2Json)
      .replace('{{BRAND_FACTS}}',        () => brandFacts)
      .replace('{{KNOWLEDGE_BASE}}',     () => stage0Signals)
      .replace('{{COMPETITOR_SIGNALS}}', () => competitorsData)
      .replace('{{SERVICE_NOTES}}',      () => 'Нет')
      .replace('{{OFFER_DETAILS}}',      () => 'Нет')
      .replace('{{PROOF_ASSETS}}',       () => 'Нет')
      .replace('{{FAQ_BANK}}',           () => stage0Result ? JSON.stringify(stage0Result.faq_bank || []) : 'Нет')
      .replace('{{TERM_WEIGHTS_JSON}}',  () => tfIdfData)
      .replace('{{SECTION_NGRAMS_JSON}}',() => blockNgrams)
      .replace('{{GLOBAL_NGRAMS_JSON}}', () => nGrams)
      .replace('{{TARGET_CHAR_COUNT}}',  () => String(blockTargetChars))
      .replace('{{MIN_CHAR_COUNT}}',     () => String(blockMinChars))
      .replace('{{MAX_CHAR_COUNT}}',     () => String(blockMaxChars))
      .replace('{{STYLE_PROFILE}}',      () => 'Коммерческий, экспертный, без воды')
      .replace('{{EXPERT_OPINION_USED}}',() => expertOpinionUsed.toString())
      .replace('{{AUTHOR_NAME}}',        () => authorName)
      .replace('{{PREVIOUS_HTML}}',      () => previousContext || 'Это первый блок страницы.')
      .replace('{{COMPETITOR_FACTS}}',   () => competitorFactsStr);

    log(`Stage 3 блок ${i + 1}: промпт ${s3prompt.length} символов (~${Math.round(s3prompt.length / 4)} токенов). Запрос...`, 'info');

    let stage3Result = await callLLM(
      'gemini',
      '',
      s3prompt,
      { retries: 3, taskId, stageName: 'stage3', callLabel: `Block ${i + 1} "${block.h2}"`, log, onTokens }
    ).catch(e => {
      log(`Stage 3 блок ${i + 1} ОШИБКА: ${e.message}`, 'error');
      return null;
    });

    // Fallback для FAQ-блоков
    if ((!stage3Result || !stage3Result.html_content) && block.type === 'faq') {
      log(`FAQ fallback для блока ${i + 1}`, 'warn');
      const faqItems = (block.lsi_must || []).slice(0, 5);
      let faqHtml = `<h2>${block.h2}</h2>\n<div class="faq-section">\n`;
      for (const term of faqItems) {
        faqHtml += `<div class="faq-item"><h3>Что такое ${term}?</h3><p>Подробная информация доступна у наших специалистов.</p></div>\n`;
      }
      faqHtml += '</div>';
      stage3Result = { html_content: faqHtml, audit_report: { coverage_percentage: 50, dropped_lsi: [] } };
    }

    if (!stage3Result?.html_content) {
      log(
        `Stage 3 блок ${i + 1}: ОШИБКА — html_content отсутствует. Ключи: [${Object.keys(stage3Result || {}).join(', ')}]. Пропуск.`,
        'error'
      );
      results.push({ blockIndex: i, html: null, status: 'error', block });
      continue;
    }

    log(`Stage 3 блок ${i + 1} получен. Размер HTML: ${stage3Result.html_content.length} символов.`, 'success');

    // Отслеживаем использование экспертного мнения
    if (
      stage3Result.html_content.includes('эксперт:') ||
      stage3Result.html_content.includes(authorName)
    ) {
      expertOpinionUsed = true;
    }

    previousContext = stage3Result.html_content.substring(0, 300) + '...';

    // Сохраняем черновик блока в task_content_blocks
    await db.query(
      `INSERT INTO task_content_blocks
         (task_id, block_index, h2_title, section_type, html_content, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       ON CONFLICT (task_id, block_index) DO UPDATE SET
         h2_title     = EXCLUDED.h2_title,
         section_type = EXCLUDED.section_type,
         html_content = EXCLUDED.html_content,
         status       = 'draft',
         updated_at   = NOW()`,
      [taskId, i, block.h2, block.type || 'generic', stage3Result.html_content]
    );

    results.push({
      blockIndex: i,
      html:       stage3Result.html_content,
      status:     'draft',
      block,
    });

    // Прогресс: Stage 3 занимает 35–65% от общего пайплайна
    const pct = 35 + Math.round(((i + 1) / taxonomy.length) * 30);
    progress(pct, 'stage3');
  }

  log(`Stage 3 завершён. Блоков сгенерировано: ${results.filter(r => r.html).length}/${taxonomy.length}`, 'success');
  return results;
}

module.exports = { runStage3, BLOCK_TYPE_WEIGHTS };
