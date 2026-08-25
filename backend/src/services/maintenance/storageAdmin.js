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
    { key: 'uploads', label: 'Загрузки задач', path: _safePath(path.join(BACKEND_ROOT, 'uploads')), cleanup: true, fileCleanup: true },
    { key: 'images', label: 'Изображения генераций', path: _safePath(imageDir), cleanup: false, fileCleanup: true },
    { key: 'brain_state', label: 'Aegis brain state', path: _safePath(path.join(REPO_ROOT, 'brain_state')), cleanup: false, fileCleanup: false },
    { key: 'backend_tmp', label: 'Backend temporary files', path: _safePath(path.join(BACKEND_ROOT, 'tmp')), cleanup: true, fileCleanup: true },
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
    inventory_roots: getKnownStoragePaths().map(({ key, label, path: target, fileCleanup }) => ({ key, label, path: target, file_cleanup: Boolean(fileCleanup) })),
    warnings: [
      'Не удаляйте pg_data/redis_data напрямую: сначала используйте API cleanup или штатные PostgreSQL/Redis команды.',
      'brain_state намеренно исключён из admin cleanup: это runtime-состояние Aegis.',
      'Обычный VACUUM освобождает место внутри PostgreSQL; возврат места ОС требует отдельной контролируемой операции.',
    ],
  };
}

async function walkOldFiles(root, cutoffMs, dryRun, shouldDelete = null) {
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
      const child = await walkOldFiles(target, cutoffMs, dryRun, shouldDelete);
      stat.scanned += child.scanned; stat.deleted += child.deleted; stat.bytes += child.bytes;
      if (!dryRun) {
        const remain = await fs.promises.readdir(target).catch(() => ['x']);
        if (!remain.length) await fs.promises.rmdir(target).catch(() => {});
      }
      continue;
    }
    stat.scanned += 1;
    if (info.mtimeMs >= cutoffMs) continue;
    if (shouldDelete && !(await shouldDelete(target))) continue;
    stat.bytes += info.size || 0;
    if (!dryRun) {
      await fs.promises.unlink(target).catch(() => {});
      stat.deleted += 1;
    }
  }
  return stat;
}

const INVENTORY_MAX_FILES = Math.max(1000, Math.min(500000, Number.parseInt(process.env.STORAGE_INVENTORY_MAX_FILES, 10) || 100000));
const ACTIVE_TASK_STATUSES = [
  'pending', 'queued', 'processing', 'running', 'in_progress', 'retrying', 'paused', 'pausing',
  'fetching', 'fetching_pages', 'analyzing', 'comparing',
];
const INVENTORY_TASK_TABLES = ['tasks', 'link_article_tasks', 'info_article_tasks'];

function getInventoryRoot(rootKey) {
  const entry = getKnownStoragePaths().find((item) => item.key === String(rootKey || '').trim());
  if (!entry) throw Object.assign(new Error('Неизвестный storage root'), { status: 400 });
  return entry;
}

function safeRelativePath(relativePath) {
  const raw = String(relativePath || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

function resolveInventoryFile(entry, relativePath) {
  const relative = safeRelativePath(relativePath);
  if (!relative) throw Object.assign(new Error('Небезопасный relative_path'), { status: 400 });
  const root = path.resolve(entry.path);
  const target = path.resolve(root, relative);
  const check = path.relative(root, target);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) {
    throw Object.assign(new Error('Путь выходит за пределы storage root'), { status: 400 });
  }
  return { relative, target };
}

function addDirectoryStat(directoryMap, relativePath, bytes, fileCount) {
  let current = relativePath;
  while (true) {
    const existing = directoryMap.get(current) || { relative_path: current || '.', bytes: 0, file_count: 0, directory_count: 0 };
    existing.bytes += bytes;
    existing.file_count += fileCount;
    directoryMap.set(current, existing);
    if (!current) break;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

async function buildInventory(entry, { page = 1, limit = 100, search = '', sort = 'size', order = 'desc' } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const query = String(search || '').trim().toLowerCase();
  const files = [];
  const directoryMap = new Map();
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let totalBytes = 0;
  let truncated = false;
  const scanErrors = [];

  async function walk(absDir, relativeDir = '') {
    let entries;
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') scanErrors.push({ relative_path: relativeDir || '.', error: error.message });
      return;
    }
    for (const dirent of entries) {
      const relativePath = relativeDir ? path.posix.join(relativeDir, dirent.name) : dirent.name;
      const absolutePath = path.join(absDir, dirent.name);
      let stat;
      try { stat = await fs.promises.lstat(absolutePath); } catch (error) {
        scanErrors.push({ relative_path: relativePath, error: error.message });
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        scannedDirectories += 1;
        const before = directoryMap.get(relativePath) || { relative_path: relativePath, bytes: 0, file_count: 0, directory_count: 0, modified_at: stat.mtime.toISOString() };
        before.modified_at = stat.mtime.toISOString();
        directoryMap.set(relativePath, before);
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;
      scannedFiles += 1;
      totalBytes += stat.size || 0;
      addDirectoryStat(directoryMap, relativeDir, stat.size || 0, 1);
      if (files.length >= INVENTORY_MAX_FILES) {
        truncated = true;
        continue;
      }
      files.push({
        relative_path: relativePath,
        name: dirent.name,
        bytes: Number(stat.size) || 0,
        human: formatBytes(stat.size),
        modified_at: stat.mtime.toISOString(),
        root_key: entry.key,
        deletable: Boolean(entry.fileCleanup),
        protected_reason: entry.fileCleanup ? null : 'Каталог защищён политикой storage',
      });
    }
  }

  await walk(entry.path);
  const matching = query ? files.filter((item) => item.relative_path.toLowerCase().includes(query)) : files;
  const direction = String(order).toLowerCase() === 'asc' ? 1 : -1;
  matching.sort((left, right) => {
    if (sort === 'modified_at') return direction * (new Date(left.modified_at).getTime() - new Date(right.modified_at).getTime());
    if (sort === 'name') return direction * left.relative_path.localeCompare(right.relative_path);
    return direction * (left.bytes - right.bytes);
  });
  const offset = (safePage - 1) * safeLimit;
  const rows = matching.slice(offset, offset + safeLimit);
  const folders = [...directoryMap.values()]
    .filter((item) => item.relative_path !== '.')
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 500)
    .map((item) => ({ ...item, human: formatBytes(item.bytes), deletable: Boolean(entry.fileCleanup) }));

  return {
    root: { key: entry.key, label: entry.label, path: entry.path, exists: fs.existsSync(entry.path), deletable: Boolean(entry.fileCleanup) },
    summary: {
      bytes: totalBytes,
      human: formatBytes(totalBytes),
      file_count: scannedFiles,
      directory_count: scannedDirectories,
      truncated,
      scan_limit: INVENTORY_MAX_FILES,
      scan_errors: scanErrors,
    },
    folders,
    files: rows,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total_files: matching.length,
      has_more: offset + rows.length < matching.length || truncated,
    },
  };
}

async function getStorageInventory({ rootKey = 'uploads', page, limit, search, sort, order } = {}) {
  const entry = getInventoryRoot(rootKey);
  return buildInventory(entry, { page, limit, search, sort, order });
}

async function isActiveTaskId(taskId, db = dbDefault) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(taskId || ''))) return false;
  for (const table of INVENTORY_TASK_TABLES) {
    try {
      const result = await db.query(
        `SELECT 1 FROM ${table} WHERE id = $1 AND status::text = ANY($2::text[]) LIMIT 1`,
        [taskId, ACTIVE_TASK_STATUSES],
      );
      if (result.rows.length) return true;
    } catch (error) {
      if (!/does not exist|relation .* does not exist/i.test(String(error.message))) throw error;
    }
  }
  return false;
}

async function getActiveTaskPayloads(db = dbDefault) {
  const payloads = [];
  for (const table of INVENTORY_TASK_TABLES) {
    try {
      const result = await db.query(
        `SELECT to_jsonb(${table})::text AS payload
           FROM ${table}
          WHERE status::text = ANY($1::text[])`,
        [ACTIVE_TASK_STATUSES],
      );
      for (const row of result.rows || []) {
        if (row.payload) payloads.push(String(row.payload));
      }
    } catch (error) {
      if (!/does not exist|relation .* does not exist/i.test(String(error.message))) throw error;
    }
  }
  return payloads;
}

async function isReferencedByActiveTask(rootKey, relativePath, db = dbDefault) {
  if (rootKey !== 'uploads') return false;
  const needle = `%${String(relativePath).replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
  for (const table of INVENTORY_TASK_TABLES) {
    try {
      const result = await db.query(
        `SELECT 1
           FROM ${table}
          WHERE status::text = ANY($1::text[])
            AND to_jsonb(${table})::text ILIKE $2 ESCAPE '\\'
          LIMIT 1`,
        [ACTIVE_TASK_STATUSES, needle],
      );
      if (result.rows.length) return true;
    } catch (error) {
      if (!/does not exist|relation .* does not exist/i.test(String(error.message))) throw error;
    }
  }
  return false;
}

async function deleteStorageFile({ rootKey, relativePath, confirm, dryRun = false, db = dbDefault } = {}) {
  const entry = getInventoryRoot(rootKey);
  if (!entry.fileCleanup) throw Object.assign(new Error('Этот storage root защищён от удаления'), { status: 403 });
  if (!dryRun && confirm !== 'DELETE') throw Object.assign(new Error('Для удаления требуется confirm=DELETE'), { status: 400 });
  const resolved = resolveInventoryFile(entry, relativePath);
  const stat = await fs.promises.lstat(resolved.target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) throw Object.assign(new Error('Файл не найден'), { status: 404 });
  if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('Разрешено удалять только обычные файлы'), { status: 400 });
  const realRoot = _safePath(entry.path);
  const realTarget = await fs.promises.realpath(resolved.target).catch(() => null);
  const realRelative = realTarget ? path.relative(realRoot, realTarget) : null;
  if (!realTarget || !realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw Object.assign(new Error('Файл выходит за пределы storage root'), { status: 400 });
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < 15 * 60 * 1000) {
    throw Object.assign(new Error('Нельзя удалять файл, изменённый менее 15 минут назад'), { status: 409 });
  }
  if (entry.key === 'images') {
    const taskId = resolved.relative.split('/')[0];
    if (await isActiveTaskId(taskId, db)) {
      throw Object.assign(new Error('Нельзя удалить файл активной задачи'), { status: 409 });
    }
  }
  if (await isReferencedByActiveTask(entry.key, resolved.relative, db)) {
    throw Object.assign(new Error('Нельзя удалить файл, используемый активной задачей'), { status: 409 });
  }

  const result = {
    root_key: entry.key,
    relative_path: resolved.relative,
    bytes: Number(stat.size) || 0,
    human: formatBytes(stat.size),
    dry_run: Boolean(dryRun),
    deleted: false,
  };
  if (dryRun) return result;
  await fs.promises.unlink(resolved.target);
  result.deleted = true;
  return result;
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
  let shouldDelete = null;
  if (entry.key === 'uploads') {
    const activePayloads = await getActiveTaskPayloads(db);
    shouldDelete = async (target) => {
      const relative = path.relative(entry.path, target).split(path.sep).join('/');
      const basename = path.basename(target);
      return !activePayloads.some((payload) => payload.includes(relative) || payload.includes(basename));
    };
  }
  const stats = await walkOldFiles(entry.path, cutoff, dryRun, shouldDelete);
  return { scope, path: entry.path, older_than_days: days, ...stats };
}

module.exports = {
  formatBytes,
  getKnownStoragePaths,
  getStorageAudit,
  cleanupStorage,
  getStorageInventory,
  deleteStorageFile,
  buildInventory,
  resolveInventoryFile,
  safeRelativePath,
  getActiveTaskPayloads,
  walkOldFiles,
};
