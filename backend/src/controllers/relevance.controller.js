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
const { withUserSlot } = require('../utils/perUserConcurrency');
const { health: relevanceHealth, cocoons: relevanceCocoons, cocoonPlan: relevanceCocoonPlan } = require('../services/relevance/pythonClient');
const rawStorage = require('../services/relevance/rawStorage');

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
              created_at, started_at, completed_at,
              raw_storage, raw_expires_at,
              (cocoons IS NOT NULL) AS has_cocoons,
              (
                (raw_storage = 'redis' AND raw_expires_at > NOW())
                OR raw_processed IS NOT NULL
              ) AS has_raw
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

    // PR3: сравнение «наш сайт vs ТОП». our_url — необязательное поле формы.
    let ourUrl = clipStr(body.our_url, 2048) || null;
    if (ourUrl) {
      // Базовая валидация: только http(s); кривые URL → отчёт всё равно
      // создаём, но без сравнения.
      try {
        const u = new URL(ourUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          ourUrl = null;
        }
      } catch (_) {
        ourUrl = null;
      }
    }
    const excludeAggregators = !!body.exclude_aggregators;

    const { rows } = await db.query(
      `INSERT INTO relevance_reports
         (user_id, query, lr, top_n, status, our_url, exclude_aggregators)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id, query, lr, top_n, status, our_url, exclude_aggregators, created_at`,
      [req.user.id, query, lr, topN, ourUrl, excludeAggregators],
    );
    const report = rows[0];

    // Fire-and-forget — пайплайн сам пишет статусы и ошибки в БД.
    setImmediate(() => {
      withUserSlot(req.user.id, () => processRelevanceReport(report.id)).catch((err) => {
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
      `SELECT id, user_id, query, lr, top_n, status, current_stage,
              fetched_count, serp, failed_urls, error_message, duration_ms,
              created_at, started_at, completed_at,
              report, cocoons, cocoon_plan,
              our_url, our_report, comparison, exclude_aggregators,
              raw_storage, raw_expires_at,
              (
                (raw_storage = 'redis' AND raw_expires_at > NOW())
                OR raw_processed IS NOT NULL
              ) AS has_raw,
              (cocoons IS NOT NULL) AS has_cocoons,
              (cocoon_plan IS NOT NULL) AS has_cocoon_plan
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2`,
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
    // Подчищаем raw-кэш в Redis (если был) — best-effort.
    try { await rawStorage.deleteRaw(req.params.id); } catch (_) { /* ignore */ }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/relevance/:id/cocoons ──────────────────────────────
// Запускает повторный проход поверх processed-документов из Redis-кэша
// (или из Postgres-fallback'а, если Redis не доступен / TTL истёк) и
// кладёт результат в relevance_reports.cocoons. Идемпотентен —
// каждый вызов перезаписывает cocoons свежим расчётом.
async function buildCocoons(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, status, raw_storage, raw_expires_at,
              (raw_processed IS NOT NULL) AS has_db_processed
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    const r = rows[0];
    if (r.status !== 'done') {
      return res.status(409).json({ error: 'Отчёт ещё не готов (status != done).' });
    }

    const redisAlive = (
      r.raw_storage === 'redis'
      && r.raw_expires_at
      && r.raw_expires_at > new Date()
    );

    // 1) Сначала пробуем Redis (быстро). 2) Если пусто — Postgres-fallback.
    let processed = null;
    if (redisAlive) {
      try {
        processed = await rawStorage.loadRaw(r.id);
      } catch (e) {
        console.warn('[relevance] loadRaw from redis failed:', e.message);
      }
    }
    if (!processed || !Array.isArray(processed) || processed.length === 0) {
      // Грузим из БД
      const dbRows = await db.query(
        `SELECT raw_processed FROM relevance_reports WHERE id = $1`,
        [r.id],
      );
      const dbProcessed = dbRows.rows[0]?.raw_processed;
      if (Array.isArray(dbProcessed) && dbProcessed.length > 0) {
        processed = dbProcessed;
      }
    }

    if (!processed || !Array.isArray(processed) || processed.length === 0) {
      return res.status(410).json({
        error: 'Кэш сырых документов недоступен (ни в Redis, ни в БД). '
             + 'Создайте новый отчёт для расчёта коконов.',
      });
    }

    // Опции коконов из тела запроса (с дефолтами и потолками).
    const body = req.body || {};
    const nTopics = clampInt(body.n_topics, 8, 2, 32);
    const topTerms = clampInt(body.top_terms, 12, 3, 50);
    const topDocs  = clampInt(body.top_documents, 5, 1, 20);

    const cocoonsPayload = {
      documents: processed.map((d) => ({
        url:    String(d.url || ''),
        // POS-последовательность для коконов не нужна — экономим трафик.
        lemmas: Array.isArray(d.lemmas) ? d.lemmas : [],
      })),
      options: { n_topics: nTopics, top_terms: topTerms, top_documents: topDocs },
    };

    const t0 = Date.now();
    const result = await relevanceCocoons(cocoonsPayload);
    const cocoonsDoc = {
      generated_at: new Date().toISOString(),
      duration_ms:  Date.now() - t0,
      options:      cocoonsPayload.options,
      topics:       Array.isArray(result?.topics) ? result.topics : [],
      stats:        result?.stats || {},
    };

    await db.query(
      `UPDATE relevance_reports SET cocoons = $2::jsonb WHERE id = $1`,
      [r.id, JSON.stringify(cocoonsDoc)],
    );

    return res.json({ cocoons: cocoonsDoc });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/relevance/:id/cocoon-plan ──────────────────────────────
// Строит «семантический кокон» по методике Bourrelly (Page Cible →
// Mères → Filles + золотые правила перелинковки) поверх уже готового
// relevance-отчёта. Не требует raw_processed (в отличие от /cocoons) —
// читает vocabulary/ngrams/headings_intersection прямо из report jsonb.
// Идемпотентен; перезаписывает relevance_reports.cocoon_plan свежим
// расчётом. Не блокирует другие действия с отчётом.
async function buildCocoonPlan(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, status, query, lr, our_url, report
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Отчёт не найден' });
    const r = rows[0];
    if (r.status !== 'done') {
      return res.status(409).json({ error: 'Отчёт ещё не готов (status != done).' });
    }

    const rep = r.report || {};
    const body = req.body || {};
    const payload = {
      query:                  r.query || '',
      vocabulary:             Array.isArray(rep.vocabulary) ? rep.vocabulary : [],
      ngrams:                 Array.isArray(rep.ngrams) ? rep.ngrams : [],
      headings_intersection:  Array.isArray(rep.headings_intersection) ? rep.headings_intersection : [],
      our_url:                r.our_url || '',
      region:                 r.lr || '',
      options: {
        max_mothers:             clampInt(body.max_mothers, 8, 3, 16),
        max_children_per_mother: clampInt(body.max_children_per_mother, 12, 4, 24),
        min_cosine:              Math.max(0.05, Math.min(0.5, Number(body.min_cosine) || 0.18)),
      },
    };

    if (!payload.query.trim()) {
      return res.status(400).json({ error: 'У отчёта нет query — не из чего строить кокон.' });
    }
    if (payload.vocabulary.length === 0 && payload.ngrams.length === 0 && payload.headings_intersection.length === 0) {
      return res.status(400).json({
        error: 'В отчёте нет vocabulary/ngrams/headings — кокон строить не из чего.',
      });
    }

    const t0 = Date.now();
    const result = await relevanceCocoonPlan(payload);
    const cocoonPlanDoc = {
      generated_at: new Date().toISOString(),
      duration_ms:  Date.now() - t0,
      options:      payload.options,
      plan:         result?.plan || null,
      markdown:     result?.markdown || '',
    };

    await db.query(
      `UPDATE relevance_reports SET cocoon_plan = $2::jsonb WHERE id = $1`,
      [r.id, JSON.stringify(cocoonPlanDoc)],
    );

    return res.json({ cocoon_plan: cocoonPlanDoc });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/relevance/:id/raw ────────────────────────────────
// Досрочно удаляет processed-документы и из Redis, и из Postgres
// (но не сами cocoons — итоговый отчёт остаётся).
async function deleteRaw(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE relevance_reports
          SET raw_storage='none', raw_expires_at=NULL, raw_processed=NULL
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Отчёт не найден' });
    }
    const removed = await rawStorage.deleteRaw(req.params.id);
    return res.json({ ok: true, removed });
  } catch (err) {
    return next(err);
  }
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Формирует заголовок Content-Disposition с поддержкой Unicode (кириллица
 * в названии запроса). Node.js при `res.setHeader` бросает ERR_INVALID_CHAR,
 * если в значении есть не-Latin1 символы — поэтому raw query'и
 * («ремонт квартир») ломали скачивание JSON/CSV.
 *
 * Решение по RFC 5987 / RFC 6266: даём ASCII-фолбэк через `filename=`
 * (с заменой не-ASCII на `_`) + полноценное `filename*=UTF-8''…` с
 * percent-encoding для современных браузеров.
 */
function _contentDispositionAttachment(rawName, ext) {
  const baseRaw = String(rawName || 'report');
  const safeUtf8  = baseRaw.replace(/[^a-zа-яё0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'report';
  const safeAscii = baseRaw.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'report';
  const filenameAscii = `relevance_${safeAscii}.${ext}`;
  // RFC 5987: percent-encode UTF-8 bytes; кавычка/процент/и т.д. — тоже.
  const filenameUtf8  = encodeURIComponent(`relevance_${safeUtf8}.${ext}`);
  return `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameUtf8}`;
}

// ─── GET /api/relevance/:id/export.json ───────────────────────────
async function exportJson(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT query, lr, status, report, cocoons, cocoon_plan, serp, failed_urls, duration_ms,
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
      cocoons:      r.cocoons || null,
      cocoon_plan:  r.cocoon_plan || null,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', _contentDispositionAttachment(r.query, 'json'));
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

    csv += `"# Vocabulary (BM25 + TF-IDF)"\r\n`;
    csv += ['Lemma', 'DF (sites)', 'Median count', 'BM25 score', 'TF-IDF score', 'Status']
      .map(csvCell).join(sep) + '\r\n';
    for (const v of vocab) {
      csv += [
        csvCell(v.lemma),
        csvCell(v.df),
        csvCell(v.median_count),
        csvCell(v.bm25_score),
        csvCell(v.tf_idf_score ?? 0),
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

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', _contentDispositionAttachment(query, 'csv'));
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

// ─── GET /api/relevance/:id/artifact ──────────────────────────────
// Sprint B: возвращает нормализованный relevance-артефакт (LSI / n-граммы /
// H2-H3 наброски / mandatory entities / competitor_signals_digest) для
// привязки к задачам infoArticle / linkArticle / metaTags. Используется
// фронтом для предпросмотра «что уйдёт в генератор» и сторонними скриптами.
async function getArtifact(req, res, next) {
  try {
    const { loadArtifact } = require('../services/relevance/relevanceArtifacts');
    const art = await loadArtifact(db, {
      reportId: req.params.id,
      userId: req.user.id,
    });
    if (!art) return res.status(404).json({ error: 'relevance report not found or not done' });
    return res.json({ artifact: art });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listReports,
  createReport,
  getReport,
  deleteReport,
  buildCocoons,
  buildCocoonPlan,
  deleteRaw,
  exportJson,
  exportCsv,
  getHealth,
  getArtifact,
};
