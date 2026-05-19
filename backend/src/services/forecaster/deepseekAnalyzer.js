'use strict';

/**
 * forecaster/deepseekAnalyzer.js — обращение к DeepSeek для генерации
 * аналитических выводов по числовым результатам прогноза.
 *
 * Промпт собирается из JSON-метрик (не из сырого CSV) — DeepSeek не получает
 * клиентских данных, только агрегаты. Модель пишет 4-7 буллетов выводов и
 * 2-3 рекомендации (на русском).
 *
 * Гейт:
 *   • если DEEPSEEK_API_KEY не задан, или вызов упал — возвращаем
 *     { verdict: 'skipped', reason } и пайплайн продолжает работу.
 */

const { callDeepSeek } = require('../llm/deepseek.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const { getForecasterConfig } = require('./config');

const SYSTEM_PROMPT = [
  'Ты — старший SEO-аналитик и data-аналитик.',
  'На вход получаешь сводку по сезонному спросу и прогнозу: помесячные данные,',
  'тренд, найденные зоны падения и оценки трафика при выходе в ТОП-3/5/10.',
  '',
  'Твоя задача — кратко, по-деловому, без воды:',
  '1) Указать ключевые сезонные паттерны (когда пик/спад).',
  '2) Прокомментировать аномальные зоны (если они есть): что могло вызвать,',
  '   на что обратить внимание клиенту.',
  '3) Дать оценку реалистичности прогноза (с учётом качества входных данных).',
  '4) Предложить 2–3 практических шага для роста (контент-план, расширение',
  '   ядра, лендинг-страницы, перелинковка).',
  '',
  'Ответ — на русском, в формате JSON:',
  '{',
  '  "summary": "1–2 предложения общего вывода",',
  '  "bullets": ["…", "…", "…"],',
  '  "recommendations": ["…", "…"]',
  '}',
  'Никакого markdown вне JSON. Никаких пояснений до или после.',
].join('\n');

function _buildUserPrompt(payload) {
  const {
    monthlySeries, anomalies, forecast, trend, trafficEstimate,
    sourceInfo,
  } = payload;
  // Сжимаем ряды: для DeepSeek хватит сводных полей + последние 18 точек.
  const tail = (monthlySeries || []).slice(-18);
  const ctx = {
    source: {
      filename: sourceInfo?.filename || '',
      rows_count: sourceInfo?.rowsCount || 0,
      months_count: (monthlySeries || []).length,
    },
    historical_monthly_tail: tail,
    trend: trend ? {
      direction: trend.direction,
      slope_per_month: Math.round((trend.slope_per_month || 0) * 100) / 100,
      r_squared: trend.r_squared,
    } : null,
    anomalies: anomalies ? {
      count: anomalies.summary?.count,
      max_severity: anomalies.summary?.max_severity,
      max_drop_pct: anomalies.summary?.max_drop_pct,
      zones: (anomalies.drops || []).map((z) => ({
        from: z.from, to: z.to, length_months: z.length_months,
        severity: z.severity, drop_pct: z.drop_pct,
      })),
    } : null,
    forecast: forecast ? {
      method: forecast.method,
      horizon: forecast.horizon,
      annual_total: forecast.annual_total,
      residual_std: forecast.residual_std,
      points: forecast.points,
    } : null,
    traffic_estimate: trafficEstimate ? {
      current_traffic_input: trafficEstimate.current_traffic_input,
      implied_ctr_now: trafficEstimate.implied_ctr_now,
      implied_ctr_now_source: trafficEstimate.implied_ctr_now_source,
      top3:  { annual: trafficEstimate.top3?.annual,  uplift_x: trafficEstimate.top3?.uplift_x },
      top5:  { annual: trafficEstimate.top5?.annual,  uplift_x: trafficEstimate.top5?.uplift_x },
      top10: { annual: trafficEstimate.top10?.annual, uplift_x: trafficEstimate.top10?.uplift_x },
    } : null,
  };
  return [
    'Ниже — все числовые данные по задаче. Верни JSON по описанной схеме.',
    '',
    '```json',
    JSON.stringify(ctx, null, 2),
    '```',
  ].join('\n');
}

function _safeParseJson(text) {
  if (!text) return null;
  // вырезаем ```json … ``` если модель не послушалась
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // если нет фигурных скобок — ищем первый {...} блок
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * Запускает аналитический вызов. Никогда не бросает — всегда возвращает
 * объект с verdict in {'ok','skipped','error'}.
 */
async function runDeepSeekAnalysis(payload) {
  const cfg = getForecasterConfig().deepseek;
  if (!cfg.enabled) {
    return { verdict: 'skipped', reason: 'feature_disabled' };
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    return { verdict: 'skipped', reason: 'no_api_key' };
  }

  const userPrompt = _buildUserPrompt(payload);

  try {
    const t0 = Date.now();
    const resp = await callDeepSeek(SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens:   cfg.maxTokens,
      timeoutMs:   cfg.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cacheHitTokens || 0;
    const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: cached });
    const parsed = _safeParseJson(resp.text || '');

    return {
      verdict: 'ok',
      summary:        parsed?.summary || (resp.text || '').slice(0, 600),
      bullets:        Array.isArray(parsed?.bullets) ? parsed.bullets : [],
      recommendations: Array.isArray(parsed?.recommendations) ? parsed.recommendations : [],
      raw_text:       parsed ? null : (resp.text || ''),
      tokens_in:      tIn,
      tokens_out:     tOut,
      cached_tokens:  cached,
      cost_usd:       Math.round(cost * 1e6) / 1e6,
      model:          resp.model || 'deepseek',
      duration_ms:    ms,
    };
  } catch (err) {
    return {
      verdict: 'error',
      reason: (err && err.message) ? err.message : String(err),
    };
  }
}

module.exports = { runDeepSeekAnalysis };
