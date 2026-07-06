'use strict';

/**
 * test-images-pipeline.js — юнит-тесты content-grounded image pipeline
 * (backend/src/services/images/*). Всё в памяти, без сети, без БД.
 *
 * Покрывает: slug, config, imageIntentPlanner, imageSceneExtractor,
 * imagePromptComposer, semanticImageQa, imageStorage (cdn_upload на tmp),
 * imageQualityGate и facade buildGroundedImagePrompts.
 *
 * Запуск:  node backend/scripts/test-images-pipeline.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const IMG = path.join(__dirname, '..', 'src', 'services', 'images');
const { slugify, transliterate } = require(path.join(IMG, 'slug'));
const { getImageConfig, isNewPipelineEnabled } = require(path.join(IMG, 'config'));
const { planImageIntents } = require(path.join(IMG, 'imageIntentPlanner'));
const { extractScene } = require(path.join(IMG, 'imageSceneExtractor'));
const { composePrompt } = require(path.join(IMG, 'imagePromptComposer'));
const { runSemanticImageQa } = require(path.join(IMG, 'semanticImageQa.service'));
const { persistImages, storeSlot } = require(path.join(IMG, 'imageStorage.service'));
const { evaluateImageGate } = require(path.join(IMG, 'imageQualityGate'));
const { buildGroundedImagePrompts } = require(path.join(IMG, 'index'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { _pass += 1; console.log(`  ✓ ${name}`); })
        .catch((e) => { console.error(`  ✗ ${name}\n      ${e.message}`); });
    }
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
  return Promise.resolve();
}

// A tiny valid PNG (1x1) is too small for QA; build a fake but larger buffer
// with valid PNG header + IHDR advertising 1024x768.
function fakePngBase64(w = 1024, h = 768, padKb = 20) {
  const head = Buffer.alloc(24);
  head[0] = 0x89; head[1] = 0x50; head[2] = 0x4E; head[3] = 0x47;
  head[4] = 0x0D; head[5] = 0x0A; head[6] = 0x1A; head[7] = 0x0A;
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  const body = Buffer.alloc(padKb * 1024, 7);
  return Buffer.concat([head, body]).toString('base64');
}

const SECTIONS = [
  {
    key: 'sec_how', h2: 'Как работает обратный осмос',
    text: 'Сначала вода проходит предфильтр, затем под давлением продавливается через мембрану. '
      + 'На этом этапе задерживаются соли. После этого чистая вода поступает в накопительный бак 10 л. '
      + 'Порядок действий важен для понимания процесса очистки.',
  },
  {
    key: 'sec_choose', h2: 'Как выбрать водомат для улицы',
    text: 'Сравним два варианта: уличный автомат против настенного модуля. Отличие в защите от мороза. '
      + 'Плюсы и минусы каждого типа помогают выбрать. Какой выбрать зависит от потока клиентов.',
  },
  {
    key: 'sec_law', h2: 'Немного истории и терминологии',
    text: 'Важно понимать, что это определение появилось давно. Таким образом, терминология уточнялась.',
  },
];

async function main() {
  console.log('slug');
  await check('transliterate RU→LAT', () => {
    assert.strictEqual(transliterate('Вода'), 'Voda');
  });
  await check('slugify strips + caps length', () => {
    assert.strictEqual(slugify('Как выбрать водомат!!!'), 'kak-vybrat-vodomat');
    assert.ok(slugify('a'.repeat(200)).length <= 60);
    assert.strictEqual(slugify(''), 'image');
  });

  console.log('config');
  await check('defaults are backward-compatible (new flow OFF)', () => {
    const saved = { ...process.env };
    delete process.env.IMAGE_PIPELINE_ENABLE_INTENT_PLANNER;
    delete process.env.IMAGE_PIPELINE_ENABLE_SCENE_EXTRACTION;
    const cfg = getImageConfig();
    assert.strictEqual(cfg.intentPlannerEnabled, false);
    assert.strictEqual(cfg.storageMode, 'inline_base64');
    assert.strictEqual(cfg.editorialModeDefault, 'strict');
    assert.strictEqual(isNewPipelineEnabled(cfg), false);
    process.env = saved;
  });
  await check('env toggles parsed', () => {
    const saved = { ...process.env };
    process.env.IMAGE_PIPELINE_ENABLE_INTENT_PLANNER = 'true';
    process.env.IMAGE_PIPELINE_GENERIC_SCORE_THRESHOLD = '0.4';
    process.env.IMAGE_PIPELINE_STORAGE_MODE = 'cdn_upload';
    const cfg = getImageConfig();
    assert.strictEqual(cfg.intentPlannerEnabled, true);
    assert.strictEqual(cfg.genericScoreThreshold, 0.4);
    assert.strictEqual(cfg.storageMode, 'cdn_upload');
    assert.ok(isNewPipelineEnabled(cfg));
    process.env = saved;
  });

  console.log('imageIntentPlanner');
  await check('cover always planned when topic present', () => {
    const plan = planImageIntents({ topic: 'Обратный осмос', sections: [], maxImages: 3 });
    assert.strictEqual(plan[0].slot, 1);
    assert.strictEqual(plan[0].image_intent, 'cover');
    assert.strictEqual(plan[0].need_image, true);
  });
  await check('maxImages=0 → empty plan', () => {
    assert.deepStrictEqual(planImageIntents({ topic: 'x', maxImages: 0 }), []);
  });
  await check('abstract section rejected, useful sections chosen', () => {
    const plan = planImageIntents({
      topic: 'Водоматы', sections: SECTIONS, maxImages: 6,
      maxInlineImages: 6, editorialMode: 'relaxed',
    });
    const chosen = plan.filter((p) => p.need_image && p.slot != null);
    const keys = chosen.map((c) => c.section_key);
    assert.ok(keys.includes('sec_how'), 'process section should be chosen');
    assert.ok(keys.includes('sec_choose'), 'comparison section should be chosen');
    const law = plan.find((p) => p.section_key === 'sec_law');
    assert.strictEqual(law.need_image, false, 'abstract/short section rejected');
  });
  await check('comparison → comparison_scene, process → step_by_step', () => {
    const plan = planImageIntents({ topic: 'x', sections: SECTIONS, maxImages: 6, editorialMode: 'relaxed' });
    const how = plan.find((p) => p.section_key === 'sec_how');
    const choose = plan.find((p) => p.section_key === 'sec_choose');
    assert.strictEqual(choose.image_intent, 'comparison_scene');
    assert.ok(['step_by_step', 'explainer_scene'].includes(how.image_intent));
  });
  await check('inline budget respects maxImages', () => {
    const plan = planImageIntents({ topic: 'x', sections: SECTIONS, maxImages: 2, editorialMode: 'relaxed' });
    const chosen = plan.filter((p) => p.slot != null);
    assert.strictEqual(chosen.length, 2); // cover + 1 inline
  });

  console.log('imageSceneExtractor');
  await check('extracts objects + anchors, low generic risk', () => {
    const scene = extractScene({
      sectionText: SECTIONS[0].text, imageIntent: 'step_by_step',
      sectionH2: SECTIONS[0].h2, topic: 'Осмос',
    });
    assert.ok(scene.objects.length >= 1);
    assert.ok(scene.factual_anchors.some((a) => /10\s*л/i.test(a)));
    assert.strictEqual(scene.fallback_used, false);
    assert.ok(['low', 'medium'].includes(scene.generic_risk));
    assert.ok(scene.must_avoid.length >= 3);
  });
  await check('empty block → fallback + high generic risk', () => {
    const scene = extractScene({ sectionText: '', imageIntent: 'explainer_scene', topic: 'Тема' });
    assert.strictEqual(scene.fallback_used, true);
    assert.strictEqual(scene.generic_risk, 'high');
    assert.ok(scene.subject);
  });

  console.log('imagePromptComposer');
  await check('composes grounded prompt + strong negatives', () => {
    const scene = extractScene({ sectionText: SECTIONS[1].text, imageIntent: 'comparison_scene', sectionH2: SECTIONS[1].h2 });
    const out = composePrompt({ scene, imageIntent: 'comparison_scene', editorialMode: 'strict' });
    assert.ok(/Subject:/.test(out.visual_prompt));
    assert.ok(/Composition:/.test(out.visual_prompt));
    assert.ok(/no text overlays/.test(out.negative_prompt));
    assert.ok(/no logos/.test(out.negative_prompt));
    assert.ok(/no glossy generic stock/.test(out.negative_prompt));
    assert.ok(out.alt_ru.length > 0);
    assert.ok(out.filename_slug.length > 0 && /^[a-z0-9-]+$/.test(out.filename_slug));
  });

  console.log('semanticImageQa');
  await check('grounded slot passes, generic slot fails', () => {
    const good = buildGroundedImagePrompts({
      topic: 'Водоматы', sections: SECTIONS, articleType: 'infoArticle', maxImages: 4,
      config: { ...getImageConfig(), maxInlineImages: 6, storageMode: 'inline_base64' },
    }).slots.map((s) => ({ ...s, status: 'done', image_base64: fakePngBase64() }));
    const qa = runSemanticImageQa(good, { genericScoreThreshold: 0.65 });
    assert.ok(['pass', 'review'].includes(qa.summary.verdict));
    assert.strictEqual(qa.summary.totalSlots, good.length);

    const generic = [{
      slot: 1, status: 'done', image_base64: fakePngBase64(), section_h2: '',
      image_intent: 'cover', alt_ru: 'x', visual_prompt: 'y', negative_prompt: '',
      scene_json: { generic_risk: 'high', fallback_used: true, subject: '', objects: [], factual_anchors: [] },
    }];
    const qa2 = runSemanticImageQa(generic, { genericScoreThreshold: 0.65 });
    assert.strictEqual(qa2.slots[0].verdict, 'fail');
  });
  await check('never throws on garbage', () => {
    const qa = runSemanticImageQa(null);
    assert.strictEqual(qa.summary.verdict, 'na');
  });

  console.log('imageStorage');
  await check('inline_base64 mode → no file, no url', async () => {
    const cfg = { ...getImageConfig(), storageMode: 'inline_base64' };
    const slot = { slot: 1, status: 'done', image_base64: fakePngBase64(), alt_ru: 'a', filename_slug: 'test' };
    const patch = await storeSlot(slot, 't1', cfg);
    assert.strictEqual(patch.storage_mode, 'inline_base64');
    assert.strictEqual(patch.image_url, null);
    assert.strictEqual(patch.stored, false);
  });
  await check('cdn_upload writes file + returns url', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgstore-'));
    const cfg = { ...getImageConfig(), storageMode: 'cdn_upload', storageDir: dir, publicBaseUrl: 'https://cdn.example.com' };
    const slots = [{ slot: 1, status: 'done', image_base64: fakePngBase64(1200, 800), alt_ru: 'обложка', filename_slug: 'oblozhka' }];
    const out = await persistImages(slots, 'task42', cfg);
    assert.strictEqual(out[0].storage_mode, 'cdn_upload');
    assert.ok(out[0].image_url.startsWith('https://cdn.example.com/task42/'));
    assert.ok(out[0].filesize_bytes > 0);
    assert.strictEqual(out[0].width, 1200);
    assert.strictEqual(out[0].height, 800);
    assert.ok(fs.existsSync(path.join(dir, 'task42', out[0].filename)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('imageQualityGate');
  await check('do_not_generate slot generated → fail', () => {
    const gate = evaluateImageGate({
      imagePrompts: [{ slot: 2, status: 'done', image_base64: 'x', alt_ru: 'a', image_intent: 'do_not_generate' }],
      config: {},
    });
    assert.strictEqual(gate.verdict, 'fail');
    assert.strictEqual(gate.canFinalize, false);
  });
  await check('missing alt → fail', () => {
    const gate = evaluateImageGate({
      imagePrompts: [{ slot: 1, status: 'done', image_base64: 'x', alt_ru: '', image_intent: 'cover' }],
      config: {},
    });
    assert.ok(gate.blockers.some((b) => /alt_ru/.test(b)));
  });
  await check('requireProductionUrl without url → fail', () => {
    const gate = evaluateImageGate({
      imagePrompts: [{ slot: 1, status: 'done', image_base64: 'x', alt_ru: 'a', image_intent: 'cover', image_url: null }],
      config: { requireProductionUrl: true },
    });
    assert.strictEqual(gate.canFinalize, false);
  });
  await check('semantic fail cover: warn_only → review, hard_fail → fail', () => {
    const base = {
      imagePrompts: [{ slot: 1, status: 'done', image_base64: 'x', alt_ru: 'a', image_intent: 'cover', image_url: 'u' }],
      technicalQa: { slots: [{ slot: 1, issues: [] }], summary: { verdict: 'pass' } },
      semanticQa: { slots: [{ slot: 1, verdict: 'fail' }], summary: { verdict: 'fail' } },
    };
    const warn = evaluateImageGate({ ...base, config: { semanticQaFallback: 'warn_only' } });
    assert.strictEqual(warn.verdict, 'review');
    assert.strictEqual(warn.canFinalize, true);
    const hard = evaluateImageGate({ ...base, config: { semanticQaFallback: 'hard_fail' } });
    assert.strictEqual(hard.verdict, 'fail');
    assert.strictEqual(hard.canFinalize, false);
  });
  await check('clean slots → pass', () => {
    const gate = evaluateImageGate({
      imagePrompts: [{ slot: 1, status: 'done', image_base64: 'x', alt_ru: 'a', image_intent: 'cover', image_url: 'u' }],
      technicalQa: { slots: [{ slot: 1, issues: [] }], summary: { verdict: 'pass' } },
      semanticQa: { slots: [{ slot: 1, verdict: 'pass' }], summary: { verdict: 'pass' } },
      config: {},
    });
    assert.strictEqual(gate.verdict, 'pass');
  });

  console.log('facade buildGroundedImagePrompts');
  await check('produces slots with scene + composed prompt, rejects abstract', () => {
    const { slots, rejected } = buildGroundedImagePrompts({
      topic: 'Уличные водоматы', articleType: 'infoArticle', sections: SECTIONS, maxImages: 6,
      config: { ...getImageConfig(), maxInlineImages: 6, storageMode: 'inline_base64' },
    });
    assert.ok(slots.length >= 2);
    assert.strictEqual(slots[0].image_intent, 'cover');
    assert.ok(slots.every((s) => s.visual_prompt && s.alt_ru && s.filename_slug && s.scene_json));
    assert.ok(rejected.some((r) => r.section_key === 'sec_law'));
  });

  console.log(`\n${_pass}/${_cases} passed`);
  if (_pass !== _cases) process.exit(1);
}

main();
