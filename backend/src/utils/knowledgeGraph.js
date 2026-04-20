'use strict';

/**
 * knowledgeGraph.js — утилиты для работы с Knowledge Graph (графом знаний).
 *
 * Knowledge Graph строится на Stage 1 (Entity Landscape) и используется
 * в Stage 2 (Taxonomy) и Stage 3 (Content Generation) для семантического
 * обогащения контента связанными сущностями.
 *
 * Формат графа:
 *   nodes: [{ id, label, type, salience, properties }]
 *   edges: [{ source, target, relation, weight }]
 */

/**
 * buildKnowledgeGraph — создаёт Knowledge Graph из entity_graph Stage 1A
 * и дополнительных данных из Stage 1B/1C.
 *
 * @param {object} entityResult    — результат Entity Landscape (1A)
 * @param {object} intentResult    — результат Commercial Intent (1B)
 * @param {object} communityResult — результат Community Voice (1C)
 * @returns {{ nodes: Array, edges: Array }}
 */
function buildKnowledgeGraph(entityResult, intentResult, communityResult) {
  const nodesMap = new Map(); // id → node
  const edges    = [];

  // ── 1. Извлекаем узлы из entity_graph (Stage 1A) ─────────────────
  const rawGraph = entityResult?.entity_graph || entityResult?.knowledge_graph?.nodes || [];
  for (const item of safeArray(rawGraph)) {
    const id = normalizeId(item.entity || item.label || item.id);
    if (!id) continue;

    nodesMap.set(id, {
      id,
      label:     item.entity || item.label || id,
      type:      item.type || 'generic',
      salience:  parseFloat(item.weight || item.salience) || 0.5,
      properties: item.properties || {},
    });

    // Связи из relations массива
    for (const rel of safeArray(item.relations)) {
      const targetId = normalizeId(typeof rel === 'string' ? rel : (rel.target || rel.entity));
      if (targetId && targetId !== id) {
        edges.push({
          source:   id,
          target:   targetId,
          relation: (typeof rel === 'object' ? rel.relation : 'related_to') || 'related_to',
          weight:   parseFloat(typeof rel === 'object' ? rel.weight : 0.5) || 0.5,
        });
      }
    }
  }

  // ── 1b. Если Stage 1A вернул knowledge_graph.edges — добавляем ───
  const rawEdges = entityResult?.knowledge_graph?.edges || [];
  for (const e of safeArray(rawEdges)) {
    const src = normalizeId(e.source);
    const tgt = normalizeId(e.target);
    if (src && tgt) {
      edges.push({
        source:   src,
        target:   tgt,
        relation: e.relation || 'related_to',
        weight:   parseFloat(e.weight) || 0.5,
      });
    }
  }

  // ── 2. Обогащаем из commercial_intents (Stage 1B) ────────────────
  for (const intent of safeArray(intentResult?.commercial_intents)) {
    const id = normalizeId(intent.intent || intent.query_example);
    if (!id) continue;
    if (!nodesMap.has(id)) {
      nodesMap.set(id, {
        id,
        label:     intent.intent || id,
        type:      'commercial_intent',
        salience:  intent.conversion_potential === 'high' ? 0.9 : 0.6,
        properties: { stage: intent.stage, query: intent.query_example },
      });
    }
  }

  // ── 3. Обогащаем из pain_points (Stage 1C) ───────────────────────
  for (const pain of safeArray(communityResult?.pain_points)) {
    const id = normalizeId(pain.pain || pain.trigger_phrase);
    if (!id) continue;
    if (!nodesMap.has(id)) {
      nodesMap.set(id, {
        id,
        label:     pain.pain || id,
        type:      'pain_point',
        salience:  0.7,
        properties: { trigger: pain.trigger_phrase, solution: pain.solution_angle },
      });
    }
  }

  // ── 4. Обогащаем из user_questions (Stage 1C) ────────────────────
  for (const q of safeArray(communityResult?.user_questions)) {
    const id = normalizeId(q.question);
    if (!id) continue;
    if (!nodesMap.has(id)) {
      nodesMap.set(id, {
        id,
        label:     q.question || id,
        type:      'user_question',
        salience:  q.priority === 'high' ? 0.8 : 0.5,
        properties: { answer_hint: q.answer_hint },
      });
    }
  }

  // Добавляем недостающие узлы из edges (target-ы без узлов)
  for (const edge of edges) {
    if (!nodesMap.has(edge.target)) {
      nodesMap.set(edge.target, {
        id:         edge.target,
        label:      edge.target,
        type:       'inferred',
        salience:   0.3,
        properties: {},
      });
    }
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges: deduplicateEdges(edges),
  };
}

/**
 * getRelatedEntities — возвращает сущности, связанные с данным H2-блоком.
 * Ищет по совпадению label/type с H2 заголовком и LSI-ключами блока.
 *
 * @param {{ nodes: Array, edges: Array }} kg — Knowledge Graph
 * @param {string}   h2       — заголовок блока
 * @param {string[]} lsiMust  — LSI ключи блока
 * @param {number}   maxCount — максимум возвращаемых сущностей
 * @returns {Array} — отсортированные по релевантности сущности
 */
function getRelatedEntities(kg, h2, lsiMust = [], maxCount = 10) {
  if (!kg || !kg.nodes?.length) return [];

  const h2Lower    = (h2 || '').toLowerCase();
  const lsiLower   = (lsiMust || []).map(w => w.toLowerCase());
  const searchText = h2Lower + ' ' + lsiLower.join(' ');

  // Ранжируем каждый узел по релевантности к блоку
  const scored = kg.nodes.map(node => {
    let score = 0;
    const labelLower = (node.label || '').toLowerCase();

    // Точное совпадение label в H2
    if (h2Lower.includes(labelLower)) score += 3;
    // Label содержится в LSI
    if (lsiLower.some(l => l.includes(labelLower) || labelLower.includes(l))) score += 2;
    // Частичное совпадение (слова из label в searchText)
    const words = labelLower.split(/\s+/).filter(w => w.length > 3);
    for (const w of words) {
      if (searchText.includes(w)) score += 0.5;
    }
    // Бонус за salience
    score += node.salience * 0.5;

    // Бонус за связи с другими высокорелевантными узлами
    const connectedEdges = (kg.edges || []).filter(
      e => e.source === node.id || e.target === node.id
    );
    score += Math.min(connectedEdges.length * 0.1, 0.5);

    return { ...node, _relevanceScore: score };
  });

  return scored
    .filter(n => n._relevanceScore > 0)
    .sort((a, b) => b._relevanceScore - a._relevanceScore)
    .slice(0, maxCount);
}

/**
 * getEntityClusters — группирует сущности в кластеры по связям.
 * Используется для Stage 2 (Taxonomy Builder) — помогает группировать
 * блоки по семантическим кластерам.
 *
 * @param {{ nodes: Array, edges: Array }} kg
 * @returns {Array<{ centroid: string, members: string[] }>}
 */
function getEntityClusters(kg) {
  if (!kg || !kg.nodes?.length) return [];

  // Простой алгоритм: connected components через BFS
  const adjacency = new Map();
  for (const node of kg.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of (kg.edges || [])) {
    if (adjacency.has(edge.source)) adjacency.get(edge.source).push(edge.target);
    if (adjacency.has(edge.target)) adjacency.get(edge.target).push(edge.source);
  }

  const visited = new Set();
  const clusters = [];

  for (const node of kg.nodes) {
    if (visited.has(node.id)) continue;

    const component = [];
    const queue = [node.id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of (adjacency.get(current) || [])) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    if (component.length > 0) {
      // Centroid = узел с наибольшим salience
      const centroid = component
        .map(id => kg.nodes.find(n => n.id === id))
        .filter(Boolean)
        .sort((a, b) => (b.salience || 0) - (a.salience || 0))[0];

      clusters.push({
        centroid: centroid?.label || component[0],
        members:  component,
      });
    }
  }

  return clusters.sort((a, b) => b.members.length - a.members.length);
}

/**
 * serializeForPrompt — сериализует Knowledge Graph для вставки в LLM промпт.
 * Компактный формат, экономящий токены.
 *
 * @param {{ nodes: Array, edges: Array }} kg
 * @param {number} maxChars — максимальная длина строки
 * @returns {string}
 */
function serializeForPrompt(kg, maxChars = 3000) {
  if (!kg || !kg.nodes?.length) return 'Нет данных';

  const topNodes = kg.nodes
    .sort((a, b) => (b.salience || 0) - (a.salience || 0))
    .slice(0, 30);

  const lines = topNodes.map(n =>
    `• ${n.label} [${n.type}] salience=${n.salience}`
  );

  const topEdges = (kg.edges || [])
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 20);

  if (topEdges.length) {
    lines.push('Relations:');
    for (const e of topEdges) {
      lines.push(`  ${e.source} —[${e.relation}]→ ${e.target}`);
    }
  }

  const result = lines.join('\n');
  return result.substring(0, maxChars);
}

// ── Вспомогательные функции ──────────────────────────────────────────

function normalizeId(str) {
  if (!str) return '';
  return str.toString().toLowerCase().trim().replace(/\s+/g, '_').substring(0, 80);
}

function safeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') {
    const firstArr = Object.values(val).find(v => Array.isArray(v));
    return firstArr || [];
  }
  return [];
}

function deduplicateEdges(edges) {
  const seen = new Set();
  return edges.filter(e => {
    const key = `${e.source}|${e.target}|${e.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  buildKnowledgeGraph,
  getRelatedEntities,
  getEntityClusters,
  serializeForPrompt,
};
