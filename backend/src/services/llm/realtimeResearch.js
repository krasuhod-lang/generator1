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

/**
 * Приводит сырой ответ DeepSeek/Gemini research contract к
 * единой форме, совпадающей с полями stage0Result основного пайплайна.
 * @param {object|null} raw
 * @returns {{realtime_facts:Array, expert_quotes:Array, latest_trends:Array, legal_updates:Array}|null}
 */
function normalizeResearch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    realtime_facts: Array.isArray(raw.current_stats)          ? raw.current_stats          : [],
    expert_quotes:  Array.isArray(raw.expert_quotes)          ? raw.expert_quotes          : [],
    latest_trends:  Array.isArray(raw.latest_trends)          ? raw.latest_trends          : [],
    legal_updates:  Array.isArray(raw.legal_or_price_updates) ? raw.legal_or_price_updates : [],
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
  callOptions = {},
} = {}) {
  if (!topic || !String(topic).trim() || !(await hasResearchProviderAsync())) return null;

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
  const context = [
    `Статья/тема: ${topic}. Регион: ${region || 'Россия'}.`,
    'SOURCE EVIDENCE (единственный источник фактов; при отсутствии evidence верни пустые массивы):',
    evidenceBlock || '[нет переданного evidence]',
  ].join('\n\n');

  try {
    const result = await callResearchProvider({
      system,
      prompt: context,
      callOptions,
      callLabel: 'Research Evidence',
      log: callOptions.log,
    });
    return result ? normalizeResearch(result.raw) : null;
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
  const heading = opts.heading || '## §2b. RESEARCH EVIDENCE — DeepSeek/Gemini';

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
