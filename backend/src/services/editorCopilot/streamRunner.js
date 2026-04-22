'use strict';

const db = require('../../config/db');
const { streamGenerate } = require('../llm/gemini.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const { buildContext } = require('./contextBuilder');
const { buildPrompt, postProcess } = require('./promptBuilder');
const { getPreset } = require('./actionPresets');

/**
 * Default model для AI-Copilot редактора.
 *
 * По требованию: «логика генерации работает ровно также, как и в создании текстов».
 * Поэтому модель по умолчанию берётся из GEMINI_MODEL (тот же ключ окружения,
 * что и в основном пайплайне Stage 3/5/6). Это гарантирует, что прокси/ключ/модель
 * у редактора совпадают с теми, что уже работают в генерации текстов.
 *
 * При желании можно переопределить отдельной переменной EDITOR_COPILOT_MODEL,
 * но дефолт намеренно следует за основной моделью пайплайна.
 */
const COPILOT_MODEL =
  process.env.EDITOR_COPILOT_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-3.1-pro-preview';

// После завершения операции держим её в in-memory регистре ещё 30 секунд,
// чтобы поздние подписчики (например, автоматический реконнект EventSource
// после кратковременного разрыва сети) могли получить snapshot+done.
const OPERATION_CLEANUP_DELAY_MS = 30_000;

/**
 * In-memory регистр активных операций. Используется для:
 *   1) пересылки SSE-событий клиентам, которые подключаются после старта стрима
 *      (re-attach при F5);
 *   2) отмены операции (POST /cancel).
 */
const activeOps = new Map();   // operationId -> { subscribers:Set<res>, abortFlag, lastUsage, partialText }

function _getOrCreate(operationId) {
  let op = activeOps.get(operationId);
  if (!op) {
    op = { subscribers: new Set(), abortFlag: false, lastUsage: null, partialText: '' };
    activeOps.set(operationId, op);
  }
  return op;
}

function _broadcast(operationId, event, payload) {
  const op = activeOps.get(operationId);
  if (!op) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of op.subscribers) {
    try { res.write(data); } catch (_) { /* dead client */ }
  }
}

function attachSubscriber(operationId, res) {
  const op = _getOrCreate(operationId);
  op.subscribers.add(res);
  // Если есть уже накопленный partialText — сразу шлём его новому клиенту, чтобы он «догнал» состояние.
  if (op.partialText) {
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify({ text: op.partialText })}\n\n`);
    } catch (_) {}
  }
  return () => {
    op.subscribers.delete(res);
  };
}

function requestCancel(operationId) {
  const op = activeOps.get(operationId);
  if (!op) return false;
  op.abortFlag = true;
  return true;
}

/**
 * runStream — основная функция: загружает context, строит prompt, открывает
 * Gemini-стрим, шлёт SSE-события подписчикам, периодически апдейтит result_text
 * в БД (для восстановления при F5), а в конце — финализирует операцию.
 *
 * @param {object} args
 * @param {string} args.operationId
 * @param {string} args.taskId
 * @returns {Promise<void>}
 */
async function runStream({ operationId, taskId }) {
  const opMem = _getOrCreate(operationId);
  const log = (level, message) => _emitLog(operationId, level, message);

  // 1) Загружаем операцию из БД
  const { rows: opRows } = await db.query(
    `SELECT * FROM editor_copilot_operations WHERE id = $1 AND task_id = $2`,
    [operationId, taskId]
  );
  if (!opRows.length) {
    log('error', 'Операция не найдена в БД');
    _broadcast(operationId, 'error', { message: 'Operation not found' });
    return;
  }
  const opRow = opRows[0];

  if (opRow.status === 'done' || opRow.status === 'cancelled' || opRow.status === 'error') {
    // Уже завершена — просто отправим snapshot + done и закроем подписчиков.
    _broadcast(operationId, 'snapshot', { text: opRow.result_text || '' });
    _broadcast(operationId, 'usage',    { tokens_in: opRow.tokens_in, tokens_out: opRow.tokens_out, cost_usd: Number(opRow.cost_usd) });
    _broadcast(operationId, 'done',     { status: opRow.status, result: opRow.result_text || '' });
    return;
  }

  // 2) Помечаем как streaming
  await db.query(
    `UPDATE editor_copilot_operations SET status = 'streaming' WHERE id = $1`,
    [operationId]
  );
  log('info', `Старт операции (action=${opRow.action})`);

  // 3) Контекст
  let ctx;
  try {
    ctx = await buildContext(taskId);
    log('info', `Контекст загружен: LSI всего ${ctx.lsi_state.all.length}, неиспользовано ${ctx.lsi_state.unused.length}, текст статьи ${ctx.full_article_text.length} симв.`);
  } catch (e) {
    return _failOp(operationId, `Ошибка загрузки контекста: ${e.message}`);
  }

  // 4) Промпт
  let prompt;
  try {
    prompt = buildPrompt(ctx, {
      action:        opRow.action,
      selected_text: opRow.selected_text,
      user_prompt:   opRow.user_prompt,
      extra_params:  opRow.extra_params,
    });
    log('info', `Промпт собран: system=${prompt.system.length} симв., user=${prompt.user.length} симв., temperature=${prompt.modelHints.temperature}`);
  } catch (e) {
    return _failOp(operationId, `Ошибка сборки промпта: ${e.message}`);
  }

  // 5) Стрим Gemini
  let firstChunkLogged = false;
  let dbFlushTimer = setInterval(async () => {
    try {
      if (opMem.partialText) {
        await db.query(
          `UPDATE editor_copilot_operations SET result_text = $1 WHERE id = $2`,
          [opMem.partialText, operationId]
        );
      }
    } catch (e) { /* лог не нужен — фоновое сохранение */ }
  }, 1500);

  try {
    const result = await streamGenerate(prompt.system, prompt.user, {
      model:       COPILOT_MODEL,
      temperature: prompt.modelHints.temperature,
      maxTokens:   prompt.modelHints.maxTokens,
      onChunk: (delta) => {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          log('info', 'Первый чанк получен от модели — стримим в UI');
        }
        opMem.partialText += delta;
        _broadcast(operationId, 'token', { delta });
      },
      shouldAbort: () => opMem.abortFlag,
    });
    clearInterval(dbFlushTimer);

    // Если сработал не-потоковый фолбэк — сообщим об этом в SSE-лог,
    // чтобы было понятно, почему текст «пришёл одним куском», а не стримился.
    if (result && result.fallbackUsed) {
      log('warn',
        'Стрим Gemini вернул пустой ответ — повторили запрос без потокового режима ' +
        '(не-стрим callGemini). Текст подставлен в редактор обычным образом.'
      );
    }

    // Если был abort — фиксируем как cancelled
    if (result.aborted || opMem.abortFlag) {
      await _finalize(operationId, {
        status:       'cancelled',
        result_text:  postProcess(result.text),
        tokens_in:    result.tokensIn  || 0,
        tokens_out:   result.tokensOut || 0,
        cost_usd:     calcCost('gemini', result.tokensIn || 0, result.tokensOut || 0),
        model_used:   result.model || COPILOT_MODEL,
        error_message:null,
      });
      _broadcast(operationId, 'done', { status: 'cancelled', result: postProcess(result.text) });
      return;
    }

    const finalText = postProcess(result.text);
    const cost      = calcCost('gemini', result.tokensIn || 0, result.tokensOut || 0);

    // Защита: модель вернула 200 OK, но не прислала ни одного текстового фрагмента
    // (типичные причины: finishReason=SAFETY/RECITATION/MAX_TOKENS на пустом ответе,
    // promptFeedback.blockReason, либо thinking-модель отдала только thought-части).
    // Раньше такие случаи фиксировались как status='done' с пустым result_text — фронтенд
    // получал «успех», но подставлять в выделенный фрагмент было нечего.
    // Теперь такой исход трактуем как ошибку, чтобы пользователь увидел причину.
    if (!finalText || !finalText.trim()) {
      const reasons = [];
      if (result.blockReason)   reasons.push(`promptFeedback.blockReason=${result.blockReason}`);
      if (result.safetyBlocked) reasons.push('safetyRatings.blocked');
      if (result.finishReason)  reasons.push(`finishReason=${result.finishReason}`);
      reasons.push(`tokens_in=${result.tokensIn || 0}`, `tokens_out=${result.tokensOut || 0}`);
      const diag = reasons.join(', ');
      return _failOp(
        operationId,
        `Модель вернула пустой ответ (${diag}). Попробуйте переформулировать запрос или уменьшить выделенный фрагмент.`
      );
    }

    await _finalize(operationId, {
      status:       'done',
      result_text:  finalText,
      tokens_in:    result.tokensIn  || 0,
      tokens_out:   result.tokensOut || 0,
      cost_usd:     cost,
      model_used:   result.model || COPILOT_MODEL,
      error_message:null,
    });
    log('info', `Готово. tokens_in=${result.tokensIn} tokens_out=${result.tokensOut} cost=$${cost.toFixed(6)}`);
    _broadcast(operationId, 'usage', { tokens_in: result.tokensIn || 0, tokens_out: result.tokensOut || 0, cost_usd: cost });
    _broadcast(operationId, 'done',  { status: 'done', result: finalText });
  } catch (e) {
    clearInterval(dbFlushTimer);
    return _failOp(operationId, e.message || String(e));
  } finally {
    // Через 30 сек после завершения чистим in-memory запись (даём время поздним подписчикам подключиться).
    setTimeout(() => activeOps.delete(operationId), OPERATION_CLEANUP_DELAY_MS);
  }
}

async function _finalize(operationId, fields) {
  const { rows } = await db.query(
    `UPDATE editor_copilot_operations
        SET status        = $1::editor_copilot_status,
            result_text   = $2,
            tokens_in     = $3,
            tokens_out    = $4,
            cost_usd      = $5,
            model_used    = $6,
            error_message = $7,
            completed_at  = NOW()
      WHERE id = $8
      RETURNING session_id`,
    [
      fields.status, fields.result_text, fields.tokens_in, fields.tokens_out,
      fields.cost_usd, fields.model_used, fields.error_message, operationId,
    ]
  );
  if (rows.length) {
    // Инкрементируем агрегаты сессии
    await db.query(
      `UPDATE editor_copilot_sessions
          SET total_tokens_in  = total_tokens_in  + $1,
              total_tokens_out = total_tokens_out + $2,
              total_cost_usd   = total_cost_usd   + $3,
              updated_at       = NOW()
        WHERE id = $4`,
      [fields.tokens_in, fields.tokens_out, fields.cost_usd, rows[0].session_id]
    );
  }
}

async function _failOp(operationId, message) {
  try {
    await db.query(
      `UPDATE editor_copilot_operations
          SET status='error', error_message=$1, completed_at=NOW()
        WHERE id=$2`,
      [String(message).slice(0, 2000), operationId]
    );
  } catch (_) {}
  _emitLog(operationId, 'error', message);
  _broadcast(operationId, 'error', { message });
}

async function _emitLog(operationId, level, message) {
  const entry = { ts: new Date().toISOString(), level, message: String(message).slice(0, 1000) };
  _broadcast(operationId, 'log', entry);
  try {
    // Append в массив. Используем jsonb_insert через jsonb-функцию (упрощённо — concat).
    await db.query(
      `UPDATE editor_copilot_operations
          SET logs = COALESCE(logs, '[]'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [JSON.stringify([entry]), operationId]
    );
  } catch (_) { /* лог опционален */ }
}

module.exports = {
  runStream,
  attachSubscriber,
  requestCancel,
  COPILOT_MODEL,
};
