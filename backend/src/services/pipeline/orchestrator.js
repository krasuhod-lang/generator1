'use strict';

/**
 * orchestrator — главный конечный автомат пайплайна Tasks (8 стадий +
 * meta/relevance/article-topics submodules).
 *
 * ─────────────────────────────────────────────────────────────────────
 * КАРТА КЭШИРОВАНИЯ (R = читает, W = пишет, RW = и то и другое):
 * Используется для resume после рестарта воркера и для передачи данных
 * между стадиями без повторных LLM-вызовов.
 *
 *   Стадия              | Колонка в `tasks`                | R/W
 *   --------------------+----------------------------------+------
 *   stage0  (scraper)   | stage0_result                    | W
 *   stage1  (entities)  | stage0_result → stage1_result    | R/W
 *   stage2  (queries)   | stage1_result → stage2_result    | R/W
 *   stage3  (writer)    | stage2_result → stage3_result    | R/W
 *   stage4  (post-edit) | stage3_result → stage4_result    | R/W
 *   stage5  (e-e-a-t)   | stage4_result → stage5_result    | R/W
 *   stage6  (lsi/refine)| stage5_result → stage6_result    | R/W
 *   stage7  (meta)      | stage6_result → stage7_result    | R/W
 *   stage8  (final)     | stage7_result → article_html     | R/W
 *
 *   Submodules:
 *     info_article_tasks / link_article_tasks — собственный пайплайн со
 *       своими колонками (см. headers infoArticlePipeline.js и
 *       linkArticlePipeline.js). Также квалити-отчёты: eeat_audit,
 *       lsi_report, readability_report, intent_verdict, fact_check_report,
 *       plagiarism_report, lsi_overdose_report, image_qa_report,
 *       validation_report, quality_score (миграция 037).
 *
 *   Между задачами:
 *     • `responseCache` (Redis) — кэш HTTP-ответов LLM. См. header
 *       `backend/src/services/llm/responseCache.js`.
 *     • Gemini Context Caching — серверный кэш Google, name хранится
 *       в `*_tasks.gemini_cache_name`. Действует только в пределах
 *       одной задачи (создаётся в IAKB/LinkAKB, переиспользуется
 *       Stage 3/5/6, удаляется в finally).
 *
 * При ре-старте воркера каждая стадия должна:
 *   1) попробовать прочитать свой `*_result` из БД;
 *   2) если уже заполнен — пропустить LLM-вызов;
 *   3) иначе выполнить LLM-вызов и записать `*_result`.
 * ─────────────────────────────────────────────────────────────────────
 */

const db              = require('../../config/db');
const { publish }     = require('../sse/sseManager');

// ─────────────────────────────────────────────────────────────────────────────
// PipelinePausedError — бросается при обнаружении запроса на паузу.
// Worker перехватывает этот класс отдельно от обычных ошибок.
// ─────────────────────────────────────────────────────────────────────────────

class PipelinePausedError extends Error {
  constructor(checkpoint) {
    super('Pipeline paused by user request');
    this.name       = 'PipelinePausedError';
    this.checkpoint = checkpoint;
  }
}

/**
 * savePipelineCheckpoint — сохраняет состояние пайплайна в БД.
 * @param {string} taskId
 * @param {object} checkpoint
 */
async function savePipelineCheckpoint(taskId, checkpoint) {
  await db.query(
    `UPDATE tasks SET pipeline_checkpoint = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(checkpoint), taskId]
  );
}

/**
 * checkPauseRequested — проверяет, запрошена ли пауза для задачи.
 * Читает статус задачи из БД.
 * @param {string} taskId
 * @returns {Promise<boolean>}
 */
async function checkPauseRequested(taskId) {
  const { rows } = await db.query(
    `SELECT status FROM tasks WHERE id = $1`,
    [taskId]
  );
  return rows[0]?.status === 'pausing';
}

/**
 * loadDoneBlock — загружает уже готовый блок из task_content_blocks.
 * @param {string} taskId
 * @param {number} blockIndex
 * @returns {Promise<object|null>}
 */
async function loadDoneBlock(taskId, blockIndex) {
  const { rows } = await db.query(
    `SELECT * FROM task_content_blocks WHERE task_id = $1 AND block_index = $2 AND status = 'done'`,
    [taskId, blockIndex]
  );
  return rows[0] || null;
}
const { runStage0 }   = require('./stage0');
const { runStage1 }   = require('./stage1');
const { runStage2 }   = require('./stage2');
const { generateSingleBlock, BLOCK_TYPE_WEIGHTS } = require('./stage3');
const { runStage4 }   = require('./stage4');
const { runStage5, checkAntiWater } = require('./stage5');
const { runStage6 }   = require('./stage6');
const { runStage7 }   = require('./stage7');
const { calculateCoverage } = require('../../utils/calculateCoverage');
const { checkObjectiveMetrics, getStructureLimits, LSI_COVERAGE_TARGET, EEAT_PQ_TARGET } = require('../../utils/objectiveMetrics');
const { stripExpertBlockquotes, stripNoDataMarkers } = require('../../utils/htmlSanitize');
const { analyzeTargetPage } = require('../parser/targetPageAnalyzer');
const { analyzeAudienceAndNiche, serializeAnalysisForPrompt } = require('../parser/audienceNicheAnalyzer');
const { getRelatedEntities } = require('../../utils/knowledgeGraph');
const { runPreStage0, buildStrategyDigest } = require('./preStage0');
const { buildUnusedInputsReport } = require('../../utils/unusedInputsReporter');
const { extractPriceData: extractMetaPriceData } = require('../metaTags/metaGenerator');
const { buildArticleKnowledgeBase } = require('../../utils/articleKnowledgeBase');
const { deriveModuleContext } = require('../../utils/moduleContext');
const { richTextToPlain, isBlankRichText } = require('../../utils/stripHtmlTags');
const { runStage8Evaluator, isStage8Enabled } = require('./stage8');
const { buildEeatContract, validateEeatContract } = require('../eeatAudit/contentContract');
const { createCachedContent, deleteCachedContent } = require('../llm/gemini.adapter');
const { resetTaskBudget, getConfiguredTaskTokenBudget } = require('../llm/callLLM');
const { estimateTokens } = require('../metrics/priceCalculator');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');
const { buildWriterContext } = require('../../utils/writerContext');
const { normalizeTz, hasTz } = require('./tzParser');

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сохраняет финальное состояние блока в task_content_blocks.
 */
async function saveContentBlock(taskId, blockIndex, block, html, pqScore, lsiCoverage, auditLog) {
  await db.query(
    `INSERT INTO task_content_blocks
       (task_id, block_index, h2_title, section_type,
        html_content, status, lsi_coverage, pq_score, audit_log_json)
     VALUES ($1, $2, $3, $4, $5, 'done', $6, $7, $8)
     ON CONFLICT (task_id, block_index) DO UPDATE SET
       h2_title       = EXCLUDED.h2_title,
       section_type   = EXCLUDED.section_type,
       html_content   = EXCLUDED.html_content,
       status         = 'done',
       lsi_coverage   = EXCLUDED.lsi_coverage,
       pq_score       = EXCLUDED.pq_score,
       audit_log_json = EXCLUDED.audit_log_json,
       updated_at     = NOW()`,
    [
      taskId,
      blockIndex,
      block.h2       || '',
      block.type     || 'generic',
      html,
      lsiCoverage,
      pqScore,
      JSON.stringify(auditLog || {}),
    ]
  );
}

/**
 * Помечает блок как ошибочный в БД.
 */
async function markBlockError(taskId, blockIndex, block, errorMsg) {
  await db.query(
    `INSERT INTO task_content_blocks
       (task_id, block_index, h2_title, section_type, html_content, status, audit_log_json)
     VALUES ($1, $2, $3, $4, '', 'error', $5)
     ON CONFLICT (task_id, block_index) DO UPDATE SET
       status         = 'error',
       audit_log_json = EXCLUDED.audit_log_json,
       updated_at     = NOW()`,
    [taskId, blockIndex, block.h2 || '', block.type || 'generic', JSON.stringify({ error: errorMsg })]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Главная функция пайплайна
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runPipeline — полный пайплайн Stage 0 → Stage 7.
 *
 * Схема (ТЗ §8):
 *   Stage 0: Конкурентный анализ (deepseek ×2)
 *   Stage 1: Entity + Intent + Community (deepseek ×3, Promise.all)
 *   Stage 2: Buyer Journey + Content Format + Taxonomy + LSI routing
 *   Stage 3–6: Цикл по блокам: генерация → аудит → PQ-рефайн → LSI-инъекция
 *   Stage 7: Глобальный аудит + BM25 + сохранение метрик
 *
 * @param {object} task — строка из таблицы tasks
 * @param {object} ctx  — { log, progress, job?, resumeFrom? }
 */
async function runPipeline(task, ctx) {
  const { log, progress, resumeFrom = null } = ctx;
  const taskId = task.id;

  // ctx.log уже публикует через worker.js → publish() + console.log
  // Не оборачиваем — иначе каждое сообщение будет отправлено дважды

  // onTokens — публикует SSE-событие {type:"tokens"} после каждого LLM-вызова
  // Фронтенд обновляет счётчики DeepSeek/Gemini в реальном времени
  const onTokens = (model, tokensIn, tokensOut, costUsd) => {
    publish(taskId, {
      type:      'tokens',
      model:     model === 'gemini' ? 'gemini' : 'deepseek',
      tokensIn,
      tokensOut,
      cost:      costUsd,
    });
  };

  // Обогащённый контекст — все stage-функции получают onTokens
  const stageCtx = { log, progress, taskId, onTokens };

  log(`Пайплайн запущен для задачи "${task.input_target_service}"`, 'info');

  // ── Конвертируем rich-text HTML описаний в plain text для LLM-промптов ──
  const RICH_TEXT_FIELDS = [
    'input_target_audience', 'input_project_limits',
    'input_page_priorities', 'input_niche_features', 'input_brand_facts',
  ];
  for (const f of RICH_TEXT_FIELDS) {
    // «Визуально пустые» значения (`<p></p>`, одинокий маркер «• ») сбрасываем
    // в '': иначе они считаются заполненными и блокируют дозаполнение из
    // анализа целевой страницы ниже, а в промты уходит пустой буллит.
    if (isBlankRichText(task[f])) task[f] = '';
    else if (task[f]) task[f] = richTextToPlain(task[f]);
  }

  // ── TZ Binding: если parse-tz уже заполнил input_tz_parsed_json, но новая
  // нормализованная колонка ещё пустая, один раз переносим ТЗ в tz_json.
  if (!hasTz(task) && task.input_tz_parsed_json && !task.tz_json) {
    try {
      const normalizedTz = normalizeTz(task.input_tz_parsed_json);
      task.tz_json = normalizedTz;
      task.tz_source = 'relevance_tool';
      await db.query(
        `UPDATE tasks
            SET tz_json = $1, tz_source = $2, updated_at = NOW()
          WHERE id = $3 AND tz_json IS NULL`,
        [JSON.stringify(normalizedTz), task.tz_source, taskId],
      );
      log('TZ Binding: input_tz_parsed_json нормализован в tasks.tz_json', 'info');
    } catch (e) {
      log(`TZ Binding: нормализация ТЗ пропущена (${e.message})`, 'warn');
    }
  }

  const pipelineStartedAt = Date.now();

  // ── Target Page Analysis (анализ целевой страницы) ──────────────
  // Если указан URL целевой страницы — анализируем контент и обогащаем задачу
  let targetPageAnalysis = null;
  if (task.input_target_url?.trim()) {
    try {
      log('Target Page Analysis: запуск анализа целевой страницы...', 'info');
      progress(1, 'target_page_analysis');

      targetPageAnalysis = await analyzeTargetPage(task.input_target_url, stageCtx);

      if (targetPageAnalysis) {
        // Enrich task fields with analysis data (only if fields are empty)
        // NOTE: Region and Brand Name are NOT auto-filled — user fills them manually
        const updates = {};

        if (!task.input_target_audience?.trim() && targetPageAnalysis.target_audience) {
          task.input_target_audience = targetPageAnalysis.target_audience;
          updates.input_target_audience = targetPageAnalysis.target_audience;
        }
        if (!task.input_niche_features?.trim() && targetPageAnalysis.niche_features?.length) {
          const nicheStr = targetPageAnalysis.niche_features.map(f => `• ${f}`).join('\n');
          task.input_niche_features = nicheStr;
          updates.input_niche_features = nicheStr;
        }
        if (!task.input_project_limits?.trim() && targetPageAnalysis.project_limits?.length) {
          const limitsStr = targetPageAnalysis.project_limits.map(l => `• ${l}`).join('\n');
          task.input_project_limits = limitsStr;
          updates.input_project_limits = limitsStr;
        }
        if (!task.input_brand_facts?.trim() && targetPageAnalysis.brand_facts) {
          task.input_brand_facts = targetPageAnalysis.brand_facts;
          updates.input_brand_facts = targetPageAnalysis.brand_facts;
        }
        if (!task.input_business_type?.trim() && targetPageAnalysis.detected_business_type) {
          task.input_business_type = targetPageAnalysis.detected_business_type;
          updates.input_business_type = targetPageAnalysis.detected_business_type;
        }
        if (!task.input_business_goal?.trim() && targetPageAnalysis.detected_business_goal) {
          task.input_business_goal = targetPageAnalysis.detected_business_goal;
          updates.input_business_goal = targetPageAnalysis.detected_business_goal;
        }
        if (!task.input_site_type?.trim() && targetPageAnalysis.detected_site_type) {
          task.input_site_type = targetPageAnalysis.detected_site_type;
          updates.input_site_type = targetPageAnalysis.detected_site_type;
        }

        // Save enriched fields to DB
        const updateKeys = Object.keys(updates);
        if (updateKeys.length > 0) {
          const setClauses = updateKeys.map((k, i) => `${k} = $${i + 2}`).join(', ');
          const setValues  = updateKeys.map(k => updates[k]);
          await db.query(
            `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
            [taskId, ...setValues]
          );
          log(`Target Page Analysis: обогащены поля задачи: ${updateKeys.join(', ')}`, 'success');
        }

        publish(taskId, { type: 'target_page_analyzed', analysis: targetPageAnalysis });
      }
    } catch (e) {
      log(`Target Page Analysis ошибка: ${e.message} — продолжаем без анализа`, 'warn');
    }
  }

  // ── Audience & Niche Deep Analysis (всегда, независимо от URL) ────
  // Углубляет TA и нишу: персоны, JTBD, боли, возражения, тон голоса,
  // терминология ниши. Прокидывается в Stage 2/3 как
  // {{AUDIENCE_PERSONAS}}, {{NICHE_DEEP_DIVE}}, {{CONTENT_VOICE}}, {{NICHE_TERMINOLOGY}}.
  let audienceNicheAnalysis = null;
  if (resumeFrom?.audienceNicheAnalysis !== undefined) {
    audienceNicheAnalysis = resumeFrom.audienceNicheAnalysis;
    log('Audience & Niche Analysis: восстановлен из checkpoint', 'info');
  } else {
    try {
      progress(2, 'audience_niche_analysis');
      audienceNicheAnalysis = await analyzeAudienceAndNiche(task, stageCtx, { targetPageAnalysis });
    } catch (e) {
      log(`Audience & Niche Analysis ошибка: ${e.message} — продолжаем с дефолтными данными`, 'warn');
    }
  }

  // Сериализуем результаты в текстовые блоки и кладём на task для всех stage-функций.
  const {
    personasText, nicheDeepDiveText, contentVoiceText, nicheTerminologyText,
  } = serializeAnalysisForPrompt(audienceNicheAnalysis);
  task.__audiencePersonasText  = personasText;
  task.__nicheDeepDiveText     = nicheDeepDiveText;
  task.__contentVoiceText      = contentVoiceText;
  task.__nicheTerminologyText  = nicheTerminologyText;

  if (audienceNicheAnalysis) {
    publish(taskId, { type: 'audience_niche_analyzed', analysis: audienceNicheAnalysis });
  }

  // ── Pre-Stage 0: Стратегический разведочный слой ──────────────────
  // Niche Landscape + Market Opportunity + Search Demand Mapper.
  // Запускается один раз на задачу, через DeepSeek, параллельно.
  // Результат (STRATEGY_CONTEXT) сохраняется в task.strategy_context
  // и пробрасывается в Stage 0 через task.__strategyContext.
  let strategyContext = null;
  if (resumeFrom?.strategyContext !== undefined) {
    strategyContext = resumeFrom.strategyContext;
    log('Pre-Stage 0: восстановлен из checkpoint', 'info');
  } else {
    try {
      strategyContext = await runPreStage0(task, stageCtx, {
        targetPageAnalysis,
        audienceNicheAnalysis,
      });
    } catch (e) {
      log(`Pre-Stage 0 ошибка: ${e.message} — продолжаем без стратегического контекста`, 'warn');
    }
  }
  // Прокидываем в task для всех последующих стадий (transient — не сохраняется в DB напрямую).
  task.__strategyContext = strategyContext;
  task.__strategyDigest  = buildStrategyDigest(strategyContext);

  if (strategyContext) {
    publish(taskId, {
      type:    'strategy_context_ready',
      summary: {
        has_niche_map:             !!strategyContext.niche_map,
        has_opportunity_portfolio: !!strategyContext.opportunity_portfolio,
        has_demand_map:            !!strategyContext.demand_map,
        errors:                    strategyContext.errors || [],
      },
    });
  }

  // ── Stage 0 ──────────────────────────────────────────────────────
  let stage0Result = null;
  if (resumeFrom?.stage0Result !== undefined) {
    stage0Result = resumeFrom.stage0Result;
    log('Stage 0: восстановлен из checkpoint', 'info');
  } else {
    try {
      stage0Result = await runStage0(task, stageCtx);
    } catch (e) {
      log(`Stage 0 упал: ${e.message} — продолжаем без Stage 0 данных`, 'warn');
    }
  }

  // ── Stage 1 ──────────────────────────────────────────────────────
  let stage1Result;
  if (resumeFrom?.stage1Result) {
    stage1Result = resumeFrom.stage1Result;
    log('Stage 1: восстановлен из checkpoint', 'info');
  } else {
    try {
      stage1Result = await runStage1(task, stageCtx, stage0Result);
    } catch (e) {
      throw new Error(`Stage 1 критическая ошибка: ${e.message}`);
    }
  }

  // ── Stage 2 ──────────────────────────────────────────────────────
  // §4-GIST: информационная дельта Stage 0 (GIST M3 Gap Finder) уходит
  // в брифы Stage 2 (2A/2B/2C) через task.__informationDelta (fail-open).
  task.__informationDelta = Array.isArray(stage0Result?.information_delta)
    ? stage0Result.information_delta
    : [];
  let taxonomy, stage2Raw, enrichedStage1;
  if (resumeFrom?.taxonomy) {
    taxonomy       = resumeFrom.taxonomy;
    stage2Raw      = resumeFrom.stage2Raw      || null;
    enrichedStage1 = resumeFrom.enrichedStage1 || null;
    log(`Stage 2: восстановлен из checkpoint (${taxonomy.length} блоков)`, 'info');
  } else {
    try {
      ({ taxonomy, stage2Raw, enrichedStage1 } = await runStage2(
        task, stageCtx, stage1Result
      ));
    } catch (e) {
      throw new Error(`Stage 2 критическая ошибка: ${e.message}`);
    }
  }

  publish(taskId, { type: 'taxonomy', taxonomy });

  // ── Используем enrichedStage1 (stage1 + buyer journey) для Stage 3
  stage1Result = enrichedStage1 || stage1Result;

  // ── Module Context (Module 1+2) — детерминированный derive ─────────
  // Pure-функция поверх stage0/stage1/stage2 — БЕЗ LLM-вызовов.
  // Содержит mandatory_entities + avoid_ambiguous_terms +
  // audience_language_clusters + format_wedge + trust_complexity +
  // claims_to_prove + jtbd_to_close. Сохраняется в tasks.module_context
  // (миграция 014) и уезжает в AKB как §11 hard analytical constraints.
  // См.: backend/src/utils/moduleContext.js
  //
  // Если у задачи привязан исходный отчёт релевантности (миграция 022,
  // tasks.source_relevance_report_id), мы дополнительно вливаем
  // mandatory_entities из entity_coverage и сводку competitor_signals
  // из ТОП-10 — по вердикту: «Вливаем mandatory_entities и competitor_signals
  // из отчета напрямую в __moduleContext при генерации».
  let relevanceReport = null;
  if (task.source_relevance_report_id) {
    try {
      const { rows: rRows } = await db.query(
        `SELECT report, our_report, comparison
           FROM relevance_reports
          WHERE id = $1 AND user_id = $2 AND status = 'done'`,
        [task.source_relevance_report_id, task.user_id]
      );
      if (rRows.length) {
        relevanceReport = rRows[0].report || {};
        // Прокидываем comparison.entity_coverage в верхний уровень,
        // чтобы deriveMandatoryEntities нашёл его одной точкой.
        if (rRows[0].comparison && rRows[0].comparison.entity_coverage) {
          relevanceReport.entity_coverage = relevanceReport.entity_coverage
            || rRows[0].comparison.entity_coverage;
        }
        log(
          `Relevance report подключён (id=${task.source_relevance_report_id.slice(0, 8)}…): ` +
          `entities=${(relevanceReport.entity_coverage?.mandatory_entities?.length) || 0}, ` +
          `competitor_signals=${relevanceReport.competitor_signals ? 'да' : 'нет'}`,
          'info'
        );
      } else {
        log(`Relevance report ${task.source_relevance_report_id.slice(0,8)}… не найден или не done — пропускаем`, 'warn');
      }
    } catch (relErr) {
      log(`Relevance report: ошибка загрузки (${relErr.message}) — продолжаем без него`, 'warn');
    }
  }

  try {
    task.__moduleContext = deriveModuleContext({
      task,
      stage0Result,
      stage1Result,
      stage2Result: { taxonomy, stage2Raw, enrichedStage1 },
      targetPageAnalysis,
      strategyContext,
      relevanceReport,
    });
    const s = task.__moduleContext._summary || {};
    log(
      `Module Context собран: entities=${s.mandatory_entities_n}, ` +
      `avoid=${s.avoid_ambiguous_terms_n}, lang=${s.audience_language_clusters_n}, ` +
      `claims=${s.claims_to_prove_n}, jtbd=${s.jtbd_to_close_n}, ` +
      `trust=${s.trust_level}, format=${s.primary_format || '—'}`,
      'success'
    );
    try {
      await db.query(
        `UPDATE tasks SET module_context = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(task.__moduleContext), taskId]
      );
    } catch (dbErr) {
      log(`Module Context: не удалось сохранить в БД (${dbErr.message}) — продолжаем`, 'warn');
    }
  } catch (mcErr) {
    log(`Module Context: ошибка derive — ${mcErr.message}. Продолжаем без него.`, 'warn');
    task.__moduleContext = null;
  }

  // ── ARTICLE_KNOWLEDGE_BASE (AKB) ─────────────────────────────────
  // Один детерминированный документ, который собирает всё «сырое знание»
  // (Pre-Stage 0 + Stage 0 + Stage 1 + target page + audience-niche).
  // Уйдёт в Gemini как нативный systemInstruction (опционально через
  // cachedContents API) для Stage 3 / 5 / 6.
  // См.: backend/src/utils/articleKnowledgeBase.js
  // ── Подгружаем projectContextBlock из task.project_context_snapshot ─
  // Если задача привязана к проекту (ТЗ §5/§8) — сериализованный contextResolver
  // лежит в JSONB-колонке project_context_snapshot (создан в createTask /
  // resume пайплайна). Рендерим его в текстовый блок и пробрасываем в AKB
  // отдельной секцией «КОНТЕКСТ ПРОЕКТА», чтобы LLM на всех стадиях знала
  // бренд/нишу/регион/факты/конкурентов/коммерческий интент проекта.
  let projectContextBlock = '';
  let projectContextData = null;
  try {
    const snap = task.project_context_snapshot || null;
    if (snap && typeof snap === 'object') {
      projectContextData = snap;
      const { buildProjectContextBlock } = require('../projects/projectContextBlock');
      projectContextBlock = buildProjectContextBlock(snap, { maxBlockChars: 6000 });
    } else if (task.project_id && task.user_id) {
      // Снапшота нет (старая задача / повторный запуск) — фолбэк к
      // contextResolver на лету. Не падаем, если проект уже удалён.
      const { buildProjectContext } = require('../projects/contextResolver');
      const ctx = await buildProjectContext(task.project_id, task.user_id);
      if (ctx) {
        projectContextData = ctx;
        const { buildProjectContextBlock } = require('../projects/projectContextBlock');
        projectContextBlock = buildProjectContextBlock(ctx, { maxBlockChars: 6000 });
      }
    }
  } catch (ctxErr) {
    log(`ARTICLE_KNOWLEDGE_BASE: контекст проекта пропущен — ${ctxErr.message}`, 'warn');
  }

  // ── BRANDCORE/TGA governance — единый слой для всех SEO writer stages ──
  // Правила не заменяют факты задачи: они запрещают выдуманные claims,
  // удерживают границу интента и фиксируют E-E-A-T/manual-review состояние.
  let governanceReport = null;
  let governanceBlock = '';
  try {
    const {
      buildGovernanceReport,
      renderGovernanceBlock,
    } = require('../contentGovernance');
    const governanceSemanticContext = {
      entities: stage1Result?.entities || stage1Result?.knowledge_graph?.nodes || [],
      intents: stage1Result?.subintents || stage1Result?.intents || [],
      questions: stage1Result?.user_questions || stage1Result?.questions || [],
      lsi: stage2Raw?.lsi?.important || stage2Raw?.important_lsi || stage2Raw?.lsi_set || [],
    };
    governanceReport = buildGovernanceReport({
      contentType: 'seo',
      task,
      projectContext: projectContextData || null,
      semanticContext: governanceSemanticContext,
    });
    governanceBlock = renderGovernanceBlock({
      report: governanceReport,
      contentType: 'seo',
      task,
      projectContext: projectContextData || null,
      semanticContext: governanceSemanticContext,
    });
    task.__governanceReport = governanceReport;
    task.__governanceBlock = governanceBlock;
    log(`BRANDCORE/TGA: ${governanceReport.status}; facts=${governanceReport.confirmed_facts}, claims=${governanceReport.confirmed_claims}`, governanceReport.blockers.length ? 'warn' : 'info');
  } catch (governanceErr) {
    log(`BRANDCORE/TGA: governance layer skipped (${governanceErr.message})`, 'warn');
  }

  // Единый E-E-A-T 12 / evidence-first contract для классической SEO-ветки.
  // Строится детерминированно из уже полученных Stage 0–2 артефактов — без
  // дополнительного LLM-вызова и без раздувания времени генерации.
  try {
    task.__eeatContract = buildEeatContract({
      branch: 'seo',
      task,
      targetPageAnalysis,
      strategy: strategyContext,
      stage0Result,
      stage1Result,
      stage2Result: { taxonomy, stage2Raw, enrichedStage1 },
      audience: audienceNicheAnalysis,
      intents: stage1Result,
      whitespace: stage0Result,
      outline: taxonomy,
      lsi: stage2Raw,
      realtimeResearch: stage0Result,
      relevanceContext: relevanceReport,
      governanceReport,
      moduleContext: task.__moduleContext,
      author: {
        name: task.input_author_name,
        role: task.input_author_role,
        reviewer: task.input_reviewer_name,
      },
      targetScore: EEAT_PQ_TARGET,
    });
    log(
      `E-E-A-T contract: ${task.__eeatContract.evidence.length} evidence, ` +
      `${task.__eeatContract.entities.length} entities, ${task.__eeatContract.semantic.lsi_required.length} LSI, ` +
      `risk=${task.__eeatContract.risk_level}, target=${task.__eeatContract.target_score}`,
      'info',
    );
  } catch (contractErr) {
    task.__eeatContract = null;
    log(`E-E-A-T contract: сборка пропущена (${contractErr.message})`, 'warn');
  }

  // DSPy optimizes only the compact writer instructions and degrades safely.
  if (task.__eeatContract) {
    try {
      const { buildPromptSuffix } = require('../projects/dspyClient');
      const dspySuffix = await buildPromptSuffix('Eeat12ContractAndWriterBrief', {
        branch: 'seo',
        risk_level: task.__eeatContract.risk_level,
        target_score: task.__eeatContract.target_score,
        metrics: task.__eeatContract.obligations.slice(0, 10),
        evidence_types: task.__eeatContract.evidence.map((item) => item.evidence_type).slice(0, 12),
        entity_count: task.__eeatContract.entities.length,
        lsi_count: task.__eeatContract.semantic.lsi_required.length,
      });
      if (dspySuffix) {
        task.__eeatDspySuffix = dspySuffix.slice(0, 8000);
        task.__eeatContract.writer_brief += `\\n\\n${task.__eeatDspySuffix}`;
        task.__eeatContract.markdown += `\\n\\n${task.__eeatDspySuffix}`;
      }
    } catch (dspyErr) {
      log(`DSPy E-E-A-T enhancement пропущен: ${dspyErr.message}`, 'info');
    }
  }

  try {
    task.__articleKnowledgeBase = buildArticleKnowledgeBase({
      task,
      targetPageAnalysis,
      strategyContext,
      stage0Result,
      stage1Result,
      knowledgeGraph: stage1Result?.knowledge_graph || null,
      moduleContext:  task.__moduleContext || null,
      projectContextBlock,
      governanceBlock,
      eeatContract: task.__eeatContract,
    });
    const akbBytes  = Buffer.byteLength(task.__articleKnowledgeBase, 'utf8');
    const akbTokens = estimateTokens(task.__articleKnowledgeBase);
    log(
      `ARTICLE_KNOWLEDGE_BASE собран: ${akbBytes} байт (~${akbTokens} токенов). ` +
      `Будет передаваться как Gemini systemInstruction для Stage 3/5/6.`,
      'info'
    );
  } catch (akbErr) {
    log(`ARTICLE_KNOWLEDGE_BASE: ошибка сборки — ${akbErr.message}. Продолжаем без AKB.`, 'warn');
    task.__articleKnowledgeBase = '';
  }

  // ── Опционально: Gemini Context Caching API ─────────────────────
  // Включается флагом GEMINI_CONTEXT_CACHE_ENABLED=true. Даёт ~75 % скидку
  // на cached input tokens, но требует, чтобы AKB был ≥ ~4 КБ.
  // На cache miss — graceful fallback в callLLM (см. opts.cachedContent).
  task.__geminiCacheName = null;
  // Skip Gemini cachedContents API for non-Gemini providers (Grok не имеет
  // серверного context-cache; LLM_RESPONSE_CACHE_ENABLED Redis-кэш покрывает
  // Grok отдельно через callLLM).
  const _provider = (task?.llm_provider || 'gemini').toString().toLowerCase();
  if (
    _provider === 'gemini' &&
    process.env.GEMINI_CONTEXT_CACHE_ENABLED === 'true' &&
    task.__articleKnowledgeBase &&
    Buffer.byteLength(task.__articleKnowledgeBase, 'utf8') >= 4096
  ) {
    try {
      const ttl = parseInt(process.env.GEMINI_CONTEXT_CACHE_TTL_SEC, 10) || 900;
      const cache = await createCachedContent({
        systemInstruction: task.__articleKnowledgeBase,
        ttlSeconds:        ttl,
        model:             normalizeGeminiCopywritingModel(task.gemini_model),
      });
      task.__geminiCacheName = cache.name;
      log(`Gemini cachedContent создан: ${cache.name} (TTL ${cache.ttlSeconds}s).`, 'success');
    } catch (cacheErr) {
      log(`Gemini cachedContent не создан — ${cacheErr.message}. Идём без кэша.`, 'warn');
      task.__geminiCacheName = null;
    }
  }

  // ── Per-task token budget (Gemini/Grok input tokens) ──────────────
  // Защита от runaway-стоимости. Дефолт конечный и общий с info/link.
  task.__tokenBudget = getConfiguredTaskTokenBudget();
  resetTaskBudget(taskId);
  if (Number.isFinite(task.__tokenBudget)) {
    log(`Gemini/Grok token budget на задачу: ${task.__tokenBudget} input-токенов.`, 'info');
  } else {
    log('Gemini/Grok token budget отключён явным значением GEMINI_TASK_TOKEN_BUDGET=0.', 'warn');
  }

  // ── Stage 3–6: Pipeline Interleaving ──────────────────────────────
  // Вместо: Stage 3 (все блоки) → Stage 4-6 (все блоки последовательно)
  // Теперь: генерация блока N и аудит блока N-1 запускаются параллельно
  // Stage 3 использует Gemini, Stage 4 использует DeepSeek — разные API, не конкурируют
  log('Stage 3–6: Генерация и аудит блоков (pipeline interleaving)...', 'info');

  // Собираем competitor_facts из Stage 0 для factCheck
  const competitorFacts = stage0Result?.competitor_facts || [];

  const finalBlocks = [];       // финальные HTML-блоки
  const allLSISet   = new Set();  // дедупликация LSI

  // Подготовка контекста генерации (shared между блоками)
  const targetService = task.input_target_service;
  const region        = task.input_region        || 'Россия';
  const brandFacts    = task.input_brand_facts   || 'Нет данных';
  const nGrams        = task.input_ngrams        || '';
  const tfIdfData     = task.input_tfidf_json || '[]';
  const authorName    = task.input_author_name   || 'Эксперт';
  const minChars      = parseInt(task.input_min_chars) || 800;
  const maxChars      = parseInt(task.input_max_chars) || 3500;
  const totalTarget   = Math.floor((minChars + maxChars) / 2);

  // Stage 3 runs once per H2. Keep the complete verified knowledge in AKB,
  // but pass a bounded deterministic navigation index instead of repeating
  // the huge raw Stage 1/2 payload on every Gemini call.
  const writerContext = buildWriterContext(stage1Result, stage2Raw || {}, taxonomy);
  const s3stage1Json = writerContext.stage1Json;
  const s3stage2Json = writerContext.stage2Json;
  log(
    `Writer context index: Stage1 ${s3stage1Json.length} + Stage2 ${s3stage2Json.length} ` +
    `символов; полный контекст сохранён в ARTICLE_KNOWLEDGE_BASE.`,
    'info'
  );

  const stage0Signals = stage0Result ? JSON.stringify({
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

  // Target page analysis data for Stage 3 prompt placeholders
  const serviceNotes = targetPageAnalysis?.service_details || 'Нет';
  const offerDetails = targetPageAnalysis?.brand_facts     || 'Нет';
  const proofAssets  = targetPageAnalysis?.proof_assets     || 'Нет';

  const blockWeights = taxonomy.map(b => BLOCK_TYPE_WEIGHTS[b.type] || 1.0);
  const weightSum    = blockWeights.reduce((s, w) => s + w, 0);

  const structureLimits = getStructureLimits(maxChars);

  // Knowledge Graph для контекста каждого блока
  const knowledgeGraph = stage1Result?.knowledge_graph || null;

  // Restore state from checkpoint if resuming
  let expertOpinionUsed = resumeFrom?.expertOpinionUsed || false;
  let previousContext   = resumeFrom?.previousContext   || '';
  const generatedH2s    = resumeFrom?.generatedH2s      || [];
  // How many blocks were already done before this resume
  const resumeFromBlock = resumeFrom?.resumeFromBlock   ?? 0;

  /**
   * auditAndRefineBlock — запускает Stage 4→5→6 для одного блока.
   * Вынесен в отдельную функцию для pipeline interleaving.
   *
   * @param {object} [blockCharLimits] { minChars, maxChars } — per-block лимиты для контроля длины
   *   в Stage 5/6 (±20% от ТЗ). Если не передано — длина не валидируется.
   */
  async function auditAndRefineBlock(i, blockHtml, block, blockExpertOpinionUsed, blockCharLimits = null) {
    const lsiMust = block.lsi_must || [];
    lsiMust.forEach(term => allLSISet.add(term));

    if (!blockHtml) {
      log(`Блок ${i + 1}: пропуск (Stage 3 не вернул HTML)`, 'warn');
      await markBlockError(taskId, i, block, 'Stage 3 failed to generate HTML');
      return null;
    }

    // Pause check перед стартом аудита: если пользователь нажал «Стоп»,
    // не запускаем дорогой Stage 4-5-6 для нового блока.
    if (await checkPauseRequested(taskId)) {
      log(`Блок ${i + 1}: запрос на паузу — пропускаем audit, HTML уже сохранён в drafts`, 'warn');
      return blockHtml;
    }

    publish(taskId, { type: 'block_start', blockIndex: i, h2: block.h2, status: 'auditing' });

    // Stage 4: E-E-A-T аудит
    let auditResult, pqScore, lsiCovPct;
    try {
      ({ auditResult, pqScore, lsiCovPct } = await runStage4(
        task, stageCtx,
        i, blockHtml, lsiMust
      ));
    } catch (e) {
      const fallbackCoverage = calculateCoverage(blockHtml, lsiMust);
      auditResult = {
        audit_status: 'unavailable',
        audit_error: /JSON parse|Unexpected end/i.test(String(e?.message || '')) ? 'json_parse' : 'audit_error',
        mathematical_audit: {
          chars_count_actual: blockHtml.length,
          lsi_coverage_percent: fallbackCoverage.percent,
          lsi_found: fallbackCoverage.found || [],
          lsi_missing: fallbackCoverage.missing || [],
          spam_risk_detected: false,
        },
        pq_score: null,
        actionable_next_steps: [{
          problem: 'Технический аудит не вернул разборный JSON',
          solution: 'Выполнить один компактный повторный audit или передать блок на проверку',
        }],
      };
      pqScore = null;
      lsiCovPct = fallbackCoverage.percent;
      log(`Stage 4 блок ${i + 1}: audit_unavailable (${e.message}) — передаём лучший HTML в контролируемый refine`, 'warn');
    }

    const needsRefinement = lsiCovPct < LSI_COVERAGE_TARGET || pqScore < EEAT_PQ_TARGET || auditResult?.mathematical_audit?.spam_risk_detected;

    // Объективные JS-метрики структуры HTML (не зависят от LLM-оценки).
    // Передаём blockCharLimits с допуском ±20% — длина становится триггером рефайна.
    const charLimitsForCheck = blockCharLimits
      ? {
          minChars: Math.round(blockCharLimits.minChars * 0.8),
          maxChars: Math.round(blockCharLimits.maxChars * 1.2),
        }
      : null;
    const objMetrics = checkObjectiveMetrics(blockHtml, { structureLimits, charLimits: charLimitsForCheck });
    const needsObjFix = !objMetrics.passed;
    if (needsObjFix && !needsRefinement) {
      log(`Блок ${i + 1}: объективные метрики НЕ пройдены (${objMetrics.issues.join('; ')}) — запускаем рефайн`, 'warn');
    }
    if (needsObjFix) {
      log(`Блок ${i + 1} метрики: H3=${objMetrics.metrics.h3_count}, списки=${objMetrics.metrics.has_list}, ` +
          `абзацев=${objMetrics.metrics.paragraph_count}, длинных=${objMetrics.metrics.long_paragraphs}, ` +
          `ссылки=${objMetrics.metrics.has_links}`, 'info');
    }

    let currentHTML  = blockHtml;
    let currentPQ    = pqScore;
    let currentAudit = auditResult;

    // Stage 5: PQ-рефайн (если нужен по LLM-аудиту ИЛИ по объективным метрикам)
    if (needsRefinement || needsObjFix) {
      // Pause check: пользователь мог нажать «Стоп» во время длинного Stage 4 →
      // не лезем в Stage 5 (до 3 итераций × 30+ секунд каждая).
      if (await checkPauseRequested(taskId)) {
        log(`Блок ${i + 1}: запрос на паузу — пропускаем Stage 5/6, отдаём HTML после Stage 4`, 'warn');
        await saveContentBlock(taskId, i, block, currentHTML, currentPQ, lsiCovPct, currentAudit);
        return currentHTML;
      }
      publish(taskId, { type: 'block_start', blockIndex: i, h2: block.h2, status: 'fixing' });
      try {
        const s5 = await runStage5(
          task, stageCtx,
          i, currentHTML, lsiMust,
          currentAudit, currentPQ,
          competitorFacts, block.h2,
          blockExpertOpinionUsed,
          blockCharLimits
        );
        currentHTML  = s5.html;
        currentPQ    = s5.pqScore;
        currentAudit = s5.auditLog;
        if (s5.budgetSkipped) {
          publish(taskId, { type: 'budget_skip', stage: 'stage5', blockIndex: i, h2: block.h2 });
        }
      } catch (e) {
        log(`Stage 5 блок ${i + 1} ОШИБКА: ${e.message} — используем HTML после Stage 4`, 'warn');
      }
    } else {
      log(`Блок ${i + 1}: PQ ${pqScore} ≥ ${EEAT_PQ_TARGET}, LSI ${Math.round(lsiCovPct)}% ≥ ${LSI_COVERAGE_TARGET}% — рефайн не нужен`, 'success');
    }

    // Stage 6: LSI-инъекция (всегда, если покрытие < LSI_COVERAGE_TARGET)
    let lsiCoverageAfter = lsiCovPct;
    // Pause check перед Stage 6: ещё одна точка остановки.
    if (await checkPauseRequested(taskId)) {
      log(`Блок ${i + 1}: запрос на паузу — пропускаем Stage 6, сохраняем после Stage 5`, 'warn');
      await saveContentBlock(taskId, i, block, currentHTML, currentPQ, lsiCovPct, currentAudit);
      return currentHTML;
    }
    try {
      const s6 = await runStage6(
        task, stageCtx,
        i, currentHTML, lsiMust,
        blockCharLimits
      );
      currentHTML     = s6.html;
      lsiCoverageAfter = s6.lsiCoverage;
      if (s6.budgetSkipped) {
        publish(taskId, { type: 'budget_skip', stage: 'stage6', blockIndex: i, h2: block.h2 });
      }
    } catch (e) {
      log(`Stage 6 блок ${i + 1} ОШИБКА: ${e.message} — используем HTML после Stage 5`, 'warn');
      const cov = calculateCoverage(currentHTML, lsiMust);
      lsiCoverageAfter = cov.percent;
    }

    // Проверяем оставшиеся water-фразы
    const finalWater = checkAntiWater(currentHTML);
    if (finalWater.length) {
      log(`Блок ${i + 1}: Остались вода-фразы: ${finalWater.join(', ')}`, 'warn');
    }

    log(`Блок ${i + 1} готов. LSI: ${lsiCoverageAfter}%, PQ: ${currentPQ == null ? 'не рассчитан' : currentPQ}`, 'success');

    // Сохраняем финальный блок в БД
    await saveContentBlock(taskId, i, block, currentHTML, currentPQ, lsiCoverageAfter, currentAudit);

    publish(taskId, {
      type:          'block_done',
      blockIndex:    i,
      h2:            block.h2,
      lsiCoverage:   lsiCoverageAfter,
      pqScore:       currentPQ,
    });

    return currentHTML;
  }

  // ── Pipeline: генерация последовательно, аудиты параллельно ──────
  // Стратегия: блоки генерируются последовательно (каждому нужен previousContext),
  // но аудит каждого блока запускается СРАЗУ после его генерации и работает
  // параллельно с генерацией следующих блоков и аудитами предыдущих.
  // Stage 3 (Gemini) и Stage 4-6 (DeepSeek) — разные API, не конкурируют.
  const auditPromises = []; // промисы аудита всех блоков
  // Stage 3 остаётся последовательным, но дорогой Stage 4–6 audit/refine
  // ограничен двумя блоками на task. Это предотвращает пиковое reservation
  // Gemini budget при interleaving и сохраняет параллелизм между DeepSeek-аудитами.
  const auditQueue = [];
  let activeAudits = 0;
  const pumpAuditQueue = () => {
    while (activeAudits < 2 && auditQueue.length) {
      const { run, resolve, reject } = auditQueue.shift();
      activeAudits += 1;
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          activeAudits -= 1;
          pumpAuditQueue();
        });
    }
  };
  const scheduleAudit = (run) => new Promise((resolve, reject) => {
    auditQueue.push({ run, resolve, reject });
    pumpAuditQueue();
  });

  // Базовый checkpoint (обновляется перед каждым блоком)
  const buildCheckpoint = (blockIndex) => ({
    stage0Result,
    stage1Result,
    stage2Raw,
    taxonomy,
    enrichedStage1,
    audienceNicheAnalysis,
    strategyContext,
    expertOpinionUsed,
    previousContext,
    generatedH2s: [...generatedH2s],
    resumeFromBlock: blockIndex,
  });

  // Сохраняем checkpoint сразу после Stage 2: даже если генерация упадёт на
  // самом первом блоке, дорогие Stage 0/1/2 (конкурентный анализ, таксономия,
  // LSI-роутинг) не потеряются и авто-возобновление стартует с блока resumeFromBlock,
  // а не с нуля.
  await savePipelineCheckpoint(taskId, buildCheckpoint(resumeFromBlock));

  for (let i = 0; i < taxonomy.length; i++) {
    const block = taxonomy[i];

    // ── Resume: если этот блок уже готов — загружаем из БД и пропускаем ──
    if (i < resumeFromBlock) {
      const doneBlock = await loadDoneBlock(taskId, i);
      if (doneBlock) {
        log(`Блок ${i + 1}: восстановлен из БД (уже готов)`, 'info');
        auditPromises.push(Promise.resolve(doneBlock.html_content));
        // LSI учёт для Stage 7
        (block.lsi_must || []).forEach(term => allLSISet.add(term));
      } else {
        log(`Блок ${i + 1}: не найден в БД — будет перегенерирован`, 'warn');
        // Fall through to generate (don't skip)
      }
      if (doneBlock) continue;
    }

    // ── Pause check: перед каждым блоком проверяем запрос на паузу ──
    if (await checkPauseRequested(taskId)) {
      const checkpoint = buildCheckpoint(i);
      await savePipelineCheckpoint(taskId, checkpoint);
      throw new PipelinePausedError(checkpoint);
    }

    // ── Checkpoint перед генерацией блока ──
    // Фиксируем прогресс ДО тяжёлой генерации/аудита блока i. Если пайплайн
    // упадёт с ошибкой на этом блоке, авто-возобновление в воркере продолжит
    // ровно с блока i (блоки 0..i-1 подтянутся из БД), а не с самого начала —
    // пользователю не нужно перенастраивать и перезапускать задачу вручную.
    // Math.max — не даём индексу возобновления откатиться назад, если блок
    // ниже resumeFromBlock отсутствовал в БД и перегенерируется.
    await savePipelineCheckpoint(taskId, buildCheckpoint(Math.max(i, resumeFromBlock)));

    const blockTargetChars = Math.round(totalTarget * (blockWeights[i] / weightSum)) || 1500;
    const blockMinChars    = Math.round(minChars    * (blockWeights[i] / weightSum)) || 600;
    const blockMaxChars    = Math.round(maxChars    * (blockWeights[i] / weightSum)) || 2500;

    // Knowledge Graph: извлекаем сущности, релевантные текущему блоку
    const blockEntities = knowledgeGraph
      ? getRelatedEntities(knowledgeGraph, block.h2, block.lsi_must || [], 8)
      : [];
    const blockEntitiesStr = blockEntities.length > 0
      ? blockEntities.map(e => `${e.label} [${e.type}]`).join(', ')
      : '';

    // Capture expert opinion state BEFORE this block is generated
    const blockExpertOpinionUsed = expertOpinionUsed;

    // Генерация текущего блока (Gemini) — await, т.к. нужен previousContext для следующего
    const genResult = await generateSingleBlock(task, stageCtx, block, i, taxonomy.length, {
      targetService, region, brandFacts, nGrams, tfIdfData, authorName,
      s3stage1Json, s3stage2Json, stage0Signals, competitorsData, competitorFactsStr,
      blockTargetChars, blockMinChars, blockMaxChars, stage0Result,
      expertOpinionUsed, previousContext, previousH2s: generatedH2s.join(' | '),
      serviceNotes, offerDetails, proofAssets,
      blockEntitiesStr, structureLimits,
    });

    // Обновляем контекст для генерации следующего блока
    if (genResult.html) {
      expertOpinionUsed = genResult.expertOpinionUsed;
      previousContext   = genResult.previousContext;
      generatedH2s.push(block.h2);
    }

    // Запускаем аудит сразу (Stage 4→5→6, DeepSeek) — НЕ ждём предыдущие аудиты
    // blockExpertOpinionUsed передаётся в Stage 5 чтобы не добавлять лишний blockquote
    // blockCharLimits — per-block min/max ТЗ для контроля длины в Stage 5/6 (±20%)
    const blockCharLimits = { minChars: blockMinChars, maxChars: blockMaxChars };
    auditPromises.push(
      genResult.html
        ? scheduleAudit(() => auditAndRefineBlock(i, genResult.html, block, blockExpertOpinionUsed, blockCharLimits))
        : Promise.resolve(null)
    );

    // Прогресс: Stage 3-6 занимают ~35-88% в пайплайне
    const pct = 35 + Math.round(((i + 1) / taxonomy.length) * 53);
    progress(pct, 'stage3-6');
  }

  // Ожидаем завершение всех аудитов (результаты в порядке блоков)
  const auditResults = await Promise.all(auditPromises);

  // Late pause check: если пользователь нажал «Стоп» уже после того, как все
  // блоки ушли в for-loop, мы пропустим Stage 7+ и зафиксируем прогресс.
  if (await checkPauseRequested(taskId)) {
    const checkpoint = buildCheckpoint(taxonomy.length);
    await savePipelineCheckpoint(taskId, checkpoint);
    throw new PipelinePausedError(checkpoint);
  }

  for (const html of auditResults) {
    if (html) finalBlocks.push(html);
  }

  if (!finalBlocks.length) {
    throw new Error('Пайплайн: ни один блок не был сгенерирован');
  }

  // ── Post-processing: enforce single expert blockquote across all blocks ──
  // Safety net for the race condition: audits run in parallel,
  // so multiple blocks may get blockquotes via Stage 5.
  // Keep only the FIRST block's blockquote, strip from the rest.
  let expertBlockFound = false;
  for (let i = 0; i < finalBlocks.length; i++) {
    if (/<blockquote[\s>]/i.test(finalBlocks[i])) {
      if (expertBlockFound) {
        log(`Post-processing: блок ${i + 1} содержит лишний blockquote — удаляем (экспертное мнение уже в предыдущем блоке)`, 'warn');
        finalBlocks[i] = stripExpertBlockquotes(finalBlocks[i]);
      } else {
        expertBlockFound = true;
      }
    }
  }

  // ── Post-processing: strip [NO_DATA] markers from all blocks ──
  // Safety net: even though prompts now instruct LLM to avoid [NO_DATA],
  // older prompts or edge cases might still produce them.
  for (let i = 0; i < finalBlocks.length; i++) {
    if (/\[NO[_\s]?DATA\]/i.test(finalBlocks[i])) {
      log(`Post-processing: блок ${i + 1} содержит [NO_DATA] — удаляем маркеры`, 'warn');
      finalBlocks[i] = stripNoDataMarkers(finalBlocks[i]);
    }
  }

  // ── Stage 7: Глобальный аудит ────────────────────────────────────
  const allLSI = Array.from(allLSISet);

  let s7Result;
  try {
    s7Result = await runStage7(
      task, stageCtx,
      finalBlocks, allLSI
    );
  } catch (e) {
    log(`Stage 7 ОШИБКА: ${e.message} — пайплайн завершён без глобального аудита`, 'warn');
    s7Result = { finalHTML: finalBlocks.join('\n\n') };
  }

  // ── E-E-A-T 12: deterministic final contract audit ───────────────
  // LLM Stage 7 остаётся диагностическим судьёй, а этот слой проверяет
  // доказательства, entities, LSI, table/comparison, authorship и risk rules
  // программно. Он не делает новый LLM-вызов и поэтому не раздувает runtime.
  let eeat12Audit = null;
  try {
    if (task.__eeatContract) {
      eeat12Audit = validateEeatContract(
        s7Result.finalHTML || finalBlocks.join('\\n\\n'),
        task.__eeatContract,
      );
      task.__eeatContractAudit = eeat12Audit;
      s7Result.eeat12Audit = eeat12Audit;
      log(
        `E-E-A-T 12: ${eeat12Audit.overall_score}/10 (target ${eeat12Audit.target_score}), ` +
        `verdict=${eeat12Audit.verdict}, blockers=${eeat12Audit.blockers.length}, ` +
        `LSI=${eeat12Audit.checks.lsi.present}/${eeat12Audit.checks.lsi.total}`,
        eeat12Audit.publish_ready ? 'success' : 'warn',
      );
      publish(taskId, { type: 'eeat12_audit', audit: eeat12Audit });
    }
  } catch (eeatErr) {
    log(`E-E-A-T 12 audit пропущен: ${eeatErr.message}`, 'warn');
  }

  // ── Post-Stage 7: «Ограничения проекта → не использовано» ──────────
  // Строим отчёт о входных данных, не вошедших в финальный HTML.
  // Чистый JS, без LLM-вызовов: переиспользуем calculateCoverage (стемминг)
  // + проверки фраз. Сохраняем в tasks.unused_inputs (миграция 006) и шлём SSE.
  let unusedInputsReport = null;
  try {
    unusedInputsReport = buildUnusedInputsReport({
      task,
      fullHTML:           s7Result.finalHTML || finalBlocks.join('\n\n'),
      stage0Result,
      strategyContext,
      targetPageAnalysis,
      tfIdfDensity:       s7Result.tfIdfDensity || [],
    });

    try {
      await db.query(
        `UPDATE tasks SET unused_inputs = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(unusedInputsReport), taskId]
      );
    } catch (dbErr) {
      log(`Unused inputs: не удалось сохранить отчёт в БД (${dbErr.message})`, 'warn');
    }

    publish(taskId, { type: 'unused_inputs_report', report: unusedInputsReport });

    log(
      `Ограничения проекта → не использовано: всего ${unusedInputsReport.summary.total_unused_items} элементов ` +
      `(LSI: ${unusedInputsReport.summary.categories.lsi}, ` +
      `n-грамм: ${unusedInputsReport.summary.categories.ngrams}, ` +
      `фактов бренда: ${unusedInputsReport.summary.categories.brand_facts}, ` +
      `фактов конкурентов: ${unusedInputsReport.summary.categories.competitor_facts}, ` +
      `FAQ: ${unusedInputsReport.summary.categories.faq_questions})`,
      'info'
    );
  } catch (e) {
    log(`Unused inputs report ошибка: ${e.message} — пропускаем`, 'warn');
  }

  // ── LinguaForensic v3.6 (детекция AI-текста + fluency-рерайт) ──────
  // Дополнительный слой поверх финального HTML — НЕ заменяет каркас.
  // Skill: skills/AI-detect-v-3-6.md (тот же, что в gist_py M8). Graceful:
  // при ошибке/отключении текст не меняется. Если рерайт принят — Stage 8
  // и Quality gate работают уже с улучшенной версией.
  let linguaForensicReport = null;
  try {
    const { runLinguaForensicPass } = require('../linguaForensic');
    const lfResult = await runLinguaForensicPass(
      s7Result.finalHTML || finalBlocks.join('\n\n'),
      { pipeline: 'seo', taskId, log, onTokens, tokenBudget: task.__tokenBudget },
    );
    linguaForensicReport = lfResult.report;
    if (lfResult.report?.verdict === 'rewritten') {
      s7Result.finalHTML = lfResult.html;
      log(
        `LinguaForensic: рерайт принят — роботность ${lfResult.report.robotness_before}% → ` +
        `${lfResult.report.robotness_after}%`,
        'success',
      );
    }
    publish(taskId, { type: 'linguaforensic_report', report: linguaForensicReport });
  } catch (e) {
    log(`LinguaForensic: непойманное исключение — ${e.message} — пропускаем`, 'warn');
  }

  // ── Stage 7.5: SEO мета-теги (GIST Meta Filter через metaFacade) ──
  // Раньше основной SEO-пайплайн не генерировал мета-теги вообще: самый
  // сильный движок проекта работал только в инструменте мета-тегов. Теперь
  // после LinguaForensic (summary строится по ФИНАЛЬНОМУ тексту) и до quality
  // gate вызывается единый фасад. Полностью graceful: ошибка меты не роняет
  // задачу. Kill-switch: META_FACADE_ENABLED=false.
  let seoMetaResult = null;
  try {
    const { generateMetaForContent } = require('../metaTags/metaFacade');
    const finalHTMLForMeta = s7Result.finalHTML || finalBlocks.join('\n\n');
    const metaKeyword = [
      task.input_target_service || '',
      task.input_region || '',
    ].filter((x) => String(x).trim()).join(' ').trim();

    seoMetaResult = await generateMetaForContent({
      keyword: metaKeyword || task.input_target_service || '',
      pipeline: 'seo',
      html: finalHTMLForMeta,
      plain: finalHTMLForMeta.replace(/<[^>]+>/g, ' '),
      context: {
        brand:    task.input_brand_name || '',
        niche:    task.input_target_service || '',
        toponym:  task.input_region || '',
        brandFacts: task.input_brand_facts || '',
        pageAngle: buildSeoPageAngle(task, strategyContext, targetPageAnalysis),
        missingNodes: buildSeoMissingNodes(stage0Result, unusedInputsReport),
        // Ту же эвристику цены переиспользуем из генератора мета-тегов.
        price_data: extractMetaPriceData({
          summary: [targetPageAnalysis?.brand_facts, task.input_brand_facts]
            .filter(Boolean).join(' | '),
        }),
        // Разовый анализ ЦА/ниши уже посчитан в Stage 3 — НЕ запускаем заново.
        audienceNicheDigest: [
          task.__contentVoiceText || '',
          (task.__nicheDeepDiveText || '').slice(0, 600),
          (task.__audiencePersonasText || '').slice(0, 500),
        ].filter(Boolean).join('\n\n').slice(0, 1500),
        governanceBlock,
        gemini_model: task.gemini_model || '',
        standalone_exposure: false,
      },
      ctx: { taskId, log, onTokens },
    });

    await db.query(
      `UPDATE tasks
          SET seo_title = $1, seo_description = $2, seo_meta = $3, updated_at = NOW()
        WHERE id = $4`,
      [
        seoMetaResult.title || null,
        seoMetaResult.description || null,
        JSON.stringify(seoMetaResult),
        taskId,
      ],
    );
    publish(taskId, { type: 'meta_tags_ready', meta: seoMetaResult });
    log(
      `Stage 7.5: мета-теги готовы (${seoMetaResult.source}, Title ${String(seoMetaResult.title || '').length} симв., `
      + `Desc ${String(seoMetaResult.description || '').length} симв.`
      + `${seoMetaResult.ctr_score ? `, CTR-скор ${seoMetaResult.ctr_score.score}/100` : ''})`,
      'info',
    );
  } catch (metaErr) {
    log(`Stage 7.5: мета-теги не сгенерированы (${metaErr.message}) — продолжаем`, 'warn');
  }

  // ── Stage 8 (опц.): Quality Evaluator ─────────────────────────────
  // Default OFF. Включается ENV STAGE8_EVALUATOR_ENABLED=true. Не блокирует
  // и не перегенерирует контент; пишет evaluator_report в БД и SSE.
  // См.: backend/src/services/pipeline/stage8.js
  let evaluatorReport = null;
  if (isStage8Enabled()) {
    try {
      evaluatorReport = await runStage8Evaluator(
        task, stageCtx,
        {
          finalHTML:     s7Result.finalHTML || finalBlocks.join('\n\n'),
          moduleContext: task.__moduleContext || null,
          artifacts: {
            stage7_result:     s7Result.globalAudit || s7Result,
            gist_score:        stage0Result?.gist_score ?? null,
            globalLSICoverage: s7Result.globalLSICoverage,
            eeat_score:        s7Result.globalEEATScore,
            tz_compliance:     s7Result.tzCompliance || s7Result.globalAudit?.tz_compliance || null,
          },
        }
      );
      if (evaluatorReport) {
        publish(taskId, { type: 'evaluator_report', report: evaluatorReport });
      }
    } catch (e) {
      log(`Stage 8 Evaluator: непойманное исключение — ${e.message}`, 'warn');
    }
  }

  // ── Unified Quality Core (Content Gen v2, Фаза 3) ──────────────────
  // Единый gate поверх финального HTML SEO-пайплайна. Risk берём из Stage 8
  // evaluator_report (regulatory_risks), если он посчитан. Value-adds для
  // 'seo' обязательны ТОЛЬКО при наличии information_gain_brief — сейчас
  // пайплайн его не формирует, поэтому checker пропускается (без ложных
  // блокировок). Пишем журнал (quality_gate_reports) + компактный вердикт
  // в tasks.quality_gate. Полностью graceful, НЕ роняет пайплайн.
  let qualityGateVerdict = null;
  try {
    const { qualityGate } = require('../qualityCore');
    const gateResult = await qualityGate.runForTask({
      pipeline: 'seo',
      taskId,
      raw: {
        html: s7Result.finalHTML || finalBlocks.join('\n\n'),
        niche: task.input_target_service || task.input_target_url || '',
        currentYear: new Date().getFullYear(),
        evaluatorReport: evaluatorReport || null,
        governanceReport: governanceReport || null,
        eeat12Audit: eeat12Audit || null,
        tzCompliance: s7Result.tzCompliance || s7Result.globalAudit?.tz_compliance || null,
        informationDelta: Array.isArray(stage0Result?.information_delta)
          ? stage0Result.information_delta
          : null,
        authorship: {
          byline: task.input_author_name || 'Редакция',
          reviewer: null,
          sources: [],
        },
      },
    });
    const eeat12Ready = !eeat12Audit || eeat12Audit.publish_ready === true;
    const eeat12Blockers = eeat12Audit && !eeat12Ready
      ? (eeat12Audit.blockers.length
        ? eeat12Audit.blockers
        : [`E-E-A-T 12 score ${eeat12Audit.overall_score} < ${eeat12Audit.target_score}`])
      : [];
    qualityGateVerdict = {
      canPublish: gateResult.canPublish && eeat12Ready,
      ymyl:       gateResult.ymyl,
      blockers:   [
        ...gateResult.blockers.map((b) => ({ name: b.name, verdict: b.verdict })),
        ...eeat12Blockers.map((item) => ({ name: 'eeat12_contract', verdict: String(item) })),
      ],
      warnings:   gateResult.warnings.map((w) => ({ name: w.name, verdict: w.verdict })),
      summary:    eeat12Ready ? gateResult.summary : `${gateResult.summary}; E-E-A-T 12 requires refine/manual review`,
      governance: governanceReport || null,
      eeat12:     eeat12Audit || null,
      lingua_forensic: linguaForensicReport
        ? {
            verdict:          linguaForensicReport.verdict,
            robotness_before: linguaForensicReport.robotness_before ?? null,
            robotness_after:  linguaForensicReport.robotness_after ?? null,
            passes:           linguaForensicReport.passes ?? 0,
          }
        : null,
      checked_at: new Date().toISOString(),
    };
    // §3.2 ТЗ GIST: фиксируем gist_score в tasks (fail-open)
    try {
      const gistGate = (gateResult.gates || []).find((g) => g.name === 'gistScore');
      if (gistGate && gistGate.score != null) {
        await db.query(
          'UPDATE tasks SET gist_score = $1 WHERE id = $2',
          [gistGate.score, taskId],
        );
      }
    } catch (gsErr) {
      log(`Quality gate: не удалось сохранить gist_score (${gsErr.message})`, 'warn');
    }
    try {
      await db.query(
        `UPDATE tasks SET quality_gate = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(qualityGateVerdict), taskId],
      );
    } catch (dbErr) {
      log(`Quality gate: не удалось сохранить вердикт в БД (${dbErr.message})`, 'warn');
    }
    log(
      `${qualityGateVerdict.canPublish ? '✅' : '🚦'} Quality gate: ${qualityGateVerdict.summary}`,
      qualityGateVerdict.canPublish ? 'info' : 'warn',
    );
  } catch (gateErr) {
    log(`Quality gate: непойманное исключение — ${gateErr.message}`, 'warn');
  }

  // Aegis publication instrumentation: classic SEO path тоже входит в
  // publication→SERP→reward loop, но запись разрешена только при реальном
  // canonical URL/query set и пройденном quality gate.
  try {
    if (qualityGateVerdict?.canPublish && task.published_url && Array.isArray(task.published_queries)
        && task.published_queries.length > 0) {
      const { recordTaskPublication } = require('../aegis/serpOutcomeTracker');
      const finalHtmlForOutcome = s7Result.finalHTML || finalBlocks.join('\n\n');
      const lsiCoverage = Number(s7Result.globalLSICoverage);
      const outcome = await recordTaskPublication({
        taskId,
        kind: 'seo',
        publishedUrl: String(task.published_url).trim(),
        queries: task.published_queries,
        html: finalHtmlForOutcome,
        projectId: task.project_id || null,
        opportunityId: task.opportunity_id || null,
        promptVersion: task.prompt_version || 'seo:stage3:v1',
        modelVersion: task.gemini_model || null,
        baselineMetrics: task.baseline_metrics || {},
        qualitySignals: {
          lsi_coverage: Number.isFinite(lsiCoverage)
            ? (lsiCoverage > 1 ? lsiCoverage / 100 : lsiCoverage)
            : null,
          intent_ok: Boolean(stage0Result?.intent_ok ?? true),
          eeat_citations: Number.isFinite(Number(s7Result.globalEEATScore))
            ? Number(s7Result.globalEEATScore) / 100
            : null,
        },
      });
      if (outcome.ok) log(`Aegis: SEO publication outcome queued (${outcome.id})`, 'info');
    }
  } catch (aegisErr) {
    log(`Aegis publication instrumentation skipped: ${aegisErr.message}`, 'warn');
  }

  // Время генерации контента (в секундах)
  const generationTimeSec = Math.round((Date.now() - pipelineStartedAt) / 1000);

  // Публикуем итоговое событие
  publish(taskId, {
    type:               'pipeline_done',
    taskId,
    blocksGenerated:    finalBlocks.length,
    globalLSICoverage:  s7Result.globalLSICoverage   || 0,
    globalEEATScore:    s7Result.globalEEATScore      ?? null,
    bm25:               s7Result.bm25                 || {},
    finalHTMLLength:    (s7Result.finalHTML || '').length,
    eeatBreakdown:      s7Result.eeatBreakdown        || null,
    eeat12Audit:        eeat12Audit                    || null,
    tfIdfDensity:       s7Result.tfIdfDensity          || [],
    unusedInputs:       unusedInputsReport             || null,
    evaluatorReport:    evaluatorReport                || null,
    linguaForensic:     linguaForensicReport           || null,
    qualityGate:        qualityGateVerdict             || null,
    seoMeta:            seoMetaResult                  || null,
    tzCompliance:       s7Result.tzCompliance || s7Result.globalAudit?.tz_compliance || null,
    generationTimeSec,
  });

  log(
    `Пайплайн завершён. Блоков: ${finalBlocks.length} | ` +
    `LSI: ${s7Result.globalLSICoverage || 0}% | ` +
    `E-E-A-T: ${s7Result.globalEEATScore ?? 'не рассчитан'} | ` +
    `BM25: ${s7Result.bm25?.score?.toFixed(2) || '—'} | ` +
    `Время: ${Math.floor(generationTimeSec / 60)}м ${generationTimeSec % 60}с`,
    'success'
  );

  // ── Cleanup: удаляем Gemini cachedContent (если был создан) ─────
  // Не блокируем return: на ошибку только лог. На error-путях кэш
  // протухает по TTL (по умолчанию 15 мин).
  if (task.__geminiCacheName) {
    deleteCachedContent(task.__geminiCacheName)
      .then(ok => {
        if (ok) log(`Gemini cachedContent удалён: ${task.__geminiCacheName}`, 'info');
        else    log(`Gemini cachedContent НЕ удалён (истечёт по TTL): ${task.__geminiCacheName}`, 'warn');
      })
      .catch(() => {});
  }

  return s7Result;
}

/**
 * Page angle страницы для GIST Meta Filter (§2 ТЗ мета-тегов): позиционирование,
 * бизнес-цель и УТП собираются детерминированно из стратегического контекста
 * (pre-Stage 0) и анализа целевой страницы — без дополнительных LLM-вызовов.
 */
function buildSeoPageAngle(task, strategyContext, targetPageAnalysis) {
  const parts = [`Страница по услуге «${task.input_target_service || ''}»`];
  if (task.input_region) parts.push(`регион: ${task.input_region}`);
  const goal = task.input_business_goal
    || (strategyContext && (strategyContext.business_goal || strategyContext.positioning));
  if (goal) parts.push(`бизнес-цель: ${goal}`);
  const positioning = (strategyContext && strategyContext.positioning_statement)
    || (targetPageAnalysis && targetPageAnalysis.detected_business_goal);
  if (positioning) parts.push(`позиционирование: ${positioning}`);
  const usp = (targetPageAnalysis && targetPageAnalysis.brand_facts) || task.input_brand_facts;
  if (usp) parts.push(`УТП: ${usp}`);
  return parts.join(' | ').replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Missing semantic nodes страницы: пробелы конкурентов (Stage 0) + входные
 * данные, не вошедшие в текст (unused inputs) — часто именно они и есть
 * уникальные факты, которыми стоит отстроить сниппет от ТОПа.
 */
function buildSeoMissingNodes(stage0Result, unusedInputsReport) {
  const nodes = [];
  const gaps = (stage0Result && stage0Result.competitor_gaps) || [];
  gaps.slice(0, 3).forEach((g) => {
    const text = typeof g === 'string' ? g : (g && (g.gap || g.topic || g.title));
    if (text) nodes.push(`Пробел конкурентов: ${text}`);
  });
  const whiteSpaces = (stage0Result && stage0Result.white_spaces) || [];
  whiteSpaces.slice(0, 2).forEach((w) => {
    if (w) nodes.push(`White space ниши: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  });
  const delta = (stage0Result && stage0Result.information_delta) || [];
  delta.slice(0, 2).forEach((d) => {
    const text = typeof d === 'string' ? d : (d && (d.claim || d.thesis || d.text));
    if (text) nodes.push(`Информационная дельта: ${text}`);
  });
  const unusedBrandFacts = unusedInputsReport?.categories?.brand_facts?.items_unused || [];
  unusedBrandFacts.slice(0, 2).forEach((f) => {
    const text = typeof f === 'string' ? f : (f && (f.item || f.text));
    if (text) nodes.push(`Неиспользованный факт бренда: ${text}`);
  });
  return nodes
    .map((n) => String(n).replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 8);
}

module.exports = { runPipeline, PipelinePausedError, buildSeoPageAngle, buildSeoMissingNodes };
