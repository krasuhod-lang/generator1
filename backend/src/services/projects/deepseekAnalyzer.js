'use strict';

/**
 * projects/deepseekAnalyzer.js — «Senior SEO-аналитик» на базе DeepSeek.
 *
 * Получает срез данных GSC за период (топ-запросы, топ-страницы, динамика
 * кликов/позиций) + описание целевой аудитории проекта и возвращает
 * форматированный Markdown-отчёт строго по структуре из ТЗ:
 *   1) Общая оценка ситуации (почему метрики растут/падают)
 *   2) Точки роста
 *   3) Усиление семантических коконов (topic clusters)
 *   4) Рекомендации по постраничной оптимизации
 *   5) Чёткий пошаговый Action Plan
 *
 * Долгий ответ (30–60 c+) — вызывающий код запускает это в фоне. Graceful:
 * никогда не бросает, возвращает { verdict: 'ok'|'skipped'|'error' }.
 */

const { callDeepSeek } = require('../llm/deepseek.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const llmUsageLog = require('../aegis/llmUsageLog');
const { getProjectsConfig } = require('./config');

const SYSTEM_PROMPT = [
  'Ты — Senior SEO-аналитик с 10+ годами опыта в поисковом продвижении.',
  'Тебе передают реальные данные из Google Search Console (динамика кликов,',
  'показов, CTR и средней позиции, топ-запросы и топ-страницы) и описание',
  'целевой аудитории проекта.',
  '',
  'Твоя задача — выдать развёрнутый, практичный отчёт на русском языке в',
  'формате Markdown. Используй заголовки (##), списки, **жирный** для',
  'акцентов и таблицы, где это уместно. Строго соблюдай структуру:',
  '',
  '## 1. Общая оценка текущей ситуации',
  'Почему метрики растут или падают, что говорит динамика позиций и CTR.',
  '',
  '## 2. Точки роста',
  'Что стоит усилить в первую очередь (конкретные запросы/страницы).',
  '',
  '## 3. Семантические коконы (topic clusters)',
  'Где и как усилить семантические коконы: какие кластеры достроить,',
  'какие опорные и дочерние страницы создать, как перелинковать.',
  '',
  '## 4. Постраничная оптимизация',
  'Рекомендации по конкретным URL из топа: title/description, контент,',
  'интент, внутренние ссылки.',
  '',
  '## 5. Action Plan на ближайший период',
  'Чёткий пронумерованный пошаговый план развития (что, зачем, ожидаемый',
  'эффект). Приоритизируй шаги.',
  '',
  '## 6. Коммерческий рост',
  'ОБЯЗАТЕЛЬНЫЙ раздел с упором на рост КОММЕРЧЕСКОГО трафика и выручки.',
  'Тебе передан детерминированный [КОММЕРЧЕСКИЙ СРЕЗ]: распределение запросов',
  'по интенту, доля коммерческого/брендового трафика, коммерческие запросы',
  'в зоне быстрого роста (striking distance), CTR-аномалии, каннибализация и',
  'несоответствие интента. На его основе дай приоритизированный план именно',
  'для коммерции: какие коммерческие страницы (каталог/услуги/карточки)',
  'усилить; под какие коммерческие запросы создать или доработать посадочные',
  'страницы; конкретные гипотезы по CTR (title/description/schema/rich',
  'snippets) для аномалий; как устранить каннибализацию (склейка/перелинковка/',
  'канонизация); куда направить пользователей при несоответствии интента;',
  'как развивать небрендовый коммерческий спрос, если доминирует бренд.',
  'Если коммерческого среза нет — кратко объясни, что усилить для коммерции',
  'на основе топ-запросов и страниц.',
  '',
  'Опирайся только на переданные данные и здравый SEO-смысл, не выдумывай',
  'цифр. Учитывай целевую аудиторию проекта во всех рекомендациях.',
  'Не добавляй преамбулы и заключения вне этой структуры.',
].join('\n');

function _stripFence(text) {
  if (!text) return '';
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function _buildUserPrompt({ project, range, performance, top, commercial }) {
  const lines = [
    '[ПРОЕКТ]',
    `Название: ${project.name || '—'}`,
    `Сайт: ${project.gsc_site_url || project.url || '—'}`,
    `Целевая аудитория: ${project.audience_description || '[не задано]'}`,
    '',
    `[ПЕРИОД] ${range.startDate} — ${range.endDate}`,
    '',
    '[СУММАРНЫЕ МЕТРИКИ]',
    `Клики: ${performance.totals.clicks}`,
    `Показы: ${performance.totals.impressions}`,
    `CTR: ${performance.totals.ctr}%`,
    `Средняя позиция: ${performance.totals.position}`,
    '',
    '[ДИНАМИКА ПО ДНЯМ] (date, clicks, impressions, ctr%, position)',
    JSON.stringify(performance.series.slice(-90)),
    '',
    `[ТОП-${top.topQueries.length} ЗАПРОСОВ] (query, clicks, impressions, ctr%, position)`,
    JSON.stringify(top.topQueries),
    '',
    `[ТОП-${top.topPages.length} СТРАНИЦ] (page, clicks, impressions, ctr%, position)`,
    JSON.stringify(top.topPages),
  ];
  if (commercial && commercial.available) {
    lines.push(
      '',
      '[КОММЕРЧЕСКИЙ СРЕЗ] (детерминированный анализ для раздела 6)',
      `Доля коммерческого трафика: ${commercial.commercial_clicks_pct}% кликов, ${commercial.commercial_impressions_pct}% показов`,
      `Доля брендового трафика: ${commercial.branded_clicks_pct}% кликов`,
      `Брендовые маркеры: ${(commercial.brand_tokens || []).join(', ') || '—'}`,
      '',
      'Распределение по интенту (intent, queries, clicks, clicksPct):',
      JSON.stringify(commercial.intent_distribution),
      '',
      'Коммерческие запросы в зоне быстрого роста / striking distance (query, intent, impressions, ctr%, position):',
      JSON.stringify(commercial.striking_distance),
      '',
      'CTR-аномалии на коммерческих запросах — CTR ниже ожидаемого для позиции (query, ctr%, expectedCtr%, position, impressions):',
      JSON.stringify(commercial.ctr_anomalies),
      '',
      'Каннибализация коммерческих запросов — один запрос делят несколько URL, ни один не в топ-3 (query, best_position, pages):',
      JSON.stringify(commercial.cannibalization),
      '',
      'Несоответствие интента — коммерческий запрос приземляется на инфо-страницу (query, landing_page, impressions, position):',
      JSON.stringify(commercial.intent_mismatch),
    );
  }
  return lines.join('\n');
}

/**
 * Запускает анализ. Возвращает объект-результат (никогда не бросает).
 */
async function runProjectAnalysis(payload) {
  const cfg = getProjectsConfig().deepseek;
  if (!cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };

  const userPrompt = _buildUserPrompt(payload);
  try {
    const t0 = Date.now();
    const resp = await callDeepSeek(SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
    });
    const tIn = resp.tokensIn || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cacheHitTokens || 0;
    const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: cached });
    const durationMs = Date.now() - t0;
    // Эгида: учитываем расход LLM в сквозной cost-аналитике (graceful, не бросает).
    try {
      llmUsageLog.recordUsage({
        provider: 'deepseek',
        kind: 'project_seo_analysis',
        outcome: 'ok',
        tokensIn: tIn,
        tokensOut: tOut,
        cachedTokens: cached,
        costUsd: cost,
        latencyMs: durationMs,
      });
    } catch (_) { /* no-op */ }
    return {
      verdict: 'ok',
      markdown: _stripFence(resp.text || ''),
      tokens_in: tIn,
      tokens_out: tOut,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: resp.model || 'deepseek',
      duration_ms: durationMs,
    };
  } catch (err) {
    try {
      llmUsageLog.recordUsage({ provider: 'deepseek', kind: 'project_seo_analysis', outcome: 'error' });
    } catch (_) { /* no-op */ }
    return { verdict: 'error', reason: (err && err.message) ? err.message : String(err) };
  }
}

module.exports = { runProjectAnalysis, SYSTEM_PROMPT, _buildUserPrompt };
