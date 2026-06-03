'use strict';

/**
 * projects/batchAnalyzer.js — порционная (map-reduce) обработка больших
 * объёмов данных GSC.
 *
 * Когда запросов и строк «запрос × страница» становится несколько сотен или
 * тысяч, единый промт к LLM раздувается, теряет фокус и упирается в лимит
 * контекста. Решение — map-reduce:
 *   1. MAP   — данные режутся на порции (chunks); по каждой LLM извлекает
 *              ёмкие выводы и гипотезы (компактный текст/буллеты).
 *   2. REDUCE — частичные выводы всех порций сводятся в общий пул и единый
 *              структурированный отчёт.
 *
 * Модуль ничего не знает про DeepSeek/GSC напрямую: map- и reduce-функции
 * передаются снаружи (инъекция), что делает оркестрацию детерминированно
 * тестируемой без сети/LLM.
 */

/**
 * Делит массив на порции фиксированного размера.
 * @returns {Array<Array>}
 */
function chunkArray(arr, size) {
  const list = Array.isArray(arr) ? arr : [];
  const n = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Оценивает «объём работы» среза: число топ-запросов + строк query×page.
 * Используется для решения, включать ли порционный режим.
 */
function estimateWorkload({ topQueries, topPages, queryPage } = {}) {
  const q = Array.isArray(topQueries) ? topQueries.length : 0;
  const p = Array.isArray(topPages) ? topPages.length : 0;
  const qp = Array.isArray(queryPage) ? queryPage.length : 0;
  return q + p + qp;
}

/**
 * Нужен ли порционный режим для данного объёма.
 */
function shouldBatch(workload, cfg) {
  if (!cfg || !cfg.enabled) return false;
  return Number(workload) > Number(cfg.workloadThreshold || Infinity);
}

/**
 * Строит порции из среза данных: режет самый «тяжёлый» источник (query×page,
 * иначе topQueries) на чанки ≤ chunkSize, но не больше maxChunks (последний
 * чанк добирает остаток, чтобы ничего не потерять).
 *
 * @returns {Array<{index, total, items}>}
 */
function buildChunks(slice, cfg) {
  const chunkSize = Math.max(1, Number(cfg.chunkSize) || 150);
  const maxChunks = Math.max(1, Number(cfg.maxChunks) || 12);

  const source = (Array.isArray(slice.queryPage) && slice.queryPage.length)
    ? slice.queryPage
    : (Array.isArray(slice.topQueries) ? slice.topQueries : []);

  let chunks = chunkArray(source, chunkSize);
  if (chunks.length > maxChunks) {
    // Схлопываем «хвост» в последнюю порцию, чтобы не плодить тысячи вызовов.
    const head = chunks.slice(0, maxChunks - 1);
    const tail = chunks.slice(maxChunks - 1).reduce((acc, c) => acc.concat(c), []);
    chunks = head.concat([tail]);
  }
  const total = chunks.length;
  return chunks.map((items, index) => ({ index: index + 1, total, items }));
}

/**
 * Запускает функции с ограниченным параллелизмом, сохраняя порядок входа.
 * Ошибка отдельной задачи не валит весь батч — возвращаем {ok,value|error}.
 */
async function _mapLimited(items, concurrency, fn) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: (err && err.message) ? err.message : String(err) };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Полный цикл map-reduce.
 *
 * @param {Object} params
 *   chunks      Array (порции из buildChunks)
 *   mapFn       async (chunk) => partial  — ёмкие выводы/гипотезы по порции
 *   reduceFn    async (partials, meta) => finalResult
 *   concurrency число параллельных map-вызовов
 * @returns {Promise<{ result, partials, warnings, stats }>}
 */
async function runMapReduce({ chunks, mapFn, reduceFn, concurrency = 3 } = {}) {
  const warnings = [];
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('runMapReduce: пустой набор порций');
  }
  if (typeof mapFn !== 'function' || typeof reduceFn !== 'function') {
    throw new Error('runMapReduce: mapFn и reduceFn обязательны');
  }

  const mapped = await _mapLimited(chunks, concurrency, (chunk) => mapFn(chunk));
  const partials = [];
  mapped.forEach((res, i) => {
    if (res.ok && res.value != null) {
      partials.push(res.value);
    } else {
      warnings.push(`map_chunk_${i + 1}_failed:${(res.error || 'empty').slice(0, 120)}`);
    }
  });

  if (partials.length === 0) {
    throw new Error('runMapReduce: все порции упали на map-фазе');
  }

  const result = await reduceFn(partials, {
    chunkCount: chunks.length,
    okCount: partials.length,
    failedCount: chunks.length - partials.length,
  });

  return {
    result,
    partials,
    warnings,
    stats: {
      chunk_count: chunks.length,
      ok_count: partials.length,
      failed_count: chunks.length - partials.length,
    },
  };
}

module.exports = {
  chunkArray,
  estimateWorkload,
  shouldBatch,
  buildChunks,
  runMapReduce,
  _mapLimited,
};
