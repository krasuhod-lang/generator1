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
 *   • включается через программный флаг QUALITY_FLAGS.validationLog.enabled
 *     в backend/src/services/qualityLayers/featureFlags.js — если флаг
 *     равен false (значение по умолчанию), функция no-op;
 *   • путь к файлу задаётся в QUALITY_FLAGS.validationLog.filePath;
 *   • mkdirSync с recursive:true — на случай отсутствия каталога;
 *   • никаких секретов в payload — фильтруем поля, начинающиеся на
 *     api_key, token, secret, authorization, bearer.
 */

const fs = require('fs');
const path = require('path');
const { getQualityFlags } = require('./featureFlags');

const SECRET_KEY_RE = /^(api_?key|token|secret|authorization|bearer|password|passwd|pwd|access_?key|private_?key|client_?secret)$/i;

/**
 * TOKEN_PATTERNS — наборы шаблонов известных секретных строк.
 * Применяются последовательно поверх каждой строки. Каждый шаблон
 * заменяется на стабильный маркер «<TYPE>-[REDACTED]».
 *
 * Список покрывает наиболее частые форматы, которые могут случайно
 * попасть в payload (URL'ы, JSON-ошибки апстрима, stack traces):
 *   - Bearer ...
 *   - sk-... (OpenAI/DeepSeek/Anthropic)
 *   - GitHub PAT (ghp_..., github_pat_..., gho_/ghu_/ghs_/ghr_)
 *   - JWT (header.payload.signature, base64url)
 *   - AWS access key ID (AKIA + 16 base32)
 *   - Generic hex 32+ символов (часто сессионные токены / hash-секреты)
 */
const TOKEN_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._\-]+/gi,                              'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_\-]{8,}\b/g,                               'sk-[REDACTED]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g,                                'ghp_[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                        'github_pat_[REDACTED]'],
  [/\bgh[oush]_[A-Za-z0-9]{20,}\b/g,                           'gh_[REDACTED]'],
  // JWT: три base64url-сегмента, разделённые точками; первый начинается с eyJ.
  [/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,  'jwt-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g,                                    'AKIA-[REDACTED]'],
  // Длинный hex (≥32) — типично session-id / API hash / SHA-256 как токен.
  // Ставим в конце, чтобы более специфичные паттерны выше отработали раньше.
  [/\b[a-f0-9]{32,}\b/gi,                                      'hex-[REDACTED]'],
];

function _maskTokensInString(s) {
  let out = s;
  for (const [re, repl] of TOKEN_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[truncated:depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return _maskTokensInString(value);
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
