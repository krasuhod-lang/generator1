'use strict';

/**
 * validationFailureLog — C1.1 плана «Усиление "Комбайна"».
 *
 * Append-only JSONL-логгер нарушений writer/validator. На основе этого
 * лога потом считается «топ-N нарушений за период» (C1.2 — отчёт
 * генерируется отдельным скриптом, в этой PR не входит).
 *
 * Принципы:
 *   • никогда не блокирует основной pipeline (ошибки записи → console.warn
 *     и продолжение работы; lossy by design);
 *   • ENV-gated через INFO_ARTICLE_VALIDATION_LOG_ENABLED — без флага
 *     функция no-op;
 *   • path управляется через INFO_ARTICLE_VALIDATION_LOG_PATH;
 *   • mkdirSync с recursive:true — на случай отсутствия каталога;
 *   • никаких секретов в payload — фильтруем поля, начинающиеся на
 *     api_key, token, secret, authorization, bearer.
 */

const fs = require('fs');
const path = require('path');
const { getQualityFlags } = require('./featureFlags');

const SECRET_KEY_RE = /^(api_?key|token|secret|authorization|bearer|password)$/i;

function sanitize(value, depth = 0) {
  if (depth > 6) return '[truncated:depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Маскируем токены вида sk-..., Bearer ...
    return value
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, 'sk-[REDACTED]');
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v, depth + 1);
    }
  }
  return out;
}

let _ensuredDirs = new Set();

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (_ensuredDirs.has(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    _ensuredDirs.add(dir);
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      // ENOENT/EACCES → log to console, do not throw
      // eslint-disable-next-line no-console
      console.warn(`[validationFailureLog] cannot mkdir ${dir}: ${err.code || err.message}`);
    } else {
      _ensuredDirs.add(dir);
    }
  }
}

/**
 * recordValidationFailure — записывает одну запись в JSONL.
 *
 * @param {object} entry
 * @param {string} entry.taskId
 * @param {string} entry.stage              — 'writer' | 'lsi' | 'links' | 'eeat' | ...
 * @param {string} entry.violationType      — 'missing-LSI' | 'broken-link' | 'short-paragraph' | 'missing-H3' | ...
 * @param {string} [entry.model]            — название модели (Gemini, DeepSeek)
 * @param {object} [entry.context]          — произвольные доп. поля (без секретов)
 * @returns {boolean}                       — true если записано, false если skip
 */
function recordValidationFailure(entry) {
  const flags = getQualityFlags();
  if (!flags.validationLog.enabled) return false;
  if (!entry || !entry.taskId || !entry.violationType) {
    // eslint-disable-next-line no-console
    console.warn('[validationFailureLog] entry must have taskId & violationType');
    return false;
  }
  const filePath = flags.validationLog.filePath;
  ensureDir(filePath);

  const record = {
    ts: new Date().toISOString(),
    taskId: String(entry.taskId),
    stage: entry.stage || 'unknown',
    violationType: entry.violationType,
    model: entry.model || null,
    context: sanitize(entry.context || {}),
  };

  try {
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[validationFailureLog] append failed: ${err.code || err.message}`);
    return false;
  }
}

/**
 * recordValidationFailures — batch-вариант.
 */
function recordValidationFailures(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  let written = 0;
  for (const e of entries) {
    if (recordValidationFailure(e)) written += 1;
  }
  return written;
}

/**
 * _resetForTest — очищает кеш ensured-dirs (нужно тестам).
 */
function _resetForTest() {
  _ensuredDirs = new Set();
}

module.exports = {
  recordValidationFailure,
  recordValidationFailures,
  _internal: { sanitize, _resetForTest },
};
