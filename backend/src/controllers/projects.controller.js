'use strict';

/**
 * Controller модуля «Проекты» (SEO-проекты + интеграция с Google Search
 * Console + AI-аналитика DeepSeek + публичный шаринг).
 *
 *   GET    /api/projects                     — список проектов пользователя
 *   POST   /api/projects                     — создать проект
 *   GET    /api/projects/:id                 — карточка проекта (+ статус GSC)
 *   PUT    /api/projects/:id                 — обновить
 *   DELETE /api/projects/:id                 — удалить
 *   GET    /api/projects/:id/gsc/auth-url    — ссылка OAuth (подключить GSC)
 *   GET    /api/projects/:id/gsc/sites       — подтверждённые домены
 *   POST   /api/projects/:id/gsc/select-site — выбрать домен
 *   DELETE /api/projects/:id/gsc             — отключить GSC
 *   GET    /api/projects/:id/performance     — данные дашборда (с кэшем)
 *   POST   /api/projects/:id/analyze         — запустить AI-аналитику (фон)
 *   GET    /api/projects/:id/analyses        — список анализов
 *   GET    /api/projects/:id/analyses/:aid   — отчёт анализа
 *   POST   /api/projects/:id/share           — выпустить публичную ссылку
 *   DELETE /api/projects/:id/share           — отозвать ссылку
 *
 *   public (без auth, отдельный роутер):
 *   GET    /api/public/projects/gsc/callback — OAuth-колбэк Google
 *   GET    /api/public/project/:token        — read-only дашборд
 */

const db = require('../config/db');
const { getProjectsConfig, getGoogleOAuthConfig } = require('../services/projects/config');
const gsc = require('../services/projects/gscClient');
const { encryptToken } = require('../services/projects/tokenCrypto');
const { fetchPerformanceSeries } = require('../services/projects/gscService');
const { processAnalysis } = require('../services/projects/analysisRunner');
const { generateShareToken, isValidShareToken } = require('../services/projects/shareToken');

const CFG = getProjectsConfig();

// ── sanitization ────────────────────────────────────────────────────
function _clipName(v) {
  return String(v || '').slice(0, CFG.limits.nameMax).trim();
}
function _clipAudience(v) {
  if (v == null) return null;
  const s = String(v).slice(0, CFG.limits.audienceMax).trim();
  return s || null;
}
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

// Публичная (безопасная) проекция строки проекта — без *_enc токенов.
const PUBLIC_COLUMNS = `
  id, name, url, audience_description,
  gsc_connected, gsc_site_url, gsc_available_sites,
  (gsc_refresh_token_enc IS NOT NULL) AS gsc_has_refresh,
  share_token, share_created_at, created_at, updated_at`;

function _frontendBase() {
  // Базовый URL фронта для редиректа после OAuth. По умолчанию — относительный
  // путь (backend и frontend за одним nginx). Можно переопределить секретом
  // окружения без правки .env.example.
  return process.env.FRONTEND_BASE_URL || '';
}

// ── CRUD ────────────────────────────────────────────────────────────
async function listProjects(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM projects
        WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ projects: rows });
  } catch (err) { return next(err); }
}

async function createProject(req, res, next) {
  try {
    const name = _clipName(req.body && req.body.name);
    const url = _sanitizeUrl(req.body && req.body.url);
    const audience = _clipAudience(req.body && req.body.audience_description);
    if (!name) return res.status(400).json({ error: 'Название проекта обязательно' });
    if (!url) return res.status(400).json({ error: 'Укажите корректную ссылку на проект (http/https)' });
    const { rows } = await db.query(
      `INSERT INTO projects (user_id, name, url, audience_description)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [req.user.id, name, url, audience],
    );
    return res.status(201).json({ project: rows[0] });
  } catch (err) { return next(err); }
}

async function _loadOwned(id, userId) {
  const { rows } = await db.query(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

async function getProject(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Проект не найден' });
    const project = rows[0];
    const { rows: analyses } = await db.query(
      `SELECT id, status, range_key, period_from, period_to, created_at, completed_at,
              error_message
         FROM project_analyses
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [project.id],
    );
    return res.json({
      project,
      analyses,
      gsc_configured: getGoogleOAuthConfig().configured,
      date_presets: CFG.datePresets,
    });
  } catch (err) { return next(err); }
}

async function updateProject(req, res, next) {
  try {
    const existing = await _loadOwned(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Проект не найден' });
    const name = req.body && req.body.name != null ? _clipName(req.body.name) : existing.name;
    const url = req.body && req.body.url != null ? _sanitizeUrl(req.body.url) : existing.url;
    const audience = req.body && 'audience_description' in req.body
      ? _clipAudience(req.body.audience_description)
      : existing.audience_description;
    if (!name) return res.status(400).json({ error: 'Название проекта обязательно' });
    if (!url) return res.status(400).json({ error: 'Укажите корректную ссылку на проект' });
    const { rows } = await db.query(
      `UPDATE projects SET name=$2, url=$3, audience_description=$4, updated_at=NOW()
        WHERE id=$1 RETURNING ${PUBLIC_COLUMNS}`,
      [existing.id, name, url, audience],
    );
    return res.json({ project: rows[0] });
  } catch (err) { return next(err); }
}

async function deleteProject(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM projects WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Проект не найден' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
}

// ── GSC OAuth ───────────────────────────────────────────────────────
async function getGscAuthUrl(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const url = gsc.buildAuthUrl(project.id, req.user.id);
    return res.json({ auth_url: url });
  } catch (err) {
    return _gscError(res, next, err);
  }
}

// OAuth-колбэк Google. Публичный (браузерный редирект). Проверяем state,
// меняем code на токены, получаем sites.list, сохраняем зашифрованные токены.
async function handleGscCallback(req, res) {
  const base = _frontendBase();
  const fail = (projectId, reason) => {
    const target = `${base}/projects/${projectId || ''}?gsc=error&reason=${encodeURIComponent(reason)}`;
    return res.redirect(target);
  };
  try {
    const { code, state, error } = req.query;
    const decoded = gsc.verifyState(state);
    if (!decoded) return fail('', 'invalid_state');
    if (error) return fail(decoded.projectId, String(error));
    if (!code) return fail(decoded.projectId, 'no_code');

    // Проект ещё принадлежит этому пользователю?
    const { rows } = await db.query(
      `SELECT id FROM projects WHERE id=$1 AND user_id=$2`,
      [decoded.projectId, decoded.userId],
    );
    if (rows.length === 0) return fail(decoded.projectId, 'project_not_found');

    const tokens = await gsc.exchangeCodeForTokens(String(code));
    const sites = await gsc.listSites(tokens.accessToken);
    const expiry = new Date(Date.now() + tokens.expiresIn * 1000);

    // refresh_token приходит только при первом согласии — не затираем его null'ом.
    const refreshEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
    await db.query(
      `UPDATE projects
          SET gsc_connected = TRUE,
              gsc_access_token_enc = $2,
              gsc_refresh_token_enc = COALESCE($3, gsc_refresh_token_enc),
              gsc_token_expiry = $4,
              gsc_available_sites = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [decoded.projectId, encryptToken(tokens.accessToken), refreshEnc, expiry, JSON.stringify(sites)],
    );
    return res.redirect(`${base}/projects/${decoded.projectId}?gsc=connected`);
  } catch (err) {
    return res.redirect(`${base}/projects?gsc=error&reason=${encodeURIComponent(err.code || 'oauth_failed')}`);
  }
}

async function listGscSites(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    // Если уже подключён — отдаём сохранённый список; иначе пусто.
    const sites = Array.isArray(project.gsc_available_sites) ? project.gsc_available_sites : [];
    return res.json({ connected: !!project.gsc_connected, sites, selected: project.gsc_site_url || null });
  } catch (err) { return next(err); }
}

async function selectGscSite(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.gsc_connected) return res.status(409).json({ error: 'Сначала подключите Google Search Console' });
    const siteUrl = String((req.body && req.body.site_url) || '').trim();
    const available = Array.isArray(project.gsc_available_sites) ? project.gsc_available_sites : [];
    if (!siteUrl || !available.some((s) => s.siteUrl === siteUrl)) {
      return res.status(400).json({ error: 'Выбранный домен недоступен в этом аккаунте GSC' });
    }
    const { rows } = await db.query(
      `UPDATE projects SET gsc_site_url=$2, updated_at=NOW()
        WHERE id=$1 RETURNING ${PUBLIC_COLUMNS}`,
      [project.id, siteUrl],
    );
    return res.json({ project: rows[0] });
  } catch (err) { return next(err); }
}

async function disconnectGsc(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE projects
          SET gsc_connected = FALSE, gsc_access_token_enc = NULL,
              gsc_refresh_token_enc = NULL, gsc_token_expiry = NULL,
              gsc_available_sites = NULL, gsc_site_url = NULL, updated_at = NOW()
        WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Проект не найден' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
}

// ── Дашборд ─────────────────────────────────────────────────────────
async function getPerformance(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.gsc_connected || !project.gsc_site_url) {
      return res.status(409).json({ error: 'Подключите GSC и выберите домен' });
    }
    const range = _rangeFromQuery(req.query);
    const data = await fetchPerformanceSeries(project, range);
    return res.json(data);
  } catch (err) {
    return _gscError(res, next, err);
  }
}

// ── AI-аналитика ────────────────────────────────────────────────────
async function startAnalysis(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.gsc_connected || !project.gsc_site_url) {
      return res.status(409).json({ error: 'Подключите GSC и выберите домен перед анализом' });
    }
    const { rangeKey, from, to } = _normalizeRangeInput(req.body || {});
    const { rows } = await db.query(
      `INSERT INTO project_analyses (project_id, user_id, status, range_key, period_from, period_to)
       VALUES ($1, $2, 'queued', $3, $4, $5)
       RETURNING id, status, range_key, period_from, period_to, created_at`,
      [project.id, req.user.id, rangeKey, from, to],
    );
    const analysis = rows[0];
    // Фоновый запуск — не блокируем HTTP-ответ (DeepSeek 30–60 c+).
    setImmediate(() => { processAnalysis(analysis.id).catch(() => {}); });
    return res.status(202).json({ analysis });
  } catch (err) { return next(err); }
}

async function listAnalyses(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const { rows } = await db.query(
      `SELECT id, status, range_key, period_from, period_to, created_at, completed_at,
              error_message, cost_usd
         FROM project_analyses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [project.id],
    );
    return res.json({ analyses: rows });
  } catch (err) { return next(err); }
}

async function getAnalysis(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.status, a.range_key, a.period_from, a.period_to,
              a.report_markdown, a.gsc_snapshot, a.llm_model, a.cost_usd,
              a.error_message, a.created_at, a.completed_at
         FROM project_analyses a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND a.project_id = $2 AND p.user_id = $3`,
      [req.params.aid, req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Анализ не найден' });
    return res.json({ analysis: rows[0] });
  } catch (err) { return next(err); }
}

// ── Шаринг ──────────────────────────────────────────────────────────
async function createShareLink(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (project.share_token) return res.json({ token: project.share_token });
    let token = generateShareToken();
    for (let i = 0; i < 5; i++) {
      try {
        await db.query(
          `UPDATE projects SET share_token=$2, share_created_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [project.id, token],
        );
        break;
      } catch (err) {
        if (err && err.code === '23505') { token = generateShareToken(); continue; }
        throw err;
      }
    }
    return res.json({ token });
  } catch (err) { return next(err); }
}

async function revokeShareLink(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE projects SET share_token=NULL, share_created_at=NULL, updated_at=NOW()
        WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Проект не найден' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
}

// ── Публичный read-only дашборд ─────────────────────────────────────
async function getSharedProject(req, res, next) {
  try {
    const token = String(req.params.token || '');
    if (!isValidShareToken(token)) return res.status(400).json({ error: 'Некорректный токен' });
    const { rows } = await db.query(
      `SELECT id, name, url, audience_description, gsc_site_url, share_created_at, created_at
         FROM projects WHERE share_token = $1 LIMIT 1`,
      [token],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ссылка недействительна или отозвана' });
    const project = rows[0];
    // Последний завершённый анализ — содержит и snapshot (графики), и markdown-отчёт.
    const { rows: aRows } = await db.query(
      `SELECT id, status, range_key, period_from, period_to,
              report_markdown, gsc_snapshot, created_at, completed_at
         FROM project_analyses
        WHERE project_id = $1 AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
      [project.id],
    );
    return res.json({ project, analysis: aRows[0] || null });
  } catch (err) { return next(err); }
}

// ── helpers ─────────────────────────────────────────────────────────
function _rangeFromQuery(q) {
  q = q || {};
  if (q.from && q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.from) && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
    return { from: q.from, to: q.to };
  }
  const preset = CFG.datePresets.find((p) => p.key === q.range);
  return { days: preset ? preset.days : 28 };
}

function _normalizeRangeInput(body) {
  const from = (body.from && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) ? body.from : null;
  const to = (body.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to)) ? body.to : null;
  if (from && to) return { rangeKey: 'custom', from, to };
  const preset = CFG.datePresets.find((p) => p.key === body.range);
  return { rangeKey: preset ? preset.key : '28d', from: null, to: null };
}

function _gscError(res, next, err) {
  if (err && err.name === 'GscError') {
    return res.status(err.httpStatus || 502).json({ error: err.message, code: err.code });
  }
  return next(err);
}

module.exports = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  getGscAuthUrl,
  handleGscCallback,
  listGscSites,
  selectGscSite,
  disconnectGsc,
  getPerformance,
  startAnalysis,
  listAnalyses,
  getAnalysis,
  createShareLink,
  revokeShareLink,
  getSharedProject,
};
