'use strict';

/**
 * Роуты модуля «Фронт работ» (конструктор КП) — раздел «Прогнозатор».
 * Всё под auth. Публичная share-ссылка — в proposalsPublic.routes.js.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const c = require('../controllers/proposals.controller');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(limiter);
router.use(auth);

// Справочник модулей и задач (редактируемый — правки переиспользуются везде)
router.get('/modules',              c.listModules);
router.post('/modules',             c.createModule);
router.put('/modules/tasks/:taskId',    c.updateModuleTask);
router.delete('/modules/tasks/:taskId', c.deleteModuleTask);
router.put('/modules/:id',          c.updateModule);
router.delete('/modules/:id',       c.deleteModule);
router.post('/modules/:id/tasks',   c.createModuleTask);

// Прайс-лист (справочник типовых цен)
router.get('/pricing-templates',        c.listPricingTemplates);
router.post('/pricing-templates',       c.createPricingTemplate);
router.put('/pricing-templates/:id',    c.updatePricingTemplate);
router.delete('/pricing-templates/:id', c.deletePricingTemplate);

// КП
router.get('/',           c.listProposals);
router.post('/',          c.createProposal);
router.get('/:id',        c.getProposal);
router.put('/:id',        c.updateProposal);
router.delete('/:id',     c.deleteProposal);
router.post('/:id/clone', c.cloneProposal);
router.get('/:id/export/pdf',  c.exportProposalPdf);
router.get('/:id/export/xlsx', c.exportProposalXlsx);
router.post('/:id/share',   c.createProposalShare);
router.delete('/:id/share', c.revokeProposalShare);

// Задачи КП
router.post('/:id/tasks',            c.addProposalTask);
router.put('/:id/tasks/:taskId',     c.updateProposalTask);
router.delete('/:id/tasks/:taskId',  c.deleteProposalTask);

// Стоимость КП
router.post('/:id/pricing',            c.addProposalPricing);
router.put('/:id/pricing/:priceId',    c.updateProposalPricing);
router.delete('/:id/pricing/:priceId', c.deleteProposalPricing);

module.exports = router;
