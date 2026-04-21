'use strict';

const { callLLM }           = require('../llm/callLLM');
const { SYSTEM_PROMPTS }    = require('../../prompts/systemPrompts');
const db                    = require('../../config/db');
const { checkObjectiveMetrics, getStructureLimits } = require('../../utils/objectiveMetrics');
const { checkAntiWater }    = require('./stage5');
const { stripExpertBlockquotes } = require('../../utils/htmlSanitize');
const { runNaturalnessChecks }   = require('../../utils/naturalnessCheck');

/**
 * structuralPreCheck — проверяет базовые E-E-A-T структурные требования блока.
 * Делегирует все проверки в checkObjectiveMetrics() + checkAntiWater() + runNaturalnessChecks().
 * Возвращает массив проблем (пустой = всё ок).
 *
 * @param {string}  html              — HTML-контент блока
 * @param {boolean} expertOpinionUsed — было ли уже использовано экспертное мнение
 * @param {string}  brandFacts        — факты о бренде
 * @param {object}  [structureLimits] — лимиты H3 на блок
 * @param {object}  [extra]           — { brandName, mainQuery } для углублённых проверок
 * @returns {string[]} — массив обнаруженных проблем
 */
function structuralPreCheck(html, expertOpinionUsed, brandFacts, structureLimits, extra = {}) {
  const { brandName = '', mainQuery = '' } = extra;
  const preCheck = checkObjectiveMetrics(html, {
    expertOpinionUsed, brandFacts, brandName, structureLimits,
  });
  const waterPhrases = checkAntiWater(html);
  const naturalness  = runNaturalnessChecks(html, { mainQuery });

  return [
    ...preCheck.issues,
    ...(waterPhrases.length ? [`Стоп-фразы: ${waterPhrases.join(', ')}`] : []),
    ...naturalness.issues,
  ];
}

/**
 * extractHtmlContent — пытается достать html_content из ответа LLM,
 * учитывая частые отклонения от схемы (вложенные ключи, альтернативные имена).
 * Возвращает строку HTML или null.
 */
function extractHtmlContent(result) {
  if (!result || typeof result !== 'object') return null;
  // Прямые варианты, нормализованные в callLLM.normalizeKeys
  const direct = result.html_content || result.htmlcontent || result.html || result.content;
  if (typeof direct === 'string' && direct.trim().length > 50) return direct;

  // Вложенные варианты, которые иногда возвращает Gemini
  const nested = result.audit_report?.html_content
              || result.eeat_self_check?.html_content
              || result.output?.html_content
              || result.section?.html_content;
  if (typeof nested === 'string' && nested.trim().length > 50) return nested;

  return null;
}

/**
 * recoverHtmlContent — recovery-retry для Stage 3, когда ответ не содержит html_content.
 * Просим LLM вернуть ТОЛЬКО html_content, без остальных полей.
 * Возвращает строку HTML или null.
 */
async function recoverHtmlContent(originalPrompt, missingKeys, blockH2, ctx) {
  const { log, taskId, onTokens } = ctx;
  const recoveryPrompt = `${originalPrompt}

⚠️ CRITICAL RECOVERY TASK ⚠️
Your previous response contained ONLY these keys: [${missingKeys.join(', ')}].
The MANDATORY field "html_content" with the actual HTML of the section was MISSING.

NOW respond with STRICT JSON containing ONLY ONE field:
{
  "html_content": "<h2>${blockH2}</h2><p>...full HTML of the section, ending with a closing tag like </p>, </ul>, or </blockquote>...</p>"
}

DO NOT include eeat_self_check, audit_report, or ANY other fields. ONLY html_content with the full <h2>${blockH2}</h2> section HTML, properly closed.`;

  const recovered = await callLLM(
    'gemini',
    '',
    recoveryPrompt,
    { retries: 2, taskId, stageName: 'stage3', callLabel: `Block "${blockH2}" recovery (missing html_content)`, temperature: 0.3, log, onTokens, maxTokens: 8192 }
  ).catch(e => {
    log(`Stage 3 recovery: LLM call ОШИБКА — ${e.message}`, 'warn');
    return null;
  });

  return extractHtmlContent(recovered);
}

/**
 * buildPlaceholderBlock — создаёт минимальный HTML-блок (H2 + 2 параграфа из LSI),
 * чтобы не терять секцию в финальной статье, если все попытки генерации провалились.
 * Это последний рубеж: лучше скромный блок с правильным H2, чем дыра в статье.
 */
function buildPlaceholderBlock(block) {
  const h2   = block.h2 || 'Раздел';
  const lsi  = (block.lsi_must || []).slice(0, 6).filter(Boolean);
  const lead = lsi.length
    ? `Этот раздел посвящён теме «${h2.toLowerCase()}». Ниже — ключевые моменты, которые важно учитывать: ${lsi.join(', ')}.`
    : `Этот раздел посвящён теме «${h2.toLowerCase()}». Ключевые детали уточняйте у наших специалистов.`;
  const tail = `Подробную консультацию по вопросам, связанным с разделом «${h2.toLowerCase()}», вы можете получить, обратившись к нашим менеджерам.`;
  return `<h2>${h2}</h2>\n<p>${lead}</p>\n<p>${tail}</p>`;
}

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
  const tfIdfData     = task.input_tfidf_json || '[]';
  const authorName    = task.input_author_name   || 'Эксперт';
  const minChars      = parseInt(task.input_min_chars) || 800;
  const maxChars      = parseInt(task.input_max_chars) || 3500;
  const totalTarget   = Math.floor((minChars + maxChars) / 2);
  const structureLimits = getStructureLimits(maxChars);

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
      .replace('{{BUSINESS_TYPE}}',      () => task.input_business_type || 'услуги')
      .replace('{{NICHE_FEATURES}}',     () => task.input_niche_features || 'Нет данных')
      .replace('{{PAGE_H1}}',            () => targetService)
      .replace('{{TARGET_SERVICE}}',     () => targetService)
      .replace('{{MAIN_QUERY}}',         () => targetService)
      .replace('{{REGION}}',             () => region)
      .replace('{{AUDIENCE}}',           () => task.input_target_audience || 'Широкая аудитория')
      .replace(/\{\{BRAND_NAME\}\}/g,    () => (task.input_brand_name || '').trim() || 'Нет данных')
      .replace('{{AUDIENCE_PERSONAS}}',  () => (task.__audiencePersonasText  || 'Нет данных').slice(0, 4000))
      .replace('{{NICHE_DEEP_DIVE}}',    () => (task.__nicheDeepDiveText     || 'Нет данных').slice(0, 4000))
      .replace('{{CONTENT_VOICE}}',      () => (task.__contentVoiceText      || 'Нет данных').slice(0, 1500))
      .replace('{{NICHE_TERMINOLOGY}}',  () => (task.__nicheTerminologyText  || 'Нет данных').slice(0, 1000))
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
      .replace('{{COMPETITOR_FACTS}}',   () => competitorFactsStr)
      .replace('{{MIN_H3_COUNT}}', () => String(structureLimits.minH3PerSection))
      .replace('{{MAX_H3_COUNT}}', () => String(structureLimits.maxH3PerSection));

    log(`Stage 3 блок ${i + 1}: промпт ${s3prompt.length} символов (~${Math.round(s3prompt.length / 4)} токенов). Запрос...`, 'info');

    let stage3Result = await callLLM(
      'gemini',
      '',
      s3prompt,
      { retries: 3, taskId, stageName: 'stage3', callLabel: `Block ${i + 1} "${block.h2}"`, temperature: 0.45, log, onTokens }
    ).catch(e => {
      log(`Stage 3 блок ${i + 1} ОШИБКА: ${e.message}`, 'error');
      return null;
    });

    // Structural pre-check: fast retry if basic E-E-A-T structure is missing
    if (stage3Result?.html_content) {
      const issues = structuralPreCheck(stage3Result.html_content, expertOpinionUsed, brandFacts, structureLimits, {
        brandName: (task.input_brand_name || '').trim(),
        mainQuery: targetService,
      });

      if (issues.length > 0) {
        log(`Stage 3 блок ${i + 1}: pre-check НЕ пройден (${issues.join('; ')}). Быстрый retry...`, 'warn');

        const retryResult = await callLLM(
          'gemini',
          '',
          s3prompt + `\n\nCRITICAL STRUCTURAL FIXES REQUIRED:\n${issues.join('\n')}\nFix ALL listed issues above in the generated HTML.`,
          { retries: 2, taskId, stageName: 'stage3', callLabel: `Block ${i + 1} "${block.h2}" retry`, temperature: 0.35, log, onTokens }
        ).catch(() => null);

        if (retryResult?.html_content) {
          log(`Stage 3 блок ${i + 1}: retry успешен (${retryResult.html_content.length} символов)`, 'success');
          stage3Result = retryResult;
        }
      }
    }

    // Fallback для FAQ-блоков
    if ((!stage3Result || !extractHtmlContent(stage3Result)) && block.type === 'faq') {
      log(`FAQ fallback для блока ${i + 1}`, 'warn');
      const faqItems = (block.lsi_must || []).slice(0, 5);
      let faqHtml = `<h2>${block.h2}</h2>\n<div class="faq-section">\n`;
      for (const term of faqItems) {
        faqHtml += `<div class="faq-item"><h3>Что такое ${term}?</h3><p>Подробная информация доступна у наших специалистов.</p></div>\n`;
      }
      faqHtml += '</div>';
      stage3Result = { html_content: faqHtml, audit_report: { coverage_percentage: 50, dropped_lsi: [] } };
    }

    // Recovery: если LLM вернул JSON без html_content — пробуем восстановить отдельным запросом.
    // Так мы не теряем целый блок из-за усечения ответа или отклонения от схемы.
    if (stage3Result && !extractHtmlContent(stage3Result)) {
      const missingKeys = Object.keys(stage3Result);
      log(
        `Stage 3 блок ${i + 1}: html_content отсутствует (ключи: [${missingKeys.join(', ')}]). Пробуем recovery-retry...`,
        'warn'
      );
      const recoveredHtml = await recoverHtmlContent(s3prompt, missingKeys, block.h2, ctx);
      if (recoveredHtml) {
        log(`Stage 3 блок ${i + 1}: recovery успешен (${recoveredHtml.length} символов)`, 'success');
        stage3Result = { html_content: recoveredHtml, audit_report: { coverage_percentage: 50, dropped_lsi: [] } };
      }
    }

    // Final fallback: лучше placeholder с правильным H2, чем дыра в статье.
    const extractedHtml = extractHtmlContent(stage3Result);
    if (!extractedHtml) {
      log(
        `Stage 3 блок ${i + 1}: все попытки провалились — используем placeholder (H2 + LSI). ` +
        `Ключи последнего ответа: [${Object.keys(stage3Result || {}).join(', ')}].`,
        'warn'
      );
      const placeholder = buildPlaceholderBlock(block);
      stage3Result = { html_content: placeholder, audit_report: { coverage_percentage: 0, dropped_lsi: [] } };
    } else if (!stage3Result.html_content) {
      // Нашли HTML во вложенном поле — нормализуем
      stage3Result.html_content = extractedHtml;
    }

    log(`Stage 3 блок ${i + 1} получен. Размер HTML: ${stage3Result.html_content.length} символов.`, 'success');

    // Enforce single expert opinion: strip blockquotes if expert opinion already used
    if (expertOpinionUsed && /<blockquote[\s>]/i.test(stage3Result.html_content)) {
      log(`Stage 3 блок ${i + 1}: экспертное мнение уже использовано — удаляем лишний blockquote`, 'warn');
      stage3Result.html_content = stripExpertBlockquotes(stage3Result.html_content);
    }

    // Отслеживаем использование экспертного мнения
    if (
      stage3Result.html_content.includes('эксперт:') ||
      stage3Result.html_content.includes(authorName)
    ) {
      expertOpinionUsed = true;
    }

    // Передаём расширенный контекст: 800 символов + H2 заголовки всех предыдущих блоков
    const prevH2s = results.filter(r => r.html).map(r => r.block.h2).join(' | ');
    previousContext = `[Предыдущие H2: ${prevH2s}]\n${stage3Result.html_content.substring(0, 800)}`;

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

/**
 * generateSingleBlock — генерация одного HTML-блока.
 * Извлечён из runStage3 для pipeline interleaving.
 *
 * @param {object}  task          — строка tasks из БД
 * @param {object}  ctx           — { log, progress, taskId, onTokens }
 * @param {object}  block         — блок из taxonomy
 * @param {number}  blockIndex    — индекс блока
 * @param {number}  totalBlocks   — общее число блоков
 * @param {object}  genContext    — { targetService, region, brandFacts, nGrams, tfIdfData, authorName,
 *                                    s3stage1Json, s3stage2Json, stage0Signals, competitorsData, competitorFactsStr,
 *                                    blockTargetChars, blockMinChars, blockMaxChars, stage0Result,
 *                                    expertOpinionUsed, previousContext }
 * @returns {{ html: string|null, expertOpinionUsed: boolean, previousContext: string, block: object }}
 */
async function generateSingleBlock(task, ctx, block, blockIndex, totalBlocks, genContext) {
  const { log, taskId, onTokens } = ctx;
  const {
    targetService, region, brandFacts, nGrams, tfIdfData, authorName,
    s3stage1Json, s3stage2Json, stage0Signals, competitorsData, competitorFactsStr,
    blockTargetChars, blockMinChars, blockMaxChars, stage0Result,
    expertOpinionUsed, previousContext, previousH2s,
    serviceNotes, offerDetails, proofAssets,
    blockEntitiesStr, structureLimits,
  } = genContext;

  log(`Генерация блока [${blockIndex + 1}/${totalBlocks}]: ${block.h2}...`, 'info');

  // Compute structureLimits fallback if not passed via genContext
  const maxChars = parseInt(task.input_max_chars) || 3500;
  const effectiveLimits = structureLimits || getStructureLimits(maxChars);

  // Роутированные n-граммы блока (или global если не роутированы)
  const blockNgrams = (block.ngrams_must && block.ngrams_must.length)
    ? block.ngrams_must.join(', ')
    : nGrams;

  // Подставляем все плейсхолдеры Stage 3
  let s3prompt = SYSTEM_PROMPTS.stage3
    .replace('{{BUSINESS_TYPE}}',      () => task.input_business_type || 'услуги')
    .replace('{{NICHE_FEATURES}}',     () => task.input_niche_features || 'Нет данных')
    .replace('{{PAGE_H1}}',            () => targetService)
    .replace('{{TARGET_SERVICE}}',     () => targetService)
    .replace('{{MAIN_QUERY}}',         () => targetService)
    .replace('{{REGION}}',             () => region)
    .replace('{{AUDIENCE}}',           () => task.input_target_audience || 'Широкая аудитория')
    .replace(/\{\{BRAND_NAME\}\}/g,    () => (task.input_brand_name || '').trim() || 'Нет данных')
    .replace('{{AUDIENCE_PERSONAS}}',  () => (task.__audiencePersonasText  || 'Нет данных').slice(0, 4000))
    .replace('{{NICHE_DEEP_DIVE}}',    () => (task.__nicheDeepDiveText     || 'Нет данных').slice(0, 4000))
    .replace('{{CONTENT_VOICE}}',      () => (task.__contentVoiceText      || 'Нет данных').slice(0, 1500))
    .replace('{{NICHE_TERMINOLOGY}}',  () => (task.__nicheTerminologyText  || 'Нет данных').slice(0, 1000))
    .replace('{{CURRENT_SECTION_JSON}}',() => JSON.stringify(block))
    .replace('{{STAGE1_JSON}}',        () => s3stage1Json)
    .replace('{{STAGE2_JSON}}',        () => s3stage2Json)
    .replace('{{BRAND_FACTS}}',        () => brandFacts)
    .replace('{{KNOWLEDGE_BASE}}',     () => stage0Signals)
    .replace('{{COMPETITOR_SIGNALS}}', () => competitorsData)
    .replace('{{SERVICE_NOTES}}',      () => serviceNotes || 'Нет')
    .replace('{{OFFER_DETAILS}}',      () => offerDetails || 'Нет')
    .replace('{{PROOF_ASSETS}}',       () => proofAssets || 'Нет')
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
    .replace('{{COMPETITOR_FACTS}}',   () => competitorFactsStr)
    .replace('{{MIN_H3_COUNT}}', () => String(effectiveLimits.minH3PerSection))
    .replace('{{MAX_H3_COUNT}}', () => String(effectiveLimits.maxH3PerSection));

  // Knowledge Graph: добавляем связанные сущности к промпту блока
  if (blockEntitiesStr) {
    s3prompt += `\n\nKNOWLEDGE GRAPH ENTITIES (related to this H2 section):\n${blockEntitiesStr}\nNaturally weave these entities into the content where semantically appropriate. Do NOT force-insert — only use if they enrich the section.`;
  }

  log(`Stage 3 блок ${blockIndex + 1}: промпт ${s3prompt.length} символов (~${Math.round(s3prompt.length / 4)} токенов). Запрос...`, 'info');

  let stage3Result = await callLLM(
    'gemini',
    '',
    s3prompt,
    { retries: 3, taskId, stageName: 'stage3', callLabel: `Block ${blockIndex + 1} "${block.h2}"`, temperature: 0.45, log, onTokens }
  ).catch(e => {
    log(`Stage 3 блок ${blockIndex + 1} ОШИБКА: ${e.message}`, 'error');
    return null;
  });

  // Structural pre-check: fast retry if basic E-E-A-T structure is missing
  if (stage3Result?.html_content) {
    const issues = structuralPreCheck(stage3Result.html_content, expertOpinionUsed, brandFacts, effectiveLimits, {
      brandName: (task.input_brand_name || '').trim(),
      mainQuery: targetService,
    });

    if (issues.length > 0) {
      log(`Stage 3 блок ${blockIndex + 1}: pre-check НЕ пройден (${issues.join('; ')}). Быстрый retry...`, 'warn');

      const retryResult = await callLLM(
        'gemini',
        '',
        s3prompt + `\n\nCRITICAL STRUCTURAL FIXES REQUIRED:\n${issues.join('\n')}\nFix ALL listed issues above in the generated HTML.`,
        { retries: 2, taskId, stageName: 'stage3', callLabel: `Block ${blockIndex + 1} "${block.h2}" retry`, temperature: 0.35, log, onTokens }
      ).catch(() => null);

      if (retryResult?.html_content) {
        log(`Stage 3 блок ${blockIndex + 1}: retry успешен (${retryResult.html_content.length} символов)`, 'success');
        stage3Result = retryResult;
      }
    }
  }

  // Fallback для FAQ-блоков
  if ((!stage3Result || !extractHtmlContent(stage3Result)) && block.type === 'faq') {
    log(`FAQ fallback для блока ${blockIndex + 1}`, 'warn');
    const faqItems = (block.lsi_must || []).slice(0, 5);
    let faqHtml = `<h2>${block.h2}</h2>\n<div class="faq-section">\n`;
    for (const term of faqItems) {
      faqHtml += `<div class="faq-item"><h3>Что такое ${term}?</h3><p>Подробная информация доступна у наших специалистов.</p></div>\n`;
    }
    faqHtml += '</div>';
    stage3Result = { html_content: faqHtml, audit_report: { coverage_percentage: 50, dropped_lsi: [] } };
  }

  // Recovery: если LLM вернул JSON без html_content — пробуем восстановить отдельным запросом.
  if (stage3Result && !extractHtmlContent(stage3Result)) {
    const missingKeys = Object.keys(stage3Result);
    log(
      `Stage 3 блок ${blockIndex + 1}: html_content отсутствует (ключи: [${missingKeys.join(', ')}]). Пробуем recovery-retry...`,
      'warn'
    );
    const recoveredHtml = await recoverHtmlContent(s3prompt, missingKeys, block.h2, ctx);
    if (recoveredHtml) {
      log(`Stage 3 блок ${blockIndex + 1}: recovery успешен (${recoveredHtml.length} символов)`, 'success');
      stage3Result = { html_content: recoveredHtml, audit_report: { coverage_percentage: 50, dropped_lsi: [] } };
    }
  }

  // Final fallback: лучше placeholder с правильным H2, чем дыра в статье.
  const extractedHtml = extractHtmlContent(stage3Result);
  if (!extractedHtml) {
    log(
      `Stage 3 блок ${blockIndex + 1}: все попытки провалились — используем placeholder (H2 + LSI). ` +
      `Ключи последнего ответа: [${Object.keys(stage3Result || {}).join(', ')}].`,
      'warn'
    );
    const placeholder = buildPlaceholderBlock(block);
    stage3Result = { html_content: placeholder, audit_report: { coverage_percentage: 0, dropped_lsi: [] } };
  } else if (!stage3Result.html_content) {
    stage3Result.html_content = extractedHtml;
  }

  log(`Stage 3 блок ${blockIndex + 1} получен. Размер HTML: ${stage3Result.html_content.length} символов.`, 'success');

  // Enforce single expert opinion: strip blockquotes if expert opinion already used
  if (expertOpinionUsed && /<blockquote[\s>]/i.test(stage3Result.html_content)) {
    log(`Stage 3 блок ${blockIndex + 1}: экспертное мнение уже использовано — удаляем лишний blockquote`, 'warn');
    stage3Result.html_content = stripExpertBlockquotes(stage3Result.html_content);
  }

  // Отслеживаем использование экспертного мнения
  let updatedExpertUsed = expertOpinionUsed;
  if (
    stage3Result.html_content.includes('эксперт:') ||
    stage3Result.html_content.includes(authorName)
  ) {
    updatedExpertUsed = true;
  }

  // Передаём расширенный контекст: 800 символов + H2 заголовки всех предыдущих блоков
  const newPreviousContext = `[Предыдущие H2: ${previousH2s}]\n${stage3Result.html_content.substring(0, 800)}`;

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
    [taskId, blockIndex, block.h2, block.type || 'generic', stage3Result.html_content]
  );

  return {
    html: stage3Result.html_content,
    expertOpinionUsed: updatedExpertUsed,
    previousContext: newPreviousContext,
    block,
  };
}

module.exports = { runStage3, generateSingleBlock, BLOCK_TYPE_WEIGHTS };
