'use strict';

/**
 * cannibalization/analyzer.js — чистое ядро сканера каннибализации
 * (SERP-overlap). Никакого I/O: на вход — снятые выдачи, на выход —
 * кластеры «под слияние», матрица общих URL и вспомогательные метрики.
 *
 * Метод (см. ТЗ / исследование вопроса):
 *   1. По каждому запросу (H1 страницы) строим множество URL из топ-N выдачи.
 *   2. Попарно считаем |A ∩ B|. Пара «конфликтна», если общих URL ≥ minCommonUrls.
 *   3. Транзитивно объединяем конфликтные пары в кластеры (union-find):
 *      если A↔B и B↔C — A,B,C в одном кластере «под слияние».
 *
 * Дополнительный сигнал — «свой домен в топе несколько раз»
 * (ownDomainDuplicates): классический признак каннибализации по одному запросу.
 *
 * buildReport(queries, opts) → {
 *   params: { minCommonUrls, topN, engine, lr, ownDomain },
 *   queries: [{ query, source_url, urlCount, ownDomainCount }],
 *   matrix:  [{ a, b, common, sharedUrls }],   // только пары с common>0
 *   clusters:[{ id, size, members:[{query,source_url}], sharedUrls, maxCommon }],
 *   ownDomainDuplicates: [{ query, source_url, urls:[...] }],
 *   summary: { totalQueries, comparedPairs, conflictPairs, clusterCount, pagesToMerge }
 * }
 *
 * queries: [{ query, source_url, urls:[normalizedUrl,...] }]
 */

/** Регистрируемый домен (eSLD) для сравнения «свой/чужой». */
function _regDomain(host) {
  if (!host) return null;
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function _hostOf(url) {
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); }
  catch (_) { return null; }
}

/** union-find */
function _makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}

function buildReport(queries, opts = {}) {
  const minCommonUrls = Math.max(1, Number(opts.minCommonUrls) || 4);
  const topN          = Math.max(1, Number(opts.topN) || 10);
  const engine        = opts.engine || 'yandex';
  const lr            = opts.lr != null ? String(opts.lr) : null;
  const ownDomain     = opts.ownDomain ? _regDomain(_hostOf(opts.ownDomain) || opts.ownDomain) : null;

  // Нормализуем вход: только валидные запросы с непустым набором URL,
  // усечёнными до topN и дедуплицированными.
  const items = [];
  for (const q of (queries || [])) {
    if (!q || !q.query) continue;
    const seen = new Set();
    const urls = [];
    for (const u of (q.urls || [])) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
      if (urls.length >= topN) break;
    }
    if (!urls.length) continue;
    items.push({
      query: q.query,
      source_url: q.source_url || null,
      urls,
      urlSet: seen,
    });
  }

  // Матрица пересечений + конфликтные пары.
  const matrix = [];
  const conflictPairs = [];
  let comparedPairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      comparedPairs++;
      const a = items[i], b = items[j];
      const shared = [];
      const smaller = a.urls.length <= b.urls.length ? a : b;
      const larger  = smaller === a ? b : a;
      for (const u of smaller.urls) if (larger.urlSet.has(u)) shared.push(u);
      if (!shared.length) continue;
      matrix.push({ a: i, b: j, common: shared.length, sharedUrls: shared });
      if (shared.length >= minCommonUrls) {
        conflictPairs.push({ i, j, shared });
      }
    }
  }

  // Транзитивные кластеры по конфликтным парам.
  const uf = _makeUF(items.length);
  for (const p of conflictPairs) uf.union(p.i, p.j);

  const groupMap = new Map();       // root → [indices]
  for (const p of conflictPairs) {
    const root = uf.find(p.i);
    if (!groupMap.has(root)) groupMap.set(root, new Set());
    groupMap.get(root).add(p.i);
    groupMap.get(root).add(p.j);
  }

  const clusters = [];
  let clusterId = 0;
  for (const [, idxSet] of groupMap) {
    const idxs = [...idxSet].sort((x, y) => x - y);
    // общие URL по всему кластеру (пересечение всех участников) и объединение
    // тех, что делят хотя бы два участника.
    const sharedCount = new Map();
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const A = items[idxs[a]], B = items[idxs[b]];
        for (const u of A.urls) if (B.urlSet.has(u)) sharedCount.set(u, (sharedCount.get(u) || 0) + 1);
      }
    }
    const sharedUrls = [...sharedCount.keys()];
    let maxCommon = 0;
    for (const p of conflictPairs) {
      if (uf.find(p.i) === uf.find(idxs[0])) maxCommon = Math.max(maxCommon, p.shared.length);
    }
    clusters.push({
      id: ++clusterId,
      size: idxs.length,
      members: idxs.map((k) => ({ query: items[k].query, source_url: items[k].source_url })),
      sharedUrls,
      maxCommon,
    });
  }
  clusters.sort((x, y) => y.maxCommon - x.maxCommon || y.size - x.size);

  // Доп. сигнал: свой домен встречается в топе одного запроса ≥ 2 раз.
  const ownDomainDuplicates = [];
  if (ownDomain) {
    for (const it of items) {
      const own = it.urls.filter((u) => _regDomain(_hostOf(u)) === ownDomain);
      if (own.length >= 2) {
        ownDomainDuplicates.push({ query: it.query, source_url: it.source_url, urls: own });
      }
    }
  }

  const pagesToMerge = clusters.reduce((n, c) => n + c.size, 0);

  return {
    params: { minCommonUrls, topN, engine, lr, ownDomain },
    queries: items.map((it) => ({
      query: it.query,
      source_url: it.source_url,
      urlCount: it.urls.length,
      ownDomainCount: ownDomain ? it.urls.filter((u) => _regDomain(_hostOf(u)) === ownDomain).length : 0,
    })),
    matrix: matrix.map((m) => ({
      a: items[m.a].query,
      b: items[m.b].query,
      a_url: items[m.a].source_url,
      b_url: items[m.b].source_url,
      common: m.common,
      sharedUrls: m.sharedUrls,
    })),
    clusters,
    ownDomainDuplicates,
    summary: {
      totalQueries: items.length,
      comparedPairs,
      conflictPairs: conflictPairs.length,
      clusterCount: clusters.length,
      pagesToMerge,
    },
  };
}

module.exports = { buildReport, _regDomain, _hostOf };
