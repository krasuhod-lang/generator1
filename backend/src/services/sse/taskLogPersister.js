'use strict';

/**
 * taskLogPersister — буферизованная запись SSE-событий задач в task_logs.
 *
 * Используется sseManager.publish(): рядом с публикацией SSE мы вызываем
 * persistEvent(taskId, event) — он копит события в памяти и сбрасывает
 * пачкой каждые ~1с (или раньше, если буфер достиг FLUSH_BATCH_SIZE).
 *
 * Запись идёт ОДНИМ INSERT с ROWS-литералом, чтобы не плодить запросов.
 * Любая ошибка БД логируется и не прерывает работу пайплайна.
 *
 * Что НЕ пишем:
 *   - heartbeat / closed / init — внутренняя SSE-механика.
 *   - очень большие payload'ы (> 64 KB) — обрезаем до 64 KB чтобы не
 *     раздуть таблицу (типичный кейс — taxonomy с 30 блоками с длинными h2).
 */

const db = require('../../config/db');

const FLUSH_INTERVAL_MS  = 1000;
const FLUSH_BATCH_SIZE   = 50;
const MAX_PAYLOAD_BYTES  = 64 * 1024;
const MAX_MESSAGE_LENGTH = 4000;

const SKIP_TYPES = new Set(['init', 'closed', 'heartbeat']);

const buffer = [];
let flushTimer = null;
let flushing   = false;

function _scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((err) => {
      console.error('[taskLogPersister] flush failed:', err.message);
    });
  }, FLUSH_INTERVAL_MS);
}

function _truncatePayload(obj) {
  let json;
  try {
    json = JSON.stringify(obj);
  } catch (_) {
    return null;
  }
  if (json.length <= MAX_PAYLOAD_BYTES) return obj;
  // Возвращаем placeholder с длиной — детали потерялись, но факт события
  // остался в логах для сопоставления с метриками.
  return { _truncated: true, _original_size: json.length };
}

/**
 * Принимает SSE-событие и кладёт его в буфер на персист.
 *
 * @param {string} taskId
 * @param {object} event — { type, msg?, level?, ts?, ...payload }
 */
function persistEvent(taskId, event) {
  if (!taskId || !event || typeof event !== 'object') return;
  const type = event.type || 'log';
  if (SKIP_TYPES.has(type)) return;

  const level   = (event.level || 'info').toString().slice(0, 16);
  const stage   = event.stage ? String(event.stage).slice(0, 32) : null;
  const message = event.msg
    ? String(event.msg).slice(0, MAX_MESSAGE_LENGTH)
    : (event.message ? String(event.message).slice(0, MAX_MESSAGE_LENGTH) : null);

  // Payload — всё событие целиком (минус message/level/stage/type, чтобы
  // не дублировать). Это полезно для типов 'block_done', 'tokens', и т.п.
  const { type: _t, msg: _m, message: _mm, level: _l, stage: _s, ts: _ts, ...rest } = event;
  const payload = Object.keys(rest).length ? _truncatePayload(rest) : null;

  buffer.push({
    task_id:    taskId,
    ts:         event.ts && /^\d{4}-/.test(event.ts) ? new Date(event.ts) : new Date(),
    level,
    stage,
    event_type: type.toString().slice(0, 32),
    message,
    payload,
  });

  if (buffer.length >= FLUSH_BATCH_SIZE) {
    flush().catch((err) => {
      console.error('[taskLogPersister] flush (batch) failed:', err.message);
    });
  } else {
    _scheduleFlush();
  }
}

/**
 * flush — записывает текущий буфер в task_logs одним INSERT.
 * Защищён от reentrance флагом `flushing`.
 */
async function flush() {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;

  const batch = buffer.splice(0, buffer.length);
  try {
    // Параметризованный INSERT: ($1,$2,...,$7), ($8,...) — по 7 полей на запись.
    const rows  = [];
    const params = [];
    let i = 1;
    for (const row of batch) {
      rows.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        row.task_id,
        row.ts,
        row.level,
        row.stage,
        row.event_type,
        row.message,
        row.payload ? JSON.stringify(row.payload) : null,
      );
    }
    await db.query(
      `INSERT INTO task_logs (task_id, ts, level, stage, event_type, message, payload)
       VALUES ${rows.join(',')}`,
      params,
    );
  } catch (err) {
    // Не теряем данные при ошибке — но и не зацикливаемся: ставим обратно
    // только если ошибка похожа на временную (UNDEFINED_TABLE — миграция
    // ещё не накачена). Для остальных — теряем батч (уже залогировали).
    if (err.code === '42P01') {
      console.warn('[taskLogPersister] task_logs table missing — drop batch silently');
    } else {
      console.error('[taskLogPersister] INSERT failed:', err.message);
    }
  } finally {
    flushing = false;
  }
}

/**
 * Принудительный flush — для shutdown hook'ов и тестов.
 */
async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
}

// Сбрасываем буфер при штатном завершении процесса, чтобы не потерять
// последние события (особенно важно для done/error финальных).
process.on('beforeExit', () => { flushNow().catch(() => {}); });
process.on('SIGTERM',    () => { flushNow().catch(() => {}); });

module.exports = { persistEvent, flushNow };
