'use strict';

/**
 * qualityCore/qualityGate — единая точка финализации контента (V1).
 *
 * `finalize(pipeline, artifacts, opts)` прогоняет все применимые checkers
 * (qualityCore/checkers.js) над готовыми артефактами задачи и возвращает
 * единое решение:
 *
 *   { canPublish, blockers[], warnings[], gates[] }
 *
 * Один и тот же вызов используется во всех трёх пайплайнах
 * (seo / link / info) — это устраняет три параллельные реализации логики
 * «что считать провалом» (сквозная точка роста A / H / I).
 *
 * Модуль НЕ вызывает LLM и НЕ обязателен к работе с БД: тяжёлые отчёты
 * (fact-check, plagiarism, intent, lsi-overdose, risk) передаются готовыми
 * в `artifacts`. Персист решения в quality_gate_reports — опциональный
 * side-effect через persistReport().
 *
 * Артефакты (все опциональны — отсутствующие проверки просто пропускаются):
 *   {
 *     html,                 // финальный HTML
 *     currentYear,          // число (по умолчанию new Date().getFullYear())
 *     ymyl,                 // bool | undefined → авто-детект по niche
 *     niche,                // строка темы/ниши (для авто-детекта YMYL)
 *     lsiOverdoseReport,    // из infoArticle/lsiDensity.checkLsiOverdose
 *     plagiarismReport,     // из infoArticle/plagiarism.runPlagiarismCheck
 *     factReport,           // из infoArticle/factCheck.runFactCheck
 *     intentReport,         // из infoArticle/intentVerify.verifyIntent
 *     links,                // нормализованный список ссылок (см. checkLinkAudit)
 *     riskReport,           // { level, issues } (Stage 8)
 *     authorship,           // { byline, reviewer, sources }
 *     informationGainBrief, // { value_adds, gaps }
 *     tzCompliance,         // детерминированный отчёт Stage 7 по ТЗ
 *   }
 */

const checkers = require('./checkers');
const contentPolicy = require('../contentPolicy');
const { collectArtifacts } = require('./collectArtifacts');

/**
 * Список требований value-add (V3) применяется только к коммерческому SEO
 * и info-пайплайну. Для ссылочных статей (link) уникальные добавки не
 * являются обязательными (цель — публикуемость, а не топ SERP).
 */
const VALUE_ADDS_REQUIRED_PIPELINES = new Set(['seo', 'info']);

/**
 * finalize — собрать единое решение quality gate.
 * @param {string} pipeline — 'seo' | 'link' | 'info'
 * @param {object} artifacts
 * @param {object} [opts] — { thresholds, requireInPlan }
 * @returns {{ canPublish:boolean, blockers:object[], warnings:object[], gates:object[] }}
 */
function finalize(pipeline, artifacts = {}, opts = {}) {
  const thresholds = opts.thresholds;
  const currentYear = artifacts.currentYear || new Date().getFullYear();

  // YMYL: явный флаг > авто-детект по нише/теме.
  const ymyl = typeof artifacts.ymyl === 'boolean'
    ? artifacts.ymyl
    : contentPolicy.isYmylNiche(artifacts.niche || '');

  const gates = [];

  // Всегда применимы, если есть HTML.
  if (typeof artifacts.html === 'string' && artifacts.html) {
    gates.push(checkers.checkFreshness(artifacts.html, { currentYear, thresholds }));
    gates.push(checkers.checkStopPhrases(artifacts.html, { blocking: false }));
    gates.push(checkers.checkBannedFormulations(artifacts.html, { blocking: true }));
  }

  // Применяются, только если соответствующий отчёт передан.
  if (artifacts.lsiOverdoseReport) {
    gates.push(checkers.checkLsiOverdose(artifacts.lsiOverdoseReport, { thresholds }));
  }
  if (artifacts.plagiarismReport) {
    gates.push(checkers.checkPlagiarism(artifacts.plagiarismReport, { thresholds }));
  }
  if (artifacts.factReport) {
    gates.push(checkers.checkFactConfidence(artifacts.factReport, { thresholds }));
  }
  if (artifacts.intentReport) {
    gates.push(checkers.checkIntent(artifacts.intentReport, { thresholds }));
  }
  if (Array.isArray(artifacts.links)) {
    gates.push(checkers.checkLinkAudit(artifacts.links, { requireInPlan: opts.requireInPlan !== false }));
  }
  if (artifacts.riskReport) {
    gates.push(checkers.checkRisk(artifacts.riskReport, { thresholds, ymyl }));
  }
  // Authorship: обязательно проверяем для YMYL (даже если объект не передан → провал).
  if (ymyl || artifacts.authorship) {
    gates.push(checkers.checkAuthorship(artifacts.authorship, { ymyl }));
  }
  // Value-adds: для коммерческого SEO и info — обязательный brief.
  if (VALUE_ADDS_REQUIRED_PIPELINES.has(pipeline) && artifacts.informationGainBrief) {
    gates.push(checkers.checkValueAdds(artifacts.informationGainBrief, { thresholds }));
  }
  // GIST Score (12-й чекер): применяется только при наличии информационной
  // дельты (GIST M3 Gap Finder). Warning, не blocker — fail-open.
  if (Array.isArray(artifacts.informationDelta) && artifacts.informationDelta.length) {
    gates.push(checkers.checkGistScore(artifacts.html, artifacts.informationDelta, { thresholds }));
  }
  // TZ compliance (13-й чекер): warning/fail-open, не blocker.
  if (artifacts.tzCompliance) {
    gates.push(checkers.checkTzCompliance(artifacts.tzCompliance));
  }
  // Asessor-MC-Quality-Audit (14-й чекер): LLM-судья MC, если отчёт уже собран.
  if (artifacts.asessorReport) {
    gates.push(checkers.checkAsessorAudit(artifacts.asessorReport, { thresholds }));
  }
  // Topic Discovery (15-й чекер): warning при balance + manual_review.
  if (artifacts.topicDiscovery) {
    gates.push(checkers.checkTopicDiscovery(artifacts.topicDiscovery));
  }

  const blockers = gates.filter((g) => g.blocking && !g.pass);
  const warnings = gates.filter((g) => !g.pass && !g.blocking);
  const canPublish = blockers.length === 0;

  return { pipeline, ymyl, canPublish, blockers, warnings, gates };
}

/**
 * persistReport — сохранить решение gate в quality_gate_reports (upsert).
 * Опциональный side-effect: ошибки БД проглатываются (не должны валить
 * пайплайн). Возвращает число сохранённых строк.
 *
 * @param {object} params — { pipeline, taskId, result, db }
 * @returns {Promise<number>}
 */
async function persistReport({ pipeline, taskId, result, db } = {}) {
  if (!pipeline || taskId == null || !result || !Array.isArray(result.gates)) return 0;
  const client = db || require('../../config/db');
  let saved = 0;
  for (const g of result.gates) {
    try {
      await client.query(
        `INSERT INTO quality_gate_reports (pipeline_type, task_id, gate_name, pass, blocking, score, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pipeline_type, task_id, gate_name)
           DO UPDATE SET pass = EXCLUDED.pass, blocking = EXCLUDED.blocking,
                         score = EXCLUDED.score, evidence = EXCLUDED.evidence,
                         created_at = NOW()`,
        [
          pipeline, taskId, g.name, g.pass, g.blocking,
          (typeof g.score === 'number' ? g.score : null),
          JSON.stringify({ verdict: g.verdict, ...(g.evidence || {}) }),
        ],
      );
      saved += 1;
    } catch (e) {
      // graceful degradation — журнал gate не критичен для генерации
    }
  }
  return saved;
}

/**
 * runForTask — сквозной хелпер Фазы 3: нормализовать сырые артефакты
 * пайплайна, прогнать finalize() и (опц.) записать журнал в
 * quality_gate_reports. Никогда НЕ бросает — quality gate не должен ронять
 * генерацию. При ошибке возвращает безопасный «пропускной» вердикт.
 *
 * @param {object} params
 * @param {string} params.pipeline — 'seo' | 'link' | 'info'
 * @param {number|string} [params.taskId] — id задачи (для persist)
 * @param {object} params.raw — сырые данные пайплайна (см. collectArtifacts)
 * @param {object} [params.opts] — прокидывается в finalize (thresholds, requireInPlan)
 * @param {boolean} [params.persist=true] — писать ли журнал в БД
 * @param {object} [params.db] — pg-клиент (для тестов)
 * @returns {Promise<object>} результат finalize() (+ поле summary)
 */
async function runForTask({ pipeline, taskId, raw = {}, opts = {}, persist = true, db } = {}) {
  try {
    const artifacts = collectArtifacts(pipeline, raw);
    const result = finalize(pipeline, artifacts, opts);
    result.summary = summarize(result);
    if (persist && taskId != null) {
      await persistReport({ pipeline, taskId, result, db });
    }
    return result;
  } catch (e) {
    // graceful: gate никогда не должен ломать пайплайн
    return {
      pipeline, ymyl: false, canPublish: true,
      blockers: [], warnings: [], gates: [],
      summary: 'quality gate skipped (error)',
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * summarize — краткая строка причин блокировки для UI/логов.
 * @param {object} result — вывод finalize()
 * @returns {string}
 */
function summarize(result) {
  if (!result) return '';
  if (result.canPublish) {
    return result.warnings.length
      ? `OK (с предупреждениями: ${result.warnings.map((w) => w.name).join(', ')})`
      : 'OK';
  }
  return `Заблокировано: ${result.blockers.map((b) => `${b.name}=${b.verdict}`).join('; ')}`;
}

module.exports = { finalize, persistReport, summarize, runForTask, VALUE_ADDS_REQUIRED_PIPELINES };
