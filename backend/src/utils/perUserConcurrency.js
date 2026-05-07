'use strict';

/**
 * perUserConcurrency.js — лимит «не более N задач одновременно на пользователя».
 *
 * Назначение
 * ──────────
 * Все «тяжёлые» фоновые задачи (info-article, link-article, meta-tags,
 * relevance, article-topics) запускаются контроллерами через `setImmediate`
 * и НЕ проходят через BullMQ. Если пользователь нажимает «создать» 5 раз
 * подряд, в одном Node-процессе одновременно стартуют 5 пайплайнов, каждый
 * из которых внутри себя делает десятки параллельных вызовов к Gemini /
 * DeepSeek / Grok. На практике это:
 *   • выгребает TPM на API-ключе в N раз быстрее,
 *   • пробивает квоту одновременных reasoning-сессий preview-моделей
 *     (типичный триггер `503 model is overloaded`),
 *   • вызывает thundering-herd при бэкоффе после 429/503,
 *   • увеличивает риск падения по таймауту/прокси-rotation.
 *
 * Решение
 * ───────
 * Тонкая FIFO-семафор-обёртка `withUserSlot(userId, fn)`:
 *   - До вызова — занимает один из MAX_PER_USER слотов конкретного userId.
 *   - Если слотов нет — становится в FIFO-очередь и ждёт `release()`.
 *   - После выполнения (success или throw) — освобождает слот и
 *     передаёт его следующему ожидающему этого же пользователя.
 *
 * Лимит выставлен жёстко в коде (см. `MAX_PER_USER`), env-переменные
 * не используются по требованию. Ограничение действует ТОЛЬКО в пределах
 * одного worker/web-процесса; если backend масштабируется горизонтально,
 * пользователь теоретически сможет получить до `MAX_PER_USER × N_процессов`
 * слотов — но текущий деплой однопроцессный.
 *
 * Поведение при перезапуске процесса
 * ──────────────────────────────────
 * Состояние in-memory и теряется при рестарте, как и сами `setImmediate`-
 * хвосты. Это не регрессия: до этой обёртки задачи в `status='queued'`,
 * по которым `setImmediate` не успел отработать, тоже зависали — отдельных
 * recovery-механизмов для них нет ни до, ни после.
 */

// Жёстко зашитый лимит по требованию задачи: «максимум 2 задачи параллельно
// в рамках одного личного кабинета». Сознательно НЕ читается из ENV.
const MAX_PER_USER = 2;

// Состояние per-user: userKey -> { active: number, waiters: Array<resolveFn> }
// Используем Map, чтобы корректно работать с любыми типами userId
// (uuid-строка, integer и т.п.) без коллизий ключей.
const _state = new Map();

function _keyFor(userId) {
  // null/undefined → общий «анонимный» бакет, чтобы не отключать защиту
  // в редких ситуациях, когда задача создаётся без auth-контекста.
  if (userId === null || userId === undefined || userId === '') return '__anon__';
  return String(userId);
}

function _bucket(userId) {
  const key = _keyFor(userId);
  let st = _state.get(key);
  if (!st) {
    st = { active: 0, waiters: [] };
    _state.set(key, st);
  }
  return st;
}

/**
 * Получает разрешение на запуск задачи под конкретным userId.
 * Возвращает функцию `release()`, которую ОБЯЗАТЕЛЬНО нужно вызвать
 * в `finally` — иначе слот «утечёт» и забьёт очередь навсегда.
 *
 * @param {string|number|null|undefined} userId
 * @returns {Promise<{release: () => void, waitedMs: number, queued: boolean}>}
 */
function acquireUserSlot(userId) {
  const st = _bucket(userId);
  const waitStart = Date.now();

  if (st.active < MAX_PER_USER) {
    st.active += 1;
    return Promise.resolve({
      release: () => _release(userId),
      waitedMs: 0,
      queued: false,
    });
  }

  return new Promise((resolve) => {
    st.waiters.push(() => {
      // Слот «передан» нам предыдущим release(); active уже инкрементирован
      // в _release ниже (transfer of ownership), счётчик не меняется здесь.
      resolve({
        release: () => _release(userId),
        waitedMs: Date.now() - waitStart,
        queued: true,
      });
    });
  });
}

function _release(userId) {
  const st = _bucket(userId);
  // Если есть кто ждёт — передаём слот, не декрементируя active
  // (передача владения слотом от завершившейся задачи к ожидающей).
  const next = st.waiters.shift();
  if (next) {
    next();
    return;
  }
  st.active = Math.max(0, st.active - 1);
  // Чистим пустые бакеты, чтобы Map не рос бесконечно при большом числе
  // редко-активных пользователей.
  if (st.active === 0 && st.waiters.length === 0) {
    _state.delete(_keyFor(userId));
  }
}

/**
 * Оборачивает асинхронную функцию `fn` per-user семафором.
 * Используется в setImmediate-обёртках контроллеров вокруг
 * `process<TaskType>Task(taskId)`.
 *
 * @template T
 * @param {string|number|null|undefined} userId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withUserSlot(userId, fn) {
  const slot = await acquireUserSlot(userId);
  try {
    return await fn();
  } finally {
    slot.release();
  }
}

/**
 * Диагностическая функция — состояние конкретного пользователя.
 *
 * @param {string|number|null|undefined} userId
 * @returns {{active: number, queued: number, max: number}}
 */
function getUserSlotStats(userId) {
  const key = _keyFor(userId);
  const st = _state.get(key);
  return {
    active: st ? st.active : 0,
    queued: st ? st.waiters.length : 0,
    max:    MAX_PER_USER,
  };
}

module.exports = {
  MAX_PER_USER,
  acquireUserSlot,
  withUserSlot,
  getUserSlotStats,
};
