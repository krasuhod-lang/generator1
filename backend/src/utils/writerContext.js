'use strict';

/**
 * Compact planning artifacts for repeated Stage 3 writer calls.
 *
 * The full ARTICLE_KNOWLEDGE_BASE remains the authoritative context. This
 * artifact is a deterministic navigation index for STAGE1_JSON/STAGE2_JSON;
 * it is deliberately bounded so the same raw Stage 1/2 payload is not paid
 * again for every H2 block.
 */

const DEFAULT_LIMITS = Object.freeze({
  stage1Chars: 9000,
  stage2Chars: 9000,
  arrayItems: 28,
  graphNodes: 40,
  graphEdges: 60,
  taxonomyBlocks: 24,
  stringChars: 720,
});

const STAGE1_KEYS = [
  'primary_intent', 'secondary_intents', 'intents', 'subintents',
  'entities', 'lsi_clusters', 'lsi_terms', 'lsi_top', 'ngrams', 'keywords',
  'terminology_map', 'language_map', 'commercial_intents', 'buyer_journey',
  'content_formats', 'competitor_gaps', 'content_gaps',
  'white_space_opportunities', 'information_delta', 'trust_triggers',
  'user_questions', 'pain_points', 'brand_facts', 'knowledge_graph',
];

const STAGE2_KEYS = [
  'primary_intent', 'secondary_intents', 'content_format', 'recommended_format',
  'page_blueprint', 'taxonomy', 'buyer_journey', 'content_formats',
  'routing_audit', 'lsi', 'important_lsi', 'lsi_set',
];

function _string(value, maxChars) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function _primitive(value, maxChars) {
  if (typeof value === 'string') return _string(value, maxChars);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function _compact(value, options = {}, depth = 0) {
  const maxItems = options.maxItems ?? DEFAULT_LIMITS.arrayItems;
  const maxKeys = options.maxKeys ?? 32;
  const stringChars = options.stringChars ?? DEFAULT_LIMITS.stringChars;

  const primitive = _primitive(value, stringChars);
  if (primitive !== undefined) return primitive;
  if (value === undefined) return undefined;
  if (depth > 4) return _string(JSON.stringify(value), stringChars);

  if (Array.isArray(value)) {
    return value
      .slice(0, maxItems)
      .map((item) => _compact(item, options, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, maxKeys)) {
      const item = _compact(value[key], options, depth + 1);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }

  return _string(value, stringChars);
}

function _pick(source, keys, options = {}) {
  const input = source && typeof source === 'object' ? source : {};
  const out = {};
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null) {
      const value = _compact(input[key], options);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

function _compactGraph(graph, limits) {
  if (!graph || typeof graph !== 'object') return null;
  return {
    nodes: _compact(graph.nodes || [], {
      maxItems: limits.graphNodes,
      maxKeys: 12,
      stringChars: 480,
    }),
    edges: _compact(graph.edges || graph.relationships || [], {
      maxItems: limits.graphEdges,
      maxKeys: 10,
      stringChars: 360,
    }),
  };
}

function _compactTaxonomy(taxonomy, limits) {
  if (!Array.isArray(taxonomy)) return [];
  return taxonomy.slice(0, limits.taxonomyBlocks).map((block) => {
    if (!block || typeof block !== 'object') return _string(block, 360);
    const out = {};
    for (const key of [
      'h2', 'type', 'primary_intent', 'secondary_intents', 'purpose',
      'lsi_must', 'ngrams_must', 'entities', 'required_entities',
      'format', 'required_elements', 'questions', 'evidence_requirements',
      'expertise_angle', 'content_angle',
    ]) {
      if (block[key] !== undefined && block[key] !== null) {
        const value = _compact(block[key], {
          maxItems: key === 'lsi_must' || key === 'ngrams_must' ? 80 : 18,
          maxKeys: 18,
          stringChars: 520,
        });
        if (value !== undefined) out[key] = value;
      }
    }
    return out;
  });
}

function _boundedJson(value, maxChars, fallback) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return serialized;

  const reduced = _compact(value, {
    maxItems: 12,
    maxKeys: 18,
    stringChars: 320,
  });
  const reducedSerialized = JSON.stringify(reduced);
  if (reducedSerialized.length <= maxChars) return reducedSerialized;

  // Last-resort valid JSON. The authoritative AKB and CURRENT_SECTION_JSON
  // still carry the complete verified context; this index only prevents a
  // provider-level prompt overflow.
  return JSON.stringify({
    _context_compacted: true,
    _context_note: fallback,
  });
}

/**
 * Build bounded JSON strings for repeated Stage 3 writer calls.
 *
 * @param {object} stage1Result
 * @param {object} stage2Raw
 * @param {object[]} taxonomy final routed taxonomy from Stage 2.5
 * @param {object} limits optional character/item caps
 * @returns {{stage1Json:string, stage2Json:string, totalChars:number}}
 */
function buildWriterContext(stage1Result, stage2Raw, taxonomy = [], limits = {}) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const s1 = _pick(stage1Result, STAGE1_KEYS, {
    maxItems: cfg.arrayItems,
    maxKeys: 24,
    stringChars: cfg.stringChars,
  });
  if (stage1Result?.knowledge_graph) {
    s1.knowledge_graph = _compactGraph(stage1Result.knowledge_graph, cfg);
  }

  const raw2 = stage2Raw && typeof stage2Raw === 'object' ? stage2Raw : {};
  const blueprint = raw2.page_blueprint && typeof raw2.page_blueprint === 'object'
    ? raw2.page_blueprint
    : null;
  const s2 = _pick(raw2, STAGE2_KEYS, {
    maxItems: cfg.arrayItems,
    maxKeys: 24,
    stringChars: cfg.stringChars,
  });
  if (blueprint) s2.page_blueprint = _pick(blueprint, [
    'h1', 'title', 'primary_intent', 'secondary_intents', 'content_format',
    'taxonomy', 'section_order', 'faq_bank', 'required_sections',
    'buyer_journey', 'content_formats',
  ], {
    maxItems: cfg.arrayItems,
    maxKeys: 24,
    stringChars: cfg.stringChars,
  });
  s2.taxonomy = _compactTaxonomy(
    Array.isArray(taxonomy) && taxonomy.length
      ? taxonomy
      : (raw2.taxonomy || blueprint?.taxonomy || []),
    cfg,
  );

  const stage1Json = _boundedJson(
    s1,
    cfg.stage1Chars,
    'Stage 1 index is available in ARTICLE_KNOWLEDGE_BASE; use it as source of truth.',
  );
  const stage2Json = _boundedJson(
    s2,
    cfg.stage2Chars,
    'Stage 2 index and final routed taxonomy are available in ARTICLE_KNOWLEDGE_BASE/CURRENT_SECTION_JSON.',
  );

  return {
    stage1Json,
    stage2Json,
    totalChars: stage1Json.length + stage2Json.length,
  };
}

module.exports = {
  buildWriterContext,
  DEFAULT_LIMITS,
};
