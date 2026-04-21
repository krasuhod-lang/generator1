'use strict';

/**
 * preStage0.js — стратегический разведочный слой ("Pre-Stage 0").
 *
 * Запускается ОДИН РАЗ на задачу, после Audience-&-Niche-Analysis и
 * до Stage 0. Параллельно выполняет три промта из `prompts/strategy/`
 * (Niche Landscape Analyzer / Market Opportunity Finder /
 * Search Demand Mapper) через DeepSeek и собирает компактный
 * `STRATEGY_CONTEXT`, который затем пробрасывается в Stage 0/1/2.
 *
 * Все вызовы — DeepSeek (как требует ТЗ: вся аналитика через DeepSeek,
 * Gemini оставляем только для генерации текстовых блоков).
 *
 * Структура результата:
 *   {
 *     niche_map:             { ... } | null,  // от 01
 *     opportunity_portfolio: { ... } | null,  // от 02
 *     demand_map:            { ... } | null,  // от 03
 *     generated_at:          ISO-timestamp,
 *     errors:                [ { call, message } ]
 *   }
 *
 * Если все три вызова провалились — возвращает null, и пайплайн
 * продолжается без стратегического контекста (graceful degradation).
 */

const { callLLM }          = require('../llm/callLLM');
const { STRATEGY_PROMPTS, isStrategyAvailable } = require('../../prompts/strategyPrompts');
const db                   = require('../../config/db');

// Размер инпут-секции, чтобы не раздувать prompt и не упереться в лимит DeepSeek.
const COMPETITOR_SNIPPET_LIMIT = 2500;
const TARGET_PAGE_SNIPPET_LIMIT = 3000;
const AUDIENCE_BLOCK_LIMIT      = 4000;

/**
 * Собирает короткий, но информативный блок входных данных, общий для всех 3 промтов.
 * Включает: ТЗ, целевую страницу (если был анализ), краткий аудиторный анализ.
 */
function buildSharedInputContext(task, { targetPageAnalysis, audienceNicheAnalysis } = {}) {
  const lines = [];

  lines.push('===== ВХОДНЫЕ ДАННЫЕ ИЗ ТЗ =====');
  lines.push(`- Ниша / целевая услуга: ${task.input_target_service || '[не указано]'}`);
  lines.push(`- Гео: ${task.input_region || '[не указано]'}`);
  lines.push(`- Язык: ${task.input_language || 'ru'}`);
  lines.push(`- Тип бизнеса: ${task.input_business_type || '[не указано]'}`);
  lines.push(`- Тип сайта: ${task.input_site_type || '[не указано]'}`);
  lines.push(`- Целевая аудитория: ${task.input_target_audience || '[не указано]'}`);
  lines.push(`- Приоритетная бизнес-цель: ${task.input_business_goal || '[не указано]'}`);
  lines.push(`- Монетизация: ${task.input_monetization || '[не указано]'}`);
  lines.push(`- Особенности ниши: ${task.input_niche_features || '[не указано]'}`);
  lines.push(`- Ограничения проекта: ${task.input_project_limits || '[не указано]'}`);
  lines.push(`- Приоритетные типы страниц: ${task.input_page_priorities || '[не указано]'}`);
  lines.push(`- Бренд: ${task.input_brand_name || '[не указано]'}`);
  if (task.input_brand_facts)  lines.push(`- Факты о бренде: ${String(task.input_brand_facts).substring(0, 1500)}`);
  if (task.input_competitor_urls) lines.push(`- Конкуренты (URL): ${String(task.input_competitor_urls).substring(0, 1000)}`);
  if (task.input_target_url)   lines.push(`- URL целевой страницы: ${task.input_target_url}`);

  if (targetPageAnalysis) {
    lines.push('');
    lines.push('===== АНАЛИЗ ЦЕЛЕВОЙ СТРАНИЦЫ =====');
    if (targetPageAnalysis.service_details) lines.push(`Услуги: ${String(targetPageAnalysis.service_details).substring(0, TARGET_PAGE_SNIPPET_LIMIT)}`);
    if (targetPageAnalysis.brand_facts)     lines.push(`Бренд: ${String(targetPageAnalysis.brand_facts).substring(0, 1500)}`);
    if (targetPageAnalysis.proof_assets)    lines.push(`Доказательства: ${String(targetPageAnalysis.proof_assets).substring(0, 1500)}`);
    if (Array.isArray(targetPageAnalysis.niche_features) && targetPageAnalysis.niche_features.length) {
      lines.push(`Особенности ниши (с сайта): ${targetPageAnalysis.niche_features.join(' • ')}`);
    }
  }

  if (audienceNicheAnalysis) {
    lines.push('');
    lines.push('===== АУДИТОРИЯ И НИША (предобработка) =====');
    const dump = JSON.stringify(audienceNicheAnalysis).substring(0, AUDIENCE_BLOCK_LIMIT);
    lines.push(dump);
  }

  return lines.join('\n');
}

/**
 * JSON-схема выхода для каждого из трёх стратегических промтов.
 * Они изначально пишут free-form по 28+ фазам — мы фиксируем на выходе
 * структурированный JSON, чтобы пайплайн мог им оперировать.
 */
const NICHE_MAP_SCHEMA = `OUTPUT FORMAT — STRICT JSON ONLY (никакого markdown, никаких комментариев вне JSON).
Сожми результат всех 28 фаз в следующую структуру (массивы могут быть пустыми, но ключи — обязательны):
{
  "scope_definition": "string",                          // фаза 1-2: что входит в нишу, уровень абстракции
  "subniches":           [{"name":"string","focus":"string","priority":"high|medium|low"}],
  "jobs_to_be_done":     [{"jtbd":"string","audience":"string","trigger":"string"}],
  "audience_layers":     [{"segment":"string","stakeholder":"string","pains":["string"]}],
  "buyer_journey":       [{"stage":"awareness|consideration|decision|retention","content_needs":["string"]}],
  "intent_architecture": [{"intent":"string","type":"informational|commercial|navigational|transactional","share":"high|medium|low"}],
  "search_demand_shape": "head-heavy|long-tail-heavy|balanced|micro-niche",
  "serp_reality":        [{"query_class":"string","dominant_format":"string","difficulty":"low|medium|high","required_eeat":"low|medium|high"}],
  "competitor_archetypes": [{"archetype":"string","strength":"string","weakness":"string"}],
  "content_depth_barrier": "low|medium|high",
  "eeat_requirements":   [{"signal":"string","why":"string","priority":"must|nice"}],
  "regulatory_risk":     "low|medium|high",
  "entity_complexity":   {"density":"low|medium|high","key_entities":["string"]},
  "format_landscape":    [{"format":"string","fit":"strong|weak"}],
  "ai_search_relevance": {"zero_click_risk":"low|medium|high","ai_overview_risk":"low|medium|high","notes":"string"},
  "monetization_fit":    [{"model":"string","fit":"strong|weak"}],
  "wedge_opportunities": [{"wedge":"string","why_works":"string","entry_difficulty":"low|medium|high"}],
  "white_space":         [{"zone":"string","reason":"string"}],
  "overhyped_zones":     [{"zone":"string","why_skip":"string"}],
  "barriers_to_entry":   ["string"],
  "scoring": {"opportunity":1-100,"feasibility":1-100,"strategic_fit":1-100},
  "strategic_observations": ["string"],
  "recommended_launch_model": "broad-first|wedge-first|geo-first|authority-first|commercial-first|hybrid",
  "go_decision": "go|cautious-go|phased-go|no-go",
  "phased_roadmap": {"3m":["string"],"6m":["string"],"12m":["string"],"24m":["string"]}
}
RULES:
- Не возвращай markdown, не оборачивай в \`\`\`.
- Не пиши пояснений вне JSON.
- Если данных недостаточно для поля — оставь пустой массив/строку, НО ключ обязан присутствовать.`;

const OPPORTUNITY_PORTFOLIO_SCHEMA = `OUTPUT FORMAT — STRICT JSON ONLY.
Структура ответа:
{
  "opportunity_definition": "string",
  "opportunity_layers":    [{"layer":"string","examples":["string"]}],
  "opportunity_universe":  [{"subniche":"string","opportunities":[{"name":"string","type":"string"}]}],
  "demand_quality":        [{"cluster":"string","quality":"high|medium|low","why":"string"}],
  "demand_to_opportunity": [{"demand":"string","opportunity":"string","conversion":"high|medium|low"}],
  "business_value":        [{"opportunity":"string","value":"high|medium|low","driver":"string"}],
  "accessibility":         [{"opportunity":"string","accessibility":"easy|medium|hard"}],
  "serp_fit":              [{"opportunity":"string","fit":"strong|weak","reason":"string"}],
  "journey_fit":           [{"opportunity":"string","stage":"awareness|consideration|decision","fit":"strong|weak"}],
  "intent_fit":            [{"opportunity":"string","intent":"informational|commercial|navigational|transactional"}],
  "trust_adjusted":        [{"opportunity":"string","eeat_load":"low|medium|high"}],
  "monetization_adjusted": [{"opportunity":"string","model":"string","fit":"strong|weak"}],
  "ai_adjusted":           [{"opportunity":"string","ai_risk":"low|medium|high"}],
  "format_fit":            [{"opportunity":"string","format":"string","fit":"strong|weak"}],
  "opportunity_wedges":    [{"wedge":"string","why":"string"}],
  "compounding":           [{"opportunity":"string","compounding_path":"string"}],
  "false_opportunities":   [{"trap":"string","reason":"string"}],
  "underexploited_gaps":   [{"gap":"string","why_missed":"string","upside":"high|medium|low"}],
  "operational_feasibility": [{"opportunity":"string","feasibility":"easy|medium|hard"}],
  "speed_to_impact":       [{"opportunity":"string","speed":"weeks|months|quarters"}],
  "by_site_maturity":      [{"opportunity":"string","best_for":"new|growing|mature"}],
  "portfolio_model":       {"core":["string"],"adjacent":["string"],"experimental":["string"]},
  "scoring_framework":     [{"opportunity":"string","total_score":1-100,"sub_scores":{"demand":1-100,"value":1-100,"feasibility":1-100,"trust":1-100}}],
  "comparison":            [{"a":"string","b":"string","verdict":"string"}],
  "strategic_sequencing":  [{"phase":"P1|P2|P3","opportunities":["string"]}],
  "strategy_interpretation": "string",
  "final_verdict":         "string",
  "final_recommendation":  {"top_3_now":["string"],"top_3_next":["string"],"avoid":["string"]}
}
RULES: только JSON, без markdown, без пояснений снаружи.`;

const DEMAND_MAP_SCHEMA = `OUTPUT FORMAT — STRICT JSON ONLY.
Структура ответа:
{
  "demand_definition":  "string",
  "demand_universe_structure": "string",
  "demand_by_subniche": [{"subniche":"string","demand_volume":"high|medium|low|niche","examples":["string"]}],
  "demand_layers_by_intent":   [{"intent":"informational|commercial|navigational|transactional","share":"high|medium|low","sample_queries":["string"]}],
  "demand_by_journey": [{"stage":"awareness|consideration|decision|retention","queries":["string"]}],
  "shape_of_demand":   "head-heavy|long-tail-heavy|balanced",
  "high_value_vs_vanity": [{"cluster":"string","verdict":"high-value|vanity","reason":"string"}],
  "demand_by_query_class": [{"class":"how-to|comparison|definition|review|list|pricing|local|other","share":"high|medium|low"}],
  "audience_segmented":[{"segment":"string","queries":["string"]}],
  "geo_specific":      [{"geo":"string","queries":["string"]}],
  "seasonality":       [{"pattern":"seasonal|cyclic|trending|evergreen","details":"string"}],
  "urgency":           [{"cluster":"string","urgency":"now|soon|later"}],
  "repeatability":     [{"cluster":"string","retention_potential":"high|medium|low"}],
  "commercial_density":[{"cluster":"string","commercial_density":"high|medium|low"}],
  "trust_adjusted":    [{"cluster":"string","trust_load":"high|medium|low"}],
  "serp_adjusted":     [{"cluster":"string","serp_difficulty":"low|medium|high"}],
  "ai_adjusted":       [{"cluster":"string","ai_overview_risk":"low|medium|high"}],
  "format_demand_fit": [{"cluster":"string","best_format":"string"}],
  "hidden_demand":     [{"cluster":"string","why_hidden":"string"}],
  "misleading_demand": [{"cluster":"string","why_misleading":"string"}],
  "compounding_structures":[{"cluster":"string","compounding":"string"}],
  "accessibility_by_maturity": [{"cluster":"string","best_for":"new|growing|mature"}],
  "demand_portfolio":  {"core":["string"],"adjacent":["string"],"experimental":["string"]},
  "scoring":           [{"cluster":"string","total_score":1-100,"volume":1-100,"intent_quality":1-100,"feasibility":1-100}],
  "comparison":        [{"a":"string","b":"string","verdict":"string"}],
  "strategic_sequencing":[{"phase":"P1|P2|P3","clusters":["string"]}],
  "growth_interpretation":"string",
  "final_verdict":     "string",
  "final_recommendation":{"top_3_now":["string"],"top_3_next":["string"],"avoid":["string"]},
  "lsi_clusters":      [{"cluster":"string","keywords":["string"],"intent":"informational|commercial|navigational|transactional"}]
}
RULES: только JSON, без markdown, без пояснений вне JSON.`;

/**
 * runPreStage0 — основной enrichment-step.
 *
 * @param {object} task
 * @param {object} ctx — { log, progress, taskId, onTokens }
 * @param {object} [extras] — { targetPageAnalysis, audienceNicheAnalysis }
 * @returns {Promise<object|null>} STRATEGY_CONTEXT или null если не удалось
 */
async function runPreStage0(task, ctx, extras = {}) {
  const { log, progress, taskId, onTokens } = ctx;

  if (!isStrategyAvailable()) {
    log('Pre-Stage 0: стратегические промты не загружены — пропускаем стадию', 'warn');
    return null;
  }

  log('Pre-Stage 0: запуск стратегического слоя (Niche Landscape + Opportunity Finder + Demand Mapper)...', 'info');
  if (progress) progress(1, 'pre_stage0');

  const sharedInput = buildSharedInputContext(task, extras);

  const inputAppendix = `\n\n${sharedInput}\n\n`;

  // Все 3 запуска параллельны и независимы. Любой из них может упасть —
  // мы не валим стадию целиком.
  const errors = [];
  const callOpts = {
    retries:     3,
    taskId,
    stageName:   'pre_stage0',
    temperature: 0.3,
    log,
    onTokens,
  };

  const [nicheMap, opportunityPortfolio, demandMap] = await Promise.all([
    callLLM(
      'deepseek',
      STRATEGY_PROMPTS.nicheLandscapeAnalyzer,
      `${inputAppendix}\n${NICHE_MAP_SCHEMA}`,
      { ...callOpts, callLabel: 'Niche Landscape Analyzer' }
    ).catch(e => { errors.push({ call: 'niche_landscape', message: e.message }); log(`Pre-Stage 0 Niche Landscape error: ${e.message}`, 'warn'); return null; }),

    callLLM(
      'deepseek',
      STRATEGY_PROMPTS.marketOpportunityFinder,
      `${inputAppendix}\n${OPPORTUNITY_PORTFOLIO_SCHEMA}`,
      { ...callOpts, callLabel: 'Market Opportunity Finder' }
    ).catch(e => { errors.push({ call: 'market_opportunity', message: e.message }); log(`Pre-Stage 0 Market Opportunity error: ${e.message}`, 'warn'); return null; }),

    callLLM(
      'deepseek',
      STRATEGY_PROMPTS.searchDemandMapper,
      `${inputAppendix}\n${DEMAND_MAP_SCHEMA}`,
      { ...callOpts, callLabel: 'Search Demand Mapper' }
    ).catch(e => { errors.push({ call: 'search_demand', message: e.message }); log(`Pre-Stage 0 Search Demand error: ${e.message}`, 'warn'); return null; }),
  ]);

  if (!nicheMap && !opportunityPortfolio && !demandMap) {
    log('Pre-Stage 0: все три вызова провалились — стратегический контекст недоступен', 'warn');
    return null;
  }

  const strategyContext = {
    niche_map:             nicheMap             || null,
    opportunity_portfolio: opportunityPortfolio || null,
    demand_map:            demandMap            || null,
    generated_at:          new Date().toISOString(),
    errors,
  };

  // Сохраняем в БД (поле strategy_context — миграция 006).
  // Если колонки нет (миграция не применена) — логируем, но не валим.
  try {
    await db.query(
      `UPDATE tasks SET strategy_context = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(strategyContext), taskId]
    );
  } catch (dbErr) {
    log(`Pre-Stage 0: не удалось сохранить strategy_context в БД (${dbErr.message}) — продолжаем in-memory`, 'warn');
  }

  log(
    `Pre-Stage 0 завершён. Niche: ${nicheMap ? '✓' : '✗'} | Opportunity: ${opportunityPortfolio ? '✓' : '✗'} | Demand: ${demandMap ? '✓' : '✗'}`,
    'success'
  );

  return strategyContext;
}

/**
 * buildStrategyDigest — компактная (≤ N симв.) текстовая выжимка из STRATEGY_CONTEXT
 * для инжекции в динамические user-промпты Stage 0/1/2. Не трогает «жёсткие»
 * системные промпты — мы дополняем только пользовательский контекст,
 * минимизируя риск регрессии.
 *
 * @param {object} strategyContext — результат runPreStage0
 * @param {number} [maxLen=4000]
 * @returns {string} digest или пустую строку если контекста нет
 */
function buildStrategyDigest(strategyContext, maxLen = 4000) {
  if (!strategyContext) return '';

  const parts = [];
  const nm = strategyContext.niche_map;
  const op = strategyContext.opportunity_portfolio;
  const dm = strategyContext.demand_map;

  if (nm) {
    parts.push('— NICHE MAP —');
    if (nm.scope_definition) parts.push(`Scope: ${nm.scope_definition}`);
    if (Array.isArray(nm.subniches) && nm.subniches.length) {
      parts.push(`Subniches: ${nm.subniches.slice(0, 8).map(s => `${s.name}(${s.priority || '?'})`).join(', ')}`);
    }
    if (Array.isArray(nm.wedge_opportunities) && nm.wedge_opportunities.length) {
      parts.push(`Wedges: ${nm.wedge_opportunities.slice(0, 5).map(w => w.wedge).join(' | ')}`);
    }
    if (Array.isArray(nm.eeat_requirements) && nm.eeat_requirements.length) {
      parts.push(`E-E-A-T must: ${nm.eeat_requirements.filter(e => e.priority === 'must').slice(0, 6).map(e => e.signal).join(' | ')}`);
    }
    if (Array.isArray(nm.serp_reality) && nm.serp_reality.length) {
      parts.push(`SERP reality: ${nm.serp_reality.slice(0, 5).map(r => `${r.query_class}→${r.dominant_format}/${r.difficulty}`).join(' | ')}`);
    }
    if (nm.go_decision) parts.push(`Strategic verdict: ${nm.go_decision}`);
  }

  if (op) {
    parts.push('— OPPORTUNITY PORTFOLIO —');
    if (op.portfolio_model) {
      const pm = op.portfolio_model;
      parts.push(`Core: ${(pm.core || []).slice(0, 5).join(' | ')}`);
      if (pm.adjacent?.length) parts.push(`Adjacent: ${pm.adjacent.slice(0, 5).join(' | ')}`);
    }
    if (op.final_recommendation?.top_3_now?.length) {
      parts.push(`Top now: ${op.final_recommendation.top_3_now.slice(0, 3).join(' | ')}`);
    }
    if (Array.isArray(op.underexploited_gaps) && op.underexploited_gaps.length) {
      parts.push(`Underexploited: ${op.underexploited_gaps.slice(0, 5).map(g => g.gap).join(' | ')}`);
    }
  }

  if (dm) {
    parts.push('— DEMAND MAP —');
    if (Array.isArray(dm.lsi_clusters) && dm.lsi_clusters.length) {
      const top = dm.lsi_clusters.slice(0, 6).map(c => `${c.cluster}: ${(c.keywords || []).slice(0, 6).join(', ')}`);
      parts.push(`LSI clusters: ${top.join(' || ')}`);
    }
    if (Array.isArray(dm.demand_by_journey) && dm.demand_by_journey.length) {
      parts.push(`Journey demand: ${dm.demand_by_journey.slice(0, 4).map(j => `${j.stage}: ${(j.queries || []).slice(0, 3).join(', ')}`).join(' || ')}`);
    }
    if (Array.isArray(dm.hidden_demand) && dm.hidden_demand.length) {
      parts.push(`Hidden demand: ${dm.hidden_demand.slice(0, 5).map(h => h.cluster).join(' | ')}`);
    }
    if (Array.isArray(dm.commercial_density) && dm.commercial_density.length) {
      const high = dm.commercial_density.filter(c => c.commercial_density === 'high').slice(0, 5).map(c => c.cluster);
      if (high.length) parts.push(`High commercial: ${high.join(' | ')}`);
    }
  }

  let digest = parts.join('\n');
  if (digest.length > maxLen) digest = digest.substring(0, maxLen - 3) + '...';
  return digest;
}

module.exports = {
  runPreStage0,
  buildStrategyDigest,
};
