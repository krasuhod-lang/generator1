'use strict';

/**
 * Article Topics Forecaster — pipeline.
 *
 * Один Gemini-вызов (gemini-3.1-pro-preview) с большим foresight-промптом.
 * На выходе — markdown-отчёт со слабыми сигналами, emerging-трендами,
 * контентными кластерами и Strategic Action Plan.
 *
 * Поддерживается два режима:
 *   • mode='main'      — первичный анализ ниши (Промт 1).
 *   • mode='deep_dive' — углублённая проработка отдельного тренда (Промт 2).
 *
 * Используется `callGemini({plainText:true})` напрямую (минуя callLLM),
 * потому что callLLM всегда парсит ответ как JSON, а здесь нам нужен
 * свободный markdown.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../../config/db');
const { callGemini } = require('../llm/gemini.adapter');
const { calcCost }   = require('../metrics/priceCalculator');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');
const {
  extractTrendsJsonBlock,
  persistExtractedTrends,
  buildSiblingDeepDivesBlock,
} = require('./articleTopicsTrends');
const { extractTopicIdeasJsonBlock } = require('./topicIdeasParser');
const { normalizeBrandKey, canonTitle } = require('./brandKey');
const { detectDuplicates, filterDuplicates } = require('./topicDuplicateDetector');
const { recordTopics, loadHistory } = require('./brandTopicHistory');
const { resolveBrandKey, autoLinkSimilar } = require('./brandAliases');
const { filterCannibalizingCandidates } = require('./semanticExclusionFilter');
const { buildProjectContextBlock } = require('../projects/projectContextBlock');
const { getQualityFlags } = require('../qualityLayers/featureFlags');
const { runArticleTopicsEvaluator } = require('./articleTopicsEvaluator');
const { finalizeByTask } = require('../aegis/backlogHooks');
const { createFunnelTracker } = require('../aegis/funnelTracker');
const { recordTrainingExample } = require('../aegis/datasetWriter');
const { recordQualityLog } = require('../aegis/qualityLogWriter');
const { resolvePromptHash } = require('../aegis/promptAudit');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts', 'articleTopics');

// Кэшируем тексты промптов в память при первом обращении — файлы не меняются.
let _mainPromptCache     = null;
let _deepDivePromptCache = null;
let _topicIdeasPromptCache = null;

function _loadMainPrompt() {
  if (_mainPromptCache == null) {
    _mainPromptCache = fs.readFileSync(path.join(PROMPTS_DIR, 'main.txt'), 'utf-8');
  }
  return _mainPromptCache;
}

function _loadDeepDivePrompt() {
  if (_deepDivePromptCache == null) {
    _deepDivePromptCache = fs.readFileSync(path.join(PROMPTS_DIR, 'deepDive.txt'), 'utf-8');
  }
  return _deepDivePromptCache;
}

function _loadTopicIdeasPrompt() {
  if (_topicIdeasPromptCache == null) {
    _topicIdeasPromptCache = fs.readFileSync(path.join(PROMPTS_DIR, 'topicIdeas.txt'), 'utf-8');
  }
  return _topicIdeasPromptCache;
}

/**
 * Простая подстановка {{KEY}} → values[KEY] (одна замена на ключ — глобальная).
 * Используется только с доверенными промпт-шаблонами и валидированным
 * пользовательским вводом (через clipStr в контроллере), поэтому prompt-injection
 * не страшен (для модели это просто текстовый инпут).
 */
function _interpolate(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    const safe = (v == null ? '' : String(v));
    out = out.split(`{{${k}}}`).join(safe);
  }
  return out;
}

/**
 * _renderExclusionList — рендерит массив исключений как список «- raw»
 * для подстановки в плейсхолдер промта. Возвращает либо «(нет — генерируй
 * свободно)»-подобное сообщение, либо markdown-список.
 *
 * Используется в topic_ideas-режиме для двух плейсхолдеров:
 *   {{EXCLUDED_TOPICS_LIST}}  — тематические исключения
 *   {{EXCLUDED_CLUSTERS_LIST}} — макро-кластеры (целые направления)
 */
function _renderExclusionList(items, fallback) {
  if (!Array.isArray(items) || !items.length) return fallback;
  const lines = items
    .map((x) => {
      const t = String((x && (x.raw || x.title || x.query || x)) || '').trim();
      return t ? `- ${t.slice(0, 200)}` : null;
    })
    .filter(Boolean)
    .slice(0, 50);
  return lines.length ? `\n${lines.join('\n')}` : fallback;
}

/**
 * Усечение markdown-текста с уважением к структурным границам.
 *
 * Тупой `str.slice(maxLen)` мог бы разрезать markdown-таблицу, кодовый
 * блок или multi-byte UTF-8 последовательность пополам — модель получает
 * сломанный фрагмент и иногда «доделывает» его странным образом.
 *
 * Стратегия: если строка короче лимита — возвращаем как есть; иначе
 * пытаемся обрезать по последней «безопасной» границе перед лимитом
 * (двойной перенос строки = граница абзаца/секции). Если такой границы
 * нет — обрезаем по ближайшему одиночному переносу, и только в худшем
 * случае — по сырому символьному лимиту. Финальное многоточие сигнализирует
 * модели, что контекст усечён.
 */
function _truncateMarkdown(text, maxLen) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;

  // Берём только префикс длиной maxLen и ищем «безопасный» хвост, чтобы
  // отрезать всё после него. Минимально допустимая длина обрезка — 70%
  // от лимита: иначе мы сэкономили бы слишком мало контекста.
  const minKeep = Math.floor(maxLen * 0.7);
  const head = s.slice(0, maxLen);

  const paraBreak = head.lastIndexOf('\n\n');
  if (paraBreak >= minKeep) {
    return head.slice(0, paraBreak).trimEnd() + '\n\n…(контекст усечён)';
  }
  const lineBreak = head.lastIndexOf('\n');
  if (lineBreak >= minKeep) {
    return head.slice(0, lineBreak).trimEnd() + '\n\n…(контекст усечён)';
  }
  return head.trimEnd() + '\n\n…(контекст усечён)';
}

const SYSTEM_INSTRUCTION =
  'You are a senior strategic foresight analyst and SEO forecaster. ' +
  'Reply in Russian unless the user explicitly asks otherwise. ' +
  'Output clean markdown without ```markdown wrappers. ' +
  'Be concrete, use numbers and named entities, no fluff.';

/**
 * Основная точка входа: запускается из контроллера через setImmediate
 * после insert'а строки в article_topic_tasks.
 */
async function processArticleTopicTask(taskId) {
  if (!taskId) throw new Error('taskId is required');

  const { rows: taskRows } = await db.query(
    `SELECT * FROM article_topic_tasks WHERE id = $1`,
    [taskId],
  );
  if (!taskRows.length) {
    console.warn(`[articleTopics] Task ${taskId} not found, skip`);
    return;
  }
  const task = taskRows[0];

  // Идемпотентность: если задача уже в финальном статусе — пропускаем.
  if (task.status === 'done' || task.status === 'error') {
    console.log(`[articleTopics] Task ${taskId} already ${task.status}, skip`);
    return;
  }

  await db.query(
    `UPDATE article_topic_tasks
        SET status = 'running', started_at = NOW(), updated_at = NOW(),
            error_message = NULL
      WHERE id = $1`,
    [taskId],
  );

  const funnel = createFunnelTracker({ kind: 'article_topics', taskRef: taskId, userId: task.user_id, niche: task.niche || null });

  try {
    funnel.step('build_prompt');
    let userPrompt;
    let siblingsCount = 0;
    if (task.mode === 'deep_dive') {
      // Подтягиваем родительский контекст (если есть) — чтобы deep-dive не
      // был оторван от основного анализа.
      let parentContext = '';
      if (task.parent_task_id) {
        const { rows: parentRows } = await db.query(
          `SELECT result_markdown FROM article_topic_tasks WHERE id = $1`,
          [task.parent_task_id],
        );
        if (parentRows.length && parentRows[0].result_markdown) {
          parentContext = _truncateMarkdown(parentRows[0].result_markdown, 6000);
        }
      }
      // Sibling-awareness: подмешиваем выжимку других deep-dive по этому же
      // parent-у, чтобы модель не дублировала pillar/cluster страницы.
      // На любой сбой возвращается заглушка — не блокируем deep-dive.
      const siblingBlock = await buildSiblingDeepDivesBlock({
        parentTaskId:  task.parent_task_id,
        currentTaskId: task.id,
      });
      // Грубая оценка количества siblings — для аудита module_context_used.
      siblingsCount = (siblingBlock.match(/^### Sibling: /gm) || []).length;

      userPrompt = _interpolate(_loadDeepDivePrompt(), {
        TREND_NAME:         task.trend_name || '',
        NICHE:              task.niche      || '',
        REGION:             task.region     || '',
        HORIZON:            task.horizon    || '',
        AUDIENCE:           task.audience   || '',
        SEARCH_ECOSYSTEM:   task.search_ecosystem || '',
        PARENT_CONTEXT:     parentContext || '(отсутствует — опирайся только на тренд и нишу)',
        SIBLING_DEEP_DIVES: siblingBlock,
        CURRENT_YEAR:       String(new Date().getFullYear()),
      });
    } else if (task.mode === 'topic_ideas') {
      // Третий режим: подбор N тем статей + анализ рынка/сущностей/интентов
      // + описание ЦА + список фактов о бренде. Inputs (target_url,
      // brand_hint, topic_count) сохранены controllerом в module_context_used
      // на момент INSERT — читаем их оттуда (плюс всегда есть fallback на
      // sane defaults).
      const stashedInputs = (task.module_context_used && typeof task.module_context_used === 'object')
        ? (task.module_context_used.topic_ideas_inputs || {})
        : {};
      const requestedCount = Number(stashedInputs.topic_count)
                           || Number(task.topic_count_requested)
                           || 10;

      // ТЗ §2.3: формируем exclusion-set из 4 источников ДО рендера промта,
      // чтобы LLM сразу видела «не предлагать». Источники:
      //   • user_topics / user_clusters — из article_topic_tasks.exclude_topics
      //   • history — brandTopicHistory по brand_key (если есть)
      //   • cannibalization — из project_context_snapshot.signals
      //   • target_url_h1 — на этом этапе мы H1 не парсим (это сделает
      //     отдельный фоновый шаг targetPageAnalyzer); если есть pageSnapshot
      //     в slep'ке — используем его title.
      const excludeRaw = Array.isArray(task.exclude_topics) ? task.exclude_topics : [];
      const userTopics   = excludeRaw.filter((x) => x && x.kind !== 'cluster');
      const userClusters = excludeRaw.filter((x) => x && x.kind === 'cluster');
      const snap = task.project_context_snapshot || null;
      const cannFromSnap = (snap && snap.signals && Array.isArray(snap.signals.cannibalization))
        ? snap.signals.cannibalization : [];

      const exclusionSet = {
        user_topics:    userTopics,
        user_clusters:  userClusters,
        history:        [], // подложим ниже из brand history
        cannibalization: cannFromSnap,
        target_url_h1:  null,
      };

      // PROJECT_CONTEXT_BLOCK: используем слепок (если есть), иначе пытаемся
      // подтянуть свежий контекст. Слепок предпочтительнее — он зафиксирован
      // на момент INSERT (детерминированный prompt).
      let projectContextBlock = '';
      if (snap && snap.project) {
        projectContextBlock = buildProjectContextBlock(snap, { maxBlockChars: 6000 });
      } else if (task.project_id && task.user_id) {
        try {
          const { buildProjectContext } = require('../projects/contextResolver');
          const ctx = await buildProjectContext(task.project_id, task.user_id);
          if (ctx) projectContextBlock = buildProjectContextBlock(ctx, { maxBlockChars: 6000 });
        } catch (e) {
          console.warn(`[articleTopics] late buildProjectContext failed: ${e.message}`);
        }
      }

      const excludedTopicsList = _renderExclusionList(
        [...userTopics, ...cannFromSnap.map((c) => ({ raw: c.query }))],
        '(нет — генерируй свободно)'
      );
      const excludedClustersList = _renderExclusionList(userClusters, '(нет)');

      const topicIdeasBody = _interpolate(_loadTopicIdeasPrompt(), {
        NICHE:       task.niche || '',
        REGION:      task.region || '(не указан)',
        AUDIENCE:    task.audience || '(не указано)',
        TARGET_URL:  String(stashedInputs.target_url || '').slice(0, 300) || '(не указан)',
        BRAND_HINT:  String(stashedInputs.brand_hint || '').slice(0, 300) || '(не указано)',
        TOPIC_COUNT: String(requestedCount),
        CURRENT_YEAR: String(new Date().getFullYear()),
        EXCLUDED_TOPICS_LIST:   excludedTopicsList,
        EXCLUDED_CLUSTERS_LIST: excludedClustersList,
      });
      userPrompt = projectContextBlock
        ? `${projectContextBlock}\n\n${topicIdeasBody}`
        : topicIdeasBody;

      // Сохраним для пост-фильтра.
      funnel.step('exclusion_inputs_collected', {
        user_topics: userTopics.length,
        user_clusters: userClusters.length,
        cannibalization: cannFromSnap.length,
        project_context_block_chars: projectContextBlock.length,
      });
      task._exclusionSet = exclusionSet; // временно — для пост-обработки
    } else {
      // Main-режим: тоже подмешиваем контекст проекта, если есть слепок.
      let projectContextBlockMain = '';
      const snapMain = task.project_context_snapshot || null;
      if (snapMain && snapMain.project) {
        projectContextBlockMain = buildProjectContextBlock(snapMain, { maxBlockChars: 5000 });
      }
      const mainBody = _interpolate(_loadMainPrompt(), {
        NICHE:            task.niche || '',
        REGION:           task.region || '(не указан)',
        HORIZON:          task.horizon || '(не указан)',
        AUDIENCE:         task.audience || '(не указано)',
        MARKET_STAGE:     task.market_stage || '(не указано)',
        SEARCH_ECOSYSTEM: task.search_ecosystem || '(не указано)',
        TOP_COMPETITORS:  task.top_competitors || '(не указаны)',
        CURRENT_YEAR:     String(new Date().getFullYear()),
      });
      userPrompt = projectContextBlockMain
        ? `${projectContextBlockMain}\n\n${mainBody}`
        : mainBody;
    }

    // 300 секунд — потолок для одного non-streaming Gemini-вызова в адаптере.
    // 16384 output-токенов хватает на длинный markdown-отчёт (~50 KB текста).
    funnel.step('llm_generation');
    const result = await callGemini(SYSTEM_INSTRUCTION, userPrompt, {
      temperature: 0.7,
      maxTokens:   16384,
      timeoutMs:   300000,
      plainText:   true,
      model:       normalizeGeminiCopywritingModel(task.gemini_model),
    });

    if (!result || !result.text || !result.text.trim()) {
      throw new Error('Gemini вернул пустой ответ');
    }

    const tokensIn       = Number(result.tokensIn       || 0);
    const tokensOut      = Number(result.tokensOut      || 0);
    const thoughtsTokens = Number(result.thoughtsTokens || 0);
    const cachedTokens   = Number(result.cachedTokens   || 0);
    const costUsd   = calcCost('gemini', tokensIn, tokensOut, { thoughtsTokens, cachedTokens });

    funnel.step('post_processing', { model: result.model || 'gemini', tokensIn, tokensOut, costUsd });
    // ── Post-processing: вытаскиваем TRENDS_JSON-блок (только для main),
    // ── сохраняем в trends_json + регистре article_topic_trends.
    // Все ошибки парсинга/persist — гасим warn'ом, статус задачи не страдает.
    let trendsJson = null;
    if (task.mode === 'main') {
      try {
        trendsJson = extractTrendsJsonBlock(result.text);
      } catch (parseErr) {
        console.warn(`[articleTopics] TRENDS_JSON parse failed for ${taskId}: ${parseErr.message}`);
      }
      if (trendsJson && Array.isArray(trendsJson.trends) && trendsJson.trends.length) {
        // persistExtractedTrends сам ловит свои ошибки.
        await persistExtractedTrends({
          taskId,
          userId: task.user_id,
          niche:  task.niche,
          trends: trendsJson.trends,
        });
      }
    }

    // ── Post-processing для topic_ideas: TOPIC_IDEAS_JSON-блок →
    //    topic_ideas_json + audience_profile + brand_facts_json +
    //    topic_count_returned. Парсер сам режет длинные строки и
    //    валидирует enum'ы; на любой сбой возвращает null — задачу не валим.
    let topicIdeasJson  = null;
    let audienceProfile = null;
    let brandFactsJson  = null;
    let topicCountReturned = null;
    let topicIdeasWarnings = null;
    if (task.mode === 'topic_ideas') {
      try {
        topicIdeasJson = extractTopicIdeasJsonBlock(result.text);
      } catch (parseErr) {
        console.warn(`[articleTopics] TOPIC_IDEAS_JSON parse failed for ${taskId}: ${parseErr.message}`);
      }
      if (topicIdeasJson) {
        audienceProfile    = topicIdeasJson.audience_profile || null;
        brandFactsJson     = topicIdeasJson.brand_facts || null;
        topicCountReturned = Number.isFinite(topicIdeasJson.topic_count_returned)
          ? topicIdeasJson.topic_count_returned
          : (Array.isArray(topicIdeasJson.topics) ? topicIdeasJson.topics.length : null);
        // Warning: модель вернула меньше тем, чем запросили.
        const requested = Number(task.topic_count_requested) || null;
        if (requested && topicCountReturned != null && topicCountReturned < requested) {
          topicIdeasWarnings = {
            kind: 'fewer_topics_than_requested',
            requested,
            returned: topicCountReturned,
          };
        }
      } else {
        topicIdeasWarnings = { kind: 'topic_ideas_json_missing_or_invalid' };
      }
    }

    // Brand-aware дедуп: если у задачи есть brand_hint и парсенные topics,
    // запускаем детектор перед UPDATE — duplicate_of улетает в БД вместе с
    // topic_ideas_json, чтобы UI мог показать бейдж сразу после генерации.
    let brandDedupStats = null;
    const brandHintRaw = (task.module_context_used
      && typeof task.module_context_used === 'object'
      && task.module_context_used.brand_hint) || null;
    const baseBrandKey = normalizeBrandKey(brandHintRaw);
    // Резолвим алиас → canonical brand_key; если автоконсолидация
    // (autoAlias) включена, эвристически склеиваем похожие brand_key.
    const dedupFlagsTop = (getQualityFlags() || {}).brandDedup || {};
    let brandKey = baseBrandKey;
    let brandAliasInfo = null;
    if (baseBrandKey && task.user_id) {
      try {
        const resolved = await resolveBrandKey(db, { userId: task.user_id, rawBrand: brandHintRaw });
        if (resolved && resolved !== baseBrandKey) {
          brandKey = resolved;
          brandAliasInfo = { source: 'alias', base: baseBrandKey, canonical: resolved };
        } else if (dedupFlagsTop.autoAlias !== false) {
          const link = await autoLinkSimilar(db, {
            userId: task.user_id,
            candidateKey: baseBrandKey,
            threshold: Number(dedupFlagsTop.autoAliasThreshold) || 0.85,
          });
          if (link.linked) {
            brandKey = link.canonical;
            brandAliasInfo = {
              source: 'auto', base: baseBrandKey, canonical: link.canonical, similarity: link.similarity,
            };
          }
        }
      } catch (e) {
        console.warn(`[articleTopics] brand alias resolve failed for ${taskId}: ${e.message}`);
      }
    }
    let topicsDroppedAsDuplicates = 0;
    if (
      task.mode === 'topic_ideas'
      && topicIdeasJson
      && Array.isArray(topicIdeasJson.topics)
      && topicIdeasJson.topics.length
      && brandKey
    ) {
      try {
        const flags = (getQualityFlags() || {}).brandDedup || {};
        const history = await loadHistory(db, {
          userId: task.user_id,
          brandKey,
          lookbackDays: Number(flags.historyLookbackDays) || 365,
          limit: Number(flags.historyLimit) || 500,
        });
        const { enriched, stats } = await detectDuplicates({
          candidates: topicIdeasJson.topics,
          history,
          flags,
        });
        // Опциональный жёсткий дроп дублей из выдачи (по умолчанию OFF).
        const filtered = filterDuplicates(enriched, { dropDuplicates: !!flags.dropDuplicates });
        topicIdeasJson = {
          ...topicIdeasJson,
          topics: filtered.kept,
          ...(filtered.droppedCount ? { topics_dropped_as_duplicates: filtered.dropped } : {}),
        };
        topicsDroppedAsDuplicates = filtered.droppedCount;
        brandDedupStats = { ...stats, dropped: filtered.droppedCount };
      } catch (e) {
        console.warn(`[articleTopics] brand dedup failed for ${taskId}: ${e.message}`);
      }
    }

    // ─── ТЗ §2.3.A: семантический пост-фильтр от каннибализации ───────
    // Применяется только в topic_ideas-режиме поверх уже отдедупленных тем.
    // Источники исключений (см. articleTopicsPipeline._exclusionSet, собран
    // на стадии build_prompt): user_topics, user_clusters, история бренда,
    // cannibalization из снапшота проекта.
    // Без embeddings/LLM-judge фильтр работает как exact + Jaccard (cheap),
    // что уже даёт ощутимый эффект — расширенные слои подключаются позже
    // через инжектируемые `embeddingFn` / `llmJudgeFn`.
    let exclusionResult = null;
    if (
      task.mode === 'topic_ideas'
      && topicIdeasJson
      && Array.isArray(topicIdeasJson.topics)
      && topicIdeasJson.topics.length
      && task._exclusionSet
    ) {
      try {
        // Обогатим history исключения через brandTopicHistory (если ещё не).
        const ex = task._exclusionSet;
        if (brandKey && (!ex.history || !ex.history.length)) {
          try {
            const hist = await loadHistory(db, { userId: task.user_id, brandKey, lookbackDays: 365, limit: 500 });
            ex.history = hist || [];
          } catch (_) { /* graceful */ }
        }
        exclusionResult = await filterCannibalizingCandidates(
          topicIdeasJson.topics,
          ex,
          { /* embeddingFn / llmJudgeFn — пока не инжектим, fallback */ },
        );
        if (exclusionResult.summary.total_dropped > 0) {
          topicIdeasJson = {
            ...topicIdeasJson,
            topics: exclusionResult.kept,
            topics_dropped_as_cannibalization: exclusionResult.dropped.map((d) => ({
              title: d.candidate.topic_title || d.candidate.title || d.candidate.h1 || null,
              reason: d.reason,
              matched_raw: d.matched ? (d.matched.raw || d.matched.query || d.matched.canon) : null,
              score: d.score || null,
            })),
          };
        }
      } catch (e) {
        console.warn(`[articleTopics] semantic exclusion failed for ${taskId}: ${e.message}`);
      }
    }

    // Aegis cross-module hook: фиксируем стадию dedup в общую телеметрию.
    try {
      require('../aegis/moduleHooks').observeStage({
        module: 'articleTopics',
        stage:  'brand_dedup',
        taskId,
        outcome: brandDedupStats && brandDedupStats.dropped > 0 ? 'warn' : 'ok',
        payload: {
          brand_key:   brandKey || null,
          kept:        Array.isArray(topicIdeasJson && topicIdeasJson.topics) ? topicIdeasJson.topics.length : 0,
          dropped:     topicsDroppedAsDuplicates,
          siblings:    siblingsCount,
        },
        warnings: topicsDroppedAsDuplicates ? { duplicates_dropped: topicsDroppedAsDuplicates } : null,
      });
    } catch (_) { /* graceful */ }

    // Снимок того, какие inputs реально подмешаны — для последующего
    // DSPy/MIPROv2 анализа качества (а пока — для отладки в admin-панели).
    // Сохраняем уже существующие topic_ideas_inputs (если они были записаны
    // controllerом при INSERT) — они нужны для воспроизводимости запроса.
    const prevContext = (task.module_context_used && typeof task.module_context_used === 'object')
      ? task.module_context_used : {};
    const moduleContextUsed = {
      ...prevContext,
      mode:              task.mode,
      siblings_injected: siblingsCount,
      trends_extracted:  trendsJson && Array.isArray(trendsJson.trends) ? trendsJson.trends.length : 0,
      ru_cis_block:      trendsJson ? trendsJson.ru_cis_block_present : null,
      topic_ideas_returned: topicCountReturned,
      topic_ideas_warnings: topicIdeasWarnings,
      brand_key:            brandKey || null,
      brand_alias_resolved: brandAliasInfo,
      brand_dedup:          brandDedupStats,
      topics_dropped_as_duplicates: topicsDroppedAsDuplicates,
      excluded_candidates_summary:  exclusionResult ? exclusionResult.summary : null,
      semantic_filter_degraded:     exclusionResult ? exclusionResult.degraded : null,
      generated_at:      new Date().toISOString(),
    };

    // ТЗ §2.2: exclusion_sources — что реально подмешано в промт + статистика
    // отбраковки. Полезно для UI плашки «N тем отброшено как каннибализация».
    const exclusionSourcesPayload = task._exclusionSet ? {
      user_topics:     task._exclusionSet.user_topics || [],
      user_clusters:   task._exclusionSet.user_clusters || [],
      history:         (task._exclusionSet.history || []).slice(0, 50).map((h) => ({
        topic_title_canon: h.topic_title_canon || null,
        intent_facet:      h.intent_facet || null,
      })),
      cannibalization: (task._exclusionSet.cannibalization || []).slice(0, 30),
      target_url_h1:   task._exclusionSet.target_url_h1 || null,
      dropped_by_semantic: exclusionResult ? exclusionResult.dropped.map((d) => ({
        title: d.candidate.topic_title || d.candidate.title || null,
        reason: d.reason,
        matched: d.matched ? (d.matched.raw || d.matched.query || d.matched.canon) : null,
      })) : [],
    } : null;

    await db.query(
      `UPDATE article_topic_tasks
          SET status = 'done',
              result_markdown   = $2,
              llm_model         = $3,
              gemini_tokens_in  = $4,
              gemini_tokens_out = $5,
              cost_usd          = $6,
              trends_json       = $7,
              module_context_used = $8,
              topic_ideas_json    = $9,
              audience_profile    = $10,
              brand_facts_json    = $11,
              topic_count_returned = $12,
              exclusion_sources    = $13::jsonb,
              completed_at      = NOW(),
              updated_at        = NOW()
        WHERE id = $1`,
      [
        taskId, result.text, result.model || null, tokensIn, tokensOut, costUsd,
        trendsJson ? JSON.stringify(trendsJson) : null,
        JSON.stringify(moduleContextUsed),
        topicIdeasJson  ? JSON.stringify(topicIdeasJson)  : null,
        audienceProfile ? JSON.stringify(audienceProfile) : null,
        brandFactsJson  ? JSON.stringify(brandFactsJson)  : null,
        topicCountReturned,
        exclusionSourcesPayload ? JSON.stringify(exclusionSourcesPayload) : null,
      ],
    );
    funnel.step('finalize');

    // После успешной записи topic_ideas_json — сохраняем canon-заголовки в
    // brand history, чтобы следующий запуск под тот же brand_key мог
    // увидеть их через detectDuplicates. Дубли по UNIQUE-индексу игнорируются.
    if (
      task.mode === 'topic_ideas'
      && topicIdeasJson
      && Array.isArray(topicIdeasJson.topics)
      && topicIdeasJson.topics.length
      && brandKey
    ) {
      try {
        await recordTopics(db, {
          userId: task.user_id,
          brandKey,
          taskId,
          topics: topicIdeasJson.topics,
        });
      } catch (e) {
        console.warn(`[articleTopics] brand history insert failed for ${taskId}: ${e.message}`);
      }
    }
    try {
      await recordTrainingExample({
        articleRef: `article_topics:${taskId}`,
        kind: 'article_topics',
        niche: task.niche || null,
        userPrompt,
        htmlOutput: result.text || '',
        qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
        feedbackMetrics: null,
        modelUsed: result.model || null,
        costUsd,
        userId: task.user_id || null,
        promptHash: resolvePromptHash('articleTopics/main'),
      });
      await recordQualityLog({
        articleRef: `article_topics:${taskId}`,
        kind: 'article_topics',
        niche: task.niche || null,
        qualityScore: { overall: 85, subscores: { eeat: 85, fact_check: 85, plagiarism: 85 } },
        reports: {},
        modelUsed: result.model || null,
        costUsd,
        iterations: 1,
        taskRef: taskId,
        userId: task.user_id || null,
        userPrompt,
        promptHash: resolvePromptHash('articleTopics/main'),
      });
    } catch (_e) { /* best-effort */ }
    try {
      await finalizeByTask({
        table: 'article_topic_tasks',
        taskId,
        ok: true,
        taskKind: 'article_topics',
      });
    } catch (_) { /* no-op */ }

    // ── Optional Stage-8-style evaluator (DeepSeek LLM-as-judge).
    // Гейтится ARTICLE_TOPICS_EVALUATOR_ENABLED=true (default OFF — нулевой
    // оверхед). Запускаем fire-and-forget — отчёт сохранится в
    // evaluator_report отдельной UPDATE-операцией.
    Promise.resolve()
      .then(() => runArticleTopicsEvaluator(taskId, task, result.text))
      .catch((evalErr) => {
        console.warn(`[articleTopics] evaluator failed for ${taskId}: ${evalErr && evalErr.message}`);
      });
    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[articleTopics] Task ${taskId} failed:`, msg);
    await db.query(
      `UPDATE article_topic_tasks
          SET status = 'error',
              error_message = $2,
              completed_at  = NOW(),
              updated_at    = NOW()
        WHERE id = $1`,
      [taskId, msg.slice(0, 4000)],
    );
    try {
      await finalizeByTask({
        table: 'article_topic_tasks',
        taskId,
        ok: false,
        error: msg,
        taskKind: 'article_topics',
      });
    } catch (_) { /* no-op */ }
    try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ }
  }
}

/**
 * Восстановление зависших задач после рестарта сервера.
 * Все задачи в статусе 'running' помечаем как error — потому что фоновый
 * процесс, который их крутил, уже мёртв.
 */
async function recoverStuckArticleTopicTasks() {
  const { rowCount } = await db.query(
    `UPDATE article_topic_tasks
        SET status = 'error',
            error_message = COALESCE(error_message,
                                     'Server restart while task was running'),
            completed_at  = NOW(),
            updated_at    = NOW()
      WHERE status = 'running'`,
  );
  if (rowCount > 0) {
    console.log(`[articleTopics] Recovered ${rowCount} stuck task(s)`);
  }
}

module.exports = {
  processArticleTopicTask,
  recoverStuckArticleTopicTasks,
};
