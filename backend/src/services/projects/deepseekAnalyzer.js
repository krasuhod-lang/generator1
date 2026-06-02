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

function _buildUserPrompt({ project, range, performance, top }) {
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
    return {
      verdict: 'ok',
      markdown: _stripFence(resp.text || ''),
      tokens_in: tIn,
      tokens_out: tOut,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: resp.model || 'deepseek',
      duration_ms: Date.now() - t0,
    };
  } catch (err) {
    return { verdict: 'error', reason: (err && err.message) ? err.message : String(err) };
  }
}

module.exports = { runProjectAnalysis, SYSTEM_PROMPT, _buildUserPrompt };
