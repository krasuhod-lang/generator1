'use strict';

/**
 * imagePromptComposer — собирает финальный визуальный промпт из scene
 * graph, style profile и ограничений статьи. Возвращает готовый контракт
 * слота: visual_prompt / negative_prompt / alt_ru / caption_ru /
 * style_label / filename_slug.
 *
 * Детерминированный (без сети/LLM): тот же scene → тот же промпт.
 * Это делает вывод воспроизводимым и тестируемым офлайн.
 *
 * visual_prompt строится строго по требованиям ТЗ §3:
 *   что изображено · среда · действие · композиция · визуальный стиль ·
 *   ограничения на артефакты.
 * negative_prompt всегда включает: no text overlays, no logos, no surreal
 *   fantasy, no malformed hands/faces, no glossy generic stock.
 */

const { slugify } = require('./slug');

// Обязательный «скелет» негатива (усиливается в strict-режиме).
const NEGATIVE_BASE = [
  'no text overlays',
  'no captions or watermarks',
  'no logos or brand marks',
  'no surreal or fantasy elements',
  'no malformed hands or faces',
  'no glossy generic stock look',
  'no distorted proportions',
];

const NEGATIVE_STRICT_EXTRA = [
  'no cartoonish or 3d-render style',
  'no oversaturated colors',
  'no collage or multiple frames',
  'no lens flare or heavy vignette',
];

const DEFAULT_STYLE_LABEL = 'editorial realistic clean';

function _join(parts) {
  return parts.filter((p) => p && String(p).trim()).map((p) => String(p).trim());
}

/**
 * composePrompt — главный вход.
 *
 * @param {object} input
 * @param {object} input.scene         — scene graph из imageSceneExtractor
 * @param {object} [input.styleProfile]— { style_label, rationale }
 * @param {string} [input.articleType]
 * @param {string} [input.imageIntent]
 * @param {object} [input.brandRules]  — { forbid[], require[] }
 * @param {string} [input.editorialMode] — 'strict' | 'relaxed'
 * @param {string} [input.sectionH2]
 * @param {string} [input.topic]
 * @returns {object} slot-контракт (никогда не бросает)
 */
function composePrompt(input = {}) {
  const scene = input.scene || {};
  const intent = String(input.imageIntent || scene.image_intent || 'explainer_scene');
  const editorialMode = input.editorialMode === 'relaxed' ? 'relaxed' : 'strict';
  const styleLabel = String(
    (input.styleProfile && input.styleProfile.style_label) || DEFAULT_STYLE_LABEL,
  ).slice(0, 120);

  const subject = String(scene.subject || input.sectionH2 || input.topic || '').trim();
  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  const mustInclude = Array.isArray(scene.must_include) ? scene.must_include : [];
  const anchors = Array.isArray(scene.factual_anchors) ? scene.factual_anchors : [];

  // ── visual_prompt: строгий порядок смысловых слотов. ────────────────
  const promptParts = _join([
    subject ? `Subject: ${subject}` : '',
    objects.length ? `Key objects: ${objects.slice(0, 6).join(', ')}` : '',
    scene.environment ? `Environment: ${scene.environment}` : '',
    scene.action ? `Action: ${scene.action}` : '',
    scene.composition ? `Composition: ${scene.composition}` : '',
    `Style: ${styleLabel}, natural lighting, high detail, photorealistic`,
    mustInclude.length ? `Must include: ${mustInclude.slice(0, 5).join('; ')}` : '',
    anchors.length ? `Grounded in facts: ${anchors.slice(0, 4).join('; ')}` : '',
  ]);
  // brandRules.require → добавляем как жёсткие требования.
  if (input.brandRules && Array.isArray(input.brandRules.require)) {
    for (const r of input.brandRules.require.slice(0, 5)) promptParts.push(`Brand requirement: ${r}`);
  }
  const visualPrompt = promptParts.join('. ').slice(0, 2000);

  // ── negative_prompt. ────────────────────────────────────────────────
  const neg = NEGATIVE_BASE.slice();
  if (editorialMode === 'strict') neg.push(...NEGATIVE_STRICT_EXTRA);
  // scene.must_avoid переводим/добавляем как есть (RU-фразы допустимы).
  if (Array.isArray(scene.must_avoid)) neg.push(...scene.must_avoid);
  if (input.brandRules && Array.isArray(input.brandRules.forbid)) {
    neg.push(...input.brandRules.forbid.map((f) => `no ${f}`));
  }
  const negativePrompt = Array.from(new Set(neg)).join(', ').slice(0, 400);

  // ── alt_ru: краткое описание для доступности/SEO. ───────────────────
  const altRu = _buildAlt(subject, intent, scene).slice(0, 200);

  // ── caption_ru: чуть более развёрнутая подпись. ─────────────────────
  const captionRu = _buildCaption(subject, intent, scene).slice(0, 240);

  // ── filename_slug. ──────────────────────────────────────────────────
  const slugSeed = [subject || input.topic || 'image', intent].join(' ');
  const filenameSlug = slugify(slugSeed, { maxLen: 60 });

  return {
    visual_prompt: visualPrompt,
    negative_prompt: negativePrompt,
    alt_ru: altRu,
    caption_ru: captionRu,
    style_label: styleLabel,
    filename_slug: filenameSlug,
  };
}

const INTENT_ALT_PREFIX = {
  cover: '',
  explainer_scene: 'Иллюстрация принципа: ',
  step_by_step: 'Этапы: ',
  comparison_scene: 'Сравнение: ',
  object_visual: '',
  trust_visual: '',
  context_of_use: 'Использование: ',
};

function _buildAlt(subject, intent, scene) {
  const base = subject || 'иллюстрация к статье';
  const prefix = INTENT_ALT_PREFIX[intent] || '';
  const anchor = Array.isArray(scene.factual_anchors) && scene.factual_anchors.length
    ? ` (${scene.factual_anchors[0]})`
    : '';
  return `${prefix}${base}${anchor}`.replace(/\s+/g, ' ').trim();
}

function _buildCaption(subject, intent, scene) {
  const base = subject || 'иллюстрация к статье';
  if (intent === 'comparison_scene') return `Сравнение вариантов: ${base}`;
  if (intent === 'step_by_step') return `Пошаговая визуализация: ${base}`;
  if (intent === 'context_of_use') return `Пример использования: ${base}`;
  if (intent === 'trust_visual') return `Практический пример: ${base}`;
  if (intent === 'cover') return base;
  return base;
}

module.exports = {
  composePrompt,
  NEGATIVE_BASE,
  NEGATIVE_STRICT_EXTRA,
  DEFAULT_STYLE_LABEL,
};
