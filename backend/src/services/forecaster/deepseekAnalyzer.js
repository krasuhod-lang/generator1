'use strict';

/**
 * forecaster/deepseekAnalyzer.js — аналитические LLM-вызовы прогнозатора.
 * Все обращения идут через analyticLLM.js: приоритетно DeepSeek (модель из
 * env DEEPSEEK_MODEL, по умолчанию deepseek-v4-pro), Gemini — фолбэк.
 *
 * Промпт собирается из JSON-метрик (не из сырого CSV) — модель не получает
 * клиентских данных, только агрегаты. Модель пишет 4-7 буллетов выводов и
 * 2-3 рекомендации (на русском).
 *
 * Гейт:
 *   • если ни DEEPSEEK_API_KEY, ни GEMINI_API_KEY не заданы, или вызов
 *     упал — возвращаем { verdict: 'skipped', reason } и пайплайн
 *     продолжает работу.
 */

const { callAnalyticLLM, hasAnalyticLLMKey, analyticCallCost } = require('./analyticLLM');
const { getForecasterConfig } = require('./config');

const SYSTEM_PROMPT = [
  'Роль: Senior SEO-аналитик и Growth-стратег. Ты пишешь «Аналитические выводы»',
  'по SEO-прогнозу — раздел, который увидит КЛИЕНТ. Он должен быть детальным,',
  'предметным и без воды: за него не должно быть стыдно.',
  '',
  'Принцип: формулы уже посчитали числа — ты их ИНТЕРПРЕТИРУЕШЬ, а не',
  'пересчитываешь и не выдумываешь. Все цифры бери строго из входных данных.',
  'Если задан target_url — учти профиль сайта (коммерческий/услуги/контентный).',
  '',
  'ВАЖНО — РЕАЛИСТИЧНОСТЬ (ключевое требование):',
  '• ×100 и ×10 за год практически недостижимы без качественного скачка домена,',
  '  редизайна, бренд-PR-волны или смены ниши. Не обещай таких чисел и «гарантий».',
  '• Тяжёлая ниша в KEYSSO_SIGNALS (высокая median_competition, большая доля фраз',
  '  вне топ-50, отрицательный momentum) — честно скажи об этом и сдержанно',
  '  скорректируй ожидания.',
  '• positive momentum и доля в топ-10 ≥ 30 % — оптимистичный сценарий допустим,',
  '  но соблюдай капы из realism-блока. Объясни, какие фразы/группы дают основной',
  '  вклад и почему cap (если сработал) оправдан.',
  '',
  'РАЗБЕРИ ПОДРОБНО, опираясь на данные:',
  '1) СПРОС: сезонные паттерны (пик/спад), тренд, аномальные зоны падения — что',
  '   могло вызвать и на что смотреть.',
  '2) ТРАФИК: реалистичность прогноза ТОП-3/5/10 и единой модели (unified),',
  '   драйверы роста, где сработали капы и почему.',
  '3) ЛИДЫ/ЗАЯВКИ: как объём трафика конвертируется в заявки (по leads_summary,',
  '   CR и intent). Никакой выручки/маржи/ROI — только трафик, показы, заявки.',
  '4) ФАКТОРЫ РАНЖИРОВАНИЯ: пройдись по чек-листу и отметь, что критично',
  '   закрыть для роста в этой нише. Учитывай, что у поисковиков они разные',
  '   (Google: релевантность/контент, E-E-A-T, ссылки, Page Experience;',
  '   Яндекс: поведенческие, коммерческие, региональность, текстовые факторы).',
  '   Чек-лист: Релевантность и покрытие интента; Глубина и полнота контента;',
  '   Кликабельность сниппета (CTR); Запросы у входа в топ (3–20);',
  '   Каннибализация; Деградация страниц; E-E-A-T; Микроразметка Schema.org;',
  '   Ссылочный профиль; Мобильный UX/Core Web Vitals; Видимость в нейровыдаче',
  '   (AI Overviews/SGE); Контентные дыры (непокрытый спрос).',
  '5) GIST / ОХВАТ СЕМАНТИКИ: по semantic_distribution и opportunities оцени, где',
  '   узкие места охвата (какие группы фраз не в топах) и что закрывает разрыв.',
  '6) ПОДВОДНЫЕ КАМНИ: честно перечисли риски (сезонный спад, тяжёлая',
  '   конкуренция, шлак в ядре, качество входных данных, каннибализация, долгий',
  '   ramp-up, зависимость от ссылок/поведенческих).',
  '7) ПЕРЕЧЕНЬ РАБОТ: если переданы works_plan (точки усиления/кластеры/действия',
  '   экспертов) — свяжи выводы с этими работами: что именно они закрывают и',
  '   какой эффект дадут. Продублируй ключевые работы в рекомендациях.',
  '',
  'Ответ — на русском, в формате JSON (все текстовые поля — предметные, без воды):',
  '{',
  '  "summary": "2–3 предложения — главный вывод по прогнозу",',
  '  "demand_analysis": "абзац: спрос, сезонность, тренд, аномалии",',
  '  "traffic_analysis": "абзац: реалистичность прогноза трафика и драйверы",',
  '  "leads_analysis": "абзац: заявки/лиды (объём, CR, intent)",',
  '  "bullets": ["ключевые наблюдения, 3–6 пунктов"],',
  '  "ranking_factors": [',
  '    { "factor": "название фактора", "status": "ok|gap|critical", "note": "что и почему" }',
  '  ],',
  '  "pitfalls": ["подводные камни/риски, 2–5 пунктов"],',
  '  "works_alignment": "как перечень работ закрывает пробелы (или пусто, если работ нет)",',
  '  "recommendations": ["конкретные шаги, 3–6 пунктов; приоритет по влияние×усилие"]',
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

// ─────────────────────────────────────────────────────────────────────
// Компактный контекст «перечня работ» прогнозатора для LLM: точки усиления
// (opportunityAnalyzer), план работ по кластерам и ранжированные действия
// (DSPy-эксперты). Используется и в «Аналитических выводах», и в «Ванге».
function _worksPlanContext({ opportunities, expertReports, unifiedForecast, sovForecast, leadsSummary, semanticDistribution } = {}) {
  const uf = (unifiedForecast && unifiedForecast.verdict === 'ok') ? unifiedForecast : null;
  const opp = (opportunities && opportunities.verdict === 'ok') ? opportunities : null;
  const exp = expertReports || {};
  const niche   = (exp.niche_strategist   && exp.niche_strategist.verdict   === 'ok') ? exp.niche_strategist   : null;
  const hunter  = (exp.opportunity_hunter && exp.opportunity_hunter.verdict === 'ok') ? exp.opportunity_hunter : null;
  const planner = (exp.cluster_planner    && exp.cluster_planner.verdict    === 'ok') ? exp.cluster_planner    : null;

  return {
    unified_forecast: uf ? {
      horizon: uf.horizon,
      current_traffic: uf.summary?.current_traffic,
      annual: uf.summary?.annual,
      at_horizon: uf.summary?.at_horizon,
      leads_annual: uf.summary?.leads_annual,
      explain_summary: uf.explain?.summary || null,
    } : null,
    sov_realistic: sovForecast?.scenarios?.realistic ? {
      sov_target: sovForecast.scenarios.realistic.sov_target,
      p_target:   sovForecast.scenarios.realistic.p_target,
    } : null,
    leads_summary: leadsSummary ? {
      conversion_rate_pct:    leadsSummary.conversion_rate_pct,
      conversion_rate_source: leadsSummary.conversion_rate_source,
      intent:                 leadsSummary.intent,
      current_leads_per_month: leadsSummary.current_leads_per_month,
      current_leads_annual:   leadsSummary.current_leads_annual,
      top3_annual:            leadsSummary.top3_annual,
      top5_annual:            leadsSummary.top5_annual,
      top10_annual:           leadsSummary.top10_annual,
      unified_leads_annual:   leadsSummary.unified_leads_annual,
    } : null,
    semantic_coverage: Array.isArray(semanticDistribution)
      ? semanticDistribution.slice(0, 12).map((d) => ({
          bucket: d.bucket || d.label || null,
          share_now: d.share_now ?? d.current_share ?? null,
          share_target: d.share_target ?? d.target_share ?? null,
        }))
      : null,
    // Перечни работ прогнозатора ↓
    opportunities_top: opp ? (opp.opportunities || []).slice(0, 12).map((o) => ({
      phrase: o.phrase,
      demand_monthly: o.demand_monthly,
      current_position: o.current_position,
      drop_pct: o.drop_pct,
      composite_score: o.composite_score,
      expected_traffic_top3: o.scenarios?.high?.top3?.expected_traffic_monthly ?? null,
      expected_leads_top3:   o.scenarios?.high?.top3?.expected_leads_monthly ?? null,
    })) : null,
    niche_strategy: niche?.payload ? {
      niche_label:      niche.payload.niche_label,
      niche_difficulty: niche.payload.niche_difficulty,
      strategy_lane:    niche.payload.strategy_lane,
      primary_levers:   niche.payload.primary_levers,
      expected_horizon_months: niche.payload.expected_horizon_months,
    } : null,
    ranked_actions: hunter?.payload ? (hunter.payload.ranked_actions || hunter.payload || [])
      .slice(0, 10).map((a) => ({
        phrase: a.phrase, action_type: a.action_type, why: a.why,
        effort_estimate_h: a.effort_estimate_h, confidence: a.confidence,
      })) : null,
    cluster_plan: planner?.payload ? (Array.isArray(planner.payload) ? planner.payload : [])
      .slice(0, 8).map((c) => ({
        cluster_centroid: c.cluster_centroid,
        content_units_target: c.content_units_target,
        page_types: c.page_types,
        expected_coverage_gain: c.expected_coverage_gain,
        phases: Array.isArray(c.phases) ? c.phases.map((p) => ({ month: p.month, milestone: p.milestone })) : null,
      })) : null,
  };
}

function _buildUserPrompt(payload) {
  const {
    monthlySeries, anomalies, forecast, trend, trafficEstimate,
    sourceInfo, targetUrl, junkSummary, keyssoSignals, mainQuery, region,
    opportunities, expertReports, unifiedForecast, sovForecast, leadsSummary,
    semanticDistribution,
  } = payload;
  // Сжимаем ряды: для DeepSeek хватит сводных полей + последние 18 точек.
  const tail = (monthlySeries || []).slice(-18);
  const ctx = {
    target_url: targetUrl || null,
    main_query: mainQuery || null,
    region: region || null,
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
    // Единая модель, лиды, охват семантики и перечни работ прогнозатора.
    works_plan: _worksPlanContext({
      opportunities, expertReports, unifiedForecast, sovForecast, leadsSummary, semanticDistribution,
    }),
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
  if (!hasAnalyticLLMKey()) {
    return { verdict: 'skipped', reason: 'no_api_key' };
  }

  const userPrompt = _buildUserPrompt(payload);

  try {
    const t0 = Date.now();
    const { resp, provider } = await callAnalyticLLM(SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens:   cfg.maxTokens,
      timeoutMs:   cfg.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cachedTokens || resp.cacheHitTokens || 0;
    const cost = analyticCallCost(provider, resp);
    const parsed = _safeParseJson(resp.text || '');

    const _strList = (v) => (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'string' ? x.trim() : x))
      .filter((x) => x && (typeof x !== 'string' || x.length));
    const _rankingFactors = (Array.isArray(parsed?.ranking_factors) ? parsed.ranking_factors : [])
      .filter((f) => f && typeof f === 'object' && (f.factor || f.note))
      .slice(0, 14)
      .map((f) => ({
        factor: String(f.factor || '').slice(0, 120),
        status: ['ok', 'gap', 'critical'].includes(String(f.status)) ? String(f.status) : 'gap',
        note:   String(f.note || '').slice(0, 400),
      }));

    return {
      verdict: 'ok',
      summary:        parsed?.summary || (resp.text || '').slice(0, 600),
      demand_analysis:  parsed?.demand_analysis  ? String(parsed.demand_analysis).slice(0, 2000)  : '',
      traffic_analysis: parsed?.traffic_analysis ? String(parsed.traffic_analysis).slice(0, 2000) : '',
      leads_analysis:   parsed?.leads_analysis   ? String(parsed.leads_analysis).slice(0, 2000)   : '',
      bullets:        _strList(parsed?.bullets),
      ranking_factors: _rankingFactors,
      pitfalls:       _strList(parsed?.pitfalls),
      works_alignment: parsed?.works_alignment ? String(parsed.works_alignment).slice(0, 2000) : '',
      recommendations: _strList(parsed?.recommendations),
      raw_text:       parsed ? null : (resp.text || ''),
      tokens_in:      tIn,
      tokens_out:     tOut,
      cached_tokens:  cached,
      cost_usd:       Math.round(cost * 1e6) / 1e6,
      model:          resp.model || provider,
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
 * Обогащает шлак-классификатор LLM-комментариями (verdict + reason).
 * Никогда не бросает. Если ни один API-ключ не задан — возвращает
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
  if (!hasAnalyticLLMKey()) return { verdict: 'skipped', reason: 'no_api_key' };
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
    const { resp, provider } = await callAnalyticLLM(JUNK_SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens:   cfg.maxTokens,
      timeoutMs:   cfg.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cost = analyticCallCost(provider, resp);
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
      model:      resp.model || provider,
    };
  } catch (err) {
    return {
      verdict: 'error',
      reason: (err && err.message) ? err.message : String(err),
    };
  }
}

module.exports = { runDeepSeekAnalysis, runDeepSeekJunkRefine, runNicheStrategist, runOpportunityHunter, runClusterPlanner, runVangaSummary };

// ─────────────────────────────────────────────────────────────────────
// «Ванга» — лаконичное бизнес-саммари прогноза для владельца бизнеса.
//
// Отдельный короткий Gemini-вызов: человеческим языком «что меня ждёт»
// по итогам математического прогноза. Cost control: жёсткий лимит объёма
// вывода в системном промпте (символы/слова из config.vanga) плюс
// серверная обрезка до maxChars. Ошибки Gemini (429/500/timeout) НИКОГДА
// не прерывают пайплайн: возвращаем { verdict:'skipped'|'error', reason },
// фронт показывает плейсхолдер «Аналитика ИИ временно недоступна…».

function _vangaSystemPrompt(cfg) {
  return [
    'Ты — «Ванга»: бизнес-аналитик, который человеческим языком говорит владельцу',
    'бизнеса, что его ждёт по итогам SEO-прогноза. Пиши просто, по-деловому,',
    'без SEO-жаргона; цифры округляй до читабельных («≈12 тыс. визитов»,',
    '«≈180 заявок в год»). Это КЛИЕНТСКИЙ текст — он должен быть тёплым,',
    'уверенным и честным, чтобы за него не было стыдно.',
    '',
    `ОГРАНИЧЕНИЕ ОБЪЁМА: максимум ${cfg.maxChars} символов и максимум`,
    `${cfg.maxWords} слов. Никаких вступлений («Итак…»), списков и markdown —`,
    'только связный текст в 2–3 абзаца.',
    '',
    'Структура (без заголовков, связным текстом):',
    '1) Что реально вырастет — трафик и заявки/лиды, к какому сроку и почему',
    '   (сошлись на спрос и сезонность). Не обещай ×10 и «гарантий».',
    '2) За счёт чего: если переданы works_plan (точки усиления, план по',
    '   кластерам, действия) — назови 1–2 ключевых направления работ, которые',
    '   дадут этот рост.',
    '3) Главный риск или условие успеха (сезонность, конкуренция, качество',
    '   входных данных, длительный разгон) — честно и без нагнетания.',
    '',
    'Ответ — ТОЛЬКО текст саммари, без JSON и пояснений.',
  ].join('\n');
}

/**
 * Лаконичное бизнес-саммари («Ванга»). Никогда не бросает.
 * @returns {{verdict:'ok'|'skipped'|'error', text?:string, reason?:string}}
 */
async function runVangaSummary({ unifiedForecast, sovForecast, trafficEstimate, monthlySummary, targetUrl, mainQuery, leadsSummary, opportunities, expertReports, semanticDistribution } = {}) {
  const cfg = getForecasterConfig().vanga;
  if (!cfg || !cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!hasAnalyticLLMKey()) return { verdict: 'skipped', reason: 'no_api_key' };

  const uf = (unifiedForecast && unifiedForecast.verdict === 'ok') ? unifiedForecast : null;
  const ctx = {
    target_url: targetUrl || null,
    main_query: mainQuery || null,
    monthly_summary: monthlySummary || null,
    unified: uf ? {
      horizon: uf.horizon,
      current_traffic: uf.summary?.current_traffic,
      annual: uf.summary?.annual,
      at_horizon: uf.summary?.at_horizon,
      leads_annual: uf.summary?.leads_annual,
      sov_start: uf.params?.sov_start,
      sov_max: uf.params?.sov_max,
      explain_summary: uf.explain?.summary || null,
    } : null,
    sov_realistic: sovForecast?.scenarios?.realistic ? {
      sov_target: sovForecast.scenarios.realistic.sov_target,
      p_target: sovForecast.scenarios.realistic.p_target,
    } : null,
    traffic_realism: trafficEstimate?.realism || null,
    // Перечни работ прогнозатора + лиды — чтобы «Ванга» назвала, ЗА СЧЁТ ЧЕГО рост.
    works_plan: _worksPlanContext({
      opportunities, expertReports, unifiedForecast, sovForecast, leadsSummary, semanticDistribution,
    }),
  };
  const userPrompt = [
    'Данные прогноза ниже. Напиши бизнес-саммари по правилам из системного промпта.',
    '```json',
    JSON.stringify(ctx, null, 2),
    '```',
  ].join('\n');

  try {
    const t0 = Date.now();
    const { resp, provider } = await callAnalyticLLM(_vangaSystemPrompt(cfg), userPrompt, {
      temperature: cfg.temperature,
      maxTokens:   cfg.maxTokens,
      timeoutMs:   cfg.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cachedTokens || resp.cacheHitTokens || 0;
    const cost = analyticCallCost(provider, resp);
    // Серверная страховка cost-control: обрезаем текст до maxChars,
    // даже если модель «разлилась мыслью по древу».
    let text = String(resp.text || '').replace(/```[a-z]*\s*|```/gi, '').trim();
    const truncated = text.length > cfg.maxChars;
    if (truncated) text = text.slice(0, cfg.maxChars).replace(/\s+\S*$/, '') + '…';
    if (!text) return { verdict: 'error', reason: 'empty_response' };
    return {
      verdict: 'ok',
      text,
      truncated,
      tokens_in: tIn,
      tokens_out: tOut,
      cached_tokens: cached,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: resp.model || provider,
      duration_ms: ms,
    };
  } catch (err) {
    // 429/500/timeout и любые прочие сбои — graceful skip, не прерываем пайплайн.
    return { verdict: 'skipped', reason: (err && err.message) ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────
// DSPy-style эксперты («Signature → strict JSON I/O»).
//
// Каждый эксперт — отдельный вызов с фокусированной задачей и строго
// типизированной JSON-схемой ответа. Это эквивалент dspy.Signature на
// чистом prompt-engineering: модель видит только relevant context,
// возвращает только ожидаемые поля; pipeline валидирует.
//
// Параметры — getForecasterConfig().advanced.experts.<name>.
// Все три эксперта graceful: при отсутствии ключа или ошибке возвращают
// { verdict: 'skipped'|'error', reason } и пайплайн продолжает работу.
//
// 1) NicheStrategist  — портрет ниши и стратегическая рамка
//    Вход: keysso_aggregate, junk_summary, traffic_estimate.realism,
//          monthly_summary, target_url
//    Выход: { niche_label, niche_difficulty (1..5), strategy_lane,
//             primary_levers[], expected_horizon_months, decision_matrix[] }
//
// 2) OpportunityHunter — ранжированные действия по top-N opportunities
//    Вход: top-N opportunities из opportunityAnalyzer (с сценариями)
//    Выход: { ranked_actions[]:{ phrase, action_type, why,
//             expected_traffic_lift_monthly, expected_leads_lift_monthly,
//             effort_estimate_h, confidence: low|mid|high, risks[] } }
//
// 3) ClusterPlanner — план работ по top-N кластерам (с log-returns)
//    Вход: clusters + calibration; контент-юниты = logReturnsUnitsFor
//    Выход: { plans[]:{ cluster_centroid, content_units_target,
//             page_types[], internal_links_min, expected_coverage_gain,
//             phases:[{month, milestone, deliverables[] }] } }

const NICHE_STRATEGIST_SYSTEM = [
  'Ты — стратег-аналитик уровня senior, специализация: продвижение в Яндексе/Google в коммерческом RU-сегменте.',
  'На вход получишь сжатый портрет ниши: main_query и sample_phrases (реальные фразы ядра —',
  'ГЛАВНЫЙ и ЕДИНСТВЕННЫЙ надёжный источник для определения бизнес-ниши), а также объём ядра,',
  'долю исключённого шлака, реализм-факторы трафик-модели и агрегаты keys.so (это только',
  'вспомогательные метрики конкуренции/динамики — по ним НЕЛЬЗЯ определять нишу). Твоя задача —',
  'определить рамки стратегии:',
  '1) niche_label (1-3 слова, строго на основе main_query/sample_phrases, например:',
  '   "пластиковые окна Москва"; если sample_phrases пуст — используй main_query; никогда не',
  '   выдумывай нишу из общих цифр конкуренции),',
  '2) niche_difficulty (1=лёгкая, 5=очень тяжёлая) — обоснованно по конкуренции, ',
  '   доле фраз в топ-10, momentum,',
  '3) strategy_lane: один из ["volume_play","precision_play","authority_play","reanimation_play"]',
  '   где volume_play — массовое покрытие, precision_play — точечные просадки,',
  '   authority_play — рост домена через E-E-A-T контент, reanimation_play — восстановление просевших страниц,',
  '4) primary_levers (2-4 главных рычага), каждый — строка <= 80 символов,',
  '5) expected_horizon_months — за сколько мес strategy_lane даст видимый эффект (3..18),',
  '6) decision_matrix — массив из 3-5 пар { if_condition, then_action } с конкретными триггерами',
  '   (например, if "phrases_in_top10_pct < 15%" then "сосредоточиться на 5-7 hub-страницах").',
  '',
  'СТРОГО не считай и не упоминай выручку, маржу, ROI, "доход". Только объёмы трафика, заявок,',
  'позиции, доли фраз. Это требование продукта.',
  '',
  'Формат ответа — JSON:',
  '{',
  '  "niche_label": "…",',
  '  "niche_difficulty": 1|2|3|4|5,',
  '  "strategy_lane": "volume_play|precision_play|authority_play|reanimation_play",',
  '  "primary_levers": ["…","…"],',
  '  "expected_horizon_months": 3..18,',
  '  "decision_matrix": [{"if_condition":"…","then_action":"…"}],',
  '  "rationale": "1-2 предложения, почему именно эта strategy_lane"',
  '}',
  'Никакого markdown вне JSON.',
].join('\n');

const OPPORTUNITY_HUNTER_SYSTEM = [
  'Ты — старший SEO-практик. На вход получишь top-N "точек усиления" (opportunities) с',
  'detailed-метриками: текущая позиция, конкуренция, drop_pct, и сценарии (effort low/mid/high ×',
  'target позиция top3/5/10 — каждый с expected_traffic_monthly и expected_leads_monthly).',
  'Числа уже посчитаны нашей моделью (Verhulst-логистика + power-law CTR), твоя задача —',
  'выбрать для каждой фразы РЕАЛИСТИЧНЫЙ план:',
  '1) action_type: один из ["fix_existing_page","build_new_landing","expand_cluster","internal_links_boost","tech_seo_fix","content_refresh"],',
  '2) why — одно предложение, ≤ 160 символов, простыми словами для клиента,',
  '3) expected_traffic_lift_monthly — возьми из подходящего сценария (не выдумывай),',
  '4) expected_leads_lift_monthly — то же,',
  '5) effort_estimate_h — оценка часов работы (1..120). На "build_new_landing" обычно 16-40 ч,',
  '   на "fix_existing_page" — 4-12 ч, на "tech_seo_fix" — 2-8 ч.',
  '6) confidence: low|mid|high — насколько уверен в реалистичности этого числа.',
  '   high только если: drop_pct < 0.5 ИЛИ current_position ≤ 20 ИЛИ low competition.',
  '7) risks — 1-2 риска короткими фразами (если есть).',
  '',
  'Сохраняй порядок фраз как во входе. НИКАКОЙ выручки/маржи/ROI — только трафик и заявки.',
  '',
  'Формат — JSON-массив той же длины:',
  '[{ "phrase":"…", "action_type":"…", "why":"…",',
  '   "expected_traffic_lift_monthly":<int>, "expected_leads_lift_monthly":<int>,',
  '   "effort_estimate_h":<int>, "confidence":"low|mid|high",',
  '   "risks":["…"] }, …]',
  'Никакого markdown вне JSON.',
].join('\n');

const CLUSTER_PLANNER_SYSTEM = [
  'Ты — старший контент-стратег. На вход получишь top-N кластеров (групп семантически близких',
  'фраз) с агрегированными метриками: total_demand_monthly, total_drop_volume, best_traffic_monthly,',
  'best_leads_monthly, member_phrases (примеры).',
  'Дополнительно — calibration с alpha/scale (log-returns закон отдачи: gain = α·ln(1 + units/scale)).',
  '',
  'Для каждого кластера верни план:',
  '1) content_units_target — сколько новых/обновлённых страниц-юнитов нужно за 12 мес (1..30).',
  '   Рекомендации: тяжёлый кластер с total_demand_monthly > 5000 → 10-20 юнитов;',
  '   средний (1000..5000) → 5-10; маленький (< 1000) → 2-4.',
  '2) page_types — массив типов из ["hub_pillar","category","commercial_landing","how_to_guide","comparison","case_study"],',
  '   обычно 1-3 разных типа на кластер,',
  '3) internal_links_min — минимум входящих ссылок на hub_pillar (5..30),',
  '4) expected_coverage_gain — оценка прироста доли покрываемых фраз кластера 0..1,',
  '5) phases — массив из 3-4 фаз: { month: 1..12, milestone: "…", deliverables: ["…"] }.',
  '   month — НОМЕР месяца проекта (1=старт). Первая фаза обычно month=1-2 (структура+pillar),',
  '   средняя — month=3-6 (контент), последняя — month=9-12 (оптимизация по данным).',
  '',
  'Сохраняй порядок кластеров. НИКАКОЙ выручки/маржи. Только трафик/заявки/позиции/контент.',
  '',
  'Формат — JSON-массив той же длины:',
  '[{ "cluster_centroid":"…", "content_units_target":<int>,',
  '   "page_types":["…"], "internal_links_min":<int>,',
  '   "expected_coverage_gain":<float 0..1>,',
  '   "phases":[{ "month":<int>, "milestone":"…", "deliverables":["…"] }] }, …]',
  'Никакого markdown вне JSON.',
].join('\n');

/** Общая обёртка для DSPy-style экспертов: единая обработка skip/error. */
async function _runExpert({ expertKey, system, userPrompt, parser }) {
  const cfg = getForecasterConfig().advanced;
  if (!cfg || !cfg.enabled) return { verdict: 'skipped', reason: 'advanced_disabled' };
  const ex = cfg.experts[expertKey];
  if (!ex || !ex.enabled) return { verdict: 'skipped', reason: 'expert_disabled' };
  if (!hasAnalyticLLMKey()) return { verdict: 'skipped', reason: 'no_api_key' };

  try {
    const t0 = Date.now();
    const { resp, provider } = await callAnalyticLLM(system, userPrompt, {
      temperature: ex.temperature,
      maxTokens:   ex.maxTokens,
      timeoutMs:   ex.timeoutMs,
    });
    const ms = Date.now() - t0;
    const tIn  = resp.tokensIn  || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cachedTokens || resp.cacheHitTokens || 0;
    const cost = analyticCallCost(provider, resp);
    const parsed = parser(resp.text || '');
    if (parsed == null) {
      return {
        verdict: 'error',
        reason:  'invalid_json',
        raw_text: (resp.text || '').slice(0, 400),
        tokens_in: tIn, tokens_out: tOut, cost_usd: Math.round(cost * 1e6) / 1e6,
        duration_ms: ms,
      };
    }
    return {
      verdict: 'ok',
      payload: parsed,
      tokens_in: tIn, tokens_out: tOut, cached_tokens: cached,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      duration_ms: ms,
      model: resp.model || provider,
    };
  } catch (err) {
    return { verdict: 'error', reason: (err && err.message) ? err.message : String(err) };
  }
}

/** NicheStrategist. */
async function runNicheStrategist({ keyssoAggregate, junkSummary, trafficRealism, monthlySummary, targetUrl, mainQuery, samplePhrases } = {}) {
  const ctx = {
    target_url: targetUrl || null,
    main_query: mainQuery || null,
    // Реальные фразы ядра (top по частотности) — основной сигнал для
    // определения ниши. Без них модель угадывала niche_label вслепую
    // по агрегатам (competition/momentum), что часто давало неверную нишу.
    sample_phrases: Array.isArray(samplePhrases) ? samplePhrases.slice(0, 40) : [],
    monthly_summary: monthlySummary || null,
    keysso_aggregate: keyssoAggregate || null,
    traffic_realism:  trafficRealism  || null,
    junk_summary: junkSummary ? {
      junk_pct: junkSummary.summary?.junk_pct,
      excluded_count: junkSummary.summary?.excluded_count,
      by_reason: junkSummary.counts?.by_reason,
    } : null,
  };
  const userPrompt = [
    'Сводный портрет ниши — верни JSON по описанной схеме.',
    '```json',
    JSON.stringify(ctx, null, 2),
    '```',
  ].join('\n');
  return _runExpert({
    expertKey: 'nicheStrategist',
    system: NICHE_STRATEGIST_SYSTEM,
    userPrompt,
    parser: _safeParseJson,
  });
}

/** OpportunityHunter. */
async function runOpportunityHunter({ opportunities, calibration, targetUrl } = {}) {
  const cfg = getForecasterConfig().advanced.experts;
  const list = Array.isArray(opportunities) ? opportunities.slice(0, cfg.hunterTopN) : [];
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_opportunities' };
  // Сжимаем структуру для промпта (убираем тяжёлые поля).
  const compact = list.map((o) => ({
    phrase: o.phrase,
    demand_monthly: o.demand_monthly,
    baseline_monthly: o.baseline_monthly,
    current_monthly: o.current_monthly,
    drop_pct: o.drop_pct,
    current_position: o.current_position,
    competition: o.competition,
    momentum_delta: o.momentum_delta,
    composite_score: o.composite_score,
    scenarios: {
      low_top10:  o.scenarios?.low?.top10,
      mid_top5:   o.scenarios?.mid?.top5,
      high_top3:  o.scenarios?.high?.top3,
    },
  }));
  const userPrompt = [
    'Top-N opportunities — выбери для каждой РЕАЛИСТИЧНЫЙ план.',
    `target_url: ${targetUrl ? JSON.stringify(targetUrl) : 'null'}`,
    `calibration: ${JSON.stringify(calibration || {})}`,
    '```json',
    JSON.stringify(compact, null, 2),
    '```',
  ].join('\n');
  return _runExpert({
    expertKey: 'opportunityHunter',
    system: OPPORTUNITY_HUNTER_SYSTEM,
    userPrompt,
    parser: _safeParseJsonArray,
  });
}

/** ClusterPlanner. */
async function runClusterPlanner({ clusters, calibration, targetUrl } = {}) {
  const cfg = getForecasterConfig().advanced.experts;
  const cfgLogR = getForecasterConfig().advanced.logReturns;
  const list = Array.isArray(clusters) ? clusters.slice(0, cfg.plannerTopN) : [];
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_clusters' };
  const compact = list.map((c) => ({
    cluster_centroid: c.centroid,
    members_count:    c.members_count,
    total_demand_monthly: c.total_demand_monthly,
    total_drop_volume:    c.total_drop_volume,
    best_traffic_monthly: c.best_traffic_monthly,
    best_leads_monthly:   c.best_leads_monthly,
    member_phrases:       c.member_phrases,
  }));
  const userPrompt = [
    'Top-N кластеров — построй план работ.',
    `target_url: ${targetUrl ? JSON.stringify(targetUrl) : 'null'}`,
    `log_returns_calibration: { alpha: ${cfgLogR.alphaDefault}, scale: ${cfgLogR.scaleDefault} }`,
    `calibration: ${JSON.stringify(calibration || {})}`,
    '```json',
    JSON.stringify(compact, null, 2),
    '```',
  ].join('\n');
  return _runExpert({
    expertKey: 'clusterPlanner',
    system: CLUSTER_PLANNER_SYSTEM,
    userPrompt,
    parser: _safeParseJsonArray,
  });
}
