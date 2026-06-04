'use strict';

/**
 * Smoke-tests для модуля Reddit Mapper V2 (исследование аудитории).
 *  • загрузчик промтов (7 этапов доступны и непустые);
 *  • DSPy-регистрация в promptRegistry;
 *  • детерминированный master-JSON слой: normalize / merge / validate;
 *  • buildResearchDigest + renderResearchDigestMarkdown;
 *  • мост в infoArticle knowledge base (§10).
 *
 * Запуск: `node backend/scripts/test-reddit-mapper.js`
 * Без сетевых вызовов (LLM не дёргается).
 */

const assert = require('assert');

const {
  PROMPTS,
  STAGE_FILES,
  loadRedditMapperPrompt,
  areRedditMapperPromptsAvailable,
} = require('../src/prompts/redditMapper');

const {
  SYSTEM_VERSION,
  MASTER_KEYS,
  createEmptyMaster,
  normalizeStageOutput,
  mergeMasterJson,
  validateMaster,
  buildResearchDigest,
  renderResearchDigestMarkdown,
  _isEmptyValue,
  _safeParseJson,
} = require('../src/services/redditMapper/masterJson');

const { STAGES, _buildStageUser } = require('../src/services/redditMapper/redditMapperPipeline');
const { buildInfoArticleKnowledgeBase } = require('../src/services/infoArticle/infoArticleKnowledgeBase');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

console.log('\n=== prompts loader ===');
ok('7 этапов перечислены', STAGE_FILES.length === 7);
ok('все промты доступны', areRedditMapperPromptsAvailable() === true);
ok('stage0 непустой', typeof PROMPTS.stage0 === 'string' && PROMPTS.stage0.length > 1000);
ok('stage6 непустой', loadRedditMapperPrompt('stage6').length > 1000);
ok('неизвестный промт бросает', (() => {
  try { loadRedditMapperPrompt('stageX'); return false; } catch (_) { return true; }
})());

console.log('\n=== DSPy registry registration ===');
{
  const { getPrompt } = require('../src/prompts/promptRegistry');
  ok('redditMapper.stage0 зарегистрирован', !!getPrompt('redditMapper.stage0'));
  ok('версия 2.0.0', getPrompt('redditMapper.stage3') && getPrompt('redditMapper.stage3').version === '2.0.0');
  ok('metadata.system', getPrompt('redditMapper.stage5')
    && getPrompt('redditMapper.stage5').metadata.system === 'reddit_mapper_v2');
}

console.log('\n=== createEmptyMaster / keys ===');
{
  const m = createEmptyMaster();
  ok('system_version выставлен', m.system_version === SYSTEM_VERSION);
  ok('все канонические ключи присутствуют', MASTER_KEYS.every((k) => k in m));
}

console.log('\n=== _isEmptyValue ===');
ok('null пустой', _isEmptyValue(null) === true);
ok('"" пустой', _isEmptyValue('  ') === true);
ok('[] пустой', _isEmptyValue([]) === true);
ok('{} пустой', _isEmptyValue({}) === true);
ok('0 не пустой', _isEmptyValue(0) === false);
ok('непустой массив', _isEmptyValue([1]) === false);

console.log('\n=== _safeParseJson / normalizeStageOutput ===');
ok('парсит чистый JSON', JSON.stringify(_safeParseJson('{"a":1}')) === '{"a":1}');
ok('снимает ```json fences', (() => {
  const r = _safeParseJson('```json\n{"pain_map":{"core_pains":[]}}\n```');
  return r && r.pain_map && Array.isArray(r.pain_map.core_pains);
})());
ok('режет мусор вокруг {}', (() => {
  const r = _safeParseJson('бла бла {"x": 2} конец');
  return r && r.x === 2;
})());
ok('строка → объект', (() => {
  const o = normalizeStageOutput('{"reddit_source_map":{"a":1}}');
  return o.reddit_source_map && o.reddit_source_map.a === 1;
})());
ok('разворачивает обёртку master_json', (() => {
  const o = normalizeStageOutput({ master_json: { pain_map: { core_pains: [1] } } });
  return o.pain_map && o.pain_map.core_pains.length === 1;
})());
ok('мусор → {}', JSON.stringify(normalizeStageOutput(42)) === '{}');

console.log('\n=== mergeMasterJson (накопительность + защита от затирания) ===');
{
  let m = createEmptyMaster();
  m = mergeMasterJson(m, { project_meta: { niche: 'тормоза' } });
  m = mergeMasterJson(m, { reddit_source_map: { subreddits: ['r/cars'] } });
  ok('stage0 секция сохранена после stage1', m.project_meta.niche === 'тормоза');
  ok('stage1 секция добавлена', Array.isArray(m.reddit_source_map.subreddits));

  // Пустой выход не должен затирать непустое.
  const before = m.project_meta.niche;
  m = mergeMasterJson(m, { project_meta: { niche: '' } });
  ok('пустой niche не затирает непустой', m.project_meta.niche === before);

  // Непустой выход перекрывает.
  m = mergeMasterJson(m, { project_meta: { niche: 'тормозные диски' } });
  ok('непустой niche перекрывает', m.project_meta.niche === 'тормозные диски');

  ok('system_version всегда фиксирован', m.system_version === SYSTEM_VERSION);
  ok('не мутирует исходный', (() => {
    const a = createEmptyMaster();
    const b = mergeMasterJson(a, { pain_map: { core_pains: [1] } });
    return _isEmptyValue(a.pain_map) && !_isEmptyValue(b.pain_map);
  })());
}

console.log('\n=== validateMaster ===');
{
  const m = createEmptyMaster();
  const v = validateMaster(m);
  ok('пустой master структурно ok (все ключи)', v.ok === true);
  ok('readyStages пуст для пустого master', v.readyStages.length === 0);

  const m2 = mergeMasterJson(m, { pain_map: { core_pains: [{ label: 'x' }] } });
  const v2 = validateMaster(m2);
  ok('stage2 в readyStages после pain_map', v2.readyStages.includes('stage2'));

  const v3 = validateMaster({ pain_map: {} });
  ok('недостающие ключи фиксируются', v3.ok === false && v3.missingKeys.length > 0);
}

console.log('\n=== buildResearchDigest / renderResearchDigestMarkdown ===');
{
  const master = mergeMasterJson(createEmptyMaster(), {
    pain_map: {
      core_pains: [{ label: 'не понимаю, какие диски брать для города' }, { label: 'боюсь перегрева' }],
      objections: [{ label: 'дешёвый аналог быстро износится' }],
    },
    language_map: {
      phrases: [{ label: 'бьёт руль при торможении' }],
      question_patterns: [{ label: 'что лучше для города X или Y?' }],
    },
    priority_matrix: {
      must_cover: [{ label: 'перфорация vs насечки для города' }],
    },
  });

  const digest = buildResearchDigest(master);
  ok('has_signal=true при наличии данных', digest.has_signal === true);
  ok('core_pains извлечены строками', digest.core_pains.length === 2 && typeof digest.core_pains[0] === 'string');
  ok('question_patterns извлечены', digest.question_patterns[0].includes('что лучше'));
  ok('must_cover_topics извлечены', digest.must_cover_topics.length === 1);

  const md = renderResearchDigestMarkdown(digest);
  ok('markdown содержит боли', md.includes('Боли аудитории'));
  ok('markdown содержит вопросы', md.includes('Типовые вопросы'));

  const emptyDigest = buildResearchDigest(createEmptyMaster());
  ok('has_signal=false для пустого', emptyDigest.has_signal === false);
  ok('пустой digest → пустой markdown', renderResearchDigestMarkdown(emptyDigest) === '');
}

console.log('\n=== pipeline stage user payload ===');
{
  ok('7 этапов в STAGES', STAGES.length === 7);
  const u0 = _buildStageUser('stage0', { brief: { niche: 'тормоза' }, master: {} });
  ok('stage0 кладёт raw_brief', u0.includes('raw_brief'));
  const u1 = _buildStageUser('stage1', { brief: {}, master: { project_meta: { niche: 'x' } } });
  ok('stage1 кладёт master_json', u1.includes('master_json'));
  const u2 = _buildStageUser('stage2', { brief: {}, master: {}, redditMaterials: 'тред про диски' });
  ok('stage2 кладёт reddit_materials', u2.includes('reddit_materials') && u2.includes('тред про диски'));
  const u2e = _buildStageUser('stage2', { brief: {}, master: {} });
  ok('stage2 без материалов → strict-пометка', u2e.includes('не переданы'));
}

console.log('\n=== bridge: infoArticle knowledge base §10 ===');
{
  const task = { topic: 'Тормозные диски', region: 'Москва' };
  const research = buildResearchDigest(mergeMasterJson(createEmptyMaster(), {
    pain_map: { core_pains: [{ label: 'перегрев в городе' }] },
    language_map: { question_patterns: [{ label: 'что выбрать для города?' }] },
  }));

  const kbWith = buildInfoArticleKnowledgeBase({ task, audienceResearch: research });
  ok('§10 рендерится при наличии research', kbWith.includes('§10. Голос аудитории'));
  ok('§10 содержит боль', kbWith.includes('перегрев в городе'));

  const kbWithout = buildInfoArticleKnowledgeBase({ task });
  ok('§10 отсутствует без research (graceful)', !kbWithout.includes('§10. Голос аудитории'));

  // Принимает сырой master JSON, не только digest.
  const rawMaster = mergeMasterJson(createEmptyMaster(), {
    pain_map: { core_pains: [{ label: 'шум при торможении' }] },
  });
  const kbRaw = buildInfoArticleKnowledgeBase({ task, audienceResearch: rawMaster });
  ok('§10 принимает сырой master JSON', kbRaw.includes('шум при торможении'));
}

console.log(`\n──────────── Reddit Mapper smoke: ${passed} passed, ${failed} failed ────────────\n`);
if (failed > 0) process.exit(1);
