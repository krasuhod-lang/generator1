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

function scanPromptFiles() {
  return _walk(PROMPTS_ROOT)
    .filter(_isPromptSource)
    .sort()
    .map((file) => {
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
}

async function persistCurrentPrompts(db) {
  const prompts = scanPromptFiles();
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
  return { ok: true, total: prompts.length };
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
  getPromptDashboardStats,
  getPromptDspyLinkageStats,
  buildAutonomySnapshot,
  buildSiteOpportunities,
  promptHashFromText,
  buildPromptMeta,
};
