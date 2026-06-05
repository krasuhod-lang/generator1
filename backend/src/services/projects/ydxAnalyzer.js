'use strict';

/**
 * projects/ydxAnalyzer.js — отдельный AI-анализ Яндекс.Вебмастера.
 *
 * Google и Яндекс ранжируют по-разному, поэтому анализируем источники
 * РАЗДЕЛЬНО (требование ТЗ). Здесь — Яндекс: упор на специфику Яндекса
 * (поведенческие факторы и CTR в выдаче, коммерческие факторы, региональность,
 * переоптимизация анкоров/текста, быстрые ответы и колдунщики, ИКС/доверие).
 *
 * Данные Webmaster API беднее GSC (нет среза по страницам и по устройствам),
 * поэтому опираемся на топ-запросы, динамику и бренд-сплит. Промпт усиливается
 * через DSPy-сигнатуру YandexQueryAnalysis. Provider — Gemini 3.1 Pro
 * (llmAnalyst), фолбэк DeepSeek. Никогда не бросает.
 */

const { runAnalyst, analystAvailable } = require('./llmAnalyst');
const { buildPromptSuffix } = require('./dspyClient');

const SYSTEM_PROMPT = [
  'Ты — Senior SEO-аналитик, специализирующийся на продвижении в ПОИСКЕ ЯНДЕКСА.',
  'Тебе передают реальные данные из Яндекс.Вебмастера (динамика показов, кликов,',
  'CTR и средней позиции, топ поисковых запросов, бренд/небренд) и описание',
  'целевой аудитории проекта.',
  '',
  'Анализируй именно с учётом особенностей ранжирования Яндекса, а НЕ Google:',
  '• поведенческие факторы и CTR в выдаче (отказы, время на сайте, дочиты);',
  '• коммерческие факторы (ассортимент, цены, доставка, контакты, отзывы) для',
  '  коммерческих запросов;',
  '• региональность (привязка к региону в Вебмастере, гео-запросы);',
  '• переоптимизация текста/анкоров (риски Баден-Бадена/Минусинска);',
  '• быстрые ответы, колдунщики, Турбо-страницы, ИКС и сигналы доверия.',
  '',
  'Выдай развёрнутый практичный отчёт на русском в Markdown (заголовки ##,',
  'списки, **жирный**, таблицы где уместно). Структура:',
  '',
  '## 1. Оценка ситуации в Яндексе',
  'Почему метрики растут/падают; что говорят позиции и CTR. Опирайся на динамику.',
  '',
  '## 2. Точки роста в Яндексе',
  'Конкретные запросы у входа в топ (позиции 3–20), брендовый vs небрендовый спрос.',
  '',
  '## 3. Поведенческие и коммерческие факторы',
  'Что усилить под поведенческие/коммерческие факторы Яндекса для приоритетных запросов.',
  '',
  '## 4. Региональность и семантика',
  'Гео-привязка, региональные запросы, кластеры для доработки.',
  '',
  '## 5. Риски переоптимизации',
  'Признаки переспама в текстах/анкорах и как их снять.',
  '',
  '## 6. Action Plan для Яндекса',
  'Чёткий пронумерованный план (что, зачем, ожидаемый эффект), приоритеты.',
  '',
  'Опирайся только на переданные данные и здравый SEO-смысл, не выдумывай цифр.',
  'Учитывай целевую аудиторию. Без преамбул и заключений вне структуры.',
].join('\n');

function _renderBrandSplit(bs) {
  if (!bs || bs.available === false) return [];
  return [
    '',
    '[БРЕНД vs НЕБРЕНД]',
    JSON.stringify({ branded: bs.branded, nonbranded: bs.nonbranded, brand_tokens: bs.brand_tokens }),
  ];
}

function _buildUserPrompt({ project, range, performance, topQueries, brandSplit, dspySuffix }) {
  const totals = (performance && performance.totals) || {};
  const series = (performance && performance.series) || [];
  const lines = [
    '[ПРОЕКТ]',
    `Название: ${project.name || '—'}`,
    `Сайт: ${project.ydx_site_url || project.url || '—'}`,
    `Целевая аудитория: ${project.audience_description || '[не задано]'}`,
    '',
    `[ПЕРИОД] ${range.startDate} — ${range.endDate}`,
    '',
    '[СУММАРНЫЕ МЕТРИКИ ЯНДЕКСА]',
    `Клики: ${totals.clicks || 0}`,
    `Показы: ${totals.impressions || 0}`,
    `CTR: ${totals.ctr || 0}%`,
    `Средняя позиция: ${totals.position || 0}`,
    '',
    '[ДИНАМИКА ПО ДНЯМ] (date, clicks, impressions, ctr%, position)',
    JSON.stringify(series.slice(-90)),
    '',
    `[ТОП-${(topQueries || []).length} ЗАПРОСОВ ЯНДЕКСА] (query, clicks, impressions, ctr%, position)`,
    JSON.stringify((topQueries || []).map((q) => ({
      query: q.key, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position,
    }))),
  ];
  lines.push(..._renderBrandSplit(brandSplit));
  if (dspySuffix) lines.push('', dspySuffix);
  return lines.join('\n');
}

/**
 * Запускает анализ Яндекса. Возвращает нормализованный результат llmAnalyst.
 * Никогда не бросает.
 */
async function runYandexAnalysis(payload) {
  if (!analystAvailable()) return { verdict: 'skipped', reason: 'no_api_key' };
  let dspySuffix = '';
  try {
    dspySuffix = await buildPromptSuffix('YandexQueryAnalysis', {
      total_queries: (payload.topQueries || []).length,
      has_brand_split: Boolean(payload.brandSplit && payload.brandSplit.available !== false),
    });
  } catch (_) { dspySuffix = ''; }

  const userPrompt = _buildUserPrompt({ ...payload, dspySuffix });
  return runAnalyst(SYSTEM_PROMPT, userPrompt, { kind: 'project_seo_analysis_yandex' });
}

module.exports = { runYandexAnalysis, SYSTEM_PROMPT, _buildUserPrompt };
