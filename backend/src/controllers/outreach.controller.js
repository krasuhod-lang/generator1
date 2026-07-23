'use strict';

/**
 * Controller для модуля Outreach (email-рассылки).
 *
 *   GET    /api/outreach/campaigns              — список кампаний пользователя
 *   POST   /api/outreach/campaigns              — создать кампанию
 *   GET    /api/outreach/campaigns/:id          — детали кампании (поллинг)
 *   PATCH  /api/outreach/campaigns/:id          — обновить (pause/resume/settings)
 *   DELETE /api/outreach/campaigns/:id          — удалить
 *
 *   GET    /api/outreach/campaigns/:id/prospects — лиды кампании (пагинация)
 *   GET    /api/outreach/campaigns/:id/emails    — письма (пагинация)
 *   GET    /api/outreach/campaigns/:id/logs      — логи кампании (последние 200)
 *   GET    /api/outreach/campaigns/:id/stats     — статистика (для графиков)
 *
 *   POST   /api/outreach/webhooks/resend         — Resend Webhook (без auth, HMAC)
 *   GET    /api/outreach/unsubscribe             — отписка (публичная)
 *
 * Паттерн повторяет serpB2b.controller.js.
 */

const db = require('../config/db');

const MAX_NAME_LEN = 200;
const MAX_KEYWORD_LEN = 200;
const MIN_DEPTH = 1;
const MAX_DEPTH = 10;
const MAX_CITIES = 30;
const MIN_DAILY_LIMIT = 1;
const MAX_DAILY_LIMIT = 200;

const ALLOWED_ENGINES = new Set(['yandex', 'google']);
const ALLOWED_STATUS_TRANSITIONS = new Set(['draft', 'active', 'paused']);

function _clip(s, n) {
  if (s == null) return '';
  return String(s).slice(0, n).trim();
}

function _clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function _sanitizeCities(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const c of input) {
    const city = _clip(c, 80);
    if (city && !seen.has(city)) { seen.add(city); out.push(city); }
    if (out.length >= MAX_CITIES) break;
  }
  return out;
}

// Наш сайт для подписи письма: нормализуем в https-URL, иначе null.
function _normalizeSenderSite(raw) {
  const s = _clip(raw, 200);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
}

// Telegram отправителя: принимаем @user | user | t.me/user | ссылку,
// сохраняем как каноничную t.me-ссылку, иначе null.
function _normalizeSenderTelegram(raw) {
  const s = _clip(raw, 200);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const user = s.replace(/^@/, '').replace(/^t\.me\//i, '').replace(/\/+$/, '');
  if (!user || !/^[a-zA-Z0-9_]{3,64}$/.test(user)) return null;
  return `https://t.me/${user}`;
}

// Разбирает список получателей прямой рассылки (req 5): массив строк или
// объектов { email, site }. Возвращает [{ email, site }] с валидным email.
const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function _parseDirectRecipients(input) {
  const items = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    let email = '';
    let site = '';
    if (typeof raw === 'string') {
      email = raw.trim();
    } else if (raw && typeof raw === 'object') {
      email = _clip(raw.email, 200);
      site = _clip(raw.site || raw.url, 200);
    }
    email = email.toLowerCase();
    if (!_EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, site: _normalizeSenderSite(site) || site || null });
    if (out.length >= 500) break;
  }
  return out;
}

// ─── GET /api/outreach/campaigns ──────────────────────────────────
async function listCampaigns(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, keyword, niche, business_type, cities, search_engine,
              depth_pages, daily_limit, warmup_week, sender_name, sender_email,
              sender_site, sender_telegram,
              status, total_prospects, total_sent, total_opened, total_clicked,
              total_replied, last_run_at, next_run_at, error_message,
              created_at, updated_at
         FROM outreach_campaigns
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.user.id],
    );
    return res.json({ campaigns: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/outreach/campaigns ─────────────────────────────────
async function createCampaign(req, res, next) {
  try {
    const body = req.body || {};
    const keyword = _clip(body.keyword || body.query, MAX_KEYWORD_LEN);
    const cities = _sanitizeCities(body.cities);
    const searchEngine = _clip(body.search_engine, 16).toLowerCase() || 'yandex';
    const depthPages = _clampInt(body.depth_pages, MIN_DEPTH, MAX_DEPTH, 3);
    const dailyLimit = _clampInt(body.daily_limit, MIN_DAILY_LIMIT, MAX_DAILY_LIMIT, 30);
    const senderName = _clip(body.sender_name, 120) || null;
    const senderSite = _normalizeSenderSite(body.sender_site);
    const senderTelegram = _normalizeSenderTelegram(body.sender_telegram);
    const name = _clip(body.name, MAX_NAME_LEN) || keyword;
    const senderEmail = _clip(body.sender_email, 200) || process.env.OUTREACH_FROM_EMAIL || null;

    if (!keyword) {
      return res.status(400).json({ error: 'Укажите нишу / запрос (keyword)' });
    }
    if (cities.length === 0) {
      return res.status(400).json({ error: 'Укажите хотя бы один город (cities)' });
    }
    if (!ALLOWED_ENGINES.has(searchEngine)) {
      return res.status(400).json({
        error: `search_engine должен быть одним из: ${[...ALLOWED_ENGINES].join(', ')}`,
      });
    }

    // Стартуем сразу активной, чтобы планировщик подхватил кампанию.
    const status = body.status === 'draft' ? 'draft' : 'active';

    // Перед запуском кампании обязательно указываем наш сайт и Telegram,
    // чтобы получатели могли связаться (req 3). Для черновика — не требуем.
    if (status !== 'draft' && (!senderSite || !senderTelegram)) {
      return res.status(400).json({
        error: 'Перед запуском укажите наш сайт (sender_site) и ссылку на Telegram (sender_telegram) — они попадут в подпись письма.',
      });
    }

    const { rows } = await db.query(
      `INSERT INTO outreach_campaigns
          (user_id, name, keyword, cities, search_engine, depth_pages,
           daily_limit, sender_name, sender_email, sender_site, sender_telegram,
           status, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       RETURNING id, name, keyword, niche, business_type, cities, search_engine,
                 depth_pages, daily_limit, warmup_week, sender_name, sender_email,
                 sender_site, sender_telegram,
                 status, total_prospects, total_sent, total_opened, total_clicked,
                 total_replied, last_run_at, next_run_at, created_at`,
      [
        req.user.id, name, keyword, cities, searchEngine, depthPages,
        dailyLimit, senderName, senderEmail, senderSite, senderTelegram, status,
      ],
    );

    return res.status(201).json({ campaign: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// Возвращает кампанию пользователя или null.
async function _findCampaign(id, userId) {
  const { rows } = await db.query(
    `SELECT * FROM outreach_campaigns WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

// ─── GET /api/outreach/campaigns/:id ──────────────────────────────
async function getCampaign(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
    return res.json({ campaign });
  } catch (err) {
    return next(err);
  }
}

// ─── PATCH /api/outreach/campaigns/:id ────────────────────────────
async function updateCampaign(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    const body = req.body || {};
    const sets = [];
    const vals = [];
    let idx = 1;

    // Итоговые значения контактов отправителя (с учётом обновления) —
    // нужны для проверки перед активацией кампании (req 3).
    let nextSite = campaign.sender_site;
    let nextTelegram = campaign.sender_telegram;
    if (body.sender_site !== undefined) {
      nextSite = _normalizeSenderSite(body.sender_site);
      sets.push(`sender_site = $${idx++}`); vals.push(nextSite);
    }
    if (body.sender_telegram !== undefined) {
      nextTelegram = _normalizeSenderTelegram(body.sender_telegram);
      sets.push(`sender_telegram = $${idx++}`); vals.push(nextTelegram);
    }

    const willActivate = (body.status !== undefined && _clip(body.status, 16).toLowerCase() === 'active')
      || body.run_now === true;
    if (willActivate && (!nextSite || !nextTelegram)) {
      return res.status(400).json({
        error: 'Перед запуском укажите наш сайт (sender_site) и ссылку на Telegram (sender_telegram) — они попадут в подпись письма.',
      });
    }

    if (body.status !== undefined) {
      const status = _clip(body.status, 16).toLowerCase();
      if (!ALLOWED_STATUS_TRANSITIONS.has(status)) {
        return res.status(400).json({
          error: `status должен быть одним из: ${[...ALLOWED_STATUS_TRANSITIONS].join(', ')}`,
        });
      }
      sets.push(`status = $${idx++}`); vals.push(status);
      // При возобновлении — запускаем сразу.
      if (status === 'active') { sets.push(`next_run_at = NOW()`); }
    }
    if (body.name !== undefined) {
      sets.push(`name = $${idx++}`); vals.push(_clip(body.name, MAX_NAME_LEN));
    }
    if (body.daily_limit !== undefined) {
      sets.push(`daily_limit = $${idx++}`);
      vals.push(_clampInt(body.daily_limit, MIN_DAILY_LIMIT, MAX_DAILY_LIMIT, campaign.daily_limit));
    }
    if (body.sender_name !== undefined) {
      sets.push(`sender_name = $${idx++}`); vals.push(_clip(body.sender_name, 120) || null);
    }
    if (body.run_now === true) {
      // Форсируем запуск немедленно: обновляем next_run_at И вызываем runTick().
      sets.push(`next_run_at = NOW()`);
      if (body.status === undefined) { sets.push(`status = 'active'`); }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id, req.user.id);

    const { rows } = await db.query(
      `UPDATE outreach_campaigns SET ${sets.join(', ')}
        WHERE id = $${idx++} AND user_id = $${idx++}
      RETURNING *`,
      vals,
    );
        // Если run_now — немедленно запускаем тик планировщика (не ждём 1 час).
    if (body.run_now === true && rows[0]) {
      try {
        const { runTick } = require('../services/outreach/outreachScheduler');
        runTick().catch((e) => console.warn('[outreach/runNow] tick error:', e.message));
      } catch (e) {
        console.warn('[outreach/runNow] scheduler unavailable:', e.message);
      }
    }
    return res.json({ campaign: rows[0] });
  } catch (err) {
    return next(err);
  }
}
// ─── DELETE /api/outreach/campaigns/:id ───────────────────────────
async function deleteCampaign(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM outreach_campaigns WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Кампания не найдена' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/outreach/campaigns/:id/prospects ────────────────────
async function listProspects(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    const offset = (page - 1) * perPage;

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total FROM outreach_prospects WHERE campaign_id = $1`,
      [campaign.id],
    );
    const total = countRows[0]?.total || 0;

    const { rows } = await db.query(
      `SELECT id, url, company_name, inn, emails, phones, messengers, niche, city, services,
              dynamics_yandex, dynamics_google, score, score_breakdown,
              status, created_at
         FROM outreach_prospects
        WHERE campaign_id = $1
        ORDER BY score DESC, created_at DESC
        LIMIT $2 OFFSET $3`,
      [campaign.id, perPage, offset],
    );
    return res.json({ prospects: rows, total, page, per_page: perPage });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/outreach/campaigns/:id/emails ───────────────────────
async function listEmails(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    const offset = (page - 1) * perPage;

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total FROM outreach_emails WHERE campaign_id = $1`,
      [campaign.id],
    );
    const total = countRows[0]?.total || 0;

    const { rows } = await db.query(
      `SELECT id, prospect_id, recipient_email, recipient_domain, subject,
              html_preview, status, error_message, queued_at, sent_at,
              delivered_at, opened_at, clicked_at, replied_at, bounced_at
         FROM outreach_emails
        WHERE campaign_id = $1
        ORDER BY queued_at DESC
        LIMIT $2 OFFSET $3`,
      [campaign.id, perPage, offset],
    );
    return res.json({ emails: rows, total, page, per_page: perPage });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/outreach/campaigns/:id/logs ─────────────────────────
async function listLogs(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    const { rows } = await db.query(
      `SELECT id, level, message, meta, created_at
         FROM outreach_logs
        WHERE campaign_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [campaign.id],
    );
    return res.json({ logs: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/outreach/campaigns/:id/stats ────────────────────────
async function getCampaignStats(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    // Динамика по дням: отправлено / открыто / кликнуто за последние 30 дней.
    const { rows: daily } = await db.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE e.sent_at::date    = d.day) AS sent,
              COUNT(*) FILTER (WHERE e.opened_at::date  = d.day) AS opened,
              COUNT(*) FILTER (WHERE e.clicked_at::date = d.day) AS clicked
         FROM generate_series(
                (NOW() - INTERVAL '29 days')::date, NOW()::date, INTERVAL '1 day'
              ) AS d(day)
         LEFT JOIN outreach_emails e ON e.campaign_id = $1
        GROUP BY d.day
        ORDER BY d.day ASC`,
      [campaign.id],
    );

    // Разбивка по статусам писем.
    const { rows: byStatus } = await db.query(
      `SELECT status, COUNT(*)::int AS count
         FROM outreach_emails
        WHERE campaign_id = $1
        GROUP BY status`,
      [campaign.id],
    );

    const totals = {
      prospects: campaign.total_prospects,
      sent: campaign.total_sent,
      opened: campaign.total_opened,
      clicked: campaign.total_clicked,
      replied: campaign.total_replied,
      open_rate: campaign.total_sent > 0
        ? +(campaign.total_opened / campaign.total_sent * 100).toFixed(1) : 0,
      click_rate: campaign.total_sent > 0
        ? +(campaign.total_clicked / campaign.total_sent * 100).toFixed(1) : 0,
    };

    return res.json({
      totals,
      daily: daily.map((d) => ({
        day: d.day,
        sent: parseInt(d.sent, 10) || 0,
        opened: parseInt(d.opened, 10) || 0,
        clicked: parseInt(d.clicked, 10) || 0,
      })),
      by_status: byStatus,
      warmup_week: campaign.warmup_week,
    });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/outreach/webhooks/resend ───────────────────────────
// Resend использует Svix для подписи событий (svix-id/svix-timestamp/
// svix-signature). Проверяем подпись по сырому телу запроса.
const RESEND_EVENT_MAP = {
  'email.sent':       { status: 'sent',      col: 'sent_at' },
  'email.delivered':  { status: 'delivered', col: 'delivered_at' },
  'email.opened':     { status: 'opened',    col: 'opened_at' },
  'email.clicked':    { status: 'clicked',   col: 'clicked_at' },
  'email.bounced':    { status: 'bounced',   col: 'bounced_at' },
  'email.complained': { status: 'complained', col: null },
};

async function resendWebhook(req, res, next) {
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : null);

    let event;
    if (secret) {
      let Webhook;
      try {
        ({ Webhook } = require('svix'));
      } catch (e) {
        console.warn('[outreach/webhook] svix недоступен:', e.message);
        return res.status(500).json({ error: 'svix не установлен' });
      }
      const payload = raw ? raw.toString('utf8') : JSON.stringify(req.body || {});
      const headers = {
        'svix-id': req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      };
      try {
        const wh = new Webhook(secret);
        event = wh.verify(payload, headers);
      } catch (e) {
        return res.status(401).json({ error: 'Неверная подпись webhook' });
      }
    } else {
      // Без секрета подпись не проверяем (dev-режим).
      event = raw ? JSON.parse(raw.toString('utf8')) : (req.body || {});
    }

    await handleResendEvent(event);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function handleResendEvent(event) {
  const type = event?.type;
  const data = event?.data || {};
  const resendId = data.email_id || data.id;
  if (!type || !resendId) return;

  const mapping = RESEND_EVENT_MAP[type];
  if (!mapping) return;

  // Находим письмо по resend_id.
  const { rows } = await db.query(
    `SELECT id, campaign_id, recipient_email, recipient_domain, status
       FROM outreach_emails WHERE resend_id = $1 LIMIT 1`,
    [resendId],
  );
  const email = rows[0];
  if (!email) return;

  // Обновляем статус и timestamp письма.
  if (mapping.col) {
    await db.query(
      `UPDATE outreach_emails
          SET status = $1, ${mapping.col} = COALESCE(${mapping.col}, NOW())
        WHERE id = $2`,
      [mapping.status, email.id],
    );
  } else {
    await db.query(
      `UPDATE outreach_emails SET status = $1 WHERE id = $2`,
      [mapping.status, email.id],
    );
  }

  // Инкрементируем счётчики кампании (только на первом переходе).
  const counterCol = {
    'email.opened':  'total_opened',
    'email.clicked': 'total_clicked',
  }[type];
  if (counterCol) {
    await db.query(
      `UPDATE outreach_campaigns SET ${counterCol} = ${counterCol} + 1, updated_at = NOW()
        WHERE id = $1`,
      [email.campaign_id],
    );
  }

  // Жалоба на спам → отписываем автоматически (РЕАЛЬНАЯ отписка:
  // ставим unsubscribed_at, чтобы emailSender блокировал отправку — миграция 122).
  if (type === 'email.complained' && email.recipient_email) {
    const addr = email.recipient_email.toLowerCase();
    await db.query(
      `INSERT INTO outreach_unsubscribes (email, domain, token, unsubscribed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email) DO UPDATE SET unsubscribed_at = COALESCE(outreach_unsubscribes.unsubscribed_at, NOW())`,
      [addr, email.recipient_domain, require('crypto').randomBytes(16).toString('hex')],
    );
    await db.query(
      `UPDATE outreach_prospects SET status = 'unsubscribed'
        WHERE campaign_id = $1 AND $2 = ANY(emails)`,
      [email.campaign_id, addr],
    );
  }

  // Отказ (bounce) → помечаем лид отклонённым.
  if (type === 'email.bounced' && email.recipient_email) {
    await db.query(
      `UPDATE outreach_prospects SET status = 'rejected'
        WHERE campaign_id = $1 AND $2 = ANY(emails)`,
      [email.campaign_id, email.recipient_email.toLowerCase()],
    );
  }

  await db.query(
    `INSERT INTO outreach_logs (campaign_id, level, message, meta)
     VALUES ($1, $2, $3, $4)`,
    [
      email.campaign_id,
      type === 'email.bounced' || type === 'email.complained' ? 'warn' : 'info',
      `Событие ${type} для ${email.recipient_email}`,
      JSON.stringify({ resendId, type }),
    ],
  );
}

// ─── GET /api/outreach/unsubscribe ────────────────────────────────
// Публичный эндпоинт. Проверяет токен и добавляет email в отписки.
async function unsubscribe(req, res, next) {
  try {
    const email = _clip(req.query.email, 200).toLowerCase();
    const token = _clip(req.query.token, 128);

    if (!email || !token) {
      return res.status(400).json({ ok: false, error: 'Отсутствует email или token' });
    }

    // Токен был сохранён при постановке письма в очередь.
    const { rows } = await db.query(
      `SELECT email FROM outreach_unsubscribes WHERE email = $1 AND token = $2`,
      [email, token],
    );

    if (rows.length === 0) {
      // Токена нет (или невалиден) — создаём отписку всё равно, но без совпадения
      // токена не подтверждаем как валидную ссылку.
      return res.status(404).json({ ok: false, error: 'Ссылка недействительна' });
    }

        // Помечаем связанные лиды отписанными.
    await db.query(
      `UPDATE outreach_prospects SET status = 'unsubscribed'
        WHERE $1 = ANY(emails)`,
      [email],
    );
    // Фиксируем РЕАЛЬНУЮ отписку: ставим unsubscribed_at (см. миграцию 122).
    // Запись с токеном уже существует (создана при отправке).
    await db.query(
      `UPDATE outreach_unsubscribes SET unsubscribed_at = NOW()
        WHERE email = $1 AND unsubscribed_at IS NULL`,
      [email],
    );
    return res.json({ ok: true, email });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/outreach/campaigns/:id/direct-send ─────────────────
// Прямая рассылка по заданному списку адресатов (req 5). Пользователь
// передаёт список email (и, опционально, сайтов). Для каждого создаётся
// лид, после чего письма проходят тот же конвейер генерации и отправки,
// что и общий поток кампании.
async function directSend(req, res, next) {
  try {
    const campaign = await _findCampaign(req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });

    // Контакты отправителя обязательны (как и при обычном запуске, req 3).
    if (!campaign.sender_site || !campaign.sender_telegram) {
      return res.status(400).json({
        error: 'Укажите наш сайт и ссылку на Telegram в настройках кампании перед рассылкой.',
      });
    }

    const recipients = _parseDirectRecipients(req.body?.recipients);
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'Укажите хотя бы один валидный email в списке recipients.' });
    }

    const appUrl = process.env.APP_URL || 'https://localhost:3000';
    const fromEmail = process.env.OUTREACH_FROM_EMAIL || campaign.sender_email;
    const fromName = process.env.OUTREACH_FROM_NAME || campaign.sender_name || 'SEO Team';

    let queued = 0;
    let skipped = 0;
    const errors = [];

    // Ленивая загрузка сервисов (совпадает с общим конвейером).
    const { prepareAndQueueEmail } = require('../services/outreach/outreachScheduler');

    for (let i = 0; i < recipients.length; i++) {
      const { email, site } = recipients[i];
      try {
        const url = site || `mailto:${email}`;
        const domain = email.split('@')[1];

        // Создаём (или переиспользуем) лид под этого адресата.
        const { rows } = await db.query(
          `INSERT INTO outreach_prospects
             (campaign_id, user_id, url, emails, status)
           VALUES ($1, $2, $3, $4, 'new')
           ON CONFLICT (url, campaign_id)
           DO UPDATE SET emails = EXCLUDED.emails
           RETURNING *`,
          [campaign.id, req.user.id, url, [email]],
        );
        const prospect = rows[0];

        const ok = await prepareAndQueueEmail(campaign, prospect, {
          fromEmail, fromName, appUrl, index: i, total: recipients.length,
        });
        if (ok) queued++; else skipped++;
      } catch (err) {
        skipped++;
        errors.push({ email, error: err.message });
      }
    }

    await db.query(
      `INSERT INTO outreach_logs (campaign_id, level, message, meta)
       VALUES ($1, 'info', $2, $3)`,
      [
        campaign.id,
        `Прямая рассылка: поставлено ${queued}, пропущено ${skipped}`,
        JSON.stringify({ queued, skipped, total: recipients.length }),
      ],
    );

    // Учитываем поставленные письма в счётчике кампании.
    if (queued > 0) {
      await db.query(
        `UPDATE outreach_campaigns
            SET total_prospects = total_prospects + $1,
                last_run_at = NOW(), updated_at = NOW()
          WHERE id = $2`,
        [queued, campaign.id],
      );
    }

    return res.json({ ok: true, queued, skipped, total: recipients.length, errors });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listCampaigns,
  createCampaign,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  listProspects,
  listEmails,
  listLogs,
  getCampaignStats,
  directSend,
  resendWebhook,
  unsubscribe,
  handleResendEvent,
};
