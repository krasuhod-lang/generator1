'use strict';

/**
 * Stage 8 — Quality Evaluator (evaluator-first).
 *
 * Default ON (`STAGE8_EVALUATOR_ENABLED=false` отключает). Всегда fail-open:
 * ошибка LLM/БД только даёт warn и null, публикацию не блокирует. Generic API
 * `runQualityEvaluator()` используется SEO/info/link пайплайнами; pairwise API
 * ниже оставлен для offline DSPy-MIPRO прогонов и не подключён в прод-flow.
 */

const { recordTrace } = require('../llm/pipelineTrace');
const db = require('../../config/db');

const PROMPT_VERSION = 'v1';
const WEIGHTS = {
  gist_coverage:        25,
  replaceability_score: 20,
  factual_density:      20,
  eeat_score:           20,
  lsi_coverage:         15,
};

const TABLE_BY_PIPELINE = {
  seo:  'tasks',
  info: 'info_article_tasks',
  link: 'link_article_tasks',
};

const SYSTEM_PROMPT = `Ты — Quality Evaluator. Оцени готовую русскоязычную статью по рубрике 0–100.

Верни ровно один JSON-объект без markdown:
{
  "rubric": {
    "gist_coverage": number|null,
    "replaceability_score": number|null,
    "factual_density": number|null,
    "eeat_score": number|null,
    "lsi_coverage": number|null
  },
  "mandatory_entity_coverage": { "covered_count": int, "total": int, "missing": ["..."] },
  "ambiguous_term_violations": [ { "term": "...", "context": "..." } ],
  "claims_supported": { "supported_count": int, "unsupported": ["..."] },
  "jtbd_closed": { "closed_count": int, "total": int, "uncovered": ["..."] },
  "regulatory_risks": [ { "risk": "...", "severity": "low|medium|high", "evidence": "..." } ],
  "trust_complexity_match": { "expected": "low|medium|high", "observed_signals": ["..."], "ok": true|false },
  "total_score": number,
  "issues": [ { "severity": "low|medium|high", "issue": "...", "fix_hint": "..." } ]
}

Критерии rubric:
- gist_coverage: раскрыта ли information_delta / content gaps.
- replaceability_score: насколько трудно конкуренту заменить страницу похожей; 100 = много уникального опыта/данных/структуры.
- factual_density: если уже задана во входе, скопируй её; иначе оцени плотность конкретики.
- eeat_score: сигналы экспертизы, авторства, доверия.
- lsi_coverage: покрытие важных LSI/сущностей без переспама.
Если данных мало — ставь null, не выдумывай.`;

const PAIRWISE_SYSTEM_PROMPT = `Ты — pairwise Quality Evaluator для DSPy-MIPRO. Сравни две версии одной секции по той же рубрике Stage 8.
Верни ровно JSON: {"winner":"a|b|tie","scores":{"a":0-100,"b":0-100},"rationale":"кратко"}.`;

function safeStringify(obj, max = 6000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (_) {
    return '{}';
  }
}

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  if (html.length > 5_000_000) return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampScore(value, max = 100) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, n));
}

function toPct(value) {
  const n = clampScore(value, 100);
  if (n === null) return null;
  return n <= 10 ? n * 10 : n;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function countWords(text) {
  const words = String(text || '').match(/[\p{L}\p{N}]+/gu);
  return words ? words.length : 0;
}

function computeFactualDensityDetails(text) {
  const plain = stripHtml(text);
  const wordCount = Math.max(1, countWords(plain));
  const patterns = [
    /\b\d{1,4}(?:[\s.,]\d{3})*(?:[\s.,]\d+)?\s?(?:%|процент(?:а|ов)?|руб\.?|₽|мм|см|м|км|кг|г|шт\.?|час(?:а|ов)?|дн(?:я|ей)?|лет|год(?:а|ов)?|мес(?:яц(?:а|ев)?)?)(?=\s|[.,;:!?)]|$)/giu,
    /\b(?:19|20)\d{2}\b/g,
    /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})\b/g,
    /\b[А-ЯЁA-Z][\p{L}-]{2,}(?:\s+[А-ЯЁA-Z][\p{L}-]{2,}){0,3}\s+\d+(?:[\s.,]\d+)?\b/gu,
  ];
  let facts = 0;
  for (const re of patterns) {
    const matches = plain.match(re);
    if (matches) facts += matches.length;
  }
  const factsPer1000Words = facts / wordCount * 1000;
  const score = Math.max(0, Math.min(100, factsPer1000Words / 15 * 100));
  return {
    score: Math.round(score * 100) / 100,
    facts,
    words: wordCount,
    facts_per_1000_words: Math.round(factsPer1000Words * 100) / 100,
  };
}

function computeFactualDensity(text) {
  return computeFactualDensityDetails(text).score;
}

function computeCompositeScore(rubric) {
  let weighted = 0;
  let totalWeight = 0;
  const used = {};
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const raw = rubric && typeof rubric[key] === 'object' && rubric[key] !== null
      ? rubric[key].score
      : rubric && rubric[key];
    const score = clampScore(raw, 100);
    if (score === null) continue;
    used[key] = score;
    weighted += score * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return Math.round((weighted / totalWeight) * 100) / 100;
}

function normalizePairwiseResult(result) {
  const obj = result && typeof result === 'object' ? result : {};
  let winner = String(obj.winner || obj.result || '').trim().toLowerCase();
  if (winner === 'variant_a' || winner === 'а' || winner === 'a wins') winner = 'a';
  if (winner === 'variant_b' || winner === 'б' || winner === 'b wins') winner = 'b';
  if (!['a', 'b', 'tie'].includes(winner)) {
    const a = firstNumber(obj.scores?.a, obj.score_a, obj.a_score);
    const b = firstNumber(obj.scores?.b, obj.score_b, obj.b_score);
    if (a !== null && b !== null) winner = Math.abs(a - b) < 1 ? 'tie' : (a > b ? 'a' : 'b');
    else winner = 'tie';
  }
  const aScore = clampScore(firstNumber(obj.scores?.a, obj.score_a, obj.a_score), 100);
  const bScore = clampScore(firstNumber(obj.scores?.b, obj.score_b, obj.b_score), 100);
  return {
    winner,
    scores: { a: aScore, b: bScore },
    rationale: String(obj.rationale || obj.reason || obj.explanation || '').slice(0, 2000),
  };
}

function isStage8Enabled() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.STAGE8_EVALUATOR_ENABLED ?? 'true').toLowerCase());
}

function isPairwiseEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.STAGE8_PAIRWISE_ENABLED || '').toLowerCase());
}

function readGistCoverage(artifacts = {}) {
  const gd = artifacts.gist_delta_json || artifacts.gistDelta || artifacts.gist_delta || null;
  return toPct(
    artifacts.gist_coverage,
    artifacts.gist_score,
    gd && (gd.coverage_score ?? gd.gist_coverage_score ?? gd.gist_score),
  );
}

function readEeatScore(artifacts = {}) {
  const audit = artifacts.eeat_audit || artifacts.eeat_report || artifacts.eeatAudit || null;
  return toPct(
    artifacts.eeat_score,
    audit && (audit.total_score ?? audit.score),
    artifacts.task_metrics && artifacts.task_metrics.eeat_score,
  );
}

function readLsiCoverage(artifacts = {}) {
  const lsi = artifacts.lsi_coverage || artifacts.lsi_report || artifacts.link_lsi_report || artifacts.computed_lsi_coverage;
  return toPct(
    typeof lsi === 'number' ? lsi : null,
    lsi && (lsi.coverage_pct ?? lsi.coveragePct ?? lsi.percent),
    artifacts.globalLSICoverage,
    artifacts.task_metrics && artifacts.task_metrics.lsi_coverage,
  );
}

async function loadDbArtifacts(pipeline, taskId) {
  if (!taskId) return {};
  try {
    if (pipeline === 'seo') {
      const { rows: [row] } = await db.query(
        `SELECT t.gist_score, t.stage7_result, t.tz_compliance,
                tm.eeat_score, tm.lsi_coverage
           FROM tasks t
           LEFT JOIN task_metrics tm ON tm.task_id = t.id
          WHERE t.id = $1`,
        [taskId],
      );
      return row || {};
    }
    if (pipeline === 'info') {
      const { rows: [row] } = await db.query(
        `SELECT gist_score, gist_delta_json, eeat_score, eeat_report, lsi_report, quality_gate
           FROM info_article_tasks WHERE id = $1`,
        [taskId],
      );
      return row || {};
    }
    if (pipeline === 'link') {
      const { rows: [row] } = await db.query(
        `SELECT gist_score, gist_delta_json, eeat_score, eeat_audit, quality_gate
           FROM link_article_tasks WHERE id = $1`,
        [taskId],
      );
      return row || {};
    }
  } catch (err) {
    console.warn(`[stage8] loadDbArtifacts failed: ${err.message}`);
  }
  return {};
}

function buildEvaluatorUserPrompt({ pipeline, taskId, articleText, artifacts, deterministicRubric, task, moduleContext }) {
  const TEXT_CAP = parseInt(process.env.STAGE8_TEXT_CAP, 10) || 12000;
  const cappedText = articleText.length > TEXT_CAP ? `${articleText.slice(0, TEXT_CAP)}…` : articleText;
  return `===== INPUTS =====
pipeline: ${pipeline}
task_id: ${taskId || '—'}
niche: ${(task?.input_target_service || task?.topic || task?.region || '').slice(0, 200)}
region: ${(task?.input_region || task?.region || 'Россия').slice(0, 80)}
brand: ${(task?.input_brand_name || task?.brand_name || task?.brand || '—').slice(0, 80)}

===== DETERMINISTIC RUBRIC VALUES (копируй, если не null) =====
${safeStringify(deterministicRubric, 2500)}

===== ARTIFACTS DIGEST =====
${safeStringify({
    gist_delta_json: artifacts.gist_delta_json || artifacts.gistDelta || null,
    stage7_result: artifacts.stage7_result || artifacts.stage7Result || null,
    tz_compliance: artifacts.tz_compliance || artifacts.tzCompliance || null,
    quality_gate: artifacts.quality_gate || artifacts.qualityGate || null,
    moduleContext,
  }, 6000)}

===== ARTICLE TEXT =====
${cappedText}

===== TASK =====
Заполни JSON по system-схеме. Для missing rubric критериев оцени только если в тексте/артефактах достаточно сигналов, иначе null.`;
}

async function persistEvaluatorReport({ pipeline, taskId, report, compositeScore }) {
  const table = TABLE_BY_PIPELINE[pipeline] || TABLE_BY_PIPELINE.seo;
  try {
    if (pipeline === 'seo') {
      await db.query(
        `UPDATE tasks
            SET evaluator_report = $1, composite_quality_score = $2, updated_at = NOW()
          WHERE id = $3`,
        [JSON.stringify(report), compositeScore, taskId],
      );
    } else {
      await db.query(
        `UPDATE ${table}
            SET composite_quality_score = $1, updated_at = NOW()
          WHERE id = $2`,
        [compositeScore, taskId],
      );
    }
  } catch (err) {
    console.warn(`[stage8] persistEvaluatorReport failed: ${err.message}`);
  }
}

async function runQualityEvaluator({ pipeline = 'seo', taskId, articleHtml, articleText, artifacts = {}, task = null, moduleContext = null, log = null, onTokens = null } = {}) {
  const logger = typeof log === 'function' ? log : ((msg, level) => console.log(`[stage8] [${level || 'info'}] ${msg}`));
  if (!isStage8Enabled()) return null;

  try {
    const text = articleText || stripHtml(articleHtml || '');
    if (!text) {
      logger('Stage 8 Evaluator: пропускаем — нет текста статьи.', 'warn');
      return null;
    }

    const dbArtifacts = await loadDbArtifacts(pipeline, taskId);
    const mergedArtifacts = { ...dbArtifacts, ...artifacts };
    const factualDensity = computeFactualDensityDetails(text);
    const deterministicRubric = {
      gist_coverage:   readGistCoverage(mergedArtifacts),
      factual_density: factualDensity.score,
      eeat_score:      readEeatScore(mergedArtifacts),
      lsi_coverage:    readLsiCoverage(mergedArtifacts),
    };

    logger('Stage 8 Evaluator: запуск composite quality rubric...', 'info');
    const startedAt = Date.now();
    const { callLLM } = require('../llm/callLLM');
    const report = await callLLM('deepseek', SYSTEM_PROMPT, buildEvaluatorUserPrompt({
      pipeline, taskId, articleText: text, artifacts: mergedArtifacts, deterministicRubric, task, moduleContext,
    }), {
      retries: 2,
      taskId: pipeline === 'seo' ? taskId : null,
      traceTaskId: pipeline === 'seo' ? null : taskId,
      pipeline,
      stageName: 'stage8',
      callLabel: 'Quality Evaluator',
      promptVersion: PROMPT_VERSION,
      temperature: 0.1,
      log: logger,
      onTokens,
    });

    if (!report || typeof report !== 'object') {
      logger('Stage 8 Evaluator: модель вернула пустой/невалидный JSON — пропускаем', 'warn');
      return null;
    }

    const llmRubric = report.rubric && typeof report.rubric === 'object' ? report.rubric : {};
    const rubric = {
      gist_coverage:        deterministicRubric.gist_coverage ?? toPct(llmRubric.gist_coverage),
      replaceability_score: toPct(llmRubric.replaceability_score),
      factual_density:      deterministicRubric.factual_density,
      eeat_score:           deterministicRubric.eeat_score ?? toPct(llmRubric.eeat_score),
      lsi_coverage:         deterministicRubric.lsi_coverage ?? toPct(llmRubric.lsi_coverage),
    };
    const compositeScore = computeCompositeScore(rubric);
    const ts = Number(report.total_score);

    const finalReport = {
      ...report,
      rubric,
      rubric_weights: WEIGHTS,
      composite_quality_score: compositeScore,
      factual_density_details: factualDensity,
      total_score: Number.isFinite(ts) ? Math.max(0, Math.min(10, ts)) : (compositeScore == null ? null : Math.round(compositeScore / 10 * 10) / 10),
      elapsed_ms: Date.now() - startedAt,
      prompt_version: PROMPT_VERSION,
      generated_at: new Date().toISOString(),
    };

    if (taskId) await persistEvaluatorReport({ pipeline, taskId, report: finalReport, compositeScore });
    await recordTrace({
      stage: 'stage8_quality', pipeline, taskId, model: 'deepseek', promptVersion: PROMPT_VERSION,
      durationMs: finalReport.elapsed_ms, qualityScore: compositeScore,
    });

    logger(`Stage 8 Evaluator завершён. Composite: ${compositeScore ?? '—'}/100`, 'success');
    return finalReport;
  } catch (err) {
    logger(`Stage 8 Evaluator ОШИБКА: ${err.message} — пропускаем`, 'warn');
    return null;
  }
}

async function runStage8Evaluator(task, ctx = {}, input = {}) {
  return runQualityEvaluator({
    pipeline: 'seo',
    taskId: ctx.taskId || task?.id,
    articleHtml: input.finalHTML,
    artifacts: input.artifacts || input.stage7Result || {},
    task,
    moduleContext: input.moduleContext || task?.__moduleContext || null,
    log: ctx.log,
    onTokens: ctx.onTokens,
  });
}

async function runPairwiseComparison({ pipeline = 'seo', taskId, sectionTitle, variantA, variantB, rubricContext } = {}) {
  if (!isPairwiseEnabled()) return null;
  const startedAt = Date.now();
  try {
    const prompt = `section_title: ${sectionTitle || '—'}\n\nrubric_context:\n${safeStringify(rubricContext || {}, 4000)}\n\nVARIANT A:\n${stripHtml(variantA || '').slice(0, 6000)}\n\nVARIANT B:\n${stripHtml(variantB || '').slice(0, 6000)}\n\nСравни варианты и верни JSON.`;
    const { callLLM } = require('../llm/callLLM');
    const raw = await callLLM('deepseek', PAIRWISE_SYSTEM_PROMPT, prompt, {
      retries: 2,
      taskId: pipeline === 'seo' ? taskId : null,
      traceTaskId: pipeline === 'seo' ? null : taskId,
      pipeline,
      stageName: 'stage8_pairwise',
      callLabel: 'Stage 8 Pairwise',
      promptVersion: PROMPT_VERSION,
      temperature: 0.1,
    });
    const normalized = normalizePairwiseResult(raw);
    const winnerScore = normalized.winner === 'a'
      ? normalized.scores.a
      : normalized.winner === 'b'
        ? normalized.scores.b
        : firstNumber(normalized.scores.a, normalized.scores.b);
    await recordTrace({
      stage: 'stage8_pairwise', pipeline, taskId, model: 'deepseek', promptVersion: PROMPT_VERSION,
      durationMs: Date.now() - startedAt, qualityScore: winnerScore,
    });
    return normalized;
  } catch (err) {
    console.warn(`[stage8] pairwise failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  runStage8Evaluator,
  runQualityEvaluator,
  runPairwiseComparison,
  isStage8Enabled,
  computeFactualDensity,
  computeCompositeScore,
  normalizePairwiseResult,
  _internal: { buildEvaluatorUserPrompt, stripHtml, SYSTEM_PROMPT, WEIGHTS, isPairwiseEnabled, computeFactualDensityDetails },
};
