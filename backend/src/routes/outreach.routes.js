'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
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
} = require('../controllers/outreach.controller');

const router = express.Router();

// Создание кампании запускает мультигео-сбор + LLM, поэтому ограничиваем
// строже. Чтения (поллинг дашборда) — мягче.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много кампаний за последнюю минуту. Подождите.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      600,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// Публичные эндпоинты (webhook/отписка) без auth — ограничиваем по IP,
// чтобы защитить БД от злоупотреблений.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// ── Публичные эндпоинты (без auth) ────────────────────────────────
// Resend webhook — подпись проверяется внутри контроллера (svix HMAC).
router.post('/webhooks/resend', publicLimiter, resendWebhook);
// Страница отписки — публичная, защищена токеном.
router.get('/unsubscribe', publicLimiter, unsubscribe);

// ── Приватные эндпоинты ───────────────────────────────────────────
router.use(readLimiter);

router.get('/campaigns',              auth, listCampaigns);
router.post('/campaigns',             auth, createLimiter, createCampaign);
router.get('/campaigns/:id',          auth, getCampaign);
router.patch('/campaigns/:id',        auth, updateCampaign);
router.delete('/campaigns/:id',       auth, deleteCampaign);

router.get('/campaigns/:id/prospects', auth, listProspects);
router.get('/campaigns/:id/emails',    auth, listEmails);
router.get('/campaigns/:id/logs',      auth, listLogs);
router.get('/campaigns/:id/stats',     auth, getCampaignStats);
// Прямая (ручная) отправка по пулу адресов: генерируем письмо для каждого.
router.post('/campaigns/:id/direct-send', auth, createLimiter, directSend);

module.exports = router;
