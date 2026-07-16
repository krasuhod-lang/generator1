'use strict';

/**
 * test-meta-fallback — безотказность обычной (SERP) генерации мета-тегов.
 *
 * Проверяет runResilientMetaPipeline: GIST усиливает качество, но не роняет
 * ключ. При полном провале трёхфазного пайплайна (пустой пул кандидатов /
 * ошибки LLM) пара собирается напрямую через MetaPairAssembler с
 * manual_review_required=true. LLM-адаптеры замоканы через require.cache.
 */

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    failed += 1;
  }
}

// ── Мок-адаптеры: маршрутизируем ответ по system-промпту ──────────────
const prompts = require('../src/services/metaTags/gistMetaPrompts');

function _mkRes(obj) {
  return {
    text: JSON.stringify(obj),
    tokensIn: 10, tokensOut: 20, thoughtsTokens: 0, cachedTokens: 0,
    model: 'mock-model', finishReason: 'STOP',
  };
}

const VALID_PAIR = {
  title: 'Пластиковые окна Rehau в Москве — монтаж по ГОСТ за 1 день с гарантией 10 лет',
  description: 'Устанавливаем пластиковые окна Rehau с пятикамерным профилем и монтажом по ГОСТ 30971 за один день. Даём гарантию 10 лет на профиль и работу, замер бесплатно в день обращения по всей Москве.',
  description_mobile: 'Окна Rehau по ГОСТ за 1 день, гарантия 10 лет, бесплатный замер.',
  h1: 'Пластиковые окна Rehau в Москве',
  winner_fact: 'монтаж по ГОСТ 30971 за 1 день',
};

// Управляемое поведение генератора кандидатов: пусто → провал пайплайна.
let candidatesEmpty = false;

function _mockGemini(systemPrompt) {
  if (systemPrompt === prompts.CANDIDATE_GENERATOR_SYSTEM) {
    return _mkRes({
      field_job: { job: 'commercial-service' },
      competitor_pattern: { dominant: 'plain' },
      candidates: candidatesEmpty ? [] : [
        { fact: 'монтаж по ГОСТ 30971 за 1 день', source: 'missing_node' },
        { fact: 'гарантия 10 лет на профиль', source: 'quantifiable' },
      ],
    });
  }
  if (systemPrompt === prompts.FILTER_RANKER_SYSTEM) {
    return _mkRes({
      manual_review_required: false,
      ranked: [
        {
          fact: 'монтаж по ГОСТ 30971 за 1 день', source: 'missing_node',
          concreteness: 1, decision_relevance: 1, replaceability: 1, verifiability: 1,
          survived: true, surprise_value: 2, verification_cost: 1, intent_specificity: 2,
        },
        {
          fact: 'гарантия 10 лет на профиль', source: 'quantifiable',
          concreteness: 1, decision_relevance: 1, replaceability: 1, verifiability: 1,
          survived: true, surprise_value: 1, verification_cost: 1, intent_specificity: 1,
        },
      ],
    });
  }
  if (systemPrompt === prompts.CONFLICT_CHECKER_SYSTEM) {
    return _mkRes({
      conflict_check: { passed: true, detail: null },
      replaceability_check: { passed: true, detail: null },
    });
  }
  // PAIR_ASSEMBLER_SYSTEM — сборка пары (в т.ч. fallback-путь).
  return _mkRes(VALID_PAIR);
}

// Инжектируем моки в require.cache ДО загрузки gistMetaFilter.
function _stubAdapter(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', 'src', 'services', 'llm', relPath));
  require.cache[abs] = {
    id: abs, filename: abs, loaded: true, exports: exportsObj,
  };
}
_stubAdapter('gemini.adapter.js', { callGemini: async (s) => _mockGemini(s) });
_stubAdapter('deepseek.adapter.js', {
  callDeepSeek: async (s) => _mockGemini(s),
  DEEPSEEK_MODEL: 'mock-deepseek',
});
// Без DEEPSEEK_API_KEY аналитические вызовы идут через callGemini — мок
// покрывает оба маршрута.
delete process.env.DEEPSEEK_API_KEY;

const {
  runResilientMetaPipeline,
} = require('../src/services/metaTags/gistMetaFilter');

const BASE_ARGS = {
  keyword: 'пластиковые окна rehau',
  semantics: { obligatory_lsi: ['окн', 'rehau'], title_mandatory_words: ['окна', 'rehau'] },
  serpData: [],
  inputs: { toponym: 'Москва', standalone_exposure: false },
  options: {},
};

(async () => {
  await test('экспорт: runResilientMetaPipeline — функция', () => {
    assert.strictEqual(typeof runResilientMetaPipeline, 'function');
  });

  await test('happy path: полный пайплайн отработал → результат без fallback', async () => {
    candidatesEmpty = false;
    const res = await runResilientMetaPipeline(BASE_ARGS);
    assert.ok(res.title, 'title должен быть непустым');
    assert.ok(res.description, 'description должен быть непустым');
    assert.strictEqual(res.manual_review_required, false);
    assert.notStrictEqual(res.fallback_used, 'assembler_direct');
    assert.ok(res.winner_fact, 'winner_fact заполнен из пайплайна');
  });

  await test('провал пайплайна (пустые кандидаты) → fallback собирает валидную пару', async () => {
    candidatesEmpty = true;
    const res = await runResilientMetaPipeline(BASE_ARGS);
    assert.ok(res.title, 'title должен быть непустым даже при провале пайплайна');
    assert.ok(res.description, 'description должен быть непустым');
    assert.strictEqual(res.manual_review_required, true, 'fallback помечает ручную проверку');
    assert.strictEqual(res.fallback_used, 'assembler_direct');
    assert.strictEqual(res.winner_source, 'fallback_structural');
    assert.ok(
      Array.isArray(res.post_validation_notes)
        && res.post_validation_notes.some((n) => /не отработал/.test(n)),
      'в заметках зафиксирована причина fallback',
    );
  });

  await test('fallback уважает кириллические safe ranges (title ≤ 80, desc ≤ 190)', async () => {
    candidatesEmpty = true;
    const res = await runResilientMetaPipeline(BASE_ARGS);
    assert.ok(res.title.length <= 80, `title=${res.title.length}`);
    assert.ok(res.description.length <= 190, `desc=${res.description.length}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
