'use strict';

/**
 * linkArticleKnowledgeBase — LAKB.
 *
 * Аналог `utils/articleKnowledgeBase.js` (AKB), но для генератора ссылочной
 * статьи. Собирает короткий человеко- и LLM-читаемый «бриф» из всех
 * DeepSeek-аналитических стадий (Pre-Stage 0 / Stage 0 / Stage 1 / Stage 1B
 * white-space / Stage 2 структура) и предоставляет:
 *
 *   1. сам текст LAKB (≤ ~24 КБ) — для передачи в Gemini как
 *      `systemInstruction` или (опционально) как контент Gemini cachedContents
 *      API. Это ключевое требование задачи: «кэшировать анализы в дипсике
 *      и далее отправлять их в джемини» — кэшируем именно так.
 *
 *   2. helpers `lakbSystem(task)` / `lakbCallOpts(task, extra)` — по образцу
 *      `akbSystem` / `geminiCallOpts`. Если task.__geminiCacheName активен,
 *      lakbSystem возвращает '' (бриф уже в кэше), а cachedContent попадает
 *      в callLLM.opts через lakbCallOpts.
 *
 *   3. функции для построения «коротких указателей» в user-prompt'е
 *      (`pointerOrJson(label, fullJson, lakbReady)`) — заменяют толстые
 *      JSON-дампы на «[См. LAKB → §N]», когда LAKB активен.
 *
 * Утилита изолирована от основного `utils/articleKnowledgeBase.js` и не
 * меняет его поведение.
 */

const MAX_LAKB_CHARS = 24 * 1024;   // 24 КБ — fits под Gemini cachedContents min-token порог + наш типовой системный промпт.
const MAX_FIELD_LEN  = 1500;        // обрезка длинных JSON-блоков

// ── Helpers ──────────────────────────────────────────────────────────

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

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function bullet(items, max = 12) {
  return asArray(items).slice(0, max).map((s) => `  • ${clip(typeof s === 'string' ? s : safeJson(s), 280)}`).join('\n');
}

// ── Section builders ─────────────────────────────────────────────────

function sectionTask(task) {
  const lines = [
    '§1. ЗАДАЧА (входы пользователя)',
    `  • topic        : ${clip(task.topic, 280)}`,
    `  • anchor_text  : ${clip(task.anchor_text, 280)}`,
    `  • anchor_url   : ${clip(task.anchor_url, 500)}`,
    `  • focus_notes  : ${clip(task.focus_notes || '[не задано]', 600)}`,
    `  • output_format: ${task.output_format || 'html'}`,
  ];
  return lines.join('\n');
}

function sectionStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object') return '';
  const lines = ['§2. СТРАТЕГИЧЕСКИЙ КОНТЕКСТ (Pre-Stage 0)'];
  if (strategy.niche_summary) lines.push(`  niche_summary: ${clip(strategy.niche_summary, 600)}`);
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
  if (asArray(strategy.demand_signals).length) {
    lines.push('  demand_signals:');
    lines.push(bullet(strategy.demand_signals.map((d) =>
      `${d.query_class || '?'}: ${asArray(d.sample_queries).slice(0, 3).join(' / ')} → pain: ${d.user_pain || ''}`), 8));
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
      if (asArray(p.pains).length)         lines.push(`        pains: ${p.pains.slice(0, 4).join('; ')}`);
      if (asArray(p.motivations).length)   lines.push(`        motivations: ${p.motivations.slice(0, 4).join('; ')}`);
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
  const lines = ['§4. СУЩНОСТИ, ИНТЕНТЫ, ВОПРОСЫ (Stage 1)'];
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
    const top = intents.user_questions.slice(0, 16).map((q) =>
      `(${q.suggested_h2_or_h3 || '?'}|${q.answer_depth || '?'}) ${q.question || '?'}`);
    lines.push(bullet(top, 16));
  }
  if (asArray(intents.semantic_anchors).length) {
    lines.push(`  semantic_anchors: ${intents.semantic_anchors.slice(0, 16).join(' · ')}`);
  }
  return lines.join('\n');
}

function sectionWhitespace(ws) {
  if (!ws || typeof ws !== 'object') return '';
  const lines = ['§5. WHITE-SPACE АНАЛИЗ И ИЕРАРХИЯ-ХИНТЫ (Stage 1B)'];
  if (ws.executive_verdict) {
    const ev = ws.executive_verdict;
    lines.push(`  saturation=${ev.saturation_level || '?'} · entry_model=${ev.entry_model || '?'} · fits_new_site=${ev.fits_new_site}`);
    if (ev.main_gap_zone)     lines.push(`  main_gap_zone: ${clip(ev.main_gap_zone, 280)}`);
    if (ev.main_opportunity)  lines.push(`  main_opportunity: ${clip(ev.main_opportunity, 320)}`);
    if (ev.main_risk)         lines.push(`  main_risk: ${clip(ev.main_risk, 280)}`);
    if (ev.summary)           lines.push(`  verdict_summary: ${clip(ev.summary, 480)}`);
  }
  if (asArray(ws.topic_gaps).length) {
    lines.push('  topic_gaps (top):');
    lines.push(bullet(ws.topic_gaps.slice(0, 8).map((g) =>
      `${g.title || '?'} → ${g.intent || '?'} / ${g.best_page_type || '?'} (horizon=${g.horizon || '?'})`), 8));
  }
  if (asArray(ws.intent_gaps).length) {
    lines.push('  intent_gaps:');
    lines.push(bullet(ws.intent_gaps.slice(0, 5).map((g) =>
      `${g.uncovered_intent || '?'} — ${clip(g.better_match || '', 200)}`), 5));
  }
  if (asArray(ws.audience_gaps).length) {
    lines.push('  audience_gaps:');
    lines.push(bullet(ws.audience_gaps.slice(0, 5).map((g) =>
      `${g.audience || '?'} — ${clip(g.needed_content || '', 220)}`), 5));
  }
  if (asArray(ws.ai_search_gaps).length) {
    lines.push('  ai_search_gaps:');
    lines.push(bullet(ws.ai_search_gaps.slice(0, 4).map((g) =>
      `${g.opportunity || '?'} — ${clip(g.needed_format || '', 200)}`), 4));
  }
  // Главное для writer'a — article_hierarchy_hints
  const hh = ws.article_hierarchy_hints;
  if (hh && typeof hh === 'object') {
    lines.push('  ▶ ARTICLE_HIERARCHY_HINTS (обязательны к учёту):');
    if (asArray(hh.must_cover_subtopics).length) {
      lines.push(`    must_cover_subtopics: ${hh.must_cover_subtopics.slice(0, 12).join(' · ')}`);
    }
    if (asArray(hh.must_cover_intents).length) {
      lines.push(`    must_cover_intents:   ${hh.must_cover_intents.slice(0, 8).join(' · ')}`);
    }
    if (asArray(hh.must_cover_audiences).length) {
      lines.push(`    must_cover_audiences: ${hh.must_cover_audiences.slice(0, 6).join(' · ')}`);
    }
    if (asArray(hh.preferred_formats).length) {
      lines.push(`    preferred_formats:    ${hh.preferred_formats.slice(0, 6).join(' · ')}`);
    }
    if (asArray(hh.h2_ideas).length) {
      lines.push('    h2_ideas:');
      lines.push(bullet(hh.h2_ideas.slice(0, 10), 10));
    }
  }
  return lines.join('\n');
}

function sectionStructure(structure) {
  if (!structure || typeof structure !== 'object') return '';
  const lines = ['§6. СТРУКТУРА СТАТЬИ (Stage 2)'];
  if (structure.h1) lines.push(`  H1: ${clip(structure.h1, 200)}`);
  if (structure.intro_brief) lines.push(`  intro_brief: ${clip(structure.intro_brief, 400)}`);
  if (asArray(structure.sections).length) {
    lines.push('  sections:');
    for (const s of structure.sections.slice(0, 10)) {
      const flags = [];
      if (s.anchor_insertion) flags.push('ANCHOR');
      if (s.image_slot != null) flags.push(`IMG#${s.image_slot}`);
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
      lines.push(`    ${s.index || '?'}. ${s.h2 || '?'}${flagStr}`);
      if (s.descriptor) lines.push(`        – ${clip(s.descriptor, 240)}`);
      if (asArray(s.covers_user_questions).length) {
        lines.push(`        covers_q: ${s.covers_user_questions.slice(0, 5).join(' · ')}`);
      }
      if (asArray(s.covers_subtopics).length) {
        lines.push(`        covers_st: ${s.covers_subtopics.slice(0, 5).join(' · ')}`);
      }
      if (asArray(s.subsections).length) {
        for (const sub of s.subsections.slice(0, 4)) {
          lines.push(`        ↳ H3: ${sub.h3 || '?'} — ${clip(sub.descriptor || '', 200)}`);
        }
      }
    }
  }
  if (structure.anchor_plan) {
    const a = structure.anchor_plan;
    lines.push('  anchor_plan:');
    lines.push(`    anchor_text: ${clip(a.anchor_text, 200)}`);
    lines.push(`    anchor_url:  ${clip(a.anchor_url, 400)}`);
    lines.push(`    target_section_index: ${a.target_section_index}`);
    if (a.natural_context) lines.push(`    natural_context: ${clip(a.natural_context, 320)}`);
  }
  if (asArray(structure.image_plan).length) {
    lines.push('  image_plan:');
    for (const p of structure.image_plan.slice(0, 3)) {
      lines.push(`    slot ${p.slot} → section ${p.target_section_index}`);
      if (p.what_to_visualize) lines.push(`        what_to_visualize: ${clip(p.what_to_visualize, 240)}`);
      if (p.scene_concept)     lines.push(`        scene_concept:     ${clip(p.scene_concept, 280)}`);
      if (p.subject_focus)     lines.push(`        subject_focus:     ${clip(p.subject_focus, 200)}`);
    }
  }
  if (structure.conclusion_brief) lines.push(`  conclusion_brief: ${clip(structure.conclusion_brief, 320)}`);
  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * buildLinkArticleKnowledgeBase — собирает полный LAKB-текст.
 * Если итоговый текст превысит MAX_LAKB_CHARS — обрезается с пометкой.
 *
 * @param {object} args
 * @param {object} args.task       — строка из link_article_tasks
 * @param {object} [args.strategy] — Pre-Stage 0
 * @param {object} [args.audience] — Stage 0
 * @param {object} [args.intents]  — Stage 1
 * @param {object} [args.whitespace] — Stage 1B
 * @param {object} [args.structure]  — Stage 2 (опционально, может быть пустым,
 *                                     если вызов делается до Stage 2)
 * @returns {string}
 */
function buildLinkArticleKnowledgeBase({ task, strategy, audience, intents, whitespace, structure } = {}) {
  if (!task) return '';
  const header = [
    'LINK-ARTICLE KNOWLEDGE BASE (LAKB).',
    '',
    'Это свернутый аналитический контекст для написания ОДНОЙ ссылочной статьи.',
    'Он строится один раз после стадий DeepSeek-анализа и используется как',
    'systemInstruction для Gemini (через cachedContents API, если включён',
    'LINK_ARTICLE_GEMINI_CACHE_ENABLED). При написании секций Gemini обязан',
    'опираться на ВСЕ §1..§6 ниже как на «фон» статьи и не выходить за их',
    'рамки. ЗАПРЕЩЕНО выдумывать факты, бренды, статистику, цитаты.',
    '',
  ].join('\n');

  const parts = [
    sectionTask(task),
    sectionStrategy(strategy),
    sectionAudience(audience),
    sectionIntents(intents),
    sectionWhitespace(whitespace),
    sectionStructure(structure),
  ].filter(Boolean);

  let text = header + parts.join('\n\n');
  if (text.length > MAX_LAKB_CHARS) {
    text = `${text.slice(0, MAX_LAKB_CHARS - 80)}\n\n…[LAKB truncated to ${MAX_LAKB_CHARS} chars]`;
  }
  return text;
}

/**
 * lakbSystem — возвращает строку для positional `system` аргумента callLLM.
 * Если активен Gemini cachedContent (task.__geminiCacheName) — возвращает ''
 * (LAKB уже в кэше). В противном случае — сам LAKB как fallback.
 */
function lakbSystem(task) {
  if (!task) return '';
  if (task.__geminiCacheName) return '';
  return task.__lakb || '';
}

/**
 * lakbCallOpts — extra-opts для callLLM при вызове Gemini Stage 3:
 *   - cachedContent — если task.__geminiCacheName есть;
 *   - onCacheMiss — обнуляет имя кэша на task при HTTP 404.
 */
function lakbCallOpts(task, extra = {}) {
  const opts = { ...extra };
  if (task?.__geminiCacheName) {
    opts.cachedContent = task.__geminiCacheName;
    opts.onCacheMiss = () => { task.__geminiCacheName = null; };
  }
  return opts;
}

/**
 * pointer — короткая ссылка на раздел LAKB. Используется в user-prompt'е
 * вместо полного JSON-блока, если LAKB активен.
 */
function pointer(label) {
  return `[См. LAKB → ${label}]`;
}

/**
 * pointerOrJson — если LAKB активен, возвращает короткий указатель.
 * Иначе — полный JSON (обрезанный до maxLen).
 */
function pointerOrJson(label, fullJson, lakbReady, maxLen = 6000) {
  if (lakbReady) return pointer(label);
  try {
    return JSON.stringify(fullJson || {}).slice(0, maxLen);
  } catch (_) {
    return '{}';
  }
}

module.exports = {
  buildLinkArticleKnowledgeBase,
  lakbSystem,
  lakbCallOpts,
  pointer,
  pointerOrJson,
  MAX_LAKB_CHARS,
};
