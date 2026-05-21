'use strict';

/**
 * relevance/aegisHooks — точечные интеграции мозга A.E.G.I.S. в модуль
 * релевантности (Phase 14):
 *
 *   • filterPoisonedPages(pages) — отбрасывает скачанные страницы, в
 *     которых poisonFilter нашёл скрытый текст / keyword stuffing /
 *     невидимые юникод-символы (зашита от Data Poisoning из конкурентных
 *     сайтов).
 *   • emitPagesTelemetry({ ok, dropped }) — счётчики
 *     aegis_relevance_pages_total / aegis_relevance_poison_dropped_total.
 *   • finalizeReportCleanup(reportId) — после status='done' зовёт
 *     vectorGc.cleanupRun({ runId: 'relevance_<id>' }), чтобы зачистить
 *     эфемерные точки этого прогона в Qdrant.
 *
 * Все хуки graceful: AEGIS_ENABLED=false или AEGIS_RELEVANCE_ENABLED=false
 * → no-op. Никогда не бросают, не валят пайплайн.
 */

const { getAegisFlags } = require('../aegis/featureFlags');

let _telemetryRef = null;
let _poisonRef = null;
let _vectorGcRef = null;

function _telemetry() {
  if (_telemetryRef === null) {
    try { _telemetryRef = require('../aegis/telemetry'); }
    catch (_) { _telemetryRef = false; }
  }
  return _telemetryRef || null;
}
function _poison() {
  if (_poisonRef === null) {
    try { _poisonRef = require('../aegis/poisonFilter'); }
    catch (_) { _poisonRef = false; }
  }
  return _poisonRef || null;
}
function _vectorGc() {
  if (_vectorGcRef === null) {
    try { _vectorGcRef = require('../aegis/vectorGc'); }
    catch (_) { _vectorGcRef = false; }
  }
  return _vectorGcRef || null;
}

function _flagsAegisOn() {
  try {
    const f = getAegisFlags();
    return f.enabled && f.relevanceAegis && f.relevanceAegis.enabled;
  } catch (_) {
    return false;
  }
}

/**
 * filterPoisonedPages(pages) — удаляет скачанные страницы, провалившие
 * poisonFilter. Возвращает { kept, dropped }, не модифицирует вход.
 *
 * @param {Array<{url:string, html:string}>} pages
 * @returns {{kept:Array, dropped:Array<{url:string, reason:string}>}}
 */
function filterPoisonedPages(pages) {
  const out = { kept: [], dropped: [] };
  const inputArr = Array.isArray(pages) ? pages : [];
  if (!_flagsAegisOn()) {
    out.kept = inputArr;
    return out;
  }
  const cfg = getAegisFlags().relevanceAegis;
  if (!cfg.poisonFilterFetched) {
    out.kept = inputArr;
    return out;
  }
  const pf = _poison();
  if (!pf || typeof pf.runPoisonCheck !== 'function') {
    out.kept = inputArr;
    return out;
  }
  for (const page of inputArr) {
    let verdict = null;
    try {
      verdict = pf.runPoisonCheck({ html: page && page.html });
    } catch (_) {
      verdict = null;
    }
    // runPoisonCheck → { blocked, verdict:'clean'|'drop'|'mark', reasons:[...] }.
    // Удаляем страницу только если blocked=true (onFail='drop' и есть причины).
    if (verdict && verdict.blocked) {
      out.dropped.push({
        url: page && page.url,
        reason: (verdict.reasons && verdict.reasons[0]) || 'poisoned',
      });
    } else {
      out.kept.push(page);
    }
  }
  return out;
}

/**
 * emitPagesTelemetry({ ok, dropped }) — пушим счётчики.
 *
 * Никогда не бросает.
 */
function emitPagesTelemetry({ ok = 0, dropped = [] } = {}) {
  if (!_flagsAegisOn()) return;
  const cfg = getAegisFlags().relevanceAegis;
  if (!cfg.telemetrySpans) return;
  const t = _telemetry();
  if (!t || !t.M) return;
  try {
    if (t.M.relevancePages) {
      t.M.relevancePages.inc(ok,             { outcome: 'ok' });
      t.M.relevancePages.inc(dropped.length, { outcome: 'poisoned' });
    }
    if (t.M.relevancePoisonDropped) {
      const byReason = {};
      for (const d of dropped) {
        const r = (d && d.reason) || 'poisoned';
        byReason[r] = (byReason[r] || 0) + 1;
      }
      for (const [reason, n] of Object.entries(byReason)) {
        t.M.relevancePoisonDropped.inc(n, { reason });
      }
    }
  } catch (_) { /* graceful */ }
}

/**
 * finalizeReportCleanup(reportId) — пост-completion hook (status='done').
 *
 * Зовёт vectorGc.cleanupRun({ runId: 'relevance_<id>' }). Если vectorGc
 * выключен / Qdrant недоступен — graceful no-op.
 */
async function finalizeReportCleanup(reportId) {
  if (!_flagsAegisOn()) return { ok: false, reason: 'disabled' };
  const cfg = getAegisFlags().relevanceAegis;
  if (!cfg.vectorGcOnDone) return { ok: false, reason: 'flag_off' };
  const gc = _vectorGc();
  if (!gc) return { ok: false, reason: 'vectorgc_missing' };
  const runId = `relevance_${String(reportId || '').trim()}`;
  try {
    return await gc.cleanupRun({ runId });
  } catch (e) {
    return { ok: false, reason: 'cleanup_failed', error: String(e && e.message || e) };
  }
}

/**
 * maybeCompressForAnalyzer(prompt) — опц. сжимает большой prompt
 * (например, SERP-evidence + наш документ) перед DeepSeek-analyzer.
 *
 * Возвращает { text, compressed: bool, ratio?: number }. По умолчанию
 * compressDeepseekPrompt=false; гейт явный.
 */
function maybeCompressForAnalyzer(prompt) {
  const text = String(prompt || '');
  if (!_flagsAegisOn()) return { text, compressed: false };
  const cfg = getAegisFlags().relevanceAegis;
  if (!cfg.compressDeepseekPrompt) return { text, compressed: false };
  let pc = null;
  try { pc = require('../aegis/promptCompressor'); } catch (_) { pc = null; }
  if (!pc || typeof pc.compressPrompt !== 'function') return { text, compressed: false };
  try {
    const res = pc.compressPrompt(text);
    if (res && !res.skipped && typeof res.text === 'string' && res.text.length < text.length) {
      return { text: res.text, compressed: true, ratio: res.compression_ratio };
    }
  } catch (_) { /* graceful */ }
  return { text, compressed: false };
}

module.exports = {
  filterPoisonedPages,
  emitPagesTelemetry,
  finalizeReportCleanup,
  maybeCompressForAnalyzer,
};
