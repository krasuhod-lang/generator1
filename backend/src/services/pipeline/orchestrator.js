'use strict';

const db              = require('../../config/db');
const { publish }     = require('../sse/sseManager');
const { runStage0 }   = require('./stage0');
const { runStage1 }   = require('./stage1');
const { runStage2 }   = require('./stage2');
const { runStage3 }   = require('./stage3');
const { runStage4 }   = require('./stage4');
const { runStage5, checkAntiWater } = require('./stage5');
const { runStage6 }   = require('./stage6');
const { runStage7 }   = require('./stage7');
const { calculateCoverage } = require('../../utils/calculateCoverage');
const { checkObjectiveMetrics } = require('../../utils/objectiveMetrics');

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
 * @param {object} ctx  — { log, progress, job? }
 */
async function runPipeline(task, ctx) {
  const { log, progress } = ctx;
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

  // ── Stage 0 ──────────────────────────────────────────────────────
  let stage0Result = null;
  try {
    stage0Result = await runStage0(task, stageCtx);
  } catch (e) {
    log(`Stage 0 упал: ${e.message} — продолжаем без Stage 0 данных`, 'warn');
  }

  // ── Stage 1 ──────────────────────────────────────────────────────
  let stage1Result;
  try {
    stage1Result = await runStage1(task, stageCtx, stage0Result);
  } catch (e) {
    throw new Error(`Stage 1 критическая ошибка: ${e.message}`);
  }

  // ── Stage 2 ──────────────────────────────────────────────────────
  let taxonomy, stage2Raw, enrichedStage1;
  try {
    ({ taxonomy, stage2Raw, enrichedStage1 } = await runStage2(
      task, stageCtx, stage1Result
    ));
  } catch (e) {
    throw new Error(`Stage 2 критическая ошибка: ${e.message}`);
  }

  publish(taskId, { type: 'taxonomy', taxonomy });

  // ── Используем enrichedStage1 (stage1 + buyer journey) для Stage 3
  stage1Result = enrichedStage1 || stage1Result;

  // ── Stage 3: генерация блоков ─────────────────────────────────────
  let stage3Blocks;
  try {
    stage3Blocks = await runStage3(
      task, stageCtx,
      taxonomy, stage0Result, stage1Result, stage2Raw
    );
  } catch (e) {
    throw new Error(`Stage 3 критическая ошибка: ${e.message}`);
  }

  // Собираем competitor_facts из Stage 0 для factCheck
  const competitorFacts = stage0Result?.competitor_facts || [];

  // ── Цикл Stage 4 → 5 → 6 по каждому блоку ───────────────────────
  log('Stage 4–6: Аудит и доработка блоков (последовательно)...', 'info');

  const finalBlocks = [];       // финальные HTML-блоки
  const allLSISet   = new Set();  // дедупликация LSI

  for (let i = 0; i < stage3Blocks.length; i++) {
    const blockItem = stage3Blocks[i];
    const block     = blockItem.block;
    const lsiMust   = block.lsi_must || [];

    lsiMust.forEach(term => allLSISet.add(term));

    if (!blockItem.html) {
      log(`Блок ${i + 1}: пропуск (Stage 3 не вернул HTML)`, 'warn');
      await markBlockError(taskId, i, block, 'Stage 3 failed to generate HTML');
      continue;
    }

    publish(taskId, { type: 'block_start', blockIndex: i, h2: block.h2, status: 'auditing' });

    // Stage 4: E-E-A-T аудит
    let auditResult, pqScore, lsiCovPct;
    try {
      ({ auditResult, pqScore, lsiCovPct } = await runStage4(
        task, stageCtx,
        i, blockItem.html, lsiMust
      ));
    } catch (e) {
      log(`Stage 4 блок ${i + 1} ОШИБКА: ${e.message} — пропускаем аудит`, 'warn');
      finalBlocks.push(blockItem.html);
      await saveContentBlock(taskId, i, block, blockItem.html, 0, 0, null);
      continue;
    }

    const needsRefinement = lsiCovPct < 80 || pqScore < 8 || auditResult?.mathematical_audit?.spam_risk_detected;

    // Объективные JS-метрики структуры HTML (не зависят от LLM-оценки)
    const objMetrics = checkObjectiveMetrics(blockItem.html);
    const needsObjFix = !objMetrics.passed;
    if (needsObjFix && !needsRefinement) {
      log(`Блок ${i + 1}: объективные метрики НЕ пройдены (${objMetrics.issues.join('; ')}) — запускаем рефайн`, 'warn');
    }

    let currentHTML  = blockItem.html;
    let currentPQ    = pqScore;
    let currentAudit = auditResult;

    // Stage 5: PQ-рефайн (если нужен по LLM-аудиту ИЛИ по объективным метрикам)
    if (needsRefinement || needsObjFix) {
      publish(taskId, { type: 'block_start', blockIndex: i, h2: block.h2, status: 'fixing' });
      try {
        const s5 = await runStage5(
          task, stageCtx,
          i, currentHTML, lsiMust,
          currentAudit, currentPQ,
          competitorFacts, block.h2
        );
        currentHTML  = s5.html;
        currentPQ    = s5.pqScore;
        currentAudit = s5.auditLog;
      } catch (e) {
        log(`Stage 5 блок ${i + 1} ОШИБКА: ${e.message} — используем HTML после Stage 4`, 'warn');
      }
    } else {
      log(`Блок ${i + 1}: PQ ${pqScore} >= 8, LSI ${Math.round(lsiCovPct)}% >= 80% — рефайн не нужен`, 'success');
    }

    // Stage 6: LSI-инъекция (всегда, если покрытие < 100%)
    let lsiCoverageAfter = lsiCovPct;
    try {
      const s6 = await runStage6(
        task, stageCtx,
        i, currentHTML, lsiMust
      );
      currentHTML     = s6.html;
      lsiCoverageAfter = s6.lsiCoverage;
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

    log(`Блок ${i + 1} готов. LSI: ${lsiCoverageAfter}%, PQ: ${currentPQ}`, 'success');

    // Сохраняем финальный блок в БД
    await saveContentBlock(taskId, i, block, currentHTML, currentPQ, lsiCoverageAfter, currentAudit);

    finalBlocks.push(currentHTML);

    publish(taskId, {
      type:          'block_done',
      blockIndex:    i,
      h2:            block.h2,
      lsiCoverage:   lsiCoverageAfter,
      pqScore:       currentPQ,
    });

    // Прогресс: Stage 3-6 занимают ~35-88% в пайплайне
    const pct = 35 + Math.round(((i + 1) / stage3Blocks.length) * 53);
    progress(pct, 'stage6');
  }

  if (!finalBlocks.length) {
    throw new Error('Пайплайн: ни один блок не был сгенерирован');
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

  // Публикуем итоговое событие
  publish(taskId, {
    type:               'pipeline_done',
    taskId,
    blocksGenerated:    finalBlocks.length,
    globalLSICoverage:  s7Result.globalLSICoverage   || 0,
    globalEEATScore:    s7Result.globalEEATScore      || 0,
    bm25:               s7Result.bm25                 || {},
    finalHTMLLength:    (s7Result.finalHTML || '').length,
  });

  log(
    `Пайплайн завершён. Блоков: ${finalBlocks.length} | ` +
    `LSI: ${s7Result.globalLSICoverage || 0}% | ` +
    `E-E-A-T: ${s7Result.globalEEATScore || 0} | ` +
    `BM25: ${s7Result.bm25?.score?.toFixed(2) || '—'}`,
    'success'
  );

  return s7Result;
}

module.exports = { runPipeline };
