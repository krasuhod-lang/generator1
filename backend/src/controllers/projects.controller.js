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
const { buildLeadContext } = require('../services/projects/leadContext');
const snapshotsRepo = require('../services/projects/snapshotsRepo');
const { compareSnapshots } = require('../services/projects/periodComparison');

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
  ydx_connected, ydx_site_url, ydx_available_sites,
  (ydx_refresh_token_enc IS NOT NULL) AS ydx_has_refresh,
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
      ydx_configured: getYandexOAuthConfig().configured,
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
    return res.json({ analysis: rows[0] });
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
              report_markdown, gsc_snapshot,
              ydx_snapshot, ydx_report_markdown, synthesis_markdown, ranking_factors,
              created_at, completed_at
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

    const { auditPages, regenerateMetaForPages } = require('../services/projects/pageMetaAudit');

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
    return res.json(result || { available: false });
  } catch (err) { return next(err); }
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
};
