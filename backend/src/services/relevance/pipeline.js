'use strict';

/**
 * Pipeline отчёта релевантности.
 *
 * Шаги:
 *   1. status='fetching' → XMLStock SERP (переиспользуем существующий клиент
 *      из meta-tags pipeline) → берём top_n URL.
 *   2. fetchPages(urls) — параллельная загрузка HTML.
 *   3. status='analyzing' → POST документов в Python-микросервис.
 *   4. status='done' / 'error' → запись report в БД.
 *
 * Ошибки fail-fast только на критическом отсутствии хотя бы одного успешно
 * скачанного URL и на отказе Python-сервиса. Частичные сбои (5 из 20 URL не
 * открылись) — НЕ ошибка, идут в failed_urls.
 */

const db = require('../../config/db');
const { fetchYandexSerp } = require('../metaTags/xmlstockClient');
const { fetchPages }      = require('./pageFetcher');
const { analyze }         = require('./pythonClient');

const MIN_FETCHED_FOR_ANALYZE = (() => {
  const v = parseInt(process.env.RELEVANCE_MIN_FETCHED, 10);
  return Number.isFinite(v) && v >= 1 ? v : 5;
})();

async function _setStage(reportId, stage, extra = {}) {
  const sets = ['current_stage = $2'];
  const params = [reportId, stage];
  let i = 3;
  if (extra.status) {
    sets.push(`status = $${i}::relevance_report_status`);
    params.push(extra.status);
    i += 1;
  }
  if (extra.fetched_count != null) {
    sets.push(`fetched_count = $${i}`);
    params.push(extra.fetched_count);
    i += 1;
  }
  if (extra.serp != null) {
    sets.push(`serp = $${i}::jsonb`);
    params.push(JSON.stringify(extra.serp));
    i += 1;
  }
  if (extra.failed_urls != null) {
    sets.push(`failed_urls = $${i}::jsonb`);
    params.push(JSON.stringify(extra.failed_urls));
    i += 1;
  }
  if (extra.started) {
    sets.push('started_at = NOW()');
  }
  await db.query(
    `UPDATE relevance_reports SET ${sets.join(', ')} WHERE id = $1`,
    params,
  );
}

async function _finishOk(reportId, report, durationMs) {
  await db.query(
    `UPDATE relevance_reports
       SET status='done',
           current_stage='done',
           report = $2::jsonb,
           completed_at = NOW(),
           duration_ms = $3
     WHERE id = $1`,
    [reportId, JSON.stringify(report), durationMs],
  );
}

async function _finishError(reportId, message) {
  const safe = String(message || 'unknown error').slice(0, 1000);
  await db.query(
    `UPDATE relevance_reports
       SET status='error',
           current_stage='error',
           error_message = $2,
           completed_at = NOW()
     WHERE id = $1`,
    [reportId, safe],
  );
}

/**
 * Основной запуск пайплайна. Никогда не бросает наружу — всё ловит и
 * пишет error_message в БД.
 *
 * @param {string} reportId — UUID записи в relevance_reports.
 */
async function processRelevanceReport(reportId) {
  const t0 = Date.now();

  const { rows } = await db.query(
    `SELECT id, query, lr, top_n FROM relevance_reports WHERE id = $1`,
    [reportId],
  );
  if (!rows.length) {
    console.error(`[relevance] report ${reportId} not found`);
    return;
  }
  const { query, lr, top_n: topN } = rows[0];

  try {
    // ── 1. SERP ──────────────────────────────────────────────────────────
    await _setStage(reportId, 'serp', { status: 'fetching', started: true });

    const serpRaw = await fetchYandexSerp(query, { lr: lr || '', pages: 2 });
    // Нормализуем + берём top_n уникальных по URL.
    const seen = new Set();
    const serp = [];
    for (const item of (serpRaw || [])) {
      const url = String(item.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      serp.push({
        url,
        title:   String(item.title   || '').slice(0, 500),
        snippet: String(item.snippet || '').slice(0, 1000),
      });
      if (serp.length >= topN) break;
    }

    if (serp.length === 0) {
      throw new Error('XMLStock не вернул ни одного URL.');
    }
    await _setStage(reportId, 'fetching_pages', { serp });

    // ── 2. Скачивание HTML ───────────────────────────────────────────────
    const { successes, failures } = await fetchPages(serp.map((s) => s.url));
    await _setStage(reportId, 'analyzing', {
      status: 'analyzing',
      fetched_count: successes.length,
      failed_urls:   failures,
    });

    if (successes.length < MIN_FETCHED_FOR_ANALYZE) {
      throw new Error(
        `Удалось скачать только ${successes.length}/${serp.length} страниц `
        + `(минимум для анализа: ${MIN_FETCHED_FOR_ANALYZE}).`,
      );
    }

    // ── 3. Python-микросервис ────────────────────────────────────────────
    const analysisResp = await analyze({
      query,
      documents: successes.map((s) => ({ url: s.url, html: s.html })),
    });

    // ── 4. Сохраняем отчёт ───────────────────────────────────────────────
    const fullReport = {
      query,
      lr: lr || '',
      generated_at: new Date().toISOString(),
      stats:      analysisResp?.stats      || {},
      vocabulary: Array.isArray(analysisResp?.vocabulary) ? analysisResp.vocabulary : [],
      ngrams:     Array.isArray(analysisResp?.ngrams)     ? analysisResp.ngrams     : [],
    };

    await _finishOk(reportId, fullReport, Date.now() - t0);
  } catch (err) {
    console.error(`[relevance] report ${reportId} failed:`, err.message);
    await _finishError(reportId, err.message);
  }
}

module.exports = { processRelevanceReport };
