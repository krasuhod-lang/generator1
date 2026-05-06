'use strict';

/**
 * Controller вкладки «Релевантность».
 *
 * REST endpoints:
 *   GET    /api/relevance               — список отчётов пользователя
 *   POST   /api/relevance               — создать и запустить отчёт
 *   GET    /api/relevance/:id           — детали отчёта (для опроса)
 *   DELETE /api/relevance/:id           — удалить отчёт
 *   GET    /api/relevance/:id/export.json — выгрузка JSON-отчёта
 *   GET    /api/relevance/:id/export.csv  — выгрузка CSV (vocab + ngrams)
 *   GET    /api/relevance/health        — диагностика связи с Python-сервисом
 */

const db = require('../config/db');
const { processRelevanceReport } = require('../services/relevance/pipeline');
const { health: relevanceHealth } = require('../services/relevance/pythonClient');

const MAX_QUERY_LEN = 200;
const MAX_LR_LEN    = 16;

function clipStr(s, max) {
  if (s == null) return '';
  return String(s).slice(0, max).trim();
}

// ─── GET /api/relevance ───────────────────────────────────────────
async function listReports(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, query, lr, top_n, status, current_stage,
              fetched_count,
              jsonb_array_length(COALESCE(serp,        '[]'::jsonb)) AS serp_count,
              jsonb_array_length(COALESCE(failed_urls, '[]'::jsonb)) AS failed_count,
              error_message, duration_ms,
              created_at, started_at, completed_at
         FROM relevance_reports
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.user.id],
    );
    return res.json({ reports: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/relevance ──────────────────────────────────────────
async function createReport(req, res, next) {
  try {
    const body  = req.body || {};
    const query = clipStr(body.query, MAX_QUERY_LEN);
    const lr    = clipStr(body.lr,    MAX_LR_LEN) || '213';

    if (!query) {
      return res.status(400).json({ error: 'Поле "query" (поисковый запрос) обязательно.' });
    }

    // top_n — на этапе MVP фиксируем 20 (можем расширить позже).
    const topN = 20;

    const { rows } = await db.query(
      `INSERT INTO relevance_reports (user_id, query, lr, top_n, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, query, lr, top_n, status, created_at`,
      [req.user.id, query, lr, topN],
    );
    const report = rows[0];

    // Fire-and-forget — пайплайн сам пишет статусы и ошибки в БД.
    setImmediate(() => {
      processRelevanceReport(report.id).catch((err) => {
        console.error('[relevance] background pipeline failed:', err.message);
      });
    });

    return res.status(201).json({ report });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/relevance/:id ───────────────────────────────────────
async function getReport(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM relevance_reports WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    return res.json({ report: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/relevance/:id ────────────────────────────────────
async function deleteReport(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM relevance_reports WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/relevance/:id/export.json ───────────────────────────
async function exportJson(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT query, lr, status, report, serp, failed_urls, duration_ms,
              created_at, completed_at
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    const r = rows[0];
    const payload = {
      query:        r.query,
      lr:           r.lr,
      status:       r.status,
      duration_ms:  r.duration_ms,
      created_at:   r.created_at,
      completed_at: r.completed_at,
      serp:         r.serp || [],
      failed_urls:  r.failed_urls || [],
      report:       r.report || {},
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const safeName = String(r.query).replace(/[^a-zа-яё0-9_-]+/gi, '_').slice(0, 60) || 'report';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="relevance_${safeName}.json"`,
    );
    return res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/relevance/:id/export.csv ────────────────────────────
function csvCell(val) {
  let s = val == null ? '' : String(val);
  s = s.replace(/[\r\n]+/g, ' ');
  // CSV-injection guard: значения, начинающиеся с =/+/-/@ — префиксуем апострофом
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportCsv(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT query, report FROM relevance_reports WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    const { query, report } = rows[0];
    const vocab  = Array.isArray(report?.vocabulary) ? report.vocabulary : [];
    const ngrams = Array.isArray(report?.ngrams)     ? report.ngrams     : [];

    const sep = ';';
    let csv = '\uFEFF'; // BOM для Excel в RU-локали
    csv += `"# Relevance report"${sep}${csvCell(query)}\r\n`;
    csv += `"# Generated"${sep}${csvCell(new Date().toISOString())}\r\n\r\n`;

    csv += `"# Vocabulary (BM25)"\r\n`;
    csv += ['Lemma', 'DF (sites)', 'Median count', 'BM25 score', 'Status']
      .map(csvCell).join(sep) + '\r\n';
    for (const v of vocab) {
      csv += [
        csvCell(v.lemma),
        csvCell(v.df),
        csvCell(v.median_count),
        csvCell(v.bm25_score),
        csvCell(v.status),
      ].join(sep) + '\r\n';
    }

    csv += '\r\n"# N-grams (bigrams + trigrams)"\r\n';
    csv += ['Phrase', 'DF (sites)', 'Median count', 'Type', 'POS pattern']
      .map(csvCell).join(sep) + '\r\n';
    for (const n of ngrams) {
      csv += [
        csvCell(n.phrase),
        csvCell(n.df),
        csvCell(n.median_count),
        csvCell(n.type),
        csvCell(n.pos_pattern),
      ].join(sep) + '\r\n';
    }

    const safeName = String(query).replace(/[^a-zа-яё0-9_-]+/gi, '_').slice(0, 60) || 'report';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="relevance_${safeName}.csv"`,
    );
    return res.send(csv);
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/relevance/health ────────────────────────────────────
async function getHealth(_req, res, next) {
  try {
    const h = await relevanceHealth();
    return res.json({ relevance: h });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listReports,
  createReport,
  getReport,
  deleteReport,
  exportJson,
  exportCsv,
  getHealth,
};
