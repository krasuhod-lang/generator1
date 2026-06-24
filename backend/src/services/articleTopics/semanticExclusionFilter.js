'use strict';

/**
 * semanticExclusionFilter — детектор каннибализации для article-topics
 * (ТЗ §2.3.A).
 *
 * Расширяет «точное совпадение по canon» из topicDuplicateDetector до
 * семантической проверки с fallback-каскадом:
 *   1. Exact / Jaccard-pre-filter — дёшево, синхронно.
 *   2. (опц.) Embeddings-similarity — через инжектируемый embeddingFn.
 *   3. (опц.) LLM-as-a-judge — через инжектируемый llmJudgeFn для
 *      «жёлтой зоны» и проверки попадания в исключённые кластеры.
 *
 * Все «дорогие» зависимости (embeddings, LLM) — опциональны и
 * инжектируются вызывающим (`articleTopicsPipeline`). Если их нет,
 * фильтр работает по cheap pre-filter (как раньше) — это даёт
 * graceful degradation без падений.
 *
 * Вход:
 *   candidates: [{ topic_title|h1, ... }] — кандидаты от LLM (topic_ideas).
 *   exclusions: {
 *     user_topics:    [{ raw, canon, kind:'topic' }],
 *     user_clusters:  [{ raw, canon, kind:'cluster' }],
 *     history:        [{ topic_title_canon, ... }],
 *     cannibalization:[{ query, ... }],
 *     target_url_h1:  string|null,
 *   }
 *   opts: { embeddingFn?, llmJudgeFn?, thresholds? }
 *
 * Выход:
 *   {
 *     kept:    [<candidate>...],
 *     dropped: [{ candidate, reason: 'exact'|'jaccard'|'embedding'|'llm_judge'|'cluster_match', matched: <source> }],
 *     summary: { total_dropped, by_reason: { exact, jaccard, embedding, llm_judge, cluster_match } },
 *     degraded: { embeddings: boolean, llm_judge: boolean }
 *   }
 */

const { canonTitle } = require('./brandKey');

const DEFAULTS = {
  jaccardHardThreshold:    0.6,   // ≥ — считаем экв. exact
  embeddingDropThreshold:  0.82,  // ≥ — отбрасываем сразу
  embeddingJudgeThreshold: 0.72,  // [0.72, 0.82) → отправляем в LLM-judge
  maxJudgePairs:           200,
};

async function filterCannibalizingCandidates(candidates, exclusions, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.thresholds || {}) };
  const embeddingFn = typeof opts.embeddingFn === 'function' ? opts.embeddingFn : null;
  const llmJudgeFn  = typeof opts.llmJudgeFn  === 'function' ? opts.llmJudgeFn  : null;

  const kept = [];
  const dropped = [];
  const summary = { total_dropped: 0, by_reason: { exact: 0, jaccard: 0, embedding: 0, llm_judge: 0, cluster_match: 0 } };
  const degraded = { embeddings: false, llm_judge: false };

  const exclusionTopics = _flattenExclusionTopics(exclusions);
  const exclusionClusters = _flattenClusters(exclusions);

  if (!exclusionTopics.length && !exclusionClusters.length) {
    return { kept: candidates.slice(), dropped, summary, degraded };
  }

  // --- Stage 1: cheap exact / Jaccard pre-filter ---
  const yellow = []; // [{candidate, candIdx, bestExclusion, bestJaccard}]
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    const candCanon = canonTitle(cand.topic_title || cand.title || cand.h1 || '');
    if (!candCanon) { kept.push(cand); continue; }

    let drop = null;
    let bestJac = 0;
    let bestExcl = null;
    for (const ex of exclusionTopics) {
      if (!ex.canon) continue;
      if (ex.canon === candCanon) { drop = { reason: 'exact', matched: ex }; break; }
      const j = _jaccard3(candCanon, ex.canon);
      if (j > bestJac) { bestJac = j; bestExcl = ex; }
    }
    if (!drop && bestJac >= cfg.jaccardHardThreshold) {
      drop = { reason: 'jaccard', matched: bestExcl, score: bestJac };
    }
    if (drop) {
      summary.by_reason[drop.reason] += 1;
      summary.total_dropped += 1;
      dropped.push({ candidate: cand, reason: drop.reason, matched: drop.matched, score: drop.score });
      continue;
    }
    // Жёлтая зона: для embedding / LLM-judge.
    if (bestJac >= 0.25 && bestExcl) {
      yellow.push({ candidate: cand, candCanon, bestExcl, bestJac });
    } else {
      // Зелёная: пропускаем сразу, но клстерная проверка ещё впереди.
      kept.push(cand);
    }
  }

  // --- Stage 2: embeddings (опц.) ---
  if (embeddingFn && yellow.length) {
    try {
      const allTexts = [
        ...yellow.map((y) => y.candCanon),
        ...exclusionTopics.map((e) => e.canon),
      ];
      const vectors = await embeddingFn(allTexts);
      if (!Array.isArray(vectors) || vectors.length !== allTexts.length) {
        throw new Error('embeddingFn returned wrong shape');
      }
      const candVecs = vectors.slice(0, yellow.length);
      const exclVecs = vectors.slice(yellow.length);

      const judgeQueue = []; // [{candIdx, exclIdx, sim}]
      const yellowKept = new Array(yellow.length).fill(true);

      for (let yi = 0; yi < yellow.length; yi += 1) {
        let bestSim = 0;
        let bestEi = -1;
        for (let ei = 0; ei < exclusionTopics.length; ei += 1) {
          const sim = _cosine(candVecs[yi], exclVecs[ei]);
          if (sim > bestSim) { bestSim = sim; bestEi = ei; }
        }
        if (bestSim >= cfg.embeddingDropThreshold && bestEi >= 0) {
          yellowKept[yi] = false;
          summary.by_reason.embedding += 1;
          summary.total_dropped += 1;
          dropped.push({
            candidate: yellow[yi].candidate,
            reason: 'embedding',
            matched: exclusionTopics[bestEi],
            score: bestSim,
          });
        } else if (bestSim >= cfg.embeddingJudgeThreshold && bestEi >= 0) {
          judgeQueue.push({ yi, ei: bestEi, sim: bestSim });
        }
      }

      // --- Stage 3: LLM-judge (опц.) ---
      if (llmJudgeFn && judgeQueue.length) {
        const trimmed = judgeQueue
          .sort((a, b) => b.sim - a.sim)
          .slice(0, cfg.maxJudgePairs);
        try {
          const pairs = trimmed.map(({ yi, ei }) => ({
            candidate: yellow[yi].candCanon,
            exclusion: exclusionTopics[ei].canon,
          }));
          const verdicts = await llmJudgeFn({ kind: 'topic_pairs', pairs });
          if (Array.isArray(verdicts)) {
            for (let k = 0; k < trimmed.length; k += 1) {
              const v = verdicts[k];
              const { yi, ei } = trimmed[k];
              if (yellowKept[yi] && v && v.exclude === true) {
                yellowKept[yi] = false;
                summary.by_reason.llm_judge += 1;
                summary.total_dropped += 1;
                dropped.push({
                  candidate: yellow[yi].candidate,
                  reason: 'llm_judge',
                  matched: exclusionTopics[ei],
                  judge_reason: v.reason || null,
                });
              }
            }
          }
        } catch (e) {
          degraded.llm_judge = true;
        }
      }

      for (let yi = 0; yi < yellow.length; yi += 1) {
        if (yellowKept[yi]) kept.push(yellow[yi].candidate);
      }
    } catch (e) {
      degraded.embeddings = true;
      // Эмбеддинги упали — консервативно не отбрасываем «жёлтые» (false-negative
      // безопаснее false-positive). Если есть LLM-judge — попробуем хотя бы его.
      if (llmJudgeFn) {
        try {
          const pairs = yellow.slice(0, cfg.maxJudgePairs).map((y) => ({
            candidate: y.candCanon, exclusion: y.bestExcl.canon,
          }));
          const verdicts = await llmJudgeFn({ kind: 'topic_pairs', pairs });
          const keptFlags = new Array(yellow.length).fill(true);
          if (Array.isArray(verdicts)) {
            for (let k = 0; k < pairs.length; k += 1) {
              const v = verdicts[k];
              if (v && v.exclude === true) {
                keptFlags[k] = false;
                summary.by_reason.llm_judge += 1;
                summary.total_dropped += 1;
                dropped.push({
                  candidate: yellow[k].candidate,
                  reason: 'llm_judge',
                  matched: yellow[k].bestExcl,
                  judge_reason: v.reason || null,
                });
              }
            }
          }
          for (let i = 0; i < yellow.length; i += 1) {
            if (keptFlags[i]) kept.push(yellow[i].candidate);
          }
        } catch (_) {
          degraded.llm_judge = true;
          for (const y of yellow) kept.push(y.candidate);
        }
      } else {
        for (const y of yellow) kept.push(y.candidate);
      }
    }
  } else {
    // Нет embeddings — «жёлтые» пропускаем (graceful) либо доверяем LLM-judge.
    if (llmJudgeFn && yellow.length) {
      try {
        const trimmed = yellow.slice(0, cfg.maxJudgePairs);
        const pairs = trimmed.map((y) => ({
          candidate: y.candCanon, exclusion: y.bestExcl.canon,
        }));
        const verdicts = await llmJudgeFn({ kind: 'topic_pairs', pairs });
        const keptFlags = new Array(trimmed.length).fill(true);
        if (Array.isArray(verdicts)) {
          for (let k = 0; k < trimmed.length; k += 1) {
            const v = verdicts[k];
            if (v && v.exclude === true) {
              keptFlags[k] = false;
              summary.by_reason.llm_judge += 1;
              summary.total_dropped += 1;
              dropped.push({
                candidate: trimmed[k].candidate,
                reason: 'llm_judge',
                matched: trimmed[k].bestExcl,
                judge_reason: v.reason || null,
              });
            }
          }
        }
        for (let i = 0; i < trimmed.length; i += 1) {
          if (keptFlags[i]) kept.push(trimmed[i].candidate);
        }
        // Хвост yellow за пределами maxJudgePairs — оставляем (graceful).
        for (let i = trimmed.length; i < yellow.length; i += 1) {
          kept.push(yellow[i].candidate);
        }
      } catch (_) {
        degraded.llm_judge = true;
        for (const y of yellow) kept.push(y.candidate);
      }
    } else {
      degraded.embeddings = true;
      for (const y of yellow) kept.push(y.candidate);
    }
  }

  // --- Cluster matching (только LLM-judge — кластеры обычно общие фразы).
  if (exclusionClusters.length && llmJudgeFn && kept.length) {
    try {
      const pairs = [];
      const refs = [];
      for (let i = 0; i < kept.length; i += 1) {
        for (const cl of exclusionClusters) {
          pairs.push({ candidate: canonTitle(kept[i].topic_title || kept[i].title || ''), cluster: cl.canon || cl.raw });
          refs.push({ candIdx: i, cluster: cl });
        }
      }
      const verdicts = await llmJudgeFn({ kind: 'cluster_membership', pairs });
      if (Array.isArray(verdicts) && verdicts.length === pairs.length) {
        const dropIdx = new Set();
        for (let k = 0; k < verdicts.length; k += 1) {
          const v = verdicts[k];
          if (v && v.exclude === true) {
            const { candIdx, cluster } = refs[k];
            if (dropIdx.has(candIdx)) continue;
            dropIdx.add(candIdx);
            summary.by_reason.cluster_match += 1;
            summary.total_dropped += 1;
            dropped.push({
              candidate: kept[candIdx], reason: 'cluster_match', matched: cluster, judge_reason: v.reason || null,
            });
          }
        }
        if (dropIdx.size) {
          const filtered = [];
          for (let i = 0; i < kept.length; i += 1) {
            if (!dropIdx.has(i)) filtered.push(kept[i]);
          }
          kept.length = 0;
          for (const k of filtered) kept.push(k);
        }
      }
    } catch (_) {
      degraded.llm_judge = true;
    }
  }

  return { kept, dropped, summary, degraded };
}

/** Раскладывает все источники тем-исключений в плоский массив с canon-формой. */
function _flattenExclusionTopics(ex) {
  const out = [];
  if (!ex) return out;
  for (const t of (ex.user_topics || [])) {
    out.push({ source: 'user_topics', raw: t.raw || t, canon: t.canon || canonTitle(t.raw || t), kind: 'topic' });
  }
  for (const h of (ex.history || [])) {
    const canon = h.topic_title_canon || canonTitle(h.title || h);
    if (canon) out.push({ source: 'history', raw: h.title || canon, canon, kind: 'topic' });
  }
  for (const c of (ex.cannibalization || [])) {
    const canon = canonTitle(c.query || c.title || '');
    if (canon) out.push({ source: 'cannibalization', raw: c.query, canon, kind: 'topic' });
  }
  if (ex.target_url_h1) {
    const canon = canonTitle(ex.target_url_h1);
    if (canon) out.push({ source: 'target_url_h1', raw: ex.target_url_h1, canon, kind: 'topic' });
  }
  return out;
}

function _flattenClusters(ex) {
  const out = [];
  if (!ex || !Array.isArray(ex.user_clusters)) return out;
  for (const c of ex.user_clusters) {
    const raw = c.raw || c;
    const canon = c.canon || canonTitle(raw);
    if (canon) out.push({ source: 'user_clusters', raw, canon, kind: 'cluster' });
  }
  return out;
}

/** Jaccard по 3-граммам слов (быстрый, без зависимостей). */
function _jaccard3(a, b) {
  if (!a || !b) return 0;
  const A = _ngrams(a, 3);
  const B = _ngrams(b, 3);
  if (!A.size || !B.size) {
    // Для коротких строк fallback: jaccard по словам.
    const wa = new Set(a.split(/\s+/).filter(Boolean));
    const wb = new Set(b.split(/\s+/).filter(Boolean));
    if (!wa.size || !wb.size) return 0;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter += 1;
    return inter / (wa.size + wb.size - inter);
  }
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function _ngrams(s, n) {
  const words = s.split(/\s+/).filter(Boolean);
  const out = new Set();
  if (words.length < n) return out;
  for (let i = 0; i <= words.length - n; i += 1) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

function _cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = {
  filterCannibalizingCandidates,
  _jaccard3,
  _cosine,
  DEFAULTS,
};
