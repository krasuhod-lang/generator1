'use strict';

const { callLLM }            = require('../llm/callLLM');
const { SYSTEM_PROMPTS, SYSTEM_PROMPTS_EXT } = require('../../prompts/systemPrompts');
const { fillPromptVars }     = require('../../utils/fillPromptVars');
const db                     = require('../../config/db');
const { serializeForPrompt, getEntityClusters } = require('../../utils/knowledgeGraph');
const { getStructureLimits } = require('../../utils/objectiveMetrics');

/**
 * routeLSIToBlocks — механический JS-роутинг (fallback если Gemini routing упал).
 * Каждый термин назначается блоку по круговому принципу (round-robin по индексу).
 */
function routeLSIToBlocksFallback(taxonomy, allLSITerms, allNgramTerms) {
  const blocks = taxonomy.map(b => ({
    ...b,
    lsi_must:    [...(b.lsi_must    || [])],
    ngrams_must: [...(b.ngrams_must || [])],
  }));

  allLSITerms.forEach((term, i) => {
    const idx = i % blocks.length;
    if (!blocks[idx].lsi_must.includes(term)) blocks[idx].lsi_must.push(term);
  });

  allNgramTerms.forEach((term, i) => {
    const idx = i % blocks.length;
    if (!blocks[idx].ngrams_must.includes(term)) blocks[idx].ngrams_must.push(term);
  });

  return blocks;
}

/**
 * Stage 2: Buyer Journey (2A) + Content Format (2B) + Taxonomy (2C) + Semantic LSI routing (2.5).
 * Адаптер: deepseek для всех вызовов (вся аналитика через DeepSeek).
 *
 * @param {object} task         — строка tasks из БД
 * @param {object} ctx          — { log, progress, taskId }
 * @param {object} stage1Result — результат Stage 1
 * @returns {{ taxonomy: array, stage2Raw: object }}
 */
async function runStage2(task, ctx, stage1Result) {
  const { log, progress, taskId, onTokens } = ctx;

  log('Stage 2: Buyer Journey + Content Format + Taxonomy + Semantic LSI routing...', 'info');

  // Пауза — cooldown после 3 параллельных API-вызовов Stage 1
  log('Пауза 3s перед Stage 2 (cooldown после Stage 1)...', 'info');
  await new Promise(r => setTimeout(r, 3000));

  const targetService = task.input_target_service;
  const rawLSI        = task.input_raw_lsi || '';
  const brandFacts    = task.input_brand_facts || '';

  // Строим безопасный stage1 JSON (без обрезания — полный контекст)
  const stage1JsonFull = JSON.stringify(stage1Result);
  const lsiForContext  = rawLSI.substring(0, 800);

  // Strategy digest (Pre-Stage 0). Если контекста нет — пусто.
  const strategyDigest = (task.__strategyDigest || '').trim();
  const strategyAppendix = strategyDigest
    ? `\n\n===== STRATEGY CONTEXT (Pre-Stage 0) =====\n${strategyDigest}\n`
    : '';

  // ── Stage 2A + 2B: Buyer Journey + Content Format (параллельно) ──
  const buyerJourneyContext = `${strategyAppendix}\n\n===== INPUT DATA =====
NICHE / TARGET SERVICE: ${targetService}
STAGE 1 RESULT: ${stage1JsonFull}
LSI TERMS (первые 800 символов): ${lsiForContext}

OUTPUT: Return JSON with buyer_journey_stages (array of stages with queries, content_needs, formats, trust_level). NO markdown.`;

  const contentFormatContext = `${strategyAppendix}\n\n===== INPUT DATA =====
NICHE / TARGET SERVICE: ${targetService}
BUSINESS TYPE: commercial service
STAGE 1 RESULT: ${stage1JsonFull}

AI SEARCH OPPORTUNITY SCANNER CONTEXT:
${SYSTEM_PROMPTS_EXT.aiSearchOpportunity.substring(0, 2000)}

OUTPUT: Return JSON with recommended_formats (array), format_priority_order (array), ai_search_opportunities (array). NO markdown.`;

  const s2aSize = (SYSTEM_PROMPTS_EXT.buyerJourney + buyerJourneyContext).length;
  const s2bSize = (SYSTEM_PROMPTS_EXT.contentFormat + contentFormatContext).length;
  log(`Stage 2A Buyer Journey — промпт ${s2aSize} символов (~${Math.round(s2aSize / 4)} токенов)`, 'info');
  log(`Stage 2B Content Format — промпт ${s2bSize} символов (~${Math.round(s2bSize / 4)} токенов)`, 'info');
  log('Stage 2A + 2B: Запуск параллельно (Promise.all)...', 'info');

  const [buyerJourneyResult, contentFormatResult] = await Promise.all([
    callLLM(
      'deepseek',
      fillPromptVars(SYSTEM_PROMPTS_EXT.buyerJourney, task),
      buyerJourneyContext,
      { retries: 3, taskId, stageName: 'stage2', callLabel: '2A Buyer Journey', temperature: 0.3, log, onTokens }
    ).catch(e => { log(`Stage 2A ОШИБКА: ${e.message}`, 'error'); return null; }),

    callLLM(
      'deepseek',
      fillPromptVars(SYSTEM_PROMPTS_EXT.contentFormat, task),
      contentFormatContext,
      { retries: 3, taskId, stageName: 'stage2', callLabel: '2B Content Format', temperature: 0.3, log, onTokens }
    ).catch(e => { log(`Stage 2B ОШИБКА: ${e.message}`, 'error'); return null; }),
  ]);

  if (!buyerJourneyResult) log('Stage 2A вернул null — продолжаем без Buyer Journey обогащения.', 'warn');
  else log(`Stage 2A: Buyer Journey получен. Стадий: ${(buyerJourneyResult?.buyer_journey_stages || []).length}`, 'success');

  if (!contentFormatResult) log('Stage 2B вернул null — продолжаем без Content Format обогащения.', 'warn');
  else log(`Stage 2B: Content Format получен. Форматов: ${(contentFormatResult?.recommended_formats || []).length}`, 'success');

  // Обогащаем stage1Result данными из 2A и 2B
  const enrichedStage1 = { ...stage1Result };
  if (buyerJourneyResult)  enrichedStage1.buyer_journey    = buyerJourneyResult;
  if (contentFormatResult) enrichedStage1.content_formats  = contentFormatResult;

  // ── Stage 2C: Taxonomy Builder ────────────────────────────────────
  log(`Stage 2 Taxonomy: STAGE1_JSON = ${JSON.stringify(enrichedStage1).length} символов (полный контекст)`, 'info');

  // Serialize Knowledge Graph for Taxonomy context (entity clusters help group H2s)
  const kgContext = enrichedStage1?.knowledge_graph
    ? serializeForPrompt(enrichedStage1.knowledge_graph, 2000)
    : '';
  const kgClusters = enrichedStage1?.knowledge_graph
    ? getEntityClusters(enrichedStage1.knowledge_graph)
    : [];

  let stage2Prompt = SYSTEM_PROMPTS.stage2
    .replace('{{BUSINESS_TYPE}}',   () => task.input_business_type || 'услуги')
    .replace('{{NICHE_FEATURES}}',  () => task.input_niche_features || 'Нет данных')
    .replace('{{TARGET_SERVICE}}', () => targetService)
    .replace(/\{\{BRAND_NAME\}\}/g, () => (task.input_brand_name || '').trim() || 'Нет данных')
    .replace('{{AUDIENCE_PERSONAS}}', () => (task.__audiencePersonasText || 'Нет данных').slice(0, 4000))
    .replace('{{NICHE_DEEP_DIVE}}',   () => (task.__nicheDeepDiveText   || 'Нет данных').slice(0, 4000))
    .replace('{{STAGE1_JSON}}',    () => JSON.stringify(enrichedStage1));

  // Добавляем Knowledge Graph контекст к промпту (не нарушая существующую структуру)
  if (kgContext) {
    stage2Prompt += `\n\n===== KNOWLEDGE GRAPH (Entity Relationships) =====\n${kgContext}`;
    if (kgClusters.length > 0) {
      const clusterStr = kgClusters.slice(0, 8).map(c =>
        `• ${c.centroid} (${c.members.length} entities)`
      ).join('\n');
      stage2Prompt += `\n\nENTITY CLUSTERS (use for H2 grouping):\n${clusterStr}`;
    }
    stage2Prompt += `\nUSE entity clusters above to inform H2 topic grouping. Each H2 should cover a coherent entity cluster.`;
  }

  // Инжектируем стратегический дайджест в taxonomy-промпт (additive, без замены жёстких блоков).
  if (strategyDigest) {
    stage2Prompt += `\n\n${strategyAppendix.trim()}\nUSE strategy context above to ensure taxonomy covers wedge opportunities, must-have E-E-A-T signals and journey-stage queries.`;
  }

  log(`Stage 2 Taxonomy Builder — итоговый промпт ${stage2Prompt.length} символов (~${Math.round(stage2Prompt.length / 4)} токенов). Запуск...`, 'info');

  // Inject structure limits into taxonomy prompt
  const totalChars = parseInt(task.input_max_chars) || 3500;
  const structureLimits = getStructureLimits(totalChars);
  stage2Prompt = stage2Prompt.replace(
    /AT LEAST \d+ AND AT MOST \d+ OBJECTS/,
    `AT LEAST ${structureLimits.minSections} AND AT MOST ${structureLimits.maxSections} OBJECTS`
  );

  let extractedTaxonomy = [];
  let s2Attempts = 0;
  let stage2Raw = null;

  while (extractedTaxonomy.length < 4 && s2Attempts < 3) {
    s2Attempts++;
    if (s2Attempts > 1) {
      stage2Prompt += `\n\n[ПОВТОРНЫЙ ЗАПРОС] Предыдущий ответ содержал ${extractedTaxonomy.length} блоков. ` +
        `Ты ОБЯЗАН создать МИНИМУМ 5-7 независимых H2. ` +
        `Включи: offer, process, pricing, trust, objection, faq. Верни JSON строго по схеме.`;
    }
    log(`Stage 2 Taxonomy попытка ${s2Attempts}/3...`, 'info');

    stage2Raw = await callLLM(
      'deepseek',
      '',
      stage2Prompt,
      { retries: 2, taskId, stageName: 'stage2', callLabel: `2C Taxonomy attempt ${s2Attempts}`, log, onTokens }
    ).catch(e => { log(`Stage 2C Taxonomy ОШИБКА: ${e.message}`, 'error'); return null; });

    if (!stage2Raw) break;

    if (stage2Raw?.page_blueprint?.taxonomy) extractedTaxonomy = stage2Raw.page_blueprint.taxonomy;
    else if (stage2Raw?.taxonomy) extractedTaxonomy = stage2Raw.taxonomy;
    else if (Array.isArray(stage2Raw)) extractedTaxonomy = stage2Raw;

    log(
      `Stage 2 Taxonomy попытка ${s2Attempts}: ключи = [${Object.keys(stage2Raw || {}).join(', ')}], блоков = ${extractedTaxonomy.length}`,
      extractedTaxonomy.length >= 4 ? 'success' : 'warn'
    );
    if (extractedTaxonomy.length < 4) log(`ИИ сгенерировал только ${extractedTaxonomy.length} блоков. Перезапрос...`, 'warn');
  }

  if (!extractedTaxonomy.length) {
    throw new Error('Stage 2: не удалось получить структуру страницы (taxonomy)');
  }

  // Trim taxonomy to maxSections if needed (priority: faq > offer > trust > process > pricing > objection > fit > generic)
  if (extractedTaxonomy.length > structureLimits.maxSections) {
    const typePriority = { faq: 0, offer: 1, trust: 2, process: 3, pricing: 4, objection: 5, fit: 6, generic: 7 };
    const sorted = extractedTaxonomy
      .map((b, idx) => ({ ...b, _origIdx: idx }))
      .sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99));
    const kept = sorted.slice(0, structureLimits.maxSections)
      .sort((a, b) => a._origIdx - b._origIdx)
      .map(({ _origIdx, ...rest }) => rest);
    log(`Stage 2: Обрезка таксономии с ${extractedTaxonomy.length} до ${structureLimits.maxSections} блоков (maxSections)`, 'warn');
    extractedTaxonomy = kept;
  }

  // ── Stage 2.5: Semantic LSI + N-gram routing через Gemini ─────────
  const allLSITerms   = rawLSI.split('\n').map(s => s.trim()).filter(Boolean);
  const allNgramTerms = (task.input_ngrams || '').split(',').map(s => s.trim()).filter(Boolean);

  log(`Stage 2.5: Семантический роутинг ${allLSITerms.length} LSI + ${allNgramTerms.length} n-грамм через DeepSeek...`, 'info');

  const h2List = extractedTaxonomy.map((b, idx) => ({
    idx,
    h2:             b.h2,
    type:           b.type           || '',
    primary_intent: b.primary_intent || '',
  }));

  const lsiRoutingSystem = `ROLE: Semantic SEO Analyst.`;
  const lsiRoutingPrompt = `TASK: Distribute LSI keywords and n-grams across H2 sections of a webpage. Each keyword must go to the most topically relevant section.

SECTIONS (JSON array):
${JSON.stringify(h2List)}

LSI_KEYWORDS (array — all must be routed, none dropped):
${JSON.stringify(allLSITerms)}

NGRAMS (array — all must be routed, none dropped):
${JSON.stringify(allNgramTerms)}

RULES:
1. Every LSI keyword MUST be assigned to at least one section. NO keyword left unrouted.
2. A keyword may appear in multiple sections if relevant to both.
3. Assign keywords based on SEMANTIC MATCH between the keyword and the H2 topic/intent.
4. n-grams follow the same rules as LSI keywords.
5. Return ONLY valid JSON. No markdown. No explanation.

OUTPUT JSON SCHEMA:
{
  "routing": [
    {
      "idx": 0,
      "lsi_must": ["keyword1", "keyword2"],
      "ngrams": ["phrase1", "phrase2"]
    }
  ],
  "unrouted_lsi": [],
  "unrouted_ngrams": []
}`;

  let semanticRouting = null;
  try {
    // Stage 2.5 — это аналитический шаг (классификация LSI/n-грамм по блокам),
    // поэтому используем DeepSeek (политика «аналитика → DeepSeek», Gemini только для генерации).
    semanticRouting = await callLLM(
      'deepseek',
      lsiRoutingSystem,
      lsiRoutingPrompt,
      { retries: 3, taskId, stageName: 'stage2', callLabel: '2.5 Semantic LSI Routing', temperature: 0.2, log, onTokens }
    );
  } catch (e) {
    log(`Stage 2.5 routing error: ${e.message} — fallback to JS routing`, 'warn');
  }

  if (semanticRouting && semanticRouting.routing && Array.isArray(semanticRouting.routing)) {
    // Применяем DeepSeek-роутинг
    for (const route of semanticRouting.routing) {
      const blockIdx = route.idx;
      if (blockIdx >= 0 && blockIdx < extractedTaxonomy.length) {
        const existing       = extractedTaxonomy[blockIdx].lsi_must    || [];
        const existingNgrams = extractedTaxonomy[blockIdx].ngrams_must || [];
        extractedTaxonomy[blockIdx].lsi_must    = Array.from(new Set([...existing,       ...(route.lsi_must || [])]));
        extractedTaxonomy[blockIdx].ngrams_must = Array.from(new Set([...existingNgrams, ...(route.ngrams   || [])]));
      }
    }

    // Нераспределённые LSI — раскидываем равномерно
    const unrouted = semanticRouting.unrouted_lsi || [];
    if (unrouted.length > 0) {
      log(`Stage 2.5: ${unrouted.length} LSI без блока — распределяем равномерно`, 'warn');
      unrouted.forEach((term, i) => {
        const idx = i % extractedTaxonomy.length;
        extractedTaxonomy[idx].lsi_must = Array.from(new Set([...(extractedTaxonomy[idx].lsi_must || []), term]));
      });
    }

    // Нераспределённые n-граммы
    const unroutedNg = semanticRouting.unrouted_ngrams || [];
    if (unroutedNg.length > 0) {
      unroutedNg.forEach((term, i) => {
        const idx = i % extractedTaxonomy.length;
        extractedTaxonomy[idx].ngrams_must = Array.from(new Set([...(extractedTaxonomy[idx].ngrams_must || []), term]));
      });
    }

    log(`Stage 2.5: семантический роутинг завершён. LSI распределены по ${extractedTaxonomy.length} блокам.`, 'success');
  } else {
    // Fallback: механический JS round-robin
    log('Stage 2.5: DeepSeek routing не вернул данные — fallback JS routing', 'warn');
    extractedTaxonomy = routeLSIToBlocksFallback(extractedTaxonomy, allLSITerms, allNgramTerms);
  }

  // Сохраняем в БД
  const stage2Payload = {
    taxonomy:         extractedTaxonomy,
    buyer_journey:    buyerJourneyResult   || null,
    content_formats:  contentFormatResult  || null,
    stage2_raw:       stage2Raw            || null,
  };

  await db.query(
    `UPDATE tasks SET stage2_result = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(stage2Payload), taskId]
  );

  log(
    `Stage 2 завершён. Блоков: ${extractedTaxonomy.length}. Семантический LSI/n-gram роутинг выполнен.`,
    'success'
  );

  progress(35, 'stage2');
  return { taxonomy: extractedTaxonomy, stage2Raw, enrichedStage1 };
}

module.exports = { runStage2 };
