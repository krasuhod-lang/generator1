'use strict';

/**
 * imageQualityGate — обязательный gate по изображениям перед финализацией
 * статьи. Агрегирует технический QA (imageQa.service), семантический QA
 * (semanticImageQa.service) и storage-статус слотов в единый вердикт.
 *
 * Вердикты:
 *   • pass    — можно финализировать
 *   • review  — финализировать можно, но помечаем на ручной обзор
 *   • fail    — блокирует финализацию
 *
 * Правила блокировки (ТЗ «Quality Gates»):
 *   статья блокируется (fail), если:
 *     - cover image = fail (техн. или семантич.);
 *     - более половины inline images = fail;
 *     - отсутствует alt_ru у сгенерированного слота;
 *     - production mode required, но image_url не получен;
 *     - semantic generic_score выше порога (учтено в semanticQa verdict);
 *     - слот с image_intent=do_not_generate всё же был сгенерирован.
 *   review, если:
 *     - хотя бы одно изображение = review;
 *     - низкая полезность/композиционная вариативность (из semanticQa).
 *
 * Никогда не бросает. Уважает fallback-режим semantic QA (warn_only):
 * при warn_only семантические fail понижаются до review и не блокируют.
 */

function _slots(imagePrompts) {
  return Array.isArray(imagePrompts) ? imagePrompts : [];
}

/**
 * evaluateImageGate — главный вход.
 *
 * @param {object} input
 * @param {Array}  input.imagePrompts   — слоты (с storage-полями)
 * @param {object} [input.technicalQa]  — результат runImageQa
 * @param {object} [input.semanticQa]   — результат runSemanticImageQa
 * @param {object} [input.config]       — { requireProductionUrl, semanticQaFallback, storageMode }
 * @returns {object} { verdict, canFinalize, blockers[], warnings[], summary }
 */
function evaluateImageGate(input = {}) {
  try {
    const slots = _slots(input.imagePrompts);
    const cfg = input.config || {};
    const requireUrl = Boolean(cfg.requireProductionUrl);
    const semanticFallback = cfg.semanticQaFallback || 'warn_only';

    const blockers = [];
    const warnings = [];

    const generated = slots.filter((s) => s && s.status === 'done' && s.image_base64);

    // ── 1) Слоты do_not_generate, которые всё же сгенерированы. ─────────
    for (const s of generated) {
      if (String(s.image_intent) === 'do_not_generate') {
        blockers.push(`slot ${s.slot}: image_intent=do_not_generate, но слот сгенерирован`);
      }
    }

    // ── 2) alt_ru обязателен у каждого сгенерированного слота. ──────────
    for (const s of generated) {
      if (!s.alt_ru || !String(s.alt_ru).trim()) {
        blockers.push(`slot ${s.slot}: отсутствует alt_ru`);
      }
    }

    // ── 3) production URL, если требуется. ─────────────────────────────
    if (requireUrl) {
      for (const s of generated) {
        if (!s.image_url) {
          blockers.push(`slot ${s.slot}: production mode требует image_url, но он не получен`);
        }
      }
    }

    // ── 4) Технический QA cover/inline. ────────────────────────────────
    const techSlots = input.technicalQa && Array.isArray(input.technicalQa.slots)
      ? input.technicalQa.slots : [];
    const techVerdict = (slotNo) => {
      const r = techSlots.find((t) => t.slot === slotNo);
      if (!r) return 'na';
      return r.issues.some((it) => it.level === 'error') ? 'fail' : 'pass';
    };

    // ── 5) Семантический QA cover/inline. ──────────────────────────────
    const semSlots = input.semanticQa && Array.isArray(input.semanticQa.slots)
      ? input.semanticQa.slots : [];
    const semVerdict = (slotNo) => {
      const r = semSlots.find((t) => t.slot === slotNo);
      return r ? r.verdict : 'na';
    };

    const isHardSemantic = semanticFallback === 'hard_fail';

    const inlineGenerated = generated.filter((s) => (s.slot || 1) !== 1);
    let inlineFails = 0;

    for (const s of generated) {
      const slotNo = s.slot || 1;
      const isCover = slotNo === 1;
      const tv = techVerdict(slotNo);
      const sv = semVerdict(slotNo);

      const techFail = tv === 'fail';
      const semFail = sv === 'fail';
      const semReview = sv === 'review';

      // Технический fail — всегда жёсткий.
      if (isCover && techFail) {
        blockers.push(`cover (slot 1): технический QA = fail`);
      }
      // Семантический fail: блокирует только в hard_fail, иначе → review.
      if (isCover && semFail) {
        if (isHardSemantic) blockers.push(`cover (slot 1): семантический QA = fail`);
        else warnings.push(`cover (slot 1): семантический QA = fail (fallback warn_only → review)`);
      }
      if (!isCover && (techFail || (semFail && isHardSemantic))) {
        inlineFails += 1;
      }
      if (semReview) {
        warnings.push(`slot ${slotNo}: семантический QA = review`);
      }
      if (!isCover && semFail && !isHardSemantic) {
        warnings.push(`slot ${slotNo}: семантический QA = fail (warn_only)`);
      }
    }

    if (inlineGenerated.length > 0 && inlineFails > inlineGenerated.length / 2) {
      blockers.push(`более половины inline-изображений = fail (${inlineFails}/${inlineGenerated.length})`);
    }

    // ── Вердикт. ────────────────────────────────────────────────────────
    let verdict;
    if (blockers.length > 0) verdict = 'fail';
    else if (warnings.length > 0) verdict = 'review';
    else if (generated.length === 0) verdict = 'na';
    else verdict = 'pass';

    return {
      verdict,
      canFinalize: verdict !== 'fail',
      blockers: Array.from(new Set(blockers)),
      warnings: Array.from(new Set(warnings)),
      summary: {
        generatedSlots: generated.length,
        inlineGenerated: inlineGenerated.length,
        inlineFails,
        requireProductionUrl: requireUrl,
        semanticQaFallback: semanticFallback,
        technicalVerdict: input.technicalQa && input.technicalQa.summary
          ? input.technicalQa.summary.verdict : 'na',
        semanticVerdict: input.semanticQa && input.semanticQa.summary
          ? input.semanticQa.summary.verdict : 'na',
      },
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      verdict: 'na',
      canFinalize: true, // fail-open: gate не должен ронять финализацию
      blockers: [],
      warnings: [`image-gate error: ${String(err && err.message || err)}`],
      summary: { error: String(err && err.message || err) },
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = { evaluateImageGate };
