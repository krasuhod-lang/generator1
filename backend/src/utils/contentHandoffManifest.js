/**
 * Content Handoff Manifest
 *
 * A deterministic, bounded contract between the analytical stages and the
 * writer/auditors. It deliberately does not call an LLM. Its purpose is to
 * preserve provenance and make loss of requirements observable instead of
 * silently falling back to empty strings or incompatible field names.
 */

const MAX_FACTS = 40;
const MAX_CLAIMS = 30;
const MAX_ENTITIES = 60;
const MAX_INTENTS = 24;
const MAX_LSI = 120;
const MAX_NGRAMS = 80;
const MAX_BLOCKS = 24;
const MAX_TEXT = 800;
const { normalizeWritingProfile } = require('./writingProfile');

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const nested = Object.values(value).find((item) => Array.isArray(item));
    return nested || [];
  }
  return [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function compact(value, max = MAX_TEXT) {
  const valueText = text(value);
  return valueText.length > max ? `${valueText.slice(0, max - 1)}…` : valueText;
}

function normalizeKey(value) {
  return text(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values, max) {
  const result = [];
  const seen = new Set();
  const queue = Array.isArray(values) ? values.slice() : [values];
  while (queue.length && result.length < max) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (value && typeof value === 'object') {
      const nested = [
        value.keyword,
        value.term,
        value.phrase,
        value.label,
        value.name,
        ...(Array.isArray(value.keywords) ? value.keywords : []),
        ...(Array.isArray(value.terms) ? value.terms : []),
        ...(Array.isArray(value.lsi) ? value.lsi : []),
        ...(Array.isArray(value.ngrams) ? value.ngrams : []),
      ].filter(Boolean);
      queue.push(...nested);
      continue;
    }
    const normalized = text(value);
    const key = normalizeKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(compact(normalized));
  }
  return result;
}

function uniqueRecords(records, keyFn, max) {
  const result = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const key = normalizeKey(keyFn(record));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(record);
    if (result.length >= max) break;
  }
  return result;
}

function normalizeEvidence(items, source, max) {
  const records = [];
  for (const item of asArray(items)) {
    if (typeof item === 'string') {
      const value = compact(item);
      if (value) records.push({ text: value, source, evidence_type: 'statement' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const value = compact(
      item.fact || item.claim || item.value || item.text || item.quote
      || item.evidence || item.trend || item.change || item.title || item.question,
    );
    if (!value) continue;
    records.push({
      text: value,
      source: compact(item.source || item.url || item.source_url || item.source_page || source, 240),
      evidence_type: compact(item.evidence_type || item.type || 'statement', 80),
      date: compact(item.date || item.published_at || '', 80) || null,
      confidence: item.confidence ?? item.reliability ?? null,
    });
  }
  return uniqueRecords(records, (item) => `${item.text}|${item.source}`, max);
}

function normalizeEntities(stage0Result, stage1Result, relevanceReport) {
  const raw = [];
  raw.push(...asArray(stage0Result?.core_entities));
  raw.push(...asArray(stage1Result?.entities));
  raw.push(...asArray(stage1Result?.entity_graph));
  raw.push(...asArray(stage1Result?.knowledge_graph?.nodes));
  raw.push(...asArray(relevanceReport?.entity_coverage?.mandatory_entities));
  raw.push(...asArray(relevanceReport?.mandatory_entities));

  const normalized = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = compact(item, 180);
      if (label) normalized.push({ label, type: 'entity', salience: null, source: 'analysis' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const label = compact(item.label || item.entity || item.name || item.title, 180);
    if (!label) continue;
    normalized.push({
      label,
      type: compact(item.type || item.entity_type || 'entity', 80),
      salience: Number.isFinite(Number(item.salience)) ? Number(item.salience) : null,
      source: compact(item.source || item.origin || 'analysis', 120),
    });
  }
  return uniqueRecords(normalized, (item) => item.label, MAX_ENTITIES);
}

function normalizeIntents(stage1Result, stage2Result, stage0Result) {
  const raw = [
    ...asArray(stage1Result?.commercial_intents),
    ...asArray(stage1Result?.intents),
    ...asArray(stage1Result?.search_intents),
    ...asArray(stage2Result?.buyer_journey?.buyer_journey_stages),
    ...asArray(stage2Result?.stage2Raw?.buyer_journey?.buyer_journey_stages),
    ...asArray(stage2Result?.stage2Raw?.buyer_journey?.stages),
    ...asArray(stage2Result?.stage2Raw?.search_intents),
    ...asArray(stage2Result?.stage2Raw?.intents),
    ...asArray(stage0Result?.search_intents),
  ];
  const normalized = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const value = compact(item, 220);
      if (value) normalized.push({ intent: value, stage: null, query_example: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const value = compact(item.intent || item.stage || item.name || item.query || item.pattern, 220);
    if (!value) continue;
    normalized.push({
      intent: value,
      stage: compact(item.stage || item.journey_stage || '', 80) || null,
      query_example: compact(item.query_example || item.query || item.example, 220) || null,
    });
  }
  return uniqueRecords(normalized, (item) => `${item.intent}|${item.stage || ''}`, MAX_INTENTS);
}

function extractTaxonomy(stage2Result) {
  const raw = stage2Result?.taxonomy
    || stage2Result?.stage2Raw?.taxonomy
    || stage2Result?.stage2Raw?.page_blueprint?.taxonomy
    || [];
  return Array.isArray(raw) ? raw : [];
}

function normalizeBlocks(taxonomy) {
  return taxonomy.slice(0, MAX_BLOCKS).map((block, index) => ({
    index,
    h2: compact(block?.h2 || `Раздел ${index + 1}`, 240),
    type: compact(block?.type || 'generic', 60),
    primary_intent: compact(block?.primary_intent || block?.intent || '', 160) || null,
    lsi_must: uniqueStrings([block?.lsi_must || block?.lsi || []], 40),
    ngrams_must: uniqueStrings([block?.ngrams_must || block?.ngrams || []], 30),
    entities: uniqueStrings([block?.entities || block?.required_entities || []], 20),
    evidence_requirements: uniqueStrings([block?.evidence_requirements || []], 12),
  }));
}

function getWritingProfile(task) {
  return normalizeWritingProfile(task?.writing_profile_json || task?.writing_profile, {
    genre: task?.input_genre || task?.content_genre || task?.genre || task?.writing_genre,
    tone: task?.input_tone || task?.tone || task?.tone_of_voice || task?.content_tone,
    complexity: task?.input_complexity || task?.complexity || task?.reading_level,
    professional_level: task?.input_professional_level || task?.professional_level || task?.expertise_level,
    business_type: task?.input_business_type,
    site_type: task?.input_site_type,
    language: task?.input_language || 'ru',
    audience: task?.input_target_audience,
    voice_notes: task?.__contentVoiceText,
  });
}

function getFreshnessPolicy(task, region) {
  const profile = normalizeWritingProfile(task?.writing_profile_json || task?.writing_profile, {
    language: task?.input_language || 'ru',
    business_type: task?.input_business_type,
    site_type: task?.input_site_type,
    audience: task?.input_target_audience,
  });
  const haystack = [
    task?.input_project_limits,
    task?.input_niche_features,
    task?.input_business_goal,
    task?.input_target_service,
    task?.freshness_requirement,
    task?.current_law_required,
    task?.regulatory_context,
    profile.genre,
    profile.voice_notes,
  ].filter(Boolean).join(' ');
  const required = profile.freshness_required
    || profile.current_law_required
    || task?.freshness_required === true
    || task?.current_law_required === true
    || /(актуальн|текущ|сегодня|на\s+дату|нововвед|изменени[ея].{0,24}(закон|правил|тариф|норм)|законодатель|регулятор)/i.test(haystack);
  return {
    required,
    as_of: required ? new Date().toISOString().slice(0, 10) : null,
    jurisdiction: compact(task?.legal_jurisdiction || region || 'Россия', 120) || 'Россия',
    source_date_required: required,
    rule: required
      ? 'Для актуальных правовых/регуляторных/коммерческих утверждений использовать только датированные подтверждённые источники; при отсутствии свежего источника утверждение исключить или отправить на human review.'
      : 'Актуальность не заявлена во входном ТЗ; не добавлять текущие даты, законы, тарифы или нововведения без источника.',
  };
}

function getTzRequirements(task) {
  let tz = task?.tz_json;
  if (typeof tz === 'string') {
    try { tz = JSON.parse(tz); } catch (_) { tz = null; }
  }
  if (!tz || typeof tz !== 'object') return {
    h1: null, h2: [], lsi: [], forbidden: [], min_words: null, max_words: null,
  };
  return {
    h1: compact(tz.h1_required || tz.h1 || '', 240) || null,
    h2: uniqueStrings([tz.h2_required || tz.h2 || []], 30),
    lsi: uniqueStrings([tz.lsi_required || []], MAX_LSI),
    forbidden: uniqueStrings([tz.lsi_forbidden || tz.forbidden_terms || []], 80),
    min_words: Number.isFinite(Number(tz.min_words)) ? Number(tz.min_words) : null,
    max_words: Number.isFinite(Number(tz.max_words)) ? Number(tz.max_words) : null,
  };
}

function buildContentHandoffManifest({
  task = {},
  stage0Result = null,
  stage1Result = null,
  stage2Result = null,
  relevanceReport = null,
  targetPageAnalysis = null,
  strategyContext = null,
} = {}) {
  const tz = getTzRequirements(task);
  const region = compact(task.input_region, 120) || 'Россия';
  const writingProfile = getWritingProfile(task);
  const freshness = getFreshnessPolicy(task, region);
  const facts = [
    ...normalizeEvidence(stage0Result?.realtime_facts, 'stage0.realtime_facts', MAX_FACTS),
    ...normalizeEvidence(stage0Result?.research_evidence, 'stage0.research_evidence', MAX_FACTS),
    ...normalizeEvidence(stage0Result?.expert_quotes, 'stage0.expert_quotes', MAX_FACTS),
    ...normalizeEvidence(stage0Result?.latest_trends, 'stage0.latest_trends', MAX_FACTS),
    ...normalizeEvidence(stage0Result?.legal_updates, 'stage0.legal_updates', MAX_FACTS),
    ...normalizeEvidence(stage0Result?.competitor_facts, 'stage0.competitor_facts', MAX_FACTS),
    ...normalizeEvidence(targetPageAnalysis?.facts, 'target_page', MAX_FACTS),
  ];
  const claims = [
    ...normalizeEvidence(stage0Result?.claims, 'stage0.claims', MAX_CLAIMS),
    ...normalizeEvidence(stage0Result?.claims_to_prove, 'stage0.claims_to_prove', MAX_CLAIMS),
    ...normalizeEvidence(stage0Result?.information_delta, 'stage0.information_delta', MAX_CLAIMS),
    ...normalizeEvidence(stage0Result?.gist_top10_claims, 'stage0.gist_top10_claims', MAX_CLAIMS),
    ...normalizeEvidence(relevanceReport?.claims, 'relevance.claims', MAX_CLAIMS),
  ];

  const entities = normalizeEntities(stage0Result, stage1Result, relevanceReport);
  const intents = normalizeIntents(stage1Result, stage2Result, stage0Result);
  const taxonomy = extractTaxonomy(stage2Result);
  const blocks = normalizeBlocks(taxonomy);
  const lsi = uniqueStrings([
    task.input_raw_lsi ? String(task.input_raw_lsi).split(/[,\n;]/) : [],
    tz.lsi,
    ...asArray(stage1Result?.lsi_terms),
    ...asArray(stage1Result?.lsi_top),
    ...asArray(stage1Result?.lsi_clusters).flatMap((item) => item?.keywords || item?.terms || []),
    ...asArray(stage2Result?.stage2Raw?.lsi),
    ...asArray(stage2Result?.stage2Raw?.lsi?.important),
    ...asArray(stage2Result?.stage2Raw?.important_lsi),
    ...asArray(stage2Result?.stage2Raw?.lsi_set),
    ...blocks.flatMap((block) => block.lsi_must),
  ], MAX_LSI);
  const ngrams = uniqueStrings([
    task.input_ngrams ? String(task.input_ngrams).split(/[,\n;]/) : [],
    ...asArray(stage1Result?.ngrams),
    ...asArray(stage2Result?.stage2Raw?.ngrams),
    ...asArray(stage2Result?.stage2Raw?.n_grams),
    ...blocks.flatMap((block) => block.ngrams_must),
  ], MAX_NGRAMS);
  const sources = normalizeEvidence(stage0Result?.research_sources, 'stage0.research_sources', MAX_FACTS);

  const warnings = [];
  if (!facts.length) warnings.push('no_verified_facts');
  if (!entities.length) warnings.push('no_entities');
  if (!intents.length) warnings.push('no_intents');
  if (!lsi.length) warnings.push('no_lsi');
  if (!blocks.length) warnings.push('no_taxonomy');
  if (relevanceReport && !relevanceReport.entity_coverage && !relevanceReport.mandatory_entities) {
    warnings.push('relevance_report_without_entity_coverage');
  }

  const manifest = {
    schema_version: 'content-handoff-v1',
    generated_at: new Date().toISOString(),
    source_contract: {
      task_id: text(task.id) || null,
      target_service: compact(task.input_target_service, 240) || null,
      region,
      source_relevance_report_id: text(task.source_relevance_report_id) || null,
      strategy_available: !!strategyContext,
      target_page_available: !!targetPageAnalysis,
    },
    requirements: {
      h1: tz.h1,
      required_h2: tz.h2,
      forbidden_terms: tz.forbidden,
      min_words: tz.min_words,
      max_words: tz.max_words,
      writing_profile: writingProfile,
      freshness,
    },
    facts,
    claims_to_prove: claims,
    sources,
    entities,
    intents,
    semantic: { lsi_required: lsi, ngrams_required: ngrams },
    blocks,
    validation: {
      status: warnings.length ? 'partial' : 'ready',
      warnings,
      counts: {
        facts: facts.length,
        claims: claims.length,
        entities: entities.length,
        intents: intents.length,
        lsi: lsi.length,
        ngrams: ngrams.length,
        blocks: blocks.length,
      },
    },
  };

  manifest.prompt_json = JSON.stringify({
    schema_version: manifest.schema_version,
    requirements: manifest.requirements,
    facts: manifest.facts.slice(0, 18),
    claims_to_prove: manifest.claims_to_prove.slice(0, 12),
    sources: manifest.sources.slice(0, 20),
    entities: manifest.entities.slice(0, 30),
    intents: manifest.intents.slice(0, 12),
    semantic: {
      lsi_required: manifest.semantic.lsi_required.slice(0, 80),
      ngrams_required: manifest.semantic.ngrams_required.slice(0, 50),
    },
    writing_profile: manifest.requirements.writing_profile,
    freshness: manifest.requirements.freshness,
    blocks: manifest.blocks,
    validation: manifest.validation,
  });

  return manifest;
}

function buildBlockHandoffPrompt(manifest, block) {
  if (!manifest || typeof manifest !== 'object') return '';
  const blockIndex = Number(block?.index);
  const selected = Number.isFinite(blockIndex)
    ? manifest.blocks?.find((item) => item.index === blockIndex)
    : null;
  const payload = {
    schema_version: manifest.schema_version,
    rule: 'Use only verified facts below. If a fact is absent, omit the claim or mark the limitation; never invent it.',
    block: selected || {
      h2: compact(block?.h2 || '', 240),
      type: compact(block?.type || 'generic', 60),
      lsi_must: uniqueStrings([block?.lsi_must || []], 40),
      ngrams_must: uniqueStrings([block?.ngrams_must || []], 30),
    },
    facts: manifest.facts.slice(0, 18),
    claims_to_prove: manifest.claims_to_prove.slice(0, 12),
    sources: manifest.sources.slice(0, 20),
    entities: manifest.entities.slice(0, 30),
    intents: manifest.intents.slice(0, 12),
    global_semantic: {
      lsi_required: manifest.semantic.lsi_required.slice(0, 80),
      ngrams_required: manifest.semantic.ngrams_required.slice(0, 50),
    },
    requirements: manifest.requirements,
    writing_profile: manifest.requirements.writing_profile,
    freshness: manifest.requirements.freshness,
  };
  return `\n\nCONTENT HANDOFF MANIFEST (verified, block-scoped):\n${JSON.stringify(payload)}\nDo not introduce a numeric, legal, medical, commercial, product or competitor claim unless it is supported by FACTS/CLAIMS above or by the supplied project context. Preserve the supplied genre, tone and audience. For freshness-sensitive topics, use only dated verified sources; otherwise omit the current-law/current-date claim or mark it for human review. Preserve intent and use routed terms naturally; never force repetitions.`;
}

function renderManifestMarkdown(manifest, maxChars = 12000) {
  if (!manifest) return '';
  const lines = [
    `Schema: ${manifest.schema_version}`,
    `Status: ${manifest.validation.status}; warnings: ${manifest.validation.warnings.join(', ') || 'none'}`,
    `Coverage: facts=${manifest.validation.counts.facts}, claims=${manifest.validation.counts.claims}, entities=${manifest.validation.counts.entities}, intents=${manifest.validation.counts.intents}, LSI=${manifest.validation.counts.lsi}, ngrams=${manifest.validation.counts.ngrams}, blocks=${manifest.validation.counts.blocks}`,
    `Требования ТЗ: H1=${manifest.requirements.h1 || 'нет'}; H2=${manifest.requirements.required_h2.join(' | ') || 'нет'}; forbidden=${manifest.requirements.forbidden_terms.join(', ') || 'нет'}`,
    `Профиль текста: жанр=${manifest.requirements.writing_profile.genre || 'не задан'}; тон=${manifest.requirements.writing_profile.tone || 'не задан'}; язык=${manifest.requirements.writing_profile.language}; аудитория=${manifest.requirements.writing_profile.audience || 'не задан'}`,
    `Актуальность: required=${manifest.requirements.freshness.required}; as_of=${manifest.requirements.freshness.as_of || 'не требуется'}; jurisdiction=${manifest.requirements.freshness.jurisdiction}`,
    `LSI: ${manifest.semantic.lsi_required.join(', ') || 'нет'}`,
    `N-граммы: ${manifest.semantic.ngrams_required.join(', ') || 'нет'}`,
    'Проверенные факты:',
    ...manifest.facts.slice(0, 18).map((item) => `- ${item.text} [${item.source}]`),
    'Claims to prove:',
    ...manifest.claims_to_prove.slice(0, 12).map((item) => `- ${item.text} [${item.source}]`),
    'Sources:',
    ...manifest.sources.slice(0, 20).map((item) => `- ${item.text} [${item.source}]`),
    'Entities:',
    ...manifest.entities.slice(0, 30).map((item) => `- ${item.label} [${item.type}]`),
    'Intent map:',
    ...manifest.intents.slice(0, 12).map((item) => `- ${item.intent}${item.stage ? ` (${item.stage})` : ''}`),
    'Block map:',
    ...manifest.blocks.map((block) => `- #${block.index} ${block.h2} [${block.type}] | LSI: ${block.lsi_must.join(', ') || 'нет'} | ngrams: ${block.ngrams_must.join(', ') || 'нет'}`),
  ];
  const markdown = lines.join('\n');
  return markdown.length <= maxChars ? markdown : `${markdown.slice(0, maxChars - 32)}\n[… manifest compacted …]`;
}

module.exports = {
  buildContentHandoffManifest,
  buildBlockHandoffPrompt,
  renderManifestMarkdown,
  uniqueStrings,
};
