'use strict';

/**
 * A.E.G.I.S. prompt audit.
 *
 * Сканирует Prompts-as-Code файлы, считает стабильные hash'и и (best-effort)
 * пишет историю изменений в aegis_prompt_audit. Содержимое промтов в БД не
 * сохраняется: только fingerprint/метаданные, чтобы безопасно связывать
 * обучение DSPy и отчёты качества с конкретной версией промта.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractVars } = require('../../prompts/promptRegistry');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROMPTS_ROOT = path.join(REPO_ROOT, 'backend/src/prompts');

// A2/B1: in-memory кэш сканирования промтов.
//   - mtimeSig: подпись по (rel_path|mtimeMs) всех файлов — инвалидируется только при реальном изменении
//   - persistedAt: последний успешный persistCurrentPrompts (с TTL ниже)
//   - prompts: последний результат scanPromptFiles() для resolvePromptHash
const _SCAN_CACHE = {
  mtimeSig: null,
  prompts: null,
  scannedAt: 0,
  persistedMtimeSig: null,
  persistedAt: 0,
};
const SCAN_TTL_MS = 60 * 1000;          // повторное чтение FS не чаще раза в минуту
const PERSIST_TTL_MS = 10 * 60 * 1000;  // запись в БД не чаще раза в 10 минут (если файлы не менялись)

function promptHashFromText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function buildPromptMeta({ kind, userPrompt, sourceKey = null, sourceHash = null } = {}) {
  const text = String(userPrompt || '');
  const userHash = text ? promptHashFromText(text) : null;
  return {
    prompt_hash: sourceHash || userHash,
    prompt_meta: {
      source_key: sourceKey,
      source_hash: sourceHash,
      user_prompt_hash: userHash,
      user_prompt_chars: text.length,
      kind: kind || null,
    },
  };
}

function _walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      _walk(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function _isPromptSource(file) {
  const ext = path.extname(file);
  if (ext === '.txt') return true;
  if (ext !== '.js') return false;
  const base = path.basename(file);
  return ['systemPrompts.js', 'strategyPrompts.js', 'personas.js'].includes(base);
}

function _classify(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/stage3_writer/.test(p)) return { role: 'writer', dspy_linked: true };
  if (/stage5|audit|critic|factcheck/.test(p)) return { role: 'critic', dspy_linked: true };
  if (/stage[0-2]|preStage0|planner|synthesis|intents|audience/.test(p)) {
    return { role: 'analysis', dspy_linked: true };
  }
  if (/editorCopilot/.test(p)) return { role: 'site_assistant', dspy_linked: false };
  return { role: 'prompt', dspy_linked: false };
}

function _computeMtimeSig(files) {
  const parts = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      parts.push(`${file}|${st.mtimeMs}|${st.size}`);
    } catch (_) { /* skip */ }
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

function scanPromptFiles() {
  const files = _walk(PROMPTS_ROOT).filter(_isPromptSource).sort();
  const mtimeSig = _computeMtimeSig(files);
  // A2: вернуть кэш если файлы не менялись и TTL не вышел.
  if (_SCAN_CACHE.prompts
    && _SCAN_CACHE.mtimeSig === mtimeSig
    && (Date.now() - _SCAN_CACHE.scannedAt) < SCAN_TTL_MS) {
    try {
      const tel = require('./telemetry');
      if (tel && tel.M && tel.M.statusCacheHits) tel.M.statusCacheHits.inc(1, { kind: 'scan' });
    } catch (_) { /* graceful */ }
    return _SCAN_CACHE.prompts;
  }
  const prompts = files.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const sourceKey = rel
      .replace(/^backend\/src\/prompts\//, '')
      .replace(/\.(txt|js)$/i, '');
    const vars = extractVars(text);
    const stat = fs.statSync(file);
    return {
      prompt_key: sourceKey,
      source_path: rel,
      prompt_hash: promptHashFromText(text),
      hash_short: promptHashFromText(text).slice(0, 12),
      content_chars: text.length,
      vars,
      vars_count: vars.length,
      mtime: stat.mtime.toISOString(),
      ..._classify(sourceKey),
    };
  });
  _SCAN_CACHE.mtimeSig = mtimeSig;
  _SCAN_CACHE.prompts = prompts;
  _SCAN_CACHE.scannedAt = Date.now();
  return prompts;
}

/**
 * B1: вернуть текущий sha256-хеш конкретного промта по prompt_key (например
 * 'infoArticle/stage3_writer'). Использует кэш scanPromptFiles, поэтому
 * пайплайны могут звать на каждой генерации без хождения по FS.
 */
function resolvePromptHash(promptKey) {
  if (!promptKey) return null;
  const prompts = scanPromptFiles();
  // совпадение по точному prompt_key или префиксу (например 'infoArticle/stage3_writer'
  // может матчить 'infoArticle/stage3_writer/system'). Берём самый длинный matched key.
  const matches = prompts.filter((p) => p.prompt_key === promptKey || p.prompt_key.startsWith(`${promptKey}/`));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0].prompt_hash;
  // несколько файлов (например system+user) — комбинированный hash в детерминированном порядке
  const combined = matches
    .sort((a, b) => a.prompt_key.localeCompare(b.prompt_key))
    .map((m) => `${m.prompt_key}:${m.prompt_hash}`)
    .join('|');
  return promptHashFromText(combined);
}

// Последняя диагностика persistCurrentPrompts — поднимаем в /api/aegis/status,
// чтобы UI понимал, почему «Всего промтов: 0» (раньше ошибка глоталась).
const _PERSIST_DIAG = {
  last_run_at: null,
  last_ok: null,
  last_error: null,      // { reason: 'table_missing'|'scan_empty'|'db_error', message }
  last_total: null,
};

function _classifyDbError(err) {
  const msg = String((err && err.message) || err || '');
  const code = (err && err.code) || null;
  if (code === '42P01' || /relation .* does not exist/i.test(msg)) {
    return { reason: 'table_missing', message: msg };
  }
  if (code === '42703' || /column .* does not exist/i.test(msg)) {
    return { reason: 'schema_mismatch', message: msg };
  }
  return { reason: 'db_error', message: msg };
}

function getPersistDiagnostics() {
  return { ..._PERSIST_DIAG };
}

async function persistCurrentPrompts(db, opts = {}) {
  const prompts = scanPromptFiles();
  const currentSig = _SCAN_CACHE.mtimeSig;
  if (!prompts.length) {
    _PERSIST_DIAG.last_run_at = new Date().toISOString();
    _PERSIST_DIAG.last_ok = false;
    _PERSIST_DIAG.last_total = 0;
    _PERSIST_DIAG.last_error = { reason: 'scan_empty', message: 'no prompt sources found under backend/src/prompts' };
    console.warn('[aegis/promptAudit] scan_empty: no prompt sources discovered');
    return { ok: false, total: 0, reason: 'scan_empty' };
  }
  // A2: skip полную запись, если файлы не менялись с прошлого persist и TTL свеж.
  // force=true позволяет ручным вызовам (тесты, миграция) обойти кэш.
  if (!opts.force
    && currentSig
    && _SCAN_CACHE.persistedMtimeSig === currentSig
    && (Date.now() - _SCAN_CACHE.persistedAt) < PERSIST_TTL_MS) {
    try {
      const tel = require('./telemetry');
      if (tel && tel.M && tel.M.statusCacheHits) tel.M.statusCacheHits.inc(1, { kind: 'persist' });
    } catch (_) { /* graceful */ }
    return { ok: true, total: prompts.length, cached: true };
  }
  try {
  for (const p of prompts) {
    const latest = await db.query(
      `SELECT prompt_hash
         FROM aegis_prompt_audit
        WHERE prompt_key = $1
        ORDER BY changed_at DESC, id DESC
        LIMIT 1`,
      [p.prompt_key],
    );
    const prev = latest.rows[0] || null;
    if (!prev || prev.prompt_hash !== p.prompt_hash) {
      await db.query(
        `INSERT INTO aegis_prompt_audit
           (prompt_key, source_path, prompt_hash, previous_hash, change_kind,
            content_chars, vars, role, dspy_linked, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, TRUE)`,
        [
          p.prompt_key,
          p.source_path,
          p.prompt_hash,
          prev ? prev.prompt_hash : null,
          prev ? 'changed' : 'created',
          p.content_chars,
          JSON.stringify(p.vars),
          p.role,
          Boolean(p.dspy_linked),
        ],
      );
    } else {
      await db.query(
        `UPDATE aegis_prompt_audit
            SET last_seen_at = NOW(), active = TRUE,
                content_chars = $2, vars = $3::jsonb, role = $4, dspy_linked = $5
          WHERE prompt_key = $1 AND prompt_hash = $6`,
        [p.prompt_key, p.content_chars, JSON.stringify(p.vars), p.role, Boolean(p.dspy_linked), p.prompt_hash],
      );
    }
  }

  const keys = prompts.map((p) => p.prompt_key);
  if (keys.length) {
    await db.query(`UPDATE aegis_prompt_audit SET active = FALSE WHERE NOT (prompt_key = ANY($1::text[]))`, [keys]);
  }
  _SCAN_CACHE.persistedMtimeSig = currentSig;
  _SCAN_CACHE.persistedAt = Date.now();
  _PERSIST_DIAG.last_run_at = new Date().toISOString();
  _PERSIST_DIAG.last_ok = true;
  _PERSIST_DIAG.last_total = prompts.length;
  _PERSIST_DIAG.last_error = null;
  return { ok: true, total: prompts.length, cached: false };
  } catch (err) {
    const diag = _classifyDbError(err);
    _PERSIST_DIAG.last_run_at = new Date().toISOString();
    _PERSIST_DIAG.last_ok = false;
    _PERSIST_DIAG.last_total = prompts.length;
    _PERSIST_DIAG.last_error = diag;
    console.warn(`[aegis/promptAudit] persist failed (${diag.reason}): ${diag.message}`);
    return { ok: false, total: prompts.length, reason: diag.reason };
  }
}

/**
 * A4: retention для aegis_prompt_audit — оставляем последние N версий на prompt_key
 * и удаляем неактивные старше M дней. Безопасно вызывать раз в сутки.
 */
async function pruneAuditHistory(db, opts = {}) {
  const keepPerKey = Math.max(1, Number(opts.keepPerKey) || 20);
  const inactiveDays = Math.max(1, Number(opts.inactiveDays) || 90);
  const stats = { kept_per_key: keepPerKey, inactive_days: inactiveDays, deleted_versions: 0, deleted_inactive: 0 };
  try {
    const r1 = await db.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (PARTITION BY prompt_key ORDER BY changed_at DESC, id DESC) AS rn
           FROM aegis_prompt_audit
       )
       DELETE FROM aegis_prompt_audit
        WHERE id IN (SELECT id FROM ranked WHERE rn > $1)`,
      [keepPerKey],
    );
    stats.deleted_versions = r1.rowCount || 0;
  } catch (e) { stats.versions_error = e.message; }
  try {
    const r2 = await db.query(
      `DELETE FROM aegis_prompt_audit
        WHERE active = FALSE
          AND last_seen_at < NOW() - ($1 || ' days')::interval`,
      [String(inactiveDays)],
    );
    stats.deleted_inactive = r2.rowCount || 0;
  } catch (e) { stats.inactive_error = e.message; }
  return stats;
}

/** Тестовый хук: сброс кэша. */
function _resetCache() {
  _SCAN_CACHE.mtimeSig = null;
  _SCAN_CACHE.prompts = null;
  _SCAN_CACHE.scannedAt = 0;
  _SCAN_CACHE.persistedMtimeSig = null;
  _SCAN_CACHE.persistedAt = 0;
}

async function getPromptDashboardStats(db) {
  const current = scanPromptFiles();
  const base = {
    total_prompts: current.length,
    dspy_linked: current.filter((p) => p.dspy_linked).length,
    writer_prompts: current.filter((p) => p.role === 'writer').length,
    critic_prompts: current.filter((p) => p.role === 'critic').length,
    analysis_prompts: current.filter((p) => p.role === 'analysis').length,
    inventory: current.slice(0, 80),
    changes_7d: 0,
    recent_changes: [],
  };
  try {
    const [{ rows: cnt }, { rows: recent }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS n
           FROM aegis_prompt_audit
          WHERE changed_at > NOW() - INTERVAL '7 days'`,
      ),
      db.query(
        `SELECT id, prompt_key, source_path, prompt_hash, previous_hash,
                change_kind, role, dspy_linked, content_chars, changed_at
           FROM aegis_prompt_audit
          ORDER BY changed_at DESC, id DESC
          LIMIT 30`,
      ),
    ]);
    base.changes_7d = Number(cnt[0] && cnt[0].n) || 0;
    base.recent_changes = recent.map((r) => ({
      ...r,
      hash_short: String(r.prompt_hash || '').slice(0, 12),
      previous_hash_short: String(r.previous_hash || '').slice(0, 12) || null,
    }));
  } catch (_) { /* migration may be absent on old DB */ }
  return base;
}

async function getPromptDspyLinkageStats(db) {
  const out = {
    dspy_rows: 0,
    dspy_rows_with_prompt_hash: 0,
    quality_rows: 0,
    quality_rows_with_prompt_hash: 0,
    unique_prompt_hashes_in_training: 0,
    coverage_pct: null,
  };
  try {
    const [{ rows: dspyRows }, { rows: qualityRows }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE prompt_hash IS NOT NULL)::int AS linked,
                COUNT(DISTINCT prompt_hash) FILTER (WHERE prompt_hash IS NOT NULL)::int AS uniq
           FROM aegis_dspy_dataset
          WHERE is_seed = FALSE`,
      ),
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE prompt_hash IS NOT NULL)::int AS linked
           FROM aegis_quality_log`,
      ),
    ]);
    out.dspy_rows = Number(dspyRows[0] && dspyRows[0].total) || 0;
    out.dspy_rows_with_prompt_hash = Number(dspyRows[0] && dspyRows[0].linked) || 0;
    out.unique_prompt_hashes_in_training = Number(dspyRows[0] && dspyRows[0].uniq) || 0;
    out.quality_rows = Number(qualityRows[0] && qualityRows[0].total) || 0;
    out.quality_rows_with_prompt_hash = Number(qualityRows[0] && qualityRows[0].linked) || 0;
    out.coverage_pct = out.dspy_rows > 0
      ? Math.round((out.dspy_rows_with_prompt_hash * 1000) / out.dspy_rows) / 10
      : null;
  } catch (_) { /* columns/table may be absent */ }
  return out;
}

function buildAutonomySnapshot(flags = {}) {
  return {
    goal: '24/7 анализ → обучение → улучшение промтов → контроль качества',
    loop: [
      'Каждая генерация пишет aegis_quality_log и симптомы failureAnalyzer',
      'Успешные примеры SPQ≥80 попадают в aegis_dspy_dataset',
      'DSPy retrain компилирует brain_state/compiled_writer.yaml',
      'Prompt audit фиксирует hash/историю изменений промтов',
      'Dashboard подсвечивает провалы, покрытие обучения и готовые улучшения сайта',
    ],
    enabled: {
      quality_log: flags.qualityLog?.enabled !== false,
      dspy: Boolean(flags.dspy?.enabled),
      backlog: Boolean(flags.backlog?.enabled),
      self_mutation: Boolean(flags.selfmutate?.enabled),
      human_review: Boolean(flags.selfmutate?.requireHumanReview),
    },
  };
}

function buildSiteOpportunities() {
  return [
    { key: 'prompt_change_log', title: 'Лог изменений промтов', status: 'ready', value: 'показывать hash, дату, роль и связь с DSPy' },
    { key: 'failure_to_prompt', title: 'Причина провала → промт', status: 'ready', value: 'сопоставлять симптомы E-E-A-T/fact-check/LSI с writer/critic промтами' },
    { key: 'dspy_training_coverage', title: 'Покрытие обучения DSPy', status: 'ready', value: 'видеть долю обучающих строк с prompt_hash и нишевое покрытие' },
    { key: 'site_backlog', title: 'Бэклог улучшений сайта', status: 'ready', value: 'выводить функции, которые можно реализовать на сайте из AEGIS-сигналов' },
    { key: 'autonomous_loop', title: 'Автономный цикл качества', status: 'watch', value: 'контроль: quality log → dataset → retrain → brain versions → prompt audit' },
  ];
}

module.exports = {
  scanPromptFiles,
  persistCurrentPrompts,
  pruneAuditHistory,
  resolvePromptHash,
  getPromptDashboardStats,
  getPromptDspyLinkageStats,
  buildAutonomySnapshot,
  buildSiteOpportunities,
  getPersistDiagnostics,
  promptHashFromText,
  buildPromptMeta,
  _resetCache,
};
