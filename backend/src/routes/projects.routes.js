'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const auth      = require('../middleware/auth');

const c = require('../controllers/projects.controller');

const router = express.Router();

// CSV-импорт ссылок GSC: храним файл в памяти (мелкий CSV), без диска.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов за минуту. Подождите.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// AI-аналитика — тяжёлая (DeepSeek), отдельный жёсткий лимит.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запусков анализа. Подождите минуту.' },
});

router.use(readLimiter);

// CRUD
router.get('/',        auth, c.listProjects);
router.post('/',       auth, createLimiter, c.createProject);
router.get('/:id',     auth, c.getProject);
router.put('/:id',     auth, c.updateProject);
router.delete('/:id',  auth, c.deleteProject);

// GSC
router.get('/:id/gsc/auth-url',    auth, c.getGscAuthUrl);
router.get('/:id/gsc/sites',       auth, c.listGscSites);
router.post('/:id/gsc/select-site', auth, c.selectGscSite);
router.delete('/:id/gsc',          auth, c.disconnectGsc);

// Яндекс.Вебмастер (симметрично GSC)
router.get('/:id/ydx/auth-url',     auth, c.getYdxAuthUrl);
router.get('/:id/ydx/sites',        auth, c.listYdxSites);
router.post('/:id/ydx/select-site', auth, c.selectYdxSite);
router.delete('/:id/ydx',           auth, c.disconnectYdx);
router.get('/:id/ydx/performance',  auth, c.getYdxPerformance);

// Сопоставление источников (GSC ↔ Яндекс.Вебмастер) + рекомендации
router.get('/:id/compare',          auth, c.compareProjectSources);

// Дашборд
router.get('/:id/performance',     auth, c.getPerformance);
router.get('/:id/freshness',       auth, c.getFreshness);

// AI-аналитика
router.post('/:id/analyze',        auth, analyzeLimiter, c.startAnalysis);
router.get('/:id/analyses',        auth, c.listAnalyses);
router.get('/:id/analyses/:aid',   auth, c.getAnalysis);

// Snapshots GSC (PR 1: персистентность). Сбор без LLM делит лимит с
// тяжёлыми GSC-запросами analyze.
router.get('/:id/snapshots',              auth, c.listProjectSnapshots);
router.post('/:id/snapshots',             auth, analyzeLimiter, c.createProjectSnapshot);
router.get('/:id/snapshots/:sid',         auth, c.getProjectSnapshot);
router.get('/:id/snapshots/:sid/diff',    auth, c.diffProjectSnapshot);

// Lead-text auto-context (компактная проекция последнего анализа)
router.get('/:id/lead-context',    auth, c.getLeadContext);

// Расширение «Анализ GSC» (п.1-8): импорт ссылок, регенерация мета, AI-probe.
router.post('/:id/gsc-links/import', auth, createLimiter, uploadCsv.single('file'), c.importGscLinks);
router.post('/:id/meta-suggestions/regenerate', auth, analyzeLimiter, c.regenerateMeta);
router.post('/:id/ai-visibility/probe', auth, analyzeLimiter, c.probeAiVisibility);
router.post('/:id/blog-article', auth, analyzeLimiter, c.generateBlogArticle);

// Шаринг
router.post('/:id/share',          auth, c.createShareLink);
router.delete('/:id/share',        auth, c.revokeShareLink);

module.exports = router;
