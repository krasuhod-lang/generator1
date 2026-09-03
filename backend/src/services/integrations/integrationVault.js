'use strict';

/**
 * Central integration secret vault.
 *
 * Secrets are stored as AES-256-GCM ciphertext using the existing project
 * tokenCrypto key derivation (PROJECTS_TOKEN_KEY -> JWT_SECRET). The database
 * is an override layer: an unset vault entry falls back to the current env
 * value, so rollout is backward compatible and does not require editing .env.
 * Plaintext is never returned by the admin API and never written to the audit
 * table or logs.
 */

const dbDefault = require('../../config/db');
const { encryptToken, decryptToken } = require('../projects/tokenCrypto');

const CACHE_TTL_MS = 30_000;
const secretCache = new Map();
const inFlight = new Map();

const INTEGRATION_CATALOG = Object.freeze([
  { envName: 'DASHSCOPE_API_KEY', label: 'Qwen / Alibaba Model Studio', group: 'AI-модели', description: 'Qwen 3.8 Max и DashScope-интеграции' },
  { envName: 'DEEPSEEK_API_KEY', label: 'DeepSeek', group: 'AI-модели', description: 'DeepSeek V4 Pro для аналитики и quality-аудитов' },
  { envName: 'OPENAI_API_KEY', label: 'OpenAI / GPT', group: 'AI-модели', description: 'GPT-5 / GPT-5.5 для точечных audit и финального quality gate' },
  { envName: 'MANUS_API_KEY', label: 'Manus API', group: 'AI-модели', description: 'Manus AI agent для research/quality stages вместо GPT' },
  { envName: 'GEMINI_API_KEY', label: 'Google Gemini', group: 'AI-модели', description: 'Gemini 3.1 Pro для генерации и редакторских этапов' },
  { envName: 'XAI_API_KEY', label: 'xAI / Grok', group: 'AI-модели', description: 'Необязательный альтернативный provider' },
  { envName: 'GIST_INTERNAL_TOKEN', label: 'GIST Content Logic', group: 'Внутренние сервисы', description: 'Внутренний токен Node → GIST' },
  { envName: 'GIST_LLM_API_KEY', label: 'GIST LLM', group: 'Внутренние сервисы', description: 'Ключ LLM-части GIST' },
  { envName: 'RELEVANCE_INTERNAL_TOKEN', label: 'Relevance Analyzer', group: 'Внутренние сервисы', description: 'Внутренний токен Node → relevance' },
  { envName: 'RESEND_API_KEY', label: 'Resend Email', group: 'Рассылки', description: 'Отправка email и подтверждений' },
  { envName: 'RESEND_WEBHOOK_SECRET', label: 'Resend Webhooks', group: 'Рассылки', description: 'Проверка подписей входящих webhook-событий' },
  { envName: 'SERPER_API_KEY', label: 'Serper', group: 'Поиск и SEO', description: 'SERP API' },
  { envName: 'SERPAPI_API_KEY', label: 'SerpApi', group: 'Поиск и SEO', description: 'Альтернативный SERP API' },
  { envName: 'KEYS_SO_API_KEY', label: 'Keys.so', group: 'Поиск и SEO', description: 'B2B/SEO enrichment' },
  { envName: 'ARSENKIN_API_TOKEN', label: 'Arsenkin', group: 'Поиск и SEO', description: 'Съём позиций и SEO-сигналы' },
  { envName: 'GOOGLE_API_KEY', label: 'Google API', group: 'Внешние API', description: 'Общий Google API key' },
  { envName: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth', group: 'Внешние API', description: 'OAuth client secret для Search Console' },
  { envName: 'YANDEX_CLIENT_SECRET', label: 'Yandex OAuth', group: 'Внешние API', description: 'OAuth client secret для Яндекс-сервисов' },
  { envName: 'YANDEX_METRIKA_OAUTH_TOKEN', label: 'Яндекс.Метрика', group: 'Аналитика', description: 'OAuth token для статистики, целей и источников Яндекс.Метрики' },
  { envName: 'DADATA_API_KEY', label: 'DaData', group: 'Внешние API', description: 'Необязательное обогащение юридических лиц' },
]);

const CATALOG_BY_NAME = new Map(INTEGRATION_CATALOG.map((item) => [item.envName, item]));
const ALIASES = Object.freeze({
  KEYS_SO_API_KEY: ['KEYSSO_API_KEY'],
  KEYSSO_API_KEY: ['KEYS_SO_API_KEY'],
});

function normalizeName(value) {
  const rawName = String(value || '').trim().toUpperCase();
  const name = rawName === 'KEYSSO_API_KEY' ? 'KEYS_SO_API_KEY' : rawName;
  if (!CATALOG_BY_NAME.has(name)) {
    throw new Error('Unknown integration key');
  }
  return name;
}

function envFallback(name) {
  const names = [name, ...(ALIASES[name] || [])];
  for (const envName of names) {
    const value = String(process.env[envName] || '').trim();
    if (value) return { value, source: 'env', envName };
  }
  return { value: '', source: 'unset', envName: name };
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 8) return '••••••••';
  return `••••••••${text.slice(-4)}`;
}

function cacheSet(name, value, source) {
  secretCache.set(name, { value: String(value || ''), source, expiresAt: Date.now() + CACHE_TTL_MS });
  return secretCache.get(name);
}

function invalidateSecret(name) {
  secretCache.delete(name);
  inFlight.delete(name);
}

async function readSecret(name, db = dbDefault) {
  const cached = secretCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const pending = inFlight.get(name);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const { rows } = await db.query(
        `SELECT encrypted_value, is_enabled
           FROM admin_integration_secrets
          WHERE env_name = $1
          LIMIT 1`,
        [name],
      );
      const row = rows[0];
      if (row?.is_enabled !== false && row?.encrypted_value) {
        try {
          return cacheSet(name, decryptToken(row.encrypted_value), 'vault');
        } catch (error) {
          console.error(`[IntegrationVault] cannot decrypt ${name}:`, error.message);
        }
      }
    } catch (error) {
      // The env fallback keeps existing deployments functional while a new
      // volume or a temporary DB issue is being repaired.
      if (!/does not exist|relation .* does not exist/i.test(String(error.message || ''))) {
        console.warn(`[IntegrationVault] read fallback for ${name}:`, error.message);
      }
    }
    const fallback = envFallback(name);
    return cacheSet(name, fallback.value, fallback.source);
  })().finally(() => inFlight.delete(name));

  inFlight.set(name, promise);
  return promise;
}

async function getIntegrationSecret(name, { db = dbDefault } = {}) {
  const normalized = normalizeName(name);
  const entry = await readSecret(normalized, db);
  return entry.value;
}

async function getIntegrationSecretInfo(name, { db = dbDefault } = {}) {
  const normalized = normalizeName(name);
  const entry = await readSecret(normalized, db);
  return { value: entry.value, source: entry.source, configured: Boolean(entry.value) };
}

async function ensureIntegrationVaultSchema(db = dbDefault) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS admin_integration_secrets (
      id              BIGSERIAL PRIMARY KEY,
      env_name        TEXT NOT NULL UNIQUE,
      encrypted_value TEXT,
      is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      last_rotated_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS admin_integration_secret_audit (
      id           BIGSERIAL PRIMARY KEY,
      env_name     TEXT NOT NULL,
      action       TEXT NOT NULL,
      admin_user_id TEXT,
      masked_value TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta         JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `ALTER TABLE admin_integration_secret_audit
       ALTER COLUMN admin_user_id TYPE TEXT
       USING admin_user_id::text`,
    `CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_created
       ON admin_integration_secret_audit(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_env
       ON admin_integration_secret_audit(env_name, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS admin_integration_key_probe_results (
      env_name        TEXT PRIMARY KEY,
      status          TEXT NOT NULL,
      active          BOOLEAN,
      probe_supported BOOLEAN NOT NULL DEFAULT FALSE,
      http_status     INTEGER,
      latency_ms      INTEGER,
      message         TEXT,
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS ix_admin_key_probe_checked
       ON admin_integration_key_probe_results(checked_at DESC)`,
  ];
  for (const sql of statements) await db.query(sql);
  console.log('[Schema] admin integration secret vault ready');
}

async function listIntegrationSecrets({ db = dbDefault } = {}) {
  let rows = [];
  try {
    const result = await db.query(
      `SELECT env_name, is_enabled, last_rotated_at, created_at, updated_at
         FROM admin_integration_secrets
        ORDER BY env_name`,
    );
    rows = result.rows || [];
  } catch (error) {
    if (!/does not exist|relation .* does not exist/i.test(String(error.message || ''))) throw error;
  }

  const byName = new Map(rows.map((row) => [row.env_name, row]));
  return Promise.all(INTEGRATION_CATALOG.map(async (item) => {
    const row = byName.get(item.envName);
    // Resolve the effective value through the same path as real provider calls.
    // This prevents a stale/corrupt/disabled vault row from disagreeing with
    // the probe result or from showing a false "configured" state.
    const effective = row?.is_enabled === false
      ? envFallback(item.envName)
      : await readSecret(item.envName, db);
    const source = row?.is_enabled === false
      ? (effective.source === 'env' ? 'env' : 'disabled')
      : effective.source;
    return {
      ...item,
      configured: Boolean(effective.value),
      source,
      masked: effective.value ? maskSecret(effective.value) : null,
      is_enabled: row ? row.is_enabled !== false : true,
      last_rotated_at: row?.last_rotated_at || null,
      updated_at: row?.updated_at || null,
    };
  }));
}

async function auditSecret({ envName, action, adminUserId = null, maskedValue = null, meta = {}, db = dbDefault }) {
  await db.query(
    `INSERT INTO admin_integration_secret_audit
      (env_name, action, admin_user_id, masked_value, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [envName, action, adminUserId || null, maskedValue, JSON.stringify(meta || {})],
  );
}

async function upsertIntegrationSecret({ envName, value, enabled = true, adminUserId = null, db = dbDefault }) {
  const normalized = normalizeName(envName);
  const plaintext = String(value || '').trim();
  if (!plaintext) throw new Error('API key value is required');
  const encrypted = encryptToken(plaintext);
  await db.query(
    `INSERT INTO admin_integration_secrets
      (env_name, encrypted_value, is_enabled, last_rotated_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (env_name) DO UPDATE SET
       encrypted_value = EXCLUDED.encrypted_value,
       is_enabled = EXCLUDED.is_enabled,
       last_rotated_at = NOW(),
       updated_at = NOW()`,
    [normalized, encrypted, enabled !== false],
  );
  invalidateSecret(normalized);
  cacheSet(normalized, plaintext, 'vault');
  await auditSecret({
    envName: normalized,
    action: 'upsert',
    adminUserId,
    maskedValue: maskSecret(plaintext),
  });
  return { envName: normalized, source: 'vault', configured: true, masked: maskSecret(plaintext) };
}

async function removeIntegrationSecret({ envName, adminUserId = null, db = dbDefault }) {
  const normalized = normalizeName(envName);
  const result = await db.query(
    `DELETE FROM admin_integration_secrets WHERE env_name = $1`,
    [normalized],
  );
  invalidateSecret(normalized);
  const fallback = envFallback(normalized);
  cacheSet(normalized, fallback.value, fallback.source);
  await auditSecret({
    envName: normalized,
    action: 'remove_override',
    adminUserId,
    maskedValue: maskSecret(fallback.value),
    meta: { fallback_source: fallback.source },
  });
  return { envName: normalized, removed: result.rowCount > 0, fallbackSource: fallback.source, configured: Boolean(fallback.value) };
}

module.exports = {
  INTEGRATION_CATALOG,
  ensureIntegrationVaultSchema,
  getIntegrationSecret,
  getIntegrationSecretInfo,
  listIntegrationSecrets,
  upsertIntegrationSecret,
  removeIntegrationSecret,
  maskSecret,
  normalizeName,
};
