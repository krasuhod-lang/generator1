'use strict';

/**
 * Module Context — pure derive over Stage 0 / 1 / 2 results.
 *
 * Объединяет «Модуль 1» (язык аудитории + сущности) и «Модуль 2»
 * (формат + trust + claims + JTBD) в один детерминированный JSON-контракт,
 * который:
 *   1. Сохраняется в `tasks.module_context` (миграция 014).
 *   2. Уезжает в AKB как §11 «hard analytical constraints» — Gemini/Grok
 *      видят его в Stage 3/5/6 и могут опираться при генерации.
 *   3. Используется опциональным Stage 8 (LLM-as-judge) как ground truth
 *      для проверки готовой статьи.
 *
 * ⚠️ Без LLM-вызовов. Без замедления генерации. Безопасно при отсутствии
 *    любого из входных результатов (graceful degradation → пустые массивы).
 *
 * Источники терминологии:
 *   - backend/src/prompts/source/18-Entity Landscape Builder.txt (canonical_entities)
 *   - backend/src/prompts/source/09-Niche Terminology & Language Map v3.txt
 *   - backend/src/prompts/source/24-Content Format Fit Analyzer.txt (format_wedge)
 *   - backend/src/prompts/source/17-E-E-A-T & Trust Requirement Scanner.txt (trust_complexity)
 *   - backend/src/prompts/source/23-Community Voice Miner.txt (jtbd, audience_language)
 */

// ── Константы (можно переопределить через ENV без редеплоя) ─────────
const MAX_MANDATORY_ENTITIES   = parseInt(process.env.MODULE_CTX_MAX_ENTITIES,    10) || 25;
const MAX_AVOID_TERMS          = parseInt(process.env.MODULE_CTX_MAX_AVOID,       10) || 15;
const MAX_AUDIENCE_CLUSTERS    = parseInt(process.env.MODULE_CTX_MAX_LANG,        10) || 12;
const MAX_CLAIMS               = parseInt(process.env.MODULE_CTX_MAX_CLAIMS,      10) || 15;
const MAX_JTBD                 = parseInt(process.env.MODULE_CTX_MAX_JTBD,        10) || 15;

// «Опасные» неоднозначные термины, которые полезно пометить как
// требующие пояснения в любой нише (используется как seed-список,
// который дополняется доменными терминами из stage1.terminology_map).
const GENERIC_AMBIGUOUS_RU = [
  'качество', 'надёжность', 'надежность', 'комплекс', 'решение', 'подход',
  'эффективность', 'оптимально', 'современно', 'инновационно', 'профессионально',
];

// ── Helpers ──────────────────────────────────────────────────────────
function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') {
    const firstArr = Object.values(v).find(x => Array.isArray(x));
    return Array.isArray(firstArr) ? firstArr : [];
  }
  return [];
}

function nonEmptyString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

function uniqueByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = (keyFn(item) || '').toString().trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function clampArr(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

// ── 1. mandatory_entities (Модуль 1) ────────────────────────────────
function deriveMandatoryEntities({ stage0Result, stage1Result }) {
  // Источники (по приоритету достоверности):
  //   a) stage1.knowledge_graph.nodes c salience >= 0.5
  //   b) stage1.entity_graph (топ по weight)
  //   c) stage0.core_entities (с trust_signal === true приоритетнее)
  const out = [];

  // a) knowledge_graph nodes
  for (const node of asArray(stage1Result?.knowledge_graph?.nodes)) {
    if (!nonEmptyString(node?.label)) continue;
    const salience = Number(node.salience);
    if (Number.isFinite(salience) && salience < 0.4) continue;
    out.push({
      entity:   node.label.trim(),
      type:     nonEmptyString(node.type) ? node.type : 'concept',
      source:   'knowledge_graph',
      weight:   Number.isFinite(salience) ? salience : 0.6,
    });
  }

  // b) entity_graph
  for (const e of asArray(stage1Result?.entity_graph)) {
    if (!nonEmptyString(e?.entity)) continue;
    out.push({
      entity:   e.entity.trim(),
      type:     nonEmptyString(e.type) ? e.type : 'concept',
      source:   'entity_graph',
      weight:   Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0.5,
    });
  }

  // c) stage0.core_entities (после Stage 1, чтобы доминировал KG)
  for (const e of asArray(stage0Result?.core_entities)) {
    if (!nonEmptyString(e?.entity)) continue;
    out.push({
      entity:   e.entity.trim(),
      type:     nonEmptyString(e.type) ? e.type : 'concept',
      source:   'stage0_core_entities',
      // trust_signal=true → выше приоритет
      weight:   e.trust_signal ? 0.7 : 0.4,
    });
  }

  const deduped = uniqueByKey(out, x => x.entity);
  // Сортируем по убыванию веса для стабильного top-N среза
  deduped.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return clampArr(deduped, MAX_MANDATORY_ENTITIES);
}

// ── 2. avoid_ambiguous_terms (Модуль 1) ─────────────────────────────
function deriveAvoidAmbiguous({ stage1Result }) {
  // Generic список + термины из terminology_map, у которых определение
  // помечено как «расплывчатое» (длина definition < 20 символов или
  // содержит «или», «разное», «зависит»).
  const out = [];

  for (const term of GENERIC_AMBIGUOUS_RU) {
    out.push({ term, reason: 'generic-marketing-cliche' });
  }

  const tmap = stage1Result?.terminology_map;
  if (tmap && typeof tmap === 'object' && !Array.isArray(tmap)) {
    for (const [term, def] of Object.entries(tmap)) {
      if (!nonEmptyString(term)) continue;
      const d = (def || '').toString().trim();
      if (d.length > 0 && d.length < 20) {
        out.push({ term: term.trim(), reason: 'definition-too-vague' });
      } else if (/(или|зависит|разное|любой)/i.test(d)) {
        out.push({ term: term.trim(), reason: 'definition-ambiguous' });
      }
    }
  }

  return clampArr(uniqueByKey(out, x => x.term), MAX_AVOID_TERMS);
}

// ── 3. audience_language_clusters (Модуль 1) ────────────────────────
function deriveAudienceLanguage({ stage1Result }) {
  // Источники: stage1.language_map (формальный → разговорный),
  //            stage1.lsi_clusters[*].keywords (как «как говорит ниша»).
  const out = [];

  const lm = stage1Result?.language_map;
  if (lm && typeof lm === 'object' && !Array.isArray(lm)) {
    for (const [formal, colloquial] of Object.entries(lm)) {
      if (!nonEmptyString(formal) || !nonEmptyString(colloquial)) continue;
      out.push({
        formal:     formal.trim(),
        colloquial: colloquial.toString().trim(),
        source:     'language_map',
      });
    }
  }

  for (const cluster of asArray(stage1Result?.lsi_clusters)) {
    if (!nonEmptyString(cluster?.cluster_name)) continue;
    const kws = asArray(cluster.keywords).filter(nonEmptyString).slice(0, 6);
    if (!kws.length) continue;
    out.push({
      cluster:  cluster.cluster_name.trim(),
      keywords: kws,
      intent:   nonEmptyString(cluster.intent) ? cluster.intent : 'informational',
      source:   'lsi_clusters',
    });
  }

  return clampArr(out, MAX_AUDIENCE_CLUSTERS);
}

// ── 4. format_wedge (Модуль 2) ──────────────────────────────────────
function deriveFormatWedge({ stage1Result, stage2Result, task }) {
  // Stage 2B (content_formats) — главный источник.
  // enrichedStage1 в orchestrator кладёт результат как stage1.content_formats.
  const cf = stage2Result?.enrichedStage1?.content_formats
          || stage1Result?.content_formats
          || null;

  const recommended = asArray(cf?.recommended_formats)
    .filter(f => nonEmptyString(typeof f === 'string' ? f : f?.format))
    .slice(0, 6)
    .map(f => (typeof f === 'string' ? { format: f } : f));

  const priorityOrder = asArray(cf?.format_priority_order).filter(nonEmptyString).slice(0, 6);

  // Primary wedge — первый по priority_order, иначе первый recommended.
  const primary = priorityOrder[0]
                || (recommended[0] && (recommended[0].format || recommended[0].name))
                || null;

  // Если совсем пусто — fallback на тип бизнеса.
  let fallback = null;
  if (!primary) {
    const bt = (task?.input_business_type || '').toLowerCase();
    if (/услуг|сервис|service/.test(bt))      fallback = 'how-to-guide';
    else if (/магазин|shop|товар|product/.test(bt)) fallback = 'product-comparison';
    else                                       fallback = 'long-form-guide';
  }

  return {
    primary:        primary || fallback,
    priority_order: priorityOrder,
    recommended:    recommended,
    ai_search_opportunities: asArray(cf?.ai_search_opportunities).slice(0, 6),
  };
}

// ── 5. trust_complexity (Модуль 2) ──────────────────────────────────
function deriveTrustComplexity({ stage0Result, targetPageAnalysis, task }) {
  // Эвристика по доступным сигналам (без LLM):
  //   - есть YMYL-маркеры в targetPage (медицина, финансы, юр., детское) → high
  //   - есть >=3 trust_triggers → medium
  //   - проект-ограничения упоминают «закон», «лицензия», «гарантия» → +1 уровень
  let level = 'medium';
  const reasons = [];

  const triggers = asArray(stage0Result?.trust_triggers);
  if (triggers.length >= 5) {
    level = 'medium';
    reasons.push(`stage0.trust_triggers=${triggers.length}`);
  } else if (triggers.length === 0) {
    level = 'low';
    reasons.push('stage0.trust_triggers=0');
  }

  const businessType = (task?.input_business_type
                     || targetPageAnalysis?.detected_business_type
                     || '').toLowerCase();
  const ymylRegex = /(медиц|здоров|клиник|стомат|финанс|кредит|инвест|юри|закон|нотар|детск|школ|учеб|еда|питание)/i;
  if (ymylRegex.test(businessType) || ymylRegex.test(task?.input_target_service || '')) {
    level = 'high';
    reasons.push('YMYL-niche detected');
  }

  const limits = (task?.input_project_limits || '').toLowerCase();
  if (/(закон|лицензи|гарант|сертификат|гост|снип)/i.test(limits)) {
    if (level === 'low')    level = 'medium';
    else if (level === 'medium') level = 'high';
    reasons.push('regulatory keywords in project_limits');
  }

  return {
    level,                                // 'low' | 'medium' | 'high'
    trust_triggers: triggers.slice(0, 8),
    proof_required: level === 'high'
      ? ['автор-эксперт', 'источники с URL', 'цифры с подтверждением', 'дисклеймер']
      : level === 'medium'
        ? ['источники', 'кейсы или цифры']
        : ['как минимум один пример'],
    reasons,
  };
}

// ── 6. claims_to_prove (Модуль 2) ───────────────────────────────────
function deriveClaimsToProve({ stage0Result, task }) {
  // Источники: stage0.competitor_facts (числа, которые мы можем оспорить
  // или повторить) + stage0.trust_triggers (что нужно подтвердить, чтобы
  // вызвать доверие) + явные обещания из brand_facts (если есть числа/%).
  const out = [];

  for (const f of asArray(stage0Result?.competitor_facts)) {
    if (!nonEmptyString(f?.fact)) continue;
    if (!/\d/.test(f.fact)) continue; // только claims с числами
    out.push({
      claim:    f.fact.trim(),
      type:     'numeric-counter',
      source:   f.source_url || 'competitor',
      proof_required: 'нужен наш аналогичный показатель или дисклеймер',
    });
  }

  for (const t of asArray(stage0Result?.trust_triggers)) {
    if (!nonEmptyString(t?.trigger)) continue;
    out.push({
      claim:           t.trigger.trim(),
      type:            'trust-trigger',
      source:          'stage0',
      proof_required:  t.strength === 'strong' ? 'обязательно подтвердить' : 'желательно подтвердить',
    });
  }

  // Brand facts — выдёргиваем строки с цифрами/процентами.
  const bf = (task?.input_brand_facts || '').toString();
  if (bf) {
    const lines = bf.split(/\n|;|\.\s/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length < 8 || line.length > 200) continue;
      if (!/[\d%]/.test(line)) continue;
      out.push({
        claim:           line,
        type:            'brand-promise',
        source:          'task.input_brand_facts',
        proof_required:  'обязательно цифрами/датами/именем эксперта',
      });
    }
  }

  return clampArr(uniqueByKey(out, x => x.claim), MAX_CLAIMS);
}

// ── 7. jtbd_to_close (Модуль 2) ─────────────────────────────────────
function deriveJtbdToClose({ stage0Result, stage1Result }) {
  // Источники: stage1.user_questions (high priority в начало),
  //            stage1.pain_points,
  //            stage0.audience_pains,
  //            stage0.faq_bank.
  const out = [];

  const prio = (p) => (p === 'high' ? 0 : p === 'medium' ? 1 : 2);

  const uq = asArray(stage1Result?.user_questions)
    .filter(q => nonEmptyString(q?.question))
    .sort((a, b) => prio(a.priority) - prio(b.priority));
  for (const q of uq) {
    out.push({
      jtbd:           q.question.trim(),
      type:           'user-question',
      hint:           nonEmptyString(q.answer_hint) ? q.answer_hint.trim() : '',
      priority:       q.priority || 'medium',
    });
  }

  for (const p of asArray(stage1Result?.pain_points)) {
    if (!nonEmptyString(p?.pain)) continue;
    out.push({
      jtbd:     p.pain.trim(),
      type:     'pain-point',
      hint:     nonEmptyString(p.solution_angle) ? p.solution_angle.trim() : '',
      priority: 'high',
    });
  }

  for (const p of asArray(stage0Result?.audience_pains)) {
    if (!nonEmptyString(p?.pain)) continue;
    out.push({
      jtbd:     p.pain.trim(),
      type:     'audience-pain',
      hint:     nonEmptyString(p.solution_signal) ? p.solution_signal.trim() : '',
      priority: p.priority || 'medium',
    });
  }

  for (const q of asArray(stage0Result?.faq_bank)) {
    if (!nonEmptyString(q?.question)) continue;
    out.push({
      jtbd:     q.question.trim(),
      type:     'faq',
      hint:     nonEmptyString(q.answer) ? q.answer.toString().slice(0, 200) : '',
      priority: 'medium',
    });
  }

  return clampArr(uniqueByKey(out, x => x.jtbd), MAX_JTBD);
}

// ── Главная функция ─────────────────────────────────────────────────
/**
 * deriveModuleContext — собирает Module Context из существующих
 * результатов пайплайна. Без LLM. Без побочных эффектов.
 *
 * @param {object}  input
 * @param {object} [input.task]
 * @param {object} [input.stage0Result]
 * @param {object} [input.stage1Result] — enriched (после Stage 2)
 * @param {object} [input.stage2Result] — { taxonomy, stage2Raw, enrichedStage1 }
 * @param {object} [input.targetPageAnalysis]
 * @param {object} [input.strategyContext]
 * @returns {object} module_context
 */
function deriveModuleContext(input = {}) {
  const {
    task              = {},
    stage0Result      = null,
    stage1Result      = null,
    stage2Result      = null,
    targetPageAnalysis = null,
  } = input;

  const ctx = {
    schema_version: 1,
    generated_at:   new Date().toISOString(),

    // Module 1
    mandatory_entities:        deriveMandatoryEntities({ stage0Result, stage1Result }),
    avoid_ambiguous_terms:     deriveAvoidAmbiguous({ stage1Result }),
    audience_language_clusters: deriveAudienceLanguage({ stage1Result }),

    // Module 2
    format_wedge:    deriveFormatWedge({ stage1Result, stage2Result, task }),
    trust_complexity: deriveTrustComplexity({ stage0Result, targetPageAnalysis, task }),
    claims_to_prove: deriveClaimsToProve({ stage0Result, task }),
    jtbd_to_close:   deriveJtbdToClose({ stage0Result, stage1Result }),
  };

  // Сводка для логирования
  ctx._summary = {
    mandatory_entities_n:        ctx.mandatory_entities.length,
    avoid_ambiguous_terms_n:     ctx.avoid_ambiguous_terms.length,
    audience_language_clusters_n: ctx.audience_language_clusters.length,
    claims_to_prove_n:           ctx.claims_to_prove.length,
    jtbd_to_close_n:             ctx.jtbd_to_close.length,
    trust_level:                 ctx.trust_complexity.level,
    primary_format:              ctx.format_wedge.primary,
  };

  return ctx;
}

/**
 * formatModuleContextForAKB — компактное Markdown-представление
 * для §11 «Module Context» в ARTICLE_KNOWLEDGE_BASE.
 *
 * Целевой размер: ≤ 2 КБ. При переполнении выдаём только summary +
 * top-N пунктов, чтобы не раздуть AKB и не разогнать Gemini-токены.
 */
function formatModuleContextForAKB(ctx) {
  if (!ctx || typeof ctx !== 'object') return '_Module Context недоступен._';

  const lines = [];
  lines.push('Это детерминированный «контракт качества», собранный из Stage 0/1/2 без LLM.');
  lines.push('Используй как hard-constraints. НЕ выдумывай сущности вне списка mandatory_entities.');
  lines.push('Избегай терминов из avoid_ambiguous_terms без явного определения в тексте.');
  lines.push('');

  // Mandatory entities — компактный список
  if (ctx.mandatory_entities?.length) {
    const top = ctx.mandatory_entities.slice(0, 15)
      .map(e => `${e.entity}${e.type ? ` (${e.type})` : ''}`)
      .join(', ');
    lines.push(`**Обязательные сущности (top-15):** ${top}`);
  }

  // Avoid ambiguous
  if (ctx.avoid_ambiguous_terms?.length) {
    const av = ctx.avoid_ambiguous_terms.slice(0, 10).map(x => x.term).join(', ');
    lines.push(`**Избегать без определения:** ${av}`);
  }

  // Audience language
  if (ctx.audience_language_clusters?.length) {
    const ac = ctx.audience_language_clusters.slice(0, 6).map(c => {
      if (c.formal && c.colloquial) return `${c.formal} → ${c.colloquial}`;
      if (c.cluster && c.keywords?.length) return `${c.cluster}: ${c.keywords.slice(0, 4).join(', ')}`;
      return null;
    }).filter(Boolean).join(' | ');
    if (ac) lines.push(`**Язык аудитории:** ${ac}`);
  }

  // Format wedge
  if (ctx.format_wedge?.primary) {
    lines.push(`**Формат-клин (Format wedge):** ${ctx.format_wedge.primary}` +
               (ctx.format_wedge.priority_order?.length
                  ? ` (порядок: ${ctx.format_wedge.priority_order.slice(0, 3).join(' → ')})`
                  : ''));
  }

  // Trust complexity
  if (ctx.trust_complexity) {
    lines.push(`**Trust complexity:** ${ctx.trust_complexity.level}` +
               (ctx.trust_complexity.proof_required?.length
                  ? ` — доказать: ${ctx.trust_complexity.proof_required.join(', ')}`
                  : ''));
  }

  // Claims to prove (top-5)
  if (ctx.claims_to_prove?.length) {
    const top = ctx.claims_to_prove.slice(0, 5)
      .map((c, i) => `${i + 1}. «${c.claim}» — ${c.proof_required}`)
      .join('\n');
    lines.push(`**Утверждения, требующие доказательств (top-5):**\n${top}`);
  }

  // JTBD (top-5)
  if (ctx.jtbd_to_close?.length) {
    const top = ctx.jtbd_to_close.slice(0, 5)
      .map((j, i) => `${i + 1}. ${j.jtbd}`)
      .join('\n');
    lines.push(`**Задачи аудитории (JTBD top-5):**\n${top}`);
  }

  return lines.join('\n');
}

module.exports = {
  deriveModuleContext,
  formatModuleContextForAKB,
  // экспортируем для юнит-тестов
  _internal: {
    deriveMandatoryEntities,
    deriveAvoidAmbiguous,
    deriveAudienceLanguage,
    deriveFormatWedge,
    deriveTrustComplexity,
    deriveClaimsToProve,
    deriveJtbdToClose,
  },
};
