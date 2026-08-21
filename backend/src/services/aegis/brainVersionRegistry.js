const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAegisFlags } = require('./featureFlags');

function _rootDir() {
  return path.resolve(getAegisFlags().brainState.rootDir);
}

function _confinedPath(candidate) {
  const root = _rootDir();
  const resolved = path.resolve(String(candidate || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('artifact_path_outside_brain_state');
  }
  return resolved;
}

function _sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function _writerPath() {
  return path.join(_rootDir(), getAegisFlags().brainState.writerYaml);
}

function rollbackArtifact({ artifactPath, expectedSha = null } = {}) {
  const source = _confinedPath(artifactPath);
  const target = _writerPath();
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return { ok: false, reason: 'artifact_not_found' };
  }
  const actualSha = _sha256(source);
  if (expectedSha && String(expectedSha) !== actualSha) {
    return { ok: false, reason: 'artifact_sha_mismatch', actual_sha: actualSha };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const historyDir = path.join(_rootDir(), 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  if (fs.existsSync(target)) {
    const currentSha = _sha256(target);
    fs.copyFileSync(target, path.join(historyDir, `compiled_writer.rollback-${Date.now()}-${currentSha.slice(0, 12)}.yaml`));
  }

  const temp = `${target}.rollback-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.copyFileSync(source, temp);
    const copiedSha = _sha256(temp);
    if (copiedSha !== actualSha) throw new Error('artifact_copy_sha_mismatch');
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { ok: true, artifact_path: target, artifact_sha: actualSha };
}

async function rollbackBrainVersion(db, versionId, actor = 'admin') {
  if (!db) return { ok: false, reason: 'db_not_wired' };
  const id = Number(versionId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid_version_id' };
  const result = await db.query(
    `SELECT id, yaml_path, artifact_sha, status
       FROM aegis_brain_versions
      WHERE id=$1 LIMIT 1`,
    [id],
  );
  const row = result.rows && result.rows[0];
  if (!row) return { ok: false, reason: 'version_not_found' };
  const artifact = rollbackArtifact({ artifactPath: row.yaml_path, expectedSha: row.artifact_sha });
  if (!artifact.ok) return artifact;

  await db.query(
    `UPDATE aegis_brain_versions
        SET status='rolled_back', rolled_back_at=COALESCE(rolled_back_at, NOW()),
            notes=COALESCE(notes, '') || $2
      WHERE status='deployed' AND id <> $1`,
    [id, `\nrollback by ${String(actor).slice(0, 80)}`],
  );
  await db.query(
    `UPDATE aegis_brain_versions
        SET status='deployed', rolled_back_at=NULL, deployed_at=NOW(), deployed_by=$2
      WHERE id=$1`,
    [id, String(actor).slice(0, 80)],
  );
  return { ok: true, id, ...artifact };
}

module.exports = { rollbackArtifact, rollbackBrainVersion, _confinedPath, _sha256 };
