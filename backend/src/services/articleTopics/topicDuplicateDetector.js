'use strict';

/**
 * topicDuplicateDetector — трёхступенчатый детектор дублей тем по бренду.
 *
 * Шаги:
 *   1. EXACT: точное совпадение canon-заголовка → duplicate.source='exact'.
 *   2. JACCARD (по словам): для пар с пересечением слов H1/title ≥ 0.65
 *      → duplicate.source='fuzzy'.
 *   3. LLM (DeepSeek, temperature=0): для «подозрительных» (jaccard 0.45–0.65)
 *      батч-запрос «является ли кандидат дубликатом из истории».
 *      Только если featureFlags.brandDedup.useLlm=true и батч ≤ maxLlmCandidates.
 *
 * Поведение: новые темы НЕ отбрасываются, в результате просто проставляется
 * флаг `duplicate_of: { task_id, title, h1, similarity, source }`.
 * Pipeline всегда сохраняет полный набор topics.
 *
 * Без сетевых вызовов всё детерминировано (LLM-этап отключаем для тестов).
 */

const { canonTitle } = require('./brandKey');

function _tokens(s) {
  const c = canonTitle(s);
  if (!c) return [];
  return c.split(/\s+/).filter(Boolean);
}

function _jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function _bestMatch(candidateTitle, history) {
  const candTokens = _tokens(candidateTitle);
  if (!candTokens.length) return { best: null, score: 0 };
  let best = null;
  let bestScore = 0;
  for (const h of history) {
    const hTokens = _tokens(h.topic_title_canon);
    const sim = _jaccard(candTokens, hTokens);
    if (sim > bestScore) {
      bestScore = sim;
      best = h;
    }
  }
  return { best, score: bestScore };
}

async function _classifyWithLlm({ pairs, callDeepSeek, timeoutMs = 30000 }) {
  // pairs: [{candidate_index, candidate_title, history_id, history_title, similarity}]
  if (!Array.isArray(pairs) || !pairs.length) return new Map();
  const system = 'Ты ассистент для дедуп-аудита SEO-тем. Отвечай только корректным JSON без пояснений.';
  const user = [
    'Дано: пары (candidate, history). Реши, является ли candidate дубликатом history по смыслу/интенту.',
    'Считай дубликатом, если темы будут раскрывать одну и ту же боль и приведут к одинаковому SERP-интенту.',
    'Не считай дубликатом, если темы освещают разные сегменты ЦА, разные стадии воронки или разные форматы.',
    'Верни JSON-массив строго в формате:',
    '[{"candidate_index":<int>,"is_duplicate":<true|false>,"confidence":<0..1>,"reason":"<краткое>"}]',
    '',
    'Пары:',
    ...pairs.map((p, i) =>
      `${i + 1}. candidate_index=${p.candidate_index} | candidate="${(p.candidate_title || '').slice(0, 200)}" | history="${(p.history_title || '').slice(0, 200)}" | jaccard=${p.similarity.toFixed(3)}`
    ),
  ].join('\n');

  let raw = '';
  try {
    const resp = await callDeepSeek(system, user, { temperature: 0, maxTokens: 2000, timeoutMs });
    raw = (resp && (resp.text || resp.content || resp.output)) || '';
    if (typeof resp === 'string') raw = resp;
  } catch (e) {
    console.warn('[topicDuplicateDetector] LLM call failed:', e.message);
    return new Map();
  }
  // Достаём JSON-массив из ответа
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return new Map();
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (_) { return new Map(); }
  if (!Array.isArray(parsed)) return new Map();
  const out = new Map();
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const idx = Number(row.candidate_index);
    if (!Number.isFinite(idx)) continue;
    const conf = Math.max(0, Math.min(1, Number(row.confidence) || 0));
    if (row.is_duplicate === true && conf >= 0.5) {
      out.set(idx, { confidence: conf, reason: String(row.reason || '').slice(0, 200) });
    }
  }
  return out;
}

/**
 * detectDuplicates({candidates, history, flags, callDeepSeek})
 *
 * candidates: парсенные topics[] (с topic_title/h1/primary_intent).
 * history:    rows из article_topics_brand_history (canon-заголовки).
 * flags:      brandDedup конфигурация (enabled/useLlm/maxLlmCandidates).
 * callDeepSeek: опциональная инъекция для тестов; по умолчанию — реальный adapter.
 *
 * Возвращает: { enriched: [...candidates с duplicate_of], stats }.
 */
async function detectDuplicates({
  candidates,
  history,
  flags = {},
  callDeepSeek = null,
} = {}) {
  const stats = { total: 0, exact: 0, fuzzy: 0, llm: 0, llm_called: false };
  if (!Array.isArray(candidates) || !candidates.length) {
    return { enriched: [], stats };
  }
  stats.total = candidates.length;
  const hist = Array.isArray(history) ? history : [];
  const enriched = candidates.map((c) => ({ ...c, duplicate_of: null }));

  if (!hist.length || flags.enabled === false) {
    return { enriched, stats };
  }

  // EXACT
  const histByTitle = new Map();
  for (const h of hist) {
    if (!histByTitle.has(h.topic_title_canon)) histByTitle.set(h.topic_title_canon, h);
  }

  const llmCandidates = [];
  for (let i = 0; i < enriched.length; i += 1) {
    const c = enriched[i];
    const title = c.topic_title || c.title || '';
    const canonT = canonTitle(title);
    if (!canonT) continue;

    // 1. EXACT
    if (histByTitle.has(canonT)) {
      const h = histByTitle.get(canonT);
      c.duplicate_of = {
        task_id: h.topic_idea_task_id || null,
        title: h.topic_title_canon,
        h1: h.topic_h1_canon,
        created_at: h.created_at,
        similarity: 1.0,
        source: 'exact',
      };
      stats.exact += 1;
      continue;
    }

    // 2. FUZZY (Jaccard)
    const { best, score } = _bestMatch(canonT, hist);
    if (best && score >= 0.65) {
      c.duplicate_of = {
        task_id: best.topic_idea_task_id || null,
        title: best.topic_title_canon,
        h1: best.topic_h1_canon,
        created_at: best.created_at,
        similarity: Number(score.toFixed(3)),
        source: 'fuzzy',
      };
      stats.fuzzy += 1;
      continue;
    }
    // 3. LLM-кандидат — серые пары
    if (best && score >= 0.45 && score < 0.65) {
      llmCandidates.push({
        candidate_index: i,
        candidate_title: title,
        history_id: best.id,
        history_title: best.topic_title_canon,
        similarity: score,
      });
    }
  }

  const maxLlm = Math.max(0, Number(flags.maxLlmCandidates) || 20);
  if (flags.useLlm && llmCandidates.length && maxLlm > 0) {
    const batch = llmCandidates.slice(0, maxLlm);
    stats.llm_called = true;
    let llmFn = callDeepSeek;
    if (!llmFn) {
      try { llmFn = require('../llm/deepseek.adapter').callDeepSeek; } catch (_) { llmFn = null; }
    }
    if (llmFn) {
      const decisions = await _classifyWithLlm({ pairs: batch, callDeepSeek: llmFn });
      for (const p of batch) {
        const dec = decisions.get(p.candidate_index);
        if (!dec) continue;
        const histRow = hist.find((h) => h.id === p.history_id);
        if (!histRow) continue;
        enriched[p.candidate_index].duplicate_of = {
          task_id: histRow.topic_idea_task_id || null,
          title: histRow.topic_title_canon,
          h1: histRow.topic_h1_canon,
          created_at: histRow.created_at,
          similarity: Number(p.similarity.toFixed(3)),
          source: 'llm',
          llm_confidence: dec.confidence,
          llm_reason: dec.reason,
        };
        stats.llm += 1;
      }
    }
  }

  return { enriched, stats };
}

module.exports = { detectDuplicates, _jaccard, _tokens };
