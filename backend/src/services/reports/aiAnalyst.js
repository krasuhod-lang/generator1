'use strict';

/**
 * reports/aiAnalyst.js — AI-резюме для отчёта.
 *
 * Использует projects/llmAnalyst.runAnalyst (Gemini 3.1 Pro → DeepSeek
 * fallback), без введения новых LLM-провайдеров. Подсвечивает ТОЛЬКО
 * положительные тренды (per ТЗ §6.1) и связывает рост с выполненными работами.
 *
 * Контракт: generateSummary(aggregatedData, {brandName, period}) →
 *   { executive_summary, highlights, growth_attribution, model, provider }
 *
 * При недоступности LLM возвращает детерминированный fallback на основе чисел
 * (без вранья — только факты), чтобы кнопка «Сгенерировать» в UI не
 * деградировала в ошибку при отсутствии API-ключей.
 */

const { runAnalyst } = require('../projects/llmAnalyst');

const SYSTEM_PROMPT = `Ты — SEO-аналитик, который готовит ежемесячный отчёт для инвесторов и топ-менеджмента. Пиши профессионально, но без жаргона. Подчёркивай ТОЛЬКО положительные тренды и достижения. Связывай рост показателей с конкретными выполненными работами. НЕ упоминай проблемы, падения или негатив. Отвечай строго JSON-объектом без префиксов и текста до/после.

Ожидаемый формат ответа:
{
  "executive_summary": "3 абзаца на русском, разделённые \\n\\n",
  "highlights": ["буллит 1", "буллит 2", "буллит 3", "..."],
  "growth_attribution": "Один-два абзаца: почему именно эти работы дали рост"
}`;

function _pctChange(curr, prev) {
  if (!prev || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10; // 1 знак после запятой
}

function _seriesDelta(series, key = 'clicks') {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = Number(series[series.length - 1]?.[key]) || 0;
  const prev = Number(series[series.length - 2]?.[key]) || 0;
  return { last, prev, deltaPct: _pctChange(last, prev) };
}

function _buildMetricsDigest(data) {
  const gscDelta = _seriesDelta(data.gsc?.series, 'clicks');
  const ywmDelta = _seriesDelta(data.ywm?.series, 'clicks');
  const visDelta = _seriesDelta(data.keys_so?.series, 'visibility');
  const tasks = data.tasks || {};

  return {
    gsc_clicks: data.gsc?.totals?.clicks || 0,
    gsc_clicks_delta_pct: gscDelta?.deltaPct ?? null,
    gsc_impressions: data.gsc?.totals?.impressions || 0,
    ywm_clicks: data.ywm?.totals?.clicks || 0,
    ywm_clicks_delta_pct: ywmDelta?.deltaPct ?? null,
    keys_so_visibility_current: data.keys_so?.current?.visibility ?? null,
    keys_so_visibility_delta_pct: visDelta?.deltaPct ?? null,
    keys_so_top10: data.keys_so?.current?.top10 ?? null,
    keys_so_top3: data.keys_so?.current?.top3 ?? null,
    tasks_total: tasks.total_generated || 0,
    tasks_by_type: tasks.by_type || {},
    forecast_clicks_3m: data.forecast?.gsc_clicks?.forecast || null,
  };
}

function _buildTasksList(data) {
  const items = (data.tasks?.items || []).slice(0, 30);
  return items.map((it) => `• ${it.title} (${it.task_type}, ${it.performed_at})`).join('\n');
}

function _safeJson(text) {
  if (!text) return null;
  // Иногда модель оборачивает в ```json … ```
  const cleaned = String(text).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* */ }
  // Попытка вытащить { ... } из произвольного текста.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { /* */ }
  }
  return null;
}

function _fallbackSummary(brandName, period, digest) {
  const parts = [];
  parts.push(
    `За период ${period} проект «${brandName}» продолжает развиваться по основным ` +
    `SEO-метрикам. Команда вела работу по нескольким направлениям, результаты которых ` +
    `постепенно проявляются в поисковом трафике и позициях.`,
  );
  const totalTasks = digest.tasks_total || 0;
  if (totalTasks > 0) {
    parts.push(
      `Всего за период выполнено ${totalTasks} задач: ` +
      Object.entries(digest.tasks_by_type)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k} — ${v}`)
        .join(', ') + '.',
    );
  }
  if (digest.gsc_clicks) {
    parts.push(`Google Search Console зафиксировал ${digest.gsc_clicks.toLocaleString('ru-RU')} кликов за период.`);
  }
  const highlights = [];
  if (digest.gsc_clicks_delta_pct != null && digest.gsc_clicks_delta_pct > 0) {
    highlights.push(`Клики из Google выросли на +${digest.gsc_clicks_delta_pct}% к предыдущему месяцу`);
  }
  if (digest.ywm_clicks_delta_pct != null && digest.ywm_clicks_delta_pct > 0) {
    highlights.push(`Трафик из Яндекса вырос на +${digest.ywm_clicks_delta_pct}%`);
  }
  if (digest.keys_so_visibility_delta_pct != null && digest.keys_so_visibility_delta_pct > 0) {
    highlights.push(`Индекс видимости в Keys.so увеличился на +${digest.keys_so_visibility_delta_pct}%`);
  }
  if (digest.keys_so_top10 != null) {
    highlights.push(`${digest.keys_so_top10} запросов в ТОП-10`);
  }
  if (totalTasks > 0) highlights.push(`Выполнено ${totalTasks} SEO-задач за период`);
  return {
    executive_summary: parts.join('\n\n'),
    highlights: highlights.length ? highlights : ['За период выполнен запланированный объём работ.'],
    growth_attribution:
      'Текущая динамика обеспечена комплексной работой команды: контентная программа ' +
      'наполняет сайт релевантными страницами, оптимизация мета-тегов улучшает CTR в выдаче, ' +
      'а ссылочная и техническая работа укрепляет авторитет домена.',
    fallback: true,
  };
}

async function generateSummary(data, opts = {}) {
  const brandName = String(opts.brandName || data.project?.name || 'Проект');
  const period = String(opts.period || '');
  const digest = _buildMetricsDigest(data);
  const tasksList = _buildTasksList(data);

  const userPrompt = [
    `Проект: ${brandName}`,
    `Период: ${period}`,
    `Метрики (JSON): ${JSON.stringify(digest)}`,
    `Выполненные работы:\n${tasksList || '— нет данных —'}`,
    '',
    'Сформируй executive_summary (3 абзаца), 3-5 highlights и growth_attribution. ' +
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n\n');

  const result = await runAnalyst(SYSTEM_PROMPT, userPrompt, {
    kind: 'reports_summary',
    temperature: 0.3,
    maxTokens: 1500,
  });

  if (result.verdict !== 'ok' || !result.markdown) {
    return { ...(_fallbackSummary(brandName, period, digest)), provider: result.verdict, model: result.model || null };
  }
  const parsed = _safeJson(result.markdown);
  if (!parsed || !parsed.executive_summary) {
    return { ...(_fallbackSummary(brandName, period, digest)), provider: result.provider, model: result.model };
  }
  return {
    executive_summary: String(parsed.executive_summary),
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String).slice(0, 8) : [],
    growth_attribution: String(parsed.growth_attribution || ''),
    provider: result.provider,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
  };
}

module.exports = { generateSummary, _buildMetricsDigest, _safeJson };
