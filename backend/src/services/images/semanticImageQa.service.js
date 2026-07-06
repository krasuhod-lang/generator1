'use strict';

/**
 * semanticImageQa.service — семантический QA изображений: проверяет не
 * технику файла (это делает imageQa.service), а СМЫСЛОВУЮ пригодность
 * картинки для блока статьи.
 *
 * Ограничение среды: у нас нет vision-модели, поэтому оценка строится
 * детерминированно по доступным сигналам слота — scene_json (что мы
 * заказывали), visual_prompt / negative_prompt (как заказывали),
 * alt_ru / caption_ru (как описываем) и метаданным intent/generic_risk.
 * Это надёжный, воспроизводимый прокси «насколько заявка на картинку
 * grounded и не-generic». При появлении vision-модели скоринг можно
 * заменить, сохранив контракт.
 *
 * Критерии (0..1, см. ТЗ §4):
 *   relevance_score · usefulness_score · generic_score ·
 *   editorial_fit_score · composition_diversity_score ·
 *   text_in_image_risk · scene_fidelity_score
 *
 * Вердикты per-slot: pass | review | fail.
 * Гарантия: runSemanticImageQa НИКОГДА не бросает.
 */

const { canon, tokenize } = require('./textSignals');

function _tokenSet(...parts) {
  const set = new Set();
  for (const p of parts) {
    for (const w of tokenize(p)) set.add(w);
  }
  return set;
}

function _overlap(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter += 1;
  return inter / aSet.size;
}

function _round(x) {
  return Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
}

// Насколько intent «объяснительный» (высокая полезность).
const INTENT_USEFULNESS = {
  cover: 0.6,
  explainer_scene: 0.9,
  step_by_step: 0.95,
  comparison_scene: 0.9,
  object_visual: 0.75,
  trust_visual: 0.7,
  context_of_use: 0.8,
  do_not_generate: 0.0,
};

const GENERIC_BY_RISK = { low: 0.2, medium: 0.5, high: 0.8 };

/**
 * scoreSlot — детерминированный per-slot скоринг.
 * neighbors — массив уже посчитанных отчётов (для composition diversity).
 */
function scoreSlot(slot, neighbors, opts) {
  const scene = slot.scene_json || {};
  const intent = String(slot.image_intent || scene.image_intent || 'explainer_scene');
  const sectionTokens = _tokenSet(slot.section_h2, scene.subject);
  const promptTokens = _tokenSet(slot.visual_prompt, slot.alt_ru, slot.caption_ru);
  const sceneTokens = _tokenSet(
    scene.subject,
    (scene.objects || []).join(' '),
    (scene.must_include || []).join(' '),
    (scene.factual_anchors || []).join(' '),
  );

  // relevance: пересечение сути блока с описанием картинки.
  const relevance = sectionTokens.size
    ? _overlap(sectionTokens, promptTokens)
    : (promptTokens.size ? 0.5 : 0);

  // scene_fidelity: перенёс ли композер сцену в промпт.
  const sceneFidelity = sceneTokens.size ? _overlap(sceneTokens, promptTokens) : 0.5;

  // usefulness: базово от intent, штраф за generic_risk=high.
  const risk = String(scene.generic_risk || 'medium');
  let usefulness = INTENT_USEFULNESS[intent] != null ? INTENT_USEFULNESS[intent] : 0.6;
  if (risk === 'high') usefulness -= 0.25;
  else if (risk === 'low') usefulness += 0.05;

  // generic_score: чем выше — тем шаблоннее (плохо).
  let generic = GENERIC_BY_RISK[risk] != null ? GENERIC_BY_RISK[risk] : 0.5;
  const anchorsN = (scene.factual_anchors || []).length + (scene.objects || []).length;
  if (anchorsN >= 4) generic -= 0.15;
  if (scene.fallback_used) generic += 0.15;

  // editorial_fit: сильный негатив + editorial style → выше.
  const neg = canon(slot.negative_prompt || '');
  let editorialFit = 0.6;
  if (neg.includes('no glossy generic stock')) editorialFit += 0.15;
  if (neg.includes('no text overlays')) editorialFit += 0.1;
  if (canon(slot.style_label || '').includes('editorial')) editorialFit += 0.1;

  // text_in_image_risk: низкий, если явно запретили текст на картинке.
  let textRisk = 0.5;
  if (neg.includes('no text overlays') || neg.includes('no captions')) textRisk = 0.15;

  // composition_diversity: штраф, если соседний слот с той же композицией.
  const comp = canon(scene.composition || '');
  let diversity = 1;
  if (comp) {
    const same = neighbors.filter((n) => canon((n.scene_json || {}).composition || '') === comp).length;
    if (same >= 1) diversity = same >= 2 ? 0.4 : 0.7;
  }

  const scores = {
    relevance_score: _round(relevance),
    usefulness_score: _round(usefulness),
    generic_score: _round(generic),
    editorial_fit_score: _round(editorialFit),
    composition_diversity_score: _round(diversity),
    text_in_image_risk: _round(textRisk),
    scene_fidelity_score: _round(sceneFidelity),
  };

  // ── Вердикт. ────────────────────────────────────────────────────────
  const genericThreshold = Number.isFinite(opts.genericScoreThreshold)
    ? opts.genericScoreThreshold : 0.65;
  const relevanceFloor = Number.isFinite(opts.relevanceFloor) ? opts.relevanceFloor : 0.2;

  const issues = [];
  let verdict = 'pass';

  if (scores.relevance_score < relevanceFloor) {
    issues.push({ code: 'low_relevance', level: 'error',
      message: `relevance=${scores.relevance_score} < ${relevanceFloor}` });
    verdict = 'fail';
  }
  if (scores.generic_score > genericThreshold) {
    issues.push({ code: 'too_generic', level: 'error',
      message: `generic=${scores.generic_score} > ${genericThreshold}` });
    verdict = 'fail';
  }
  if (verdict !== 'fail') {
    if (scores.usefulness_score < 0.5) {
      issues.push({ code: 'low_usefulness', level: 'warn',
        message: `usefulness=${scores.usefulness_score} < 0.5` });
      verdict = 'review';
    }
    if (scores.composition_diversity_score < 0.5) {
      issues.push({ code: 'low_composition_diversity', level: 'warn',
        message: `composition повторяется у соседних слотов` });
      verdict = 'review';
    }
    if (scores.scene_fidelity_score < 0.3) {
      issues.push({ code: 'low_scene_fidelity', level: 'warn',
        message: `scene_fidelity=${scores.scene_fidelity_score} — промпт слабо отражает сцену` });
      verdict = 'review';
    }
  }

  return {
    slot: Number(slot.slot) || 0,
    section_h2: String(slot.section_h2 || ''),
    image_intent: intent,
    verdict,
    scores,
    issues,
  };
}

/**
 * runSemanticImageQa — фасад. Принимает массив image_prompts (слоты) и
 * опции (thresholds). Возвращает { summary, slots, generated_at }.
 * Никогда не бросает.
 */
function runSemanticImageQa(imagePrompts, opts = {}) {
  try {
    const list = Array.isArray(imagePrompts) ? imagePrompts : [];
    // Оцениваем только реально сгенерированные слоты.
    const done = list.filter((p) => p && p.status === 'done' && p.image_base64);
    const reports = [];
    for (const slot of done) {
      reports.push(scoreSlot(slot, done.filter((d) => d !== slot), opts));
    }

    const total = reports.length;
    const cover = reports.find((r) => r.slot === 1);
    const inline = reports.filter((r) => r.slot !== 1);
    const inlineFails = inline.filter((r) => r.verdict === 'fail').length;
    const anyReview = reports.some((r) => r.verdict === 'review');
    const coverFail = Boolean(cover && cover.verdict === 'fail');

    let verdict;
    if (total === 0) verdict = 'na';
    else if (coverFail || (inline.length > 0 && inlineFails > inline.length / 2)) verdict = 'fail';
    else if (anyReview || reports.some((r) => r.verdict === 'fail')) verdict = 'review';
    else verdict = 'pass';

    const avg = (key) => (total
      ? _round(reports.reduce((s, r) => s + (r.scores[key] || 0), 0) / total)
      : 0);

    return {
      summary: {
        totalSlots: total,
        passSlots: reports.filter((r) => r.verdict === 'pass').length,
        reviewSlots: reports.filter((r) => r.verdict === 'review').length,
        failSlots: reports.filter((r) => r.verdict === 'fail').length,
        coverVerdict: cover ? cover.verdict : 'na',
        inlineFails,
        inlineTotal: inline.length,
        avg: {
          relevance_score: avg('relevance_score'),
          usefulness_score: avg('usefulness_score'),
          generic_score: avg('generic_score'),
          scene_fidelity_score: avg('scene_fidelity_score'),
        },
        verdict,
      },
      slots: reports,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      summary: {
        totalSlots: 0, passSlots: 0, reviewSlots: 0, failSlots: 0,
        coverVerdict: 'na', inlineFails: 0, inlineTotal: 0, avg: {},
        verdict: 'na', error: String(err && err.message || err),
      },
      slots: [],
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = {
  runSemanticImageQa,
  scoreSlot,
  INTENT_USEFULNESS,
  GENERIC_BY_RISK,
};
