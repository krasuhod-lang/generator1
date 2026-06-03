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

function _buildUserPrompt({ project, range, performance, top, commercial, serpVerification }) {
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
  lines.push(..._renderSerpVerificationLines(serpVerification));
  return lines.join('\n');
}

/**
 * Блок проверки каннибализации по реальной топ-выдаче Google. Включается в
 * промт, чтобы LLM рекомендовала склейку разделов ТОЛЬКО там, где выдача это
 * подтверждает (verdict=merge_recommended), а не по одному сигналу из GSC.
 */
function _renderSerpVerificationLines(serpVerification) {
  if (!serpVerification || !serpVerification.available
    || !Array.isArray(serpVerification.items) || serpVerification.items.length === 0) {
    return [];
  }
  return [
    '',
    `[ВЕРИФИКАЦИЯ КАННИБАЛИЗАЦИИ ПО ТОП-ВЫДАЧЕ ${String(serpVerification.engine || 'google').toUpperCase()}]`,
    'Каждый кейс каннибализации сверен с реальной выдачей. Рекомендуй слияние/',
    'склейку разделов ТОЛЬКО для verdict=merge_recommended. Для keep_separate —',
    'НЕ предлагай объединять страницы. Для inconclusive — отметь, что выдачу не',
    'удалось снять, и опирайся на данные GSC.',
    'Кейсы (query, verdict, best_position, site_pages_in_top_count, recommendation):',
    JSON.stringify(serpVerification.items.map((it) => ({
      query: it.query,
      verdict: it.verdict,
      best_position: it.best_position,
      site_pages_in_top_count: it.site_pages_in_top_count,
      recommendation: it.recommendation,
    }))),
  ];
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

module.exports = { runProjectAnalysis, runProjectAnalysisBatched, SYSTEM_PROMPT, _buildUserPrompt };

// ── Порционный (map-reduce) режим для больших наборов данных ───────────

const { buildChunks, runMapReduce, estimateWorkload, shouldBatch } = require('./batchAnalyzer');

// MAP: ёмкое извлечение выводов и гипотез по одной порции данных.
const MAP_SYSTEM_PROMPT = [
  'Ты — SEO-аналитик. Тебе дают ПОРЦИЮ строк Google Search Console',
  '(query × page: клики, показы, CTR%, позиция). Это часть большого набора.',
  'Выдели только САМОЕ ВАЖНОЕ по этой порции в виде коротких буллетов на',
  'русском, без воды и преамбул, максимально ёмко:',
  '• точки роста (запросы/страницы у входа в топ);',
  '• подозрения на каннибализацию (один запрос — несколько URL);',
  '• несоответствие интента (коммерческий запрос на инфо-странице);',
  '• заметные CTR-аномалии и гипотезы по их причинам.',
  'Не выдумывай данных. Не более 12 буллетов. Только буллеты.',
].join('\n');

function _buildMapUserPrompt(chunk) {
  return [
    `[ПОРЦИЯ ${chunk.index}/${chunk.total}] строк query×page: ${chunk.items.length}`,
    '(query, page, clicks, impressions, ctr%, position)',
    JSON.stringify(chunk.items.map((r) => ({
      query: r.query, page: r.page, clicks: r.clicks,
      impressions: r.impressions, ctr: r.ctr, position: r.position,
    }))),
  ].join('\n');
}

async function _callDeepSeekTracked(system, user, cfg, kind) {
  const t0 = Date.now();
  const resp = await callDeepSeek(system, user, {
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
  });
  const tIn = resp.tokensIn || 0;
  const tOut = resp.tokensOut || 0;
  const cached = resp.cacheHitTokens || 0;
  const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: cached });
  const durationMs = Date.now() - t0;
  try {
    llmUsageLog.recordUsage({
      provider: 'deepseek', kind, outcome: 'ok',
      tokensIn: tIn, tokensOut: tOut, cachedTokens: cached,
      costUsd: cost, latencyMs: durationMs,
    });
  } catch (_) { /* no-op */ }
  return { text: resp.text || '', tIn, tOut, cached, cost, model: resp.model || 'deepseek', durationMs };
}

/**
 * Порционный анализ: режет тяжёлый срез (query×page) на порции, по каждой
 * извлекает выводы/гипотезы (map), затем сводит общий пул в единый отчёт
 * (reduce). Включается в analysisRunner при большом объёме данных.
 * Graceful: при провале map-reduce откатывается на обычный runProjectAnalysis.
 */
async function runProjectAnalysisBatched(payload) {
  const cfg = getProjectsConfig();
  const dcfg = cfg.deepseek;
  const bcfg = cfg.batch;
  if (!dcfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };

  const slice = {
    topQueries: (payload.top && payload.top.topQueries) || [],
    queryPage: Array.isArray(payload.queryPage) ? payload.queryPage : [],
  };
  const chunks = buildChunks(slice, bcfg);
  // Слишком мало порций — нет смысла в map-reduce, обычный путь.
  if (chunks.length < 2) return runProjectAnalysis(payload);

  try {
    let mapTokIn = 0; let mapTokOut = 0; let mapCost = 0;
    const mapFn = async (chunk) => {
      const r = await _callDeepSeekTracked(
        MAP_SYSTEM_PROMPT, _buildMapUserPrompt(chunk), dcfg, 'project_seo_analysis_map',
      );
      mapTokIn += r.tIn; mapTokOut += r.tOut; mapCost += r.cost;
      const text = _stripFence(r.text).trim();
      return text ? { index: chunk.index, total: chunk.total, text } : null;
    };

    const reduceFn = async (partials) => {
      const base = _buildUserPrompt(payload);
      const poolLines = partials.map(
        (p) => `— Порция ${p.index}/${p.total}:\n${p.text}`,
      );
      const reduceUser = [
        base,
        '',
        '[СВЕДЁННЫЙ ПУЛ ВЫВОДОВ И ГИПОТЕЗ ПО ПОРЦИЯМ]',
        'Данные были обработаны порционно. Ниже — ёмкие выводы по каждой порции.',
        'Сведи их в единый непротиворечивый отчёт по структуре выше, убери',
        'дубли, расставь приоритеты. Держи изложение ёмким, чётким и понятным.',
        '',
        poolLines.join('\n\n'),
      ].join('\n');
      const r = await _callDeepSeekTracked(
        SYSTEM_PROMPT, reduceUser, dcfg, 'project_seo_analysis_reduce',
      );
      return r;
    };

    const { result: reduced, stats } = await runMapReduce({
      chunks, mapFn, reduceFn, concurrency: bcfg.concurrency,
    });

    const tokIn = mapTokIn + reduced.tIn;
    const tokOut = mapTokOut + reduced.tOut;
    const cost = mapCost + reduced.cost;
    return {
      verdict: 'ok',
      markdown: _stripFence(reduced.text),
      tokens_in: tokIn,
      tokens_out: tokOut,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: reduced.model,
      duration_ms: reduced.durationMs,
      batched: true,
      batch_stats: stats,
    };
  } catch (err) {
    // Любой сбой порционного режима — мягкий откат на одиночный анализ.
    try {
      llmUsageLog.recordUsage({ provider: 'deepseek', kind: 'project_seo_analysis_batched', outcome: 'error' });
    } catch (_) { /* no-op */ }
    return runProjectAnalysis(payload);
  }
}

// Реэкспорт утилит для analysisRunner (решение о порционном режиме).
module.exports.estimateWorkload = estimateWorkload;
module.exports.shouldBatch = shouldBatch;
