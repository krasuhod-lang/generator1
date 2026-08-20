'use strict';

/**
 * services/images — общий модуль content-grounded image pipeline.
 *
 * Facade: собирает планировочный слой (intent → scene → prompt) в один
 * вызов buildGroundedImagePrompts(), а также ре-экспортирует остальные
 * слои (semantic QA, storage, quality gate, config) для использования из
 * infoArticle / linkArticle пайплайнов и будущего seo/commercial pipeline.
 *
 * Все планировочные функции детерминированы (без сети/LLM) — вывод
 * воспроизводим и тестируется офлайн.
 */

const { getImageConfig, isNewPipelineEnabled } = require('./config');
const { planImageIntents } = require('./imageIntentPlanner');
const { extractScene } = require('./imageSceneExtractor');
const { composePrompt } = require('./imagePromptComposer');
const { runSemanticImageQa } = require('./semanticImageQa.service');
const { persistImages } = require('./imageStorage.service');
const { evaluateImageGate } = require('./imageQualityGate');
const { slugify } = require('./slug');

/**
 * buildSectionsFromArticle — общий deterministic extractor для link/info
 * pipeline. Сохраняет H2, тело секции и anchor_block_id, чтобы image slot
 * можно было встроить перед конкретным блоком без нового LLM-вызова.
 */
function buildSectionsFromArticle(articleHtml) {
  const html = String(articleHtml || '');
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
  const marks = [];
  let match;
  while ((match = h2Re.exec(html)) !== null) {
    marks.push({ index: match.index, endTag: match.index + match[0].length, title: match[1] });
  }
  const stripTags = (value) => String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : html.length;
    const bodyHtml = html.slice(mark.endTag, end);
    return {
      key: `section_${index}`,
      h2: stripTags(mark.title).slice(0, 200),
      html: bodyHtml,
      text: stripTags(bodyHtml),
      anchor_block_id: `block_${index}`,
      index,
    };
  });
}

/**
 * buildGroundedImagePrompts — превращает секции статьи в готовые слоты
 * для генерации: для каждого нужного слота выполняет scene extraction и
 * prompt composition. Слоты с need_image=false возвращаются в
 * `rejected[]` (для аудита/логов) и НЕ идут в генерацию.
 *
 * @param {object} input
 * @param {string} input.articleType
 * @param {string} input.topic
 * @param {Array}  input.sections       — [{ key, h2, text|html, anchor_block_id }]
 * @param {object} [input.audience]
 * @param {object} [input.styleProfile] — { style_label, rationale }
 * @param {object} [input.brandRules]
 * @param {number} [input.maxImages]
 * @param {object} [input.config]       — переопределение (тесты)
 * @returns {{ slots: Array, rejected: Array, plan: Array }}
 */
function buildGroundedImagePrompts(input = {}) {
  const cfg = input.config || getImageConfig();
  const editorialMode = input.editorialMode
    || (input.articleType === 'linkArticle' ? cfg.editorialModeDefault : 'relaxed');

  const sectionByKey = new Map();
  for (let i = 0; i < (input.sections || []).length; i += 1) {
    const s = input.sections[i] || {};
    sectionByKey.set(String(s.key || `section_${i}`), s);
  }

  const plan = planImageIntents({
    articleType: input.articleType,
    topic: input.topic,
    sections: input.sections,
    audience: input.audience,
    maxImages: input.maxImages,
    maxInlineImages: cfg.maxInlineImages,
    editorialMode,
  });

  const slots = [];
  const rejected = [];

  for (const p of plan) {
    if (!p.need_image || p.slot == null) {
      rejected.push(p);
      continue;
    }

    const section = p.section_key === 'cover'
      ? null
      : sectionByKey.get(p.section_key);
    const sectionText = section ? (section.text != null ? section.text : section.html) : '';

    // Once the grounded facade is requested, scene extraction is always part
    // of its contract. The config flag controls activation at pipeline level;
    // keeping extraction here unconditional prevents silent generic prompts.
    const scene = extractScene({
      sectionText,
      imageIntent: p.image_intent,
      sectionH2: p.section_h2,
      topic: input.topic,
      articleType: input.articleType,
      audience: input.audience,
    });
    // Прикрепляем intent к сцене — используется в semantic QA.
    if (scene) scene.image_intent = p.image_intent;

    const composed = composePrompt({
      scene,
      styleProfile: input.styleProfile,
      articleType: input.articleType,
      imageIntent: p.image_intent,
      brandRules: input.brandRules,
      editorialMode,
      sectionH2: p.section_h2,
      topic: input.topic,
    });

    slots.push({
      slot: p.slot,
      section_h2: p.section_h2,
      section_key: p.section_key,
      anchor_block_id: p.anchor_block_id,
      image_intent: p.image_intent,
      value_reason: p.value_reason,
      placement_mode: p.placement_mode,
      priority: p.priority,
      generic_risk: scene ? scene.generic_risk : 'medium',
      scene_json: scene,
      visual_prompt: composed.visual_prompt,
      negative_prompt: composed.negative_prompt,
      alt_ru: composed.alt_ru,
      caption_ru: composed.caption_ru,
      style_label: composed.style_label,
      filename_slug: composed.filename_slug,
      storage_mode: cfg.storageMode,
      image_url: null,
      semantic_qa_result: null,
      semantic_qa_scores: null,
      status: 'pending',
      image_base64: null,
      mime_type: null,
      error: null,
    });
  }

  return { slots, rejected, plan };
}

module.exports = {
  // config
  getImageConfig,
  isNewPipelineEnabled,
  // planning layer
  planImageIntents,
  extractScene,
  composePrompt,
  buildGroundedImagePrompts,
  buildSectionsFromArticle,
  // qa / storage / gate
  runSemanticImageQa,
  persistImages,
  evaluateImageGate,
  // utils
  slugify,
};
