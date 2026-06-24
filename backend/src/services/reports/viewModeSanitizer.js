'use strict';

/**
 * reports/viewModeSanitizer.js — слой санитизации payload отчётов под
 * единый view-mode contract (analyst|client), параллельный
 * services/projects/viewMode.js.
 *
 * Используется в reports.controller.js: getDraft, getDraftData, publicGet,
 * exportDraftPdf/Docx, publicExportPdf/Docx. Всё ниже — чистые функции,
 * без БД/HTTP; тестируются отдельно (backend/scripts/test-reports-view-mode.js).
 *
 * Правила:
 *   • В analyst mode payload не меняется — возвращаем как есть.
 *   • В client mode удаляются технические/диагностические поля
 *     (см. *_TECH_FIELDS) и режутся длинные таблицы внутри модулей.
 *   • Никогда не мутируем входные объекты: всегда новые копии.
 */

const VIEW_MODES = Object.freeze({ ANALYST: 'analyst', CLIENT: 'client' });

function _isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
function _isClient(mode) {
  return String(mode || '').toLowerCase() === VIEW_MODES.CLIENT;
}

// ── Field lists ───────────────────────────────────────────────────────────

/** Тех. поля на уровне draft (черновика отчёта). */
const DRAFT_TECH_FIELDS = Object.freeze([
  'llm_job_id',
  'llm_error',
  'llm_meta',
  'llm_status',
  'llm_prompt',
  'llm_raw_response',
  'token_usage',
  'ai_meta',
  'debug',
  'raw_prompt',
  'prompt',
  'prompts',
  'trace',
]);

/** Тех. поля внутри секции из dataAggregator (gsc / ywm / keys_so / position / tasks / modules). */
const SECTION_TECH_FIELDS = Object.freeze([
  'debug',
  'raw',
  'raw_response',
  'raw_prompt',
  'prompt',
  'prompts',
  'llm_meta',
  'token_usage',
  'usage',
  'trace',
  'request_payload',
  'request',
  'error_stack',
]);

/** Тех. поля внутри каждого модуля reports/modules/*. */
const MODULE_TECH_FIELDS = Object.freeze([
  'debug',
  'raw',
  'raw_response',
  'prompt',
  'request_payload',
  'trace',
]);

/** Поля строки модулей, которые нельзя показывать клиенту (числовые score/raw). */
const MODULE_ITEM_TECH_FIELDS = Object.freeze([
  'opportunity_score',
  'opportunity_delta',
  'ctr_ratio',
  'benchmark_ctr',
  'raw',
  'debug',
  '_posSum',
  '_posWeight',
]);

/** Сколько строк таблиц оставлять в client mode (короткий top-N для презентации). */
const CLIENT_ITEMS_LIMIT = 10;

// ── Helpers ───────────────────────────────────────────────────────────────

function _stripKeys(obj, keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function _sanitizeModuleItem(item) {
  if (!_isObj(item)) return item;
  return _stripKeys(item, MODULE_ITEM_TECH_FIELDS);
}

function _sanitizeModule(mod) {
  if (!_isObj(mod)) return mod;
  const copy = _stripKeys(mod, MODULE_TECH_FIELDS);
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.slice(0, CLIENT_ITEMS_LIMIT).map(_sanitizeModuleItem);
  }
  return copy;
}

function _sanitizeModulesBlock(modules) {
  if (!_isObj(modules)) return modules;
  const copy = { ...modules };
  for (const key of ['striking_distance', 'ctr_gap', 'content_health', 'off_page', 'tech_audit']) {
    if (_isObj(copy[key])) copy[key] = _sanitizeModule(copy[key]);
  }
  // executive сводка — оставляем как есть, это уже сжатые числа.
  for (const k of MODULE_TECH_FIELDS) delete copy[k];
  return copy;
}

function _sanitizeSection(section) {
  if (!_isObj(section)) return section;
  return _stripKeys(section, SECTION_TECH_FIELDS);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Санитизация черновика отчёта (то, что отдаёт _serializeDraft в reports.controller).
 * Возвращает новый объект; в analyst mode — возвращает аргумент как есть.
 */
function sanitizeDraft(draft, mode) {
  if (!_isObj(draft) || !_isClient(mode)) return draft;
  const copy = _stripKeys(draft, DRAFT_TECH_FIELDS);
  // tasks_blocks — может содержать внутренние debug-поля в каждом блоке/задаче.
  if (Array.isArray(copy.tasks_blocks)) {
    copy.tasks_blocks = copy.tasks_blocks.map((block) => {
      if (!_isObj(block)) return block;
      const b = _stripKeys(block, ['debug', 'raw']);
      if (Array.isArray(b.sections)) {
        b.sections = b.sections.map((s) => {
          if (!_isObj(s)) return s;
          const sec = _stripKeys(s, ['debug']);
          if (Array.isArray(sec.tasks)) {
            sec.tasks = sec.tasks.map((t) => (_isObj(t) ? _stripKeys(t, ['debug', 'raw', 'internal_note']) : t));
          }
          return sec;
        });
      }
      return b;
    });
  }
  // config — некоторые поля только для аналитика (modules thresholds, debug).
  if (_isObj(copy.config)) {
    copy.config = _stripKeys(copy.config, ['debug', 'modules_debug', 'prompt']);
  }
  return copy;
}

/**
 * Санитизация data-payload, который возвращает services/reports/dataAggregator.aggregateForDraft.
 * Снимает технические поля с каждой секции и сжимает таблицы модулей.
 */
function sanitizeData(data, mode) {
  if (!_isObj(data) || !_isClient(mode)) return data;
  const copy = { ...data };
  for (const key of ['gsc', 'ywm', 'keys_so', 'position', 'tasks']) {
    if (_isObj(copy[key])) copy[key] = _sanitizeSection(copy[key]);
  }
  if (_isObj(copy.modules)) copy.modules = _sanitizeModulesBlock(copy.modules);
  // tasks.items в client mode не должны содержать description (HTML с внутренними
  // пометками) — оставим только client-safe поля.
  if (_isObj(copy.tasks) && Array.isArray(copy.tasks.items)) {
    copy.tasks = {
      ...copy.tasks,
      items: copy.tasks.items.map((it) => {
        if (!_isObj(it)) return it;
        return {
          title: it.title,
          performed_at: it.performed_at,
          task_type: it.task_type,
          source: it.source,
          client_summary: it.client_summary || null,
        };
      }),
    };
  }
  return copy;
}

/**
 * Санитизация AI-summary (highlights, executive_summary, etc.). В client mode
 * прячем диагностику генерации, оставляем готовый текст для клиента.
 */
function sanitizeSummary(summary, mode) {
  if (!_isObj(summary) || !_isClient(mode)) return summary;
  return _stripKeys(summary, ['llm_meta', 'token_usage', 'debug', 'prompt', 'raw_response']);
}

module.exports = {
  VIEW_MODES,
  sanitizeDraft,
  sanitizeData,
  sanitizeSummary,
  // экспорт для тестов
  _internal: {
    DRAFT_TECH_FIELDS,
    SECTION_TECH_FIELDS,
    MODULE_TECH_FIELDS,
    MODULE_ITEM_TECH_FIELDS,
    CLIENT_ITEMS_LIMIT,
    _sanitizeModule,
    _sanitizeModulesBlock,
    _sanitizeSection,
  },
};
