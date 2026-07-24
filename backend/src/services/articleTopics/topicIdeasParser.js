'use strict';

/**
 * topicIdeasParser.js — извлечение и валидация TOPIC_IDEAS_JSON-блока
 * из markdown-ответа Gemini для режима 'topic_ideas' раздела «Темы статей».
 *
 * Формат блока (см. backend/src/prompts/articleTopics/topicIdeas.txt):
 *
 *   <!-- TOPIC_IDEAS_JSON_START -->
 *   ```json
 *   { market_overview, entities, intents, audience_profile,
 *     brand_facts, topics, coverage_map,
 *     topic_count_requested, topic_count_returned, serp_evidence_used }
 *   ```
 *   <!-- TOPIC_IDEAS_JSON_END -->
 *
 * Стиль и контракт совпадают с articleTopicsTrends.extractTrendsJsonBlock:
 *   • НЕ выбрасывает — на любую ошибку (нет блока / битый JSON / битая
 *     схема) возвращает null;
 *   • режет потенциально длинные строки до безопасных лимитов, чтобы не
 *     раздуть БД;
 *   • валидирует enum'ы и приводит неизвестные значения к null (чтобы UI
 *     мог показать их как «не указано», а не как мусорный текст);
 *   • не пытается «починить» trailing-запятые — это нарушение контракта,
 *     возвращаем null и пусть UI fallback на табличный парсер markdown.
 */

const SENTINEL_RE =
  /<!--\s*TOPIC_IDEAS_JSON_START\s*-->([\s\S]*?)<!--\s*TOPIC_IDEAS_JSON_END\s*-->/i;

// Лимиты длины строковых полей — чтобы случайно длинная цитата от модели
// не раздула JSONB-колонку в БД. Цифры подобраны под человекочитаемое
// содержание (заголовок темы, JTBD, факт), а не «сжать любой ценой».
const LIM = {
  shortStr:    240,   // title, segment.name, fact.source, intent facet
  mediumStr:   600,   // h1_variant, segment.description, pain, voc
  longStr:    1200,   // fact.fact, market_overview.fact, uniqueness_angle, why_now
  slug:        120,
  arrayCap:     30,   // максимум элементов в любом массиве (entities, topics, …)
  cellsRowCap:  20,   // макс строк в coverage_map.cells
  cellsColCap:  20,   // макс столбцов в coverage_map.cells
};

const PRIMARY_INTENT_OK = new Set([
  'informational', 'commercial', 'transactional', 'navigational',
]);
const FORMAT_OK = new Set([
  'how-to', 'listicle', 'guide', 'comparison', 'case', 'faq',
]);
const CONFIDENCE_OK = new Set(['low', 'medium', 'high']);
const GEO_POTENTIAL_OK = new Set(['low', 'medium', 'high']);
const DECISION_STAGE_OK = new Set(['TOFU', 'MOFU', 'BOFU']);
const DUPLICATE_SOURCE_OK = new Set(['exact', 'fuzzy', 'llm']);

function _str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

function _arr(v) {
  return Array.isArray(v) ? v : [];
}

function _strArr(v, maxItems, maxLen) {
  return _arr(v)
    .map((x) => _str(x, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * _strOrArr — для intent-полей, которые LLM может вернуть либо строкой,
 * либо массивом строк, либо массивом объектов с .text/.value/.label.
 * Возвращаем массив непустых строк; null если ничего полезного.
 */
function _strOrArr(v, maxItems, maxLen) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const out = v
      .map((x) => {
        if (x == null) return '';
        if (typeof x === 'string') return _str(x, maxLen);
        if (typeof x === 'object') {
          const cand = x.text || x.value || x.label || x.title || '';
          return _str(cand, maxLen);
        }
        return _str(String(x), maxLen);
      })
      .filter(Boolean)
      .slice(0, maxItems);
    return out.length ? out : null;
  }
  if (typeof v === 'string') {
    const s = _str(v, maxLen);
    return s ? [s] : null;
  }
  if (typeof v === 'object') {
    const cand = v.text || v.value || v.label || '';
    const s = _str(cand, maxLen);
    return s ? [s] : null;
  }
  return null;
}

function _intRange(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < min || r > max) return null;
  return r;
}

function _enum(v, set, lower = true) {
  const s = lower ? String(v || '').toLowerCase().trim() : String(v || '').trim();
  return set.has(s) ? s : null;
}

function _normMarketFact(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const fact = _str(o.fact, LIM.longStr);
  if (!fact) return null;
  return {
    fact,
    source:     _str(o.source, LIM.shortStr),
    confidence: _enum(o.confidence, CONFIDENCE_OK) || 'low',
  };
}

function _normEntities(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    products:        _strArr(o.products,        LIM.arrayCap, LIM.shortStr),
    companies:       _strArr(o.companies,       LIM.arrayCap, LIM.shortStr),
    technologies:    _strArr(o.technologies,    LIM.arrayCap, LIM.shortStr),
    methodologies:   _strArr(o.methodologies,   LIM.arrayCap, LIM.shortStr),
    problems:        _strArr(o.problems,        LIM.arrayCap, LIM.mediumStr),
    regulations:     _strArr(o.regulations,     LIM.arrayCap, LIM.shortStr),
  };
}

function _normIntents(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    informational: _strArr(o.informational, LIM.arrayCap, LIM.shortStr),
    commercial:    _strArr(o.commercial,    LIM.arrayCap, LIM.shortStr),
    transactional: _strArr(o.transactional, LIM.arrayCap, LIM.shortStr),
    navigational:  _strArr(o.navigational,  LIM.arrayCap, LIM.shortStr),
  };
}

function _normSegment(seg) {
  const o = seg && typeof seg === 'object' ? seg : {};
  const name = _str(o.name, LIM.shortStr);
  if (!name) return null;
  return {
    name,
    description: _str(o.description, LIM.mediumStr),
  };
}

function _normAudienceProfile(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const segments = _arr(o.segments)
    .map(_normSegment)
    .filter(Boolean)
    .slice(0, 8);
  return {
    segments,
    jtbd:               _strArr(o.jtbd,               LIM.arrayCap, LIM.mediumStr),
    pains:              _strArr(o.pains,              LIM.arrayCap, LIM.mediumStr),
    voice_of_customer:  _strArr(o.voice_of_customer,  LIM.arrayCap, LIM.mediumStr),
  };
}

function _normBrandFact(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const fact = _str(o.fact, LIM.longStr);
  if (!fact) return null;
  return {
    fact,
    confidence: _enum(o.confidence, CONFIDENCE_OK) || 'low',
  };
}

function _normDuplicateOf(o) {
  if (!o || typeof o !== 'object') return null;
  const taskId = _str(o.task_id || o.taskId, LIM.shortStr);
  const title  = _str(o.title || o.topic_title, LIM.mediumStr);
  if (!taskId && !title) return null;
  const sim = Number(o.similarity);
  return {
    task_id:       taskId || null,
    task_short_id: _str(o.task_short_id || o.taskShortId, LIM.shortStr) || null,
    title:         title || null,
    h1:            _str(o.h1 || o.topic_h1, LIM.mediumStr) || null,
    created_at:    o.created_at || o.createdAt || null,
    similarity:    Number.isFinite(sim) ? Math.max(0, Math.min(1, sim)) : null,
    source:        DUPLICATE_SOURCE_OK.has(String(o.source)) ? o.source : null,
    llm_confidence: Number.isFinite(Number(o.llm_confidence))
      ? Math.max(0, Math.min(1, Number(o.llm_confidence))) : null,
    llm_reason:    _str(o.llm_reason, LIM.mediumStr) || null,
  };
}

function _normTopic(t) {
  const o = t && typeof t === 'object' ? t : {};
  const title = _str(o.title, LIM.shortStr);
  if (!title) return null;
  return {
    title,
    h1_variant:              _str(o.h1_variant, LIM.mediumStr),
    slug_hint:               _str(o.slug_hint, LIM.slug),
    primary_intent:          _enum(o.primary_intent, PRIMARY_INTENT_OK),
    intent_facet:            _str(o.intent_facet, LIM.shortStr).toLowerCase() || null,
    target_audience_segment: _str(o.target_audience_segment, LIM.shortStr),
    expected_format:         _enum(o.expected_format, FORMAT_OK),
    pain_or_question:        _str(o.pain_or_question, LIM.mediumStr),
    key_entities:            _strArr(o.key_entities, 12, LIM.shortStr),
    lsi_seed:                _strArr(o.lsi_seed,     20, LIM.shortStr),
    commercial_potential:    _intRange(o.commercial_potential, 1, 5),
    difficulty:              _intRange(o.difficulty,           1, 5),
    uniqueness_angle:        _str(o.uniqueness_angle, LIM.longStr),
    why_now:                 _str(o.why_now,          LIM.longStr),

    // GEO 2026: потенциал попадания в AI-выдачу (Google AI Overviews /
    // Яндекс Нейро) и конкретный вопрос для прямого lead-answer в статье.
    geo_potential:           _enum(o.geo_potential, GEO_POTENTIAL_OK),
    ai_answer_trigger:       _str(o.ai_answer_trigger, LIM.longStr),

    // Расширенные intent-поля (PR-3) — модель может пропустить любое из них.
    // Все нормализуются в массив строк или null, чтобы CSV не падал.
    intent_user_questions:   _strOrArr(o.intent_user_questions, 15, LIM.mediumStr),
    intent_pains:            _strOrArr(o.intent_pains || o.pain_points, 15, LIM.mediumStr),
    intent_jobs_to_be_done:  _strOrArr(o.intent_jobs_to_be_done || o.jtbd, 12, LIM.mediumStr),
    intent_decision_stage:   _enum(o.intent_decision_stage || o.decision_stage, DECISION_STAGE_OK, false),
    intent_serp_features:    _strOrArr(o.intent_serp_features, 10, LIM.shortStr),
    expected_search_volume:  _intRange(o.expected_search_volume, 0, 100000000),
    target_audience_segment_detail: _str(o.target_audience_segment_detail, LIM.longStr),
    content_angle:           _str(o.content_angle, LIM.longStr),
    cta_suggestion:          _str(o.cta_suggestion, LIM.mediumStr),

    // Passthrough для duplicate_of (заполняется topicDuplicateDetector
    // ПОСЛЕ парсинга; здесь оставляем как опциональное поле).
    duplicate_of:            _normDuplicateOf(o.duplicate_of),
  };
}

function _normCoverageMap(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const rows    = _strArr(o.rows,    LIM.cellsRowCap, LIM.shortStr);
  const columns = _strArr(o.columns, LIM.cellsColCap, LIM.shortStr);
  const cellsRaw = _arr(o.cells).slice(0, LIM.cellsRowCap);
  const cells = cellsRaw.map((row) => {
    const r = _arr(row).slice(0, LIM.cellsColCap);
    return r.map((cell) => {
      const arr = _arr(cell)
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 999)
        .map((n) => Math.round(n));
      // Дедуп номеров тем в одной ячейке
      return Array.from(new Set(arr)).slice(0, 20);
    });
  });
  return { rows, columns, cells };
}

/**
 * Извлекает и валидирует TOPIC_IDEAS_JSON-блок из markdown-отчёта.
 * Возвращает нормализованный объект или null (на любой сбой).
 *
 * Структура возвращаемого объекта совпадает с описанием в промпте, но
 * все строки усечены до безопасных лимитов, enum'ы валидированы (неверные
 * значения становятся null), массивы capped по длине.
 */
function extractTopicIdeasJsonBlock(markdown) {
  const text = String(markdown || '');
  if (!text) return null;
  const m = SENTINEL_RE.exec(text);
  if (!m) return null;

  let raw = m[1].trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const market_overview = _arr(parsed.market_overview)
    .map(_normMarketFact)
    .filter(Boolean)
    .slice(0, 12);

  const entities         = _normEntities(parsed.entities);
  const intents          = _normIntents(parsed.intents);
  const audience_profile = _normAudienceProfile(parsed.audience_profile);
  const brand_facts      = _arr(parsed.brand_facts)
    .map(_normBrandFact)
    .filter(Boolean)
    .slice(0, 20);

  const topics = _arr(parsed.topics)
    .map(_normTopic)
    .filter(Boolean)
    .slice(0, LIM.arrayCap);

  // Если topics после нормализации пустой — это полный провал контракта,
  // возвращаем null (UI покажет fallback на сырой markdown).
  if (!topics.length) return null;

  const coverage_map = _normCoverageMap(parsed.coverage_map);

  const requested = _intRange(parsed.topic_count_requested, 1, 100);
  const returned  = _intRange(parsed.topic_count_returned,  0, 100);

  return {
    market_overview,
    entities,
    intents,
    audience_profile,
    brand_facts,
    topics,
    coverage_map,
    topic_count_requested: requested,
    topic_count_returned:  returned != null ? returned : topics.length,
    serp_evidence_used:    Boolean(parsed.serp_evidence_used),
  };
}

module.exports = {
  extractTopicIdeasJsonBlock,
  // экспортируем приватные хелперы для тестов
  _internals: {
    _normTopic,
    _normAudienceProfile,
    _normBrandFact,
    _normCoverageMap,
    PRIMARY_INTENT_OK,
    FORMAT_OK,
    CONFIDENCE_OK,
    LIM,
  },
};
