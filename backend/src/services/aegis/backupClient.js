'use strict';

/**
 * aegis/backupClient — клиент к /backup/run в aegis_py.
 *
 * Назначение: ночной snapshot накопленного «опыта» ИИ:
 *   • Qdrant snapshot API → dump per-collection;
 *   • Neo4j → neo4j-admin database dump (cypher-shell APOC export);
 *   • опц. загрузка в S3 (boto3) — иначе локально (volume).
 *
 * GitHub Actions workflow .github/workflows/aegis-nightly-backup.yml
 * выполняется по cron'у 03:00 UTC и вызывает этот endpoint через
 * /api/aegis/backup/run (admin).
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().backup;
  return {
    base:      getAegisFlags().graphrag.pyServiceUrl,
    timeoutMs: 60_000 * 30,        // 30 минут — на крупных коллекциях.
    enabled:   cfg.enabled,
    s3Bucket:  cfg.s3Bucket,
    s3Region:  cfg.s3Region,
    s3Prefix:  cfg.s3Prefix,
    localDir:  cfg.localDir,
    retainDays: cfg.retainDays,
  };
}

async function runBackup({ targets = ['qdrant', 'neo4j'] } = {}) {
  const o = _opts();
  if (!o.enabled) return { ok: false, reason: 'disabled' };
  return http.post(o.base, '/backup/run', {
    targets,
    s3_bucket:   o.s3Bucket,
    s3_region:   o.s3Region,
    s3_prefix:   o.s3Prefix,
    local_dir:   o.localDir,
    retain_days: o.retainDays,
  }, { timeoutMs: o.timeoutMs });
}

async function listBackups() {
  const o = _opts();
  return http.get(o.base, '/backup/list', { timeoutMs: 15_000 });
}

async function health() {
  const o = _opts();
  return http.get(o.base, '/backup/health', { timeoutMs: 5_000 });
}

module.exports = { runBackup, listBackups, health };
