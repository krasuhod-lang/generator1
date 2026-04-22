'use strict';

/**
 * Controller для bulk-генератора метатегов (Title + Description, без H1).
 * REST endpoints:
 *   GET    /api/meta-tags                — список задач пользователя
 *   POST   /api/meta-tags                — создать и запустить задачу
 *   GET    /api/meta-tags/:id            — детальная задача (с результатами)
 *   DELETE /api/meta-tags/:id            — удалить задачу
 *   GET    /api/meta-tags/:id/export.csv — выгрузка CSV (Excel-совместимый)
 */

const db = require('../config/db');
const { processMetaTagTask } = require('../services/metaTags/pipeline');

// ─── Валидация входных данных ─────────────────────────────────────
const MAX_NAME_LEN     = 200;
const MAX_KEYWORDS     = 200;   // защита от безумных нагрузок (200 ключей × ~4 сек = ~13 мин)
const MAX_KEYWORD_LEN  = 300;
const MAX_FIELD_LEN    = 500;

function clipStr(s, max) {
  if (s == null) return '';
  return String(s).slice(0, max).trim();
}

function parseKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((k) => clipStr(k, MAX_KEYWORD_LEN)).filter(Boolean);
  }
  return String(raw || '')
    .split(/\r?\n/)
    .map((k) => clipStr(k, MAX_KEYWORD_LEN))
    .filter(Boolean);
}

// ─── GET /api/meta-tags ───────────────────────────────────────────
async function listMetaTagTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, status, niche,
              progress_current, progress_total, active_keyword,
              jsonb_array_length(COALESCE(keywords, '[]'::jsonb)) AS keywords_count,
              error_message, created_at, started_at, completed_at
         FROM meta_tag_tasks
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ tasks: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/meta-tags ──────────────────────────────────────────
async function createMetaTagTask(req, res, next) {
  try {
    const body = req.body || {};
    const name     = clipStr(body.name,     MAX_NAME_LEN) || 'Без названия';
    const niche    = clipStr(body.niche,    MAX_FIELD_LEN);
    const lr       = clipStr(body.lr,       50);
    const toponym  = clipStr(body.toponym,  MAX_FIELD_LEN);
    const brand    = clipStr(body.brand,    MAX_FIELD_LEN);
    const phone    = clipStr(body.phone,    MAX_FIELD_LEN);
    const summary  = clipStr(body.summary,  MAX_FIELD_LEN);
    const keywords = parseKeywords(body.keywords).slice(0, MAX_KEYWORDS);

    if (keywords.length === 0) {
      return res.status(400).json({ error: 'Список ключевых запросов пуст' });
    }

    const { rows } = await db.query(
      `INSERT INTO meta_tag_tasks
         (user_id, name, niche, lr, toponym, brand, phone, summary, keywords,
          status, progress_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', $10)
       RETURNING id, name, status, progress_total, created_at`,
      [req.user.id, name, niche, lr, toponym, brand, phone, summary,
        JSON.stringify(keywords), keywords.length],
    );
    const task = rows[0];

    // Запускаем фоновую обработку. Любая ошибка ловится внутри pipeline и
    // сохраняется в БД — здесь only fire-and-forget.
    setImmediate(() => {
      processMetaTagTask(task.id).catch((err) => {
        console.error('[metaTags] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/meta-tags/:id ───────────────────────────────────────
async function getMetaTagTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM meta_tag_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    return res.json({ task: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/meta-tags/:id ────────────────────────────────────
async function deleteMetaTagTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM meta_tag_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/meta-tags/:id/export.csv ────────────────────────────
function csvCell(val) {
  // CSV-кавычки: оборачиваем + экранируем " как ""
  // CRLF/CR/LF внутри значений не разрешаем — заменяем на пробел, чтобы не
  // ломать строки и потенциальные CSV-injection-вектора (= + - @) пропускаем,
  // прибавляя апостроф в начало.
  let s = val == null ? '' : String(val);
  s = s.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportMetaTagTaskCsv(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT name, results FROM meta_tag_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    const { name, results } = rows[0];
    const items = Array.isArray(results) ? results : [];

    const headers = [
      'Keyword', 'Status', 'Intent',
      'Title', 'Title length',
      'Description', 'Description length',
      'Niche analysis', 'Detected year',
      'Title LSI (≥35%)', 'Description LSI (15–35%)',
      'Used important words', 'Missed LSI',
      'Error',
    ];

    const sep = ';'; // Excel в RU-локали ожидает ; как разделитель
    let csv = '\uFEFF'; // BOM — Excel корректно поймёт UTF-8
    csv += headers.map(csvCell).join(sep) + '\r\n';

    for (const it of items) {
      if (it.status === 'success') {
        const m = it.metas || {};
        const s = it.semantics || {};
        const lsi = m.lsi_check || {};
        const missed = Array.isArray(lsi.missed_lsi) ? lsi.missed_lsi : [];
        csv += [
          csvCell(it.keyword),
          csvCell('success'),
          csvCell(m.intent),
          csvCell(m.title),
          csvCell(m.title_length),
          csvCell(m.description),
          csvCell(m.description_length),
          csvCell(m.niche_analysis),
          csvCell(m.detected_year),
          csvCell((s.title_mandatory_words       || []).join(', ')),
          csvCell((s.description_mandatory_words || []).join(', ')),
          csvCell((m.used_important_words        || []).join(', ')),
          csvCell(missed.join(', ')),
          csvCell(''),
        ].join(sep) + '\r\n';
      } else {
        csv += [
          csvCell(it.keyword),
          csvCell('error'),
          csvCell(''), csvCell(''), csvCell(''), csvCell(''), csvCell(''),
          csvCell(''), csvCell(''), csvCell(''), csvCell(''), csvCell(''), csvCell(''),
          csvCell(it.error),
        ].join(sep) + '\r\n';
      }
    }

    const safeName = String(name || 'meta-tags')
      .replace(/[^a-zA-Z0-9_\-а-яА-ЯёЁ]+/g, '_')
      .slice(0, 80) || 'meta-tags';
    const fname = `${safeName}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(csv);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listMetaTagTasks,
  createMetaTagTask,
  getMetaTagTask,
  deleteMetaTagTask,
  exportMetaTagTaskCsv,
};
