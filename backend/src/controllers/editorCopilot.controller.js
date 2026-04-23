'use strict';

const db = require('../config/db');
const { validateRequest, listPresets } = require('../services/editorCopilot/actionPresets');
const {
  runStream, attachSubscriber, requestCancel, COPILOT_MODEL,
} = require('../services/editorCopilot/streamRunner');

// ────────────────────────────────────────────────────────────────────
// Лимиты на размер пользовательских строк (защита от мусора и DoS)
// ────────────────────────────────────────────────────────────────────
// MAX_SELECTED_TEXT — максимум для одного выделения в WYSIWYG (≈10 экранов).
// MAX_USER_PROMPT   — комментарий пользователя; длиннее обычно бессмысленно
//                     и съедает токенный бюджет Gemini.
// MAX_HTML_APPLY    — full_html_edited; ~500KB ≈ 250-300k символов «чистого»
//                     текста, что покрывает любую SEO-статью с большим
//                     запасом и одновременно ограничивает row size в Postgres.
const MAX_SELECTED_TEXT = 20_000;
const MAX_USER_PROMPT   = 4_000;
const MAX_HTML_APPLY    = 500_000;

/**
 * loadOwnTask — общая проверка владельца задачи (как в tasks.controller).
 */
async function loadOwnTask(taskId, userId) {
  const { rows } = await db.query(
    `SELECT id, user_id, full_html, full_html_edited
       FROM tasks
      WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  if (!rows.length) {
    const err = new Error('Задача не найдена или доступ запрещён');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function getOrCreateSession(taskId, userId, llmProvider = null) {
  // Inherit provider from the task on first creation. Subsequent calls
  // honour the existing session row (UPDATE ... updated_at = NOW()).
  // If llmProvider explicitly passed (allowed values 'gemini'|'grok') —
  // overrides on update too, so user can switch mid-session.
  let provider = null;
  if (llmProvider != null) {
    const lc = String(llmProvider).toLowerCase().trim();
    provider = (lc === 'grok' || lc === 'gemini') ? lc : null;
  }
  if (!provider) {
    const { rows: tRows } = await db.query(
      `SELECT llm_provider FROM tasks WHERE id = $1`,
      [taskId]
    );
    provider = (tRows[0]?.llm_provider || 'gemini').toString().toLowerCase();
    if (provider !== 'grok' && provider !== 'gemini') provider = 'gemini';
  }

  const { rows } = await db.query(
    `INSERT INTO editor_copilot_sessions (task_id, user_id, llm_provider)
     VALUES ($1, $2, $3)
     ON CONFLICT (task_id) DO UPDATE SET
       updated_at   = NOW(),
       llm_provider = COALESCE(EXCLUDED.llm_provider, editor_copilot_sessions.llm_provider)
     RETURNING *`,
    [taskId, userId, provider]
  );
  return rows[0];
}

// ────────────────────────────────────────────────────────────────────
// GET /api/editor-copilot/presets — список доступных Intent-пресетов
// ────────────────────────────────────────────────────────────────────
async function getPresets(req, res) {
  res.json({ presets: listPresets(), model: COPILOT_MODEL });
}

// ────────────────────────────────────────────────────────────────────
// GET /api/editor-copilot/:taskId/session — сводка сессии для UI
// ────────────────────────────────────────────────────────────────────
async function getSession(req, res, next) {
  try {
    await loadOwnTask(req.params.taskId, req.user.id);
    const session = await getOrCreateSession(req.params.taskId, req.user.id);
    const { rows: ops } = await db.query(
      `SELECT id, action, status, applied, applied_mode, tokens_in, tokens_out, cost_usd,
              model_used, created_at, completed_at, error_message
         FROM editor_copilot_operations
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [req.params.taskId]
    );
    res.json({
      session: {
        id:               session.id,
        total_tokens_in:  Number(session.total_tokens_in)  || 0,
        total_tokens_out: Number(session.total_tokens_out) || 0,
        total_cost_usd:   Number(session.total_cost_usd)   || 0,
      },
      operations: ops,
      model:      COPILOT_MODEL,
    });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// GET /api/editor-copilot/:taskId/operations — список операций
// ────────────────────────────────────────────────────────────────────
async function listOperations(req, res, next) {
  try {
    await loadOwnTask(req.params.taskId, req.user.id);
    const { rows } = await db.query(
      `SELECT id, action, selected_text, user_prompt, extra_params,
              status, result_text, applied, applied_mode,
              tokens_in, tokens_out, cost_usd, model_used,
              error_message, logs, created_at, completed_at
         FROM editor_copilot_operations
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.params.taskId]
    );
    res.json({ operations: rows });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// GET /api/editor-copilot/:taskId/operations/:opId — одна операция
// ────────────────────────────────────────────────────────────────────
async function getOperation(req, res, next) {
  try {
    await loadOwnTask(req.params.taskId, req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM editor_copilot_operations
        WHERE id = $1 AND task_id = $2`,
      [req.params.opId, req.params.taskId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Operation not found' });
    res.json({ operation: rows[0] });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// POST /api/editor-copilot/:taskId/operations — создать операцию
//   body: { action, selected_text?, user_prompt?, extra_params? }
//   возвращает { operationId } — далее клиент открывает SSE-стрим.
// ────────────────────────────────────────────────────────────────────
async function createOperation(req, res, next) {
  try {
    const { taskId } = req.params;
    const task = await loadOwnTask(taskId, req.user.id);

    const action        = String(req.body.action || '').trim();
    const selected_text = req.body.selected_text == null ? null : String(req.body.selected_text);
    const user_prompt   = req.body.user_prompt   == null ? null : String(req.body.user_prompt);
    const extra_params  = req.body.extra_params && typeof req.body.extra_params === 'object'
      ? req.body.extra_params : null;

    if (selected_text && selected_text.length > MAX_SELECTED_TEXT) {
      return res.status(400).json({ error: `selected_text слишком длинный (>${MAX_SELECTED_TEXT} симв.)` });
    }
    if (user_prompt && user_prompt.length > MAX_USER_PROMPT) {
      return res.status(400).json({ error: `user_prompt слишком длинный (>${MAX_USER_PROMPT} симв.)` });
    }

    const validationError = validateRequest({ action, selected_text, user_prompt, extra_params });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (!task.full_html && !task.full_html_edited) {
      return res.status(400).json({ error: 'Статья ещё не сгенерирована — AI-Copilot недоступен' });
    }

    const session = await getOrCreateSession(taskId, req.user.id, req.body.llm_provider);

    const { rows } = await db.query(
      `INSERT INTO editor_copilot_operations
         (session_id, task_id, user_id, action, selected_text, user_prompt, extra_params, status, model_used, llm_provider)
       VALUES ($1, $2, $3, $4::editor_copilot_action, $5, $6, $7, 'pending', $8, $9)
       RETURNING id, status, created_at`,
      [session.id, taskId, req.user.id, action, selected_text, user_prompt,
       extra_params ? JSON.stringify(extra_params) : null, COPILOT_MODEL,
       session.llm_provider || 'gemini']
    );

    res.status(201).json({ operationId: rows[0].id, status: rows[0].status });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// GET /api/editor-copilot/:taskId/operations/:opId/stream — SSE
//   Стримит события: log / token / usage / snapshot / done / error.
//   Если операция в статусе pending — запускает её. Если уже streaming —
//   подключается к активному стриму. Если done/error — отдаёт snapshot+done.
// ────────────────────────────────────────────────────────────────────
async function streamOperation(req, res, next) {
  try {
    const { taskId, opId } = req.params;
    await loadOwnTask(taskId, req.user.id);

    const { rows } = await db.query(
      `SELECT id, status, result_text, tokens_in, tokens_out, cost_usd
         FROM editor_copilot_operations
        WHERE id = $1 AND task_id = $2`,
      [opId, taskId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Operation not found' });
    const op = rows[0];

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`event: init\ndata: ${JSON.stringify({ operationId: opId, status: op.status })}\n\n`);

    // Подписываем клиента до запуска (на случай если runStream быстро закончится)
    const unsubscribe = attachSubscriber(opId, res);
    req.on('close', () => { try { unsubscribe(); } catch (_) {} });

    // Heartbeat каждые 25 сек, чтобы прокси/nginx не закрывал idle-соединение.
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) {}
    }, 25_000);
    req.on('close', () => clearInterval(hb));

    // Если операция уже завершена — сразу отправляем done, runStream сам поймёт.
    if (op.status === 'done' || op.status === 'cancelled' || op.status === 'error') {
      res.write(`event: snapshot\ndata: ${JSON.stringify({ text: op.result_text || '' })}\n\n`);
      res.write(`event: usage\ndata: ${JSON.stringify({ tokens_in: op.tokens_in, tokens_out: op.tokens_out, cost_usd: Number(op.cost_usd) })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ status: op.status, result: op.result_text || '' })}\n\n`);
      // Не закрываем сразу, даём клиенту обработать.
      return;
    }

    // Если pending — запускаем стрим (не ждём завершения, чтобы вернуть HTTP-handshake).
    if (op.status === 'pending') {
      // Fire-and-forget: ошибки уходят в SSE.
      runStream({ operationId: opId, taskId }).catch((err) => {
        console.error('[copilot] runStream uncaught:', err.message);
      });
    }
    // Если streaming — runStream уже бежит в другом запросе, мы просто подписаны.
  } catch (e) {
    if (!res.headersSent) next(e);
  }
}

// ────────────────────────────────────────────────────────────────────
// POST /api/editor-copilot/:taskId/operations/:opId/cancel
// ────────────────────────────────────────────────────────────────────
async function cancelOperation(req, res, next) {
  try {
    const { taskId, opId } = req.params;
    await loadOwnTask(taskId, req.user.id);
    const inMem = requestCancel(opId);
    // Также форсим в БД на случай, если воркер уже умер
    await db.query(
      `UPDATE editor_copilot_operations
          SET status='cancelled', completed_at=NOW()
        WHERE id=$1 AND task_id=$2 AND status IN ('pending','streaming')`,
      [opId, taskId]
    );
    res.json({ ok: true, signaled: inMem });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// POST /api/editor-copilot/:taskId/operations/:opId/apply
//   body: { mode: 'replace'|'insert_below', new_full_html: string }
// ────────────────────────────────────────────────────────────────────
async function applyOperation(req, res, next) {
  try {
    const { taskId, opId } = req.params;
    await loadOwnTask(taskId, req.user.id);

    const mode = req.body.mode;
    const newHtml = String(req.body.new_full_html || '');
    if (mode !== 'replace' && mode !== 'insert_below') {
      return res.status(400).json({ error: 'mode must be "replace" or "insert_below"' });
    }
    if (!newHtml.trim()) {
      return res.status(400).json({ error: 'new_full_html is empty' });
    }
    if (newHtml.length > MAX_HTML_APPLY) {
      return res.status(400).json({ error: `new_full_html слишком большой (>${MAX_HTML_APPLY} симв.)` });
    }

    const { rows } = await db.query(
      `SELECT id, status FROM editor_copilot_operations
        WHERE id = $1 AND task_id = $2`,
      [opId, taskId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Operation not found' });
    if (rows[0].status !== 'done') {
      return res.status(409).json({ error: `Нельзя применить операцию в статусе "${rows[0].status}"` });
    }

    // Пишем в обе сущности атомарно.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE tasks SET full_html_edited = $1 WHERE id = $2`,
        [newHtml, taskId]
      );
      await client.query(
        `UPDATE editor_copilot_operations
            SET applied = TRUE, applied_mode = $1::editor_copilot_apply_mode
          WHERE id = $2`,
        [mode, opId]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
}

// ────────────────────────────────────────────────────────────────────
// POST /api/editor-copilot/:taskId/html-edited — ручное сохранение HTML
//   body: { html: string }  (для случаев когда пользователь правит руками
//   без AI-операции, чтобы не потерять при F5).
// ────────────────────────────────────────────────────────────────────
async function saveEditedHtml(req, res, next) {
  try {
    const { taskId } = req.params;
    await loadOwnTask(taskId, req.user.id);
    const html = String(req.body.html || '');
    if (html.length > MAX_HTML_APPLY) {
      return res.status(400).json({ error: `html слишком большой (>${MAX_HTML_APPLY} симв.)` });
    }
    await db.query(
      `UPDATE tasks SET full_html_edited = $1 WHERE id = $2`,
      [html.trim() ? html : null, taskId]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  getPresets,
  getSession,
  listOperations,
  getOperation,
  createOperation,
  streamOperation,
  cancelOperation,
  applyOperation,
  saveEditedHtml,
};
