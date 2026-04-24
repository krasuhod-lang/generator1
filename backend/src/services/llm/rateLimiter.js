'use strict';

/**
 * rateLimiter.js — per-provider concurrency semaphore for LLM calls.
 *
 * Назначение
 * ──────────
 * При параллельной обработке 50–100 задач (BullMQ workers × per-stage
 * параллельность Promise.all внутри Stage 1/2 / pre-stage 0) число одновременных
 * HTTP-запросов к DeepSeek / Gemini / Grok легко выходит за безопасный RPS
 * для одного API-ключа, даже на платных тарифах. Возникает каскад 429/503,
 * обходимый только бэкоффом, который удлиняет каждую задачу в разы.
 *
 * Решение
 * ───────
 * Тонкая семафор-обёртка `withProviderSlot(provider, fn)`:
 *   - До вызова — занимает один из N свободных слотов провайдера.
 *   - Если слотов нет — становится в FIFO-очередь и ждёт `release()`.
 *   - После выполнения (success или throw) — освобождает слот.
 *
 * Лимиты задаются env-переменными (per-process, на одного worker):
 *   DEEPSEEK_MAX_CONCURRENT  (default 8)
 *   GEMINI_MAX_CONCURRENT    (default 6)
 *   XAI_MAX_CONCURRENT       (default 4)
 *
 * Установить значение `0` — полностью отключает throttling для провайдера
 * (например, если у вас выделенный пул прокси / enterprise-tier ключ).
 *
 * Опционально:
 *   LLM_QUEUE_WARN_MS (default 5000) — если слот ждали дольше порога,
 *   пишем `console.warn` для диагностики bottleneck'ов в production.
 *
 * Бэквард-совместимость
 * ─────────────────────
 * Дефолтные лимиты подобраны под Tier-1 платные ключи и НЕ медленнее
 * текущего поведения для типичной задачи (3 параллельных Stage-1 вызова
 * пройдут моментально). Для одиночной задачи (single user) overhead ≈ 0 —
 * семафор просто увеличивает счётчик.
 */

function _readLimit(envName, defaultVal) {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  return n;
}

const LIMITS = Object.freeze({
  deepseek: _readLimit('DEEPSEEK_MAX_CONCURRENT', 8),
  gemini:   _readLimit('GEMINI_MAX_CONCURRENT',   6),
  grok:     _readLimit('XAI_MAX_CONCURRENT',      4),
});

const QUEUE_WARN_MS = _readLimit('LLM_QUEUE_WARN_MS', 5000);

// Состояние per-provider: { active: number, waiters: Array<resolveFn> }
const _state = {
  deepseek: { active: 0, waiters: [] },
  gemini:   { active: 0, waiters: [] },
  grok:     { active: 0, waiters: [] },
};

/**
 * Получает разрешение на запуск вызова. Возвращает функцию `release()`,
 * которую ОБЯЗАТЕЛЬНО нужно вызвать в finally — даже если основной вызов
 * бросил исключение, иначе слот «утечёт» и забьёт очередь навсегда.
 *
 * @param {'deepseek'|'gemini'|'grok'} provider
 * @returns {Promise<{release: function(): void, waitedMs: number}>}
 */
function _acquire(provider) {
  const limit = LIMITS[provider];
  // limit=0 → throttling отключён, выдаём пустой release
  if (!limit) {
    return Promise.resolve({ release: () => {}, waitedMs: 0 });
  }
  const st = _state[provider];
  if (!st) {
    // Неизвестный провайдер — не блокируем, но логируем (это баг кода)
    console.warn(`[rateLimiter] Unknown provider "${provider}" — bypass`);
    return Promise.resolve({ release: () => {}, waitedMs: 0 });
  }

  const waitStart = Date.now();

  if (st.active < limit) {
    st.active += 1;
    return Promise.resolve({
      release: () => _release(provider),
      waitedMs: 0,
    });
  }

  // Слотов нет — встаём в FIFO очередь
  return new Promise((resolve) => {
    st.waiters.push(() => {
      st.active += 1;
      const waitedMs = Date.now() - waitStart;
      if (QUEUE_WARN_MS > 0 && waitedMs > QUEUE_WARN_MS) {
        console.warn(
          `[rateLimiter] ${provider} slot waited ${waitedMs}ms ` +
          `(active=${st.active}/${limit}, queued=${st.waiters.length})`
        );
      }
      resolve({
        release: () => _release(provider),
        waitedMs,
      });
    });
  });
}

function _release(provider) {
  const st = _state[provider];
  if (!st) return;
  st.active = Math.max(0, st.active - 1);
  // Передаём слот следующему ожидающему (FIFO):
  // active декрементирован выше; внутри next() он будет инкрементирован
  // обратно — итоговый счётчик не меняется (transfer of ownership).
  const next = st.waiters.shift();
  if (next) next();
}

/**
 * Оборачивает асинхронную функцию `fn` per-provider семафором.
 * Используется в callLLM прямо вокруг `await callFn(...)`.
 *
 * @template T
 * @param {'deepseek'|'gemini'|'grok'} provider
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withProviderSlot(provider, fn) {
  const slot = await _acquire(provider);
  try {
    return await fn();
  } finally {
    slot.release();
  }
}

/**
 * Диагностическая функция — текущая загрузка провайдеров.
 * Полезна для admin endpoint'а или health-check.
 *
 * @returns {{deepseek: object, gemini: object, grok: object, limits: object}}
 */
function getStats() {
  return {
    limits: { ...LIMITS },
    deepseek: { active: _state.deepseek.active, queued: _state.deepseek.waiters.length },
    gemini:   { active: _state.gemini.active,   queued: _state.gemini.waiters.length },
    grok:     { active: _state.grok.active,     queued: _state.grok.waiters.length },
  };
}

module.exports = {
  withProviderSlot,
  getStats,
  // Экспорт для тестов
  _LIMITS: LIMITS,
};
