'use strict';

/**
 * contentGovernance — единый слой правил BRANDCORE + TGA Navigator.
 *
 * Исходные документы используются как нормативная основа, но сами файлы
 * намеренно не входят в репозиторий. Модуль не обещает позиции в Google или
 * Яндексе: он обеспечивает воспроизводимость фактов, семантическое покрытие,
 * E-E-A-T-проверки, защиту от выдуманных claims и понятный human-review.
 */

const CONTENT_TYPES = Object.freeze({
  seo: {
    label: 'SEO-текст',
    purpose: 'коммерческая страница под подтверждённый поисковый интент',
    required: [
      'primary_intent',
      'target_audience',
      'mandatory_entities',
      'answer_first',
      'commercial_proof',
      'internal_link_plan',
    ],
    stages: [
      'до анализа: определить границу темы, аудиторию, регион и интент',
      'до структуры: проверить сущности, JTBD, вопросы и каннибализацию',
      'до writer: передать только подтверждённые факты и claims',
      'после writer: проверить E-E-A-T, факты, интент, LSI и value-add',
      'до meta: не добавлять в мета-теги сведения, которых нет в финальном тексте',
    ],
  },
  link: {
    label: 'Ссылочная статья',
    purpose: 'полезная самостоятельная статья на внешней площадке с естественной ссылкой',
    required: [
      'donor_audience',
      'article_intent',
      'one_planned_anchor',
      'neutral_editorial_value',
      'source_disclosure',
    ],
    stages: [
      'до структуры: проверить роль донора, аудиторию и допустимый анкор',
      'до writer: сформировать самостоятельную пользу без рекламного давления',
      'после writer: проверить естественность ссылки, claims и E-E-A-T',
      'до meta: мета-теги должны описывать статью, а не продвигаемый анкор',
    ],
  },
  info: {
    label: 'Статья для блога',
    purpose: 'информационный материал, закрывающий вопросы аудитории и информационную дельту',
    required: [
      'reader_questions',
      'topic_entities',
      'information_gain',
      'author_byline',
      'sources_or_evidence',
    ],
    stages: [
      'до анализа: определить вопрос читателя и границу информационной задачи',
      'до структуры: связать H2/H3 с вопросами, сущностями и JTBD',
      'до writer: передать реальные факты, источники и ограничения claims',
      'после writer: проверить E-E-A-T, фактологию, интент, оригинальную пользу и FAQ',
      'до meta: не обещать в Title/Description то, чего статья не раскрывает',
    ],
  },
  meta: {
    label: 'Мета-теги',
    purpose: 'Title, Description и H1, точно отражающие готовую страницу',
    required: [
      'page_topic',
      'search_intent',
      'page_angle',
      'verified_claims_only',
      'no_clickbait',
    ],
    stages: [
      'до генерации: взять тему и интент из страницы, а не придумывать новую семантику',
      'во время генерации: не добавлять неподтверждённые цифры, гарантии и преимущества',
      'после генерации: проверить соответствие финальному HTML, длину и отсутствие дублей',
    ],
  },
});

const STATUS_ALIASES = new Map([
  ['подтверждено', 'confirmed'],
  ['подтверждён', 'confirmed'],
  ['подтвержден', 'confirmed'],
  ['confirmed', 'confirmed'],
  ['verified', 'confirmed'],
  ['черновик', 'draft'],
  ['draft', 'draft'],
  ['устарело', 'obsolete'],
  ['устаревший', 'obsolete'],
  ['obsolete', 'obsolete'],
  ['в архиве', 'archived'],
  ['архив', 'archived'],
  ['archived', 'archived'],
]);

const SENSITIVE_PATTERN = /(медицин|здоров|лечен|лекар|финанс|кредит|банк|инвест|страхован|юридичес|право|адвокат|налог|лиценз|безопасност|детск|психолог)/i;
const PLACEHOLDER_PATTERN = /^\s*\[[^\]]+\]\s*$/;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value, max = 1200) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value || '')) || /\[TODO\]/i.test(String(value || ''));
}

function normalizeStatus(value) {
  const key = String(value || '').trim().toLowerCase();
  return STATUS_ALIASES.get(key) || (key ? key : 'unknown');
}

function unique(values) {
  return [...new Set(values.map((value) => asText(value, 500)).filter(Boolean))];
}

function normalizeRecord(record, kind = 'fact') {
  if (record == null) return null;
  if (typeof record === 'string') {
    if (!record.trim() || isPlaceholder(record)) return null;
    return {
      id: null,
      kind,
      text: asText(record, 700),
      status: 'unstructured',
      source: '',
      excerpt: '',
      channels: [],
    };
  }
  if (typeof record !== 'object' || Array.isArray(record)) return null;
  const text = record.text || record.fact || record.claim || record.value || record.statement || record.name;
  if (!text || isPlaceholder(text)) return null;
  return {
    id: asText(record.id || record.claim_id || record.fact_id, 120),
    kind,
    text: asText(text, 700),
    status: normalizeStatus(record.status || record.verification_status || record.confidence_status),
    source: asText(record.source || record.source_url || record.evidence_source, 500),
    excerpt: asText(record.excerpt || record.exact_excerpt || record.evidence_excerpt, 700),
    channels: asArray(record.channels || record.allowed_channels).map((v) => asText(v, 80)).filter(Boolean),
    expiresAt: asText(record.review_by || record.review_until || record.expires_at, 80),
    product: asText(record.product || record.product_line, 160),
    audience: asText(record.audience || record.condition, 240),
    allowed: asText(record.allowed || record.allowed_formulation, 600),
    forbidden: asText(record.forbidden || record.forbidden_formulation, 600),
  };
}

function collectProjectContext(projectContext = {}) {
  const project = projectContext.project || {};
  const brand = projectContext.brand || {};
  const criteria = project.content_criteria || {};
  const signals = projectContext.signals || {};
  const task = projectContext.task || {};

  const rawFacts = [
    ...asArray(brand.facts),
    ...asArray(project.facts),
    ...asArray(task.verified_facts),
    ...asArray(task.brand_facts_json),
  ];
  const rawClaims = [
    ...asArray(brand.approved_claims),
    ...asArray(project.approved_claims),
    ...asArray(criteria.approved_claims),
    ...asArray(task.approved_claims),
    ...asArray(task.claims),
  ];
  const rawWarnings = [
    ...asArray(criteria.required_disclaimers),
    ...asArray(project.required_disclaimers),
    ...asArray(task.required_disclaimers),
  ];
  const rawConflicts = [
    ...asArray(projectContext.conflicts),
    ...asArray(project.conflicts),
    ...asArray(brand.conflicts),
    ...asArray(criteria.conflicts),
    ...asArray(task.source_conflicts),
  ];

  const facts = rawFacts.map((value) => normalizeRecord(value, 'fact')).filter(Boolean);
  const claims = rawClaims.map((value) => normalizeRecord(value, 'claim')).filter(Boolean);
  const disclaimers = rawWarnings
    .map((value) => (typeof value === 'string' ? { text: value, status: 'unstructured' } : value))
    .map((value) => ({ ...value, text: asText(value?.text || value?.wording || value?.value, 700), status: normalizeStatus(value?.status) }))
    .filter((value) => value.text && !isPlaceholder(value.text));

  return {
    project,
    brand,
    criteria,
    signals,
    task,
    facts,
    claims,
    disclaimers,
    conflicts: unique(rawConflicts.map((value) => typeof value === 'string' ? value : value?.reason || value?.description || value?.text)),
  };
}

function detectSensitive(task = {}, context = {}) {
  if (task.ymyl === true || task.sensitive_category === true || context.project?.sensitive_category === true) return true;
  const haystack = [
    task.input_target_service,
    task.topic,
    task.input_business_type,
    task.input_niche_features,
    context.project?.niche,
  ].filter(Boolean).join(' ');
  return SENSITIVE_PATTERN.test(haystack);
}

function getConfirmed(records) {
  return records.filter((record) => record.status === 'confirmed');
}

function getTypeRules(contentType) {
  return CONTENT_TYPES[contentType] || CONTENT_TYPES.seo;
}

function buildGovernanceReport({ contentType = 'seo', task = {}, projectContext = null, semanticContext = null } = {}) {
  const normalizedType = CONTENT_TYPES[contentType] ? contentType : 'seo';
  const data = collectProjectContext({ ...(projectContext || {}), task: { ...(projectContext?.task || {}), ...task } });
  const sensitive = detectSensitive(task, data);
  const blockers = [];
  const warnings = [];

  if (data.conflicts.length) {
    blockers.push({ code: 'source_conflict', message: 'Есть конфликтующие внутренние источники; спорные факты нельзя использовать до ручного разрешения.', items: data.conflicts.slice(0, 8) });
  }

  const obsoleteClaims = data.claims.filter((record) => record.status === 'obsolete' || record.status === 'archived');
  const obsoleteFacts = data.facts.filter((record) => record.status === 'obsolete' || record.status === 'archived');
  const draftClaims = data.claims.filter((record) => record.status === 'draft' || record.status === 'unknown' || record.status === 'unstructured');
  const draftFacts = data.facts.filter((record) => record.status === 'draft' || record.status === 'unknown' || record.status === 'unstructured');
  if (obsoleteClaims.length || obsoleteFacts.length) {
    warnings.push({ code: 'obsolete_claims_ignored', message: 'Устаревшие или архивные claims исключены из публичного контента.', count: obsoleteClaims.length });
  }

  if (draftClaims.length || draftFacts.length) {
    warnings.push({ code: 'unverified_claims_restricted', message: 'Facts/claims без статуса confirmed нельзя использовать как публичные утверждения.', count: draftClaims.length + draftFacts.length });
  }

  const authorName = task.input_author_name || task.author_name || task.__authorName || task.author || data.project.author;
  const reviewerName = task.input_reviewer_name || task.reviewer_name || task.__reviewerName || task.reviewer || data.project.reviewer;
  if (sensitive && !String(authorName || '').trim()) {
    blockers.push({ code: 'missing_author_for_sensitive_topic', message: 'Для чувствительной тематики не указан автор или ответственная роль.' });
  }
  if (sensitive && !String(reviewerName || '').trim()) {
    warnings.push({ code: 'missing_reviewer_for_sensitive_topic', message: 'Для чувствительной тематики желательно указать проверяющего специалиста до публикации.' });
  }
  if (!data.facts.length && !data.claims.length) {
    warnings.push({ code: 'no_structured_provenance', message: 'Структурированный банк подтверждённых фактов не найден; точные claims и цифры запрещены.' });
  }

  const semantic = semanticContext && typeof semanticContext === 'object' ? semanticContext : {};
  const semanticCounts = {
    entities: asArray(semantic.entities || semantic.mandatory_entities).length,
    intents: asArray(semantic.intents || semantic.subintents).length,
    questions: asArray(semantic.questions || semantic.user_questions).length,
    lsi: asArray(semantic.lsi || semantic.important_lsi).length,
  };
  const semanticWarningCount = Object.values(semanticCounts).filter((count) => count === 0).length;
  if (semanticWarningCount >= 2) {
    warnings.push({ code: 'weak_semantic_context', message: 'Недостаточно подтверждённых сущностей, интентов, вопросов или LSI для уверенного расширения семантики.', counts: semanticCounts });
  }

  const report = {
    schema: 'brandcore-tga-governance-v1',
    content_type: normalizedType,
    content_label: getTypeRules(normalizedType).label,
    sensitive_topic: sensitive,
    status: blockers.length ? 'blocked' : (sensitive || warnings.length ? 'needs_human_review' : 'ready'),
    can_generate: blockers.length === 0,
    can_publish: blockers.length === 0 && !sensitive && !data.conflicts.length,
    blockers,
    warnings,
    confirmed_facts: getConfirmed(data.facts).length,
    confirmed_claims: getConfirmed(data.claims).length,
    confirmed_fact_records: getConfirmed(data.facts).slice(0, 12),
    confirmed_claim_records: getConfirmed(data.claims).slice(0, 12),
    ignored_claims: obsoleteClaims.length + draftClaims.length,
    ignored_facts: obsoleteFacts.length + draftFacts.length,
    ignored_records: obsoleteClaims.length + draftClaims.length + obsoleteFacts.length + draftFacts.length,
    disclaimers: data.disclaimers.filter((item) => item.status === 'confirmed' || item.status === 'unstructured').map((item) => item.text).slice(0, 10),
    semantic_counts: semanticCounts,
    source_policy: {
      confirmed_status: 'confirmed',
      allowed_statuses_for_public_claims: ['confirmed'],
      placeholder_is_not_fact: true,
      conflicts_require_human_review: true,
    },
    generated_at: new Date().toISOString(),
  };
  return report;
}

function renderGovernanceBlock({ report, contentType = 'seo', task = {}, projectContext = null, semanticContext = null } = {}) {
  const governance = report || buildGovernanceReport({ contentType, task, projectContext, semanticContext });
  const rules = getTypeRules(contentType);
  const data = collectProjectContext({ ...(projectContext || {}), task: { ...(projectContext?.task || {}), ...task } });
  const confirmedFacts = projectContext ? getConfirmed(data.facts) : asArray(governance.confirmed_fact_records);
  const confirmedClaims = projectContext ? getConfirmed(data.claims) : asArray(governance.confirmed_claim_records);
  const factsText = confirmedFacts.slice(0, 10).map((record) => `- ${record.text}${record.source ? ` (источник: ${record.source})` : ''}`).join('\n') || '- Нет структурированных подтверждённых фактов.';
  const claimsText = confirmedClaims.slice(0, 10).map((record) => `- ${record.allowed || record.text}${record.source ? ` (источник: ${record.source})` : ''}`).join('\n') || '- Нет структурированных подтверждённых claims. Точные обещания запрещены.';
  const disclaimersText = governance.disclaimers.length ? governance.disclaimers.map((value) => `- ${value}`).join('\n') : '- Обязательные оговорки не заданы.';
  const blockerText = governance.blockers.length ? governance.blockers.map((item) => `- ${item.code}: ${item.message}`).join('\n') : '- Нет блокирующих конфликтов.';

  return [
    '## CONTENT GOVERNANCE — BRANDCORE + TGA',
    `Тип материала: ${rules.label}. Цель: ${rules.purpose}.`,
    `Статус входного контекста: ${governance.status}. can_generate=${governance.can_generate}; can_publish=${governance.can_publish}.`,
    '',
    '### Иерархия правил',
    '1. Закон, лицензии, защита данных и подтверждённые обязательные предупреждения.',
    '2. Подтверждённые факты и claims с явным статусом confirmed.',
    '3. Техническое задание, поисковый интент и семантическая структура.',
    '4. Редакторские и SEO-эвристики. Внутренние оценки не выдавать за гарантированные факторы ранжирования.',
    '',
    '### Факты и claims',
    'Используй только подтверждённые записи. Плейсхолдеры, черновики, архивные и устаревшие записи не являются фактами.',
    'Не выдумывай цифры, даты, лицензии, клиентов, отзывы, цитаты, гарантии, награды и результаты. При нехватке фактов используй нейтральную формулировку или отметь необходимость проверки человеком.',
    'Подтверждённые факты:',
    factsText,
    'Разрешённые claims:',
    claimsText,
    '',
    '### E-E-A-T и публикационная готовность',
    'Показывай реальный опыт только через переданные факты, кейсы, доказательства и источники. Не создавай вымышленного автора, эксперта, рецензента или цитату.',
    'Для чувствительных тем нужен автор/ответственная роль, проверяющий специалист и источники; финальный статус публикации требует ручного согласования.',
    'Дата, регион, ограничения услуги и актуальность должны соответствовать входным данным; если подтверждения нет, не конкретизируй.',
    'Обязательные оговорки:',
    disclaimersText,
    '',
    '### TGA: семантика и границы темы',
    'Сохраняй границу одной страницы и один основной пользовательский интент. Не объединяй разные интенты без явного задания.',
    'Раскрывай связанные сущности, вопросы, JTBD и информационные пробелы только в рамках задачи. Не добавляй семантику ради плотности ключевых слов.',
    `Контекст семантики: entities=${governance.semantic_counts.entities}, intents=${governance.semantic_counts.intents}, questions=${governance.semantic_counts.questions}, lsi=${governance.semantic_counts.lsi}.`,
    'Не каннибализируй опубликованные темы и не создавай внутренние ссылки, которых нет в плане.',
    '',
    '### Правила конкретного типа материала',
    rules.stages.map((stage, index) => `${index + 1}. ${stage}`).join('\n'),
    '',
    '### Блокирующие причины и ручная проверка',
    blockerText,
    governance.warnings.length ? governance.warnings.map((item) => `- предупреждение ${item.code}: ${item.message}`).join('\n') : '- Дополнительных предупреждений нет.',
    '',
    '### Контракт ответа',
    'Верни только запрошенный формат текущего этапа. Не помещай служебные governance-инструкции в публичный HTML, Title или Description.',
  ].join('\n');
}

function governanceGate(report) {
  const value = report || {};
  const blockers = asArray(value.blockers);
  const warnings = asArray(value.warnings);
  const pass = blockers.length === 0;
  return {
    name: 'content_governance',
    pass,
    blocking: !pass,
    score: pass ? 1 : 0,
    verdict: value.status || (pass ? 'ready' : 'blocked'),
    evidence: {
      content_type: value.content_type || null,
      sensitive_topic: value.sensitive_topic === true,
      blocker_codes: blockers.map((item) => item.code).filter(Boolean),
      warning_codes: warnings.map((item) => item.code).filter(Boolean),
      confirmed_facts: Number(value.confirmed_facts) || 0,
      confirmed_claims: Number(value.confirmed_claims) || 0,
      semantic_counts: value.semantic_counts || {},
    },
  };
}

module.exports = {
  CONTENT_TYPES,
  normalizeStatus,
  isPlaceholder,
  buildGovernanceReport,
  renderGovernanceBlock,
  governanceGate,
};
