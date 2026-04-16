'use strict';

/**
 * SSE Manager — Server-Sent Events для реалтайм-логов задач.
 *
 * Архитектура: Map<taskId → Set<res>>
 * Каждый клиент, открывший GET /api/tasks/:id/stream, добавляется в Set.
 * Worker публикует события через publish(taskId, event).
 */

// taskId (string) → Set<express.Response>
const clients = new Map();

// -----------------------------------------------------------------
// subscribe(taskId, res)
// Вызывается из роутера при GET /api/tasks/:id/stream
// -----------------------------------------------------------------

/**
 * Подписывает HTTP-ответ на SSE-поток задачи.
 *
 * @param {string}           taskId
 * @param {express.Response} res
 */
function subscribe(taskId, res) {
  // Заголовки SSE уже установлены в streamTask контроллере (иначе Node.js
  // бросит "Cannot set headers after they are sent").
  // Здесь только регистрируем клиента и налаживаем heartbeat.

  // Сразу шлём keepalive-комментарий (не является SSE-событием)
  if (!res.writableEnded) {
    res.write(`: connected to task ${taskId}\n\n`);
  }

  // Регистрируем клиента
  if (!clients.has(taskId)) clients.set(taskId, new Set());
  clients.get(taskId).add(res);

  console.log(
    `[SSE] Client subscribed to task ${taskId}. ` +
    `Total listeners: ${clients.get(taskId).size}`
  );

  // Keepalive — heartbeat каждые 25 секунд (предотвращает таймаут прокси)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    } else {
      clearInterval(heartbeat);
    }
  }, 25000);

  // При закрытии соединения — чистим
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.get(taskId)?.delete(res);
    if (clients.get(taskId)?.size === 0) clients.delete(taskId);
    console.log(`[SSE] Client disconnected from task ${taskId}`);
  });

  // Обрыв сети
  res.on('error', (err) => {
    console.error(`[SSE] Response error for task ${taskId}:`, err.message);
    clearInterval(heartbeat);
    clients.get(taskId)?.delete(res);
  });
}

// -----------------------------------------------------------------
// publish(taskId, event)
// Вызывается из Worker и pipeline-функций
// -----------------------------------------------------------------

/**
 * Публикует событие всем подписчикам задачи.
 *
 * Формат события (из раздела 7.2 ТЗ):
 * { type: 'log'|'progress'|'block'|'tokens'|'done'|'error', ...payload }
 *
 * @param {string} taskId
 * @param {object} event
 */
function publish(taskId, event) {
  const taskClients = clients.get(taskId);
  if (!taskClients || taskClients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const res of taskClients) {
    try {
      if (!res.writableEnded) {
        res.write(payload);
      }
    } catch (err) {
      // Клиент отвалился во время записи — убираем тихо
      console.error(`[SSE] Failed to write to client for task ${taskId}:`, err.message);
      taskClients.delete(res);
    }
  }
}

// -----------------------------------------------------------------
// closeTask(taskId)
// Закрывает все SSE-соединения задачи (вызывается при DELETE /tasks/:id)
// -----------------------------------------------------------------

/**
 * Принудительно закрывает все SSE-соединения для задачи.
 * @param {string} taskId
 */
function closeTask(taskId) {
  const taskClients = clients.get(taskId);
  if (!taskClients) return;

  // Шлём финальное событие перед закрытием
  publish(taskId, { type: 'closed', taskId, msg: 'Task deleted' });

  for (const res of taskClients) {
    try {
      if (!res.writableEnded) res.end();
    } catch (_) { /* клиент уже отвалился */ }
  }

  clients.delete(taskId);
  console.log(`[SSE] All connections closed for task ${taskId}`);
}

/**
 * Количество активных SSE-клиентов для задачи.
 * @param {string} taskId
 * @returns {number}
 */
function getClientCount(taskId) {
  return clients.get(taskId)?.size || 0;
}

module.exports = { subscribe, publish, closeTask, getClientCount };
