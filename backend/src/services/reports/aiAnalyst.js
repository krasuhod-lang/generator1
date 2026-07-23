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
 *     next_month_forecast, traffic_value, model, provider }
 *
 * При недоступности LLM возвращает детерминированный fallback на основе чисел
 * (без вранья — только факты), чтобы кнопка «Сгенерировать» в UI не
 * деградировала в ошибку при отсутствии API-ключей.
 */

const { runAnalyst } = require('../projects/llmAnalyst');

const SYSTEM_PROMPT = `Ты — SEO-аналитик, который готовит ежемесячный отчёт для инвесторов и топ-менеджмента. Твоя главная задача — убедительно показать прогресс и рост проекта. Пиши профессионально, уверенно, позитивно, но без жаргона.

ГЛАВНОЕ ПРАВИЛО ПО ЦИФРАМ:
Ты НЕ считаешь и НЕ придумываешь числа. Все числовые показатели (абсолютные значения, дельты, проценты, тренды) уже посчитаны математически из итогов графиков и подставляются в отчёт автоматически. Твоя задача — ТОЛЬКО текстовый анализ: тезисно объяснить закономерности и связи (например, «сайт вырос по видимости → выросли клики»), привязать динамику к выполненным работам. Опирайся исключительно на числа, переданные тебе во входных данных, и никогда не выдумывай значения, которых там нет. В полях delta_value/delta_pct можешь оставлять пустые строки — система подставит корректные значения сама.

КЛЮЧЕВЫЕ ПРАВИЛА ТОНА:
1. В executive_summary и highlights — подчёркивай ИСКЛЮЧИТЕЛЬНО положительные тренды, достижения, рекорды и прогресс. Связывай каждый рост с конкретными выполненными работами команды. Даже если рост небольшой — подай его как значимый результат («стабильный прирост», «уверенная положительная динамика»).
2. Если по какой-то метрике есть снижение — упомяни его КРАТКО и ВСКОЛЬЗЬ (не более 1 предложения), сразу переведи фокус на причину и план восстановления. Никогда не акцентируй внимание на негативе.
3. В growth_attribution анализируй КАЖДУЮ метрику ОТДЕЛЬНО как отдельный график. Пиши ТЕЗИСНО: что произошло с показателем и почему, какие закономерности прослеживаются, за счёт каких работ. Числа в delta_value/delta_pct подставит система — не выдумывай их. Если есть снижение — сформулируй мягко как «корректировка» или «стабилизация после пикового периода» и укажи конкретный план действий для возврата к росту.
4. Обязательно показывай ДИНАМИКУ НА ПРОТЯЖЕНИИ ПОСЛЕДНИХ 3 МЕСЯЦЕВ: используй помесячные ряды (поля *_trend_3m) — опиши, как двигался показатель от месяца к месяцу (например, «третий месяц подряд восходящий тренд», «после стабилизации во втором месяце — ускорение в третьем»), а не только сравнение последнего месяца с предыдущим.
4a. Обязательно учитывай ДАТУ ФОРМИРОВАНИЯ ОТЧЁТА (report_generated_at) и ДАТУ СЪЁМА ПОКАЗАТЕЛЕЙ по каждому источнику (metrics_captured_at). Если данные сняты заметно раньше даты отчёта или последний месяц ещё не завершён — не трактуй неполный/устаревший последний период как спад; ориентируйся на завершённые месяцы из *_trend_3m.
5. Обязательно выделяй **жирным шрифтом** (двойными звёздочками markdown) ключевые тезисы, чтобы они сразу бросались в глаза при чтении.
6. Если метрика снизилась, обязательно предложи гипотезу причины: сезонность спроса, обновление алгоритмов Яндекса/Google или усиление давления конкурентов. Формулируй причину нейтрально и сразу давай план возврата к росту.
7. Чётко указывай, за счёт чего произошёл рост: вывод новых страниц, улучшение CTR сниппетов, рост позиций по кластерам, расширение семантики или технические доработки. Привязывай рост к конкретным выполненным работам.
8. НЕ упоминай количество выполненных задач и не считай их — это не показатель для отчёта. Работы упоминай качественно (какие направления велись), но без чисел «выполнено N задач».

Отвечай строго JSON-объектом без префиксов и текста до/после, без markdown-обёртки.

Ожидаемый формат ответа:
{
  "executive_summary": "3 абзаца на русском, разделённые \\n\\n. Первый абзац — главное достижение периода с конкретными цифрами роста. Второй — ключевые факторы роста и связь с выполненными работами. Третий — уверенный прогноз и направление дальнейшего развития.",
  "highlights": ["Каждый буллит начинается с конкретной цифры роста: «+25% кликов из Google (с 1200 до 1500)», «Рост видимости на +0.15 п.п.», «+48 новых запросов в ТОП-10»"],
  "growth_attribution": [
    {
      "metric": "Название метрики (например: «Клики из Google», «Показы в Google», «Клики из Яндекса», «Показы в Яндексе», «Видимость Keys.so», «Запросы в ТОП-10»)",
      "trend_direction": "оставь пустым — система проставит up | stable | down сама",
      "delta_value": "оставь пустым — система подставит абсолютное изменение из математически посчитанных итогов",
      "delta_pct": "оставь пустым — система подставит процентное изменение сама",
      "attribution": "Что именно из выполненных работ повлияло на динамику этой метрики — тезисно, привяжи к направлениям работ (1–2 предложения). Если метрика снизилась — предложи гипотезу причины (сезонность спроса, обновление алгоритмов Яндекса/Google, давление конкурентов) и укажи, что это временное явление.",
      "conclusion": "Позитивный аналитический вывод: что динамика этой метрики значит для бизнеса проекта. Если снижение — сформулируй как «точка роста» с конкретным планом (1 предложение).",
      "forecast": "Уверенный прогноз развития на 1–3 месяца (1 предложение, без выдуманных цифр).",
      "weak_zones": "Точки усиления для ещё большего роста — не критика, а возможности (1 предложение)."
    }
  ],
  "quick_wins": [{"query":"", "position": 12, "plan": ""}],
  "next_month_forecast": "string (1-2 предложения — качественный прогноз направления роста на следующий месяц на основе текущей динамики)",
  "traffic_value": "1-2 предложения про сэкономленный бюджет клиента"
}

ВАЖНО для growth_attribution:
- Сделай ОТДЕЛЬНЫЙ объект для КАЖДОЙ ключевой метрики: Google клики, Google показы, Яндекс клики, Яндекс показы, видимость Keys.so (Яндекс), видимость Keys.so (Google), ТОП-10 Яндекс / ТОП-10 Google. НЕ добавляй метрику про объём/количество задач.
- Если данные Keys.so есть по обеим ПС (Яндекс и Google), анализируй их ОТДЕЛЬНО — это разные поисковые системы с разной выдачей.
- Поля trend_direction, delta_value и delta_pct оставляй пустыми — их подставит система из математически посчитанных чисел. Ты только пишешь текстовый анализ.
- Пиши тезисно и указывай, ЗА СЧЁТ ЧЕГО менялась метрика (новые страницы, CTR, позиции), не выдумывая чисел.
- Если метрика снизилась — начинай с нейтральной ГИПОТЕЗЫ причины (сезонность, обновление алгоритмов Яндекса/Google, конкуренты) и сразу давай план действий.
- Для quick_wins используй запросы на позициях 11-15.
- Для next_month_forecast дай конкретный прогноз роста на следующий месяц с ожидаемыми цифрами на основе текущей динамики.
- Если данных по метрике нет — не выдумывай, просто пропусти её.`;

// ── Линейная регрессия по ряду графика ─────────────────────────────────────
// Точная копия _linregress из frontend/src/components/reports/ReportTrendChart.vue
// (панель «Динамика за период»). Держим единый метод, чтобы числа в разделе
// «Анализ показателей» совпадали с трендом, который клиент видит на графике.
// Регрессия строится по ВСЕМ точкам ряда «как на графике» (включая текущий
// неполный месяц) — это осознанный выбор ради визуального совпадения цифр.
function _linregress(data) {
  const pts = [];
  (data || []).forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    pts.push([i, v]);
  });
  if (pts.length < 2) {
    const only = pts.length === 1 ? pts[0][1] : null;
    return { slope: 0, intercept: only, fitFirst: only, fitLast: only, n: pts.length };
  }
  const n = pts.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return {
    slope,
    intercept,
    fitFirst: slope * pts[0][0] + intercept,
    fitLast: slope * pts[pts.length - 1][0] + intercept,
    n,
  };
}

// Извлекает значения ряда по ключу «как на графике»: series.map(r => r[key]).
// Секцию принимает в форме {series} или «сырым» массивом серии.
function _seriesValues(input, key) {
  const section = Array.isArray(input) ? { series: input } : (input || {});
  const series = Array.isArray(section.series) ? section.series : [];
  return series.map((r) => (r && r[key] != null ? Number(r[key]) : null));
}

/**
 * Считает регрессионный тренд ряда графика по ключу и возвращает
 * { first: fitLast_начала, last: fitLast_конца, delta, pct, dir } —
 * идентично панели «Динамика за период» на фронте (trendSummary):
 *   delta = fitLast − fitFirst; pct = delta / |fitFirst| × 100; dir по знаку slope.
 * Возвращает null, если точек меньше двух (тренд не определён — цифру скрываем).
 */
function _regressAttr(input, key) {
  const values = _seriesValues(input, key);
  const { slope, fitFirst, fitLast, n } = _linregress(values);
  if (fitFirst === null || fitLast === null || n < 2) return null;
  const delta = fitLast - fitFirst;
  const pct = fitFirst !== 0 ? (delta / Math.abs(fitFirst)) * 100 : null;
  const dir = slope > 0 ? 'up' : (slope < 0 ? 'down' : 'stable');
  return { first: fitFirst, last: fitLast, delta, pct, dir };
}

// Округление процента до 1 знака для хранения в digest (текст fallback/промпта).
function _round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

// ── Форматтеры числовых полей growth_attribution ───────────────────────────
// Вынесены в модульную область: используются и детерминированным fallback'ом,
// и «канонизацией» чисел (см. _applyCanonicalNumbers). Числа считаются ТОЛЬКО
// математически (из итогов графиков), ИИ их не выдумывает. Формат — ru-RU с
// 1 знаком после запятой, чтобы совпадать с _fmtDelta/_fmtPct на графике.
function _trendDir(delta) {
  if (delta == null) return '';
  return delta > 0 ? 'up' : (delta < 0 ? 'down' : 'stable');
}
function _deltaStr(last, prev, unit = '') {
  if (last == null || prev == null) return '';
  const diff = last - prev;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${Number(diff).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}${unit ? ' ' + unit : ''}`;
}
function _pctStr(pct) {
  if (pct == null) return '';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Number(pct).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

/**
 * Классифицирует название метрики (из ответа LLM или fallback) в логический id,
 * чтобы подставить в growth_attribution математически посчитанные числа.
 * Возвращает null, если метрику распознать не удалось.
 */
function _classifyMetric(metric) {
  const m = String(metric || '').toLowerCase();
  const isGoogle = m.includes('google') || m.includes('гугл');
  const isYandex = m.includes('яндек') || m.includes('yandex');
  if (m.includes('видим')) return isGoogle ? 'keys_so_google_visibility' : 'keys_so_visibility';
  if (m.includes('топ-10') || m.includes('топ 10') || m.includes('top-10') || m.includes('top10')) {
    return isGoogle ? 'keys_so_google_top10' : 'keys_so_top10';
  }
  if (m.includes('показ')) {
    if (isGoogle) return 'gsc_impressions';
    if (isYandex) return 'ywm_impressions';
    return null;
  }
  if (m.includes('клик')) {
    if (isGoogle) return 'gsc_clicks';
    if (isYandex) return 'ywm_clicks';
    return null;
  }
  return null;
}

/**
 * Карта «id метрики → математически посчитанные числовые поля»
 * (trend_direction / delta_value / delta_pct). Все значения берутся из digest,
 * который собран из итогов графиков (dataAggregator), а не из ответа LLM.
 */
function _canonicalNumbers(digest) {
  const map = {};
  // dir — направление берётся по знаку slope регрессии (совпадает с графиком).
  // Для прямой аппроксимации знак delta всегда равен знаку slope, поэтому
  // _trendDir(pct) — корректный fallback, если dir не передан.
  const put = (id, last, prev, pct, unit, dir) => {
    map[id] = {
      trend_direction: dir || _trendDir(pct),
      delta_value: (last != null && prev != null) ? _deltaStr(last, prev, unit) : '',
      delta_pct: _pctStr(pct),
    };
  };
  put('gsc_clicks', digest.gsc_clicks_last, digest.gsc_clicks_prev, digest.gsc_clicks_delta_pct, 'кликов', digest.gsc_clicks_dir);
  put('gsc_impressions', digest.gsc_impressions_last, digest.gsc_impressions_prev, digest.gsc_impressions_delta_pct, 'показов', digest.gsc_impressions_dir);
  put('ywm_clicks', digest.ywm_clicks_last, digest.ywm_clicks_prev, digest.ywm_clicks_delta_pct, 'кликов', digest.ywm_clicks_dir);
  put('ywm_impressions', digest.ywm_impressions_last, digest.ywm_impressions_prev, digest.ywm_impressions_delta_pct, 'показов', digest.ywm_impressions_dir);
  // Видимость Keys.so: абсолютная дельта намеренно скрыта (last/prev=null) —
  // в единицах видимости абсолют близок к нулю и неинформативен; показываем
  // только процент и направление (по регрессии, как на графике).
  put('keys_so_visibility', null, null, digest.keys_so_visibility_delta_pct, '', digest.keys_so_visibility_dir);
  put('keys_so_google_visibility', null, null, digest.keys_so_google_visibility_delta_pct, '', digest.keys_so_google_visibility_dir);
  put('keys_so_top10', digest.keys_so_top10_last, digest.keys_so_top10_prev, digest.keys_so_top10_delta_pct, 'запросов', digest.keys_so_top10_dir);
  put('keys_so_google_top10', digest.keys_so_google_top10_last, digest.keys_so_google_top10_prev, digest.keys_so_google_top10_delta_pct, 'запросов', digest.keys_so_google_top10_dir);
  return map;
}

/**
 * Подставляет в каждый объект growth_attribution математически посчитанные
 * числа (trend_direction / delta_value / delta_pct), заменяя любые значения,
 * пришедшие от LLM. Если метрику распознать не удалось — числовые поля
 * очищаются, чтобы в отчёт не попали выдуманные ИИ цифры. Текстовый анализ
 * (attribution / conclusion / forecast / weak_zones) остаётся от LLM.
 */
function _applyCanonicalNumbers(growth, digest) {
  if (!Array.isArray(growth)) return [];
  const canon = _canonicalNumbers(digest);
  return growth.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const id = _classifyMetric(item.metric);
    const nums = id ? canon[id] : null;
    if (nums) {
      return { ...item, trend_direction: nums.trend_direction, delta_value: nums.delta_value, delta_pct: nums.delta_pct };
    }
    return { ...item, trend_direction: '', delta_value: '', delta_pct: '' };
  });
}

/**
 * Возвращает помесячные бакеты ТОЛЬКО за полные (календарно закрытые + с
 * учётом лага источника) месяцы. Приоритетно берём авторитетный
 * `series_meta.monthly_periods` (см. dataAggregator/periodResolver), где
 * `is_complete` уже учитывает закрытие месяца, лаг выгрузки и отставание
 * источника. Если меты нет (напр. Keys.so) — падаем на серию, исключая
 * текущий календарный месяц по дате бакета.
 *
 * Принимает секцию `{series, series_meta}` или «сырой» массив серии.
 * Возвращает массив бакетов, где значение метрики лежит по ключу `key`.
 */
function _completeMonths(input) {
  const section = Array.isArray(input) ? { series: input } : (input || {});
  const monthly = section.series_meta && Array.isArray(section.series_meta.monthly_periods)
    ? section.series_meta.monthly_periods
    : null;
  if (monthly) {
    return monthly.filter((m) => m && m.is_complete);
  }
  // Fallback без меты: исключаем текущий (неполный) календарный месяц.
  const series = Array.isArray(section.series) ? section.series : [];
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  return series.filter((row) => {
    const m = String(row?.date || '').match(/^(\d{4})-(\d{2})/);
    if (!m) return true; // если формат не месяц — оставляем
    return !(+m[1] === curY && +m[2] === curM);
  });
}

/**
 * Тренд метрики за последние N полных месяцев (по умолчанию 3) — чтобы AI
 * анализировал ДИНАМИКУ на протяжении квартала, а не только «последний месяц
 * vs предыдущий». Текущий неполный месяц исключается (сравнение «23 дня vs
 * полный месяц» даёт ложные минусы). Возвращает массив
 * [{ month: 'YYYY-MM', value }] от старого к новому.
 */
function _seriesTrend(input, key = 'clicks', maxPoints = 3) {
  const src = _completeMonths(input);
  if (!Array.isArray(src) || !src.length) return [];
  return src.slice(-maxPoints).map((row) => ({
    month: String(row?.key || row?.date || '').slice(0, 7),
    value: Number(row?.[key]) || 0,
  }));
}

function _buildMetricsDigest(data) {
  // Дельты считаем регрессией по всему ряду графика (панель «Динамика за
  // период»), а не сравнением «последний полный месяц vs предыдущий».
  const gscClicksDelta = _regressAttr(data.gsc, 'clicks');
  const gscImprDelta = _regressAttr(data.gsc, 'impressions');
  const ywmClicksDelta = _regressAttr(data.ywm, 'clicks');
  const ywmImprDelta = _regressAttr(data.ywm, 'impressions');
  // Яндекс Keys.so (по умолчанию — top-level series/current для обратной совместимости)
  const ydxSeries = data.keys_so?.yandex?.series || data.keys_so?.series || [];
  const ydxCurrent = data.keys_so?.yandex?.current || data.keys_so?.current || null;
  const visDelta = _regressAttr(ydxSeries, 'visibility');
  const top10Delta = _regressAttr(ydxSeries, 'keywords_top10');
  // Google Keys.so
  const gglSeries = data.keys_so?.google?.series || [];
  const gglCurrent = data.keys_so?.google?.current || null;
  const gglVisDelta = _regressAttr(gglSeries, 'visibility');
  const gglTop10Delta = _regressAttr(gglSeries, 'keywords_top10');
  const tasks = data.tasks || {};

  // Даты для контекста анализа: когда сформирован отчёт и когда сняты
  // показатели по каждому источнику (freshness.last_sync_at). AI должен
  // учитывать разрыв между съёмом данных и датой отчёта, чтобы не выдавать
  // устаревший/неполный последний месяц за спад.
  const dateContext = {
    report_generated_at: data.generated_at || new Date().toISOString(),
    metrics_captured_at: {
      gsc: data.gsc?.last_sync_at || null,
      yandex_webmaster: data.ywm?.last_sync_at || null,
      keys_so: data.keys_so?.last_sync_at || null,
    },
  };

  return {
    gsc_clicks: data.gsc?.totals?.clicks || 0,
    gsc_clicks_delta_pct: _round1(gscClicksDelta?.pct ?? null),
    gsc_clicks_prev: gscClicksDelta?.first ?? null,
    gsc_clicks_last: gscClicksDelta?.last ?? null,
    gsc_clicks_dir: gscClicksDelta?.dir ?? null,
    gsc_clicks_trend_3m: _seriesTrend(data.gsc, 'clicks'),
    gsc_impressions: data.gsc?.totals?.impressions || 0,
    gsc_impressions_delta_pct: _round1(gscImprDelta?.pct ?? null),
    gsc_impressions_prev: gscImprDelta?.first ?? null,
    gsc_impressions_last: gscImprDelta?.last ?? null,
    gsc_impressions_dir: gscImprDelta?.dir ?? null,
    gsc_impressions_trend_3m: _seriesTrend(data.gsc, 'impressions'),
    ywm_clicks: data.ywm?.totals?.clicks || 0,
    ywm_clicks_delta_pct: _round1(ywmClicksDelta?.pct ?? null),
    ywm_clicks_prev: ywmClicksDelta?.first ?? null,
    ywm_clicks_last: ywmClicksDelta?.last ?? null,
    ywm_clicks_dir: ywmClicksDelta?.dir ?? null,
    ywm_clicks_trend_3m: _seriesTrend(data.ywm, 'clicks'),
    ywm_impressions: data.ywm?.totals?.impressions || 0,
    ywm_impressions_delta_pct: _round1(ywmImprDelta?.pct ?? null),
    ywm_impressions_prev: ywmImprDelta?.first ?? null,
    ywm_impressions_last: ywmImprDelta?.last ?? null,
    ywm_impressions_dir: ywmImprDelta?.dir ?? null,
    ywm_impressions_trend_3m: _seriesTrend(data.ywm, 'impressions'),
    // Яндекс Keys.so
    keys_so_visibility_current: ydxCurrent?.visibility ?? null,
    keys_so_visibility_delta_pct: _round1(visDelta?.pct ?? null),
    keys_so_visibility_dir: visDelta?.dir ?? null,
    keys_so_visibility_trend_3m: _seriesTrend(ydxSeries, 'visibility'),
    keys_so_top10: ydxCurrent?.top10 ?? null,
    keys_so_top10_delta_pct: _round1(top10Delta?.pct ?? null),
    keys_so_top10_prev: top10Delta?.first ?? null,
    keys_so_top10_last: top10Delta?.last ?? null,
    keys_so_top10_dir: top10Delta?.dir ?? null,
    keys_so_top10_trend_3m: _seriesTrend(ydxSeries, 'keywords_top10'),
    keys_so_top3: ydxCurrent?.top3 ?? null,
    // Google Keys.so
    keys_so_google_visibility_current: gglCurrent?.visibility ?? null,
    keys_so_google_visibility_delta_pct: _round1(gglVisDelta?.pct ?? null),
    keys_so_google_visibility_dir: gglVisDelta?.dir ?? null,
    keys_so_google_visibility_trend_3m: _seriesTrend(gglSeries, 'visibility'),
    keys_so_google_top10: gglCurrent?.top10 ?? null,
    keys_so_google_top10_delta_pct: _round1(gglTop10Delta?.pct ?? null),
    keys_so_google_top10_prev: gglTop10Delta?.first ?? null,
    keys_so_google_top10_last: gglTop10Delta?.last ?? null,
    keys_so_google_top10_dir: gglTop10Delta?.dir ?? null,
    keys_so_google_top10_trend_3m: _seriesTrend(gglSeries, 'keywords_top10'),
    keys_so_google_top3: gglCurrent?.top3 ?? null,
    tasks_total: tasks.total_generated || 0,
    tasks_by_type: tasks.by_type || {},
    forecast_clicks_3m: data.forecast?.gsc_clicks?.forecast || null,
    traffic_value: data.traffic_value?.estimated_savings || null,
    position_top10: data.position?.summary?.top10 || 0,
    report_generated_at: dateContext.report_generated_at,
    metrics_captured_at: dateContext.metrics_captured_at,
    quick_wins: (data.position?.quick_wins || []).slice(0, 8).map((item) => ({
      query: item.query,
      position: item.position,
    })),
    modules: _buildModulesDigest(data.modules, data.queries),
  };
}

/**
 * Свод сигналов модулей отчёта (ТЗ §5) для AI Executive Summary: сколько точек
 * роста Striking Distance, разрывов CTR, проблемных по Content Health страниц,
 * состояние Off-Page и tech-audit. Возвращает null, если модули недоступны.
 *
 * ТЗ §4: striking_distance / ctr_gap топы фильтруем — отдаём LLM только
 * коммерческие запросы (intent ∈ commercial/transactional/investigation),
 * чтобы рекомендации не «дрейфовали» в инфо-контент. Если в data.queries
 * есть классифицированный список — используем его как whitelist по
 * key/clicks. Если нет — fallback: пропускаем фильтр (старое поведение).
 */
function _buildModulesDigest(modules, queries) {
  if (!modules || modules.disabled || modules.error) return null;
  const ex = modules.executive || {};
  const sd = ex.striking_distance || modules.striking_distance?.summary || {};
  const cg = ex.ctr_gap || modules.ctr_gap?.summary || {};
  const ch = ex.content_health || modules.content_health?.summary || {};
  const op = ex.off_page || modules.off_page?.summary || {};
  const ta = ex.tech_audit || modules.tech_audit?.summary || {};

  // Whitelist коммерческих запросов: исходя из payload queries-секции
  // (см. dataAggregator._queriesSection). Сравнение по нормализованному key.
  const commercialSet = new Set();
  if (queries) {
    for (const q of (queries.top_queries_commercial || [])) {
      if (q?.key) commercialSet.add(String(q.key).toLowerCase().trim());
    }
  }
  const isCommercialQuery = (query) => {
    if (commercialSet.size === 0) return true; // нет данных для фильтра — пропускаем всё
    return commercialSet.has(String(query || '').toLowerCase().trim());
  };

  const topStriking = (modules.striking_distance?.items || [])
    .filter((it) => isCommercialQuery(it.query))
    .slice(0, 5)
    .map((it) => ({ query: it.query, position: it.avg_position, priority: it.priority, score: it.opportunity_score }));
  const topCtrGaps = (modules.ctr_gap?.items || [])
    .filter((it) => isCommercialQuery(it.query))
    .slice(0, 5)
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
  if (digest.gsc_clicks) {
    parts.push(`Google Search Console зафиксировал ${digest.gsc_clicks.toLocaleString('ru-RU')} кликов за период.`);
  }
  const highlights = [];
  if (digest.gsc_clicks_delta_pct != null && digest.gsc_clicks_delta_pct > 0) {
    highlights.push(`+${digest.gsc_clicks_delta_pct}% кликов из Google (с ${Math.round(digest.gsc_clicks_prev || 0).toLocaleString('ru-RU')} до ${Math.round(digest.gsc_clicks_last || 0).toLocaleString('ru-RU')})`);
  }
  if (digest.gsc_impressions_delta_pct != null && digest.gsc_impressions_delta_pct > 0) {
    highlights.push(`+${digest.gsc_impressions_delta_pct}% показов в Google (с ${Math.round(digest.gsc_impressions_prev || 0).toLocaleString('ru-RU')} до ${Math.round(digest.gsc_impressions_last || 0).toLocaleString('ru-RU')})`);
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

  // Структурированный growth_attribution: по каждой ключевой метрике —
  // отдельный объект с trend_direction / delta_value / delta_pct / attribution /
  // conclusion / forecast / weak_zones. Без LLM мы даём детерминированные данные
  // с реальными числами, чтобы UI показывал динамику роста.
  const taskTypes = Object.entries(digest.tasks_by_type || {})
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  const taskMix = taskTypes.length ? taskTypes.join(', ') : 'комплексной работы команды';

  const growth = [];
  if (digest.gsc_clicks != null && digest.gsc_clicks > 0) {
    const delta = digest.gsc_clicks_delta_pct;
    growth.push({
      metric: 'Клики из Google',
      trend_direction: digest.gsc_clicks_dir || _trendDir(delta),
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
      trend_direction: digest.gsc_impressions_dir || _trendDir(delta),
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
      trend_direction: digest.ywm_clicks_dir || _trendDir(delta),
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
      trend_direction: digest.ywm_impressions_dir || _trendDir(delta),
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
      trend_direction: digest.keys_so_visibility_dir || _trendDir(delta),
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
      trend_direction: digest.keys_so_google_visibility_dir || _trendDir(delta),
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

  // Детерминированный прогноз на следующий месяц на основе текущей динамики
  // кликов (Google приоритетно, затем Яндекс). Без вранья — экстраполируем
  // наблюдаемый темп прироста и формулируем осторожно.
  const forecastDeltaPct = digest.gsc_clicks_delta_pct ?? digest.ywm_clicks_delta_pct ?? null;
  const forecastBase = digest.gsc_clicks_last || digest.ywm_clicks_last || 0;
  let nextMonthForecast;
  if (forecastDeltaPct != null && forecastDeltaPct > 0) {
    const projected = forecastBase ? Math.round(forecastBase * (1 + forecastDeltaPct / 100)) : null;
    nextMonthForecast = projected
      ? `При сохранении текущего темпа ожидаем прирост трафика ещё на ~${forecastDeltaPct}% в следующем месяце — ориентировочно до ${projected.toLocaleString('ru-RU')} кликов.`
      : `При сохранении текущего темпа ожидаем прирост трафика ещё на ~${forecastDeltaPct}% в следующем месяце.`;
  } else {
    nextMonthForecast = 'В следующем месяце ожидаем закрепление достигнутых результатов и умеренный рост за счёт дожатия запросов из зоны 11–15 в ТОП-10 и вывода новых страниц.';
  }

  return {
    executive_summary: parts.join('\n\n'),
    highlights: highlights.length ? highlights : ['За период выполнен запланированный объём работ.'],
    growth_attribution: growth,
    quick_wins: quickWins,
    next_month_forecast: nextMonthForecast,
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
      gsc_clicks_trend_3m: digest.gsc_clicks_trend_3m,
      gsc_impressions: digest.gsc_impressions, gsc_impressions_delta_pct: digest.gsc_impressions_delta_pct,
      gsc_impressions_prev: digest.gsc_impressions_prev, gsc_impressions_last: digest.gsc_impressions_last,
      gsc_impressions_trend_3m: digest.gsc_impressions_trend_3m,
      ywm_clicks: digest.ywm_clicks, ywm_clicks_delta_pct: digest.ywm_clicks_delta_pct,
      ywm_clicks_prev: digest.ywm_clicks_prev, ywm_clicks_last: digest.ywm_clicks_last,
      ywm_clicks_trend_3m: digest.ywm_clicks_trend_3m,
      ywm_impressions: digest.ywm_impressions, ywm_impressions_delta_pct: digest.ywm_impressions_delta_pct,
      ywm_impressions_prev: digest.ywm_impressions_prev, ywm_impressions_last: digest.ywm_impressions_last,
      ywm_impressions_trend_3m: digest.ywm_impressions_trend_3m,
      tasks_by_type: digest.tasks_by_type,
      forecast_clicks_3m: digest.forecast_clicks_3m,
      report_generated_at: digest.report_generated_at, metrics_captured_at: digest.metrics_captured_at,
    })}`,
    `Выполненные работы:\n${tasksList || '— нет данных —'}`,
    '',
    'ЗАДАНИЕ: Сформируй ЧАСТЬ отчёта про ТРАФИК (Google + Яндекс) в формате JSON:',
    '{',
    '  "traffic_highlights": ["3-4 тезиса про трафик"],',
    '  "traffic_growth": [массив объектов growth_attribution ТОЛЬКО для: Google клики, Google показы, Яндекс клики, Яндекс показы],',
    '  "traffic_summary": "1-2 абзаца про динамику трафика (тезисно, без выдуманных чисел)"',
    '}',
    'Каждый growth-объект: {metric, attribution, conclusion, forecast, weak_zones}. Поля trend_direction/delta_value/delta_pct оставь пустыми — их подставит система из посчитанных чисел.',
    'В attribution/conclusion опиши ДИНАМИКУ за последние 3 месяца по рядам *_trend_3m (движение от месяца к месяцу), а не только последний месяц. Учитывай report_generated_at и metrics_captured_at: неполный/устаревший последний период не выдавай за спад.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  // ── Pass 2: Анализ видимости Keys.so (Яндекс + Google) + позиции ───────
  const pass2Prompt = [
    `Проект: ${brandName}`,
    `Период: ${period}`,
    `Метрики видимости Keys.so (JSON): ${JSON.stringify({
      yandex: {
        visibility: digest.keys_so_visibility_current, visibility_delta_pct: digest.keys_so_visibility_delta_pct,
        visibility_trend_3m: digest.keys_so_visibility_trend_3m,
        top10: digest.keys_so_top10, top10_delta_pct: digest.keys_so_top10_delta_pct,
        top10_prev: digest.keys_so_top10_prev, top10_last: digest.keys_so_top10_last,
        top10_trend_3m: digest.keys_so_top10_trend_3m,
        top3: digest.keys_so_top3,
      },
      google: {
        visibility: digest.keys_so_google_visibility_current, visibility_delta_pct: digest.keys_so_google_visibility_delta_pct,
        visibility_trend_3m: digest.keys_so_google_visibility_trend_3m,
        top10: digest.keys_so_google_top10, top10_delta_pct: digest.keys_so_google_top10_delta_pct,
        top10_prev: digest.keys_so_google_top10_prev, top10_last: digest.keys_so_google_top10_last,
        top10_trend_3m: digest.keys_so_google_top10_trend_3m,
        top3: digest.keys_so_google_top3,
      },
      position_top10: digest.position_top10,
      traffic_value: digest.traffic_value,
      report_generated_at: digest.report_generated_at, metrics_captured_at: digest.metrics_captured_at,
    })}`,
    `Выполненные работы:\n${tasksList || '— нет данных —'}`,
    '',
    'ЗАДАНИЕ: Сформируй ЧАСТЬ отчёта про ВИДИМОСТЬ в поисковых системах в формате JSON:',
    '{',
    '  "visibility_highlights": ["2-3 тезиса про видимость"],',
    '  "visibility_growth": [массив объектов growth_attribution для: Видимость Keys.so (Яндекс), Видимость Keys.so (Google), ТОП-10 Яндекс, ТОП-10 Google],',
    '  "visibility_summary": "1-2 абзаца про динамику видимости в обеих ПС (тезисно, без выдуманных чисел)",',
    '  "traffic_value": "1-2 предложения про сэкономленный бюджет"',
    '}',
    'Каждый growth-объект: {metric, attribution, conclusion, forecast, weak_zones}. Поля trend_direction/delta_value/delta_pct оставь пустыми — их подставит система из посчитанных чисел.',
    'В attribution/conclusion опиши ДИНАМИКУ за последние 3 месяца по рядам *_trend_3m (движение от месяца к месяцу). Учитывай report_generated_at и metrics_captured_at: неполный/устаревший последний период не выдавай за спад.',
    'Если данных по Google Keys.so нет — пропусти эту метрику.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  // ── Pass 3: Синтез — executive summary, quick wins, прогноз ─────────────
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
    '  "executive_summary": "3 абзаца: 1) главное достижение с числами из входных данных, 2) факторы роста и связь с работами, 3) прогноз. Выделяй ключевые тезисы **жирным** (markdown-звёздочками)",',
    '  "highlights": ["3-5 ярких тезисов про рост"],',
    '  "quick_wins": [{query, position, plan}],',
    '  "next_month_forecast": "1-2 предложения — качественный прогноз направления роста на следующий месяц на основе текущей динамики",',
    '  "traffic_value": "1-2 предложения"',
    '}',
    'Используй ТОЛЬКО числа, которые есть во входных данных — не считай и не выдумывай собственные значения. НЕ упоминай количество выполненных задач. executive_summary должен учитывать и Яндекс, и Google.',
    'Опирайся на ДИНАМИКУ последних 3 месяцев (ряды *_trend_3m в метриках) и учитывай report_generated_at / metrics_captured_at — не выдавай неполный или устаревший последний период за спад.',
    'Если по какой-то метрике снижение — предложи гипотезу причины (сезонность, обновление алгоритмов Яндекса/Google, конкуренты) и план возврата к росту. Для роста укажи, за счёт чего он произошёл (новые страницы, CTR, позиции).',
    'Если есть «Сигналы модулей отчёта» — используй их: точки роста Striking Distance (с opportunity_score), разрывы CTR Gap (critical/warning), проблемные страницы Content Health, состояние Off-Page и tech-audit — отрази их в highlights и рекомендациях.',
    'Ответь СТРОГО JSON-объектом, без markdown-обёртки.',
  ].join('\n');

  const result3 = await runAnalyst(SYSTEM_PROMPT, pass3Prompt, {
    kind: 'reports_synthesis',
    temperature: 0.3,
    maxTokens: 2000,
  });

  const parsed3 = result3.verdict === 'ok' ? _safeJson(result3.markdown) : null;

  // Merge growth_attribution from passes 1 & 2. Числа (trend/delta/pct)
  // подставляются математически из digest — ИИ их не считает и не выдумывает.
  const allGrowth = _applyCanonicalNumbers([
    ..._normalizeGrowthAttribution(parsed1?.traffic_growth),
    ..._normalizeGrowthAttribution(parsed2?.visibility_growth),
  ], digest);

  // Merge highlights
  const allHighlights = [
    ...(parsed1?.traffic_highlights || []).map(String),
    ...(parsed2?.visibility_highlights || []).map(String),
  ].slice(0, 8);

  if (parsed3 && parsed3.executive_summary) {
    return {
      executive_summary: String(parsed3.executive_summary),
      highlights: parsed3.highlights?.length ? _normalizeStringList(parsed3.highlights, 8) : allHighlights,
      growth_attribution: allGrowth.length ? allGrowth : _applyCanonicalNumbers(_normalizeGrowthAttribution(parsed3.growth_attribution), digest),
      quick_wins: _normalizeQuickWins(parsed3.quick_wins),
      next_month_forecast: String(parsed3.next_month_forecast || '').trim() || _fallbackSummary(brandName, period, digest).next_month_forecast,
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
    next_month_forecast: _fallbackSummary(brandName, period, digest).next_month_forecast,
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
  _applyCanonicalNumbers,
  _classifyMetric,
  _canonicalNumbers,
};
