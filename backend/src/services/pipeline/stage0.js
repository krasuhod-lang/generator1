'use strict';

const { callLLM }             = require('../llm/callLLM');
const { scrapeCompetitors }   = require('../parser/scraper');
const { SYSTEM_PROMPTS_EXT }  = require('../../prompts/systemPrompts');
const { fillPromptVars }      = require('../../utils/fillPromptVars');
const db                      = require('../../config/db');

/**
 * Определяет, является ли URL собственным сайтом задачи.
 * Простая эвристика: домен совпадает с targetPageUrl.
 */
function isOwnSite(url, targetPageUrl) {
  if (!targetPageUrl) return false;
  try {
    const targetHost = new URL(targetPageUrl).hostname.replace('www.', '');
    const urlHost    = new URL(url).hostname.replace('www.', '');
    return urlHost === targetHost;
  } catch { return false; }
}

/**
 * Stage 0: анализ конкурентов + SERP Reality Check + Niche Landscape.
 *
 * @param {object}   task     — строка из таблицы tasks
 * @param {object}   ctx      — { log, progress, taskId }
 * @returns {object}          — stage0_result для сохранения в БД
 */
async function runStage0(task, ctx) {
  const { log, progress, taskId, onTokens } = ctx;

  log('Stage 0: Начало глубокого анализа конкурентов...', 'info');
  progress(2, 'stage0');

  // Достаём URL конкурентов (и целевую страницу если есть)
  const rawUrls = (task.input_competitor_urls || '').split('\n').map(u => u.trim()).filter(Boolean);
  if (!rawUrls.length) {
    log('Stage 0: URL конкурентов не указаны — пропускаем парсинг', 'warn');
    return null;
  }

  // Парсим все страницы параллельно
  log(`Stage 0: Парсинг ${rawUrls.length} страниц...`, 'info');
  const scrapedPages = await scrapeCompetitors(rawUrls);

  // Логируем в SSE все URL с ошибками или таймаутами — не роняем процесс
  scrapedPages.filter(p => p.timedOut || p.error).forEach(p => {
    const reason = p.timedOut ? 'Таймаут (>20s)' : `Ошибка: ${p.error}`;
    log(`Stage 0: ${reason} — ${p.url}`, 'warn');
  });

  const competitorContent = scrapedPages.map(p => ({
    url:      p.url,
    content:  p.content || '',
    error:    p.error   || null,
    isOwnSite: isOwnSite(p.url, task.input_target_url || task.input_competitor_urls?.split('\n')?.[0]),
  }));

  const ownSiteContent   = competitorContent.find(c => c.isOwnSite)   || null;
  const onlyCompetitors  = competitorContent.filter(c => !c.isOwnSite);

  log(
    `Stage 0: Спарсено ${competitorContent.filter(c => c.content).length}/${rawUrls.length}` +
    `${ownSiteContent ? ' (вкл. наш сайт)' : ''}`,
    'success'
  );

  // ── Calls 1 & 2: SERP Reality Check + Niche Landscape (параллельно) ──
  log('Stage 0: SERP Reality Check + Niche Landscape Analyzer (параллельно)...', 'info');

  const serpRealityContext = `

===== COMPETITOR CONTENT DATA (TOP-4 COMPETITORS ONLY) =====
NICHE: ${task.input_target_service}GEO: ${task.input_region || '[не указано]'}
LANGUAGE: ${task.input_language || 'ru'}
BUSINESS TYPE: ${task.input_business_type || '[не указано]'}
SITE TYPE: ${task.input_site_type || '[не указано]'}
TARGET AUDIENCE: ${task.input_target_audience || '[не указано]'}
BUSINESS GOAL: ${task.input_business_goal || '[не указано]'}
MONETIZATION: ${task.input_monetization || '[не указано]'}
PROJECT LIMITS: ${task.input_project_limits || '[не указано]'}
PAGE PRIORITIES: ${task.input_page_priorities || '[не указано]'}
NICHE FEATURES: ${task.input_niche_features || '[не указано]'}${onlyCompetitors.map(c => `URL: ${c.url}\n${c.content.substring(0, 8000)}`).join('\n\n---\n\n')}
${ownSiteContent ? `
===== OUR SITE (ANALYZE WEAKNESSES vs COMPETITORS) =====
URL: ${ownSiteContent.url}
${ownSiteContent.content.substring(0, 4000)}
TASK: Find gaps between our content and competitors. What do competitors cover that we miss? What can we do BETTER?
` : ''}
OUTPUT: Return ONLY valid JSON with ALL of these keys:
- competitor_facts: [{fact, source_url, category}] (min 5, only real numbers/data)
- core_entities: [{entity, type, trust_signal, context}] (min 5)
- audience_pains: [{pain, priority: 'high|medium|low', solution_signal}] (min 5)
- trust_triggers: [{trigger, type, strength}] (min 5)
- search_intents: [{intent, type: 'informational|commercial|navigational|transactional', frequency: 'high|medium|low'}] (min 3)
- buyer_journey_signals: [{stage: 'awareness|consideration|decision', signal, query_example}] (min 3 per stage)
- dominant_formats: [{format, purpose, example_topic}]
- content_gaps: [{topic, reason_missing, opportunity_score: 1-10}] (min 5)
- white_space_opportunities: [{opportunity, potential_traffic, difficulty: 'low|medium|high'}] (min 3)
- faq_bank: [{question, answer}] (min 5)
NO markdown. NO extra text outside JSON.`;

  const nicheLandscapeContext = `

===== INPUT DATA =====
NICHE / TARGET SERVICE: ${task.input_target_service}
GEO: ${task.input_region || '[не указано]'}
LANGUAGE: ${task.input_language || 'ru'}
BUSINESS TYPE: ${task.input_business_type || '[не указано]'}
SITE TYPE: ${task.input_site_type || '[не указано]'}
TARGET AUDIENCE: ${task.input_target_audience || '[не указано]'}
BUSINESS GOAL: ${task.input_business_goal || '[не указано]'}
MONETIZATION: ${task.input_monetization || '[не указано]'}
PROJECT LIMITS: ${task.input_project_limits || '[не указано]'}
PAGE PRIORITIES: ${task.input_page_priorities || '[не указано]'}
NICHE FEATURES: ${task.input_niche_features || '[не указано]'}
COMPETITOR CONTENT SUMMARY: ${onlyCompetitors.map(c => c.content.substring(0, 3000)).join(' ')}
${ownSiteContent ? `OUR SITE CURRENT STATE: ${ownSiteContent.content.substring(0, 2000)}\n` : ''}

OUTPUT: Return ONLY valid JSON enriching with: niche_segments (array), demand_layers (array), topic_clusters (array), competitor_gaps (array), strategic_priorities (array). NO markdown.`;

  // Запускаем оба вызова параллельно — они используют разные промпты и не зависят друг от друга
  const [serpRealityResult, nicheLandscapeResult] = await Promise.all([
    callLLM('deepseek', fillPromptVars(SYSTEM_PROMPTS_EXT.serpRealityCheck, task), serpRealityContext, {
      retries:   3,
      taskId,
      stageName: 'stage0',
      callLabel: 'SERP Reality Check',
      temperature: 0.3,
      log,
      onTokens,
    }).catch(e => { log(`Stage 0 Call 1 error: ${e.message}`, 'warn'); return null; }),

    callLLM('deepseek', fillPromptVars(SYSTEM_PROMPTS_EXT.nicheLandscape, task), nicheLandscapeContext, {
      retries:   3,
      taskId,
      stageName: 'stage0',
      callLabel: 'Niche Landscape',
      temperature: 0.3,
      log,
      onTokens,
    }).catch(e => { log(`Stage 0 Call 2 error: ${e.message}`, 'warn'); return null; }),
  ]);

  progress(8, 'stage0');

  // Fallback если оба вызова провалились
  if (!serpRealityResult && !nicheLandscapeResult) {
    const fallbackSystem = `ROLE: Senior SEO Competitive Intelligence Analyst.
MISSION: Провести глубокий реверс-инжиниринг контента конкурентов для ниши "${task.input_target_service}".`;

    const fallbackPrompt = `INPUT DATA: ${onlyCompetitors.map(c => `URL: ${c.url}\n${c.content.substring(0, 5000)}`).join('\n\n---\n\n')}${ownSiteContent ? `\n\nOUR SITE: URL: ${ownSiteContent.url}\n${ownSiteContent.content.substring(0, 3000)}` : ''}
JSON SCHEMA: {"competitor_facts":[{"fact":"string","source_url":"string","category":"string"}],"core_entities":[{"entity":"string","type":"string","trust_signal":true,"context":"string"}],"audience_pains":[{"pain":"string","priority":"high|medium|low","solution_signal":"string"}],"trust_triggers":[{"trigger":"string","type":"string","strength":"string"}],"white_spaces":["string"],"content_patterns":["string"],"faq_bank":[{"question":"string","answer":"string"}]}
RULES: 1. competitor_facts — ТОЛЬКО реальные числа. 2. Минимум 5 записей в каждом массиве. OUTPUT: JSON ONLY.`;

    const fallbackResult = await callLLM('deepseek', fallbackSystem, fallbackPrompt, {
      retries: 3, taskId, stageName: 'stage0', callLabel: 'Fallback Analysis', log, onTokens,
    }).catch(() => null);

    if (!fallbackResult) throw new Error('Stage 0: все запросы вернули ошибки');
    return { ...fallbackResult };
  }

  // Объединяем результаты
  const stage0Result = {
    ...(serpRealityResult  || {}),
    niche_segments:       nicheLandscapeResult?.niche_segments       || [],
    demand_layers:        nicheLandscapeResult?.demand_layers        || [],
    topic_clusters:       nicheLandscapeResult?.topic_clusters       || [],
    competitor_gaps:      nicheLandscapeResult?.competitor_gaps      || [],
    strategic_priorities: nicheLandscapeResult?.strategic_priorities || [],
  };

  // Сохраняем в tasks
  await db.query(
    `UPDATE tasks SET stage0_result = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(stage0Result), taskId]
  );

  log(
    `Stage 0 завершён! Фактов: ${(stage0Result.competitor_facts||[]).length}, ` +
    `Сущностей: ${(stage0Result.core_entities||[]).length}, ` +
    `Болей: ${(stage0Result.audience_pains||[]).length}, ` +
    `Пробелов: ${(stage0Result.competitor_gaps||[]).length}`,
    'success'
  );

  progress(10, 'stage0');
  return stage0Result;
}

module.exports = { runStage0 };
