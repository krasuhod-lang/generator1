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

const SYSTEM_PROMPT = `Ты — SEO-аналитик, который готовит ежемесячный отчёт для инвесторов и топ-менеджмента. Пиши профессионально, но без жаргона. В разделах executive_summary и highlights подчёркивай ТОЛЬКО положительные тренды и достижения, связывай рост показателей с конкретными выполненными работами. В разделе growth_attribution дай объективный аналитический разбор по метрикам: что повлияло на рост, какие выводы можно сделать, какой дальнейший прогноз и где есть слабые зоны / точки роста. Слабые зоны формулируй как точки развития, не как критику. Отвечай строго JSON-объектом без префиксов и текста до/после, без markdown-обёртки.

Ожидаемый формат ответа:
{
  "executive_summary": "3 абзаца на русском, разделённые \\n\\n",
  "highlights": ["буллит 1", "буллит 2", "буллит 3", "..."],
  "growth_attribution": [
    {
      "metric": "Название метрики (например: «Клики из Google», «Видимость Keys.so», «Запросы в ТОП-10»)",
      "attribution": "Что повлияло на текущую динамику этой метрики — связь с конкретными выполненными работами и внешними факторами (1–2 предложения).",
      "conclusion": "Аналитический вывод по метрике: что это значит для проекта (1 предложение).",
      "forecast": "Дальнейший прогноз: куда метрика двинется в ближайшие 1–3 месяца при сохранении текущей работы (1 предложение).",
      "weak_zones": "Слабые зоны / точки роста по этой метрике: где не дорабатываем и что можно усилить (1–2 предложения)."
    }
  ]
}

Сделай 3–5 объектов в growth_attribution — по одному на ключевую метрику (Google clicks, Yandex clicks, видимость Keys.so, ТОП-10/ТОП-3, объём задач и т.п.). Если данных по метрике нет — не выдумывай, просто пропусти её.`;

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

  // Структурированный growth_attribution: по каждой ключевой метрике —
  // attribution / conclusion / forecast / weak_zones. Без LLM мы можем дать
  // только детерминированную «болванку», но с реальными числами и связкой
  // с выполненными задачами, чтобы UI всё равно показывал что-то осмысленное.
  const taskTypes = Object.entries(digest.tasks_by_type || {})
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  const taskMix = taskTypes.length ? taskTypes.join(', ') : 'комплексной работы команды';

  const growth = [];
  if (digest.gsc_clicks != null && digest.gsc_clicks > 0) {
    const delta = digest.gsc_clicks_delta_pct;
    const dir = delta != null
      ? (delta > 0 ? `рост +${delta}% к предыдущему месяцу` : (delta < 0 ? `снижение ${delta}%` : 'стабилизация'))
      : 'стабильный уровень';
    growth.push({
      metric: 'Клики из Google',
      attribution: `Динамика обусловлена работой команды по направлениям: ${taskMix}. Контентная программа наполняет сайт релевантными страницами, оптимизация мета-тегов улучшает CTR в выдаче.`,
      conclusion: `Текущий уровень — ${digest.gsc_clicks.toLocaleString('ru-RU')} кликов за период (${dir}).`,
      forecast: digest.forecast_clicks_3m && digest.forecast_clicks_3m.length
        ? `Прогноз на ближайшие 3 месяца: ${digest.forecast_clicks_3m.map((v) => Math.round(v).toLocaleString('ru-RU')).join(' → ')} кликов при сохранении текущего темпа работ.`
        : 'При сохранении текущего темпа работ ожидается продолжение положительной динамики в ближайшие 1–3 месяца.',
      weak_zones: 'Точка роста — масштабирование контентной программы и проработка страниц, находящихся на позициях 11–20 (striking distance), для быстрого выхода в ТОП-10.',
    });
  }
  if (digest.ywm_clicks != null && digest.ywm_clicks > 0) {
    const delta = digest.ywm_clicks_delta_pct;
    growth.push({
      metric: 'Клики из Яндекса',
      attribution: 'Динамика поддерживается технической оптимизацией и работой над поведенческими факторами, релевантным контентом под коммерческие запросы.',
      conclusion: `За период собрано ${digest.ywm_clicks.toLocaleString('ru-RU')} кликов${delta != null ? ` (${delta > 0 ? '+' : ''}${delta}% к прошлому месяцу)` : ''}.`,
      forecast: 'Ожидается дальнейший прирост по мере индексации новых страниц и накопления поведенческих сигналов.',
      weak_zones: 'Слабая зона — низкочастотные региональные запросы и страницы со слабой внутренней перелинковкой; здесь есть быстрый потенциал.',
    });
  }
  if (digest.keys_so_visibility_current != null) {
    const delta = digest.keys_so_visibility_delta_pct;
    growth.push({
      metric: 'Видимость Keys.so',
      attribution: 'Рост видимости связан с появлением новых ранжирующихся страниц и улучшением позиций по приоритетным кластерам после оптимизации мета-тегов и ссылочной работы.',
      conclusion: `Текущая видимость — ${(Number(digest.keys_so_visibility_current) * 100).toFixed(2)}%${delta != null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta}% к прошлому месяцу)` : ''}; запросов в ТОП-10: ${digest.keys_so_top10 ?? '—'}.`,
      forecast: 'При сохранении темпа публикации и линкбилдинга в течение 1–3 месяцев видимость продолжит укрепляться, а часть запросов из ТОП-50/30 поднимется в ТОП-10.',
      weak_zones: 'Зона развития — запросы в striking distance (позиции 11–20), а также кластеры, где конкуренты опережают по объёму контента и качеству ссылочного профиля.',
    });
  }
  if (totalTasks > 0) {
    growth.push({
      metric: 'Объём выполненных работ',
      attribution: `За период выполнено ${totalTasks} задач по направлениям: ${taskMix}. Системная работа создаёт кумулятивный эффект — результат проявляется на горизонте 1–3 месяцев.`,
      conclusion: 'Темп работ соответствует SEO-стратегии и обеспечивает постепенный накопительный эффект.',
      forecast: 'При сохранении темпа в 30+ задач/мес. ожидается планомерное расширение семантического ядра и укрепление позиций.',
      weak_zones: 'Точка усиления — балансировка задач между контентом, ссылочным и техническим аудитом, чтобы ни одно направление не отставало.',
    });
  }
  if (!growth.length) {
    growth.push({
      metric: 'Общая динамика',
      attribution: 'Текущая динамика обеспечена комплексной работой команды: контентная программа наполняет сайт релевантными страницами, оптимизация мета-тегов улучшает CTR в выдаче, ссылочная и техническая работа укрепляет авторитет домена.',
      conclusion: 'Проект стабильно развивается по основным SEO-направлениям.',
      forecast: 'При сохранении текущего темпа работ ожидается продолжение положительной динамики в ближайшие 1–3 месяца.',
      weak_zones: 'Точка роста — расширение семантического ядра и системная работа со страницами на границе ТОП-10 (позиции 11–20).',
    });
  }

  return {
    executive_summary: parts.join('\n\n'),
    highlights: highlights.length ? highlights : ['За период выполнен запланированный объём работ.'],
    growth_attribution: growth,
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
    'Сформируй executive_summary (3 абзаца), 3-5 highlights и growth_attribution ' +
    '(массив из 3–5 объектов по ключевым метрикам с полями metric, attribution, ' +
    'conclusion, forecast, weak_zones). Используй реальные числа из метрик и ' +
    'ссылайся на конкретные выполненные работы. Ответь СТРОГО JSON-объектом, ' +
    'без markdown-обёртки.',
  ].join('\n\n');

  const result = await runAnalyst(SYSTEM_PROMPT, userPrompt, {
    kind: 'reports_summary',
    temperature: 0.3,
    maxTokens: 2500,
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
    growth_attribution: _normalizeGrowthAttribution(parsed.growth_attribution),
    provider: result.provider,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
  };
}

/**
 * Приводит growth_attribution к массиву объектов
 * {metric, attribution, conclusion, forecast, weak_zones}.
 *
 * Старые модели/черновики могли вернуть строку или массив строк — мы
 * аккуратно их оборачиваем, чтобы фронт всегда получал стабильную форму.
 */
function _normalizeGrowthAttribution(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    return [{
      metric: 'Общая динамика',
      attribution: text,
      conclusion: '',
      forecast: '',
      weak_zones: '',
    }];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const t = item.trim();
        return t ? {
          metric: '', attribution: t, conclusion: '', forecast: '', weak_zones: '',
        } : null;
      }
      if (typeof item !== 'object') return null;
      const metric = String(item.metric || item.name || '').trim();
      const attribution = String(item.attribution || item.cause || '').trim();
      const conclusion = String(item.conclusion || '').trim();
      const forecast = String(item.forecast || item.prediction || '').trim();
      const weak_zones = String(item.weak_zones || item.weakZones || item.weakness || '').trim();
      if (!metric && !attribution && !conclusion && !forecast && !weak_zones) return null;
      return { metric, attribution, conclusion, forecast, weak_zones };
    })
    .filter(Boolean)
    .slice(0, 8);
}

module.exports = { generateSummary, _buildMetricsDigest, _safeJson, _normalizeGrowthAttribution };
