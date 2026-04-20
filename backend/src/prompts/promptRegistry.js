'use strict';

/**
 * promptRegistry.js — DSPy-inspired Prompts-as-Code фреймворк.
 *
 * Реализует концепции из DSPy для Node.js:
 * - Модульное управление промптами (каждый промпт — версионированный модуль)
 * - Программная валидация промптов (все {{VAR}} должны быть заполнены)
 * - Валидация JSON-схем ответов LLM
 * - Отслеживание версий промптов для A/B тестирования
 *
 * Совместимость: система полностью совместима с существующими
 * SYSTEM_PROMPTS / SYSTEM_PROMPTS_EXT из systemPrompts.js.
 * Регистрация промптов не изменяет их содержимое.
 */

// ── Prompt Registry ─────────────────────────────────────────────────

const registry = new Map(); // name → { prompt, version, inputVars, outputSchema, metadata }

/**
 * registerPrompt — регистрирует промпт в реестре.
 *
 * @param {string}   name         — уникальное имя ('stage3', 'entityLandscape', etc.)
 * @param {object}   config
 * @param {string}   config.prompt       — текст промпта
 * @param {string}   [config.version]    — версия ('1.0.0')
 * @param {string[]} [config.inputVars]  — список ожидаемых {{VARS}} (для валидации)
 * @param {object}   [config.outputSchema] — JSON-схема ожидаемого ответа
 * @param {object}   [config.metadata]   — произвольные метаданные
 */
function registerPrompt(name, config) {
  if (!name || !config?.prompt) {
    throw new Error(`registerPrompt: name and prompt are required`);
  }

  // Автоматически извлекаем {{VARS}} из текста промпта
  const detectedVars = extractVars(config.prompt);

  registry.set(name, {
    prompt:       config.prompt,
    version:      config.version || '1.0.0',
    inputVars:    config.inputVars || detectedVars,
    outputSchema: config.outputSchema || null,
    metadata:     config.metadata || {},
    registeredAt: new Date().toISOString(),
  });
}

/**
 * getPrompt — возвращает промпт из реестра.
 *
 * @param {string} name
 * @returns {{ prompt: string, version: string, inputVars: string[], outputSchema: object|null }}
 */
function getPrompt(name) {
  const entry = registry.get(name);
  if (!entry) return null;
  return { ...entry };
}

/**
 * fillAndValidate — заполняет переменные в промпте И валидирует,
 * что все {{VARS}} были заменены.
 *
 * @param {string}  promptText — текст промпта с {{VAR}} плейсхолдерами
 * @param {object}  vars       — { VAR_NAME: value, ... }
 * @param {object}  [opts]
 * @param {boolean} [opts.strict=false] — если true, бросает ошибку при незаполненных VAR
 * @param {Function} [opts.log] — callback для логирования предупреждений
 * @returns {string} — заполненный промпт
 */
function fillAndValidate(promptText, vars = {}, opts = {}) {
  const { strict = false, log = null } = opts;

  let result = promptText;

  // Заменяем все {{VAR}} на значения из vars
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'g');
    result = result.replace(pattern, () => String(value ?? ''));
  }

  // Проверяем незаполненные {{VAR}}
  const remaining = extractVars(result);
  if (remaining.length > 0) {
    const msg = `fillAndValidate: ${remaining.length} unfilled vars: ${remaining.join(', ')}`;
    if (strict) {
      throw new Error(msg);
    } else if (log) {
      log(msg, 'warn');
    }
  }

  return result;
}

/**
 * validateOutput — валидирует JSON-ответ LLM по зарегистрированной схеме.
 *
 * Lightweight-валидация (не полная JSON Schema):
 * - Проверяет наличие обязательных ключей
 * - Проверяет типы значений
 * - Логирует предупреждения для отсутствующих полей
 *
 * @param {string} promptName — имя промпта в реестре
 * @param {object} output     — JSON-ответ LLM
 * @param {object} [opts]
 * @param {Function} [opts.log] — callback для логирования
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validateOutput(promptName, output, opts = {}) {
  const { log = null } = opts;
  const entry = registry.get(promptName);

  if (!entry || !entry.outputSchema) {
    return { valid: true, issues: [] };
  }

  const issues = [];
  const schema = entry.outputSchema;

  // Проверяем required keys
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in output) || output[key] === null || output[key] === undefined) {
        issues.push(`Missing required key: ${key}`);
      }
    }
  }

  // Проверяем типы (если указаны)
  if (schema.properties) {
    for (const [key, spec] of Object.entries(schema.properties)) {
      if (!(key in output)) continue;
      const val = output[key];
      if (spec.type === 'string' && typeof val !== 'string') {
        issues.push(`${key}: expected string, got ${typeof val}`);
      }
      if (spec.type === 'number' && typeof val !== 'number') {
        issues.push(`${key}: expected number, got ${typeof val}`);
      }
      if (spec.type === 'array' && !Array.isArray(val)) {
        issues.push(`${key}: expected array, got ${typeof val}`);
      }
      if (spec.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
        issues.push(`${key}: expected object, got ${typeof val}`);
      }
    }
  }

  if (issues.length > 0 && log) {
    log(`Prompt "${promptName}" output validation: ${issues.join('; ')}`, 'warn');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * listPrompts — возвращает список всех зарегистрированных промптов.
 * @returns {Array<{ name: string, version: string, varsCount: number }>}
 */
function listPrompts() {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    version:   entry.version,
    varsCount: entry.inputVars.length,
  }));
}

// ── Предопределённые JSON-схемы ответов ─────────────────────────────

const OUTPUT_SCHEMAS = {
  stage3: {
    required: ['html_content'],
    properties: {
      html_content:    { type: 'string' },
      eeat_self_check: { type: 'object' },
      audit_report:    { type: 'object' },
    },
  },
  stage4: {
    required: ['pq_score'],
    properties: {
      pq_score:            { type: 'number' },
      eeat_criteria:       { type: 'object' },
      mathematical_audit:  { type: 'object' },
    },
  },
  stage5: {
    required: ['html_content'],
    properties: {
      html_content:    { type: 'string' },
      refinement_log:  { type: 'object' },
    },
  },
  stage6: {
    required: ['html_content'],
    properties: {
      html_content:   { type: 'string' },
      injection_log:  { type: 'array' },
    },
  },
  stage7: {
    required: ['global_audit'],
    properties: {
      global_audit:               { type: 'object' },
      eeat_criteria_breakdown:    { type: 'object' },
      tf_idf_and_spam_report:     { type: 'object' },
    },
  },
  entityLandscape: {
    required: ['entity_graph'],
    properties: {
      entity_graph:       { type: 'array' },
      knowledge_graph:    { type: 'object' },
      lsi_clusters:       { type: 'array' },
      commercial_intents: { type: 'array' },
      terminology_map:    { type: 'object' },
    },
  },
};

// ── Вспомогательные функции ─────────────────────────────────────────

/**
 * extractVars — извлекает все {{VAR_NAME}} из текста промпта.
 * @param {string} text
 * @returns {string[]} — уникальные имена переменных
 */
function extractVars(text) {
  if (!text) return [];
  const matches = text.match(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g) || [];
  return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))];
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  registerPrompt,
  getPrompt,
  fillAndValidate,
  validateOutput,
  listPrompts,
  extractVars,
  OUTPUT_SCHEMAS,
};
