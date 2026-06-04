'use strict';

/**
 * redditMapperPipeline.js — оркестратор Reddit Mapper V2 (исследование аудитории).
 *
 * Прогоняет 7 этапов из `prompts/redditMapper` единой цепочкой, где каждый этап
 * продолжает накопительный master JSON (см. masterJson.js). Результат —
 * исследовательский слой «голоса аудитории», который infoArticle-генератор
 * подаёт в knowledge base (§10) как Information-Gain топливо для статьи.
 *
 * Интеграция с Эгидой:
 *   - все LLM-вызовы идут через services/llm/callLLM (тот же путь, что у
 *     остальных пайплайнов; маршрутизация/кэш/учёт токенов — Эгида);
 *   - промты лежат в backend/src/prompts/** → автоматически попадают под
 *     Aegis prompt-audit (resolvePromptHash) и связку с DSPy-обучением;
 *   - опциональный onTokens-callback пробрасывается для SSE/метрик.
 *
 * Интеграция с DSPy:
 *   - промты регистрируются в DSPy-style promptRegistry (см. registerRedditMapperPrompts);
 *   - few-shot усиление доступно через aegis_py /dspy/prompt/{signature}
 *     (reddit_mapper_dspy.py).
 *
 * GRACEFUL: падение одного этапа не теряет работу прошлых — master JSON
 * сохраняется, ошибка попадает в errors[] и quality_control.pipeline_errors.
 */

const { callLLM } = require('../llm/callLLM');
const { loadRedditMapperPrompt, areRedditMapperPromptsAvailable } = require('../../prompts/redditMapper');
const {
  createEmptyMaster,
  mergeMasterJson,
  validateMaster,
  buildResearchDigest,
} = require('./masterJson');

let _resolvePromptHash = null;
try {
  ({ resolvePromptHash: _resolvePromptHash } = require('../aegis/promptAudit'));
} catch (_e) {
  _resolvePromptHash = () => null; // graceful: Эгида не подключена
}

// Канонический порядок этапов + промт-ключи (для Aegis prompt-audit).
const STAGES = Object.freeze([
  { key: 'stage0', promptKey: 'redditMapper/stage0_init',      label: 'RedditMapper Этап 0 (seed)',        temperature: 0.3 },
  { key: 'stage1', promptKey: 'redditMapper/stage1_sourcemap', label: 'RedditMapper Этап 1 (source map)',  temperature: 0.35 },
  { key: 'stage2', promptKey: 'redditMapper/stage2_painmap',   label: 'RedditMapper Этап 2 (pain map)',    temperature: 0.35 },
  { key: 'stage3', promptKey: 'redditMapper/stage3_language',  label: 'RedditMapper Этап 3 (language)',    temperature: 0.35 },
  { key: 'stage4', promptKey: 'redditMapper/stage4_emerging',  label: 'RedditMapper Этап 4 (emerging)',    temperature: 0.4 },
  { key: 'stage5', promptKey: 'redditMapper/stage5_priority',  label: 'RedditMapper Этап 5 (priority)',    temperature: 0.3 },
  { key: 'stage6', promptKey: 'redditMapper/stage6_clusters',  label: 'RedditMapper Этап 6 (clusters)',    temperature: 0.3 },
]);

const DEFAULT_PROVIDER = 'deepseek';

/**
 * _buildStageUser — формирует user-payload для этапа: входной master JSON +
 * проектный бриф + (опционально) сырьё Reddit-материалов для этапов 2–4.
 *
 * Все большие куски обрезаются, чтобы не раздувать контекст.
 */
function _buildStageUser(stageKey, { brief, master, redditMaterials }) {
  const lines = ['[INPUTS]'];

  if (stageKey === 'stage0') {
    // Этап 0 собирает seed из «сырого» брифа.
    lines.push(`raw_brief: ${JSON.stringify(brief || {}).slice(0, 8000)}`);
  } else {
    // Этапы 1–6 продолжают накопительный master JSON.
    lines.push(`master_json: ${JSON.stringify(master || {}).slice(0, 24000)}`);
  }

  // Reddit-материалы релевантны этапам извлечения (2, 3, 4).
  if (['stage2', 'stage3', 'stage4'].includes(stageKey) && redditMaterials) {
    const mat = typeof redditMaterials === 'string'
      ? redditMaterials
      : JSON.stringify(redditMaterials);
    lines.push(`reddit_materials: ${String(mat).slice(0, 16000)}`);
  } else if (['stage2', 'stage3', 'stage4'].includes(stageKey)) {
    lines.push('reddit_materials: [не переданы — работай в strict-режиме, не выдумывай]');
  }

  return lines.join('\n');
}

/**
 * runRedditMapperPipeline — последовательный прогон 7 этапов.
 *
 * @param {object}   input
 * @param {object}   input.brief            — стартовый бриф проекта (niche, geo, site_input, mode, seed_topics…)
 * @param {string|object} [input.redditMaterials] — сырьё Reddit-обсуждений (опционально)
 * @param {object}   [opts]
 * @param {string}   [opts.provider='deepseek'] — LLM-провайдер для всех этапов
 * @param {Function} [opts.log]             — (msg, level) => void
 * @param {Function} [opts.onTokens]        — (model, tIn, tOut, cost) => void (SSE/метрики Эгиды)
 * @param {string[]} [opts.stages]          — подмножество ключей этапов (по умолчанию все)
 * @param {number}   [opts.retries=3]
 * @returns {Promise<{ master, digest, validation, stagesRun, errors, promptHashes }>}
 */
async function runRedditMapperPipeline(input = {}, opts = {}) {
  const provider = opts.provider || DEFAULT_PROVIDER;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const retries = Number.isFinite(opts.retries) ? opts.retries : 3;

  if (!areRedditMapperPromptsAvailable()) {
    throw new Error('[redditMapper] промты недоступны (пустые/не найдены файлы stageN_*.txt)');
  }

  const selected = Array.isArray(opts.stages) && opts.stages.length
    ? STAGES.filter((s) => opts.stages.includes(s.key))
    : STAGES;

  let master = createEmptyMaster();
  const stagesRun = [];
  const errors = [];
  const promptHashes = {};

  for (const stage of selected) {
    const user = _buildStageUser(stage.key, {
      brief: input.brief,
      master,
      redditMaterials: input.redditMaterials,
    });

    try {
      promptHashes[stage.key] = _safeHash(stage.promptKey);
      log(`[redditMapper] ${stage.label} → старт`, 'info');

      const out = await callLLM(
        provider,
        loadRedditMapperPrompt(stage.key),
        user,
        {
          retries,
          temperature: stage.temperature,
          callLabel: stage.label,
          stageName: `reddit_mapper_${stage.key}`,
          log: (m, l) => log(m, l),
          onTokens: opts.onTokens || null,
        },
      );

      master = mergeMasterJson(master, out);
      stagesRun.push(stage.key);
      log(`[redditMapper] ${stage.label} → ок`, 'info');
    } catch (err) {
      const msg = `${stage.label}: ${err && err.message ? err.message : String(err)}`;
      errors.push({ stage: stage.key, error: msg });
      log(`[redditMapper] ${msg}`, 'warn');
      // graceful: продолжаем со следующего этапа, не теряя накопленный master.
    }
  }

  // Фиксируем ошибки пайплайна в самом master (machine-readable).
  if (errors.length) {
    master.quality_control = master.quality_control || {};
    master.quality_control.pipeline_errors = errors;
  }

  const validation = validateMaster(master);
  const digest = buildResearchDigest(master);

  return { master, digest, validation, stagesRun, errors, promptHashes };
}

function _safeHash(promptKey) {
  try {
    return _resolvePromptHash ? _resolvePromptHash(promptKey) : null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  STAGES,
  DEFAULT_PROVIDER,
  runRedditMapperPipeline,
  _buildStageUser,
};
