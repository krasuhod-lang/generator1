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
  '## 1. Сводка закономерностей Google ↔ Яндекс',
  'Где источники сходятся (общие сильные/слабые запросы, страницы, тренды), а',
  'где расходятся (запрос силён в одной системе и слаб в другой — и почему,',
  'с учётом разницы факторов ранжирования). Конкретику бери из отчётов.',
  '',
  '## 2. Чего не хватает для роста (факторы ранжирования)',
  'На основе [ФАКТОРЫ РАНЖИРОВАНИЯ] разбери КАЖДЫЙ значимый незакрытый фактор:',
  'что именно проседает, почему это тормозит рост и что сделать. Сначала',
  'критичные (status=critical), затем зоны роста (status=gap). Будь предметным.',
  '',
  '## 3. Общий приоритезированный план роста',
  'Единый пошаговый план для обеих систем: что сделать в первую очередь, какой',
  'ожидается эффект и в какой поисковой системе он сильнее. Приоритизируй по',
  'влиянию на рост × усилию.',
  '',
  '## 4. Прогноз',
  'Аргументированный прогноз динамики при выполнении плана (без выдуманных цифр —',
  'качественно: что вырастет, где быстрее, какие риски).',
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

function _buildUserPrompt({ project, gscReport, ydxReport, gscPerformance, ydxPerformance, rankingFactors, dspySuffix }) {
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
