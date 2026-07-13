'use strict';

/**
 * forecaster/forecastReport.js — AI-аналитика прогноза (полный отчёт).
 *
 * Принцип: формулы считают, AI объясняет. LLM никогда не пересчитывает
 * и не корректирует числа — она работает исключительно с уже рассчитанными
 * данными задачи как с входным контекстом и генерирует структурированный
 * аналитический отчёт: не пересказ цифр, а их интерпретацию с экспертными
 * выводами и конкретными рекомендациями.
 *
 * generateForecastReport(task) — вход: строка forecaster_tasks (или объект
 * с теми же полями). Выход (никогда не бросает):
 *   { verdict:'ok', report:{...схема ниже...}, model, tokens_in, tokens_out,
 *     cost_usd, duration_ms }
 *   { verdict:'skipped'|'error', reason }
 *
 * Хранение: forecaster_tasks.ai_report (JSONB, mig 112). Генерируется один
 * раз при финализации задачи (fire-and-forget). Перегенерация — по кнопке
 * пользователя (POST /api/forecaster/:id/regenerate-report).
 */

const { callGemini } = require('../llm/gemini.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const { getForecasterConfig } = require('./config');

const SYSTEM_PROMPT = [
  'Роль: Senior SEO Strategist & Growth Analyst.',
  'Задача: на основе предоставленных расчётных данных прогнозатора SEO-трафика',
  'написать экспертный аналитический отчёт.',
  '',
  'Правила:',
  '- Все цифры в отчёте — строго из входных данных, не придумывать.',
  '- Не пересказывать таблицы — интерпретировать их смысл.',
  '- Язык: деловой, без воды, конкретные выводы. Ответ на русском.',
  '- Структура ответа — строго JSON (см. схему ниже).',
  '- Запрещено: галлюцинации о ценах, конкурентах без данных, общие фразы.',
  '- Никаких выручки/маржи/ROI — только трафик, показы, позиции, заявки.',
  '',
  'Схема ответа JSON:',
  '{',
  '  "executive_summary": "string (3-4 предложения — суть прогноза и главный вывод)",',
  '  "growth_narrative": "string (абзац — почему такая динамика роста, что её определяет)",',
  '  "semantic_gap_analysis": "string (анализ распределения семантики: где узкие места)",',
  '  "top_opportunities": [',
  '    { "title": "string", "description": "string", "impact": "high|medium|low" }',
  '  ],',
  '  "risks": [',
  '    { "title": "string", "description": "string" }',
  '  ],',
  '  "action_plan": [',
  '    { "month_range": "string (напр. M1-M2)", "action": "string", "expected_effect": "string" }',
  '  ],',
  '  "confidence_comment": "string (оценка достоверности прогноза)"',
  '}',
  'Никакого markdown вне JSON. Никаких пояснений до или после.',
].join('\n');

// Сборка компактного контекста из уже рассчитанных полей задачи.
// Только агрегаты — никаких сырых выгрузок клиента.
function _buildContext(task) {
  const t = task || {};
  const options = t.options || {};
  const unified = (t.unified_forecast && t.unified_forecast.verdict === 'ok')
    ? t.unified_forecast : null;
  const te = t.traffic_estimate || null;
  const keysso = (t.keysso_signals && t.keysso_signals.verdict === 'ok')
    ? t.keysso_signals.aggregate : null;
  const monthly = (t.monthly_series && t.monthly_series.monthly) || [];

  return {
    domain: t.target_url || options.target_url || null,
    niche:  options.main_query || null,
    region: options.region || null,
    monthly_forecast: t.forecast ? {
      method:       t.forecast.method,
      horizon:      t.forecast.horizon,
      annual_total: t.forecast.annual_total,
      points:       t.forecast.points,
    } : null,
    trafficEstimate: te ? {
      current_traffic_input:  te.current_traffic_input,
      implied_ctr_now:        te.implied_ctr_now,
      implied_ctr_now_source: te.implied_ctr_now_source,
      realism:                te.realism,
      top3:  { annual: te.top3?.annual,  uplift_x: te.top3?.uplift_x,  uplift_capped: te.top3?.uplift_capped },
      top5:  { annual: te.top5?.annual,  uplift_x: te.top5?.uplift_x,  uplift_capped: te.top5?.uplift_capped },
      top10: { annual: te.top10?.annual, uplift_x: te.top10?.uplift_x, uplift_capped: te.top10?.uplift_capped },
    } : null,
    semanticDistribution: Array.isArray(t.semantic_distribution)
      ? t.semantic_distribution
      : null,
    unifiedForecast: unified ? {
      horizon:  unified.horizon,
      params:   unified.params ? {
        sov_start: unified.params.sov_start,
        sov_max:   unified.params.sov_max,
        r:         unified.params.r,
        k:         unified.params.k,
        t0:        unified.params.t0,
      } : null,
      summary:  unified.summary,
      explain_summary: unified.explain?.summary || null,
    } : null,
    currentMetrics: {
      traffic:        Number(options.current_traffic_per_month) || te?.current_traffic_input || 0,
      positions_avg:  keysso?.avg_current_position ?? null,
      top10_coverage: keysso?.phrases_in_top10_pct ?? null,
    },
    competitorBenchmarks: keysso ? {
      median_competition:   keysso.median_competition ?? null,
      momentum:             keysso.momentum ?? null,
      phrases_in_top30_pct: keysso.phrases_in_top30_pct ?? null,
      phrases_off_top50_pct: keysso.phrases_off_top50_pct ?? null,
    } : null,
    history_months: monthly.length,
  };
}

// Вырезаем первый сбалансированный JSON-объект из ответа модели
// (модель может обернуть в ```json … ``` или дописать хвост).
function _extractJson(text) {
  const cleaned = String(text || '').replace(/```[a-z]*\s*|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('В ответе модели не найден JSON-объект');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

const _IMPACTS = new Set(['high', 'medium', 'low']);

function _str(v, max = 4000) {
  const s = String(v == null ? '' : v).trim();
  return s.slice(0, max);
}

// Валидация + нормализация ответа под схему ТЗ. Бросает при пустом отчёте.
function _normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Ответ модели — не объект');
  const report = {
    executive_summary:     _str(raw.executive_summary),
    growth_narrative:      _str(raw.growth_narrative),
    semantic_gap_analysis: _str(raw.semantic_gap_analysis),
    top_opportunities: (Array.isArray(raw.top_opportunities) ? raw.top_opportunities : [])
      .filter((o) => o && typeof o === 'object')
      .slice(0, 10)
      .map((o) => ({
        title:       _str(o.title, 200),
        description: _str(o.description, 1000),
        impact:      _IMPACTS.has(String(o.impact)) ? String(o.impact) : 'medium',
      }))
      .filter((o) => o.title || o.description),
    risks: (Array.isArray(raw.risks) ? raw.risks : [])
      .filter((r) => r && typeof r === 'object')
      .slice(0, 10)
      .map((r) => ({
        title:       _str(r.title, 200),
        description: _str(r.description, 1000),
      }))
      .filter((r) => r.title || r.description),
    action_plan: (Array.isArray(raw.action_plan) ? raw.action_plan : [])
      .filter((a) => a && typeof a === 'object')
      .slice(0, 12)
      .map((a) => ({
        month_range:     _str(a.month_range, 40),
        action:          _str(a.action, 1000),
        expected_effect: _str(a.expected_effect, 500),
      }))
      .filter((a) => a.action),
    confidence_comment: _str(raw.confidence_comment, 1500),
  };
  if (!report.executive_summary) throw new Error('Пустой executive_summary в ответе модели');
  return report;
}

/**
 * Генерация AI-отчёта по уже рассчитанной задаче. Никогда не бросает.
 * @param {Object} task — строка forecaster_tasks (расчётные JSONB-поля).
 * @param {string} [llmProvider] — task.llm_provider; сейчас поддержан
 *   только Gemini (как и весь forecaster, см. deepseekAnalyzer.js).
 */
async function generateForecastReport(task, llmProvider = null) {
  const cfg = getForecasterConfig().report;
  if (!cfg || !cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.GEMINI_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };

  const ctx = _buildContext(task);
  const userPrompt = [
    'Расчётные данные прогнозатора ниже. Напиши аналитический отчёт строго по схеме из системного промпта.',
    '```json',
    JSON.stringify(ctx),
    '```',
  ].join('\n');

  const attempts = Math.max(1, Number(cfg.maxAttempts) || 2);
  let totalIn = 0, totalOut = 0, totalCost = 0, model = null;
  let lastErr = null;
  const t0 = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await callGemini(SYSTEM_PROMPT, userPrompt, {
        temperature: cfg.temperature,
        maxTokens:   cfg.maxTokens,
        timeoutMs:   cfg.timeoutMs,
      });
      totalIn  += resp.tokensIn  || 0;
      totalOut += resp.tokensOut || 0;
      totalCost += calcCost('gemini', resp.tokensIn || 0, resp.tokensOut || 0, {
        cachedTokens: resp.cachedTokens || 0, thoughtsTokens: resp.thoughtsTokens || 0,
      });
      model = resp.model || 'gemini';
      const report = _normalizeReport(_extractJson(resp.text));
      return {
        verdict: 'ok',
        report,
        model,
        attempts: attempt,
        tokens_in:  totalIn,
        tokens_out: totalOut,
        cost_usd:   Math.round(totalCost * 1e6) / 1e6,
        duration_ms: Date.now() - t0,
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
      // Self-correction: сетевые ошибки и непарсящийся JSON — повторный вызов.
    }
  }
  return {
    verdict: 'error',
    reason: (lastErr && lastErr.message) ? lastErr.message : String(lastErr),
    tokens_in:  totalIn,
    tokens_out: totalOut,
    cost_usd:   Math.round(totalCost * 1e6) / 1e6,
  };
}

module.exports = { generateForecastReport, _buildContext, _extractJson, _normalizeReport, SYSTEM_PROMPT };
