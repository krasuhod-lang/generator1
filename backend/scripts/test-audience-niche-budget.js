'use strict';

const assert = require('assert');

const callLLMPath = require.resolve('../src/services/llm/callLLM');
const analyzerPath = require.resolve('../src/services/parser/audienceNicheAnalyzer');
const originalCallLLM = require.cache[callLLMPath];
const originalAnalyzer = require.cache[analyzerPath];

let captured = null;
let shouldFail = false;
require.cache[callLLMPath] = {
  id: callLLMPath,
  filename: callLLMPath,
  loaded: true,
  exports: {
    callLLM: async (...args) => {
      captured = args;
      if (shouldFail) throw new Error('synthetic provider failure');
      return {
        audience_personas: [{ name: 'Сегмент', voice_examples: ['как выбрать'] }],
        niche_deep_dive: [{ theme: 'Trust', insight: 'Фактор', content_implication: 'Показать доказательства' }],
        niche_terminology: ['Термин — расшифровка'],
        niche_red_flags: [],
        content_voice: { tone: 'деловой-сдержанный' },
      };
    },
  },
};
delete require.cache[analyzerPath];

async function main() {
  const { analyzeAudienceAndNiche } = require(analyzerPath);
  const logs = [];
  const result = await analyzeAudienceAndNiche(
    {
      input_target_service: 'создание SEO-текста',
      input_brand_name: 'Test Brand',
      input_business_type: 'B2B',
      input_region: 'Москва',
      input_brand_facts: 'Подтверждённые факты бренда',
      input_target_audience: 'Маркетологи малого бизнеса',
      input_niche_features: 'Контент и поисковое продвижение',
    },
    { taskId: 'test-task', log: (message) => logs.push(message), onTokens: () => {} },
  );

  assert(result && result.audience_personas.length === 1, 'analyzer should return structured JSON');
  assert(captured, 'callLLM should be invoked');
  assert.strictEqual(captured[0], 'deepseek');
  assert.strictEqual(captured[3].maxTokens, 12000);
  assert.strictEqual(captured[3].retryOnTruncation, false);
  assert.deepStrictEqual(captured[3].responseFormat, { type: 'json_object' });
  assert(captured[2].includes('РОВНО 3 ПЕРСОНЫ'), 'compact persona contract missing');
  assert(captured[2].includes('РОВНО 4 ИНСАЙТА'), 'compact niche contract missing');
  assert(captured[2].includes('8–10 LSI-сущностей'), 'compact terminology contract missing');
  assert(logs.some((line) => String(line).includes('персон 1')), 'success log missing');

  shouldFail = true;
  const fallback = await analyzeAudienceAndNiche(
    { input_target_service: 'создание SEO-текста', input_target_audience: 'Маркетологи малого бизнеса' },
    { taskId: 'fallback-task', log: (message) => logs.push(message), onTokens: () => {} },
  );
  assert.strictEqual(fallback.analysis_status, 'fallback');
  assert(fallback.audience_personas.length === 1, 'fallback persona missing');
  assert(logs.some((line) => String(line).includes('fallback после ошибки')), 'fallback log missing');

  console.log('Audience/Niche budget regression: 11/11 passed');
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalCallLLM) require.cache[callLLMPath] = originalCallLLM;
    else delete require.cache[callLLMPath];
    if (originalAnalyzer) require.cache[analyzerPath] = originalAnalyzer;
    else delete require.cache[analyzerPath];
  });
