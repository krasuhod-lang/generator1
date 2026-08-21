'use strict';

/**
 * Shared evidence-first E-E-A-T contract for seo, link and info branches.
 *
 * This module intentionally does not call an LLM. It compiles already available
 * task/research/semantic artifacts into a stable writer contract and validates
 * the rendered HTML with deterministic checks. DSPy can optimize the prompt
 * suffix around this contract, but it cannot override evidence or blockers.
 */

const CONTRACT_VERSION = 'eeat12.v1';
const TARGET_DEFAULT = 7.5;
const MAX_EVIDENCE = 24;
const MAX_ENTITIES = 36;
const MAX_LSI = 60;
const MAX_OBLIGATIONS = 24;

const BRANCH_DEFAULTS = Object.freeze({
  seo: Object.freeze({
    label: 'SEO-текст',
    pageType: 'service',
    requireTable: true,
    requireComparison: false,
    requireFaq: true,
    requireExperienceSignal: false,
    requireReviewer: false,
    requireSources: false,
  }),
  link: Object.freeze({
    label: 'ссылочная статья',
    pageType: 'editorial',
    requireTable: true,
    requireComparison: true,
    requireFaq: true,
    requireExperienceSignal: true,
    requireReviewer: false,
    requireSources: true,
  }),
  info: Object.freeze({
    label: 'статья для блога',
    pageType: 'informational',
    requireTable: true,
    requireComparison: true,
    requireFaq: true,
    requireExperienceSignal: true,
    requireReviewer: false,
    requireSources: true,
  }),
});

const METRICS = Object.freeze([
  'experience',
  'expertise',
  'author_transparency',
  'reviewer_validation',
  'factual_accuracy',
  'source_transparency',
  'entity_completeness',
  'information_gain',
  'specificity_actionability',
  'trustworthiness',
  'intent_fit',
  'freshness_editorial_ux',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniq(values, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const item = clean(value, 240);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeBranch(branch) {
  const value = clean(branch, 30).toLowerCase();
  if (value === 'link_article' || value === 'link') return 'link';
  if (value === 'info_article' || value === 'blog' || value === 'info') return 'info';
  return 'seo';
}

function normalizeRisk(task = {}, moduleContext = {}, governanceReport = {}) {
  const raw = [
    moduleContext.trust_level,
    moduleContext.trust_complexity,
    task.input_niche_features,
    task.input_business_type,
    governanceReport.risk_level,
  ].map((value) => clean(value)).join(' ').toLowerCase();
  if (/ymyl|медицин|здоров|финанс|кредит|страх|юрид|право|лекар|инвест|налог|регулятор/.test(raw)) return 'ymyl';
  if (/high|высок|regulated|sensitive|риск/.test(raw)) return 'high';
  if (/medium|сред|коммер|b2b/.test(raw)) return 'medium';
  return 'low';
}

function sourceOf(item) {
  const obj = asObject(item);
  return clean(obj.source_url || obj.source || obj.url || obj.href || obj.citation || '', 360);
}

function textOf(item) {
  if (typeof item === 'string') return clean(item, 420);
  const obj = asObject(item);
  return clean(obj.fact || obj.claim || obj.text || obj.quote || obj.value || obj.title || obj.name || '', 420);
}

function evidenceStatus(item, fallback = 'unknown') {
  const obj = asObject(item);
  if (obj.status && /confirmed|verified|primary|brand/i.test(String(obj.status))) return 'confirmed';
  if (sourceOf(item)) return 'source_backed';
  return fallback;
}

function normalizeEvidence(items, type, sourceType = 'research', fallbackStatus = 'unknown') {
  return asArray(items).map((item, index) => {
    const text = textOf(item);
    if (!text) return null;
    const source = sourceOf(item);
    const obj = asObject(item);
    return {
      evidence_id: `ev-${type}-${index + 1}`,
      text,
      evidence_type: type,
      source: source || null,
      source_type: clean(obj.source_type || sourceType, 40),
      status: evidenceStatus(item, fallbackStatus),
      confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : null,
      date: clean(obj.date || obj.published_at || obj.updated_at || '', 40) || null,
      allowed_formulation: clean(obj.allowed_formulation || text, 360),
      forbidden_formulation: clean(obj.forbidden_formulation || '', 240) || null,
    };
  }).filter(Boolean);
}

function collectEvidence({ task = {}, targetPageAnalysis, stage0Result, stage1Result, realtimeResearch, governanceReport, relevanceContext }) {
  const facts = [];
  const push = (items, type, sourceType, fallbackStatus) => facts.push(...normalizeEvidence(items, type, sourceType, fallbackStatus));

  const brandFacts = clean(task.input_brand_facts || targetPageAnalysis?.brand_facts || '', 2200);
  if (brandFacts) push([{ text: brandFacts, source_type: 'brand_input', status: 'confirmed' }], 'brand_fact', 'brand_input', 'confirmed');
  if (targetPageAnalysis?.service_details) push([{ text: targetPageAnalysis.service_details, source_type: 'target_page' }], 'service_detail', 'target_page', 'source_backed');
  if (targetPageAnalysis?.proof_assets) push([{ text: targetPageAnalysis.proof_assets, source_type: 'target_page' }], 'proof_asset', 'target_page', 'source_backed');

  push(realtimeResearch?.realtime_facts || realtimeResearch?.current_stats, 'research_fact', 'research', 'unknown');
  push(realtimeResearch?.expert_quotes, 'expert_quote', 'expert', 'unknown');
  push(realtimeResearch?.legal_updates || realtimeResearch?.legal_or_price_updates, 'legal_or_price', 'official', 'unknown');
  push(stage0Result?.competitor_facts, 'competitor_fact', 'serp', 'unknown');
  push(stage0Result?.source_evidence || stage0Result?.sources, 'source', 'research', 'unknown');
  push(relevanceContext?.facts || relevanceContext?.verified_claims, 'relevance_fact', 'relevance', 'unknown');
  push(governanceReport?.confirmed_facts, 'governed_fact', 'governance', 'confirmed');

  const seen = new Set();
  return facts.filter((item) => {
    const key = `${item.text.toLowerCase()}|${item.source || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EVIDENCE);
}

function entityText(item) {
  if (typeof item === 'string') return clean(item, 120);
  const obj = asObject(item);
  return clean(obj.entity || obj.label || obj.text || obj.name || obj.term || '', 120);
}

function collectEntities({ task = {}, stage1Result, moduleContext, relevanceContext, lsi }) {
  const values = [];
  const add = (items, required = false, type = 'entity') => {
    for (const item of asArray(items)) {
      const text = entityText(item);
      if (!text) continue;
      const obj = asObject(item);
      values.push({
        entity: text,
        type: clean(obj.type || obj.entity_type || type, 40),
        required: required || obj.required === true || obj.must_appear === true,
        relationship: clean(obj.relationship || obj.role || '', 120) || null,
        evidence_required: obj.evidence_required === true || obj.requires_evidence === true,
      });
    }
  };

  add(moduleContext?.mandatory_entities, true, 'mandatory_entity');
  add(relevanceContext?.mandatory_entities, true, 'serp_entity');
  add(stage1Result?.entities, false, 'topic_entity');
  add(stage1Result?.semantic_entities, false, 'semantic_entity');
  add(stage1Result?.knowledge_graph?.nodes, false, 'knowledge_graph');
  add(lsi?.entities, false, 'lsi_entity');
  add(lsi?.important_lsi, false, 'lsi_entity');
  add(lsi?.important, false, 'lsi_entity');

  const seen = new Set();
  return values.filter((item) => {
    const key = item.entity.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ENTITIES);
}

function collectLsi({ task = {}, lsi, relevanceContext, stage2Result }) {
  const terms = [];
  const weights = [];
  const addTerms = (items) => {
    for (const item of asArray(items)) {
      if (typeof item === 'string') terms.push(item);
      else {
        const obj = asObject(item);
        const term = obj.term || obj.lemma || obj.text || obj.phrase || obj.keyword;
        if (term) terms.push(term);
        if (obj.tf_idf_score != null || obj.bm25_score != null) {
          weights.push({ term: clean(term, 120), tf_idf: obj.tf_idf_score ?? null, bm25: obj.bm25_score ?? null });
        }
      }
    }
  };
  addTerms(lsi?.important_lsi);
  addTerms(lsi?.important);
  addTerms(lsi?.importantTerms);
  addTerms(lsi?.additional_lsi);
  addTerms(relevanceContext?.important_lsi);
  addTerms(relevanceContext?.additional_lsi);
  addTerms(relevanceContext?.top_ngrams);
  addTerms(stage2Result?.important_lsi);
  addTerms(stage2Result?.lsi_set);
  addTerms(stage2Result?.lsi?.important);

  let tfidf = [];
  try {
    const raw = typeof task.input_tfidf_json === 'string' ? JSON.parse(task.input_tfidf_json) : task.input_tfidf_json;
    tfidf = asArray(raw).slice(0, 50).map((item) => ({
      term: clean(item?.term || item?.lemma || item?.text || item, 120),
      range_min: Number(item?.rangeMin ?? item?.range_min ?? 0) || 0,
      range_max: Number(item?.rangeMax ?? item?.range_max ?? 999) || 999,
    })).filter((item) => item.term);
  } catch (_) { /* malformed input is handled as empty */ }

  return {
    required: uniq(terms, MAX_LSI),
    weights: weights.filter((item) => item.term).slice(0, 60),
    tfidf,
    bm25_source: relevanceContext?.bm25 || relevanceContext?.bm25_score || null,
  };
}

function deriveFormat(branch, task = {}, outline = {}, risk = 'low') {
  const defaults = BRANCH_DEFAULTS[branch] || BRANCH_DEFAULTS.seo;
  const outlineText = JSON.stringify(outline || {}).toLowerCase();
  const topicText = `${task.topic || ''} ${task.input_target_service || ''} ${task.input_niche_features || ''}`.toLowerCase();
  const comparisonIntent = /сравн|versus|vs\b|альтернатив|лучше|выбор|цена|тариф|плюс|минус/.test(`${outlineText} ${topicText}`);
  const highRisk = risk === 'ymyl' || risk === 'high';
  return {
    require_table: defaults.requireTable || comparisonIntent,
    require_comparison: defaults.requireComparison || comparisonIntent,
    require_faq: defaults.requireFaq,
    require_limitations: highRisk,
    require_methodology: branch !== 'seo' || highRisk,
    require_experience_signal: defaults.requireExperienceSignal,
    require_sources: defaults.requireSources || highRisk,
    require_reviewer: defaults.requireReviewer || highRisk,
    require_summary: true,
    require_byline: true,
    preferred_blocks: uniq([
      'answer-first lead',
      'definition or scope block',
      comparisonIntent ? 'comparison table' : 'decision table',
      branch === 'link' ? 'natural contextual bridge to the anchor destination' : '',
      branch === 'info' ? 'practical checklist or step-by-step block' : '',
      highRisk ? 'limitations and reviewer/disclaimer block' : '',
    ], 8),
  };
}

function deriveObligations({ branch, outline, entities, lsi, format, risk, moduleContext }) {
  const obligations = [];
  for (const entity of entities.filter((item) => item.required).slice(0, 16)) {
    obligations.push({
      obligation_id: `entity:${entity.entity}`,
      kind: 'entity',
      text: `Раскрыть сущность «${entity.entity}» с определением и связью с основной темой.`,
      required: true,
      evidence_required: entity.evidence_required,
    });
  }
  for (const term of lsi.required.slice(0, 18)) {
    obligations.push({
      obligation_id: `lsi:${term}`,
      kind: 'semantic',
      text: `Использовать LSI/термин «${term}» естественно и только в релевантном контексте.`,
      required: true,
      evidence_required: false,
    });
  }
  if (format.require_table) obligations.push({ obligation_id: 'format:table', kind: 'format', text: 'Добавить полезную таблицу с критериями, вариантами, шагами или сравнением; не заполнять её выдуманными цифрами.', required: true, evidence_required: true });
  if (format.require_comparison) obligations.push({ obligation_id: 'format:comparison', kind: 'format', text: 'Добавить честное сравнение вариантов с условиями применимости и ограничениями.', required: true, evidence_required: false });
  if (format.require_methodology) obligations.push({ obligation_id: 'trust:methodology', kind: 'trust', text: 'Описать методику/порядок действий только в пределах подтверждённых возможностей бренда или общедоступных источников.', required: true, evidence_required: true });
  if (format.require_limitations) obligations.push({ obligation_id: 'trust:limitations', kind: 'risk', text: 'Указать ограничения, риски и необходимость проверки специалистом.', required: true, evidence_required: true });
  if (risk === 'ymyl' || risk === 'high') obligations.push({ obligation_id: 'trust:reviewer', kind: 'trust', text: 'Нужен реальный reviewer и human review до публикации.', required: true, evidence_required: true });
  const outlineSections = asArray(outline?.sections || outline?.h2_sections || outline?.blocks || outline);
  for (const section of outlineSections.slice(0, 8)) {
    const h2 = clean(section?.h2 || section?.title || section?.heading || '', 160);
    if (h2) obligations.push({ obligation_id: `section:${h2}`, kind: 'section', text: `Закрыть интент секции «${h2}» практическим ответом, entity-контекстом и evidence при наличии claims.`, required: true, evidence_required: false });
  }
  return obligations.slice(0, MAX_OBLIGATIONS);
}

function buildWriterBrief(contract) {
  const format = contract.format || {};
  const riskRule = contract.risk_level === 'low'
    ? 'Для low-risk темы не имитируй reviewer; достаточно честного byline и источников там, где есть внешние claims.'
    : 'Для high/YMYL темы не публикуй неподтверждённые claims: при нехватке evidence ставь human_review_required=true.';
  const lines = [
    `[PAGE_EEAT_CONTRACT ${contract.version}]`,
    `Ветка: ${contract.branch}; тип страницы: ${contract.page_type}; trust sensitivity: ${contract.risk_level}; целевой E-E-A-T: ${contract.target_score}/10.`,
    'Пиши только на основе VERIFIED_EVIDENCE и VERIFIED_BRAND_FACTS. Не добавляй факты, числа, цены, кейсы, цитаты, сертификаты, гарантии, first-hand experience или авторов, которых нет в contract.',
    'Если доказательства нет, используй нейтральную формулировку без конкретного обещания и добавь риск в self_audit/needs_human_review.',
    `Форматные требования: table=${format.require_table}; comparison=${format.require_comparison}; faq=${format.require_faq}; methodology=${format.require_methodology}; limitations=${format.require_limitations}.`,
    'Пиши естественно: чередуй короткие и длинные предложения, используй конкретные переходы, объясняй причинно-следственные связи, избегай шаблонных вступлений и повторов. Не имитируй «человечность» фальшивыми историями.',
    'LSI и entities встраивай только там, где они помогают ответу; запрещено механическое перечисление терминов и keyword stuffing. TF-IDF/BM25 — ориентир покрытия и распределения, не причина повторять фразу.',
    riskRule,
    `Обязательства: ${contract.obligations.map((item) => `${item.obligation_id} — ${item.text}`).join(' | ')}`,
  ];
  return lines.join('\n').slice(0, 15000);
}

function renderContractMarkdown(contract) {
  const evidence = contract.evidence || [];
  const entities = contract.entities || [];
  const lsi = contract.semantic?.lsi_required || [];
  const obligations = contract.obligations || [];
  const lines = [
    '## E-E-A-T 12 / EVIDENCE-FIRST CONTENT CONTRACT',
    `- Версия: ${contract.version}; ветка: ${contract.branch}; риск: ${contract.risk_level}; target: ${contract.target_score}/10.`,
    '- Правило истины: writer использует только перечисленные подтверждённые facts/evidence и данные бренда; неизвестное не заполняется догадкой.',
    `- Обязательные форматы: table=${contract.format.require_table}; comparison=${contract.format.require_comparison}; methodology=${contract.format.require_methodology}; limitations=${contract.format.require_limitations}.`,
  ];
  if (contract.author) lines.push(`- Автор: ${contract.author.name || 'не задан'}; роль: ${contract.author.role || 'не задана'}; reviewer: ${contract.author.reviewer || 'не задан'}.`);
  if (evidence.length) {
    lines.push('### VERIFIED EVIDENCE');
    for (const item of evidence.slice(0, 8)) lines.push(`- [${item.evidence_id}|${item.status}|${item.source_type}] ${item.text}${item.source ? ` — ${item.source}` : ''}`);
  } else {
    lines.push('### VERIFIED EVIDENCE\n- Нет подтверждённых внешних источников: не создавать внешние facts, цифры, цитаты и кейсы.');
  }
  if (entities.length) lines.push(`### REQUIRED ENTITIES\n${entities.slice(0, 18).map((item) => `- ${item.entity}${item.required ? ' [required]' : ''}${item.relationship ? ` — ${item.relationship}` : ''}`).join('\n')}`);
  if (lsi.length) lines.push(`### LSI / SEMANTIC COVERAGE\n- ${lsi.slice(0, 36).join(', ')}`);
  if (contract.semantic?.tfidf?.length) lines.push(`### TF-IDF RANGES\n${contract.semantic.tfidf.slice(0, 15).map((item) => `- ${item.term}: ${item.range_min}–${item.range_max}`).join('\n')}`);
  if (obligations.length) lines.push(`### SECTION OBLIGATIONS\n${obligations.slice(0, 16).map((item) => `- ${item.obligation_id}: ${item.text}`).join('\n')}`);
  lines.push('### WRITER BRIEF\n' + contract.writer_brief.slice(0, 6000));
  return lines.join('\n\n').slice(0, 14000);
}

function stripHtml(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return clean(value, 100000).toLowerCase().replace(/ё/g, 'е');
}

function termPresent(text, term) {
  const normalized = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (normalized.includes(normalizedTerm)) return true;
  const words = normalizedTerm.split(/\s+/).filter((word) => word.length >= 4);
  return words.length > 0 && words.every((word) => normalized.includes(word.slice(0, Math.min(6, word.length))));
}

function metricScores({ contract, text, html, checks }) {
  const evidence = contract.evidence || [];
  const sourceBacked = evidence.filter((item) => item.source || item.source_type === 'brand_input').length;
  const requiredEntities = (contract.entities || []).filter((item) => item.required);
  const entityCoverage = requiredEntities.length
    ? requiredEntities.filter((item) => checks.entitiesPresent.includes(item.entity)).length / requiredEntities.length
    : Math.min(1, (contract.entities || []).length / 6);
  const lsiCoverage = checks.lsi.total ? checks.lsi.present / checks.lsi.total : 1;
  const hasActionable = /шага|шагов|как |порядок|чек-лист|проверь|рекоменд|критер|таблиц|список/i.test(text);
  const hasHumanStructure = checks.sentenceVariance >= 0.35 && !checks.repetitiveOpening;
  const highRisk = contract.risk_level === 'high' || contract.risk_level === 'ymyl';
  const score = {
    experience: contract.format.require_experience_signal ? (evidence.some((item) => /case|brand|test|proof/i.test(item.evidence_type) || item.source_type === 'brand_input') ? 8 : 4) : 7,
    expertise: Math.min(10, 5 + Math.min(4, (contract.entities || []).length / 5) + (hasActionable ? 1 : 0)),
    author_transparency: checks.hasByline ? (contract.author?.name && contract.author.name !== 'Редакция' ? 9 : 7) : 3,
    reviewer_validation: highRisk ? (contract.author?.reviewer ? 9 : 3) : 8,
    factual_accuracy: checks.unsupportedClaims.length ? 3 : (evidence.length ? 8 : 6),
    source_transparency: highRisk ? (sourceBacked >= 2 ? 9 : sourceBacked ? 6 : 3) : (sourceBacked ? 8 : 6),
    entity_completeness: Math.round(entityCoverage * 10 * 10) / 10,
    information_gain: (checks.hasTable || checks.hasComparison || contract.obligations.some((item) => item.kind === 'section')) ? 8 : 5,
    specificity_actionability: hasActionable ? 8 : 5,
    trustworthiness: checks.critical.length ? 3 : (checks.unsupportedClaims.length ? 5 : 8),
    intent_fit: 7,
    freshness_editorial_ux: hasHumanStructure && checks.hasDateSignal ? 8 : (hasHumanStructure ? 7 : 5),
  };
  return Object.fromEntries(METRICS.map((key) => [key, Math.max(0, Math.min(10, Math.round((score[key] || 0) * 10) / 10))]));
}

function validateEeatContract(html, contract = {}) {
  const text = stripHtml(html);
  const lower = text.toLowerCase();
  const requiredEntities = (contract.entities || []).filter((item) => item.required);
  const entitiesPresent = requiredEntities.filter((item) => termPresent(text, item.entity)).map((item) => item.entity);
  const lsiTerms = contract.semantic?.lsi_required || [];
  const lsiPresent = lsiTerms.filter((term) => termPresent(text, term));
  const lsiMissing = lsiTerms.filter((term) => !termPresent(text, term));
  const numericClaims = (text.match(/\b\d+(?:[.,]\d+)?\s*(?:%|₽|руб\.?|млн|тыс\.?|лет|дн\.?|час(?:а|ов)?)\b/gi) || []).length;
  const hasSourceLink = /https?:\/\//i.test(html) || /источник\s*:/i.test(text);
  const hasEvidenceMarker = /ev-[a-z0-9_-]+|evidence_id|data-evidence/i.test(text);
  const unsupportedClaims = [];
  if (numericClaims > 0 && (!contract.evidence?.length || (!hasSourceLink && !hasEvidenceMarker))) {
    unsupportedClaims.push(`numeric_claims_without_local_evidence:${numericClaims}`);
  }
  if (/по данным|согласно исследован|сертификат|гарантируем|клиент(?:ы|ов)\s+получил/i.test(text)
      && !hasSourceLink && !hasEvidenceMarker) {
    unsupportedClaims.push('evidence_language_without_local_source');
  }
  const critical = [];
  if (!contract.format?.requireByline || /автор|редакц/i.test(lower) || /author/i.test(html)) {
    // Presence is evaluated below; this branch only keeps the rule explicit.
  }
  const hasByline = /автор|редакц|author|byline/i.test(lower) || /application\/ld\+json/i.test(html);
  if (!hasByline) critical.push('missing_author_byline');
  if ((contract.format?.require_table || false) && !/<table\b/i.test(html)) critical.push('missing_required_table');
  if ((contract.format?.require_comparison || false) && !/сравн|альтернатив|критери|плюс|минус|вариант/i.test(text)) critical.push('missing_comparison_signal');
  if ((contract.format?.require_faq || false) && !/часто задава|faq|вопрос/i.test(text)) critical.push('missing_faq_signal');
  if ((contract.format?.require_limitations || false) && !/огранич|риск|не подход|проверить специалист|дисклеймер/i.test(text)) critical.push('missing_limitations');
  if ((contract.risk_level === 'high' || contract.risk_level === 'ymyl') && !contract.author?.reviewer) critical.push('reviewer_required_for_high_risk');
  if (requiredEntities.length && entitiesPresent.length / requiredEntities.length < 0.7) critical.push(`entity_coverage_below_70:${entitiesPresent.length}/${requiredEntities.length}`);
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const lengths = sentences.map((s) => s.split(/\s+/).length);
  const mean = lengths.length ? lengths.reduce((sum, n) => sum + n, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((sum, n) => sum + ((n - mean) ** 2), 0) / lengths.length : 0;
  const sentenceVariance = mean ? Math.sqrt(variance) / mean : 0;
  const openingSamples = sentences.slice(0, 8).map((s) => s.split(/\s+/).slice(0, 3).join(' ').toLowerCase());
  const repetitiveOpening = new Set(openingSamples).size < Math.max(2, Math.floor(openingSamples.length / 2));
  const hasDateSignal = /20\d{2}|обновлено|актуально на|дата/i.test(text);
  const checks = {
    entitiesPresent,
    entitiesMissing: requiredEntities.filter((item) => !entitiesPresent.includes(item.entity)).map((item) => item.entity),
    lsi: { total: lsiTerms.length, present: lsiPresent.length, missing: lsiMissing },
    unsupportedClaims,
    critical,
    hasByline,
    hasTable: /<table\b/i.test(html),
    hasComparison: /сравн|альтернатив|критери|плюс|минус|вариант/i.test(text),
    hasSourceLink,
    sentenceVariance,
    repetitiveOpening,
    hasDateSignal,
  };
  const components = metricScores({ contract, text, html, checks });
  const overall = METRICS.reduce((sum, key) => sum + components[key], 0) / METRICS.length;
  const rounded = Math.round(overall * 10) / 10;
  const target = Number(contract.target_score || TARGET_DEFAULT);
  const hardBlock = critical.some((item) => /reviewer_required|unsupported|missing_limitations|entity_coverage/.test(item));
  const verdict = hardBlock ? 'human_review' : (rounded >= target && !unsupportedClaims.length ? 'pass' : 'refine');
  return {
    contract_version: contract.version || CONTRACT_VERSION,
    verdict,
    overall_score: rounded,
    target_score: target,
    components,
    checks,
    missing_entities: checks.entitiesMissing,
    missing_lsi: lsiMissing,
    unsupported_claims: unsupportedClaims,
    blockers: critical,
    refiner_actions: [
      ...critical.map((item) => `Исправить blocker: ${item}`),
      ...lsiMissing.slice(0, 12).map((item) => `Естественно добавить LSI-термин: ${item}`),
      ...unsupportedClaims.map((item) => `Проверить evidence или убрать неподтверждённое утверждение: ${item}`),
    ],
    publish_ready: verdict === 'pass',
  };
}

function buildEeatContract({ branch = 'seo', task = {}, targetPageAnalysis = null, strategy = null, stage0Result = null, stage1Result = null, stage2Result = null, audience = null, intents = null, whitespace = null, outline = null, lsi = null, realtimeResearch = null, relevanceContext = null, governanceReport = null, moduleContext = null, author = null, targetScore = TARGET_DEFAULT } = {}) {
  const normalizedBranch = normalizeBranch(branch);
  const risk = normalizeRisk(task, moduleContext || {}, governanceReport || {});
  const format = deriveFormat(normalizedBranch, task, outline, risk);
  const evidence = collectEvidence({ task, targetPageAnalysis, stage0Result, stage1Result, realtimeResearch, governanceReport, relevanceContext });
  const entities = collectEntities({ task, stage1Result: stage1Result || intents, moduleContext, relevanceContext, lsi });
  const semantic = collectLsi({ task, lsi, relevanceContext, stage2Result });
  const obligations = deriveObligations({ branch: normalizedBranch, outline, entities, lsi: semantic, format, risk, moduleContext });
  const contract = {
    version: CONTRACT_VERSION,
    branch: normalizedBranch,
    branch_label: BRANCH_DEFAULTS[normalizedBranch].label,
    page_type: BRANCH_DEFAULTS[normalizedBranch].pageType,
    risk_level: risk,
    target_score: Number.isFinite(Number(targetScore)) ? Math.max(7.5, Math.min(9.5, Number(targetScore))) : TARGET_DEFAULT,
    author: {
      name: clean(author?.name || task.input_author_name || task.author_name || '', 120) || null,
      role: clean(author?.role || task.input_author_role || task.author_role || '', 120) || null,
      reviewer: clean(author?.reviewer || task.reviewer_name || '', 120) || null,
    },
    evidence,
    entities,
    semantic: {
      lsi_required: semantic.required,
      tfidf: semantic.tfidf,
      weights: semantic.weights,
      bm25_source: semantic.bm25_source,
    },
    format,
    obligations,
    unknowns: [
      ...(evidence.length ? [] : ['Нет подтверждённого evidence pack для внешних фактов.']),
      ...(entities.length ? [] : ['Нет структурированного entity map.']),
      ...(semantic.required.length ? [] : ['Нет обязательного LSI/semantic набора.']),
    ],
    human_review_required: risk === 'ymyl' || risk === 'high',
    dspy_signature: 'Eeat12ContractAndWriterBrief',
  };
  contract.writer_brief = buildWriterBrief(contract);
  contract.markdown = renderContractMarkdown(contract);
  return contract;
}

module.exports = {
  CONTRACT_VERSION,
  METRICS,
  BRANCH_DEFAULTS,
  buildEeatContract,
  renderContractMarkdown,
  validateEeatContract,
};
