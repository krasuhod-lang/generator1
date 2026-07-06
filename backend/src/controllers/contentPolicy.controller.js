'use strict';

/**
 * controllers/contentPolicy.controller.js — админ-REST для V6 «Prompt & Policy
 * Registry» (редактируемые правила контента) и чтения V1-журнала quality gate.
 *
 *   GET    /api/admin/content-policy/rules            — список правил (фильтры)
 *   POST   /api/admin/content-policy/rules            — создать правило
 *   PATCH  /api/admin/content-policy/rules/:id        — обновить payload/active
 *   DELETE /api/admin/content-policy/rules/:id        — мягко удалить (active=false)
 *   GET    /api/admin/content-policy/effective        — итоговая политика (defaults ∪ БД)
 *   GET    /api/admin/content-policy/gate-reports     — журнал quality_gate_reports
 *
 * Все маршруты защищены adminAuth (см. routes). Ошибки валидатора
 * (Error.status=400) транслируются как HTTP 400 с machine-readable code.
 */

const contentPolicy = require('../services/contentPolicy');
const rulesRepo     = require('../services/contentPolicy/rulesRepo');
const {
  DEFAULT_THRESHOLDS,
  DEFAULT_VALUE_ADD_CATALOG,
} = require('../services/contentPolicy/defaults');
const { reportsRepo } = require('../services/qualityCore');

/** Транслировать ошибку сервиса в HTTP-ответ. */
function _fail(res, err) {
  const status = (err && Number.isInteger(err.status)) ? err.status : 500;
  const body = { error: (err && err.code) || 'internal_error' };
  if (err && err.message && status === 400) body.message = err.message;
  if (status >= 500) console.error('[contentPolicy.controller]', err);
  return res.status(status).json(body);
}

async function listRules(req, res) {
  try {
    const q = req.query || {};
    const active = q.active == null ? undefined : (q.active === 'true' || q.active === '1');
    const rules = await rulesRepo.listRules({
      ruleType: q.rule_type || undefined,
      scope:    q.scope || undefined,
      active,
    });
    return res.json({ rules, meta: { rule_types: rulesRepo.RULE_TYPES, scopes: rulesRepo.SCOPES } });
  } catch (err) { return _fail(res, err); }
}

async function createRule(req, res) {
  try {
    const createdBy = (req.user && req.user.id) || null;
    const rule = await rulesRepo.createRule({ input: req.body, createdBy });
    return res.status(201).json({ rule });
  } catch (err) { return _fail(res, err); }
}

async function updateRule(req, res) {
  try {
    const patch = {};
    if (req.body && req.body.payload !== undefined) patch.payload = req.body.payload;
    if (req.body && req.body.active !== undefined) patch.active = req.body.active;
    const rule = await rulesRepo.updateRule({ id: req.params.id, patch });
    if (!rule) return res.status(404).json({ error: 'rule_not_found' });
    return res.json({ rule });
  } catch (err) { return _fail(res, err); }
}

async function deleteRule(req, res) {
  try {
    const rule = await rulesRepo.deactivateRule({ id: req.params.id });
    if (!rule) return res.status(404).json({ error: 'rule_not_found' });
    return res.json({ rule, deactivated: true });
  } catch (err) { return _fail(res, err); }
}

/**
 * effectivePolicy — то, что реально применяется генератором прямо сейчас:
 * defaults ∪ активные правила из БД. Полезно для проверки «подхватилось ли
 * моё правило» без чтения кода.
 */
async function effectivePolicy(req, res) {
  try {
    await contentPolicy.refresh({ force: true });
    return res.json({
      stop_phrases:        contentPolicy.getStopPhrasesSync(),
      banned_formulations: contentPolicy.getBannedFormulationsSync(),
      ymyl_keywords:       contentPolicy.getYmylKeywordsSync(),
      value_add_catalog:   contentPolicy.getValueAddCatalogSync(),
      thresholds:          contentPolicy.getThresholds(),
      defaults: {
        thresholds:        DEFAULT_THRESHOLDS,
        value_add_catalog: DEFAULT_VALUE_ADD_CATALOG,
      },
    });
  } catch (err) { return _fail(res, err); }
}

async function listGateReports(req, res) {
  try {
    const q = req.query || {};
    const rows = await reportsRepo.listReports({
      pipeline: q.pipeline || undefined,
      taskId:   q.task_id != null ? q.task_id : undefined,
    });
    return res.json({ reports: rows, pipelines: reportsRepo.PIPELINES });
  } catch (err) { return _fail(res, err); }
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  effectivePolicy,
  listGateReports,
};
