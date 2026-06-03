'use strict';

/**
 * categoryLead/pipeline.js — оркестратор инструмента
 * «Lead-text + Фасетный SEO-оптимизатор».
 *
 * Поток (см. схему в постановке):
 *   [A] Сбор фильтров   — ручной ввод + (опц.) парсинг URL категории
 *   [B] Сбор интентов   — (опц.) GSC query×page по показам → кластеры + ручные вопросы
 *   [C] Семантическое ядро — объединение запросов/интентов для Прохода 2
 *   Проход 1 — Lead-text generator (callGemini)
 *   Проход 2 — Facet navigation semantic optimizer (callGemini)
 *   [D] Мост к мета-тегам — High-фасеты → виртуальные ключи + черновик меты
 *   Сохранение результата в category_lead_tasks.
 *
 * Любая ошибка ловится здесь и сохраняется в статус 'error' задачи —
 * контроллер вызывает pipeline fire-and-forget.
 */

const db = require('../../config/db');
const { calcCost } = require('../metrics/priceCalculator');
const { deriveBrandTokens } = require('../projects/commercialIntent');
const { buildLeadContextFromAnalysis } = require('../projects/leadContext');

const { getCategoryLeadConfig } = require('./config');
const { parseManualFilters, fetchFiltersFromUrl, renderFiltersForPrompt } = require('./filterParser');
const { clusterIntents, renderIntentsForPrompt, normalizeQueryRows } = require('./intentClustering');
const { generateLeadText } = require('./leadGenerator');
const { generateFacetOptimization } = require('./facetOptimizer');
const { buildMetaBridge } = require('./metaBridge');

// Aegis-петля: funnel-аналитика и обучающий датасет. Любая ошибка здесь —
// best-effort (не валит генерацию).
const { createFunnelTracker } = require('../aegis/funnelTracker');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const { getAegisFlags } = require('../aegis/featureFlags');

function _str(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * Опциональный сбор интентов из подключённого GSC-проекта.
 * Полностью graceful: при любой ошибке возвращает [].
 *
 * @returns {Promise<Array<{query,impressions,clicks}>>}
 */
async function _collectGscQueries(projectId, userId, pageUrl) {
  if (!projectId) return [];
  try {
    const { rows } = await db.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    const project = rows[0];
    if (!project || !project.gsc_connected || !project.gsc_site_url) return [];

    const { fetchQueryPageMatrix } = require('../projects/gscService');
    const matrix = await fetchQueryPageMatrix(project, { days: 90 });

    const page = _str(pageUrl);
    let filtered = Array.isArray(matrix) ? matrix : [];
    if (page) {
      // Сопоставляем по подстроке пути — выгрузка содержит полные URL.
      const needle = page.toLowerCase();
      const byPage = filtered.filter((r) => _str(r.page).toLowerCase().includes(needle));
      if (byPage.length) filtered = byPage;
    }
    return filtered.map((r) => ({
      query: r.query, impressions: r.impressions, clicks: r.clicks,
    }));
  } catch (err) {
    console.warn('[categoryLead] GSC intent collection failed:', err.message);
    return [];
  }
}

/**
 * _loadProjectContext — defence-in-depth: даже если фронт ничего не передал,
 * на сервере подтягиваем «контекст последнего успешного анализа» (бренд-токены,
 * подсказанные вопросы, ядро) из таблиц `projects` + `project_analyses`.
 *
 * Graceful: при любой ошибке возвращает null.
 */
async function _loadProjectContext(projectId, userId) {
  if (!projectId) return null;
  try {
    const { rows: pRows } = await db.query(
      `SELECT id, name, url, audience_description, gsc_connected, gsc_site_url
         FROM projects WHERE id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    const project = pRows[0];
    if (!project) return null;
    const { rows: aRows } = await db.query(
      `SELECT id, gsc_snapshot, completed_at
         FROM project_analyses
        WHERE project_id = $1 AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1`,
      [project.id],
    );
    const analysis = aRows[0] || null;
    const context = buildLeadContextFromAnalysis({ project, analysis });
    return { project, analysis, context };
  } catch (err) {
    console.warn('[categoryLead] _loadProjectContext failed:', err.message);
    return null;
  }
}

/**
 * processCategoryLeadTask — основной фоновый обработчик задачи.
 */
async function processCategoryLeadTask(taskId) {
  let task;
  try {
    const { rows } = await db.query(
      `SELECT * FROM category_lead_tasks WHERE id = $1`, [taskId],
    );
    task = rows[0];
    if (!task) {
      console.error(`[categoryLead] task ${taskId} not found`);
      return;
    }
  } catch (err) {
    console.error('[categoryLead] load failed:', err.message);
    return;
  }

  await db.query(
    `UPDATE category_lead_tasks
        SET status = 'running', started_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [taskId],
  );

  // Funnel-аналитика — graceful, не валит пайплайн.
  const funnel = createFunnelTracker({
    kind: 'category_lead',
    taskRef: taskId,
    userId: task.user_id || null,
    niche: _str(task.category) || null,
  });
  funnel.step('load');

  try {
    const inputs = task.inputs && typeof task.inputs === 'object' ? task.inputs : {};
    const category = _str(task.category) || _str(inputs.category);
    const options = inputs.options && typeof inputs.options === 'object' ? inputs.options : {};

    // ── Контекст проекта (defence-in-depth) ────────────────────────
    // Если на форме был выбран gsc_project_id, на сервере тоже подтягиваем
    // последний успешный analysis (даже если фронт это уже сделал — мы
    // используем его данные только для пустых полей).
    funnel.step('load_project_context');
    const projectCtx = await _loadProjectContext(inputs.gsc_project_id, task.user_id);

    // ── [A] Фильтры ────────────────────────────────────────────────
    funnel.step('collect_filters');
    let filterGroups = parseManualFilters(inputs.filters);
    const parserDiag = { source: 'manual', url: '', error: '' };
    if (filterGroups.length === 0 && _str(inputs.category_url)) {
      const fetched = await fetchFiltersFromUrl(inputs.category_url);
      parserDiag.source = 'parsed_url';
      parserDiag.url = fetched.url || _str(inputs.category_url);
      if (fetched.ok) filterGroups = fetched.groups;
      else parserDiag.error = fetched.error || 'no_filters_found';
    }
    const filtersText = renderFiltersForPrompt(filterGroups);

    // ── [B] Интенты ────────────────────────────────────────────────
    funnel.step('collect_intents');
    let brandTokens = deriveBrandTokens({
      name: category,
      url: inputs.category_url,
    });
    // Расширяем brand-токены данными из последнего анализа проекта (если
    // проект выбран и есть commercial.brand_tokens / brand_split).
    if (projectCtx && projectCtx.context && Array.isArray(projectCtx.context.brand_tokens)) {
      const set = new Set((brandTokens || []).map((t) => String(t).toLowerCase()));
      for (const t of projectCtx.context.brand_tokens) {
        const s = String(t || '').toLowerCase().trim();
        if (s) set.add(s);
      }
      brandTokens = [...set];
    }

    const gscQueries = await _collectGscQueries(
      inputs.gsc_project_id, task.user_id, inputs.category_url,
    );
    const manualQuestionsRaw = Array.isArray(inputs.questions)
      ? inputs.questions.map(_str).filter(Boolean)
      : [];
    // Defence-in-depth: если пользователь не заполнил questions, а проект
    // имеет analysis — подмешиваем suggested_questions из контекста.
    let manualQuestions = manualQuestionsRaw;
    let questionsSource = 'manual';
    if (manualQuestions.length === 0 && projectCtx && projectCtx.context
        && Array.isArray(projectCtx.context.suggested_questions)
        && projectCtx.context.suggested_questions.length) {
      manualQuestions = projectCtx.context.suggested_questions.slice(0, 16);
      questionsSource = 'project_analysis';
    }

    const clusterResult = clusterIntents(gscQueries, { brandTokens });
    const intentsText = renderIntentsForPrompt(clusterResult, manualQuestions);

    // ── [C] Семантическое ядро для Прохода 2 ───────────────────────
    // Объединяем GSC-запросы (по показам), ручные вопросы, явное ядро и —
    // как запасной источник — ядро из последнего анализа проекта.
    const projectSuggestedCore = (projectCtx && projectCtx.context
      && Array.isArray(projectCtx.context.suggested_core)) ? projectCtx.context.suggested_core : [];
    const userSemanticCore = inputs.semantic_core;
    const semanticCoreSourceFromProject = (
      (Array.isArray(userSemanticCore) && userSemanticCore.length === 0)
      || (typeof userSemanticCore === 'string' && !userSemanticCore.trim())
      || userSemanticCore == null
    ) && projectSuggestedCore.length > 0;

    const coreRows = [
      ...normalizeQueryRows(gscQueries),
      ...normalizeQueryRows(userSemanticCore),
      ...(semanticCoreSourceFromProject ? normalizeQueryRows(projectSuggestedCore) : []),
      ...manualQuestions.map((q) => ({ query: q, impressions: 0, clicks: 0 })),
    ];
    const cfg = getCategoryLeadConfig().limits;
    const semanticCoreText = coreRows.length
      ? coreRows
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, cfg.maxSemanticCore)
        .map((r) => (r.impressions
          ? `- ${r.query} (показы: ${r.impressions})`
          : `- ${r.query}`))
        .join('\n')
      : '(семантическое ядро не задано)';

    // ── Проход 1 — Lead-text ───────────────────────────────────────
    funnel.step('lead_text_pass');
    const lead = await generateLeadText({
      category, filtersText, intentsText, options,
    });

    // ── Проход 2 — Facet optimizer ─────────────────────────────────
    funnel.step('facet_pass');
    const facet = await generateFacetOptimization({
      category, filtersText, semanticCoreText, options,
    });

    // ── [D] Мост к мета-тегам ──────────────────────────────────────
    funnel.step('meta_bridge');
    const metaBridge = buildMetaBridge({
      category, leadResult: lead.result, facetResult: facet.result,
    });

    // ── [E] SEO/GEO 2026: Breadcrumb + ItemList + FAQPage JSON-LD ──
    let jsonLdBlocks = null;
    try {
      const {
        buildBreadcrumbListJsonLd,
        buildFaqPageJsonLd,
        buildItemListJsonLd,
      } = require('../seo/geoSchema');
      const blocksInput = lead.result.json_ld_blocks || {};
      const breadcrumb = buildBreadcrumbListJsonLd(
        Array.isArray(blocksInput.breadcrumb_items) ? blocksInput.breadcrumb_items : []
      );
      const faq = (Array.isArray(blocksInput.faq_items) && blocksInput.faq_items.length >= 1)
        ? buildFaqPageJsonLd(blocksInput.faq_items)
        : null;
      const itemList = (Array.isArray(blocksInput.item_list_about) && blocksInput.item_list_about.length >= 1)
        ? buildItemListJsonLd({
          name: category,
          items: blocksInput.item_list_about.map((s, i) => ({ name: s, position: i + 1 })),
        })
        : null;
      const blocks = [breadcrumb, itemList, faq].filter(Boolean);
      if (blocks.length > 0) jsonLdBlocks = blocks;
    } catch (schemaErr) {
      console.warn('[categoryLead] JSON-LD build failed:', schemaErr.message);
    }

    // ── Стоимость ──────────────────────────────────────────────────
    // priceCalculator.calcCost ждёт семейство модели ('gemini'), а не полное
    // имя — оба прохода идут через callGemini.
    const model = lead.meta.model || facet.meta.model || '';
    const tokensIn = (lead.meta.tokensIn || 0) + (facet.meta.tokensIn || 0);
    const tokensOut = (lead.meta.tokensOut || 0) + (facet.meta.tokensOut || 0);
    let costUsd = 0;
    try {
      costUsd = calcCost('gemini', tokensIn, tokensOut, {
        thoughtsTokens: (lead.meta.thoughtsTokens || 0) + (facet.meta.thoughtsTokens || 0),
        cachedTokens: (lead.meta.cachedTokens || 0) + (facet.meta.cachedTokens || 0),
      });
    } catch (_) { costUsd = 0; }

    const diagnostics = {
      filters: {
        ...parserDiag,
        groups_count: filterGroups.length,
        groups: filterGroups,
      },
      intents: {
        gsc_queries: gscQueries.length,
        manual_questions: manualQuestions.length,
        questions_source: questionsSource,
        clusters: clusterResult.clusters,
        // Источник «контекста» — id последнего анализа, если использовали.
        source_analysis_id: (projectCtx && projectCtx.analysis) ? (projectCtx.analysis.id || null) : null,
        semantic_core_source: semanticCoreSourceFromProject ? 'project_analysis' : 'manual',
      },
    };

    funnel.step('finalize');
    await db.query(
      `UPDATE category_lead_tasks
          SET status = 'done',
              lead_text = $2::jsonb,
              facet_table = $3::jsonb,
              meta = $4::jsonb,
              diagnostics = $5::jsonb,
              llm_model = $6,
              tokens_in = $7,
              tokens_out = $8,
              cost_usd = $9,
              json_ld_blocks = $10::jsonb,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [
        taskId,
        JSON.stringify(lead.result),
        JSON.stringify(facet.result),
        JSON.stringify(metaBridge),
        JSON.stringify(diagnostics),
        model,
        tokensIn,
        tokensOut,
        Number(costUsd) || 0,
        jsonLdBlocks ? JSON.stringify(jsonLdBlocks) : null,
      ],
    );

    // ── Aegis: training example (best-effort) ──────────────────────
    try { await _writeAegisTrainingExample({ task, taskId, category, lead, facet, metaBridge, model, tokensIn, tokensOut, costUsd, brandTokens, filterGroups, clusterResult }); }
    catch (_e) { /* never fail generation on analytics */ }

    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }
  } catch (err) {
    console.error(`[categoryLead] task ${taskId} failed:`, err.message);
    await db.query(
      `UPDATE category_lead_tasks
          SET status = 'error', error_message = $2,
              completed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [taskId, String(err.message || 'Unknown error').slice(0, 1000)],
    );
    try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ }
  }
}

/**
 * Best-effort запись training-example в `aegis_dspy_dataset`. Использует
 * фиктивный qualityScore (= 85) — у Lead-text пока нет агрегированного SPQ,
 * но мы соблюдаем минимальный порог гейта (см. metaTags pipeline для аналога).
 * Контролируется флагом `categoryLead.aegisHooks.trainingDataset`.
 */
async function _writeAegisTrainingExample({
  task, taskId, category, lead, facet, metaBridge, model, tokensIn, tokensOut, costUsd, brandTokens, filterGroups, clusterResult,
}) {
  let hook;
  try { hook = (getAegisFlags().categoryLead || {}).aegisHooks; } catch (_e) { hook = null; }
  if (!hook || hook.trainingDataset === false) return;

  const facetRows = (facet && facet.result && Array.isArray(facet.result.rows)) ? facet.result.rows : [];
  const leadParas = (lead && lead.result && Array.isArray(lead.result.paragraphs)) ? lead.result.paragraphs : [];
  const userPrompt = [
    `category: ${category || ''}`,
    `brand_tokens: ${(brandTokens || []).slice(0, 16).join(', ')}`,
    `filter_groups: ${filterGroups.length}`,
    `clusters: ${(clusterResult && clusterResult.clusters || []).map((c) => c.intent).join(', ')}`,
  ].join('\n');
  const htmlOutput = JSON.stringify({
    lead_paragraphs_count: leadParas.length,
    facet_rows_count: facetRows.length,
    virtual_keys_count: (metaBridge && Array.isArray(metaBridge.virtual_keys)) ? metaBridge.virtual_keys.length : 0,
    paragraphs_chars: leadParas.reduce((s, p) => s + (typeof p === 'string' ? p.length : 0), 0),
  });

  await recordTrainingExample({
    articleRef: `category_lead:${taskId}`,
    kind: 'category_lead',
    niche: category || null,
    userPrompt,
    htmlOutput,
    qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
    gaMetrics: null,
    modelUsed: model || null,
    costUsd: Number(costUsd) || 0,
    userId: task.user_id || null,
  });
}

/**
 * recoverStuckCategoryLeadTasks — при рестарте процесса помечаем «зависшие»
 * running/queued задачи как error (см. metaTags.recoverStuckMetaTagTasks).
 */
async function recoverStuckCategoryLeadTasks() {
  try {
    const { rowCount } = await db.query(
      `UPDATE category_lead_tasks
          SET status = 'error',
              error_message = 'Прервано рестартом сервера',
              completed_at = NOW(), updated_at = NOW()
        WHERE status IN ('queued', 'running')`,
    );
    if (rowCount > 0) {
      console.log(`[categoryLead] recovered ${rowCount} stuck task(s)`);
    }
  } catch (err) {
    console.warn('[categoryLead] recoverStuck failed:', err.message);
  }
}

module.exports = { processCategoryLeadTask, recoverStuckCategoryLeadTasks };
