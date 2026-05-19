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
  'Если задан target_url — это URL продвигаемого сайта; учти его профиль',
  '(коммерческий/контентный/услуги) при рекомендациях.',
  '',
  'ВАЖНО — РЕАЛИСТИЧНОСТЬ ПРОГНОЗА (ключевое требование):',
  '• ×100 и ×10 за год — практически не достижимы без качественного скачка домена,',
  '  редизайна, бренд-PR-волны или резкого изменения ниши. Не обещай таких чисел.',
  '• Если в KEYSSO_SIGNALS видна тяжёлая ниша (median_competition высокая,',
  '  большая доля фраз вне топ-50, отрицательный momentum) — явно скажи об этом',
  '  и сдержанно скорректируй ожидания клиента.',
  '• Если KEYSSO_SIGNALS показывает positive momentum и долю в топ-10 ≥ 30 %,',
  '  оптимистичный сценарий допустим, но всё равно соблюдай капы из realism-блока.',
  '• Конкретно объясни, какие фразы / группы фраз дают основной вклад в прогноз',
  '  и почему cap (если он сработал) был оправдан.',
  '',
  'Твоя задача — кратко, по-деловому, без воды:',
  '1) Указать ключевые сезонные паттерны (когда пик/спад).',
  '2) Прокомментировать аномальные зоны (если они есть): что могло вызвать,',
  '   на что обратить внимание клиенту.',
  '3) Дать оценку реалистичности прогноза (с учётом качества входных данных,',
  '   realism-факторов и KEYSSO_SIGNALS — там реальные позиции и конкуренция).',
  '4) Предложить 2–3 практических шага для роста (контент-план, расширение',
  '   ядра, лендинг-страницы, перелинковка). По возможности — со ссылкой на',
  '   target_url, если он задан.',
  '',
  'Ответ — на русском, в формате JSON:',
  '{',
  '  "summary": "1–2 предложения общего вывода",',
  '  "bullets": ["…", "…", "…"],',
  '  "recommendations": ["…", "…"]',
  '}',
  'Никакого markdown вне JSON. Никаких пояснений до или после.',
].join('\n');

const JUNK_SYSTEM_PROMPT = [
  'Ты — старший SEO-аналитик. На вход — список кандидатов в «шлак-запросы»',
  'из ядра. По каждому уже размечены формальные причины (too_broad, info_intent,',
  'dead, foreign_brand, duplicate, too_short). Твоя задача:',
  '1) Подтвердить или скорректировать вердикт (drop / keep / unsure).',
  '2) Кратко (одно предложение) объяснить почему — простым языком клиенту,',
  '   со ссылкой на target_url, если он задан и его профиль помогает решению.',
  '3) Не выдумывать новых фраз. Сохранить порядок и фразу точно как в input.',
  '',
  'Формат ответа — строго JSON-массив той же длины и в том же порядке:',
  '[',
  '  { "phrase": "<точно как на входе>", "verdict": "drop|keep|unsure",',
  '    "reason": "<одно предложение, ≤180 символов>" },',
  '  …',
  ']',
  'Никакого markdown вне JSON.',
].join('\n');

function _buildUserPrompt(payload) {
  const {
    monthlySeries, anomalies, forecast, trend, trafficEstimate,
    sourceInfo, targetUrl, junkSummary, keyssoSignals,
  } = payload;
  // Сжимаем ряды: для DeepSeek хватит сводных полей + последние 18 точек.
  const tail = (monthlySeries || []).slice(-18);
  const ctx = {
    target_url: targetUrl || null,
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
      realism: trafficEstimate.realism,
      keysso_calibration: trafficEstimate.keysso_calibration || null,
      top3:  { annual: trafficEstimate.top3?.annual,  uplift_x: trafficEstimate.top3?.uplift_x,
               uplift_capped: trafficEstimate.top3?.uplift_capped },
      top5:  { annual: trafficEstimate.top5?.annual,  uplift_x: trafficEstimate.top5?.uplift_x,
               uplift_capped: trafficEstimate.top5?.uplift_capped },
      top10: { annual: trafficEstimate.top10?.annual, uplift_x: trafficEstimate.top10?.uplift_x,
               uplift_capped: trafficEstimate.top10?.uplift_capped },
    } : null,
    keysso_signals: (keyssoSignals && keyssoSignals.verdict === 'ok') ? {
      domain:     keyssoSignals.domain,
      region:     keyssoSignals.region,
      engine:     keyssoSignals.engine,
      requested:  keyssoSignals.requested,
      matched:    keyssoSignals.matched,
      aggregate:  keyssoSignals.aggregate,
    } : (keyssoSignals ? { verdict: keyssoSignals.verdict, reason: keyssoSignals.reason || null } : null),
    junk_summary: junkSummary ? {
      junk_pct:   junkSummary.summary?.junk_pct,
      warn:       junkSummary.summary?.warn,
      excluded_count: junkSummary.summary?.excluded_count,
      excluded_total_demand: junkSummary.summary?.excluded_total_demand,
      by_reason:  junkSummary.counts?.by_reason,
      top_examples: junkSummary.summary?.top_examples,
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

function _safeParseJsonArray(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

/**
 * Обогащает шлак-классификатор DeepSeek-комментариями (verdict + reason).
 * Никогда не бросает. Если DEEPSEEK_API_KEY отсутствует — возвращает
 * { verdict: 'skipped', reason }; пайплайн всё равно сохранит детерминированную
 * разметку.
 *
 * @param {Object} args
 * @param {Array} args.candidates   — array of { phrase, total, reasons, severity }
 * @param {string} [args.targetUrl]
 */
async function runDeepSeekJunkRefine({ candidates, targetUrl } = {}) {
  const cfg = getForecasterConfig().deepseek;
  if (!cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_candidates' };

  const compact = list.map((c) => ({
    phrase:   String(c.phrase || '').slice(0, 200),
    total:    Number(c.total || 0),
    reasons:  Array.isArray(c.reasons) ? c.reasons.slice(0, 6) : [],
    severity: c.severity || 'low',
  }));
  const userPrompt = [
    'Ниже массив кандидатов в «шлак-запросы» из ядра.',
    `target_url: ${targetUrl ? JSON.stringify(targetUrl) : 'null'}`,
    'Верни JSON-массив той же длины и в том же порядке (см. схему в системном сообщении).',
    '',
    '```json',
    JSON.stringify(compact, null, 2),
    '```',
  ].join('\n');

  try {
    const t0 = Date.now();
    const resp = await callDeepSeek(JUNK_SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens:   cfg.maxTokens,
      timeoutMs:   cfg.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cacheHitTokens || 0;
    const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: cached });
    const parsed = _safeParseJsonArray(resp.text || '');
    if (!parsed) {
      return { verdict: 'error', reason: 'invalid_json', tokens_in: tIn, tokens_out: tOut, cost_usd: cost };
    }
    // нормализуем: индексируем по нормализованной phrase для устойчивости
    const map = new Map();
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue;
      const phrase = String(it.phrase || '').trim();
      if (!phrase) continue;
      const verdict = ['drop', 'keep', 'unsure'].includes(it.verdict) ? it.verdict : 'unsure';
      const reason  = String(it.reason || '').slice(0, 220);
      map.set(phrase.toLowerCase(), { verdict, reason });
    }
    return {
      verdict: 'ok',
      items_count: parsed.length,
      annotations: Object.fromEntries(
        Array.from(map.entries()).map(([k, v]) => [k, v]),
      ),
      tokens_in:  tIn,
      tokens_out: tOut,
      cost_usd:   Math.round(cost * 1e6) / 1e6,
      duration_ms: ms,
      model:      resp.model || 'deepseek',
    };
  } catch (err) {
    return {
      verdict: 'error',
      reason: (err && err.message) ? err.message : String(err),
    };
  }
}

module.exports = { runDeepSeekAnalysis, runDeepSeekJunkRefine };
