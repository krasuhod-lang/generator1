'use strict';

/**
 * audienceResearch.service — мост между Reddit Mapper V2 и info-article
 * генератором. Прогоняет redditMapperPipeline (7 этапов исследования
 * «голоса аудитории») и отдаёт исследовательский дайджест, который IAKB
 * рендерит как §10 (Information-Gain топливо: реальные боли, язык, вопросы,
 * приоритетные темы).
 *
 * Дизайн (см. план «§10 в генераторе»):
 *   1. Фиче-флаг qualityLayers/featureFlags.audienceResearch — без ENV, по
 *      умолчанию ВЫКЛ. Когда выключен — возвращаем digest=null, pipeline идёт
 *      как раньше (graceful).
 *   2. A/B: детерминированный бакет по taskId. Тест-группа получает §10,
 *      контрольная — нет (для сравнения качества). abSampleRatio задаёт долю
 *      тест-группы.
 *   3. Кэш по ключу niche|geo (одна тема/регион → один прогон 7 этапов),
 *      in-memory с TTL — экономит LLM-вызовы при пакетной генерации.
 *   4. GRACEFUL: любая ошибка (промты недоступны, сбой LLM, нет сигнала) →
 *      digest=null + meta.skipped_reason; статья генерируется без §10.
 *
 * Возвращаемый meta — наблюдаемая телеметрия A/B (сохраняется в колонку
 * info_article_tasks.audience_research для офлайн-сравнения групп).
 */

const crypto = require('crypto');
const { getQualityFlags } = require('../qualityLayers/featureFlags');
const { runRedditMapperPipeline } = require('../redditMapper/redditMapperPipeline');
const { areRedditMapperPromptsAvailable } = require('../../prompts/redditMapper');

// ── In-memory TTL-кэш дайджеста по niche|geo ─────────────────────────
// Map сохраняет порядок вставки — используем его для FIFO-эвикции при
// переполнении cacheMaxEntries.
const _cache = new Map(); // key -> { digest, expiresAt }

function _now() { return Date.now(); }

function _cacheKey(brief = {}) {
  const niche = String(brief.niche || '').trim().toLowerCase();
  const geo = String(brief.geo || '').trim().toLowerCase();
  return `${niche}|${geo}`;
}

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= _now()) {
    _cache.delete(key);
    return null;
  }
  return hit.digest;
}

function _cacheSet(key, digest, ttlMs, maxEntries) {
  _cache.set(key, { digest, expiresAt: _now() + ttlMs });
  // FIFO-эвикция самых старых записей при переполнении.
  while (_cache.size > maxEntries) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

function _clearCache() { _cache.clear(); }

/**
 * _abBucket — детерминированный A/B-бакет по taskId.
 * ratio>=1 → всегда 'test'; ratio<=0 → всегда 'control'. Иначе берём
 * первые 4 байта sha256(taskId) как равномерное число в [0,1).
 */
function _abBucket(taskId, ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return 'control';
  if (r >= 1) return 'test';
  const h = crypto.createHash('sha256').update(String(taskId == null ? '' : taskId)).digest();
  const v = h.readUInt32BE(0) / 0xFFFFFFFF;
  return v < r ? 'test' : 'control';
}

function _asLabelArray(value, max = 8) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    let label = '';
    if (typeof item === 'string') label = item;
    else if (item && typeof item === 'object') {
      label = item.label || item.title || item.name || item.question || item.text || '';
    }
    label = String(label || '').trim();
    if (label) out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * _buildBrief — компактный стартовый бриф для redditMapperPipeline из
 * данных задачи и ранних DeepSeek-стадий. Извлечение защитное: формы
 * strategy/audience/intents могут отличаться, неизвестные поля игнорируем.
 */
function _buildBrief({ task = {}, strategy = null, audience = null, intents = null } = {}) {
  const brief = {
    niche: String(task.topic || '').trim(),
    geo: String(task.region || '').trim(),
    brand_name: String(task.brand_name || task.brand || '').trim(),
    seed_topics: [],
    manual_context_from_user: '',
  };

  try {
    if (strategy && typeof strategy === 'object') {
      const summary = strategy.summary || strategy.strategic_context || strategy.context || '';
      if (summary) brief.manual_context_from_user = String(summary).slice(0, 2000);
      if (!brief.niche && strategy.niche) brief.niche = String(strategy.niche).trim();
    }
  } catch (_) { /* graceful */ }

  try {
    const seeds = [];
    if (intents && typeof intents === 'object') {
      seeds.push(..._asLabelArray(intents.user_questions, 6));
      seeds.push(..._asLabelArray(intents.intents, 4));
      seeds.push(..._asLabelArray(intents.jtbd, 4));
    }
    if (audience && typeof audience === 'object') {
      seeds.push(..._asLabelArray(audience.segments, 3));
    }
    // dedup + cap
    brief.seed_topics = Array.from(new Set(seeds.filter(Boolean))).slice(0, 12);
  } catch (_) { /* graceful */ }

  return brief;
}

function _countSignals(digest) {
  if (!digest || typeof digest !== 'object') return 0;
  let n = 0;
  for (const key of Object.keys(digest)) {
    if (Array.isArray(digest[key])) n += digest[key].length;
  }
  return n;
}

/**
 * resolveAudienceResearch — вернуть дайджест «голоса аудитории» для §10 или
 * null (graceful) + наблюдаемую A/B-телеметрию.
 *
 * @param {object}   args
 * @param {object}   args.task        — задача info_article (нужны id, topic, region)
 * @param {object}  [args.strategy]   — выход pre-strategy стадии
 * @param {object}  [args.audience]   — выход stage0 (ЦА)
 * @param {object}  [args.intents]    — выход stage1 (интенты/вопросы)
 * @param {object}  [args.ctx]        — callLLM-контекст ({ log, onTokens }) для метрик/SSE
 * @param {object}  [deps]            — DI для тестов ({ runPipeline })
 * @returns {Promise<{ digest: object|null, meta: object }>}
 */
async function resolveAudienceResearch(args = {}, deps = {}) {
  const { task = {}, strategy = null, audience = null, intents = null, ctx = null } = args;
  const runPipeline = typeof deps.runPipeline === 'function' ? deps.runPipeline : runRedditMapperPipeline;

  // deps.flags — DI для тестов (по умолчанию читаем frozen-конфиг продукта).
  const cfg = deps.flags || getQualityFlags().audienceResearch;
  const taskId = task && (task.id != null ? task.id : task.task_id);

  const meta = {
    enabled: !!cfg.enabled,
    ab_bucket: null,
    ab_sample_ratio: cfg.abSampleRatio,
    cache_hit: false,
    has_signal: false,
    signal_count: 0,
    included: false,
    skipped_reason: null,
    stages_run: [],
    errors: [],
  };

  if (!cfg.enabled) {
    meta.skipped_reason = 'flag_disabled';
    return { digest: null, meta };
  }

  const bucket = _abBucket(taskId, cfg.abSampleRatio);
  meta.ab_bucket = bucket;
  if (bucket === 'control') {
    meta.skipped_reason = 'ab_control';
    return { digest: null, meta };
  }

  if (!areRedditMapperPromptsAvailable()) {
    meta.skipped_reason = 'prompts_unavailable';
    return { digest: null, meta };
  }

  const brief = _buildBrief({ task, strategy, audience, intents });
  const key = _cacheKey(brief);
  const ttlMs = cfg.cacheTtlMinutes * 60 * 1000;

  let digest = _cacheGet(key);
  if (digest) {
    meta.cache_hit = true;
  } else {
    try {
      const res = await runPipeline(
        { brief },
        {
          provider: cfg.provider,
          log: ctx && typeof ctx.log === 'function' ? ctx.log : undefined,
          onTokens: ctx && typeof ctx.onTokens === 'function' ? ctx.onTokens : undefined,
        },
      );
      digest = res && res.digest ? res.digest : null;
      meta.stages_run = (res && res.stagesRun) || [];
      meta.errors = (res && res.errors) || [];
      if (digest && digest.has_signal) {
        _cacheSet(key, digest, ttlMs, cfg.cacheMaxEntries);
      }
    } catch (err) {
      meta.skipped_reason = 'pipeline_error';
      meta.errors = [{ stage: 'pipeline', error: err && err.message ? err.message : String(err) }];
      return { digest: null, meta };
    }
  }

  meta.has_signal = !!(digest && digest.has_signal);
  meta.signal_count = _countSignals(digest);

  if (!meta.has_signal) {
    meta.skipped_reason = meta.skipped_reason || 'no_signal';
    return { digest: null, meta };
  }

  meta.included = true;
  return { digest, meta };
}

module.exports = {
  resolveAudienceResearch,
  // экспортируем helpers для unit-тестов
  _abBucket,
  _buildBrief,
  _cacheKey,
  _countSignals,
  _clearCache,
};
