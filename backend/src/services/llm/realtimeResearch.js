'use strict';

/**
 * realtimeResearch — общий evidence-based research helper для infoArticle и
 * linkArticle. Использует DeepSeek как primary structured analyst и Gemini как
 * fallback. Ни один из этих adapters не является веб-поиском: в prompt передаём
 * только фактический контекст статьи/конкурентов/SERP, а неподтверждённые данные
 * должны отбрасываться.
 *
 * Fail-open: при отсутствии обоих доступных ключей или любой ошибке возвращает
 * null, и пайплайн продолжает работу без research evidence.
 */

const { fillPromptVars } = require('../../utils/fillPromptVars');
const { SYSTEM_PROMPTS_EXT } = require('../../prompts/systemPrompts');
const {
  callResearchProvider,
  hasResearchProviderAsync,
} = require('./researchProvider');
const { runQwenResearchAgent } = require('./qwenAgent.adapter');
const { getIntegrationSecretInfo } = require('../integrations/integrationVault');

/**
 * Приводит сырой ответ DeepSeek/Gemini research contract к
 * единой форме, совпадающей с полями stage0Result основного пайплайна.
 * @param {object|null} raw
 * @returns {{realtime_facts:Array, expert_quotes:Array, latest_trends:Array, legal_updates:Array}|null}
 */
function normalizeResearch(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceOf = (item) => item?.source || item?.source_url || item?.url || '';
  const normalizeFacts = (items) => (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return {
      ...item,
      fact: item.fact || item.claim || item.statement || item.title || '',
      value: item.value || item.fact || item.claim || '',
      source: sourceOf(item),
      quote: item.quote || item.extract || item.evidence_quote || '',
    };
  }).filter(Boolean).slice(0, 30);
  const normalizeQuotes = (items) => (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return {
      ...item,
      author: item.author || item.speaker || item.expert || '',
      role: item.role || item.organization || item.position || '',
      quote: item.quote || item.text || item.extract || '',
      source: sourceOf(item),
    };
  }).filter(Boolean).slice(0, 20);
  const normalizeTrends = (items) => (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return {
      ...item,
      trend: item.trend || item.title || item.topic || item.claim || '',
      evidence: item.evidence || item.quote || item.extract || '',
      source: sourceOf(item),
    };
  }).filter(Boolean).slice(0, 20);
  const normalizeLegal = (items) => (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return {
      ...item,
      topic: item.topic || item.title || item.subject || '',
      change: item.change || item.description || item.claim || '',
      source: sourceOf(item),
    };
  }).filter(Boolean).slice(0, 20);
  return {
    realtime_facts: normalizeFacts(raw.current_stats || raw.realtime_facts),
    expert_quotes: normalizeQuotes(raw.expert_quotes),
    latest_trends: normalizeTrends(raw.latest_trends),
    legal_updates: normalizeLegal(raw.legal_or_price_updates || raw.legal_updates),
    research_provider: meta.provider || raw.research_provider || null,
    research_model: meta.model || raw.research_model || null,
    research_providers: meta.providers || raw.research_providers || [],
  };
}

/**
 * @param {object|null} rt — нормализованный результат runRealtimeResearch.
 * @returns {boolean} — есть ли хоть какие-то актуальные данные.
 */
function hasRealtimeData(rt) {
  if (!rt || typeof rt !== 'object') return false;
  return Boolean(
    (Array.isArray(rt.realtime_facts) && rt.realtime_facts.length) ||
    (Array.isArray(rt.expert_quotes)  && rt.expert_quotes.length)  ||
    (Array.isArray(rt.latest_trends)  && rt.latest_trends.length)  ||
    (Array.isArray(rt.legal_updates)  && rt.legal_updates.length),
  );
}

/**
 * runRealtimeResearch — evidence-based research по теме статьи.
 *
 * @param {object}  args
 * @param {string}  args.topic        — тема статьи (обязательно).
 * @param {string} [args.region]      — регион/гео.
 * @param {string} [args.evidence]    — SERP/конкурентный/статейный evidence.
 * @param {string} [args.sourceContext] — дополнительный подтверждённый контекст.
 * @param {object} [args.callOptions] — прокидывается в callLLM через router.
 * @returns {Promise<object|null>}    — { realtime_facts, expert_quotes,
 *                                      latest_trends, legal_updates } или null.
 */
async function runRealtimeResearch({
  topic,
  region,
  evidence = '',
  sourceContext = '',
  targetUrl = '',
  taskId = null,
  pipeline = 'info_article',
  callOptions = {},
} = {}) {
  if (!topic || !String(topic).trim()) return null;

  const qwenEnabled = !['0', 'false', 'no', 'off'].includes(
    String(process.env.CONTENT_QWEN_RESEARCH_ENABLED || 'true').toLowerCase(),
  );
  let qwenConfigured = false;
  if (qwenEnabled) {
    try {
      const qwenInfo = await getIntegrationSecretInfo('DASHSCOPE_API_KEY');
      qwenConfigured = Boolean(qwenInfo?.configured);
    } catch (_) {
      qwenConfigured = false;
    }
  }
  const legacyConfigured = await hasResearchProviderAsync();
  if (!qwenConfigured && !legacyConfigured) return null;

  const synthTask = {
    input_target_service: String(topic),
    input_region: region || '',
  };
  const system = fillPromptVars(SYSTEM_PROMPTS_EXT.deepseekResearcher, synthTask);
  const evidenceBlock = [evidence, sourceContext]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 30000);

  let qwenResearch = null;
  if (qwenConfigured) {
    try {
      const qwenResult = await runQwenResearchAgent({
        task: {
          input_target_service: String(topic),
          input_target_url: targetUrl || '',
          input_region: region || '',
          input_language: 'ru',
          input_target_audience: String(sourceContext || '').slice(0, 4000),
          input_business_goal: String(sourceContext || '').slice(0, 4000),
        },
        existingEvidence: evidenceBlock,
        taskId,
        log: callOptions.log,
        onTokens: callOptions.onTokens,
        pipeline,
        stageName: 'pre_stage0_research',
        callLabel: `${pipeline === 'link_article' ? 'Link Article' : 'Blog'} Qwen Research Agent`,
      });
      qwenResearch = normalizeResearch(qwenResult?.raw, {
        provider: 'qwen',
        model: qwenResult?.model || 'qwen3.8-max',
        providers: ['qwen'],
      });
    } catch (qwenError) {
      if (typeof callOptions.log === 'function') {
        await callOptions.log(`⚠ Qwen research недоступен: ${qwenError.message} — fallback на DeepSeek/Gemini`, 'warn');
      }
    }
  }

  const qwenEvidence = qwenResearch && hasRealtimeData(qwenResearch)
    ? JSON.stringify(qwenResearch).slice(0, 24000)
    : '';
  const synthesisEvidence = [evidenceBlock, qwenEvidence]
    .filter(Boolean)
    .join('\n\nQWEN WEB EVIDENCE (требует проверки):\n\n');
  const context = [
    `Статья/тема: ${topic}. Регион: ${region || 'Россия'}.`,
    'SOURCE EVIDENCE (единственный источник фактов; при отсутствии evidence верни пустые массивы):',
    evidenceBlock || '[нет переданного evidence]',
  ].join('\n\n');

  try {
    const result = legacyConfigured
      ? await callResearchProvider({
          system,
          prompt: context.replace(evidenceBlock || '[нет переданного evidence]', synthesisEvidence || '[нет переданного evidence]'),
          callOptions,
          callLabel: 'Research Evidence (DeepSeek validation)',
          log: callOptions.log,
        })
      : null;
    if (result) {
      return normalizeResearch(result.raw, {
        provider: qwenResearch ? 'qwen+deepseek' : (result.provider || 'deepseek'),
        model: result.model || null,
        providers: qwenResearch ? ['qwen', result.provider || 'deepseek'] : [result.provider || 'deepseek'],
      });
    }
    return qwenResearch || null;
  } catch (_) {
    return null;
  }
}

function formatList(items, max) {
  return items
    .slice(0, max)
    .map((x) => `- ${x}`)
    .join('\n');
}

/**
 * renderRealtimeDataSection — markdown-секция «RESEARCH EVIDENCE» для IAKB/LAKB.
 * Совпадает по смыслу с §2b основной AKB (articleKnowledgeBase.js). Все блоки
 * опциональны; если данных нет — возвращает пустую строку.
 *
 * @param {object|null} rt
 * @param {object} [opts]
 * @param {string} [opts.heading] — заголовок секции (по умолчанию §2b).
 * @returns {string}
 */
function renderRealtimeDataSection(rt, opts = {}) {
  if (!hasRealtimeData(rt)) return '';
  const providerLabel = rt?.research_providers?.length
    ? rt.research_providers.join(' + ')
    : (rt?.research_provider || 'DeepSeek/Gemini');
  const heading = opts.heading || `## §2b. RESEARCH EVIDENCE — ${providerLabel}`;

  const out = [
    heading,
    '',
    'Ниже приведены только evidence-grounded факты и сигналы из переданного ' +
    'контекста. Не называй данные свежими без даты/источника, не добавляй ' +
    'неподтверждённые цены или законы. Каждую цитату сопровождай автором, ' +
    'должностью и источником; при отсутствии подтверждения не используй её.',
  ];

  const rtFacts = Array.isArray(rt.realtime_facts) ? rt.realtime_facts : [];
  if (rtFacts.length) {
    const facts = rtFacts
      .map((f) => {
        if (typeof f === 'string') return f;
        if (!f || typeof f !== 'object') return '';
        const parts = [f.fact, f.value].filter(Boolean).join(' — ');
        return f.source ? `${parts} (источник: ${f.source})` : parts;
      })
      .filter(Boolean);
    if (facts.length) out.push('', '### Актуальные факты и цифры', formatList(facts, 12));
  }

  const rtQuotes = Array.isArray(rt.expert_quotes) ? rt.expert_quotes : [];
  if (rtQuotes.length) {
    const quotes = rtQuotes
      .map((q) => {
        if (typeof q === 'string') return q;
        if (!q || typeof q !== 'object') return '';
        const attribution = [q.author, q.role].filter(Boolean).join(', ');
        const src = q.source ? ` [${q.source}]` : '';
        return q.quote ? `«${q.quote}» — ${attribution || 'эксперт'}${src}` : '';
      })
      .filter(Boolean);
    if (quotes.length) out.push('', '### Реальные цитаты экспертов', formatList(quotes, 8));
  }

  const rtTrends = Array.isArray(rt.latest_trends) ? rt.latest_trends : [];
  if (rtTrends.length) {
    out.push('', '### Последние тренды и новости', formatList(rtTrends.filter(Boolean), 8));
  }

  const rtLegal = Array.isArray(rt.legal_updates) ? rt.legal_updates : [];
  if (rtLegal.length) {
    out.push('', '### Изменения в законодательстве / ценах', formatList(rtLegal.filter(Boolean), 8));
  }

  return out.join('\n');
}

module.exports = {
  runRealtimeResearch,
  normalizeResearch,
  hasRealtimeData,
  renderRealtimeDataSection,
};
