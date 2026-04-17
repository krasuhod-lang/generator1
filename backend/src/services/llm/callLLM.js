'use strict';

const { callDeepSeek } = require('./deepseek.adapter');
const { callGemini }   = require('./gemini.adapter');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const db               = require('../../config/db');
const { calcCost }     = require('../metrics/priceCalculator');

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
  }

  if (parsed.tfidf_and_spam_report && !parsed.tf_idf_and_spam_report)
    parsed.tf_idf_and_spam_report = parsed.tfidf_and_spam_report;
  if (parsed.eeatcriteriabreakdown && !parsed.eeat_criteria_breakdown)
    parsed.eeat_criteria_breakdown = parsed.eeatcriteriabreakdown;

  return parsed;
}

/**
 * Пытается распарсить JSON из сырого текста LLM.
 * Применяет autoCloseJSON при обрыве.
 */
function parseJSON(text) {
  // Убираем Markdown-обёртку если есть
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();

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
async function persistStageCall({ taskId, stageName, callLabel, model, promptSize, tokensIn, tokensOut, costUsd, resultJson, startedAt }) {
  if (!taskId) return;

  const completedAt = new Date();

  try {
    // Вставляем запись о вызове
    await db.query(
      `INSERT INTO task_stages
         (task_id, stage_name, call_label, status, model_used, prompt_size,
          tokens_in, tokens_out, cost_usd, result_json, started_at, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [taskId, stageName, callLabel, model, promptSize,
       tokensIn, tokensOut, costUsd, resultJson ? JSON.stringify(resultJson) : null,
       startedAt, completedAt]
    );

    // Обновляем агрегированные метрики
    const isDeepSeek = model.startsWith('deepseek');
    const metricsCol = isDeepSeek
      ? { colIn: 'deepseek_tokens_in', colOut: 'deepseek_tokens_out', colCost: 'deepseek_cost_usd' }
      : { colIn: 'gemini_tokens_in',   colOut: 'gemini_tokens_out',   colCost: 'gemini_cost_usd'   };

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
 * @param {'deepseek'|'gemini'} adapter   — какой адаптер использовать
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
 *
 * @returns {Promise<object>}   — распарсенный JSON-ответ
 */
async function callLLM(adapter, system, prompt, opts = {}) {
  const {
    retries   = 6,
    taskId    = null,
    stageName = 'unknown',
    callLabel = '',
    onLog      = null,
    log: optLog = null,  // stages передают { log } — принимаем оба варианта
    onTokens   = null,   // callback(model, tokensIn, tokensOut, costUsd) — для SSE
    temperature,
    maxTokens,
  } = opts;

  const logCallback = onLog || optLog;

  const log = (msg, level = 'info') => {
    if (logCallback) logCallback(msg, level);
    else console.log(`[callLLM:${stageName}] [${level}] ${msg}`);
  };

  const callFn    = adapter === 'gemini' ? callGemini : callDeepSeek;
  const startedAt = new Date();
  const promptSize = (system + prompt).length;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result    = await callFn(system, prompt, { temperature, maxTokens });
      const costUsd   = calcCost(adapter, result.tokensIn, result.tokensOut);
      const parsed    = normalizeKeys(parseJSON(result.text));

      log(
        `${callLabel || stageName} ✓ — ${result.tokensIn}↑ ${result.tokensOut}↓ токенов | $${costUsd.toFixed(6)}`,
        'success'
      );

      // Публикуем SSE-событие tokens — фронтенд реактивно обновляет счётчики
      if (onTokens) {
        try {
          onTokens(adapter, result.tokensIn, result.tokensOut, costUsd);
        } catch (_) { /* не прерываем пайплайн */ }
      }

      // Сохраняем метрики асинхронно, не блокируем пайплайн
      persistStageCall({
        taskId, stageName, callLabel,
        model:      result.model,
        promptSize,
        tokensIn:   result.tokensIn,
        tokensOut:  result.tokensOut,
        costUsd,
        resultJson: parsed,
        startedAt,
      }).catch(() => {}); // ошибки уже логируются внутри

      return parsed;

    } catch (err) {
      const isRateLimit  = err.status === 429 || err.status === 503;
      const isNetworkErr = err.code === 'ECONNABORTED' || err.code === 'ECONNRESET'
                        || err.message.includes('timeout') || err.message.includes('Network');

      // Детерминированные ошибки — повторные попытки бессмысленны
      const isDeterministic = err.message === 'Input text too long'
                           || err.message.includes('API_KEY is not set')
                           || err.isDeterministic  // гео-блокировка (все прокси исчерпаны)
                           || err.isGeoBlock;       // маркер из gemini.adapter

      if (isDeterministic || attempt === retries - 1) {
        log(`${callLabel || stageName} FAILED после ${attempt + 1} попыток: ${err.message}`, 'error');
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

module.exports = { callLLM };
