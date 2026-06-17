'use strict';

/**
 * projects/synthesisAnalyzer.js — финальный проход: сводка ЗАКОНОМЕРНОСТЕЙ по
 * двум источникам (Google Search Console + Яндекс.Вебмастер) и подсветка
 * незакрытых ФАКТОРОВ РАНЖИРОВАНИЯ («чего не хватает для большего роста»).
 *
 * Получает на вход два уже готовых markdown-отчёта (Google и Яндекс), ключевые
 * метрики обоих источников и детерминированный аудит факторов ранжирования
 * (rankingFactors). Возвращает:
 *   • markdown — общая сводка закономерностей + приоритезированный рост;
 *   • ranking_factors — детерминированный аудит (прокидывается как есть, для
 *     красивой карточки на фронте).
 *
 * Большой промпт усилен DSPy-сигнатурами ProjectGrowthSynthesis и
 * RankingFactorGaps. Provider — Gemini 3.1 Pro (llmAnalyst). Не бросает.
 */

const { runAnalyst, analystAvailable } = require('./llmAnalyst');
const { buildPromptSuffix } = require('./dspyClient');
const { renderRankingFactorsLines } = require('./rankingFactors');

const SYSTEM_PROMPT = [
  'Ты — Lead SEO-стратег. Тебе дают РАЗДЕЛЬНЫЕ результаты анализа по двум',
  'поисковым системам — Google Search Console и Яндекс.Вебмастер — по одному',
  'и тому же сайту, плюс детерминированный аудит факторов ранжирования.',
  '',
  'Твоя задача — НЕ повторять источники по отдельности, а вывести ЗАКОНОМЕРНОСТИ:',
  'что общего и что различается между Google и Яндексом, и собрать единый',
  'приоритезированный план роста. Самое важное — опираясь на важные факторы',
  'ранжирования, ЧЁТКО подсветить, ЧЕГО НЕ ХВАТАЕТ сайту для большего роста.',
  '',
  'Выдай развёрнутый отчёт на русском в Markdown по структуре:',
  '',
  '## 1. Сводная динамика: Google ↔ Яндекс',
  'Для КАЖДОГО источника опиши динамику ключевых метрик (клики, показы, CTR,',
  'позиции) — растут/падают/стабильны. Выдели ЗАКОНОМЕРНОСТИ:',
  '  • Где источники сходятся (общие сильные/слабые запросы, страницы, тренды).',
  '  • Где расходятся (запрос силён в Google, но слаб в Яндексе и наоборот).',
  '  • Почему расходятся — с учётом РАЗНИЦЫ факторов ранжирования (Google:',
  '    E-E-A-T, ссылки, PageExperience; Яндекс: поведенческие, коммерческие,',
  '    региональность, текстовые факторы).',
  'Если динамика в одном поисковике падает, а в другом растёт — ОБЪЯСНИ причину',
  'расхождения и какие действия это диктует.',
  '',
  '## 2. Чего не хватает для роста (факторы ранжирования)',
  'На основе [ФАКТОРЫ РАНЖИРОВАНИЯ] разбери КАЖДЫЙ значимый незакрытый фактор:',
  'что именно проседает, почему это тормозит рост и что сделать. Сначала',
  'критичные (status=critical), затем зоны роста (status=gap). Будь предметным.',
  '',
  '## 3. Сводная информация по проекту',
  'Собери КОНСОЛИДИРОВАННУЮ картину из данных обоих источников:',
  '  • Общий объём трафика (Google + Яндекс), его распределение.',
  '  • Ключевые запросы: какие работают в обоих поисковиках, какие — только',
  '    в одном (и почему, что сделать для второго).',
  '  • Ключевые страницы: какие URL лидируют, какие отстают по позициям.',
  '  • Проблемные зоны: каннибализация, decay, низкий CTR — проявляются ли',
  '    они в обоих источниках или специфичны для одного.',
  'Цель: дать владельцу сайта ЕДИНУЮ сводку состояния проекта, а не два',
  'разрозненных отчёта.',
  '',
  '## 4. Общий приоритезированный план роста',
  'Единый пошаговый план для обеих систем: что сделать в первую очередь, какой',
  'ожидается эффект и в какой поисковой системе он сильнее. Приоритизируй по',
  'влиянию на рост × усилию.',
  '',
  '## 5. Прогноз динамики и рекомендации на будущее',
  'Развёрнутый, аргументированный прогноз:',
  '',
  '### 5.1. Прогноз на ближайшие 1-3 месяца',
  'Для КАЖДОЙ метрики (клики, показы, CTR, позиции) по каждому поисковику:',
  '  • Ожидаемый тренд и аргументация (на основе текущей динамики, сезонности,',
  '    конкурентной среды, запланированных действий).',
  '  • Какие запросы/страницы будут драйверами роста.',
  '  • Какие риски могут помешать (сезонный спад, алгоритмические апдейты,',
  '    действия конкурентов, технический долг).',
  '',
  '### 5.2. Потенциал роста при реализации плана',
  '  • Где эффект будет заметен быстрее (Google vs Яндекс).',
  '  • Какие действия дадут максимальный ROI.',
  '  • Ожидаемый тайминг: что даст результат через 2-4 недели, что через',
  '    1-3 месяца, что через 3-6 месяцев.',
  '',
  '### 5.3. Стратегические рекомендации на 6+ месяцев',
  '  • Куда развивать семантику и контент.',
  '  • Как усилить позиции в слабом поисковике (если один отстаёт).',
  '  • Какие новые направления трафика стоит осваивать.',
  '',
  'Не выдумывай конкретных цифр и процентов — давай качественную, но',
  'АРГУМЕНТИРОВАННУЮ оценку на основе реальных данных и трендов.',
  '',
  'Опирайся только на переданные данные. Не выдумывай метрик. Без преамбул.',
].join('\n');

function _clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…[обрезано]` : s;
}

function _metricsLine(label, perf) {
  const t = (perf && perf.totals) || {};
  return `${label}: клики ${t.clicks || 0}, показы ${t.impressions || 0}, CTR ${t.ctr || 0}%, ср. позиция ${t.position || 0}`;
}

function _buildUserPrompt({ project, gscReport, ydxReport, gscPerformance, ydxPerformance, rankingFactors, gscSnapshot, ydxSnapshot, dspySuffix }) {
  const lines = [
    '[ПРОЕКТ]',
    `Название: ${project.name || '—'}`,
    `Сайт: ${project.gsc_site_url || project.ydx_site_url || project.url || '—'}`,
    `Целевая аудитория: ${project.audience_description || '[не задано]'}`,
    '',
    '[КЛЮЧЕВЫЕ МЕТРИКИ]',
    _metricsLine('Google', gscPerformance),
    ydxPerformance ? _metricsLine('Яндекс', ydxPerformance) : 'Яндекс: данные недоступны (не подключён или нет данных)',
  ];

  // Добавляем данные о динамике для более глубокого анализа
  if (gscPerformance && gscPerformance.series) {
    const gscSeries = gscPerformance.series.slice(-30);
    if (gscSeries.length > 0) {
      lines.push('', '[ДИНАМИКА GOOGLE за последние 30 дней] (date, clicks, impressions, ctr%, position)');
      lines.push(JSON.stringify(gscSeries));
    }
  }
  if (ydxPerformance && ydxPerformance.series) {
    const ydxSeries = ydxPerformance.series.slice(-30);
    if (ydxSeries.length > 0) {
      lines.push('', '[ДИНАМИКА ЯНДЕКС за последние 30 дней] (date, clicks, impressions, ctr%, position)');
      lines.push(JSON.stringify(ydxSeries));
    }
  }

  // Добавляем топ-запросы из обоих источников для сводного анализа
  if (gscSnapshot && gscSnapshot.topQueries) {
    const topQ = (Array.isArray(gscSnapshot.topQueries) ? gscSnapshot.topQueries : []).slice(0, 30);
    if (topQ.length) {
      lines.push('', '[ТОП-ЗАПРОСЫ GOOGLE] (query, clicks, impressions, ctr%, position)');
      lines.push(JSON.stringify(topQ));
    }
  }
  if (ydxSnapshot && ydxSnapshot.topQueries) {
    const topQ = (Array.isArray(ydxSnapshot.topQueries) ? ydxSnapshot.topQueries : []).slice(0, 30);
    if (topQ.length) {
      lines.push('', '[ТОП-ЗАПРОСЫ ЯНДЕКС] (query, shows, clicks, ctr%, position)');
      lines.push(JSON.stringify(topQ));
    }
  }

  // Данные о сезонности и period compare для прогноза
  if (gscSnapshot && gscSnapshot.seasonality && gscSnapshot.seasonality.available) {
    lines.push('', '[ТРЕНДЫ И СЕЗОННОСТЬ GOOGLE]');
    const s = gscSnapshot.seasonality;
    if (s.trend) lines.push(`Тренд: направление=${s.trend.direction}, slope=${s.trend.slope_clicks_per_day} клик/день`);
    if (s.monthly_decline_streak) lines.push(`Месячный спад подряд: ${s.monthly_decline_streak} мес.`);
    if (s.months) lines.push('Помесячно: ' + JSON.stringify(s.months));
  }

  if (gscSnapshot && gscSnapshot.period_compare && gscSnapshot.period_compare.available) {
    const pc = gscSnapshot.period_compare;
    lines.push('', '[ИЗМЕНЕНИЯ VS ПРЕДЫДУЩИЙ ПЕРИОД — GOOGLE]');
    lines.push(`Дельты: ${JSON.stringify(pc.totals?.delta || {})}`);
    lines.push(`В процентах: ${JSON.stringify(pc.totals?.pct || {})}`);
    if (pc.totals?.decomposition) lines.push(`Декомпозиция Δclicks: ${JSON.stringify(pc.totals.decomposition)}`);
  }

  lines.push(...renderRankingFactorsLines(rankingFactors));

  lines.push(
    '',
    '[ОТЧЁТ ПО GOOGLE SEARCH CONSOLE]',
    gscReport ? _clip(gscReport, 14000) : '[нет отчёта Google]',
    '',
    '[ОТЧЁТ ПО ЯНДЕКС.ВЕБМАСТЕРУ]',
    ydxReport ? _clip(ydxReport, 10000) : '[нет отчёта Яндекса — анализируй только Google и общие факторы]',
  );

  if (dspySuffix) lines.push('', dspySuffix);
  return lines.join('\n');
}

/**
 * Запускает синтез. Возвращает { verdict, markdown, ranking_factors, ... }.
 * Никогда не бросает. Если LLM недоступен — отдаёт детерминированный fallback
 * на основе rankingFactors, чтобы карточка всё равно была заполнена.
 */
async function runSynthesis(payload) {
  const rf = payload.rankingFactors || null;
  if (!analystAvailable()) {
    return {
      verdict: 'skipped',
      reason: 'no_api_key',
      markdown: _fallbackMarkdown(rf),
      ranking_factors: rf,
    };
  }

  let dspySuffix = '';
  try {
    const [s1, s2] = await Promise.all([
      buildPromptSuffix('ProjectGrowthSynthesis', { has_yandex: Boolean(payload.ydxReport) }),
      buildPromptSuffix('RankingFactorGaps', { gaps: rf && rf.gaps ? rf.gaps.length : 0 }),
    ]);
    dspySuffix = [s1, s2].filter(Boolean).join('\n');
  } catch (_) { dspySuffix = ''; }

  const userPrompt = _buildUserPrompt({ ...payload, dspySuffix });
  const res = await runAnalyst(SYSTEM_PROMPT, userPrompt, { kind: 'project_seo_analysis_synthesis' });
  return { ...res, ranking_factors: rf };
}

/** Детерминированная сводка, если LLM недоступен. */
function _fallbackMarkdown(rf) {
  if (!rf || !rf.available) return '';
  const lines = ['## Чего не хватает для роста (факторы ранжирования)', ''];
  if (rf.summary) lines.push(rf.summary, '');
  const gaps = (rf.gaps || []);
  if (!gaps.length) {
    lines.push('По доступным данным явных незакрытых факторов не выявлено.');
    return lines.join('\n');
  }
  lines.push('| Фактор | Статус | Что сделать |', '| --- | --- | --- |');
  for (const g of gaps) {
    lines.push(`| ${g.label} | ${g.status} | ${g.action || g.finding} |`);
  }
  return lines.join('\n');
}

module.exports = { runSynthesis, SYSTEM_PROMPT, _buildUserPrompt, _fallbackMarkdown };
