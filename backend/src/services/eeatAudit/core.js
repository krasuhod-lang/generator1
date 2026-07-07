'use strict';

/**
 * eeatAudit/core.js — Phase 2 / С2. Унифицированная логика EEAT-аудита,
 * общая для info-article и link-article пайплайнов.
 *
 * До этой унификации каждая из пайплайн-веток (info, link) держала свой
 * `runEeatAudit` с почти идентичной логикой: одинаковая нормализация
 * total_score → [0..10], одинаковый verdict-фолбэк по threshold,
 * одинаковая структура issues. Различалась только сборка `user`-промта
 * (поля задачи) и системный промт.
 *
 * Этот модуль:
 *   • экспортирует `runEeatAuditCore({ adapter, system, userText, threshold,
 *     callOptions, chunkOpts? })` — единая точка вызова LLM + нормализации;
 *   • экспортирует `normalizeEeatAudit(raw, threshold)` — чистая функция
 *     для тестов;
 *   • опционально включает chunked-режим (Б1) через `chunkOpts.html` —
 *     если HTML > target и `INFO_ARTICLE_EEAT_CHUNKED=true`, делит статью
 *     на смысловые H2-чанки, аудитит каждый отдельно и агрегирует.
 *
 * Контракт:
 *   • никогда не валит pipeline; LLM-сбой → graceful возврат «refine»-аудита
 *     (decision принимается на уровне callsite).
 */

const { callLLM } = require('../llm/callLLM');
const {
  chunkArticleForEeat,
  aggregateChunkAudits,
  EEAT_CHUNKED_ENABLED,
  EEAT_CHUNK_TARGET_CHARS,
} = require('../infoArticle/eeatChunker');

/**
 * normalizeEeatAudit — чистая нормализация LLM-ответа.
 * Гарантирует: total_score ∈ [0..10], issues — массив, verdict ∈ enum.
 */
function normalizeEeatAudit(raw, threshold = 7.5) {
  const norm = (raw && typeof raw === 'object') ? { ...raw } : {};
  const totalRaw = Number(norm.total_score);
  norm.total_score = Number.isFinite(totalRaw)
    ? Math.max(0, Math.min(10, Math.round(totalRaw * 10) / 10))
    : 0;
  if (!Array.isArray(norm.issues)) norm.issues = [];
  if (!['pass', 'refine', 'reject'].includes(norm.verdict)) {
    norm.verdict = norm.total_score >= threshold ? 'pass' : 'refine';
  }
  if (typeof norm.lsi_coverage_pct !== 'number' || !Number.isFinite(norm.lsi_coverage_pct)) {
    norm.lsi_coverage_pct = 0;
  }
  return norm;
}

/**
 * runEeatAuditCore — единый entrypoint EEAT-аудита.
 *
 * @param {object} args
 * @param {string} args.adapter        — 'deepseek' / 'gemini' / ...
 * @param {string} args.system         — system-prompt для аудитора
 * @param {string} args.userText       — собранный user-prompt (уже с inputs)
 * @param {number} args.threshold      — порог pass/refine
 * @param {object} args.callOptions    — { retries, temperature, callLabel, ...ctx }
 * @param {object} [args.chunkOpts]    — { html, buildChunkUserText(chunk)→string }
 * @returns {Promise<object>}          — нормализованный аудит-объект
 */
async function runEeatAuditCore({ adapter, system, userText, threshold, callOptions, chunkOpts }) {
  // Chunked-режим (Б1)
  if (
    EEAT_CHUNKED_ENABLED
    && chunkOpts
    && typeof chunkOpts.html === 'string'
    && chunkOpts.html.length > EEAT_CHUNK_TARGET_CHARS
    && typeof chunkOpts.buildChunkUserText === 'function'
  ) {
    const chunks = chunkArticleForEeat(chunkOpts.html);
    if (chunks.length >= 2) {
      const chunkResults = [];
      for (const ch of chunks) {
        const chunkUser = chunkOpts.buildChunkUserText(ch);
        const label = `${callOptions?.callLabel || 'EEAT audit'} [chunk ${ch.index + 1}/${chunks.length}]`;
        let audit = null;
        let lastErr = null;
        // Бесперебойность (Б1+): каждый чанк получает до 2 попыток с
        // backoff — одиночный LLM-сбой больше не превращается в score=0.
        for (let attempt = 1; attempt <= 2 && !audit; attempt++) {
          try {
            const r = await callLLM(adapter, system, chunkUser, {
              ...callOptions,
              callLabel: attempt === 1 ? label : `${label} retry`,
            });
            audit = normalizeEeatAudit(r, threshold);
          } catch (e) {
            lastErr = e;
            if (attempt < 2) await new Promise((res) => setTimeout(res, 800 * attempt));
          }
        }
        if (audit) {
          chunkResults.push({ chunk: ch, audit });
        } else {
          chunkResults.push({
            chunk: ch,
            audit: {
              total_score: 0,
              verdict: 'refine',
              issues: [`[chunk ${ch.index + 1}/${chunks.length}] LLM-сбой: ${String(lastErr?.message || 'unknown').slice(0, 200)}`],
              lsi_coverage_pct: 0,
              audit_failed: true,
            },
          });
        }
      }

      // Агрегация: сбойные чанки (audit_failed) не тянут средний балл к нулю —
      // score считаем только по успешно проаудированным чанкам, а issues
      // сбойных сохраняем для прозрачности. Если ВСЕ чанки сбойные —
      // возвращаем refine со score 0 (как раньше).
      const okResults = chunkResults.filter((cr) => !cr.audit.audit_failed);
      const failedResults = chunkResults.filter((cr) => cr.audit.audit_failed);
      const agg = aggregateChunkAudits(okResults.length ? okResults : chunkResults);
      if (okResults.length && failedResults.length) {
        for (const fr of failedResults) {
          for (const issue of fr.audit.issues) {
            agg.issues.push({ chunk: fr.chunk?.h2_text || '', text: String(issue) });
          }
        }
      }
      const verdict = okResults.length
        ? (agg.total_score >= threshold ? 'pass' : 'refine')
        : 'refine';
      const hasReject = chunkResults.some((cr) => cr.audit && cr.audit.verdict === 'reject');
      return {
        total_score:      okResults.length ? agg.total_score : 0,
        verdict:          hasReject ? 'reject' : verdict,
        issues:           agg.issues,
        lsi_coverage_pct: agg.lsi_coverage_pct,
        per_chunk:        agg.per_chunk,
        chunked:          true,
        failed_chunks:    failedResults.length,
      };
    }
    // Только один чанк → fallback к single-call ниже.
  }

  // Single-call режим (back-compat).
  const raw = await callLLM(adapter, system, userText, callOptions);
  return normalizeEeatAudit(raw, threshold);
}

module.exports = {
  normalizeEeatAudit,
  runEeatAuditCore,
};
