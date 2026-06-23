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
const { getProjectsConfig, getGoogleOAuthConfig, getYandexOAuthConfig } = require('../services/projects/config');
const gsc = require('../services/projects/gscClient');
const ydx = require('../services/projects/ydxClient');
const { encryptToken } = require('../services/projects/tokenCrypto');
const { fetchPerformanceSeries, fetchTopDimensions } = require('../services/projects/gscService');
const ydxService = require('../services/projects/ydxService');
const { compareSources } = require('../services/projects/sourceComparison');
const { processAnalysis, collectSnapshot } = require('../services/projects/analysisRunner');
const { generateShareToken, isValidShareToken } = require('../services/projects/shareToken');
const {
  VIEW_MODES,
  resolveViewMode,
  normalizeMode,
  sanitizeProject,
  sanitizeAnalysis,
} = require('../services/projects/viewMode');
const { buildLeadContext } = require('../services/projects/leadContext');
const snapshotsRepo = require('../services/projects/snapshotsRepo');
const { compareSnapshots } = require('../services/projects/periodComparison');
const { ensureLinkedPositionProject, syncLinkedPositionProject } = require('../services/projects/positionBridge');
const freshnessService = require('../services/projects/freshnessService');

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

// ── branding sanitizers (logo url / accent color / Keys.so domain & region) ─
function _sanitizeLogoUrl(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 500);
  if (!s) return null;
  // Разрешаем только http(s):// и data:image/* (для логотипов SVG/PNG inline).
  if (/^data:image\//i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (_) { return null; }
}
function _sanitizeAccent(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}
function _sanitizeKeysSoDomain(v) {
  if (v == null) return null;
  let raw = String(v).trim().toLowerCase().slice(0, 400);
  if (!raw) return null;
  // Принимаем как голый домен, так и URL — нормализуем без backtracking-уязвимых regex.
  if (raw.startsWith('https://')) raw = raw.slice(8);
  else if (raw.startsWith('http://')) raw = raw.slice(7);
  const slashIdx = raw.indexOf('/');
  if (slashIdx >= 0) raw = raw.slice(0, slashIdx);
  if (raw.startsWith('www.')) raw = raw.slice(4);
  const stripped = raw;
  // Простая защита от мусора: должен содержать минимум одну точку и валидные символы.
  if (!/^[a-z0-9.\-]+\.[a-z]{2,}$/i.test(stripped)) return null;
  return stripped.slice(0, 200);
}
const KEYS_SO_REGIONS = new Set([
  'msk', 'gru', 'zen', 'gkv', 'rnd', 'ekb', 'ufa', 'sar', 'krr', 'prm',
  'sam', 'kry', 'oms', 'kzn', 'che', 'nsk', 'nnv', 'vlg', 'vrn', 'spb',
  'mns', 'tmn', 'gmns', 'tom', 'gny',
]);
function _sanitizeKeysSoRegion(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  return KEYS_SO_REGIONS.has(s) ? s : null;
}

// Публичная (безопасная) проекция строки проекта — без *_enc токенов.
const PUBLIC_COLUMNS = `
  id, name, url, audience_description,
  logo_url, color_accent, keys_so_domain, keys_so_region,
  gsc_connected, gsc_site_url, gsc_available_sites,
  (gsc_refresh_token_enc IS NOT NULL) AS gsc_has_refresh,
  ydx_connected, ydx_site_url, ydx_available_sites,
  (ydx_refresh_token_enc IS NOT NULL) AS ydx_has_refresh,
  (SELECT pp.id FROM position_projects pp WHERE pp.parent_project_id = projects.id LIMIT 1) AS linked_position_project_id,
  share_token, share_created_at, share_mode, share_expires_at, created_at, updated_at`;

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
    await ensureLinkedPositionProject({ ...rows[0], user_id: req.user.id });
    const { rows: finalRows } = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
      [rows[0].id, req.user.id],
    );
    return res.status(201).json({ project: finalRows[0] || rows[0] });
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
    const mode = resolveViewMode(req);
    const project = sanitizeProject(rows[0], mode);
    const { rows: analyses } = await db.query(
      `SELECT id, status, range_key, period_from, period_to, created_at, completed_at,
              error_message
         FROM project_analyses
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [project.id],
    );
    const { rows: linkedRows } = await db.query(
      `SELECT id, name, domain, engine::text AS engine, geo_lr, geo_loc,
              device::text AS device, schedule::text AS schedule, last_run_at
         FROM position_projects
        WHERE parent_project_id = $1
        LIMIT 1`,
      [project.id],
    );
    return res.json({
      project,
      view_mode: mode,
      position_project: linkedRows[0] || null,
      analyses,
      gsc_configured: getGoogleOAuthConfig().configured,
      ydx_configured: getYandexOAuthConfig().configured,
      date_presets: CFG.datePresets,
    });
  } catch (err) { return next(err); }
}

async function updateProject(req, res, next) {
  try {
    const existing = await _loadOwned(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Проект не найден' });
    const body = req.body || {};
    const name = body.name != null ? _clipName(body.name) : existing.name;
    const url = body.url != null ? _sanitizeUrl(body.url) : existing.url;
    const audience = 'audience_description' in body
      ? _clipAudience(body.audience_description)
      : existing.audience_description;
    // Поля брендинга и интеграции с источниками — обновляем только если ключ
    // явно присутствует в payload (пустая строка трактуется как «очистить»).
    const logoUrl = 'logo_url' in body ? _sanitizeLogoUrl(body.logo_url) : existing.logo_url;
    const accent = 'color_accent' in body ? _sanitizeAccent(body.color_accent) : existing.color_accent;
    const keysSoDomain = 'keys_so_domain' in body
      ? _sanitizeKeysSoDomain(body.keys_so_domain)
      : existing.keys_so_domain;
    const keysSoRegion = 'keys_so_region' in body
      ? (_sanitizeKeysSoRegion(body.keys_so_region) || (body.keys_so_region == null ? null : existing.keys_so_region))
      : existing.keys_so_region;
    if (!name) return res.status(400).json({ error: 'Название проекта обязательно' });
    if (!url) return res.status(400).json({ error: 'Укажите корректную ссылку на проект' });
    const { rows } = await db.query(
      `UPDATE projects SET name=$2, url=$3, audience_description=$4,
              logo_url=$5, color_accent=$6, keys_so_domain=$7, keys_so_region=$8,
              updated_at=NOW()
        WHERE id=$1 RETURNING ${PUBLIC_COLUMNS}`,
      [existing.id, name, url, audience, logoUrl, accent, keysSoDomain, keysSoRegion],
    );
    await syncLinkedPositionProject({
      id: existing.id,
      name,
      url,
      keys_so_domain: keysSoDomain,
    });
    const { rows: linkedRows } = await db.query(
      `SELECT id, name, domain, engine::text AS engine, geo_lr, geo_loc,
              device::text AS device, schedule::text AS schedule, last_run_at
         FROM position_projects
        WHERE parent_project_id = $1
        LIMIT 1`,
      [existing.id],
    );
    return res.json({ project: { ...(rows[0] || {}), position_project: linkedRows[0] || null } });
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

// ── Яндекс.Вебмастер OAuth (полный аналог GSC) ──────────────────────
async function getYdxAuthUrl(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const url = ydx.buildAuthUrl(project.id, req.user.id);
    return res.json({ auth_url: url });
  } catch (err) {
    return _integrationError(res, next, err);
  }
}

// OAuth-колбэк Яндекса. Публичный (браузерный редирект). Проверяем state,
// меняем code на токены, получаем список хостов, сохраняем зашифрованные токены.
async function handleYdxCallback(req, res) {
  const base = _frontendBase();
  const fail = (projectId, reason) => {
    const target = `${base}/projects/${projectId || ''}?ydx=error&reason=${encodeURIComponent(reason)}`;
    return res.redirect(target);
  };
  try {
    const { code, state, error } = req.query;
    const decoded = ydx.verifyState(state);
    if (!decoded) return fail('', 'invalid_state');
    if (error) return fail(decoded.projectId, String(error));
    if (!code) return fail(decoded.projectId, 'no_code');

    const { rows } = await db.query(
      `SELECT id FROM projects WHERE id=$1 AND user_id=$2`,
      [decoded.projectId, decoded.userId],
    );
    if (rows.length === 0) return fail(decoded.projectId, 'project_not_found');

    const tokens = await ydx.exchangeCodeForTokens(String(code));
    const userId = await ydx.getUserId(tokens.accessToken);
    const sites = await ydx.listHosts(tokens.accessToken, userId);
    const expiry = new Date(Date.now() + tokens.expiresIn * 1000);

    const refreshEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
    await db.query(
      `UPDATE projects
          SET ydx_connected = TRUE,
              ydx_access_token_enc = $2,
              ydx_refresh_token_enc = COALESCE($3, ydx_refresh_token_enc),
              ydx_token_expiry = $4,
              ydx_available_sites = $5,
              updated_at = NOW()
        WHERE id = $1`,
      [decoded.projectId, encryptToken(tokens.accessToken), refreshEnc, expiry, JSON.stringify(sites)],
    );
    return res.redirect(`${base}/projects/${decoded.projectId}?ydx=connected`);
  } catch (err) {
    return res.redirect(`${base}/projects?ydx=error&reason=${encodeURIComponent(err.code || 'oauth_failed')}`);
  }
}

async function listYdxSites(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const sites = Array.isArray(project.ydx_available_sites) ? project.ydx_available_sites : [];
    return res.json({ connected: !!project.ydx_connected, sites, selected: project.ydx_site_url || null });
  } catch (err) { return next(err); }
}

async function selectYdxSite(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.ydx_connected) return res.status(409).json({ error: 'Сначала подключите Яндекс.Вебмастер' });
    const siteUrl = String((req.body && req.body.site_url) || '').trim();
    const available = Array.isArray(project.ydx_available_sites) ? project.ydx_available_sites : [];
    if (!siteUrl || !available.some((s) => s.siteUrl === siteUrl)) {
      return res.status(400).json({ error: 'Выбранный сайт недоступен в этом аккаунте Яндекс.Вебмастера' });
    }
    const { rows } = await db.query(
      `UPDATE projects SET ydx_site_url=$2, updated_at=NOW()
        WHERE id=$1 RETURNING ${PUBLIC_COLUMNS}`,
      [project.id, siteUrl],
    );
    return res.json({ project: rows[0] });
  } catch (err) { return next(err); }
}

async function disconnectYdx(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE projects
          SET ydx_connected = FALSE, ydx_access_token_enc = NULL,
              ydx_refresh_token_enc = NULL, ydx_token_expiry = NULL,
              ydx_available_sites = NULL, ydx_site_url = NULL, updated_at = NOW()
        WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Проект не найден' });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
}

// GET /:id/ydx/performance — данные дашборда Яндекс.Вебмастера.
async function getYdxPerformance(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.ydx_connected || !project.ydx_site_url) {
      return res.status(409).json({ error: 'Подключите Яндекс.Вебмастер и выберите сайт' });
    }
    const range = _rangeFromQuery(req.query);
    const data = await ydxService.fetchPerformanceSeries(project, range);
    return res.json(data);
  } catch (err) {
    return _integrationError(res, next, err);
  }
}

// ── Сопоставление источников (GSC ↔ Яндекс.Вебмастер) ───────────────
// GET /:id/compare — тянет показатели и топ-запросы из обеих систем,
// считает дельты и формирует рекомендации по улучшению. Источник, который
// не подключён или вернул ошибку, тихо пропускается (сравниваем доступное).
async function compareProjectSources(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const range = _rangeFromQuery(req.query);

    let gscData = null;
    let ydxData = null;
    const errors = {};

    if (project.gsc_connected && project.gsc_site_url) {
      try {
        const [perf, top] = await Promise.all([
          fetchPerformanceSeries(project, range),
          fetchTopDimensions(project, range),
        ]);
        gscData = { totals: perf.totals, topQueries: top.topQueries };
      } catch (err) { errors.google = err.code || err.message; }
    }

    if (project.ydx_connected && project.ydx_site_url) {
      try {
        const [perf, top] = await Promise.all([
          ydxService.fetchPerformanceSeries(project, range),
          ydxService.fetchTopDimensions(project, range),
        ]);
        ydxData = { totals: perf.totals, topQueries: top.topQueries };
      } catch (err) { errors.yandex = err.code || err.message; }
    }

    const comparison = compareSources(gscData, ydxData);
    return res.json({
      comparison,
      connected: {
        google: Boolean(project.gsc_connected && project.gsc_site_url),
        yandex: Boolean(project.ydx_connected && project.ydx_site_url),
      },
      errors,
    });
  } catch (err) {
    return _integrationError(res, next, err);
  }
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
              error_message, cost_usd, snapshot_id
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
              a.ydx_snapshot, a.ydx_report_markdown, a.synthesis_markdown, a.ranking_factors,
              a.error_message, a.created_at, a.completed_at, a.snapshot_id
         FROM project_analyses a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND a.project_id = $2 AND p.user_id = $3`,
      [req.params.aid, req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Анализ не найден' });
    const mode = resolveViewMode(req);
    return res.json({ analysis: sanitizeAnalysis(rows[0], mode), view_mode: mode });
  } catch (err) { return next(err); }
}

// ── GET /api/projects/:id/lead-context ─────────────────────────────
// Подтягиваем «контекст» проекта (имя/url/описание + последний анализ) для
// префилла формы инструмента «Lead-text + Фасетный SEO-оптимизатор».
async function getLeadContext(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const payload = await buildLeadContext(db, project);
    return res.json(payload);
  } catch (err) { return next(err); }
}

// ── Snapshots GSC (PR 1: персистентность) ──────────────────────────
// Снимок — голая выгрузка GSC за период, отдельная сущность, не привязанная
// к LLM-анализу. Используется для дашборда, истории, сравнения дельты.

async function listProjectSnapshots(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const snapshots = await snapshotsRepo.listSnapshots(project.id, { limit });
    return res.json({ snapshots });
  } catch (err) { return next(err); }
}

async function createProjectSnapshot(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.gsc_connected || !project.gsc_site_url) {
      return res.status(409).json({ error: 'Подключите GSC и выберите домен перед сбором снимка' });
    }
    const { rangeKey, from, to } = _normalizeRangeInput(req.body || {});
    const range = (from && to) ? { from, to } : { days: _daysForKey(rangeKey) };
    const { snapshot } = await collectSnapshot(project, range);
    const ins = await snapshotsRepo.insertSnapshot({
      projectId: project.id,
      userId: req.user.id,
      rangeKey,
      periodFrom: snapshot.range.startDate,
      periodTo: snapshot.range.endDate,
      source: 'manual',
      gscData: snapshot,
    });
    return res.status(201).json({
      snapshot: {
        id: ins.id,
        range_key: rangeKey,
        period_from: snapshot.range.startDate,
        period_to: snapshot.range.endDate,
        source: 'manual',
        created_at: ins.created_at,
        totals: snapshot.totals,
      },
    });
  } catch (err) {
    return _gscError(res, next, err);
  }
}

async function getProjectSnapshot(req, res, next) {
  try {
    const snap = await snapshotsRepo.getSnapshot(req.params.sid, req.params.id, req.user.id);
    if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
    return res.json({ snapshot: snap });
  } catch (err) { return next(err); }
}

async function diffProjectSnapshot(req, res, next) {
  try {
    const curr = await snapshotsRepo.getSnapshot(req.params.sid, req.params.id, req.user.id);
    if (!curr) return res.status(404).json({ error: 'Снимок не найден' });
    let prev = null;
    if (req.query.prev) {
      prev = await snapshotsRepo.getSnapshot(String(req.query.prev), req.params.id, req.user.id);
      if (!prev) return res.status(404).json({ error: 'Предыдущий снимок не найден' });
    } else {
      prev = await snapshotsRepo.findPreviousSnapshot(req.params.id, curr.id);
    }
    if (!prev) {
      return res.json({ diff: { available: false, reason: 'no_previous_snapshot' } });
    }
    const cfg = CFG.periodCompare || {};
    const diff = compareSnapshots(curr.gsc_data, prev.gsc_data, {
      minImpressions: cfg.minImpressions,
      minClicksAbsDelta: cfg.minClicksAbsDelta,
      topQueriesDelta: cfg.topQueriesDelta,
      topPagesDelta: cfg.topPagesDelta,
    });
    return res.json({
      diff,
      curr: { id: curr.id, period_from: curr.period_from, period_to: curr.period_to },
      prev: { id: prev.id, period_from: prev.period_from, period_to: prev.period_to },
    });
  } catch (err) { return next(err); }
}

function _daysForKey(key) {
  switch (key) {
    case '7d': return 7;
    case '3m': return 90;
    case '6m': return 180;
    case '28d':
    default: return 28;
  }
}

// ── Шаринг ──────────────────────────────────────────────────────────
// POST /api/projects/:id/share — body: { mode?: 'analyst'|'client', ttlDays?: number }
//   • mode    — режим payload для получателя (default: 'client').
//   • ttlDays — срок действия в днях (1..365). Default: 90. 0/null → бессрочно.
// Если ссылка уже выпущена, ре-выпускает её с новыми параметрами (mode/expires_at);
// сам токен сохраняется, чтобы не ломать уже отправленные клиенту URL.
async function createShareLink(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const body = req.body || {};
    const mode = normalizeMode(body.mode, VIEW_MODES.CLIENT);
    let ttlDays = Number(body.ttlDays);
    if (!Number.isFinite(ttlDays) || ttlDays < 0) ttlDays = 90;
    if (ttlDays > 365) ttlDays = 365;
    const expiresClause = ttlDays > 0 ? `NOW() + ($3 || ' days')::INTERVAL` : `NULL`;
    const expiresParam = ttlDays > 0 ? [String(ttlDays)] : [];

    // Если токен уже есть — только обновим параметры доступа.
    if (project.share_token) {
      await db.query(
        `UPDATE projects
            SET share_mode=$2, share_expires_at=${expiresClause}, updated_at=NOW()
          WHERE id=$1`,
        [project.id, mode, ...expiresParam],
      );
      const { rows } = await db.query(
        `SELECT share_token, share_mode, share_expires_at, share_created_at
           FROM projects WHERE id=$1`,
        [project.id],
      );
      return res.json({
        token: rows[0].share_token,
        mode:  rows[0].share_mode,
        expires_at:  rows[0].share_expires_at,
        created_at:  rows[0].share_created_at,
      });
    }

    // Выпускаем новый токен, ретраи на коллизию unique-индекса.
    let token = generateShareToken();
    for (let i = 0; i < 5; i++) {
      try {
        await db.query(
          `UPDATE projects
              SET share_token=$2, share_created_at=NOW(),
                  share_mode=$3, share_expires_at=${expiresClause},
                  updated_at=NOW()
            WHERE id=$1`,
          [project.id, token, mode, ...expiresParam],
        );
        break;
      } catch (err) {
        if (err && err.code === '23505') { token = generateShareToken(); continue; }
        throw err;
      }
    }
    const { rows } = await db.query(
      `SELECT share_token, share_mode, share_expires_at, share_created_at
         FROM projects WHERE id=$1`,
      [project.id],
    );
    return res.json({
      token: rows[0].share_token,
      mode:  rows[0].share_mode,
      expires_at:  rows[0].share_expires_at,
      created_at:  rows[0].share_created_at,
    });
  } catch (err) { return next(err); }
}

async function revokeShareLink(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `UPDATE projects
          SET share_token=NULL, share_created_at=NULL, share_expires_at=NULL,
              share_mode='client', updated_at=NOW()
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
      `SELECT id, name, url, audience_description, gsc_site_url, share_mode,
              share_created_at, share_expires_at, created_at
         FROM projects WHERE share_token = $1 LIMIT 1`,
      [token],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ссылка недействительна или отозвана' });
    const project = rows[0];
    // Проверка срока действия: NULL = бессрочно.
    if (project.share_expires_at && new Date(project.share_expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Срок действия ссылки истёк', code: 'SHARE_EXPIRED' });
    }
    const mode = normalizeMode(project.share_mode, VIEW_MODES.CLIENT);
    // Последний завершённый анализ — содержит и snapshot (графики), и markdown-отчёт.
    const { rows: aRows } = await db.query(
      `SELECT id, status, range_key, period_from, period_to,
              report_markdown, gsc_snapshot,
              ydx_snapshot, ydx_report_markdown, synthesis_markdown, ranking_factors,
              created_at, completed_at
         FROM project_analyses
        WHERE project_id = $1 AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
      [project.id],
    );
    return res.json({
      project: sanitizeProject(project, mode),
      analysis: aRows[0] ? sanitizeAnalysis(aRows[0], mode) : null,
      view_mode: mode,
    });
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

// Обобщённый обработчик ошибок интеграций (GSC + Яндекс.Вебмастер): обе
// ошибки несут httpStatus/code, поэтому отдаём их клиенту единообразно.
function _integrationError(res, next, err) {
  if (err && (err.name === 'GscError' || err.name === 'YdxError')) {
    return res.status(err.httpStatus || 502).json({ error: err.message, code: err.code });
  }
  return next(err);
}

// ── Расширение «Анализ GSC» (п.1-8 ТЗ) ──────────────────────────────────

/**
 * POST /:id/gsc-links/import — импорт CSV-выгрузки «Ссылки» из GSC UI.
 * Принимает multipart-файл (поле "file") ИЛИ сырой CSV в body.csv.
 * Тип таблицы (sites/pages/anchors) определяется автоматически по заголовку.
 */
async function importGscLinks(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const linkCfg = CFG.linkStrategy || {};
    let csvText = '';
    if (req.file && req.file.buffer) {
      if (req.file.size > (linkCfg.importMaxBytes || 5_000_000)) {
        return res.status(413).json({ error: 'Файл слишком большой' });
      }
      csvText = req.file.buffer.toString('utf8');
    } else if (req.body && typeof req.body.csv === 'string') {
      csvText = req.body.csv;
    }
    if (!csvText.trim()) return res.status(400).json({ error: 'Пустой CSV' });

    const { importLinksCsv } = require('../services/projects/linkStrategy/linksImporter');
    const { saveImport } = require('../services/projects/linkStrategy/linksRepo');
    const parsed = importLinksCsv(csvText);
    if (parsed.type === 'unknown') {
      return res.status(422).json({ error: 'Не удалось определить тип таблицы GSC (sites/pages/anchors)' });
    }
    const saved = await saveImport({
      projectId: project.id, userId: req.user.id, type: parsed.type, rows: parsed.rows,
    });
    return res.json({ type: parsed.type, imported: saved.inserted, parsed: parsed.count });
  } catch (err) { return next(err); }
}

/**
 * POST /:id/meta-suggestions/regenerate — перегенерация мета-тегов через
 * инструмент Meta Tags (п.4 ТЗ). Принимает body.url целевой страницы, парсит
 * текущие title/description и прогоняет через metaGenerator.
 */
async function regenerateMeta(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Некорректный url' });

    const { auditPages, regenerateMetaForPages, mergeGeneratedMetaIntoAudit } = require('../services/projects/pageMetaAudit');

    // Тянем реальные поисковые запросы этой страницы из GSC (query×page), чтобы
    // семантика регенерации строилась на фактическом спросе, а не была пустой
    // (без этого генератор пропускал страницу — п.2 ТЗ). При отсутствии GSC или
    // ошибке — graceful: staged-хелпер дотянет анализ выдачи по запросам.
    let queryPage = [];
    if (project.gsc_connected && project.gsc_site_url) {
      try {
        const { fetchQueryPageMatrix } = require('../services/projects/gscService');
        const range = _rangeFromQuery(req.query);
        const matrix = await fetchQueryPageMatrix(project, range);
        queryPage = (matrix || []).filter((r) => r.page === url);
      } catch (_) { queryPage = []; }
    }

    // Шаг 1 — детерминированный аудит «было» (парсинг + диагностика длины), без
    // LLM. Подаём страницу как единственную top_page.
    const audited = await auditPages({
      project,
      snapshot: { top_pages: [{ key: url }] },
      queryPage,
      regenerate: false,
    });
    if (!audited || !Array.isArray(audited.pages) || audited.pages.length === 0) {
      return res.json(audited || { available: false });
    }

    // Шаг 2 — staged-генерация мета-тегов через общий хелпер metaTags/metaStages
    // (разовый анализ ЦА/ниши → SERP → семантика → Gemini → LSI-проверка), с
    // трекингом этапов через funnelTracker (как в инструменте мета-тегов).
    const { createFunnelTracker } = require('../services/aegis/funnelTracker');
    const funnel = createFunnelTracker({
      kind: 'projects_meta_audit',
      taskRef: `project:${project.id}`,
      userId: req.user.id,
      niche: project.name || null,
    });
    let result;
    try {
      result = await regenerateMetaForPages({ project, pages: audited.pages, funnel });
      try { await funnel.persist({ status: 'completed' }); } catch (_) { /* no-op */ }
    } catch (err) {
      try { funnel.fail(err.message); await funnel.persist({ status: 'failed', error: err.message }); } catch (_) { /* no-op */ }
      throw err;
    }
    const persisted = await _persistGeneratedMetaAudit({
      projectId: project.id,
      userId: req.user.id,
      analysisId: req.body && req.body.analysis_id,
      result,
      mergeGeneratedMetaIntoAudit,
    });
    return res.json({ ...(result || { available: false }), persisted });
  } catch (err) { return next(err); }
}

async function _persistGeneratedMetaAudit({ projectId, userId, analysisId, result, mergeGeneratedMetaIntoAudit }) {
  const pages = result && Array.isArray(result.pages) ? result.pages : [];
  if (!pages.length || typeof mergeGeneratedMetaIntoAudit !== 'function') return null;

  const params = [projectId, userId];
  let where = 'a.project_id = $1 AND p.user_id = $2 AND a.status = \'done\'';
  if (analysisId) {
    params.push(analysisId);
    where += ` AND a.id = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT a.id, a.gsc_snapshot
       FROM project_analyses a
       JOIN projects p ON p.id = a.project_id
      WHERE ${where}
      ORDER BY a.completed_at DESC NULLS LAST, a.created_at DESC
      LIMIT 1`,
    params,
  );
  if (!rows.length) return null;

  const snapshot = rows[0].gsc_snapshot && typeof rows[0].gsc_snapshot === 'object'
    ? { ...rows[0].gsc_snapshot }
    : {};
  snapshot.page_meta_audit = mergeGeneratedMetaIntoAudit(snapshot.page_meta_audit, pages);

  await db.query(
    `UPDATE project_analyses
        SET gsc_snapshot = $2
      WHERE id = $1`,
    [rows[0].id, snapshot],
  );
  return { analysis_id: rows[0].id, page_meta_audit: snapshot.page_meta_audit };
}

/**
 * POST /:id/ai-visibility/probe — ручной запуск пробника нейровыдачи (п.7 ТЗ).
 * Тяжёлый (SERP-запросы), поэтому отдельный эндпоинт под analyzeLimiter.
 */
async function probeAiVisibility(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const range = _rangeFromQuery(req.query);
    const { top } = await collectSnapshot(project, range);
    const { probeAiVisibility: probe } = require('../services/projects/geoAeo');
    const result = await probe({ project, topQueries: top.topQueries });
    return res.json(result || { available: false });
  } catch (err) { return _gscError(res, next, err); }
}

/**
 * POST /:id/blog-article — сгенерировать статью для блога через наш внутренний
 * инструмент (info-article pipeline) из темы плана публикаций проекта (ТЗ п.7).
 * Факты о компании собираются автоматически со страницы проекта.
 */
async function generateBlogArticle(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });

    const body = req.body || {};
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    if (topic.length < 5) {
      return res.status(400).json({ error: 'Тема статьи обязательна (не короче 5 символов)' });
    }

    const { generateBlogArticleFromProject } = require('../services/projects/blogArticleBridge');
    const result = await generateBlogArticleFromProject({
      project,
      userId: req.user.id,
      topic,
      region: body.region,
      geminiModel: body.gemini_model,
      imagesCount: body.images_count,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err && err.statusCode === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
}

/**
 * GET /api/projects/:id/freshness — статус свежести по всем источникам данных
 * проекта (ТЗ §5.2). Возвращает массив `{source, status, last_successful_sync_at,
 * source_max_date, expected_max_date, rows_last_sync, is_partial_period, last_error}`.
 *
 * Список источников — все, по которым когда-либо был sync (запись в
 * data_source_health). UI решает, как рендерить статусы 'ok'/'partial'/'stale'/
 * 'gap'/'error' (бейджи в topbar и summary-карточках).
 */
async function getFreshness(req, res, next) {
  try {
    const project = await _loadOwned(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    const items = await freshnessService.getProjectFreshness(project.id);
    return res.json({ project_id: project.id, sources: items });
  } catch (err) {
    return next(err);
  }
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
  getYdxAuthUrl,
  handleYdxCallback,
  listYdxSites,
  selectYdxSite,
  disconnectYdx,
  getYdxPerformance,
  compareProjectSources,
  getPerformance,
  startAnalysis,
  listAnalyses,
  getAnalysis,
  getLeadContext,
  createShareLink,
  revokeShareLink,
  getSharedProject,
  listProjectSnapshots,
  createProjectSnapshot,
  getProjectSnapshot,
  diffProjectSnapshot,
  importGscLinks,
  regenerateMeta,
  probeAiVisibility,
  generateBlogArticle,
  getFreshness,
};
