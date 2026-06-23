'use strict';

/**
 * reports/aiAnalyst.js — AI-резюме для отчёта.
 *
 * Использует projects/llmAnalyst.runAnalyst (Gemini 3.1 Pro → DeepSeek
 * fallback), без введения новых LLM-провайдеров. Подсвечивает ТОЛЬКО
 * положительные тренды (per ТЗ §6.1) и связывает рост с выполненными работами.
 *
 * Контракт: generateSummary(aggregatedData, {brandName, period}) →
 *   { executive_summary, highlights, growth_attribution, quick_wins,
 *     vulnerabilities, roadmap, traffic_value, model, provider }
 *
 * При недоступности LLM возвращает детерминированный fallback на основе чисел
 * (без вранья — только факты), чтобы кнопка «Сгенерировать» в UI не
 * деградировала в ошибку при отсутствии API-ключей.
 */

const { runAnalyst } = require('../projects/llmAnalyst');

const SYSTEM_PROMPT = `Ты — SEO-аналитик, который готовит ежемесячный отчёт для инвесторов и топ-менеджмента. Твоя главная задача — убедительно показать прогресс и рост проекта. Пиши профессионально, уверенно, позитивно, но без жаргона.

КЛЮЧЕВЫЕ ПРАВИЛА ТОНА:
1. В executive_summary и highlights — подчёркивай ИСКЛЮЧИТЕЛЬНО положительные тренды, достижения, рекорды и прогресс. Связывай каждый рост с конкретными выполненными работами команды. Даже если рост небольшой — подай его как значимый результат («стабильный прирост», «уверенная положительная динамика»).
2. Если по какой-то метрике есть снижение — упомяни его КРАТКО и ВСКОЛЬЗЬ (не более 1 предложения), сразу переведи фокус на причину и план восстановления. Никогда не акцентируй внимание на негативе.
3. В growth_attribution анализируй КАЖДУЮ метрику ОТДЕЛЬНО как отдельный график. Начинай анализ каждой метрики с конкретных цифр роста (абсолютные и процентные значения). Если есть рост — выдели его ярко: «Рост на +X% (с Y до Z)». Если есть снижение — сформулируй мягко как «корректировка» или «стабилизация после пикового периода» и укажи конкретный план действий для возврата к росту.
4. Обязательно показывай ДИНАМИКУ: сравнивай текущий период с предыдущим, указывай направление тренда («восходящий тренд последние 3 месяца», «стабильный рост с начала квартала»).

Отвечай строго JSON-объектом без префиксов и текста до/после, без markdown-обёртки.

Ожидаемый формат ответа:
{
  "executive_summary": "3 абзаца на русском, разделённые \\n\\n. Первый абзац — главное достижение периода с конкретными цифрами роста. Второй — ключевые факторы роста и связь с выполненными работами. Третий — уверенный прогноз и направление дальнейшего развития.",
  "highlights": ["Каждый буллит начинается с конкретной цифры роста: «+25% кликов из Google (с 1200 до 1500)», «Рост видимости на +0.15 п.п.», «+48 новых запросов в ТОП-10»"],
  "growth_attribution": [
    {
      "metric": "Название метрики (например: «Клики из Google», «Показы в Google», «Клики из Яндекса», «Показы в Яндексе», «Видимость Keys.so», «Запросы в ТОП-10»)",
      "trend_direction": "up | stable | down",
      "delta_value": "Абсолютное изменение с числами: «+350 кликов» или «−12 запросов»",
      "delta_pct": "Процентное изменение: «+25.3%» или «−2.1%»",
      "attribution": "Что именно из выполненных работ повлияло на рост этой метрики — привяжи к конкретным задачам (1–2 предложения). Если метрика снизилась — объясни причину нейтрально (сезонность, переиндексация, ротация выдачи) и укажи, что это временное явление.",
      "conclusion": "Позитивный аналитический вывод: что рост этой метрики значит для бизнеса проекта. Если снижение — сформулируй как «точка роста» с конкретным планом (1 предложение).",
      "forecast": "Уверенный прогноз роста на 1–3 месяца с конкретными ожидаемыми цифрами, если они есть в данных (1 предложение).",
      "weak_zones": "Точки усиления для ещё большего роста — не критика, а возможности (1 предложение)."
    }
  ],
  "quick_wins": [{"query":"", "position": 12, "plan": ""}],
  "vulnerabilities": ["Формулируй не как проблемы, а как зоны потенциального роста"],
  "roadmap": ["..."],
  "traffic_value": "1-2 предложения про сэкономленный бюджет клиента"
}

ВАЖНО для growth_attribution:
- Сделай ОТДЕЛЬНЫЙ объект для КАЖДОЙ ключевой метрики: Google клики, Google показы, Яндекс клики, Яндекс показы, видимость Keys.so (Яндекс), видимость Keys.so (Google), ТОП-10 Яндекс / ТОП-10 Google, объём задач.
- Если данные Keys.so есть по обеим ПС (Яндекс и Google), анализируй их ОТДЕЛЬНО — это разные поисковые системы с разной выдачей.
- Всегда указывай trend_direction, delta_value и delta_pct на основе реальных данных.
- Если метрика выросла — начинай attribution со слова «Рост» и указывай конкретные цифры.
- Если метрика снизилась — начинай с нейтрального объяснения причины и сразу давай план действий.
- Для quick_wins используй запросы на позициях 11-15.
- Для roadmap дай 5-7 коротких пунктов на следующий месяц.
- Если данных по метрике нет — не выдумывай, просто пропусти её.`;

function _pctChange(curr, prev) {
  if (!prev || !Number.isFinite(prev) || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10; // 1 знак после запятой
}

function _seriesDelta(series, key = 'clicks') {
  if (!Array.isArray(series) || series.length < 2) return null;
  // Определяем, является ли последний бакет текущим (неполным) месяцем.
  // Если да — пропускаем его и берём два последних полных месяца.
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const fullMonths = series.filter((row) => {
    const m = String(row?.date || '').match(/^(\d{4})-(\d{2})/);
    if (!m) return true; // если формат не месяц — оставляем
    return !(+m[1] === curY && +m[2] === curM);
  });
  // Нужно минимум 2 полных месяца.
  const src = fullMonths.length >= 2 ? fullMonths : series;
  const last = Number(src[src.length - 1]?.[key]) || 0;
  const prev = Number(src[src.length - 2]?.[key]) || 0;
  return { last, prev, deltaPct: _pctChange(last, prev) };
}

function _buildMetricsDigest(data) {
  const gscClicksDelta = _seriesDelta(data.gsc?.series, 'clicks');
  const gscImprDelta = _seriesDelta(data.gsc?.series, 'impressions');
  const ywmClicksDelta = _seriesDelta(data.ywm?.series, 'clicks');
  const ywmImprDelta = _seriesDelta(data.ywm?.series, 'impressions');
  // Яндекс Keys.so (по умолчанию — top-level series/current для обратной совместимости)
  const ydxSeries = data.keys_so?.yandex?.series || data.keys_so?.series || [];
  const ydxCurrent = data.keys_so?.yandex?.current || data.keys_so?.current || null;
  const visDelta = _seriesDelta(ydxSeries, 'visibility');
  const top10Delta = _seriesDelta(ydxSeries, 'keywords_top10');
  // Google Keys.so
  const gglSeries = data.keys_so?.google?.series || [];
  const gglCurrent = data.keys_so?.google?.current || null;
  const gglVisDelta = _seriesDelta(gglSeries, 'visibility');
  const gglTop10Delta = _seriesDelta(gglSeries, 'keywords_top10');
  const tasks = data.tasks || {};

  return {
    gsc_clicks: data.gsc?.totals?.clicks || 0,
    gsc_clicks_delta_pct: gscClicksDelta?.deltaPct ?? null,
    gsc_clicks_prev: gscClicksDelta?.prev ?? null,
    gsc_clicks_last: gscClicksDelta?.last ?? null,
    gsc_impressions: data.gsc?.totals?.impressions || 0,
    gsc_impressions_delta_pct: gscImprDelta?.deltaPct ?? null,
    gsc_impressions_prev: gscImprDelta?.prev ?? null,
    gsc_impressions_last: gscImprDelta?.last ?? null,
    ywm_clicks: data.ywm?.totals?.clicks || 0,
    ywm_clicks_delta_pct: ywmClicksDelta?.deltaPct ?? null,
    ywm_clicks_prev: ywmClicksDelta?.prev ?? null,
    ywm_clicks_last: ywmClicksDelta?.last ?? null,
    ywm_impressions: data.ywm?.totals?.impressions || 0,
    ywm_impressions_delta_pct: ywmImprDelta?.deltaPct ?? null,
    ywm_impressions_prev: ywmImprDelta?.prev ?? null,
    ywm_impressions_last: ywmImprDelta?.last ?? null,
    // Яндекс Keys.so
    keys_so_visibility_current: ydxCurrent?.visibility ?? null,
    keys_so_visibility_delta_pct: visDelta?.deltaPct ?? null,
    keys_so_top10: ydxCurrent?.top10 ?? null,
    keys_so_top10_delta_pct: top10Delta?.deltaPct ?? null,
    keys_so_top10_prev: top10Delta?.prev ?? null,
    keys_so_top10_last: top10Delta?.last ?? null,
    keys_so_top3: ydxCurrent?.top3 ?? null,
    // Google Keys.so
    keys_so_google_visibility_current: gglCurrent?.visibility ?? null,
    keys_so_google_visibility_delta_pct: gglVisDelta?.deltaPct ?? null,
    keys_so_google_top10: gglCurrent?.top10 ?? null,
    keys_so_google_top10_delta_pct: gglTop10Delta?.deltaPct ?? null,
    keys_so_google_top10_prev: gglTop10Delta?.prev ?? null,
    keys_so_google_top10_last: gglTop10Delta?.last ?? null,
    keys_so_google_top3: gglCurrent?.top3 ?? null,
    tasks_total: tasks.total_generated || 0,
    tasks_by_type: tasks.by_type || {},
    forecast_clicks_3m: data.forecast?.gsc_clicks?.forecast || null,
    traffic_value: data.traffic_value?.estimated_savings || null,
    position_top10: data.position?.summary?.top10 || 0,
    quick_wins: (data.position?.quick_wins || []).slice(0, 8).map((item) => ({
      query: item.query,
      position: item.position,
    })),
    modules: _buildModulesDigest(data.modules),
  };
}

/**
 * Свод сигналов модулей отчёта (ТЗ §5) для AI Executive Summary: сколько точек
 * роста Striking Distance, разрывов CTR, проблемных по Content Health страниц,
 * состояние Off-Page и tech-audit. Возвращает null, если модули недоступны.
 */
function _buildModulesDigest(modules) {
  if (!modules || modules.disabled || modules.error) return null;
  const ex = modules.executive || {};
  const sd = ex.striking_distance || modules.striking_distance?.summary || {};
  const cg = ex.ctr_gap || modules.ctr_gap?.summary || {};
  const ch = ex.content_health || modules.content_health?.summary || {};
  const op = ex.off_page || modules.off_page?.summary || {};
  const ta = ex.tech_audit || modules.tech_audit?.summary || {};
  const topStriking = (modules.striking_distance?.items || []).slice(0, 5)
    .map((it) => ({ query: it.query, position: it.avg_position, priority: it.priority, score: it.opportunity_score }));
  const topCtrGaps = (modules.ctr_gap?.items || []).slice(0, 5)
    .map((it) => ({ query: it.query, position: it.position, ctr: it.ctr, benchmark: it.benchmark_ctr, level: it.level }));
  return {
    striking_distance: {
      total: sd.total || 0, high: sd.high || 0, medium: sd.medium || 0, low: sd.low || 0,
      opportunity_clicks: sd.total_opportunity_clicks || 0, top: topStriking,
    },
    ctr_gap: {
      total: cg.total || 0, critical: cg.critical || 0, warning: cg.warning || 0,
      lost_clicks: cg.lost_clicks || 0, top: topCtrGaps,
    },
    content_health: {
      avg_score: ch.avg_score ?? null, healthy: ch.healthy || 0,
      needs_work: ch.needs_work || 0, critical: ch.critical || 0,
    },
    off_page: {
      total: op.total || 0, indexed_yandex: op.indexed_yandex || 0,
      indexed_google: op.indexed_google || 0, broken: op.broken || 0, unique_donors: op.unique_donors || 0,
    },
    tech_audit: {
      pages: ta.pages || 0, images_no_alt: ta.images_no_alt || 0,
      images_non_webp: ta.images_non_webp || 0, broken: ta.broken || 0,
    },
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
    highlights.push(`+${digest.gsc_clicks_delta_pct}% кликов из Google (с ${(digest.gsc_clicks_prev || 0).toLocaleString('ru-RU')} до ${(digest.gsc_clicks_last || 0).toLocaleString('ru-RU')})`);
  }
  if (digest.gsc_impressions_delta_pct != null && digest.gsc_impressions_delta_pct > 0) {
    highlights.push(`+${digest.gsc_impressions_delta_pct}% показов в Google (с ${(digest.gsc_impressions_prev || 0).toLocaleString('ru-RU')} до ${(digest.gsc_impressions_last || 0).toLocaleString('ru-RU')})`);
  }
  if (digest.ywm_clicks_delta_pct != null && digest.ywm_clicks_delta_pct > 0) {
    highlights.push(`+${digest.ywm_clicks_delta_pct}% кликов из Яндекса`);
  }
  if (digest.ywm_impressions_delta_pct != null && digest.ywm_impressions_delta_pct > 0) {
    highlights.push(`+${digest.ywm_impressions_delta_pct}% показов в Яндексе`);
  }
  if (digest.keys_so_visibility_delta_pct != null && digest.keys_so_visibility_delta_pct > 0) {
    highlights.push(`+${digest.keys_so_visibility_delta_pct}% видимости в Keys.so`);
  }
  if (digest.keys_so_top10 != null) {
    highlights.push(`${digest.keys_so_top10} запросов в ТОП-10`);
  }
  if (totalTasks > 0) highlights.push(`Выполнено ${totalTasks} SEO-задач за период`);

  // Структурированный growth_attribution: по каждой ключевой метрике —
  // отдельный объект с trend_direction / delta_value / delta_pct / attribution /
  // conclusion / forecast / weak_zones. Без LLM мы даём детерминированные данные
  // с реальными числами, чтобы UI показывал динамику роста.
  const taskTypes = Object.entries(digest.tasks_by_type || {})
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  const taskMix = taskTypes.length ? taskTypes.join(', ') : 'комплексной работы команды';

  function _trendDir(delta) {
    if (delta == null) return '';
    return delta > 0 ? 'up' : (delta < 0 ? 'down' : 'stable');
  }
  function _deltaStr(last, prev, unit = '') {
    if (last == null || prev == null) return '';
    const diff = last - prev;
    const sign = diff >= 0 ? '+' : '';
    return `${sign}${Math.round(diff).toLocaleString('ru-RU')}${unit ? ' ' + unit : ''}`;
  }
  function _pctStr(pct) {
    if (pct == null) return '';
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct}%`;
  }

  const growth = [];
  if (digest.gsc_clicks != null && digest.gsc_clicks > 0) {
    const delta = digest.gsc_clicks_delta_pct;
    growth.push({
      metric: 'Клики из Google',
      trend_direction: _trendDir(delta),
      delta_value: _deltaStr(digest.gsc_clicks_last, digest.gsc_clicks_prev, 'кликов'),
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост кликов на ${_pctStr(delta)} обусловлен работой команды по направлениям: ${taskMix}. Контентная программа и оптимизация мета-тегов дают прямое увеличение CTR в выдаче.`
        : `Динамика обусловлена работой команды по направлениям: ${taskMix}. Контентная программа наполняет сайт релевантными страницами, оптимизация мета-тегов улучшает CTR в выдаче.`,
      conclusion: `Текущий уровень — ${digest.gsc_clicks.toLocaleString('ru-RU')} кликов за период.`,
      forecast: digest.forecast_clicks_3m && digest.forecast_clicks_3m.length
        ? `Прогноз на ближайшие 3 месяца: ${digest.forecast_clicks_3m.map((v) => Math.round(v).toLocaleString('ru-RU')).join(' → ')} кликов при сохранении текущего темпа работ.`
        : 'При сохранении текущего темпа работ ожидается продолжение положительной динамики в ближайшие 1–3 месяца.',
      weak_zones: 'Точка роста — масштабирование контентной программы и проработка страниц на позициях 11–20 для быстрого выхода в ТОП-10.',
    });
  }
  if (digest.gsc_impressions != null && digest.gsc_impressions > 0) {
    const delta = digest.gsc_impressions_delta_pct;
    growth.push({
      metric: 'Показы в Google',
      trend_direction: _trendDir(delta),
      delta_value: _deltaStr(digest.gsc_impressions_last, digest.gsc_impressions_prev, 'показов'),
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост объёма показов на ${_pctStr(delta)} — результат расширения семантического ядра и появления новых ранжирующихся страниц.`
        : 'Объём показов поддерживается за счёт индексации новых страниц и расширения охвата в поисковой выдаче.',
      conclusion: `За период — ${digest.gsc_impressions.toLocaleString('ru-RU')} показов в Google.`,
      forecast: 'Рост показов создаёт базу для дальнейшего увеличения кликов и трафика.',
      weak_zones: 'Потенциал — увеличение CTR по запросам с высоким объёмом показов через доработку title и description.',
    });
  }
  if (digest.ywm_clicks != null && digest.ywm_clicks > 0) {
    const delta = digest.ywm_clicks_delta_pct;
    growth.push({
      metric: 'Клики из Яндекса',
      trend_direction: _trendDir(delta),
      delta_value: _deltaStr(digest.ywm_clicks_last, digest.ywm_clicks_prev, 'кликов'),
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост на ${_pctStr(delta)} поддерживается технической оптимизацией и работой над поведенческими факторами.`
        : 'Динамика поддерживается технической оптимизацией и работой над поведенческими факторами.',
      conclusion: `За период собрано ${digest.ywm_clicks.toLocaleString('ru-RU')} кликов из Яндекса.`,
      forecast: 'Ожидается дальнейший прирост по мере индексации новых страниц.',
      weak_zones: 'Зона развития — низкочастотные региональные запросы и усиление внутренней перелинковки.',
    });
  }
  if (digest.ywm_impressions != null && digest.ywm_impressions > 0) {
    const delta = digest.ywm_impressions_delta_pct;
    growth.push({
      metric: 'Показы в Яндексе',
      trend_direction: _trendDir(delta),
      delta_value: _deltaStr(digest.ywm_impressions_last, digest.ywm_impressions_prev, 'показов'),
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост показов на ${_pctStr(delta)} связан с расширением семантического охвата и индексацией нового контента.`
        : 'Охват поддерживается за счёт текущего контента и расширения семантического ядра.',
      conclusion: `За период — ${digest.ywm_impressions.toLocaleString('ru-RU')} показов в Яндексе.`,
      forecast: 'Увеличение показов — индикатор роста охвата; это база для роста кликов в следующих периодах.',
      weak_zones: 'Потенциал — проработка коммерческих запросов с высоким объёмом показов для увеличения конверсии в клики.',
    });
  }
  if (digest.keys_so_visibility_current != null) {
    const delta = digest.keys_so_visibility_delta_pct;
    growth.push({
      metric: 'Видимость Keys.so (Яндекс)',
      trend_direction: _trendDir(delta),
      delta_value: '',
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост видимости на ${_pctStr(delta)} связан с появлением новых ранжирующихся страниц и улучшением позиций после оптимизации мета-тегов и ссылочной работы.`
        : 'Видимость поддерживается за счёт текущих ранжирующихся страниц и ссылочного профиля.',
      conclusion: `Текущая видимость в Яндексе — ${(Number(digest.keys_so_visibility_current) * 100).toFixed(2)}%; запросов в ТОП-10: ${digest.keys_so_top10 ?? '—'}.`,
      forecast: 'При сохранении темпа публикации и линкбилдинга видимость продолжит укрепляться.',
      weak_zones: 'Зона развития — запросы в striking distance (позиции 11–20) и кластеры с отставанием по контенту.',
    });
  }
  if (digest.keys_so_google_visibility_current != null) {
    const delta = digest.keys_so_google_visibility_delta_pct;
    growth.push({
      metric: 'Видимость Keys.so (Google)',
      trend_direction: _trendDir(delta),
      delta_value: '',
      delta_pct: _pctStr(delta),
      attribution: delta != null && delta > 0
        ? `Рост видимости в Google на ${_pctStr(delta)} обусловлен индексацией новых страниц и улучшением позиций по ключевым кластерам.`
        : 'Видимость в Google поддерживается за счёт текущих ранжирующихся страниц.',
      conclusion: `Текущая видимость в Google — ${(Number(digest.keys_so_google_visibility_current) * 100).toFixed(2)}%; запросов в ТОП-10: ${digest.keys_so_google_top10 ?? '—'}.`,
      forecast: 'Ожидается дальнейшее укрепление позиций в Google при сохранении темпа контентной и ссылочной работы.',
      weak_zones: 'Точка роста — оптимизация страниц на позициях 11–20 в Google для быстрого выхода в ТОП-10.',
    });
  }
  if (totalTasks > 0) {
    growth.push({
      metric: 'Объём выполненных работ',
      trend_direction: 'up',
      delta_value: `${totalTasks} задач`,
      delta_pct: '',
      attribution: `За период выполнено ${totalTasks} задач по направлениям: ${taskMix}. Системная работа создаёт кумулятивный эффект — результат проявляется на горизонте 1–3 месяцев.`,
      conclusion: 'Темп работ соответствует SEO-стратегии и обеспечивает накопительный эффект.',
      forecast: 'При сохранении темпа ожидается планомерное расширение семантического ядра и укрепление позиций.',
      weak_zones: 'Точка усиления — балансировка задач между контентом, ссылочным и техническим аудитом.',
    });
  }
  if (!growth.length) {
    growth.push({
      metric: 'Общая динамика',
      trend_direction: 'stable',
      delta_value: '',
      delta_pct: '',
      attribution: 'Текущая динамика обеспечена комплексной работой команды: контентная программа, оптимизация мета-тегов, ссылочная и техническая работа.',
      conclusion: 'Проект стабильно развивается по основным SEO-направлениям.',
      forecast: 'При сохранении текущего темпа работ ожидается продолжение положительной динамики в ближайшие 1–3 месяца.',
      weak_zones: 'Точка роста — расширение семантического ядра и системная работа со страницами на границе ТОП-10 (позиции 11–20).',
    });
  }

  const quickWins = (digest.quick_wins || []).map((item) => ({
    query: item.query,
    position: item.position,
    plan: 'Усилить релевантность страницы, расширить сниппет и внутреннюю перелинковку, чтобы дожать запрос в ТОП-10.',
  }));
  const vulnerabilities = [
    'Часть запросов ещё находится в диапазоне 11–15 позиций и требует точечной дожимки.',
    'Не все кластеры получили одинаковую плотность контента и внутренних ссылок.',
  ];
  const roadmap = [
    'Дожать запросы из зоны 11–15 в ТОП-10.',
    'Продолжить публикацию и обновление SEO-страниц по приоритетным кластерам.',
    'Расширить внутреннюю перелинковку между посадочными и информационными страницами.',
    'Усилить CTR через доработку title/description для страниц с высоким impression-share.',
    'Поддержать рост видимости публикацией новых материалов и техработами.',
  ];

  return {
    executive_summary: parts.join('\n\n'),
    highlights: highlights.length ? highlights : ['За период выполнен запланированный объём работ.'],
    growth_attribution: growth,
    quick_wins: quickWins,
    vulnerabilities,
    roadmap,
    traffic_value: digest.traffic_value
      ? `Ориентировочная экономия рекламного бюджета за период — около ${Number(digest.traffic_value).toLocaleString('ru-RU')} ₽ по данным Keys.so.`
      : '',
    fallback: true,
  };
}

async function generateSummary(data, opts = {}) {
  const brandName = String(opts.brandName || data.project?.name || 'Проект');
  const period = String(opts.period || '');
  const digest = _buildMetricsDigest(data);
  const tasksList = _buildTasksList(data);

  // ── Pass 1: Анализ трафика (GSC + Яндекс.Вебмастер + задачи) ───────────
  const pass1Prompt = [
    `Проект: ${brandName}`,
    `Период: ${period}`,
    `Метрики трафика (JSON): ${JSON.stringify({
      gsc_clicks: digest.gsc_clicks, gsc_clicks_delta_pct: digest.gsc_clicks_delta_pct,
      gsc_clicks_prev: digest.gsc_clicks_prev, gsc_clicks_last: digest.gsc_clicks_last,
      gsc_impressions: digest.gsc_impressions, gsc_impressions_delta_pct: digest.gsc_impressions_delta_pct,
      gsc_impressions_prev: digest.gsc_impressions_prev, gsc_impressions_last: digest.gsc_impressions_last,
      ywm_clicks: digest.ywm_clicks, ywm_clicks_delta_pct: digest.ywm_clicks_delta_pct,
      ywm_clicks_prev: digest.ywm_clicks_prev, ywm_clicks_last: digest.ywm_clicks_last,
      ywm_impressions: digest.ywm_impressions, ywm_impressions_delta_pct: digest.ywm_impressions_delta_pct,
      ywm_impressions_prev: digest.ywm_impressions_prev, ywm_impressions_last: digest.ywm_impressions_last,
      tasks_total: digest.tasks_total, tasks_by_type: digest.tasks_by_type,
      forecast_clicks_3m: digest.forecast_clicks_3m,
    })}`,
    `Выполненные работы:\n${tasksList || '— нет данных —'}`,
    '',
    'ЗАДАНИЕ: Сформируй ЧАСТЬ отчёта про ТРАФИК (Google + Яндекс) в формате JSON:',
    '{',
    '  "traffic_highlights": ["3-4 пункта про трафик, каждый с цифрами"],',
    '  "traffic_growth": [массив объектов growth_attribution ТОЛЬКО для: Google клики, Google показы, Яндекс клики, Яндекс показы],',
    '  "traffic_summary": "1-2 абзаца про динамику трафика с конкретными числами"',
    '}',
    'Каждый growth-объект: {metric, trend_direction, delta_value, delta_pct, attribution, conclusion, forecast, weak_zones}.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  // ── Pass 2: Анализ видимости Keys.so (Яндекс + Google) + позиции ───────
  const pass2Prompt = [
    `Проект: ${brandName}`,
    `Период: ${period}`,
    `Метрики видимости Keys.so (JSON): ${JSON.stringify({
      yandex: {
        visibility: digest.keys_so_visibility_current, visibility_delta_pct: digest.keys_so_visibility_delta_pct,
        top10: digest.keys_so_top10, top10_delta_pct: digest.keys_so_top10_delta_pct,
        top10_prev: digest.keys_so_top10_prev, top10_last: digest.keys_so_top10_last,
        top3: digest.keys_so_top3,
      },
      google: {
        visibility: digest.keys_so_google_visibility_current, visibility_delta_pct: digest.keys_so_google_visibility_delta_pct,
        top10: digest.keys_so_google_top10, top10_delta_pct: digest.keys_so_google_top10_delta_pct,
        top10_prev: digest.keys_so_google_top10_prev, top10_last: digest.keys_so_google_top10_last,
        top3: digest.keys_so_google_top3,
      },
      position_top10: digest.position_top10,
      traffic_value: digest.traffic_value,
      tasks_total: digest.tasks_total,
    })}`,
    `Выполненные работы:\n${tasksList || '— нет данных —'}`,
    '',
    'ЗАДАНИЕ: Сформируй ЧАСТЬ отчёта про ВИДИМОСТЬ в поисковых системах в формате JSON:',
    '{',
    '  "visibility_highlights": ["2-3 пункта про видимость с цифрами"],',
    '  "visibility_growth": [массив объектов growth_attribution для: Видимость Keys.so (Яндекс), Видимость Keys.so (Google), ТОП-10 Яндекс, ТОП-10 Google, Объём работ],',
    '  "visibility_summary": "1-2 абзаца про динамику видимости в обеих ПС с конкретными числами",',
    '  "traffic_value": "1-2 предложения про сэкономленный бюджет"',
    '}',
    'Каждый growth-объект: {metric, trend_direction, delta_value, delta_pct, attribution, conclusion, forecast, weak_zones}.',
    'Если данных по Google Keys.so нет — пропусти эту метрику.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  // ── Pass 3: Синтез — executive summary, roadmap, quick wins ─────────────
  const pass3PromptBase = [
    `Проект: ${brandName}`,
    `Период: ${period}`,
    `Все метрики (JSON): ${JSON.stringify(digest)}`,
    `Quick Wins: ${JSON.stringify(digest.quick_wins)}`,
  ];
  if (digest.modules) {
    pass3PromptBase.push(
      `Сигналы модулей отчёта (Striking Distance, CTR Gap, Content Health, Off-Page, Tech Audit) (JSON): ${JSON.stringify(digest.modules)}`,
    );
  }

  // Run passes 1 & 2 in parallel
  const [result1, result2] = await Promise.all([
    runAnalyst(SYSTEM_PROMPT, pass1Prompt, { kind: 'reports_traffic', temperature: 0.3, maxTokens: 1500 }),
    runAnalyst(SYSTEM_PROMPT, pass2Prompt, { kind: 'reports_visibility', temperature: 0.3, maxTokens: 1500 }),
  ]);

  const parsed1 = result1.verdict === 'ok' ? _safeJson(result1.markdown) : null;
  const parsed2 = result2.verdict === 'ok' ? _safeJson(result2.markdown) : null;

  // If both LLM calls failed, use fallback
  if (!parsed1 && !parsed2) {
    return { ...(_fallbackSummary(brandName, period, digest)), provider: result1.verdict, model: result1.model || null };
  }

  // Build context from passes 1 & 2 for synthesis
  const pass3Prompt = [
    ...pass3PromptBase,
    '',
    `Результат анализа трафика: ${JSON.stringify(parsed1 || {})}`,
    `Результат анализа видимости: ${JSON.stringify(parsed2 || {})}`,
    '',
    'ЗАДАНИЕ: На основе двух предыдущих анализов сформируй ИТОГОВЫЙ отчёт в формате JSON:',
    '{',
    '  "executive_summary": "3 абзаца: 1) главное достижение с числами, 2) факторы роста и связь с работами, 3) прогноз",',
    '  "highlights": ["3-5 ярких пунктов, каждый начинается с цифры роста"],',
    '  "quick_wins": [{query, position, plan}],',
    '  "vulnerabilities": ["зоны потенциального роста"],',
    '  "roadmap": ["5-7 коротких пунктов на следующий месяц"],',
    '  "traffic_value": "1-2 предложения"',
    '}',
    'Используй РЕАЛЬНЫЕ числа. executive_summary должен учитывать и Яндекс, и Google.',
    'Если есть «Сигналы модулей отчёта» — используй их: точки роста Striking Distance (с opportunity_score), разрывы CTR Gap (critical/warning), проблемные страницы Content Health, состояние Off-Page и tech-audit — отрази их в highlights, vulnerabilities и roadmap.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  const result3 = await runAnalyst(SYSTEM_PROMPT, pass3Prompt, {
    kind: 'reports_synthesis',
    temperature: 0.3,
    maxTokens: 2000,
  });

  const parsed3 = result3.verdict === 'ok' ? _safeJson(result3.markdown) : null;

  // Merge growth_attribution from passes 1 & 2
  const allGrowth = [
    ..._normalizeGrowthAttribution(parsed1?.traffic_growth),
    ..._normalizeGrowthAttribution(parsed2?.visibility_growth),
  ];

  // Merge highlights
  const allHighlights = [
    ...(parsed1?.traffic_highlights || []).map(String),
    ...(parsed2?.visibility_highlights || []).map(String),
  ].slice(0, 8);

  if (parsed3 && parsed3.executive_summary) {
    return {
      executive_summary: String(parsed3.executive_summary),
      highlights: parsed3.highlights?.length ? _normalizeStringList(parsed3.highlights, 8) : allHighlights,
      growth_attribution: allGrowth.length ? allGrowth : _normalizeGrowthAttribution(parsed3.growth_attribution),
      quick_wins: _normalizeQuickWins(parsed3.quick_wins),
      vulnerabilities: _normalizeStringList(parsed3.vulnerabilities, 8),
      roadmap: _normalizeStringList(parsed3.roadmap, 10),
      traffic_value: String(parsed3.traffic_value || parsed2?.traffic_value || '').trim(),
      provider: result3.provider,
      model: result3.model,
      tokens_in: (result1.tokens_in || 0) + (result2.tokens_in || 0) + (result3.tokens_in || 0),
      tokens_out: (result1.tokens_out || 0) + (result2.tokens_out || 0) + (result3.tokens_out || 0),
    };
  }

  // Pass 3 failed — assemble from passes 1 & 2
  return {
    executive_summary: [parsed1?.traffic_summary || '', parsed2?.visibility_summary || ''].filter(Boolean).join('\n\n') || _fallbackSummary(brandName, period, digest).executive_summary,
    highlights: allHighlights.length ? allHighlights : _fallbackSummary(brandName, period, digest).highlights,
    growth_attribution: allGrowth,
    quick_wins: _normalizeQuickWins(digest.quick_wins),
    vulnerabilities: _fallbackSummary(brandName, period, digest).vulnerabilities,
    roadmap: _fallbackSummary(brandName, period, digest).roadmap,
    traffic_value: String(parsed2?.traffic_value || '').trim(),
    provider: result1.provider || result2.provider,
    model: result1.model || result2.model,
    tokens_in: (result1.tokens_in || 0) + (result2.tokens_in || 0),
    tokens_out: (result1.tokens_out || 0) + (result2.tokens_out || 0),
  };
}

function _normalizeQuickWins(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    query: String(item?.query || item?.keyword || '').trim(),
    position: item?.position == null ? null : Number(item.position),
    plan: String(item?.plan || item?.action || '').trim(),
  })).filter((item) => item.query || item.plan).slice(0, 12);
}

function _normalizeStringList(raw, limit) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit);
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
      trend_direction: '',
      delta_value: '',
      delta_pct: '',
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
          metric: '', trend_direction: '', delta_value: '', delta_pct: '',
          attribution: t, conclusion: '', forecast: '', weak_zones: '',
        } : null;
      }
      if (typeof item !== 'object') return null;
      const metric = String(item.metric || item.name || '').trim();
      const trend_direction = String(item.trend_direction || '').trim();
      const delta_value = String(item.delta_value || '').trim();
      const delta_pct = String(item.delta_pct || '').trim();
      const attribution = String(item.attribution || item.cause || '').trim();
      const conclusion = String(item.conclusion || '').trim();
      const forecast = String(item.forecast || item.prediction || '').trim();
      const weak_zones = String(item.weak_zones || item.weakZones || item.weakness || '').trim();
      if (!metric && !attribution && !conclusion && !forecast && !weak_zones) return null;
      return { metric, trend_direction, delta_value, delta_pct, attribution, conclusion, forecast, weak_zones };
    })
    .filter(Boolean)
    .slice(0, 10);
}

module.exports = {
  generateSummary,
  _buildMetricsDigest,
  _safeJson,
  _normalizeGrowthAttribution,
};
