'use strict';

/**
 * Smoke-tests для audienceResearch.service (мост Reddit Mapper V2 → IAKB §10).
 *
 * Покрывает БЕЗ сетевых вызовов:
 *   • фиче-флаг (по умолчанию ВЫКЛ → digest=null, skipped=flag_disabled);
 *   • детерминированный A/B-бакет по taskId + границы ratio 0/1;
 *   • построение брифа из task/strategy/audience/intents;
 *   • кэш по ключу niche|geo;
 *   • тест-путь с DI-раннером (has_signal → §10 включается; нет сигнала →
 *     graceful skip; ошибка раннера → pipeline_error);
 *   • интеграция дайджеста в buildInfoArticleKnowledgeBase (§10).
 *
 * Запуск: `node backend/scripts/test-audience-research.js`
 */

const assert = require('assert');

const {
  resolveAudienceResearch,
  _abBucket,
  _buildBrief,
  _cacheKey,
  _countSignals,
  _clearCache,
} = require('../src/services/infoArticle/audienceResearch.service');

const { getQualityFlags } = require('../src/services/qualityLayers/featureFlags');
const { buildInfoArticleKnowledgeBase } = require('../src/services/infoArticle/infoArticleKnowledgeBase');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

// Дайджест с сигналом (как из masterJson.buildResearchDigest).
function digestWithSignal() {
  return {
    system_version: 'reddit_mapper_v2',
    core_pains: ['перегрев в городе', 'шум при торможении'],
    question_patterns: ['что выбрать для города?'],
    has_signal: true,
  };
}

console.log('\n=== feature flag default (OFF) ===');
{
  const flags = getQualityFlags().audienceResearch;
  ok('блок audienceResearch существует', !!flags);
  ok('по умолчанию ВЫКЛ', flags.enabled === false);
  ok('provider = deepseek', flags.provider === 'deepseek');
  ok('abSampleRatio в [0..1]', flags.abSampleRatio >= 0 && flags.abSampleRatio <= 1);
}

console.log('\n=== resolveAudienceResearch: flag disabled (graceful) ===');
(async () => {
  const r = await resolveAudienceResearch({ task: { id: 1, topic: 'тормоза', region: 'РФ' } });
  ok('digest=null при выключенном флаге', r.digest === null);
  ok('skipped_reason=flag_disabled', r.meta.skipped_reason === 'flag_disabled');
  ok('included=false', r.meta.included === false);

  console.log('\n=== _abBucket: детерминизм и границы ===');
  ok('ratio>=1 → test', _abBucket('any', 1) === 'test');
  ok('ratio<=0 → control', _abBucket('any', 0) === 'control');
  ok('детерминирован по taskId', _abBucket('task-xyz', 0.5) === _abBucket('task-xyz', 0.5));
  {
    // На большой выборке доля test ~ ratio (грубая проверка распределения).
    let testCount = 0;
    const N = 2000;
    for (let i = 0; i < N; i += 1) if (_abBucket(`id-${i}`, 0.5) === 'test') testCount += 1;
    const frac = testCount / N;
    ok('ratio=0.5 даёт ~50% test (0.4..0.6)', frac > 0.4 && frac < 0.6, `frac=${frac}`);
  }

  console.log('\n=== _buildBrief ===');
  {
    const brief = _buildBrief({
      task: { topic: 'тормозные диски', region: 'Москва', brand_name: 'ACME' },
      strategy: { summary: 'контекст ниши' },
      intents: { user_questions: [{ label: 'какие диски выбрать?' }, 'когда менять диски'] },
      audience: { segments: [{ label: 'автовладельцы' }] },
    });
    ok('niche из topic', brief.niche === 'тормозные диски');
    ok('geo из region', brief.geo === 'Москва');
    ok('brand_name проброшен', brief.brand_name === 'ACME');
    ok('seed_topics собраны', brief.seed_topics.includes('какие диски выбрать?'));
    ok('manual_context из strategy', brief.manual_context_from_user === 'контекст ниши');
  }

  console.log('\n=== _cacheKey / _countSignals ===');
  ok('_cacheKey нормализует регистр/пробелы', _cacheKey({ niche: ' Тормоза ', geo: 'РФ' }) === 'тормоза|рф');
  ok('_countSignals считает элементы массивов', _countSignals(digestWithSignal()) === 3);

  console.log('\n=== DI-раннер: тест-группа с сигналом → §10 ===');
  const onCfg = { enabled: true, provider: 'deepseek', abSampleRatio: 1.0, cacheTtlMinutes: 60, cacheMaxEntries: 50 };
  {
    _clearCache();
    let calls = 0;
    const runPipeline = async () => { calls += 1; return { digest: digestWithSignal(), stagesRun: ['stage0', 'stage1'], errors: [] }; };
    const task = { id: 'det-task-1', topic: 'тормоза', region: 'РФ' };
    const r1 = await resolveAudienceResearch({ task }, { runPipeline, flags: onCfg });
    ok('digest получен (has_signal)', r1.digest && r1.digest.has_signal === true);
    ok('included=true', r1.meta.included === true);
    ok('ab_bucket=test (ratio=1)', r1.meta.ab_bucket === 'test');
    ok('signal_count посчитан', r1.meta.signal_count === 3);
    ok('раннер вызван 1 раз', calls === 1);

    // Повторный вызов той же темы/региона → кэш, раннер не зовётся снова.
    const r2 = await resolveAudienceResearch({ task }, { runPipeline, flags: onCfg });
    ok('кэш-хит при повторе', r2.meta.cache_hit === true);
    ok('раннер НЕ вызван повторно (cache)', calls === 1);
  }

  console.log('\n=== DI-раннер: контрольная A/B-группа → без §10 ===');
  {
    _clearCache();
    let calls = 0;
    const runPipeline = async () => { calls += 1; return { digest: digestWithSignal() }; };
    // ratio=0 → всегда control.
    const r = await resolveAudienceResearch(
      { task: { id: 'ctl', topic: 'x', region: 'y' } },
      { runPipeline, flags: { ...onCfg, abSampleRatio: 0 } },
    );
    ok('control → digest=null', r.digest === null);
    ok('skipped_reason=ab_control', r.meta.skipped_reason === 'ab_control');
    ok('раннер не вызван для control', calls === 0);
  }

  console.log('\n=== DI-раннер: нет сигнала → graceful skip ===');
  {
    _clearCache();
    const runPipeline = async () => ({ digest: { has_signal: false }, stagesRun: [], errors: [] });
    const r = await resolveAudienceResearch({ task: { id: 'ns', topic: 'a', region: 'b' } }, { runPipeline, flags: onCfg });
    ok('no_signal → digest=null', r.digest === null);
    ok('skipped_reason=no_signal', r.meta.skipped_reason === 'no_signal');
  }

  console.log('\n=== DI-раннер: ошибка пайплайна → graceful ===');
  {
    _clearCache();
    const runPipeline = async () => { throw new Error('boom'); };
    const r = await resolveAudienceResearch({ task: { id: 'err', topic: 'a', region: 'b' } }, { runPipeline, flags: onCfg });
    ok('ошибка → digest=null', r.digest === null);
    ok('skipped_reason=pipeline_error', r.meta.skipped_reason === 'pipeline_error');
    ok('ошибка записана в meta.errors', Array.isArray(r.meta.errors) && r.meta.errors.length === 1);
  }

  console.log('\n=== интеграция дайджеста в IAKB §10 ===');
  {
    const task = { topic: 'тормоза', region: 'РФ' };
    const kbWith = buildInfoArticleKnowledgeBase({ task, audienceResearch: digestWithSignal() });
    ok('§10 рендерится при наличии дайджеста', kbWith.includes('§10. Голос аудитории'));
    ok('§10 содержит боль', kbWith.includes('перегрев в городе'));
    const kbWithout = buildInfoArticleKnowledgeBase({ task, audienceResearch: null });
    ok('§10 отсутствует без дайджеста (graceful)', !kbWithout.includes('§10. Голос аудитории'));
  }

  console.log(`\n──────────── audienceResearch smoke: ${passed} passed, ${failed} failed ────────────\n`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
