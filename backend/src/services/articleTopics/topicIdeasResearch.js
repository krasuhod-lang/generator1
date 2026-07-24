'use strict';

/**
 * topicIdeasResearch — Perplexity-исследователь интентов для режима подбора
 * тем статей (article_topic_tasks, mode='topic_ideas').
 *
 * В отличие от общего services/llm/realtimeResearch (который собирает свежие
 * факты/цифры/законы для writer'а статьи) этот модуль собирает РЕАЛЬНЫЙ
 * поисковый спрос ниши: живые формулировки запросов, их интенты/фасеты/стадию
 * воронки, вопросы People-Also-Ask и AI Overviews, смежные семантические темы
 * и ключевые сущности. Эти данные подмешиваются в промт topicIdeas.txt, чтобы
 * Gemini строил план тем строго от интентов пользователя и покрывал как
 * классический поиск, так и ответы ИИ-выдачи.
 *
 * Fail-open: без PERPLEXITY_API_KEY или при любой ошибке возвращает null, и
 * подбор тем продолжается без real-time данных (как раньше).
 */

const { callLLM } = require('../llm/callLLM');
const { fillPromptVars } = require('../../utils/fillPromptVars');
const { SYSTEM_PROMPTS_EXT } = require('../../prompts/systemPrompts');

/**
 * Приводит сырой ответ Perplexity (контракт perplexityTopicResearcher) к
 * единой форме с гарантированными массивами.
 * @param {object|null} raw
 * @returns {{user_intents:Array, adjacent_topics:Array, paa_questions:Array,
 *   ai_overview_questions:Array, semantic_entities:Array, current_stats:Array,
 *   latest_trends:Array}|null}
 */
function normalizeTopicResearch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    user_intents:          arr(raw.user_intents),
    adjacent_topics:       arr(raw.adjacent_topics),
    paa_questions:         arr(raw.paa_questions),
    ai_overview_questions: arr(raw.ai_overview_questions),
    semantic_entities:     arr(raw.semantic_entities),
    current_stats:         arr(raw.current_stats),
    latest_trends:         arr(raw.latest_trends),
  };
}

/**
 * @param {object|null} r — нормализованный результат runTopicIdeasResearch.
 * @returns {boolean} — есть ли хоть какие-то полезные данные.
 */
function hasTopicResearch(r) {
  if (!r || typeof r !== 'object') return false;
  return Boolean(
    (Array.isArray(r.user_intents)          && r.user_intents.length)          ||
    (Array.isArray(r.adjacent_topics)       && r.adjacent_topics.length)       ||
    (Array.isArray(r.paa_questions)         && r.paa_questions.length)         ||
    (Array.isArray(r.ai_overview_questions) && r.ai_overview_questions.length) ||
    (Array.isArray(r.semantic_entities)     && r.semantic_entities.length)     ||
    (Array.isArray(r.current_stats)         && r.current_stats.length)         ||
    (Array.isArray(r.latest_trends)         && r.latest_trends.length),
  );
}

/**
 * runTopicIdeasResearch — единичный вызов Perplexity sonar-pro по нише.
 *
 * @param {object}  args
 * @param {string}  args.niche       — ниша/тема (обязательно).
 * @param {string} [args.region]     — регион/гео.
 * @param {string} [args.audience]   — описание ЦА (для точности ресёрча).
 * @param {string} [args.brandHint]  — краткое описание бренда.
 * @param {string} [args.targetUrl]  — URL целевой страницы.
 * @param {object} [args.callOptions] — прокидывается в callLLM.
 * @returns {Promise<object|null>}
 */
async function runTopicIdeasResearch({ niche, region, audience, brandHint, targetUrl, callOptions = {} } = {}) {
  if (!niche || !String(niche).trim()) return null;
  // Fail-open: без ключа Perplexity не дёргаем сеть — сразу null.
  if (!process.env.PERPLEXITY_API_KEY) return null;

  const synthTask = { input_target_service: String(niche), input_region: region || 'Россия' };
  const system = fillPromptVars(SYSTEM_PROMPTS_EXT.perplexityTopicResearcher, synthTask);

  const contextParts = [
    `Собери реальный поисковый спрос и интенты пользователей по нише: ${niche}.`,
    `Регион: ${region || 'Россия'}.`,
  ];
  if (audience && String(audience).trim())  contextParts.push(`Целевая аудитория: ${String(audience).slice(0, 300)}.`);
  if (brandHint && String(brandHint).trim()) contextParts.push(`Бренд/проект: ${String(brandHint).slice(0, 300)}.`);
  if (targetUrl && String(targetUrl).trim()) contextParts.push(`Целевая страница: ${String(targetUrl).slice(0, 300)}.`);
  const context = contextParts.join(' ');

  try {
    const raw = await callLLM('perplexity', system, context, {
      retries: 2,
      temperature: 0.2,
      callLabel: 'Topic Intent Research (Perplexity)',
      ...callOptions,
    });
    return normalizeTopicResearch(raw);
  } catch (_) {
    // Fail-open: подбор тем продолжается без real-time данных.
    return null;
  }
}

function _clip(s, n) {
  const str = String(s == null ? '' : s).trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * renderTopicResearchBlock — markdown-блок с реальными интентами/смежными
 * темами/PAA для подстановки в плейсхолдер {{REALTIME_RESEARCH_BLOCK}} промта
 * topicIdeas.txt. Если данных нет — возвращает fallback-строку.
 *
 * @param {object|null} r
 * @param {object} [opts]
 * @param {string} [opts.fallback] — что вернуть при отсутствии данных.
 * @returns {string}
 */
function renderTopicResearchBlock(r, opts = {}) {
  const fallback = opts.fallback != null
    ? opts.fallback
    : '(real-time ресёрч недоступен — опирайся на нишу, аудиторию и собственные знания об интентах)';
  if (!hasTopicResearch(r)) return fallback;

  const out = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'REAL-TIME РЕСЁРЧ ИНТЕНТОВ (Perplexity sonar-pro, веб-поиск)',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Ниже — РЕАЛЬНЫЕ поисковые запросы, вопросы и смежные темы, собранные',
    'веб-поиском по этой нише. Строй план тем СТРОГО от этих интентов',
    'пользователей. Используй смежные темы и семантические кластеры, чтобы',
    'полностью покрыть спектр интентов и семантику. Формулируй темы так,',
    'чтобы они ранжировались в классическом поиске И попадали в ответы',
    'ИИ-выдачи (AI Overviews). Не искажай данные и не выдумывай источники.',
  ];

  const intents = Array.isArray(r.user_intents) ? r.user_intents : [];
  if (intents.length) {
    out.push('', '### Реальные поисковые интенты (запрос → интент / фасет / стадия)');
    intents.slice(0, 20).forEach((it) => {
      if (typeof it === 'string') { out.push(`- ${_clip(it, 160)}`); return; }
      if (!it || typeof it !== 'object') return;
      const q = _clip(it.query, 160);
      if (!q) return;
      const meta = [it.intent, it.facet, it.stage].filter(Boolean).map((x) => _clip(x, 40)).join(' / ');
      out.push(meta ? `- «${q}» — ${meta}` : `- «${q}»`);
    });
  }

  const adjacent = Array.isArray(r.adjacent_topics) ? r.adjacent_topics : [];
  if (adjacent.length) {
    out.push('', '### Смежные темы для расширения охвата (semantic coverage)');
    adjacent.slice(0, 15).forEach((a) => {
      if (typeof a === 'string') { out.push(`- ${_clip(a, 160)}`); return; }
      if (!a || typeof a !== 'object') return;
      const topic = _clip(a.topic, 160);
      if (!topic) return;
      const tail = [a.semantic_cluster ? `кластер: ${_clip(a.semantic_cluster, 60)}` : '', a.why ? _clip(a.why, 120) : '']
        .filter(Boolean).join('; ');
      out.push(tail ? `- ${topic} (${tail})` : `- ${topic}`);
    });
  }

  const paa = (Array.isArray(r.paa_questions) ? r.paa_questions : []).map((q) => _clip(q, 160)).filter(Boolean);
  if (paa.length) {
    out.push('', '### Вопросы People-Also-Ask');
    paa.slice(0, 15).forEach((q) => out.push(`- ${q}`));
  }

  const aiq = (Array.isArray(r.ai_overview_questions) ? r.ai_overview_questions : []).map((q) => _clip(q, 160)).filter(Boolean);
  if (aiq.length) {
    out.push('', '### Вопросы для ИИ-выдачи (AI Overviews)');
    aiq.slice(0, 15).forEach((q) => out.push(`- ${q}`));
  }

  const ents = (Array.isArray(r.semantic_entities) ? r.semantic_entities : []).map((e) => _clip(e, 80)).filter(Boolean);
  if (ents.length) {
    out.push('', '### Ключевые сущности / LSI', `- ${ents.slice(0, 30).join(', ')}`);
  }

  const stats = Array.isArray(r.current_stats) ? r.current_stats : [];
  if (stats.length) {
    out.push('', '### Актуальные факты и цифры');
    stats.slice(0, 10).forEach((f) => {
      if (typeof f === 'string') { out.push(`- ${_clip(f, 200)}`); return; }
      if (!f || typeof f !== 'object') return;
      const parts = [f.fact, f.value].filter(Boolean).map((x) => _clip(x, 140)).join(' — ');
      if (!parts) return;
      out.push(f.source ? `- ${parts} (источник: ${_clip(f.source, 80)})` : `- ${parts}`);
    });
  }

  const trends = (Array.isArray(r.latest_trends) ? r.latest_trends : []).map((t) => _clip(t, 200)).filter(Boolean);
  if (trends.length) {
    out.push('', '### Последние тренды (обоснование «почему сейчас»)');
    trends.slice(0, 8).forEach((t) => out.push(`- ${t}`));
  }

  return out.join('\n');
}

module.exports = {
  runTopicIdeasResearch,
  normalizeTopicResearch,
  hasTopicResearch,
  renderTopicResearchBlock,
};
