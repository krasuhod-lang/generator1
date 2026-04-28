'use strict';

/**
 * infoArticleKnowledgeBase — IAKB (аналог LAKB для генератора инфо-статьи).
 *
 * Собирает компактный «бриф» из всех DeepSeek-аналитических стадий
 * (Pre-Stage 0 / Stage 0 / Stage 1 / Stage 1B / Stage 2 / LSI / link_plan)
 * и предоставляет:
 *   1) текст IAKB (≤ MAX_IAKB_CHARS) — для передачи в Gemini как
 *      systemInstruction либо контент Gemini cachedContents;
 *   2) helpers `iakbSystem(task)` / `iakbCallOpts(task, extra)` — по образцу
 *      `lakbSystem` / `lakbCallOpts` из linkArticleKnowledgeBase.js;
 *   3) `pointerOrJson(label, fullJson, iakbReady)` — короткие указатели
 *      "[См. IAKB → §N]" в user-prompt'ах при активном кэше.
 */

const MAX_IAKB_CHARS = 28 * 1024;
const MAX_FIELD_LEN  = 1500;

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return '{}';
  }
}
function clip(text, max = MAX_FIELD_LEN) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
function asArray(v) { return Array.isArray(v) ? v : []; }
function bullet(items, max = 12) {
  return asArray(items).slice(0, max)
    .map((s) => `  • ${clip(typeof s === 'string' ? s : safeJson(s), 320)}`)
    .join('\n');
}

// ── Section builders ─────────────────────────────────────────────────

function sectionTask(task) {
  const links = asArray(task.commercial_links);
  return [
    '§1. ЗАДАЧА (входы пользователя)',
    `  • topic         : ${clip(task.topic, 280)}`,
    `  • region        : ${clip(task.region || '[не задано]', 200)}`,
    `  • brand_name    : ${clip(task.brand_name || '[авто]', 200)}`,
    `  • author_name   : ${clip(task.author_name || '[авто]', 200)}`,
    `  • output_format : ${task.output_format || 'html'}`,
    `  • commercial_links_count : ${links.length}`,
    `  • brand_facts   : ${clip(task.brand_facts || '[не задано]', 800)}`,
  ].join('\n');
}

function sectionStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object') return '';
  const lines = ['§2. СТРАТЕГИЧЕСКИЙ КОНТЕКСТ (Pre-Stage 0)'];
  if (strategy.niche_summary)        lines.push(`  niche_summary: ${clip(strategy.niche_summary, 600)}`);
  if (strategy.article_type_hint)    lines.push(`  article_type_hint: ${strategy.article_type_hint}`);
  if (strategy.inferred_brand_role)  lines.push(`  inferred_brand_role: ${clip(strategy.inferred_brand_role, 200)}`);
  if (strategy.default_brand_name)   lines.push(`  default_brand_name: ${clip(strategy.default_brand_name, 120)}`);
  if (strategy.default_author_persona) lines.push(`  default_author_persona: ${clip(strategy.default_author_persona, 240)}`);
  if (asArray(strategy.audience_clusters).length) {
    lines.push('  audience_clusters:');
    lines.push(bullet(strategy.audience_clusters.map((c) =>
      `${c.name || '?'} (${c.intent_bias || '?'}) — pains: ${asArray(c.pains).slice(0, 3).join('; ')}`), 6));
  }
  if (asArray(strategy.topical_opportunities).length) {
    lines.push('  topical_opportunities:');
    lines.push(bullet(strategy.topical_opportunities.map((o) =>
      `[${o.priority || '?'}] ${o.angle || '?'} — ${o.why_relevant || ''}`), 8));
  }
  return lines.join('\n');
}

function sectionAudience(audience) {
  if (!audience || typeof audience !== 'object') return '';
  const lines = ['§3. АУДИТОРИЯ И ТОН (Stage 0)'];
  if (asArray(audience.audience_personas).length) {
    lines.push('  personas:');
    for (const p of audience.audience_personas.slice(0, 4)) {
      lines.push(`    – ${p.name || '?'} (${p.reading_level || '?'}): ${clip(p.context || '', 280)}`);
      if (asArray(p.pains).length)       lines.push(`        pains: ${p.pains.slice(0, 4).join('; ')}`);
      if (asArray(p.motivations).length) lines.push(`        motivations: ${p.motivations.slice(0, 4).join('; ')}`);
    }
  }
  if (audience.tone_of_voice) {
    const tov = audience.tone_of_voice;
    lines.push(`  tone: register=${tov.register || '?'}, sentence_length=${tov.sentence_length || '?'}`);
    if (asArray(tov.do_use).length) lines.push(`        do_use: ${tov.do_use.slice(0, 6).join(', ')}`);
    if (asArray(tov.avoid).length)  lines.push(`        avoid : ${tov.avoid.slice(0, 6).join(', ')}`);
  }
  if (asArray(audience.pain_points).length) {
    lines.push('  pain_points:');
    lines.push(bullet(audience.pain_points, 8));
  }
  if (audience.content_voice) lines.push(`  content_voice: ${clip(audience.content_voice, 320)}`);
  return lines.join('\n');
}

function sectionIntents(intents) {
  if (!intents || typeof intents !== 'object') return '';
  const lines = ['§4. СУЩНОСТИ, ИНТЕНТЫ, ВОПРОСЫ, JTBD (Stage 1)'];
  if (asArray(intents.entities).length) {
    lines.push('  entities (high+medium):');
    const top = intents.entities
      .filter((e) => e && e.importance !== 'low')
      .slice(0, 16)
      .map((e) => `${e.entity || '?'} [${e.type || '?'}] — ${clip(e.description || '', 160)}`);
    lines.push(bullet(top, 16));
  }
  if (asArray(intents.subintents).length) {
    lines.push('  subintents (must+should):');
    const top = intents.subintents
      .filter((s) => s && s.priority !== 'nice')
      .slice(0, 10)
      .map((s) => `[${s.priority || '?'}|${s.type || '?'}] ${s.intent || '?'} → ${s.user_goal || ''}`);
    lines.push(bullet(top, 10));
  }
  if (asArray(intents.user_questions).length) {
    lines.push('  user_questions (обязательные к покрытию):');
    lines.push(bullet(intents.user_questions.slice(0, 16).map((q) =>
      `(${q.suggested_h2_or_h3 || '?'}|${q.answer_depth || '?'}) ${q.question || '?'}`), 16));
  }
  if (asArray(intents.jtbd_clusters).length) {
    lines.push('  jtbd_clusters:');
    lines.push(bullet(intents.jtbd_clusters.map((c) => `${c.cluster}: ${c.description || ''}`), 8));
  }
  if (asArray(intents.semantic_anchors).length) {
    lines.push(`  semantic_anchors: ${intents.semantic_anchors.slice(0, 16).join(' · ')}`);
  }
  return lines.join('\n');
}

function sectionWhitespace(ws) {
  if (!ws || typeof ws !== 'object') return '';
  const lines = ['§5. WHITE-SPACE / HIERARCHY HINTS (Stage 1B)'];
  if (ws.executive_verdict) {
    const ev = ws.executive_verdict;
    lines.push(`  saturation=${ev.saturation_level || '?'}`);
    if (ev.main_gap_zone)    lines.push(`  main_gap_zone:    ${clip(ev.main_gap_zone, 280)}`);
    if (ev.main_opportunity) lines.push(`  main_opportunity: ${clip(ev.main_opportunity, 320)}`);
    if (ev.main_risk)        lines.push(`  main_risk:        ${clip(ev.main_risk, 280)}`);
    if (ev.summary)          lines.push(`  summary: ${clip(ev.summary, 480)}`);
  }
  const hh = ws.article_hierarchy_hints;
  if (hh && typeof hh === 'object') {
    lines.push('  ▶ article_hierarchy_hints:');
    if (asArray(hh.must_cover_subtopics).length)
      lines.push(`    must_cover_subtopics: ${hh.must_cover_subtopics.slice(0, 12).join(' · ')}`);
    if (asArray(hh.must_cover_intents).length)
      lines.push(`    must_cover_intents:   ${hh.must_cover_intents.slice(0, 8).join(' · ')}`);
    if (asArray(hh.must_cover_audiences).length)
      lines.push(`    must_cover_audiences: ${hh.must_cover_audiences.slice(0, 6).join(' · ')}`);
    if (asArray(hh.preferred_formats).length)
      lines.push(`    preferred_formats:    ${hh.preferred_formats.slice(0, 6).join(' · ')}`);
    if (asArray(hh.h2_ideas).length) {
      lines.push('    h2_ideas:');
      lines.push(bullet(hh.h2_ideas.slice(0, 10), 10));
    }
  }
  return lines.join('\n');
}

function sectionOutline(outline) {
  if (!outline || typeof outline !== 'object') return '';
  const lines = ['§6. СТРУКТУРА СТАТЬИ (Stage 2)'];
  if (outline.h1) lines.push(`  H1: ${clip(outline.h1, 200)}`);
  if (outline.intro_brief) lines.push(`  intro_brief: ${clip(outline.intro_brief, 400)}`);
  if (asArray(outline.sections).length) {
    lines.push('  sections:');
    for (const s of outline.sections.slice(0, 12)) {
      const flags = [];
      if (s.image_slot != null) flags.push(`IMG#${s.image_slot}`);
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
      lines.push(`    ${s.index || '?'}. ${s.h2 || '?'}${flagStr}`);
      if (s.descriptor)   lines.push(`        – ${clip(s.descriptor, 240)}`);
      if (s.jtbd_cluster) lines.push(`        jtbd: ${s.jtbd_cluster}`);
      if (s.derived_from && typeof s.derived_from === 'object') {
        const df = s.derived_from;
        if (asArray(df.entities).length)
          lines.push(`        derived.entities:   ${df.entities.slice(0, 5).join(' · ')}`);
        if (asArray(df.subintents).length)
          lines.push(`        derived.subintents: ${df.subintents.slice(0, 4).join(' · ')}`);
        if (asArray(df.questions).length)
          lines.push(`        derived.questions:  ${df.questions.slice(0, 4).join(' · ')}`);
      }
      if (asArray(s.lsi_focus).length)
        lines.push(`        lsi_focus: ${s.lsi_focus.slice(0, 6).join(' · ')}`);
      if (asArray(s.covers_user_questions).length)
        lines.push(`        covers_q: ${s.covers_user_questions.slice(0, 5).join(' · ')}`);
      if (asArray(s.subsections).length) {
        for (const sub of s.subsections.slice(0, 4)) {
          lines.push(`        ↳ H3: ${sub.h3 || '?'} — ${clip(sub.descriptor || '', 200)}`);
        }
      }
    }
  }
  if (asArray(outline.image_plan).length) {
    lines.push('  image_plan:');
    for (const p of outline.image_plan.slice(0, 3)) {
      lines.push(`    slot ${p.slot} → section ${p.target_section_index}`);
      if (p.scene_concept)  lines.push(`        scene_concept: ${clip(p.scene_concept, 280)}`);
      if (p.subject_focus)  lines.push(`        subject_focus: ${clip(p.subject_focus, 200)}`);
    }
  }
  // Mandatory expert opinion plan (Stage 2 outline.expert_opinion_slot).
  // Writer обязан вставить ровно 1 <blockquote class="expert-opinion"> в указанной секции.
  const eo = outline.expert_opinion_slot;
  if (eo && typeof eo === 'object') {
    lines.push('  expert_opinion_slot (ОБЯЗАТЕЛЬНО, ровно 1 <blockquote class="expert-opinion">):');
    lines.push(`    target_section_index: ${eo.target_section_index ?? '?'}`);
    if (eo.expert_role)  lines.push(`    expert_role:          ${clip(eo.expert_role, 200)}`);
    if (eo.focus)        lines.push(`    focus:                ${clip(eo.focus, 240)}`);
    if (eo.key_insight)  lines.push(`    key_insight:          ${clip(eo.key_insight, 360)}`);
    if (asArray(eo.tied_to_entities).length)
      lines.push(`    tied_to_entities:     ${eo.tied_to_entities.slice(0, 6).join(' · ')}`);
  }
  // Mandatory FAQ block (Stage 2 outline.faq_block).
  // Writer обязан отрендерить <h2>Часто задаваемые вопросы</h2> + 4–6 <h3>/<p> пар
  // ПЕРЕД секцией «Заключение».
  const fb = outline.faq_block;
  if (fb && typeof fb === 'object' && asArray(fb.items).length) {
    lines.push('  faq_block (ОБЯЗАТЕЛЬНО, перед «Заключением»):');
    lines.push(`    place_after_section_index: ${fb.place_after_section_index ?? '?'}`);
    lines.push(`    items (${fb.items.length}):`);
    for (const it of fb.items.slice(0, 6)) {
      lines.push(`      • Q: ${clip(it.question || '', 220)}`);
      if (it.answer_brief) lines.push(`        A_brief: ${clip(it.answer_brief, 280)}`);
      if (asArray(it.tied_to_entities).length)
        lines.push(`        tied_to_entities: ${it.tied_to_entities.slice(0, 5).join(' · ')}`);
    }
  }
  if (outline.conclusion_brief) lines.push(`  conclusion_brief: ${clip(outline.conclusion_brief, 320)}`);
  return lines.join('\n');
}

function sectionLsi(lsi) {
  if (!lsi || typeof lsi !== 'object') return '';
  const lines = ['§7. LSI-НАБОР (Stage 2B)'];
  if (asArray(lsi.important).length)  lines.push(`  important (обязательны): ${lsi.important.slice(0, 30).join(' · ')}`);
  if (asArray(lsi.supporting).length) lines.push(`  supporting (желательны): ${lsi.supporting.slice(0, 30).join(' · ')}`);
  if (asArray(lsi.banned).length)     lines.push(`  banned (запрещены):      ${lsi.banned.slice(0, 15).join(' · ')}`);
  return lines.join('\n');
}

function sectionLinkPlan(linkPlan) {
  if (!Array.isArray(linkPlan) || !linkPlan.length) return '';
  const lines = ['§8. ПЛАН ПЕРЕЛИНКОВКИ (Stage 2C)'];
  for (const p of linkPlan) {
    lines.push(`  H2 #${p.h2_index} «${clip(p.h2_text, 120)}»`);
    for (const pick of asArray(p.picks).slice(0, 2)) {
      lines.push(`    [${pick.role || 'primary'}] anchor="${clip(pick.anchor_text, 80)}" → ${clip(pick.url, 200)}`);
      if (pick.reason) lines.push(`        reason: ${clip(pick.reason, 240)}`);
    }
  }
  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────

function buildInfoArticleKnowledgeBase({
  task, strategy, audience, intents, whitespace, outline, lsi, linkPlan,
} = {}) {
  if (!task) return '';
  const header = [
    'INFO-ARTICLE KNOWLEDGE BASE (IAKB).',
    '',
    'Свернутый аналитический контекст для ОДНОЙ информационной статьи в блог.',
    'Строится один раз после стадий DeepSeek-анализа и используется как',
    'systemInstruction для Gemini (через cachedContents API, если включён',
    'INFO_ARTICLE_GEMINI_CACHE_ENABLED). Gemini обязан опираться на §1..§8',
    'как на «фон» статьи и не выходить за их рамки. ЗАПРЕЩЕНО выдумывать',
    'факты, бренды, статистику, цитаты, ссылки.',
    '',
  ].join('\n');

  const parts = [
    sectionTask(task),
    sectionStrategy(strategy),
    sectionAudience(audience),
    sectionIntents(intents),
    sectionWhitespace(whitespace),
    sectionOutline(outline),
    sectionLsi(lsi),
    sectionLinkPlan(linkPlan),
  ].filter(Boolean);

  let text = header + parts.join('\n\n');
  if (text.length > MAX_IAKB_CHARS) {
    text = `${text.slice(0, MAX_IAKB_CHARS - 80)}\n\n…[IAKB truncated to ${MAX_IAKB_CHARS} chars]`;
  }
  return text;
}

function iakbSystem(task) {
  if (!task) return '';
  if (task.__geminiCacheName) return '';
  return task.__iakb || '';
}

function iakbCallOpts(task, extra = {}) {
  const opts = { ...extra };
  if (task?.__geminiCacheName) {
    opts.cachedContent = task.__geminiCacheName;
    opts.onCacheMiss = () => { task.__geminiCacheName = null; };
  }
  return opts;
}

function pointer(label) {
  return `[См. IAKB → ${label}]`;
}

function pointerOrJson(label, fullJson, iakbReady, maxLen = 6000) {
  if (iakbReady) return pointer(label);
  try {
    return JSON.stringify(fullJson || {}).slice(0, maxLen);
  } catch (_) {
    return '{}';
  }
}

module.exports = {
  buildInfoArticleKnowledgeBase,
  iakbSystem,
  iakbCallOpts,
  pointer,
  pointerOrJson,
  MAX_IAKB_CHARS,
};
