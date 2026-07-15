'use strict';

/**
 * tzParser — детерминированная нормализация пользовательского ТЗ.
 *
 * Поддерживает несколько источников: JSON из relevance-tool, 28-польную схему
 * input_tz_parsed_json и ручной объект. Не валидирует «строго», а мягко
 * приводит известные алиасы к единому контракту Stage 2/7.
 */

const DEFAULT_TZ = Object.freeze({
  h1_required: null,
  h2_required: [],
  h2_optional: [],
  min_words: null,
  max_words: null,
  lsi_required: [],
  lsi_forbidden: [],
  commercial_blocks_required: null,
  faq_required: null,
  table_required: null,
  entity_anchors: [],
});

function _parseMaybeJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

function _isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _first(obj, aliases) {
  if (!_isPlainObject(obj)) return undefined;
  for (const key of aliases) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function _asString(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return _asString(v[0]);
  if (_isPlainObject(v)) {
    return _asString(v.value || v.text || v.title || v.name || v.h1 || v.header);
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

function _splitTextList(s) {
  return String(s || '')
    .split(/\r?\n|[;,|]/)
    .map((x) => x.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(Boolean);
}

function _asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) {
    return v
      .flatMap((item) => (_isPlainObject(item)
        ? _asArray(item.text || item.title || item.name || item.value || item.h2 || item.header || item.keyword)
        : _asArray(item)))
      .map((x) => String(x).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }
  if (_isPlainObject(v)) {
    return _asArray(v.items || v.list || v.required || v.values || v.keywords || v.headers || v.h2);
  }
  return _splitTextList(v);
}

function _asBool(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', 'да', 'нужно', 'required', 'обязательно', '1'].includes(s)) return true;
  if (['false', 'no', 'n', 'нет', 'не нужно', 'optional', '0'].includes(s)) return false;
  return null;
}

function _asNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (_isPlainObject(v)) return _asNumber(v.min || v.from || v.value || v.words || v.count);
  const m = String(v).replace(/\s+/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

function _wordBounds(raw) {
  if (raw === undefined || raw === null || raw === '') return { min: null, max: null };
  if (typeof raw === 'number') return { min: Math.round(raw), max: null };
  if (_isPlainObject(raw)) {
    return {
      min: _asNumber(raw.min || raw.from || raw.minimum || raw.min_words),
      max: _asNumber(raw.max || raw.to || raw.maximum || raw.max_words),
    };
  }
  const nums = String(raw).replace(/\s+/g, ' ').match(/\d+/g);
  if (!nums || !nums.length) return { min: null, max: null };
  const first = Number(nums[0]);
  const second = nums[1] ? Number(nums[1]) : null;
  if (/до|не\s+более|max|≤|</i.test(String(raw)) && !second) return { min: null, max: first };
  return { min: first, max: second };
}

function _uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr || []) {
    const s = String(item || '').replace(/\s+/g, ' ').trim();
    const key = s.toLowerCase();
    if (s && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function _pickNested(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const part of path.split('.')) {
      cur = _isPlainObject(cur) ? cur[part] : undefined;
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

function normalizeTz(raw) {
  const src = _parseMaybeJson(raw);
  const tz = { ...DEFAULT_TZ };
  if (!_isPlainObject(src)) return tz;

  const h1 = _first(src, ['h1_required', 'h1', 'title_h1', 'title', 'main_title', 'page_title']);
  tz.h1_required = _asString(h1);

  tz.h2_required = _uniq(_asArray(_first(src, [
    'h2_required', 'required_h2', 'required_headers', 'headers_required',
    'mandatory_h2', 'mandatory_headers', 'h2', 'headers', 'structure',
    'content_requirements',
  ])));

  tz.h2_optional = _uniq(_asArray(_first(src, [
    'h2_optional', 'optional_h2', 'optional_headers', 'recommended_h2',
    'recommended_headers', 'extra_headers',
  ])));

  const explicitMin = _first(src, ['min_words', 'word_count_min', 'words_min', 'minWordCount']);
  const explicitMax = _first(src, ['max_words', 'word_count_max', 'words_max', 'maxWordCount']);
  const volume = _first(src, ['volume', 'word_count', 'words', 'text_volume', 'content_volume', 'length']);
  const bounds = _wordBounds(volume);
  tz.min_words = _asNumber(explicitMin) ?? bounds.min;
  tz.max_words = _asNumber(explicitMax) ?? bounds.max;

  tz.lsi_required = _uniq(_asArray(_first(src, [
    'lsi_required', 'required_lsi', 'lsi', 'keywords', 'key_words',
    'terms', 'search_terms', 'mandatory_keywords',
    'known_terms',
  ])));

  tz.lsi_forbidden = _uniq(_asArray(_first(src, [
    'lsi_forbidden', 'forbidden_lsi', 'forbidden_words', 'stop_words',
    'negative_keywords', 'banned_words', 'exclude_keywords',
  ])));

  tz.commercial_blocks_required = _asBool(_first(src, [
    'commercial_blocks_required', 'commercial_blocks', 'commercial_block',
    'commerce_required', 'price_block_required',
  ]));
  tz.faq_required = _asBool(_first(src, ['faq_required', 'faq', 'questions_required', 'qa_required']));
  tz.table_required = _asBool(_first(src, ['table_required', 'table', 'comparison_table_required']));
  tz.entity_anchors = _uniq(_asArray(_first(src, [
    'entity_anchors', 'entities', 'anchors', 'entity_links', 'required_entities',
    'products_services', 'brand_usp', 'trust_assets',
  ])));

  const relevanceTool = _pickNested(src, [
    'technical_requirements',
    'tz',
    'requirements',
    'content_requirements',
    'seo_requirements',
  ]);
  if (_isPlainObject(relevanceTool)) {
    const nested = normalizeTz(relevanceTool);
    for (const key of Object.keys(tz)) {
      if (Array.isArray(tz[key])) tz[key] = _uniq([...tz[key], ...nested[key]]);
      else if (tz[key] === null || tz[key] === undefined) tz[key] = nested[key];
    }
  }

  return tz;
}

function hasTz(task) {
  if (!task || !task.tz_source) return false;
  const tz = _parseMaybeJson(task.tz_json);
  if (!_isPlainObject(tz)) return false;
  return Object.keys(tz).some((key) => {
    const v = tz[key];
    return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
  });
}

module.exports = { normalizeTz, hasTz, DEFAULT_TZ };
