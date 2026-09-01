'use strict';

const { callDeepSeek, DEEPSEEK_DEFAULT_MAX_TOKENS } = require('./deepseek.adapter');
const { callGemini }   = require('./gemini.adapter');
const { callGrok }     = require('./grok.adapter');
const { callOpenAI }   = require('./openai.adapter');
const { autoCloseJSON, extractBalancedJson } = require('../../utils/autoCloseJSON');
const db               = require('../../config/db');
const {
  calculateCostBreakdown,
  estimateTokens,
} = require('../metrics/priceCalculator');
const { getCachedResponse, setCachedResponse } = require('./responseCache');
const responseCacheModule = require('./responseCache');
const { withProviderSlot } = require('./rateLimiter');
const { recordTrace } = require('./pipelineTrace');
const { recordApiRequest } = require('../metrics/adminApiLedger');

// Дефолтный лимит выходных токенов по адаптерам — соответствует значениям
// по умолчанию внутри самих адаптеров. Используется как fallback в логике
// авто-удвоения maxTokens при обрезанном ответе: если вызывающая сторона
// не передала maxTokens явно, реальный первый запрос ушёл с дефолтом
// адаптера (напр. DeepSeek 16000), поэтому «удваивать» надо от него, а не
// от заниженной константы — иначе ретрай УМЕНЬШАЛ бы лимит и усугублял обрыв.
const ADAPTER_DEFAULT_MAX_TOKENS = {
  deepseek:   DEEPSEEK_DEFAULT_MAX_TOKENS, // 16000 (env DEEPSEEK_MAX_TOKENS)
  gemini:     16384,                       // gemini.adapter profile default
  grok:       8192,                       // grok.adapter default
  openai:     16000,                      // openai.adapter default
};

// ────────────────────────────────────────────────────────────────────
// Per-task token budget guard
//
// Gemini вызовы (Stage 3/5/6) могут раскручиваться до десятков долларов
// на одну задачу при патологии (бесконечный refine-loop, огромный input).
// Здесь — мягкий guard: вызывающая сторона передаёт `tokenBudget`
// (Infinity по умолчанию). Когда бюджет исчерпан — бросаем
// `BudgetExceededError` с `isDeterministic=true`, чтобы callLLM не
// плодил ретраи. Внешние стадии могут поймать ошибку и решить, что делать
// (например, пропустить Stage 6 cycle 2/3).
//
// Бюджет считается по billable input tokens: Gemini cachedContent входит в
// provider prompt_tokens, но cached input уже тарифицируется отдельно и не
// должен повторно блокировать обязательную генерацию каждого H2-блока.
// Фактические provider tokens и billing metrics при этом сохраняются без
// изменений.
//
// Состояние per-task хранится в Map(taskId → {gemini, deepseek, reservedGemini}).
// ────────────────────────────────────────────────────────────────────

const tokenBudgetState = new Map(); // taskId → { gemini, deepseek, reservedGemini }

// Без явного лимита runaway-сценарии (Stage 5/6 refine, corrective retry)
// могли бесконечно наращивать Gemini input spend. 200k billable input tokens
// — консервативный production default: обычная SEO/info/link задача укладывается
// в него, а патологическая задача останавливает только необязательные вызовы.
const DEFAULT_GEMINI_TASK_TOKEN_BUDGET = 200000;

function getConfiguredTaskTokenBudget() {
  const raw = process.env.GEMINI_TASK_TOKEN_BUDGET;
  // 0/отрицательное значение сохраняет явный opt-out для аварийной
  // совместимости со старыми окружениями; отсутствие переменной — конечный
  // защитный default.
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_GEMINI_TASK_TOKEN_BUDGET;
    return n > 0 ? n : Infinity;
  }
  return DEFAULT_GEMINI_TASK_TOKEN_BUDGET;
}

class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
    this.isBudgetExceeded = true;
    this.isDeterministic  = true;
  }
}

/**
 * resetTaskBudget — обнуляет учёт для taskId. Вызывать в начале runPipeline().
 */
function resetTaskBudget(taskId) {
  if (taskId) tokenBudgetState.delete(taskId);
}

/**
 * getTaskBudgetSpent — текущее потребление токенов по адаптеру для задачи.
 */
function getTaskBudgetSpent(taskId, adapter = 'gemini') {
  const st = tokenBudgetState.get(taskId);
  return st ? (st[adapter] || 0) : 0;
}

/**
 * Возвращает доступный остаток input-бюджета для provider-класса Gemini/Grok.
 * Это только локальный preflight; окончательное reservation выполняется
 * атомарно непосредственно перед HTTP-вызовом.
 */
function getTaskBudgetRemaining(taskId, tokenBudget = getConfiguredTaskTokenBudget(), adapter = 'gemini') {
  if (!taskId || !Number.isFinite(tokenBudget)) return Infinity;
  const st = tokenBudgetState.get(taskId);
  if (!st) return tokenBudget;
  const key = adapter === 'openai' ? 'openai' : 'gemini';
  const reservedKey = key === 'openai' ? 'reservedOpenai' : 'reservedGemini';
  return Math.max(0, tokenBudget - Math.max(0, Number(st[key]) || 0) - Math.max(0, Number(st[reservedKey]) || 0));
}

function _getBudgetState(taskId) {
  if (!taskId) return null;
  const st = tokenBudgetState.get(taskId) || {
    gemini: 0,
    openai: 0,
    deepseek: 0,
    reservedGemini: 0,
    reservedOpenai: 0,
  };
  if (!Number.isFinite(st.reservedGemini)) st.reservedGemini = 0;
  if (!Number.isFinite(st.reservedOpenai)) st.reservedOpenai = 0;
  tokenBudgetState.set(taskId, st);
  return st;
}

function _accumulateTokens(taskId, adapter, tokensIn) {
  if (!taskId) return;
  const st = _getBudgetState(taskId);
  st[adapter] = (st[adapter] || 0) + Math.max(0, Number(tokensIn) || 0);
  tokenBudgetState.set(taskId, st);
}

/**
 * Tokens used by the budget guard, separate from provider-reported usage.
 * Gemini cachedContent reports the cached system context inside tokensIn;
 * it is already represented by cachedTokens and should not consume the same
 * task budget again. Billing still receives the original tokensIn below.
 */
function getBudgetInputTokens(adapter, result, fallback = 0) {
  const total = Math.max(0, Number(result?.tokensIn) || Number(fallback) || 0);
  if (adapter === 'gemini' || adapter === 'openai') {
    const cached = Math.min(total, Math.max(0, Number(result?.cachedTokens) || 0));
    return Math.max(0, total - cached);
  }
  return total;
}

/**
 * Reserving the estimated prompt budget before the HTTP request closes the
 * race where several independent Gemini calls all see the same pre-spend.
 * The reservation is released and replaced by actual usage on success.
 */
function _reserveMeteredBudget(taskId, tokenBudget, estimatedTokens, adapter = 'gemini') {
  if (!taskId || !Number.isFinite(tokenBudget)) return null;
  const key = adapter === 'openai' ? 'openai' : 'gemini';
  const reservedKey = key === 'openai' ? 'reservedOpenai' : 'reservedGemini';
  const st = _getBudgetState(taskId);
  const estimate = Math.max(1, Math.ceil(Number(estimatedTokens) || 0));
  const committed = Math.max(0, Number(st[key]) || 0);
  const reserved = Math.max(0, Number(st[reservedKey]) || 0);
  if (committed + reserved + estimate > tokenBudget) {
    throw new BudgetExceededError(
      `${key} token budget exhausted for task ${taskId}: `
      + `${committed + reserved}/${tokenBudget} input tokens reserved. `
      + 'Skip non-essential calls and continue.'
    );
  }
  st[reservedKey] = reserved + estimate;
  tokenBudgetState.set(taskId, st);
  let released = false;
  return {
    commit(actualTokens) {
      if (released) return;
      released = true;
      const current = _getBudgetState(taskId);
      current[reservedKey] = Math.max(0, (current[reservedKey] || 0) - estimate);
      current[key] = (current[key] || 0) + Math.max(0, Number(actualTokens) || 0);
      tokenBudgetState.set(taskId, current);
    },
    release() {
      if (released) return;
      released = true;
      const current = _getBudgetState(taskId);
      current[reservedKey] = Math.max(0, (current[reservedKey] || 0) - estimate);
      tokenBudgetState.set(taskId, current);
    },
  };
}

/**
 * clampPQScore — нормализует PQ-score в допустимый диапазон [0, 10].
 *
 * LLM иногда возвращает значения с потерянной десятичной точкой
 * (например, `72` вместо `7.2`, `750` вместо `7.5`). Восстанавливаем
 * правдоподобную шкалу делением на 10 / 100, затем clamp в [0, 10].
 *
 * @param {*} value — сырое значение pq_score
 * @returns {number|undefined} нормализованный PQ-score (0..10) или undefined
 */
function clampPQScore(value) {
  if (value === null || value === undefined) return value;
  let n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return value;
  if (n < 0) n = 0;
  // Восстанавливаем потерянную десятичную точку
  if (n > 10 && n <= 100)        n = n / 10;    // 72 → 7.2
  else if (n > 100 && n <= 1000) n = n / 100;   // 750 → 7.5
  else if (n > 1000)             n = n / Math.pow(10, String(Math.trunc(n)).length - 1); // 9999 → 9.999
  if (n > 10) n = 10;
  return Math.round(n * 10) / 10; // округляем до 1 знака
}

/**
 * Нормализует ключи JSON-ответа LLM для обратной совместимости
 * (та же логика, что была в index.html).
 */
function normalizeKeys(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  if (parsed.htmlcontent && !parsed.html_content)       parsed.html_content       = parsed.htmlcontent;
  if (parsed.html_content && !parsed.htmlcontent)       parsed.htmlcontent        = parsed.html_content;
  if (parsed.pqscore && !parsed.pq_score)               parsed.pq_score           = parsed.pqscore;
  if (parsed.pq_score && !parsed.pqscore)               parsed.pqscore            = parsed.pq_score;

  // Clamp pq_score / pqscore: LLM иногда теряет десятичную точку (72 вместо 7.2).
  if (parsed.pq_score !== undefined) parsed.pq_score = clampPQScore(parsed.pq_score);
  if (parsed.pqscore  !== undefined) parsed.pqscore  = clampPQScore(parsed.pqscore);

  if (parsed.mathematicalaudit && !parsed.mathematical_audit)
    parsed.mathematical_audit = parsed.mathematicalaudit;
  if (parsed.mathematical_audit && !parsed.mathematicalaudit)
    parsed.mathematicalaudit  = parsed.mathematical_audit;

  if (parsed.global_audit && !parsed.globalaudit)       parsed.globalaudit        = parsed.global_audit;
  if (parsed.globalaudit) {
    if (parsed.globalaudit.hcu_status && !parsed.globalaudit.hcustatus)
      parsed.globalaudit.hcustatus       = parsed.globalaudit.hcu_status;
    if (parsed.globalaudit.page_quality_score && !parsed.globalaudit.pagequalityscore)
      parsed.globalaudit.pagequalityscore = parsed.globalaudit.page_quality_score;
    // Глобальный page_quality_score тоже clamp'им (та же логика)
    if (parsed.globalaudit.page_quality_score !== undefined)
      parsed.globalaudit.page_quality_score = clampPQScore(parsed.globalaudit.page_quality_score);
    if (parsed.globalaudit.pagequalityscore !== undefined)
      parsed.globalaudit.pagequalityscore = clampPQScore(parsed.globalaudit.pagequalityscore);
  }

  if (parsed.tfidf_and_spam_report && !parsed.tf_idf_and_spam_report)
    parsed.tf_idf_and_spam_report = parsed.tfidf_and_spam_report;
  if (parsed.eeatcriteriabreakdown && !parsed.eeat_criteria_breakdown)
    parsed.eeat_criteria_breakdown = parsed.eeatcriteriabreakdown;

  return parsed;
}

/**
 * Определяет, обрезан ли JSON-ответ LLM (незакрытые скобки).
 * Работает независимо от finish_reason.
 */
function _isJsonTruncated(text) {
  if (!text) return false;
  const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // Находим первую открывающую скобку
  const start = Math.min(
    t.indexOf('{') === -1 ? Infinity : t.indexOf('{'),
    t.indexOf('[') === -1 ? Infinity : t.indexOf('[')
  );
  if (start === Infinity) return false;
  // Считаем баланс скобок
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth > 0; // если depth > 0 — JSON незакрыт
}

/**
 * Пытается распарсить JSON из сырого текста LLM.
 * Применяет autoCloseJSON при обрыве.
 */
function salvageQualityJson(text, parseError = null) {
  const source = String(text || '');
  if (!source.trim() || !/[{[]/.test(source)) return null;

  const numberAfter = (keys) => {
    for (const key of keys) {
      const re = new RegExp(`(?:['\\\"])?${key}(?:['\\\"])?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
      const match = source.match(re);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };
  const score = (value) => {
    if (value == null) return null;
    const n = clampPQScore(value);
    return Number.isFinite(Number(n)) ? Number(n) : null;
  };

  const pq = score(numberAfter(['pq_score', 'pqscore']));
  const pageQuality = score(numberAfter(['page_quality_score', 'pagequalityscore']));
  const lsiCoverage = numberAfter(['lsi_coverage_percent', 'lsi_coverage']);
  const result = {
    audit_status: 'partial_json',
    audit_error: parseError?.message || 'JSON response was incomplete',
    partial_json: true,
  };

  if (pq != null) result.pq_score = pq;
  if (lsiCoverage != null) {
    result.mathematical_audit = {
      lsi_coverage_percent: Math.max(0, Math.min(100, lsiCoverage)),
      spam_risk_detected: /(?:['\\\"])?spam_risk_detected(?:['\\\"])?\\s*:\\s*true/i.test(source),
    };
  }
  if (pageQuality != null) {
    result.global_audit = { page_quality_score: pageQuality };
  }

  const criteria = ['experience', 'expertise', 'authoritativeness', 'trustworthiness', 'content_quality'];
  const breakdown = {};
  for (const criterion of criteria) {
    const re = new RegExp(`['\\\"]${criterion}['\\\"]\\s*:\\s*\\{[\\s\\S]{0,600}?['\\\"]score['\\\"]\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
    const match = source.match(re);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n)) breakdown[criterion] = { score: Math.max(0, Math.min(2, n)) };
    }
  }
  if (Object.keys(breakdown).length) result.eeat_criteria_breakdown = breakdown;
  if (pq == null && pageQuality == null && !Object.keys(breakdown).length && lsiCoverage == null) return null;
  return result;
}

function parseJSON(text) {
  // Убираем Markdown-обёртку если есть
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Попытка 0: первый СБАЛАНСИРОВАННЫЙ JSON-объект/массив — игнорируем
  // любой мусор после закрывающей скобки (второй JSON-блок, пояснения
  // модели со скобками и т.п.). Именно такой хвост даёт ошибку
  // «Unexpected non-whitespace character after JSON at position N».
  const balanced = extractBalancedJson(t);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch (_) { /* fallback ниже */ }
  }

  // Находим границы JSON-объекта или массива
  const fb  = t.indexOf('{');
  const fab = t.indexOf('[');
  let start = -1;
  if (fb !== -1 && fab !== -1)      start = Math.min(fb, fab);
  else if (fb !== -1)                start = fb;
  else if (fab !== -1)               start = fab;

  if (start !== -1) {
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    t = end > start ? t.substring(start, end + 1) : t.substring(start);
  }

  // Попытка 1: честный JSON.parse
  try {
    return JSON.parse(t);
  } catch (_) { /* fallback */ }

  // Попытка 2: autoCloseJSON — восстановление обрывов
  try {
    return JSON.parse(autoCloseJSON(t));
  } catch (e) {
    throw new Error(`JSON parse failed after autoCloseJSON: ${e.message}`);
  }
}

/**
 * Сохраняет запись о вызове LLM в task_stages и обновляет task_metrics.
 */
function inferPipeline(stageName, pipeline) {
  if (pipeline) return pipeline;
  const s = String(stageName || '').toLowerCase();
  if (s.includes('info')) return 'info';
  if (s.includes('link')) return 'link';
  return 'seo';
}

async function persistStageCall({
  taskId, traceTaskId, pipeline, stageName, callLabel, model, promptSize,
  tokensIn, tokensOut, costUsd, resultJson, startedAt, promptVersion,
  qualityScore, triggeredRefine, pricingMeta,
}) {
  const completedAt = new Date();
  const traceId = traceTaskId || taskId;

  // Дублируем task_stages в универсальный pipeline_traces. Для info/link
  // taskId в task_stages не передаётся из-за FK на tasks, но traceTaskId
  // позволяет всё равно видеть LLM-трафик в общей таблице.
  await recordTrace({
    stage: stageName,
    pipeline: inferPipeline(stageName, pipeline),
    taskId: traceId,
    model,
    promptVersion,
    inputTokens: tokensIn,
    outputTokens: tokensOut,
    durationMs: startedAt ? completedAt.getTime() - new Date(startedAt).getTime() : null,
    qualityScore,
    triggeredRefine,
  });

  if (!taskId) return;

  try {
    // Вставляем запись о вызове
    await db.query(
      `INSERT INTO task_stages
         (task_id, stage_name, call_label, status, model_used, prompt_size,
          tokens_in, tokens_out, cost_usd, result_json, started_at, completed_at,
          model_tier, pricing_mode, cache_hit_tokens, cache_miss_tokens,
          thoughts_tokens, input_cost_usd, output_cost_usd)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [taskId, stageName, callLabel, model, promptSize,
       tokensIn, tokensOut, costUsd, resultJson ? JSON.stringify(resultJson) : null,
       startedAt, completedAt,
       pricingMeta?.modelTier || model || null,
       pricingMeta?.pricingMode || null,
       pricingMeta?.cacheHitTokens || 0,
       pricingMeta?.cacheMissTokens || 0,
       pricingMeta?.thoughtsTokens || 0,
       pricingMeta?.inputCostUsd || 0,
       pricingMeta?.outputCostUsd || 0]
    );

    // Обновляем агрегированные метрики. Каждый провайдер пишет в свою
    // тройку колонок:
    //   - DeepSeek    → deepseek_tokens_in/out/cost_usd
    //   - Grok (x.ai) → grok_tokens_in/out/cost_usd
    //   - Gemini      → gemini_tokens_in/out/cost_usd
    // До migration 011 Grok сваливался в gemini_*; теперь — отдельно.
    let metricsCol;
    if (model.startsWith('deepseek')) {
      metricsCol = { colIn: 'deepseek_tokens_in', colOut: 'deepseek_tokens_out', colCost: 'deepseek_cost_usd' };
    } else if (model.startsWith('grok')) {
      metricsCol = { colIn: 'grok_tokens_in',     colOut: 'grok_tokens_out',     colCost: 'grok_cost_usd'     };
    } else if (model.startsWith('gpt-')) {
      metricsCol = { colIn: 'openai_tokens_in',   colOut: 'openai_tokens_out',   colCost: 'openai_cost_usd'   };
    } else {
      metricsCol = { colIn: 'gemini_tokens_in',   colOut: 'gemini_tokens_out',   colCost: 'gemini_cost_usd'   };
    }

    await db.query(
      `INSERT INTO task_metrics (task_id, ${metricsCol.colIn}, ${metricsCol.colOut}, ${metricsCol.colCost}, total_tokens, total_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id) DO UPDATE SET
         ${metricsCol.colIn}   = task_metrics.${metricsCol.colIn}   + EXCLUDED.${metricsCol.colIn},
         ${metricsCol.colOut}  = task_metrics.${metricsCol.colOut}  + EXCLUDED.${metricsCol.colOut},
         ${metricsCol.colCost} = task_metrics.${metricsCol.colCost} + EXCLUDED.${metricsCol.colCost},
         total_tokens          = task_metrics.total_tokens          + EXCLUDED.total_tokens,
         total_cost_usd        = task_metrics.total_cost_usd        + EXCLUDED.total_cost_usd,
         updated_at            = NOW()`,
      [taskId, tokensIn, tokensOut, costUsd, tokensIn + tokensOut, costUsd]
    );
  } catch (dbErr) {
    // Не прерываем пайплайн из-за ошибки записи метрик
    console.error('[callLLM] Failed to persist stage metrics:', dbErr.message);
  }
}

/**
 * Главная функция вызова LLM.
 *
 * @param {'deepseek'|'gemini'|'grok'} adapter   — какой адаптер использовать
 * @param {string}              system    — системный промпт
 * @param {string}              prompt    — пользовательский промпт
 * @param {object}              [opts]
 * @param {number}              [opts.retries=6]
 * @param {string}              [opts.taskId]       — UUID задачи для записи в БД
 * @param {string}              [opts.stageName]    — 'stage0', 'stage1', ...
 * @param {string}              [opts.callLabel]    — 'SERP Check', 'Entity Builder', ...
 * @param {Function}            [opts.onLog]        — callback(msg, level) для SSE-логов
 * @param {number}              [opts.temperature]
 * @param {number}              [opts.maxTokens]
 * @param {number}              [opts.timeoutMs]    — переопределяет дефолтный
 *                                                    таймаут адаптера. Полезно
 *                                                    для тяжёлых writer-стадий
 *                                                    с большим maxTokens, где
 *                                                    дефолтные 3 минуты Gemini
 *                                                    стабильно недостаточны.
 * @param {string}              [opts.cachedContent]— `cachedContents/...` (Gemini only)
 * @param {Function}            [opts.onCacheMiss]  — callback() при HTTP 404 на cachedContent;
 *                                                    после вызова callLLM однократно перезапросит
 *                                                    без cachedContent.
  * @param {number}  [opts.tokenBudget]  — лимит input-токенов на задачу (для Gemini).
 *                                                    Production default — 200000 billable input
 *                                                    tokens; cached Gemini context не считается
 *                                                    повторно. Передайте Infinity для opt-out.
 *                                                    При исчерпании —
 *                                                    BudgetExceededError (isDeterministic).
 * @param {boolean} [opts.allowPartialJson=false] — opt-in salvage score fields from
 *                                                    an incomplete quality-audit JSON;
 *                                                    disabled for ordinary calls.
 * @param {boolean} [opts.skipOnBudget=false] — для необязательных calls: сделать
 *                                                    локальный preflight и не отправлять
 *                                                    запрос, если он не помещается в остаток.
 * @param {boolean} [opts.repairOnJsonError=false] — один bounded repair-вызов при
 *                                                    JSON parse failure вместо полного повторного промпта.
 * @param {number}  [opts.repairMaxTokens=4096] — cap ответа JSON repair.
 * @param {string}  [opts.brand]        — наименование бренда из задачи
 *                                                    (task.brand / brand_name). Используется
 *                                                    в Redis-кэше для изоляции по бренду
 *                                                    (см. responseCache.buildKey) и для
 *                                                    последующего поиска/инвалидации кэша
 *                                                    по бренду через listKeysByBrand.
 *
 * @returns {Promise<object>}   — распарсенный JSON-ответ
 */
async function callLLM(adapter, system, prompt, opts = {}) {
  // maxTokens объявлен через let, т.к. при автодетекции обрезанного JSON
  // мы удваиваем лимит и переприсваиваем значение внутри цикла attempt.
  let { maxTokens, retryOnTruncation = true } = opts;
  const {
    retries   = 6,
    taskId    = null,
    stageName = 'unknown',
    callLabel = '',
    onLog      = null,
    log: optLog = null,  // stages передают { log } — принимаем оба варианта
    onTokens   = null,   // callback(model, tokensIn, tokensOut, costUsd) — для SSE
    temperature,
    timeoutMs,
    logprobs = false,
    cachedContent = null,
    onCacheMiss   = null,
    tokenBudget   = getConfiguredTaskTokenBudget(),
    brand         = '',
    model         = null,
    pipeline      = null,
    traceTaskId   = null,
    promptVersion = null,
    qualityScore  = null,
    triggeredRefine = false,
    responseFormat = null,
    cacheFallbackSystem = null,
    // Optional per-stage cap for truncation retries. This prevents large
    // audit JSON calls from doubling to 32K when a compact response was
    // already requested. Default preserves legacy behavior.
    maxTruncationTokens = 32000,
    allowPartialJson = false,
    skipOnBudget = false,
    repairOnJsonError = false,
    repairMaxTokens = 4096,
  } = opts;

  const logCallback = onLog || optLog;

  const log = (msg, level = 'info') => {
    if (logCallback) logCallback(msg, level);
    else console.log(`[callLLM:${stageName}] [${level}] ${msg}`);
  };

  const callFn = adapter === 'gemini'
    ? callGemini
    : adapter === 'grok'
      ? callGrok
      : adapter === 'openai'
        ? callOpenAI
        : callDeepSeek;
  // Grok/OpenAI/Gemini use the metered per-task input guard; DeepSeek keeps
  // its separate accounting path for backward compatibility.
  const providerClass = adapter === 'deepseek' ? 'deepseek' : (adapter === 'openai' ? 'openai' : 'gemini-class');
  const startedAt = new Date();
  let activeSystem = system;
  let promptSize = estimateTokens(activeSystem + prompt);

  // Budget проверяется после response-cache lookup: cache-hit не вызывает
  // провайдера и не должен блокироваться из-за уже исчерпанного бюджета.

  // Локальная копия cachedContent — может «сгореть» при cache miss.
  // Только для Gemini; Grok не поддерживает cachedContent.
  let activeCachedContent = adapter === 'gemini' ? cachedContent : null;
  let jsonRepairUsed = false;

  // ── Детерминированный response cache (Redis) ─────────────────────
  // Ключ: sha256(adapter + model + system + prompt + temperature + maxTokens).
  // При включённом LLM_RESPONSE_CACHE_ENABLED — экономит деньги на повторных
  // запусках задачи с тем же входом. Логируем cache_hit/miss через onLog.
  // Skip lookup entirely when feature flag is off (избегаем async overhead).
  const cacheResult = responseCacheModule.ENABLED
    ? await getCachedResponse({
        adapter,
        system,
        prompt,
        temperature,
        maxTokens,
        model,
        brand,
      }).catch(() => null)
    : null;

  if (cacheResult && cacheResult.cached) {
    log(`${callLabel || stageName} ✓ (cached, $0.00)`, 'success');
    if (onTokens) {
      try { onTokens(adapter, 0, 0, 0, { cacheHit: true }); } catch (_) { /* no-op */ }
    }
    if (logCallback) logCallback(`[cache_hit] ${callLabel || stageName}`, 'system');
    return cacheResult.value;
  }

  const budgetTaskId = taskId || traceTaskId;
  const budgetKey = providerClass === 'gemini-class' ? 'gemini' : adapter;

  for (let attempt = 0; attempt < retries; attempt++) {
    let budgetReservation = null;
    let apiAttemptStartedAt = null;
    let ledgerContext = null;
    try {
      if ((providerClass === 'gemini-class' || providerClass === 'openai') && Number.isFinite(tokenBudget) && budgetTaskId) {
        const remaining = getTaskBudgetRemaining(budgetTaskId, tokenBudget, adapter);
        if (skipOnBudget && remaining < promptSize) {
          const skipError = new BudgetExceededError(
            `${adapter} token budget preflight skipped ${callLabel || stageName}: ` +
            `${Math.round(remaining)}/${tokenBudget} input tokens remaining, ` +
            `estimated ${promptSize}.`
          );
          skipError.silentBudgetSkip = true;
          throw skipError;
        }
        budgetReservation = _reserveMeteredBudget(budgetTaskId, tokenBudget, promptSize, adapter);
      }
      const callOpts = { temperature, maxTokens, logprobs, responseFormat };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        callOpts.timeoutMs = timeoutMs;
      }
      if (model) {
        callOpts.model = model;
      }
      if (adapter === 'gemini' && activeCachedContent) {
        callOpts.cachedContent = activeCachedContent;
      }

      apiAttemptStartedAt = new Date();
      const result = await withProviderSlot(adapter, () => callFn(activeSystem, prompt, callOpts));
      const apiDurationMs = Math.max(0, Date.now() - apiAttemptStartedAt.getTime());
      const budgetInputTokens = getBudgetInputTokens(adapter, result, promptSize);
      if (budgetReservation) budgetReservation.commit(budgetInputTokens);
      const costModel = adapter === 'deepseek'
        ? (result.model || model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro')
        : adapter === 'openai'
          ? (result.model || model || process.env.OPENAI_MODEL || 'gpt-5')
          : adapter;
      const pricingMeta = calculateCostBreakdown(costModel, result.tokensIn, result.tokensOut, {
        cacheHit: adapter === 'deepseek' && (result.cacheHitTokens || 0) > 0,
        cacheHitTokens: result.cacheHitTokens || 0,
        cacheMissTokens: result.cacheMissTokens,
        thoughtsTokens: result.thoughtsTokens || 0,
        cachedTokens: result.cachedTokens || 0,
      });
      const costUsd = pricingMeta.totalUsd;
      const cacheHit = pricingMeta.cacheHitTokens > 0;
      ledgerContext = {
        provider: adapter,
        model: result.model || model || (adapter === 'deepseek' ? process.env.DEEPSEEK_MODEL : null) || adapter,
        pipeline: inferPipeline(stageName, pipeline),
        stageName,
        callLabel,
        taskId,
        traceTaskId,
        attempt: attempt + 1,
        durationMs: apiDurationMs,
        promptSize,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cachedTokens: result.cachedTokens || 0,
        cacheHitTokens: pricingMeta.cacheHitTokens || 0,
        cacheMissTokens: pricingMeta.cacheMissTokens || 0,
        thoughtsTokens: result.thoughtsTokens || 0,
        inputCostUsd: pricingMeta.inputCostUsd || 0,
        outputCostUsd: pricingMeta.outputCostUsd || 0,
        costUsd,
        meta: {
          cache_hit: cacheHit,
          cached_content: Boolean(activeCachedContent),
          finish_reason: result.finishReason || null,
          usage_source: 'provider_response',
          pricing_known: pricingMeta.pricingKnown !== false,
          pricing_source: pricingMeta.pricingSource || null,
        },
      };
      // Usage фиксируем ДО проверки truncation/JSON: retry после обрезанного
      // ответа тоже является реальным provider-вызовом и должен попасть в budget.
      if (!budgetReservation && (providerClass === 'gemini-class' || providerClass === 'openai') && budgetTaskId) {
        _accumulateTokens(budgetTaskId, budgetKey, budgetInputTokens);
      }

      // Если ответ обрезан по max_tokens (детекция: finish_reason=length ИЛИ незакрытый JSON) —
      // автоматически удваиваем лимит и повторяем. Главная причина
      // JSON parse ошибок в outreach emailComposer/nicheExpander.
      const isTruncated = result.finishReason === 'length' || _isJsonTruncated(result.text);
      if (isTruncated && retryOnTruncation && attempt < retries - 1) {
        recordApiRequest({ ...ledgerContext, requestStatus: 'truncated' }).catch(() => {});
        // Когда maxTokens не задан явно, реальный запрос ушёл с дефолтом
        // адаптера (напр. DeepSeek 16000), а не с 1000 — берём его как базу,
        // чтобы удвоение ПОВЫШАЛО лимит, а не понижало его.
        const adapterDefault = ADAPTER_DEFAULT_MAX_TOKENS[adapter] || 1000;
        const curMax = callOpts.maxTokens || maxTokens || adapterDefault;
        const retryCap = Math.max(curMax, Number.isFinite(Number(maxTruncationTokens))
          ? Number(maxTruncationTokens)
          : 32000);
        const newMax = Math.min(curMax * 2, retryCap);
        if (newMax <= curMax) {
          log(`${callLabel || stageName} truncated response (finishReason=${result.finishReason || 'unknown'}, maxTokens=${curMax}) — retry cap ${retryCap} достигнут`, 'warn');
          retryOnTruncation = false;
        } else {
          log(`${callLabel || stageName} truncated response (finishReason=${result.finishReason || 'unknown'}, maxTokens=${curMax}), retry ${attempt + 1} with maxTokens=${newMax}`, 'warn');
          callOpts.maxTokens = newMax;
          maxTokens = newMax;
          continue;
        }
      }
      let parsed;
      let partialJson = false;
      let jsonRepaired = false;
      try {
        parsed = normalizeKeys(parseJSON(result.text));
      } catch (parseError) {
        if (repairOnJsonError && !jsonRepairUsed) {
          jsonRepairUsed = true;
          const rawResponse = String(result.text || '');
          const boundedResponse = rawResponse.length > 16000
            ? `${rawResponse.slice(0, 12000)}\\n[… response compacted …]\\n${rawResponse.slice(-3500)}`
            : rawResponse;
          const repairPrompt = [
            'Return ONLY valid JSON. Repair the malformed model response below.',
            'Preserve every recoverable field and value; do not invent or summarize data.',
            'Do not wrap the JSON in Markdown fences or add commentary.',
            `Original task: ${callLabel || stageName}`,
            'MALFORMED_RESPONSE:',
            boundedResponse,
          ].join('\\n\\n');
          log(`${callLabel || stageName}: JSON parse failed — bounded repair (maxTokens=${repairMaxTokens})`, 'warn');
          try {
            parsed = await callLLM(
              adapter,
              cacheFallbackSystem || system || 'Return valid JSON only.',
              repairPrompt,
              {
                ...opts,
                retries: 1,
                retryOnTruncation: false,
                repairOnJsonError: false,
                allowPartialJson: false,
                maxTokens: repairMaxTokens,
                maxTruncationTokens: repairMaxTokens,
                cachedContent: null,
                cacheFallbackSystem: null,
                onCacheMiss: null,
                callLabel: `${callLabel || stageName} JSON repair`,
              }
            );
            jsonRepaired = true;
          } catch (repairError) {
            parseError.isDeterministic = true;
            parseError.message = `JSON parse failed after bounded repair: ${repairError.message}`;
            throw parseError;
          }
        } else {
          if (!allowPartialJson) throw parseError;
          const salvaged = salvageQualityJson(result.text, parseError);
          if (!salvaged) throw parseError;
          parsed = normalizeKeys(salvaged);
          partialJson = true;
          log(`${callLabel || stageName}: partial quality JSON salvaged; score fields preserved`, 'warn');
        }
      }

      const cacheNote   = cacheHit ? ` | cache_hit: ${result.cacheHitTokens}` : '';
      const cachedNote  = (adapter === 'gemini' && activeCachedContent) ? ' | gemini_cached' : '';
      // Подсветим thoughts/cached в логе только когда они ненулевые — иначе шум.
      const thoughtsNote = (result.thoughtsTokens || 0) > 0 ? ` | thoughts: ${result.thoughtsTokens}` : '';
      const partialJsonNote = partialJson ? ' | partial_json' : '';
      const repairNote = jsonRepaired ? ' | repaired_json' : '';
      const cachedTokNote = (result.cachedTokens   || 0) > 0 ? ` | cached_in: ${result.cachedTokens}` : '';
      // Показываем фактически использованную модель — для удобства сравнения
      // качества разных Gemini-моделей в одной задаче.
      const modelTag = result.model ? ` (${result.model})` : '';
      const callDurationMs = Math.max(0, Date.now() - startedAt.getTime());
      log(
        `${callLabel || stageName}${modelTag} ✓ — ${result.tokensIn}↑ ${result.tokensOut}↓ токенов${thoughtsNote}${cachedTokNote}${cacheNote}${cachedNote}${partialJsonNote}${repairNote} | $${costUsd.toFixed(6)} | ${callDurationMs}ms`,
        'success'
      );

      recordApiRequest({
        ...ledgerContext,
        requestStatus: partialJson ? 'partial_json' : (jsonRepaired ? 'repaired_json' : 'success'),
      }).catch(() => {});

      // Публикуем SSE-событие tokens — фронтенд реактивно обновляет счётчики
      if (onTokens) {
        try {
          onTokens(adapter, result.tokensIn, result.tokensOut, costUsd);
        } catch (_) { /* не прерываем пайплайн */ }
      }

      // Сохраняем метрики асинхронно, не блокируем пайплайн
      persistStageCall({
        taskId, traceTaskId, pipeline, stageName, callLabel,
        model:      result.model,
        promptSize,
        tokensIn:   result.tokensIn,
        tokensOut:  result.tokensOut,
        costUsd,
        pricingMeta,
        resultJson: pricingMeta.cacheHitTokens > 0 || pricingMeta.cacheMissTokens > 0
          ? Object.assign({}, parsed, {
            _billing: {
              model: pricingMeta.modelTier,
              pricing_mode: pricingMeta.pricingMode,
              cache_hit_tokens: pricingMeta.cacheHitTokens,
              cache_miss_tokens: pricingMeta.cacheMissTokens,
              input_cost_usd: pricingMeta.inputCostUsd,
              output_cost_usd: pricingMeta.outputCostUsd,
            },
          })
          : parsed,
        startedAt,
        promptVersion,
        qualityScore,
        triggeredRefine,
      }).catch(() => {}); // ошибки уже логируются внутри

      if (result.logprobs) {
        Object.defineProperty(parsed, '__logprobs', {
          value: result.logprobs,
          enumerable: false,
          writable: true,
        });
      }

      // Записываем в response-cache (асинхронно, не блокируем).
      if (cacheResult && cacheResult.key) {
        setCachedResponse(cacheResult.key, parsed).catch(() => {});
      }

      return parsed;

    } catch (err) {
      if (budgetReservation) budgetReservation.release();
      if (ledgerContext) {
        recordApiRequest({
          ...ledgerContext,
          requestStatus: 'invalid_response',
          httpStatus: err.status || null,
          errorCode: err.code || err.name || 'invalid_response',
          errorMessage: err.message,
        }).catch(() => {});
      } else if (apiAttemptStartedAt) {
        recordApiRequest({
          provider: adapter,
          model: model || (adapter === 'deepseek' ? process.env.DEEPSEEK_MODEL : null) || adapter,
          pipeline: inferPipeline(stageName, pipeline),
          stageName,
          callLabel,
          taskId,
          traceTaskId,
          requestStatus: err.isCacheMiss ? 'cache_miss' : 'failed',
          httpStatus: err.status || null,
          attempt: attempt + 1,
          durationMs: Math.max(0, Date.now() - apiAttemptStartedAt.getTime()),
          promptSize,
          errorCode: err.code || err.name || 'provider_error',
          errorMessage: err.message,
          meta: { retryable: !(err.isDeterministic || err.isGeoBlock) },
        }).catch(() => {});
      }
      // ── Cache miss / expiry: однократная повторная попытка без кэша ──
      if (err.isCacheMiss && activeCachedContent) {
        log(
          `Gemini cachedContent expired/invalid (${activeCachedContent}). ` +
          `Повторяем без кэша...`,
          'warn'
        );
        activeCachedContent = null;
        if (cacheFallbackSystem) {
          activeSystem = cacheFallbackSystem;
          promptSize = estimateTokens(activeSystem + prompt);
          log(`${callLabel || stageName}: cache fallback uses bounded AKB (${activeSystem.length} chars)`, 'info');
        }
        if (typeof onCacheMiss === 'function') {
          try { onCacheMiss(); } catch (_) { /* no-op */ }
        }
        // Не считаем это попыткой — даём adapter ещё один шанс.
        continue;
      }

      const isRateLimit  = err.status === 429 || err.status === 503;
      const isNetworkErr = err.code === 'ECONNABORTED' || err.code === 'ECONNRESET'
                        || err.message.includes('timeout') || err.message.includes('Network');

      // Детерминированные ошибки — повторные попытки бессмысленны
      const isDeterministic = err.message === 'Input text too long'
                           || err.message.includes('API_KEY is not set')
                           || err.isDeterministic  // гео-блокировка (все прокси исчерпаны), budget guard, cache miss и т.д.
                           || err.isGeoBlock        // маркер из gemini.adapter
                           || err.message?.includes('User location is not supported'); // geo-block fallback по тексту

      if (err.silentBudgetSkip) {
        throw err;
      }

      if (isDeterministic || attempt === retries - 1) {
        const failedDurationMs = Math.max(0, Date.now() - startedAt.getTime());
        log(`${callLabel || stageName} FAILED после ${attempt + 1} попыток: ${err.message} | ${failedDurationMs}ms`, 'error');
        throw err;
      }

      // Экспоненциальный бэкофф: 429/сеть — длиннее, прочие — короче
      const base    = (isRateLimit || isNetworkErr) ? 4000 : 2000;
      const delay   = Math.pow(2, attempt) * base + Math.floor(Math.random() * 2000);
      const delayS  = (delay / 1000).toFixed(1);

      log(
        `Попытка ${attempt + 1}/${retries} — ${err.message.substring(0, 120)}. Retry через ${delayS}s...`,
        'warn'
      );

      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = {
  callLLM,
  BudgetExceededError,
  resetTaskBudget,
  getTaskBudgetSpent,
  getTaskBudgetRemaining,
  getConfiguredTaskTokenBudget,
  getBudgetInputTokens,
  DEFAULT_GEMINI_TASK_TOKEN_BUDGET,
  parseJSON,
  _isJsonTruncated,
  salvageQualityJson,
};
