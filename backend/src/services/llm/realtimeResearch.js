'use strict';

/**
 * realtimeResearch — общий «Агент-Ресёрчер» (Perplexity sonar-pro) для
 * пайплайнов статьи в блог (infoArticle) и ссылочной статьи (linkArticle).
 *
 * Основной SEO-пайплайн (services/pipeline/stage0.js) уже вызывает Perplexity
 * как real-time research-агента и кладёт результат в §2b REAL-TIME DATA основной
 * Article Knowledge Base. Этот модуль переиспользует ту же логику (тот же
 * системный промпт SYSTEM_PROMPTS_EXT.perplexityResearcher и модель sonar-pro),
 * чтобы блог- и ссылочные статьи тоже опирались на свежие факты/цифры/законы и
 * реальные цитаты экспертов, а не на устаревшую обучающую выборку DeepSeek/Gemini.
 *
 * Fail-open: без PERPLEXITY_API_KEY или при любой ошибке возвращает null, и
 * пайплайн продолжает работу без актуальных данных (как раньше).
 */

const { callLLM } = require('./callLLM');
const { fillPromptVars } = require('../../utils/fillPromptVars');
const { SYSTEM_PROMPTS_EXT } = require('../../prompts/systemPrompts');

/**
 * Приводит сырой ответ Perplexity (JSON-контракт perplexityResearcher) к
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
 * runRealtimeResearch — единичный вызов Perplexity sonar-pro по теме статьи.
 *
 * @param {object}  args
 * @param {string}  args.topic        — тема статьи (обязательно).
 * @param {string} [args.region]      — регион/гео (для точности ресёрча).
 * @param {object} [args.callOptions] — прокидывается в callLLM (log/onTokens/
 *                                      stageName/traceTaskId/pipeline и т.д.).
 * @returns {Promise<object|null>}    — { realtime_facts, expert_quotes,
 *                                      latest_trends, legal_updates } или null.
 */
async function runRealtimeResearch({ topic, region, callOptions = {} } = {}) {
  if (!topic || !String(topic).trim()) return null;
  // Fail-open: без ключа Perplexity не дёргаем сеть — сразу null.
  if (!process.env.PERPLEXITY_API_KEY) return null;

  const synthTask = { input_target_service: String(topic), input_region: region || '' };
  const system  = fillPromptVars(SYSTEM_PROMPTS_EXT.perplexityResearcher, synthTask);
  const context = `Собери актуальные данные для темы: ${topic}. Регион: ${region || 'Россия'}.`;

  try {
    const raw = await callLLM('perplexity', system, context, {
      retries: 2,
      temperature: 0.2,
      callLabel: 'Real-Time Research (Perplexity)',
      ...callOptions,
    });
    return normalizeResearch(raw);
  } catch (_) {
    // Fail-open: пайплайн продолжается без актуальных данных.
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
 * renderRealtimeDataSection — markdown-секция «REAL-TIME DATA» для IAKB/LAKB.
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
  const heading = opts.heading || '## §2b. REAL-TIME DATA (2026) — актуальные данные веб-поиска (Perplexity)';

  const out = [
    heading,
    '',
    'Свежие данные текущего месяца, собранные веб-поиском (Perplexity sonar-pro). ' +
    'Опирайся на эти актуальные факты, цифры и реальные цитаты экспертов вместо ' +
    'выдуманных данных. Каждую цитату сопровождай именем и должностью автора. ' +
    'ЗАПРЕЩЕНО искажать цифры и приписывать несуществующие источники.',
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
