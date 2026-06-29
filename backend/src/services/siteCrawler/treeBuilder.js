'use strict';

/**
 * siteCrawler/treeBuilder.js — собирает иерархическое дерево URL из
 * плоского списка страниц (задача 3, требование «отображать в виде дерева,
 * чтобы было видно, что откуда идёт»).
 *
 * buildTree(pages, origin) → { tree, byUrl }
 *   - tree: { segment:'', fullUrl:origin, children:[...] }
 *   - дети сортируются по сегменту;
 *   - промежуточные узлы, которых нет среди page-ов (например, /catalog/
 *     не загружался, но есть /catalog/x), создаются как 'virtual' (без статуса/title);
 *   - flatten(tree) выдаёт DFS-обход с полем depth — удобно для CSV-дампа дерева.
 *
 * pages: [{ url, http_status, title, h1, description }]. Все остальные
 * поля просто прокидываются в узел.
 *
 * Чистая функция, никаких I/O.
 */

function _segmentsOf(urlString, origin) {
  try {
    const u    = new URL(urlString);
    const oh   = origin ? new URL(origin).host : u.host;
    if (u.host !== oh) return null;
    const path = u.pathname || '/';
    const segs = path.split('/').filter(Boolean);
    return segs;
  } catch (_) { return null; }
}

function buildTree(pages, origin) {
  if (!origin && pages && pages.length) {
    try { const u = new URL(pages[0].url); origin = u.origin; } catch (_) { /* */ }
  }
  if (!origin) return { tree: null, byUrl: {} };

  const root = {
    segment: '',
    fullUrl: origin,
    isVirtual: true,                  // станет false, если есть сам origin как страница
    childrenMap: Object.create(null), // segment → node
  };
  const byUrl = {};

  function ensurePath(segments, fullUrl) {
    let node = root;
    let cur  = origin;
    if (segments.length === 0) return node;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      cur = cur.replace(/\/$/, '') + '/' + seg;
      let child = node.childrenMap[seg];
      if (!child) {
        child = {
          segment: seg,
          fullUrl: cur,
          isVirtual: true,
          childrenMap: Object.create(null),
        };
        node.childrenMap[seg] = child;
      }
      node = child;
    }
    return node;
  }

  for (const p of (pages || [])) {
    const segs = _segmentsOf(p.url, origin);
    if (!segs) continue;
    const node = ensurePath(segs, p.url);
    node.isVirtual   = false;
    node.fullUrl     = p.url;
    node.title       = p.title || null;
    node.h1          = p.h1 || null;
    node.description = p.description || null;
    node.status      = (p.http_status != null) ? Number(p.http_status) : null;
    node.depth       = segs.length;
    byUrl[p.url]     = node;
  }

  // childrenMap → children[] (sorted by segment)
  function finalize(node, depth) {
    const keys = Object.keys(node.childrenMap).sort();
    node.children = keys.map((k) => finalize(node.childrenMap[k], depth + 1));
    delete node.childrenMap;
    if (node.depth == null) node.depth = depth;
    return node;
  }
  finalize(root, 0);
  return { tree: root, byUrl };
}

/** DFS-обход дерева для CSV-дампа: возвращает строки {url, depth, parent_url, ...}. */
function flatten(tree) {
  const out = [];
  if (!tree) return out;
  function walk(node, parentUrl) {
    out.push({
      url:         node.fullUrl,
      depth:       node.depth,
      parent_url:  parentUrl,
      is_virtual:  !!node.isVirtual,
      title:       node.title || null,
      h1:          node.h1 || null,
      description: node.description || null,
      status:      node.status != null ? node.status : null,
    });
    for (const c of (node.children || [])) walk(c, node.fullUrl);
  }
  walk(tree, null);
  return out;
}

module.exports = { buildTree, flatten };
