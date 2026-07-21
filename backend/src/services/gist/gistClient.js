/**
 * gistClient — HTTP-клиент к FastAPI gist_py/:8003 (GIST Content Logic).
 *
 * Точка интеграции A (ТЗ «GIST Content Logic»): Node-пайплайны (SEO Stage 0,
 * инфо Stage 1B) вызывают M2+M3 Gap Finder Python-сервиса и получают готовые
 * JSON-артефакты { information_delta, gist_score, top10_claims }.
 *
 * Принцип fail-open: клиент бросает исключения — вызывающая сторона обязана
 * оборачивать вызовы в Promise.allSettled/try-catch и продолжать без дельты,
 * если GIST недоступен.
 *
 * ENV:
 *   GIST_SERVICE_URL    — базовый URL сервиса (default: http://gist:8003)
 *   GIST_INTERNAL_TOKEN — X-Internal-Token (тот же, что GIST_INTERNAL_TOKEN gist_py)
 */

'use strict';

const axios = require('axios');

const GIST_URL   = process.env.GIST_SERVICE_URL || 'http://gist:8003';
const GIST_TOKEN = process.env.GIST_INTERNAL_TOKEN;

function _headers() {
  const headers = {};
  if (GIST_TOKEN) headers['X-Internal-Token'] = GIST_TOKEN;
  return headers;
}

/**
 * M2+M3 Gap Finder: шум конкурентов → информационная дельта.
 *
 * @param {object} params
 * @param {string} params.keyword — основной запрос/тема
 * @param {string[]} [params.competitors_text] — готовые тексты конкурентов
 *        (Stage 0 Node-скрейпера); если не передано — gist_py скрейпит сам (M1)
 * @param {string} [params.page_type] — 'seo' | 'info' | 'link'
 * @param {string} [params.target_audience]
 * @returns {Promise<{information_delta: string[], gist_score: number|null, top10_claims: string[]}>}
 */
async function runGistGapFinder({ keyword, competitors_text, page_type, target_audience } = {}) {
  const response = await axios.post(
    `${GIST_URL}/pipeline/run`,
    {
      keyword,
      query: keyword,
      competitors_text: Array.isArray(competitors_text)
        ? competitors_text.filter((t) => typeof t === 'string' && t.trim())
        : undefined,
      page_type: page_type || '',
      target_audience: target_audience || '',
      modules: ['M2', 'M3'],
    },
    { headers: _headers(), timeout: 45000 },
  );
  const data = response.data || {};
  return {
    information_delta: Array.isArray(data.information_delta) ? data.information_delta : [],
    gist_score:        data.gist_score ?? null,
    top10_claims:      Array.isArray(data.top10_claims) ? data.top10_claims : [],
  };
}

/**
 * M-1 Topic Discovery (InfoGapRadar): агрегированные сигналы спроса/предложения
 * → topic_state (void|lack|balance|abundance) + go/no-go + подниши.
 *
 * @param {object} params
 * @param {string} params.query — ключевой запрос/тема
 * @param {object|null} [params.trends_data] — сигналы Google Trends (demand/supply)
 * @param {Array|object|null} [params.reddit_insights] — боли/темы аудитории (Reddit Mapper)
 * @param {Array|object|null} [params.paa_questions] — вопросы People Also Ask
 * @returns {Promise<{topic_status:string, topic_score:number|null,
 *   go_decision:boolean, sub_niche_suggestions:string[], reasoning:string,
 *   manual_review?:boolean}>}
 */
async function runTopicDiscovery({ query, trends_data = null, reddit_insights = null, paa_questions = null } = {}) {
  const response = await axios.post(
    `${GIST_URL}/topic/discover`,
    {
      query,
      trends_data: trends_data || null,
      reddit_insights: reddit_insights || null,
      paa_questions: paa_questions || null,
    },
    { headers: _headers(), timeout: 45000 },
  );
  const data = response.data || {};
  const suggestions = Array.isArray(data.sub_niche_suggestions) ? data.sub_niche_suggestions : [];
  return {
    topic_status: typeof data.topic_status === 'string' ? data.topic_status : 'balance',
    topic_score: data.topic_score ?? null,
    go_decision: data.go_decision !== false,
    sub_niche_suggestions: suggestions,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
    manual_review: data.manual_review === true,
  };
}

/**
 * M0 Relevance Scanner для одного ключа.
 * @param {object} params — { keyword }
 * @returns {Promise<{aio_group: string|null, trigger_rate: number|null, intent_type: string|null}>}
 */
async function scanRelevance({ keyword } = {}) {
  const response = await axios.post(
    `${GIST_URL}/relevance/scan`,
    { queries: [keyword] },
    { headers: _headers(), timeout: 10000 },
  );
  const first = (response.data && response.data.results && response.data.results[0]) || {};
  return {
    aio_group:    first.trigger_group ?? null,
    trigger_rate: first.trigger_rate ?? null,
    intent_type:  first.content_type ?? null,
    raw:          first,
  };
}

// ── Математика объединения белых пятен и GIST-дельты ────────────────────────
// ContentGap_merged = WhiteSpace ∪ InformationDelta ∖ Top10Claims

/** Идентичность claim'а: claim_id (если есть) или нормализованный текст. */
function _claimKey(item) {
  if (item && typeof item === 'object') {
    if (item.claim_id != null) return String(item.claim_id);
    return String(item.claim || item.thesis || item.topic || JSON.stringify(item))
      .trim().toLowerCase();
  }
  return String(item ?? '').trim().toLowerCase();
}

/**
 * mergeContentGaps — объединяет белые пятна DeepSeek с GIST-дельтой.
 * weight: 1.4 для GIST-дельты — буст смысловой уникальности перед Stage 2.
 *
 * @param {object|array} whiteSpace — объект white_space ({gaps: [...]}) или массив gaps
 * @param {array} informationDelta — тезисы M3 (строки или {claim_id, claim, ...})
 * @param {array} top10Claims — шум конкурентов M2
 */
function mergeContentGaps(whiteSpace, informationDelta, top10Claims) {
  const gaps = Array.isArray(whiteSpace)
    ? whiteSpace
    : (whiteSpace && Array.isArray(whiteSpace.gaps) ? whiteSpace.gaps : []);
  const delta  = Array.isArray(informationDelta) ? informationDelta : [];
  const claims = Array.isArray(top10Claims) ? top10Claims : [];

  const claimsSet = new Set(claims.map(_claimKey));
  const uniqueDelta = delta.filter((d) => !claimsSet.has(_claimKey(d)));

  const _asObj = (item) => (item && typeof item === 'object' ? item : { claim: String(item) });

  return {
    base_gaps:  gaps,
    gist_delta: uniqueDelta, // только то, чего нет у конкурентов
    merged_priority: [
      ...uniqueDelta.map((d) => ({ ..._asObj(d), source: 'gist', weight: 1.4 })),
      ...gaps.map((g) => ({ ..._asObj(g), source: 'whitespace', weight: 1.0 })),
    ].sort((a, b) => b.weight - a.weight),
  };
}

/** Форматирует дельту в маркированный список для §11/§4-GIST блока промптов. */
function formatDeltaAsBullets(informationDelta, { max = 20, maxLen = 300 } = {}) {
  return (Array.isArray(informationDelta) ? informationDelta : [])
    .slice(0, max)
    .map((d) => {
      const text = d && typeof d === 'object'
        ? String(d.claim || d.thesis || d.topic || JSON.stringify(d))
        : String(d ?? '');
      return `- ${text.trim().slice(0, maxLen)}`;
    })
    .filter((l) => l !== '- ')
    .join('\n');
}

/**
 * §11 GIST Delta блок для Stage 2/IAKB. Legacy marker §4-GIST оставлен,
 * чтобы старые промпты/логи не потеряли привязку.
 * Пустая строка, если дельты нет.
 */
function buildGistDeltaBrief(informationDelta) {
  const bullets = formatDeltaAsBullets(informationDelta);
  if (!bullets) return '';
  return [
    '§11 GIST Delta — Missing Semantic Nodes (legacy §4-GIST):',
    'ИНФОРМАЦИОННАЯ ДЕЛЬТА (тезисы, которых нет у конкурентов):',
    bullets,
    '',
    'ИНСТРУКЦИЯ: Каждый тезис из §11 GIST-дельты ДОЛЖЕН быть отражён минимум в одном H2',
    'или в экспертном блоке. Не менее 2 H2 помечай gist_expert=true или [GIST_EXPERT_BLOCK].',
    'GIST Score цели: ≥30% параграфов должны покрывать хотя бы один тезис дельты.',
  ].join('\n');
}

module.exports = {
  runGistGapFinder,
  runTopicDiscovery,
  scanRelevance,
  mergeContentGaps,
  formatDeltaAsBullets,
  buildGistDeltaBrief,
};
