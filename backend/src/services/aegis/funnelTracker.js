'use strict';

/**
 * aegis/funnelTracker — единая модель «воронки генерации».
 *
 * Цель: учитывать УСПЕШНЫЕ и НЕУСПЕШНЫЕ «связки» (этапы / LLM-вызовы) каждой
 * генерации и детализировать каждую воронку — от входа до финального
 * результата — так, чтобы по корпусу задач можно было строить агрегаты:
 *   • conversion-rate по стадиям (сколько вошло → сколько прошло);
 *   • топ причин отказов на каждой стадии;
 *   • стоимость / латентность успешной vs неуспешной генерации;
 *   • разбивка по kind (info_article / link_article / meta_tags / …).
 *
 * Модель:
 *   funnel = { kind, taskRef, userId, stages: [ stage, … ] }
 *   stage  = {
 *     stage,        // имя стадии (snake_case)
 *     outcome,      // 'ok' | 'fail' | 'skipped' | 'retry'
 *     reason,       // классифицированная причина отказа (null для ok/skipped)
 *     reason_text,  // сырой текст причины (обрезан)
 *     duration_ms,  // длительность связки
 *     model,        // использованная LLM-модель (если применимо)
 *     tokens_in/out,
 *     cost_usd,
 *     attempts,     // число попыток (для retry-связок)
 *     ts,
 *   }
 *
 * Контракт без жёсткой БД-зависимости: трекер собирает JSON в памяти,
 * `toReport()` отдаёт агрегат, `persist()` (опц.) сохраняет строку в
 * таблицу `generation_funnels`. Persist и telemetry безопасны при
 * выключенном флаге (no-op), чтобы не менять поведение пайплайнов.
 *
 * Конфигурация — aegis/featureFlags.js (блок `funnel`), без новых ENV в
 * .env.example (по конвенции владельца продукта).
 */

const { getAegisFlags } = require('./featureFlags');
const { classifyIssue } = require('../infoArticle/validationFailures.service');

// telemetry опционален: грузим лениво/безопасно, чтобы избежать циклов.
let _telemetry = null;
function _tel() {
  if (_telemetry === null) {
    try { _telemetry = require('./telemetry'); }
    catch (_e) { _telemetry = false; }
  }
  return _telemetry || null;
}

// db опционален (для unit-тестов модуль грузится без БД).
let _db = null;
function _getDb() {
  if (_db === null) {
    try { _db = require('../../config/db'); }
    catch (_e) { _db = false; }
  }
  return _db || null;
}

const VALID_OUTCOMES = new Set(['ok', 'fail', 'skipped', 'retry']);
const MAX_REASON_CHARS = 500;
const MAX_STAGES = 200;

/**
 * Классификация причины отказа стадии в стабильный `reason`-код.
 * Сначала — сетевые / LLM / парсинг / таймаут / бюджет ошибки (по подстроке),
 * затем фолбэк на классификатор валидатора writer'а (ISSUE_PATTERNS), чтобы
 * причины были сопоставимы между воронками. Возвращает 'other', если ничего
 * не совпало, и null для пустого ввода.
 */
const ERROR_PATTERNS = [
  { reason: 'timeout',        re: /timed?\s*out|timeout|etimedout|deadline|aborted/i },
  { reason: 'rate_limit',     re: /rate.?limit|429|too many requests|quota|resource exhausted/i },
  { reason: 'auth',           re: /\b401\b|\b403\b|unauthor|forbidden|invalid api key|permission denied/i },
  { reason: 'network',        re: /econnreset|econnrefused|enotfound|socket hang up|network|fetch failed|getaddrinfo|dns/i },
  { reason: 'llm_error',      re: /llm|gemini|deepseek|dashscope|openai|completion|model (?:error|failed)|overloaded|503|500|502|504/i },
  { reason: 'parse_error',    re: /json|parse|unexpected token|malformed|invalid (?:response|format|output)|schema/i },
  { reason: 'empty_output',   re: /empty|пуст|no (?:content|output|result)|нет (?:контента|результата)/i },
  { reason: 'budget',         re: /budget|превышен.*расход|cost.*exceed|kill.?switch/i },
  { reason: 'not_found',      re: /not found|404|не найден|отсутству/i },
  { reason: 'db_error',       re: /database|postgres|sql|deadlock|relation .* does not exist/i },
];

function classifyReason(input) {
  if (input == null) return null;
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof Error) text = input.message || String(input);
  else if (typeof input === 'object') text = input.message || input.text || JSON.stringify(input);
  else text = String(input);
  if (!text || !text.trim()) return null;

  for (const p of ERROR_PATTERNS) {
    if (p.re.test(text)) return p.reason;
  }
  // Фолбэк на классификатор валидатора writer'а (h1_count, faq_block, lsi_missing, …).
  const validatorKind = classifyIssue(text);
  if (validatorKind && validatorKind !== 'other') return validatorKind;
  return 'other';
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _isOn() {
  try { return getAegisFlags().funnel.enabled === true; }
  catch (_e) { return false; }
}

/**
 * createFunnelTracker({ kind, taskRef, userId, niche })
 * Создаёт трекер одной воронки генерации.
 */
function createFunnelTracker({ kind, taskRef = null, userId = null, niche = null } = {}) {
  const startedAt = Date.now();
  const stages = [];

  function recordStage(stage, opts = {}) {
    if (stages.length >= MAX_STAGES) return null;
    const outcome = VALID_OUTCOMES.has(opts.outcome) ? opts.outcome : 'ok';
    const reasonRaw = (outcome === 'fail' || outcome === 'retry')
      ? (opts.reason != null ? opts.reason : opts.error)
      : null;
    const reasonText = reasonRaw == null
      ? null
      : String(reasonRaw instanceof Error ? reasonRaw.message : reasonRaw).slice(0, MAX_REASON_CHARS);
    const entry = {
      stage:       String(stage || 'unknown'),
      outcome,
      reason:      reasonRaw == null ? null : classifyReason(reasonRaw),
      reason_text: reasonText,
      duration_ms: opts.durationMs != null ? Math.max(0, Math.round(_num(opts.durationMs))) : null,
      model:       opts.model || null,
      tokens_in:   opts.tokensIn != null ? Math.round(_num(opts.tokensIn)) : null,
      tokens_out:  opts.tokensOut != null ? Math.round(_num(opts.tokensOut)) : null,
      cost_usd:    opts.costUsd != null ? _num(opts.costUsd) : null,
      attempts:    opts.attempts != null ? Math.max(1, Math.round(_num(opts.attempts))) : 1,
      ts:          new Date().toISOString(),
    };
    stages.push(entry);

    // Telemetry (Prometheus) — безопасно при выключенной телеметрии.
    const tel = _tel();
    if (tel && tel.recordFunnelStage) {
      try {
        tel.recordFunnelStage({
          kind:       String(kind || 'unknown'),
          stage:      entry.stage,
          outcome:    entry.outcome,
          reason:     entry.reason,
          durationMs: entry.duration_ms,
        });
      } catch (_e) { /* telemetry must never throw */ }
    }
    return entry;
  }

  /**
   * runStage(name, fn, opts) — оборачивает асинхронную стадию: измеряет
   * длительность, ставит outcome=ok при успехе и outcome=fail + причина при
   * исключении (исключение пробрасывается дальше — бизнес-логика не меняется).
   * opts.optional=true → исключение конвертируется в skipped и НЕ пробрасывается
   * (для некритичных стадий, как в существующих graceful-обёртках).
   */
  async function runStage(name, fn, opts = {}) {
    const t0 = Date.now();
    try {
      const result = await fn();
      recordStage(name, {
        outcome: 'ok',
        durationMs: Date.now() - t0,
        model: opts.model,
        tokensIn: opts.tokensIn,
        tokensOut: opts.tokensOut,
        costUsd: opts.costUsd,
      });
      return result;
    } catch (err) {
      if (opts.optional) {
        recordStage(name, { outcome: 'skipped', reason: err, durationMs: Date.now() - t0 });
        return opts.fallback !== undefined ? opts.fallback : null;
      }
      recordStage(name, { outcome: 'fail', error: err, durationMs: Date.now() - t0 });
      throw err;
    }
  }

  /**
   * toReport(finalOpts) — машинно-читаемый агрегат воронки.
   *   finalOpts.status   — финальный статус ('completed'|'failed'|'partial').
   *   finalOpts.error    — текст ошибки (если воронка оборвалась).
   * Если status не задан, выводится из стадий (fail → failed, иначе completed).
   */
  function toReport(finalOpts = {}) {
    const failStage = stages.find((s) => s.outcome === 'fail') || null;
    const status = finalOpts.status
      || (failStage ? 'failed' : 'completed');
    const finalStage = failStage
      ? failStage.stage
      : (stages.length ? stages[stages.length - 1].stage : null);
    const failReason = finalOpts.error != null
      ? classifyReason(finalOpts.error)
      : (failStage ? failStage.reason : null);

    const byOutcome = { ok: 0, fail: 0, skipped: 0, retry: 0 };
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalRetries = 0;
    for (const s of stages) {
      byOutcome[s.outcome] = (byOutcome[s.outcome] || 0) + 1;
      totalCost += _num(s.cost_usd);
      totalTokensIn += _num(s.tokens_in);
      totalTokensOut += _num(s.tokens_out);
      if (s.attempts > 1) totalRetries += (s.attempts - 1);
    }

    return {
      kind:           String(kind || 'unknown'),
      task_ref:       taskRef ? String(taskRef) : null,
      niche:          niche || null,
      status,
      final_stage:    finalStage,
      fail_reason:    status === 'completed' ? null : failReason,
      fail_reason_text: failStage ? failStage.reason_text
        : (finalOpts.error != null ? String(finalOpts.error instanceof Error ? finalOpts.error.message : finalOpts.error).slice(0, MAX_REASON_CHARS) : null),
      stage_count:    stages.length,
      by_outcome:     byOutcome,
      total_cost_usd: Number(totalCost.toFixed(6)),
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      total_retries:  totalRetries,
      duration_ms:    Date.now() - startedAt,
      stages,
    };
  }

  /**
   * persist(finalOpts) — сохраняет строку воронки в `generation_funnels`.
   * No-op (возвращает { ok:false, reason:'disabled' }) при выключенном флаге
   * funnel.persist. Никогда не бросает — аналитика не должна валить генерацию.
   */
  async function persist(finalOpts = {}) {
    const report = toReport(finalOpts);
    let flags;
    try { flags = getAegisFlags().funnel; } catch (_e) { flags = null; }
    if (!flags || flags.persist !== true) return { ok: false, reason: 'disabled', report };
    const db = _getDb();
    if (!db) return { ok: false, reason: 'no_db', report };
    try {
      await db.query(
        `INSERT INTO generation_funnels
           (kind, task_ref, user_id, niche, status, final_stage, fail_reason,
            stage_count, total_cost_usd, total_tokens_in, total_tokens_out,
            total_retries, duration_ms, report)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         ON CONFLICT (kind, task_ref) WHERE task_ref IS NOT NULL
         DO UPDATE SET
           status = EXCLUDED.status,
           final_stage = EXCLUDED.final_stage,
           fail_reason = EXCLUDED.fail_reason,
           stage_count = EXCLUDED.stage_count,
           total_cost_usd = EXCLUDED.total_cost_usd,
           total_tokens_in = EXCLUDED.total_tokens_in,
           total_tokens_out = EXCLUDED.total_tokens_out,
           total_retries = EXCLUDED.total_retries,
           duration_ms = EXCLUDED.duration_ms,
           report = EXCLUDED.report,
           finished_at = NOW()`,
        [
          report.kind,
          report.task_ref,
          userId || null,
          report.niche,
          report.status,
          report.final_stage,
          report.fail_reason,
          report.stage_count,
          report.total_cost_usd,
          report.total_tokens_in,
          report.total_tokens_out,
          report.total_retries,
          report.duration_ms,
          JSON.stringify(report),
        ],
      );
      return { ok: true, report };
    } catch (e) {
      return { ok: false, reason: 'db_error', error: e.message, report };
    }
  }

  // ── Stepper API (минимальная разметка пайплайнов) ─────────────────
  // Паттерн: одна строка `funnel.step('name')` на границе стадии. step()
  // закрывает предыдущую открытую стадию как ok (с длительностью) и
  // открывает новую. fail(err) закрывает текущую открытую стадию как fail.
  // finish(opts) закрывает текущую как ok и (опц.) персистит. Это даёт
  // полную пер-стадийную детализацию и корректную атрибуцию обрыва при
  // минимуме правок в больших пайплайнах.
  let _openStage = null;
  let _openAt = 0;

  function _closeOpen(outcome, errOrReason, opts = {}) {
    if (!_openStage) return;
    recordStage(_openStage, {
      outcome,
      reason: outcome === 'ok' ? null : errOrReason,
      durationMs: Date.now() - _openAt,
      model: opts.model,
      tokensIn: opts.tokensIn,
      tokensOut: opts.tokensOut,
      costUsd: opts.costUsd,
    });
    _openStage = null;
  }

  function step(name, opts = {}) {
    _closeOpen('ok', null, opts);
    _openStage = String(name || 'unknown');
    _openAt = Date.now();
    return _openStage;
  }

  function skip(name, reason = null) {
    _closeOpen('ok');
    recordStage(name, { outcome: 'skipped', reason });
  }

  function fail(errOrReason, opts = {}) {
    _closeOpen('fail', errOrReason, opts);
  }

  async function finish(finalOpts = {}) {
    if (finalOpts.error != null) _closeOpen('fail', finalOpts.error);
    else _closeOpen('ok');
    return persist(finalOpts);
  }

  return { recordStage, runStage, step, skip, fail, finish, toReport, persist, _stages: stages, kind, taskRef };
}

/**
 * recordTaskFunnel({ kind, taskRef, userId, niche, status, error, stages })
 * — упрощённый «task-level» helper для пайплайнов, у которых нет детальной
 * пер-стадийной разметки: фиксирует одну связку с финальным исходом. Если
 * передан массив stages — каждый элемент записывается через recordStage.
 * Возвращает результат persist() (no-op при выключенном флаге).
 */
async function recordTaskFunnel({ kind, taskRef = null, userId = null, niche = null, status = null, error = null, stages = null } = {}) {
  const tracker = createFunnelTracker({ kind, taskRef, userId, niche });
  if (Array.isArray(stages)) {
    for (const s of stages) {
      if (s && s.stage) tracker.recordStage(s.stage, s);
    }
  }
  return tracker.persist({ status: status || (error ? 'failed' : 'completed'), error });
}

module.exports = {
  createFunnelTracker,
  recordTaskFunnel,
  classifyReason,
  ERROR_PATTERNS,
  isFunnelEnabled: _isOn,
};
