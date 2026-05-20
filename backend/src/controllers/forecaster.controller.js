'use strict';

/**
 * Controller для модуля «Прогнозатор».
 *
 *   GET    /api/forecaster          — список задач пользователя
 *   POST   /api/forecaster          — создать задачу (CSV/JSON-rows загрузка)
 *   GET    /api/forecaster/:id      — детальная задача
 *   DELETE /api/forecaster/:id      — удалить
 *   POST   /api/forecaster/:id/share   — выпустить share-токен
 *   DELETE /api/forecaster/:id/share   — отозвать
 *
 *   GET    /api/public/forecaster/:token — публичный read-only снапшот
 *                                          (без auth, отдельный роутер)
 */

const db = require('../config/db');
const { processForecasterTask } = require('../services/forecaster/forecasterPipeline');
const { withUserSlot } = require('../utils/perUserConcurrency');
const {
  generateShareToken,
  isValidShareToken,
} = require('../services/forecaster/shareToken');

const NAME_LIMIT = 200;

function _clipName(v) {
  return String(v || '').slice(0, NAME_LIMIT).trim();
}

// Безопасная нормализация URL: принимаем только http/https, обрезаем мусор.
// Возвращаем строку URL (с протоколом) либо пустую — если что-то не так.
function _sanitizeUrl(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  let s = raw;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

// Конверсия сайта: 0..0.5 (50 % — жёсткий потолок против опечаток).
// Принимаем число (0.02), процент (2 = 2 %, если > 1 и ≤ 100), и пустоту → null.
function _sanitizeCr(v) {
  if (v == null || v === '') return null;
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Эвристика: если пользователь ввёл "2" — считаем как 2 %.
  if (n > 1 && n <= 100) n = n / 100;
  if (n > 0.5) return null; // отсекаем явные опечатки
  return Math.round(n * 100000) / 100000;
}

function _sanitizeIntent(v) {
  const allowed = ['commercial', 'ecommerce', 'lead_gen', 'info', 'b2b'];
  const s = String(v || '').trim().toLowerCase();
  return allowed.includes(s) ? s : null;
}

// ─── GET /api/forecaster ───────────────────────────────────────────
async function listForecasterTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, status, error_message,
              source_filename, source_rows_count,
              llm_model, tokens_in, tokens_out, cost_usd,
              share_token, share_created_at,
              created_at, started_at, completed_at
         FROM forecaster_tasks
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.user.id],
    );
    return res.json({ tasks: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/forecaster ──────────────────────────────────────────
// Принимает JSON: { name, options, source: { filename, rows: string[][] } }
// Файл (XLSX) парсится на фронте через read-excel-file, отправляется как
// массив массивов строк. CSV-файл фронт может либо распарсить тем же путём,
// либо отправить как { filename, csv: "<raw>" }.
async function createForecasterTask(req, res, next) {
  try {
    const body = req.body || {};
    const name = _clipName(body.name) || `Прогноз · ${new Date().toLocaleString('ru-RU')}`;
    const src = body.source || {};
    const filename = String(src.filename || '').slice(0, 255).trim();
    const rows = Array.isArray(src.rows) ? src.rows : null;
    const csv  = typeof src.csv === 'string' ? src.csv : null;

    if (!rows && !csv) {
      return res.status(400).json({ error: 'Не передан файл: ожидается source.rows (array) или source.csv (string)' });
    }
    // Защитные потолки на размер файла/число строк намеренно сняты:
    // по требованию владельца продукта прогнозатор обязан учитывать все
    // фразы из выгрузки Wordstat без отсечения. Парсер сам справляется
    // с большими объёмами (O(N) по строкам, без сетевых вызовов).

    // Опции (текущий трафик и т.п.)
    const opts = body.options || {};
    const rawTargetUrl = String(opts.target_url || '').slice(0, 500).trim();
    const targetUrl = _sanitizeUrl(rawTargetUrl);
    const options = {
      current_traffic_per_month: Math.max(0, Math.floor(Number(opts.current_traffic_per_month) || 0)),
      region:                    String(opts.region || '').slice(0, 100),
      notes:                     String(opts.notes  || '').slice(0, 1000),
      target_url:                targetUrl,
      // Конверсия сайта (0..0.5). Хранится как дробь (0.02 = 2 %).
      // По требованию владельца: маржу/выручку модуль не считает,
      // только объём заявок = traffic × CR.
      conversion_rate:           _sanitizeCr(opts.conversion_rate),
      // Подсказка intent (commercial/ecommerce/lead_gen/info/b2b).
      // Используется только если conversion_rate не задан (выбирается preset).
      intent:                    _sanitizeIntent(opts.intent),
    };

    const sourceColumns = rows ? { raw_rows: rows } : { raw_csv: csv };

    const { rows: ins } = await db.query(
      `INSERT INTO forecaster_tasks
         (user_id, name, status, source_filename, options, source_columns)
       VALUES ($1, $2, 'queued', $3, $4::jsonb, $5::jsonb)
       RETURNING id, name, status, source_filename, created_at`,
      [
        req.user.id, name, filename,
        JSON.stringify(options),
        JSON.stringify(sourceColumns),
      ],
    );
    const task = ins[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processForecasterTask(task.id)).catch((err) => {
        console.error('[forecaster] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/forecaster/:id ───────────────────────────────────────
async function getForecasterTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, name, status, error_message,
              source_filename, source_rows_count, source_columns,
              options, target_url,
              monthly_series, anomalies, forecast, trend,
              traffic_estimate, junk_phrases, keysso_signals,
              opportunities, expert_reports, leads_summary,
              deepseek_summary,
              llm_provider, llm_model, tokens_in, tokens_out, cost_usd,
              share_token, share_created_at,
              created_at, started_at, completed_at, updated_at
         FROM forecaster_tasks
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    const t = rows[0];
    // Не отдаём сырые загруженные данные на фронт — они уже учтены в monthly_series.
    if (t.source_columns) {
      const sc = { ...t.source_columns };
      delete sc.raw_rows;
      delete sc.raw_csv;
      t.source_columns = sc;
    }
    return res.json({ task: t });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/forecaster/:id ────────────────────────────────────
async function deleteForecasterTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM forecaster_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/forecaster/:id/share ────────────────────────────────
async function createShareLink(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, status, share_token FROM forecaster_tasks
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Задача не найдена' });
    const t = rows[0];
    if (t.status !== 'done') {
      return res.status(409).json({ error: 'Поделиться можно только завершённой задачей' });
    }
    if (t.share_token) {
      return res.json({ token: t.share_token });
    }
    // генерируем токен; на коллизию (uniq violation) — повторяем
    let token = generateShareToken();
    for (let i = 0; i < 5; i++) {
      try {
        await db.query(
          `UPDATE forecaster_tasks
              SET share_token=$2, share_created_at=NOW(), updated_at=NOW()
            WHERE id=$1`,
          [t.id, token],
        );
        break;
      } catch (err) {
        if (err && err.code === '23505') { token = generateShareToken(); continue; }
        throw err;
      }
    }
    return res.json({ token });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/forecaster/:id/share ──────────────────────────────
async function revokeShareLink(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE forecaster_tasks
          SET share_token=NULL, share_created_at=NULL, updated_at=NOW()
        WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/public/forecaster/:token ─────────────────────────────
// Read-only снапшот: НЕ отдаём user_id, email, raw_csv, source_columns.raw_*.
async function getSharedForecast(req, res, next) {
  try {
    const token = String(req.params.token || '');
    if (!isValidShareToken(token)) {
      return res.status(400).json({ error: 'Некорректный токен' });
    }
    const { rows } = await db.query(
      `SELECT id, name, status, source_filename, source_rows_count, target_url,
              monthly_series, anomalies, forecast, trend,
              traffic_estimate, junk_phrases, keysso_signals,
              opportunities, expert_reports, leads_summary,
              deepseek_summary,
              share_created_at, created_at, completed_at
         FROM forecaster_tasks
        WHERE share_token = $1 AND status='done'
        LIMIT 1`,
      [token],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ссылка недействительна или отозвана' });
    }
    return res.json({ task: rows[0] });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listForecasterTasks,
  createForecasterTask,
  getForecasterTask,
  deleteForecasterTask,
  createShareLink,
  revokeShareLink,
  getSharedForecast,
};
