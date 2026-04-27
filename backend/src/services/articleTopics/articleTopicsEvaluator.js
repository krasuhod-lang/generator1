'use strict';

/**
 * Article Topics — Quality Evaluator (LLM-as-judge).
 *
 * OPTIONAL DeepSeek-вызов после успешного main / deep-dive прогона.
 * Гейтится `ARTICLE_TOPICS_EVALUATOR_ENABLED=true` (default OFF — нулевое
 * влияние на текущий пайплайн и на стоимость).
 *
 * Архитектура копирует Stage 8 (backend/src/services/pipeline/stage8.js):
 *   - Один DeepSeek-вызов, ~$0.001 за задачу (markdown-отчёт сжат до
 *     ARTICLE_TOPICS_EVALUATOR_TEXT_CAP, default 12000 символов).
 *   - Никогда не блокирует основной flow; на любую ошибку → возвращает
 *     null и пишет warn-лог.
 *   - Результат сохраняется в `article_topic_tasks.evaluator_report`
 *     (миграция 016) — отдельной не-блокирующей UPDATE-операцией.
 *
 * Оценка по 5 критериям (0..10 каждый), важных именно для foresight-отчёта:
 *   - specificity         — конкретные имена/цифры/даты vs общие слова
 *   - evidence            — заполненность Confidence-столбца + наличие
 *                           проверяемых источников у high-confidence сигналов
 *   - actionability       — Strategic Action Plan содержит измеримые KPI и
 *                           ссылки на конкретные кластеры из Фазы 3
 *   - novelty             — есть ли неочевидные сигналы / тренды vs мейнстрим
 *   - structure_compliance — соблюдена ли заявленная структура (## Фазы,
 *                           таблицы, TRENDS_JSON в конце)
 */

const { callLLM } = require('../llm/callLLM');
const db          = require('../../config/db');

const SYSTEM_PROMPT = `Ты — Quality Evaluator для foresight / SEO-отчётов о темах статей.
Твоя задача — оценить markdown-отчёт по 5 критериям (0..10 каждый) и вернуть
строго JSON.

КРИТЕРИИ:
  1. specificity (0..10) — есть ли конкретные имена компаний, продуктов,
     людей, даты, цифры, точные технологии? 10 = насыщенно конкретикой;
     0 = одни общие слова без носителей.
  2. evidence (0..10) — заполнен ли столбец Confidence в Фазе 1, у high-
     confidence сигналов указаны проверяемые источники (имя/ссылка/дата),
     не выдумано? 10 = всё прозрачно; 0 = всё с потолка.
  3. actionability (0..10) — у Strategic Action Plan есть измеримые KPI
     (визиты/позиции/лиды/CTR), точные кластеры из Фазы 3 цитируются
     дословно? 10 = немедленно в работу; 0 = пустые слова «улучшить».
  4. novelty (0..10) — насколько неочевидны сигналы и тренды? 10 = реально
     foresight-инсайты, которых нет в топ-блогах; 0 = пересказ Википедии.
  5. structure_compliance (0..10) — соблюдены ли заявленные ## Фаза N
     заголовки, markdown-таблицы в Фазах 1/2/3, есть ли в конце блок
     TRENDS_JSON_START/END? 10 = всё на месте; 0 = промт проигнорирован.

ВЫХОД: ровно один JSON-объект (без markdown, без префиксов, без
\`\`\`json-обёртки) со схемой:
{
  "scores": {
    "specificity": number,
    "evidence": number,
    "actionability": number,
    "novelty": number,
    "structure_compliance": number
  },
  "total_score":  number (среднее по 5 критериям, 0..10),
  "top_strengths":  ["...", "..."],
  "top_weaknesses": ["...", "..."],
  "issues": [
    { "severity": "low|medium|high",
      "issue":    "конкретно где и что не так",
      "fix_hint": "что переписать" }
  ]
}

ВАЖНО:
  - Никаких пояснений вне JSON.
  - Не оценивай стиль/орфографию — только содержание по 5 критериям.
  - Если отчёт пуст или явно сломан — поставь все скоры 0 и опиши в issues.`;

function _capText(s, max) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) + '…(truncated)' : t;
}

function _buildUserPrompt({ task, markdown }) {
  const TEXT_CAP = parseInt(process.env.ARTICLE_TOPICS_EVALUATOR_TEXT_CAP, 10) || 12000;
  // Описание задачи компактно — нужно evaluator'у только для контекста
  // (evaluation сам по содержимому отчёта).
  const ctx = {
    mode:             task?.mode || 'main',
    niche:            task?.niche || '',
    region:           task?.region || '',
    horizon:          task?.horizon || '',
    audience:         task?.audience || '',
    market_stage:     task?.market_stage || '',
    search_ecosystem: task?.search_ecosystem || '',
    trend_name:       task?.trend_name || '',
  };
  return `===== TASK INPUTS =====
${JSON.stringify(ctx)}

===== REPORT MARKDOWN =====
${_capText(markdown, TEXT_CAP)}

===== INSTRUCTION =====
Оцени отчёт по 5 критериям из system-промпта. Только JSON.`;
}

function isEvaluatorEnabled() {
  return String(process.env.ARTICLE_TOPICS_EVALUATOR_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Запускает evaluator. Не выбрасывает наружу — на любую ошибку возвращает
 * null. Сохраняет отчёт в article_topic_tasks.evaluator_report.
 *
 * @param {string} taskId
 * @param {object} task     — строка из article_topic_tasks (для контекста)
 * @param {string} markdown — result_markdown отчёта
 * @returns {Promise<object|null>}
 */
async function runArticleTopicsEvaluator(taskId, task, markdown) {
  if (!isEvaluatorEnabled())          return null;
  if (!taskId || !markdown || !task)  return null;

  const startedAt = Date.now();
  let report = null;
  try {
    report = await callLLM(
      'deepseek',
      SYSTEM_PROMPT,
      _buildUserPrompt({ task, markdown }),
      {
        retries:     2,
        taskId,
        stageName:   'article_topics_evaluator',
        callLabel:   'Article Topics Evaluator',
        temperature: 0.1,
      },
    );
  } catch (err) {
    console.warn(`[articleTopicsEvaluator] task ${taskId} LLM failed: ${err.message}`);
    return null;
  }

  if (!report || typeof report !== 'object') {
    console.warn(`[articleTopicsEvaluator] task ${taskId}: empty/invalid JSON`);
    return null;
  }

  // Нормализуем total_score: либо берём из ответа, либо считаем сами как
  // среднее, чтобы UI всегда мог показать число.
  const scores = (report.scores && typeof report.scores === 'object') ? report.scores : {};
  const numeric = ['specificity', 'evidence', 'actionability', 'novelty', 'structure_compliance']
    .map(k => Number(scores[k]))
    .filter(n => Number.isFinite(n));
  if (numeric.length) {
    const avg = numeric.reduce((a, b) => a + b, 0) / numeric.length;
    const reportedTotal = Number(report.total_score);
    if (!Number.isFinite(reportedTotal)) {
      report.total_score = Math.round(avg * 10) / 10;
    } else {
      report.total_score = Math.max(0, Math.min(10, reportedTotal));
    }
  } else {
    report.total_score = null;
  }
  report.elapsed_ms   = Date.now() - startedAt;
  report.generated_at = new Date().toISOString();

  try {
    await db.query(
      `UPDATE article_topic_tasks SET evaluator_report = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(report), taskId],
    );
  } catch (dbErr) {
    console.warn(`[articleTopicsEvaluator] task ${taskId} DB persist failed: ${dbErr.message}`);
  }
  return report;
}

module.exports = {
  runArticleTopicsEvaluator,
  isEvaluatorEnabled,
  // экспорт для тестов
  _internal: { _buildUserPrompt, _capText, SYSTEM_PROMPT },
};
