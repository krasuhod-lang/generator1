'use strict';

/**
 * topicDiscovery.service — Node-оркестратор M-1 Topic Discovery (InfoGapRadar).
 *
 * Собирает реальные сигналы спроса/предложения ДО запуска генерации статьи и
 * вызывает FastAPI-эндпоинт gist_py POST /topic/discover, получая go/no-go
 * решение и статус темы (void|lack|balance|abundance).
 *
 * Источники сигналов (ТЗ §1.1):
 *   1. Reddit Mapper (services/redditMapper) — «боли» и темы аудитории по нише.
 *      Переиспользуем существующий runRedditMapperPipeline; из накопительного
 *      master JSON берём компактный digest (core_pains, must_cover_topics …).
 *   2. PAA (People Also Ask) — вопросы из serpVerification.cases[].paa
 *      (тот же источник, что contentGapPlanner/gapDetector).
 *   3. Google Trends — trendsCollector.collectTrends (demand_signal, related).
 *
 * Принципы:
 *   • Каждый источник fail-open по отдельности: сбой одного не роняет остальные
 *     и не роняет пайплайн — просто передаём то, что собрали.
 *   • Все внешние зависимости инъектируемы (deps) → модуль юнит-тестируется
 *     полностью на моках, без сети.
 *   • Итог нормализуется в стабильный контракт для пайплайна:
 *       { topic_state, topic_score, sub_niche_suggestions, manual_review,
 *         reasoning, go_decision, signals_used }
 */

const gistClient = require('../gist/gistClient');
const trendsCollector = require('./trendsCollector');

const ALLOWED_STATES = ['void', 'lack', 'balance', 'abundance'];

function _bool(v, dflt) {
  if (v == null) return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

function _isEnabled() {
  return _bool(process.env.TOPIC_DISCOVERY_ENABLED, true);
}

function _asStringList(value, limit = 10) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const s = String(item == null ? '' : item).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Извлечь боли/темы аудитории из Reddit Mapper (fail-open).
 * @returns {Promise<Array<string>>}
 */
async function _collectRedditInsights({ niche, brief, deps, log }) {
  const runner = deps.runRedditMapperPipeline;
  if (typeof runner !== 'function') return [];
  try {
    const input = {
      brief: brief || { niche: niche || '' },
    };
    // Достаточно этапов боли/приоритизации — но переиспользуем текущий интерфейс.
    const result = await runner(input, { log });
    const digest = result && (result.digest || (result.master
      && deps.buildResearchDigest && deps.buildResearchDigest(result.master)));
    if (!digest) return [];
    const insights = []
      .concat(_asStringList(digest.core_pains, 8))
      .concat(_asStringList(digest.must_cover_topics, 6))
      .concat(_asStringList(digest.desired_outcomes, 4));
    return _asStringList(insights, 15);
  } catch (err) {
    log(`[topic-discovery] reddit fail-open: ${err && err.message ? err.message : err}`);
    return [];
  }
}

/**
 * Извлечь вопросы PAA из serpVerification (тот же контракт, что gapDetector).
 * Дополнительно принимает уже готовый массив paaQuestions.
 * @returns {Array<string>}
 */
function _collectPaaQuestions({ paaQuestions, serpVerification }) {
  const collected = [];
  if (Array.isArray(paaQuestions)) collected.push(...paaQuestions);
  if (serpVerification && Array.isArray(serpVerification.cases)) {
    for (const cse of serpVerification.cases) {
      const bucket = (cse && (cse.related_queries || cse.paa)) || [];
      if (Array.isArray(bucket)) collected.push(...bucket);
    }
  }
  return _asStringList(collected, 15);
}

/**
 * Нормализовать ответ M-1 в стабильный контракт пайплайна.
 */
function _normalizeResult(raw, signalsUsed) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let state = String(r.topic_status || r.topic_state || 'balance').toLowerCase();
  if (!ALLOWED_STATES.includes(state)) state = 'balance';
  const score = Number.isFinite(Number(r.topic_score)) ? Number(r.topic_score) : null;
  return {
    topic_state: state,
    topic_score: score,
    go_decision: r.go_decision !== false,
    sub_niche_suggestions: _asStringList(r.sub_niche_suggestions, 10),
    manual_review: r.manual_review === true,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    signals_used: signalsUsed,
    collected_at: new Date().toISOString(),
  };
}

/**
 * Результат при полном отказе/выключении — безопасный «balance + manual_review».
 */
function _safeFallback(signalsUsed, reason) {
  return {
    topic_state: 'balance',
    topic_score: null,
    go_decision: true,
    sub_niche_suggestions: [],
    manual_review: true,
    reasoning: reason || 'Topic Discovery недоступен — требуется ручная проверка.',
    signals_used: signalsUsed || { reddit: 0, paa: 0, trends: false },
    collected_at: new Date().toISOString(),
  };
}

/**
 * runTopicDiscovery — основной вход.
 *
 * @param {object} params
 * @param {string} params.query — ключевой запрос/тема статьи
 * @param {string} [params.niche] — ниша (для Reddit Mapper)
 * @param {object} [params.brief] — проектный бриф для Reddit Mapper
 * @param {Array}  [params.paaQuestions] — готовые вопросы PAA
 * @param {object} [params.serpVerification] — источник PAA (cases[].paa)
 * @param {function} [params.log] — лог-callback
 * @param {object} [params.deps] — инъекция зависимостей (тесты):
 *        { runTopicDiscovery, collectTrends, runRedditMapperPipeline,
 *          buildResearchDigest }
 * @returns {Promise<object>} нормализованный результат (никогда не бросает)
 */
async function runTopicDiscovery(params = {}) {
  const {
    query, niche = '', brief = null, paaQuestions = null, serpVerification = null,
  } = params;
  const log = typeof params.log === 'function' ? params.log : () => {};
  const deps = params.deps || {};

  const signalsUsed = { reddit: 0, paa: 0, trends: false };

  if (!query || !String(query).trim()) {
    return _safeFallback(signalsUsed, 'Пустой запрос — Topic Discovery пропущен.');
  }
  if (!_isEnabled()) {
    return _safeFallback(signalsUsed, 'TOPIC_DISCOVERY_ENABLED=off.');
  }

  // 1) Reddit insights (fail-open).
  const redditInsights = await _collectRedditInsights({ niche, brief, deps, log });
  signalsUsed.reddit = redditInsights.length;

  // 2) PAA (детерминированно, без сети).
  const paa = _collectPaaQuestions({ paaQuestions, serpVerification });
  signalsUsed.paa = paa.length;

  // 3) Google Trends (fail-open null).
  let trendsData = null;
  try {
    const collect = typeof deps.collectTrends === 'function'
      ? deps.collectTrends
      : trendsCollector.collectTrends;
    trendsData = await collect(query, { log });
  } catch (err) {
    log(`[topic-discovery] trends fail-open: ${err && err.message ? err.message : err}`);
    trendsData = null;
  }
  signalsUsed.trends = !!trendsData;

  // 4) Вызов M-1 (fail-open — при недоступности gist_py возвращаем safe fallback).
  try {
    const call = typeof deps.runTopicDiscovery === 'function'
      ? deps.runTopicDiscovery
      : gistClient.runTopicDiscovery;
    const raw = await call({
      query,
      trends_data: trendsData,
      reddit_insights: redditInsights.length ? redditInsights : null,
      paa_questions: paa.length ? paa : null,
    });
    return _normalizeResult(raw, signalsUsed);
  } catch (err) {
    log(`[topic-discovery] gist fail-open: ${err && err.message ? err.message : err}`);
    return _safeFallback(signalsUsed, 'gist_py /topic/discover недоступен — ручная проверка.');
  }
}

module.exports = {
  runTopicDiscovery,
  isEnabled: _isEnabled,
  _internal: {
    _collectRedditInsights, _collectPaaQuestions, _normalizeResult, _safeFallback, _asStringList,
  },
};
