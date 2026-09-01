'use strict';

const {
  listIntegrationSecrets,
  upsertIntegrationSecret,
  removeIntegrationSecret,
} = require('../services/integrations/integrationVault');
const { probeIntegrationKey, probeAllIntegrationKeys } = require('../services/integrations/integrationKeyProbe');
const db = require('../config/db');

function errorStatus(error) {
  if (/Unknown integration key|API key value is required/i.test(String(error?.message || ''))) return 400;
  return 500;
}

async function listAdminIntegrationKeys(req, res) {
  try {
    const secrets = await listIntegrationSecrets();
    res.json({ secrets, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[AdminIntegrationKeys] list failed:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить реестр интеграций' });
  }
}

async function putAdminIntegrationKey(req, res) {
  try {
    const { value, enabled = true } = req.body || {};
    const secret = await upsertIntegrationSecret({
      envName: req.params.envName,
      value,
      enabled,
      adminUserId: req.user?.id || null,
    });
    res.status(200).json({ success: true, secret });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('[AdminIntegrationKeys] upsert failed:', error.message);
    res.status(status).json({ error: status === 400 ? error.message : 'Не удалось сохранить ключ интеграции' });
  }
}

async function deleteAdminIntegrationKey(req, res) {
  try {
    const result = await removeIntegrationSecret({
      envName: req.params.envName,
      adminUserId: req.user?.id || null,
    });
    res.json({ success: true, result });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('[AdminIntegrationKeys] remove failed:', error.message);
    res.status(status).json({ error: status === 400 ? error.message : 'Не удалось удалить override ключа' });
  }
}

async function probeAdminIntegrationKey(req, res) {
  try {
    const result = await probeIntegrationKey(req.params.envName);
    res.json({ result });
  } catch (error) {
    const status = errorStatus(error);
    res.status(status).json({ error: status === 400 ? error.message : 'Не удалось проверить ключ интеграции' });
  }
}

async function probeAllAdminIntegrationKeys(req, res) {
  try {
    res.json(await probeAllIntegrationKeys());
  } catch (error) {
    console.error('[AdminIntegrationKeys] probe all failed:', error.message);
    res.status(500).json({ error: 'Не удалось проверить ключи интеграций' });
  }
}

async function listAdminIntegrationKeyAudit(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT env_name, action, admin_user_id, masked_value, created_at, meta
         FROM admin_integration_secret_audit
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    res.json({ audit: rows });
  } catch (error) {
    console.error('[AdminIntegrationKeys] audit failed:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить аудит ротаций' });
  }
}

module.exports = {
  listAdminIntegrationKeys,
  putAdminIntegrationKey,
  deleteAdminIntegrationKey,
  probeAdminIntegrationKey,
  probeAllAdminIntegrationKeys,
  listAdminIntegrationKeyAudit,
};
