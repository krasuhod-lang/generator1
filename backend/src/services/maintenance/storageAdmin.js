'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const Redis = require('ioredis');
const dbDefault = require('../../config/db');
const { connection: redisConnection } = require('../../queue/queue');
const { getCacheStatsByBrand } = require('../llm/responseCache');
const { resolveStorageDir } = require('../images/imageStorage.service');
const { runStorageRetention } = require('./storageRetention');

const execFileAsync = promisify(execFile);
const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function _safePath(target) {
  try {
    return fs.realpathSync(target);
  } catch (_) {
    return path.resolve(target);
  }
}

function getKnownStoragePaths() {
  const imageDir = resolveStorageDir();
  return [
    { key: 'uploads', label: 'Загрузки задач', path: _safePath(path.join(BACKEND_ROOT, 'uploads')), cleanup: true },
    { key: 'images', label: 'Изображения генераций', path: _safePath(imageDir), cleanup: false },
    { key: 'brain_state', label: 'Aegis brain state', path: _safePath(path.join(REPO_ROOT, 'brain_state')), cleanup: false },
    { key: 'backend_tmp', label: 'Backend temporary files', path: _safePath(path.join(BACKEND_ROOT, 'tmp')), cleanup: true },
  ];
}

async function getPathUsage(entry) {
  const result = { ...entry, exists: false, bytes: 0, human: '0 B' };
  try {
    const stat = await fs.promises.stat(entry.path);
    result.exists = true;
    result.kind = stat.isDirectory() ? 'directory' : 'file';
    const { stdout } = await execFileAsync('du', ['-sb', entry.path], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const bytes = Number(String(stdout).trim().split(/\s+/)[0]);
    result.bytes = Number.isFinite(bytes) ? bytes : 0;
    result.human = formatBytes(result.bytes);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 1) result.error = error.message;
  }
  return result;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024 || unit === 'TB') return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
  }
  return `${n} B`;
}

function parseRedisInfo(info) {
  const out = {};
  for (const line of String(info || '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return out;
}

async function getRedisStorage() {
  const result = {
    available: false,
    dbsize: 0,
    used_memory_bytes: 0,
    maxmemory_bytes: 0,
    response_cache: { prefix: 'llmcache:v2:', by_brand_hash: [] },
    known_namespaces: ['BullMQ queues: bull:*', 'LLM response cache: llmcache:v2:*'],
  };
  let client;
  try {
    client = new Redis(redisConnection, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await client.connect();
    const [dbsize, memoryInfo, cacheStats] = await Promise.all([
      client.dbsize(),
      client.info('memory'),
      getCacheStatsByBrand(),
    ]);
    const parsed = parseRedisInfo(memoryInfo);
    result.available = true;
    result.dbsize = Number(dbsize) || 0;
    result.used_memory_bytes = Number(parsed.used_memory) || 0;
    result.maxmemory_bytes = Number(parsed.maxmemory) || 0;
    result.used_memory_human = formatBytes(result.used_memory_bytes);
    result.maxmemory_human = result.maxmemory_bytes ? formatBytes(result.maxmemory_bytes) : null;
    result.response_cache.by_brand_hash = cacheStats;
  } catch (error) {
    result.error = error.message;
  } finally {
    if (client) await client.quit().catch(() => client.disconnect());
  }
  return result;
}

async function getDatabaseStorage(db = dbDefault) {
  const result = { available: false, database_bytes: 0, database_human: '0 B', tables: [] };
  try {
    const [database, tables] = await Promise.all([
      db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`),
      db.query(`
        SELECT n.nspname AS schema, c.relname AS table_name,
               pg_total_relation_size(c.oid)::bigint AS bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS human
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND c.relkind IN ('r', 'm', 'p')
         ORDER BY pg_total_relation_size(c.oid) DESC
         LIMIT 100`),
    ]);
    const bytes = Number(database.rows[0]?.bytes) || 0;
    result.available = true;
    result.database_bytes = bytes;
    result.database_human = formatBytes(bytes);
    result.tables = tables.rows;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function getFilesystemStorage() {
  const paths = await Promise.all(getKnownStoragePaths().map(getPathUsage));
  let filesystem = null;
  try {
    const stat = fs.statfsSync(REPO_ROOT);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    filesystem = {
      mount: REPO_ROOT,
      total_bytes: total,
      free_bytes: free,
      used_bytes: Math.max(0, total - free),
      total_human: formatBytes(total),
      free_human: formatBytes(free),
      used_human: formatBytes(Math.max(0, total - free)),
    };
  } catch (error) {
    filesystem = { error: error.message };
  }
  return { filesystem, paths };
}

async function getStorageAudit(deps = {}) {
  const db = deps.db || dbDefault;
  const [filesystem, database, redis] = await Promise.all([
    getFilesystemStorage(),
    getDatabaseStorage(db),
    getRedisStorage(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    filesystem,
    database,
    redis,
    cleanup_allowlist: getKnownStoragePaths().filter((entry) => entry.cleanup).map(({ key, label, path: target }) => ({ key, label, path: target })),
    warnings: [
      'Не удаляйте pg_data/redis_data напрямую: сначала используйте API cleanup или штатные PostgreSQL/Redis команды.',
      'brain_state намеренно исключён из admin cleanup: это runtime-состояние Aegis.',
      'Обычный VACUUM освобождает место внутри PostgreSQL; возврат места ОС требует отдельной контролируемой операции.',
    ],
  };
}

async function walkOldFiles(root, cutoffMs, dryRun) {
  const stat = { scanned: 0, deleted: 0, bytes: 0, dry_run: !!dryRun };
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return stat;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    let info;
    try { info = await fs.promises.lstat(target); } catch (_) { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const child = await walkOldFiles(target, cutoffMs, dryRun);
      stat.scanned += child.scanned; stat.deleted += child.deleted; stat.bytes += child.bytes;
      if (!dryRun) {
        const remain = await fs.promises.readdir(target).catch(() => ['x']);
        if (!remain.length) await fs.promises.rmdir(target).catch(() => {});
      }
      continue;
    }
    stat.scanned += 1;
    if (info.mtimeMs >= cutoffMs) continue;
    stat.bytes += info.size || 0;
    if (!dryRun) {
      await fs.promises.unlink(target).catch(() => {});
      stat.deleted += 1;
    }
  }
  return stat;
}

async function cleanupStorage({ scope, olderThanDays, confirm, dryRun = false, db = dbDefault } = {}) {
  const allowed = new Set(['tasks', 'uploads', 'backend_tmp', 'response_cache']);
  if (!allowed.has(scope)) throw Object.assign(new Error('Неверный scope очистки'), { status: 400 });
  const days = Math.max(1, Math.min(3650, Number(olderThanDays) || 30));
  if (!dryRun && confirm !== 'DELETE') {
    throw Object.assign(new Error('Для удаления требуется confirm=DELETE'), { status: 400 });
  }
  if (scope === 'tasks') {
    return runStorageRetention({
      dryRun,
      retentionDays: days,
      failedDays: days,
      vacuum: false,
      vacuumFull: false,
    }, { db });
  }
  if (scope === 'response_cache') {
    const client = new Redis(redisConnection, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    try {
      await client.connect();
      const keys = [];
      let cursor = '0';
      do {
        const [next, batch] = await client.scan(cursor, 'MATCH', 'llmcache:v2:*', 'COUNT', 500);
        cursor = next; keys.push(...batch);
      } while (cursor !== '0');
      if (dryRun) return { scope, dry_run: true, keys_found: keys.length, deleted: 0 };
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 200) {
        deleted += Number(await client.unlink(...keys.slice(i, i + 200))) || 0;
      }
      return { scope, dry_run: false, keys_found: keys.length, deleted };
    } finally { await client.quit().catch(() => client.disconnect()); }
  }
  const entry = getKnownStoragePaths().find((item) => item.key === scope);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stats = await walkOldFiles(entry.path, cutoff, dryRun);
  return { scope, path: entry.path, older_than_days: days, ...stats };
}

module.exports = {
  formatBytes,
  getKnownStoragePaths,
  getStorageAudit,
  cleanupStorage,
  walkOldFiles,
};
