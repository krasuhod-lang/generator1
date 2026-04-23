'use strict';

/**
 * SSE Manager — Server-Sent Events для реалтайм-логов задач.
 *
 * Архитектура:
 *   - Локальные SSE-клиенты: Map<taskId → Set<res>>
 *   - Кросс-процессная доставка: Redis Pub/Sub
 *
 * Backend (HTTP-сервер) и Worker (BullMQ) запускаются в отдельных
 * контейнерах/процессах. publish() отправляет событие в Redis-канал,
 * а подписчик на стороне backend-процесса пересылает его в локальные
 * SSE-соединения. Это решает проблему, когда Worker публикует события
 * в свою in-memory Map, у которой нет клиентов.
 */

const Redis = require('ioredis');
const { persistEvent } = require('./taskLogPersister');

const SSE_CHANNEL = 'sse:events';

// ── Redis-подключения ────────────────────────────────────────────────────────
// Для Pub/Sub нужны два отдельных соединения (ioredis requirement).

function createRedisClient(label) {
  const url = process.env.REDIS_URL;
  let client;
  if (url) {
    client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  } else {
    client = new Redis({
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }
  client.on('error', (err) => {
    console.error(`[SSE][Redis:${label}] Error:`, err.message);
  });
  client.connect().catch((err) => {
    console.error(`[SSE][Redis:${label}] Connect failed:`, err.message);
  });
  return client;
}

const redisPub = createRedisClient('pub');
const redisSub = createRedisClient('sub');

// ── Локальные SSE-клиенты ────────────────────────────────────────────────────
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
// _deliverLocally(taskId, event)
// Доставляет событие локальным SSE-клиентам текущего процесса
// -----------------------------------------------------------------

function _deliverLocally(taskId, event) {
  const taskClients = clients.get(taskId);
  if (!taskClients || taskClients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const res of taskClients) {
    try {
      if (!res.writableEnded) {
        res.write(payload);
      }
    } catch (err) {
      console.error(`[SSE] Failed to write to client for task ${taskId}:`, err.message);
      taskClients.delete(res);
    }
  }
}

// -----------------------------------------------------------------
// Redis Pub/Sub subscriber
// Получает события из Redis и доставляет локальным SSE-клиентам
// -----------------------------------------------------------------

redisSub.subscribe(SSE_CHANNEL).catch((err) => {
  console.error('[SSE] Redis subscribe failed:', err.message);
});

redisSub.on('message', (channel, message) => {
  if (channel !== SSE_CHANNEL) return;
  try {
    const { taskId, event } = JSON.parse(message);
    _deliverLocally(taskId, event);
  } catch (err) {
    console.error('[SSE] Failed to parse Redis message:', err.message);
  }
});

// -----------------------------------------------------------------
// publish(taskId, event)
// Вызывается из Worker и pipeline-функций.
// Публикует событие через Redis Pub/Sub → все процессы получают его.
// -----------------------------------------------------------------

/**
 * Публикует событие всем подписчикам задачи через Redis Pub/Sub.
 *
 * Формат события (из раздела 7.2 ТЗ):
 * { type: 'log'|'progress'|'block'|'tokens'|'done'|'error', ...payload }
 *
 * @param {string} taskId
 * @param {object} event
 */
function publish(taskId, event) {
  // Персистим событие в БД (батчем, не блокируя SSE).
  // taskLogPersister сам решает, что писать (init/closed/heartbeat пропускает).
  try { persistEvent(taskId, event); } catch (err) {
    console.warn(`[SSE] persistEvent failed for task ${taskId}:`, err.message);
  }
  const message = JSON.stringify({ taskId, event });
  redisPub.publish(SSE_CHANNEL, message).catch((err) => {
    console.warn(`[SSE] Redis publish failed for task ${taskId}, falling back to local delivery:`, err.message);
    _deliverLocally(taskId, event);
  });
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

  // Шлём финальное событие перед закрытием (локально, т.к. после этого
  // соединения закрываются — нет смысла слать через Redis в другие процессы)
  _deliverLocally(taskId, { type: 'closed', taskId, msg: 'Task deleted' });

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
