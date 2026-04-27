'use strict';

/**
 * Article Topics Forecaster — pipeline.
 *
 * Один Gemini-вызов (gemini-3.1-pro-preview) с большим foresight-промптом.
 * На выходе — markdown-отчёт со слабыми сигналами, emerging-трендами,
 * контентными кластерами и Strategic Action Plan.
 *
 * Поддерживается два режима:
 *   • mode='main'      — первичный анализ ниши (Промт 1).
 *   • mode='deep_dive' — углублённая проработка отдельного тренда (Промт 2).
 *
 * Используется `callGemini({plainText:true})` напрямую (минуя callLLM),
 * потому что callLLM всегда парсит ответ как JSON, а здесь нам нужен
 * свободный markdown.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../../config/db');
const { callGemini } = require('../llm/gemini.adapter');
const { calcCost }   = require('../metrics/priceCalculator');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts', 'articleTopics');

// Кэшируем тексты промптов в память при первом обращении — файлы не меняются.
let _mainPromptCache     = null;
let _deepDivePromptCache = null;

function _loadMainPrompt() {
  if (_mainPromptCache == null) {
    _mainPromptCache = fs.readFileSync(path.join(PROMPTS_DIR, 'main.txt'), 'utf-8');
  }
  return _mainPromptCache;
}

function _loadDeepDivePrompt() {
  if (_deepDivePromptCache == null) {
    _deepDivePromptCache = fs.readFileSync(path.join(PROMPTS_DIR, 'deepDive.txt'), 'utf-8');
  }
  return _deepDivePromptCache;
}

/**
 * Простая подстановка {{KEY}} → values[KEY] (одна замена на ключ — глобальная).
 * Используется только с доверенными промпт-шаблонами и валидированным
 * пользовательским вводом (через clipStr в контроллере), поэтому prompt-injection
 * не страшен (для модели это просто текстовый инпут).
 */
function _interpolate(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    const safe = (v == null ? '' : String(v));
    out = out.split(`{{${k}}}`).join(safe);
  }
  return out;
}

/**
 * Усечение markdown-текста с уважением к структурным границам.
 *
 * Тупой `str.slice(maxLen)` мог бы разрезать markdown-таблицу, кодовый
 * блок или multi-byte UTF-8 последовательность пополам — модель получает
 * сломанный фрагмент и иногда «доделывает» его странным образом.
 *
 * Стратегия: если строка короче лимита — возвращаем как есть; иначе
 * пытаемся обрезать по последней «безопасной» границе перед лимитом
 * (двойной перенос строки = граница абзаца/секции). Если такой границы
 * нет — обрезаем по ближайшему одиночному переносу, и только в худшем
 * случае — по сырому символьному лимиту. Финальное многоточие сигнализирует
 * модели, что контекст усечён.
 */
function _truncateMarkdown(text, maxLen) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;

  // Берём только префикс длиной maxLen и ищем «безопасный» хвост, чтобы
  // отрезать всё после него. Минимально допустимая длина обрезка — 70%
  // от лимита: иначе мы сэкономили бы слишком мало контекста.
  const minKeep = Math.floor(maxLen * 0.7);
  const head = s.slice(0, maxLen);

  const paraBreak = head.lastIndexOf('\n\n');
  if (paraBreak >= minKeep) {
    return head.slice(0, paraBreak).trimEnd() + '\n\n…(контекст усечён)';
  }
  const lineBreak = head.lastIndexOf('\n');
  if (lineBreak >= minKeep) {
    return head.slice(0, lineBreak).trimEnd() + '\n\n…(контекст усечён)';
  }
  return head.trimEnd() + '\n\n…(контекст усечён)';
}

const SYSTEM_INSTRUCTION =
  'You are a senior strategic foresight analyst and SEO forecaster. ' +
  'Reply in Russian unless the user explicitly asks otherwise. ' +
  'Output clean markdown without ```markdown wrappers. ' +
  'Be concrete, use numbers and named entities, no fluff.';

/**
 * Основная точка входа: запускается из контроллера через setImmediate
 * после insert'а строки в article_topic_tasks.
 */
async function processArticleTopicTask(taskId) {
  if (!taskId) throw new Error('taskId is required');

  const { rows: taskRows } = await db.query(
    `SELECT * FROM article_topic_tasks WHERE id = $1`,
    [taskId],
  );
  if (!taskRows.length) {
    console.warn(`[articleTopics] Task ${taskId} not found, skip`);
    return;
  }
  const task = taskRows[0];

  // Идемпотентность: если задача уже в финальном статусе — пропускаем.
  if (task.status === 'done' || task.status === 'error') {
    console.log(`[articleTopics] Task ${taskId} already ${task.status}, skip`);
    return;
  }

  await db.query(
    `UPDATE article_topic_tasks
        SET status = 'running', started_at = NOW(), updated_at = NOW(),
            error_message = NULL
      WHERE id = $1`,
    [taskId],
  );

  try {
    let userPrompt;
    if (task.mode === 'deep_dive') {
      // Подтягиваем родительский контекст (если есть) — чтобы deep-dive не
      // был оторван от основного анализа.
      let parentContext = '';
      if (task.parent_task_id) {
        const { rows: parentRows } = await db.query(
          `SELECT result_markdown FROM article_topic_tasks WHERE id = $1`,
          [task.parent_task_id],
        );
        if (parentRows.length && parentRows[0].result_markdown) {
          parentContext = _truncateMarkdown(parentRows[0].result_markdown, 6000);
        }
      }
      userPrompt = _interpolate(_loadDeepDivePrompt(), {
        TREND_NAME:       task.trend_name || '',
        NICHE:            task.niche      || '',
        REGION:           task.region     || '',
        HORIZON:          task.horizon    || '',
        AUDIENCE:         task.audience   || '',
        SEARCH_ECOSYSTEM: task.search_ecosystem || '',
        PARENT_CONTEXT:   parentContext || '(отсутствует — опирайся только на тренд и нишу)',
      });
    } else {
      userPrompt = _interpolate(_loadMainPrompt(), {
        NICHE:            task.niche || '',
        REGION:           task.region || '(не указан)',
        HORIZON:          task.horizon || '(не указан)',
        AUDIENCE:         task.audience || '(не указано)',
        MARKET_STAGE:     task.market_stage || '(не указано)',
        SEARCH_ECOSYSTEM: task.search_ecosystem || '(не указано)',
        TOP_COMPETITORS:  task.top_competitors || '(не указаны)',
      });
    }

    // 300 секунд — потолок для одного non-streaming Gemini-вызова в адаптере.
    // 16384 output-токенов хватает на длинный markdown-отчёт (~50 KB текста).
    const result = await callGemini(SYSTEM_INSTRUCTION, userPrompt, {
      temperature: 0.7,
      maxTokens:   16384,
      timeoutMs:   300000,
      plainText:   true,
    });

    if (!result || !result.text || !result.text.trim()) {
      throw new Error('Gemini вернул пустой ответ');
    }

    const tokensIn  = Number(result.tokensIn  || 0);
    const tokensOut = Number(result.tokensOut || 0);
    const costUsd   = calcCost('gemini', tokensIn, tokensOut, false);

    await db.query(
      `UPDATE article_topic_tasks
          SET status = 'done',
              result_markdown   = $2,
              llm_model         = $3,
              gemini_tokens_in  = $4,
              gemini_tokens_out = $5,
              cost_usd          = $6,
              completed_at      = NOW(),
              updated_at        = NOW()
        WHERE id = $1`,
      [taskId, result.text, result.model || null, tokensIn, tokensOut, costUsd],
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[articleTopics] Task ${taskId} failed:`, msg);
    await db.query(
      `UPDATE article_topic_tasks
          SET status = 'error',
              error_message = $2,
              completed_at  = NOW(),
              updated_at    = NOW()
        WHERE id = $1`,
      [taskId, msg.slice(0, 4000)],
    );
  }
}

/**
 * Восстановление зависших задач после рестарта сервера.
 * Все задачи в статусе 'running' помечаем как error — потому что фоновый
 * процесс, который их крутил, уже мёртв.
 */
async function recoverStuckArticleTopicTasks() {
  const { rowCount } = await db.query(
    `UPDATE article_topic_tasks
        SET status = 'error',
            error_message = COALESCE(error_message,
                                     'Server restart while task was running'),
            completed_at  = NOW(),
            updated_at    = NOW()
      WHERE status = 'running'`,
  );
  if (rowCount > 0) {
    console.log(`[articleTopics] Recovered ${rowCount} stuck task(s)`);
  }
}

module.exports = {
  processArticleTopicTask,
  recoverStuckArticleTopicTasks,
};
