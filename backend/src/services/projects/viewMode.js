'use strict';

/**
 * projects/viewMode.js — слой режима просмотра проектного дашборда.
 *
 * Два режима (Premium UI ТЗ):
 *   • 'analyst' — полный payload (для штатного пользователя/SEO-аналитика).
 *   • 'client'  — урезанный payload без технических деталей (для клиента,
 *                 открывшего публичную ссылку или включившего тумблер
 *                 «Режим клиента» в UI).
 *
 * Источники режима (в порядке приоритета, см. middleware/viewMode.js):
 *   1. `share_mode` из БД, если запрос пришёл по публичной share-ссылке;
 *   2. заголовок `X-Client-Mode: 1` / query `?mode=client` — пользовательский
 *      тумблер для авторизованного запроса;
 *   3. default = 'analyst' для авторизованных, 'client' для публичных.
 *
 * Санитайзеры (`sanitizeProject`, `sanitizeAnalysis`) выполняют две задачи:
 *   • убирают тех. поля, которые клиенту не нужны (debug, raw_prompt и т.п.);
 *   • никогда не модифицируют исходный объект (возвращают копию).
 *
 * Принципы:
 *   • Это чистые функции — БД/HTTP не трогаем, тестируем отдельно
 *     (см. backend/scripts/test-view-mode.js).
 *   • Конкретные ключи перечислены явно, чтобы случайно не «потерять»
 *     данные при добавлении новых полей в snapshot.
 */

const VIEW_MODES = Object.freeze({ ANALYST: 'analyst', CLIENT: 'client' });

const VALID_MODES = new Set([VIEW_MODES.ANALYST, VIEW_MODES.CLIENT]);

/** Допустимое значение режима или fallback. */
function normalizeMode(value, fallback = VIEW_MODES.ANALYST) {
  const v = typeof value === 'string' ? value.toLowerCase().trim() : '';
  return VALID_MODES.has(v) ? v : fallback;
}

/**
 * Решает режим просмотра по объекту запроса. Используется middleware и
 * напрямую в getSharedProject (там известен share_mode проекта).
 *
 * opts:
 *   • shareMode   — режим из БД для публичной ссылки (если есть).
 *   • isPublic    — запрос пришёл на публичный роут (без auth).
 *
 * Заголовок и query учитываются только для авторизованных запросов:
 *   публичный токен сам определяет уровень доступа, и его нельзя
 *   «повысить» через X-Client-Mode.
 */
function resolveViewMode(req, opts = {}) {
  const { shareMode = null, isPublic = false } = opts;
  if (isPublic) return normalizeMode(shareMode, VIEW_MODES.CLIENT);
  const header = req && req.headers ? req.headers['x-client-mode'] : undefined;
  const query  = req && req.query   ? req.query.mode               : undefined;
  // X-Client-Mode: 1 / true / client — все эквивалентны.
  if (header !== undefined) {
    const h = String(header).toLowerCase().trim();
    if (h === '1' || h === 'true' || h === 'client') return VIEW_MODES.CLIENT;
    if (h === '0' || h === 'false' || h === 'analyst') return VIEW_MODES.ANALYST;
  }
  if (query) return normalizeMode(query, VIEW_MODES.ANALYST);
  return VIEW_MODES.ANALYST;
}

// ── Sanitizers ────────────────────────────────────────────────────────────

/** Поля проекта, которые НЕЛЬЗЯ показывать клиенту (тех. интеграции). */
const PROJECT_TECH_FIELDS = Object.freeze([
  'gsc_access_token_enc',
  'gsc_refresh_token_enc',
  'gsc_token_expiry',
  'gsc_available_sites',
  'gsc_has_refresh',
  'ydx_access_token_enc',
  'ydx_refresh_token_enc',
  'ydx_token_expiry',
  'ydx_available_sites',
  'ydx_has_refresh',
  'share_token',
  'share_expires_at',
  'share_mode',
  'share_created_at',
  'keys_so_domain',
  'keys_so_region',
]);

function sanitizeProject(project, mode) {
  if (!project || typeof project !== 'object') return project;
  if (normalizeMode(mode) !== VIEW_MODES.CLIENT) return project;
  const copy = { ...project };
  for (const key of PROJECT_TECH_FIELDS) delete copy[key];
  return copy;
}

/**
 * Поля внутри snapshot (gsc_snapshot / ydx_snapshot), которые скрываем
 * от клиента: отладочные срезы, сырые ответы LLM, внутренние счётчики.
 * Если поле отсутствует — просто пропускаем.
 */
const SNAPSHOT_TECH_FIELDS = Object.freeze([
  'debug',
  'raw',
  'raw_response',
  'raw_prompt',
  'prompt',
  'prompts',
  'llm_meta',
  'dspy_meta',
  'token_usage',
  'usage',
  'trace',
  'request_payload',
]);

function _sanitizeSnapshot(snapshot, mode) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (normalizeMode(mode) !== VIEW_MODES.CLIENT) return snapshot;
  const copy = { ...snapshot };
  for (const key of SNAPSHOT_TECH_FIELDS) delete copy[key];
  // Дополнительно вычищаем тех. поля внутри known-вложенных секций.
  // Список консервативный — добавляем только если знаем поле точно.
  if (copy.top_page_insights && typeof copy.top_page_insights === 'object') {
    const tpi = { ...copy.top_page_insights };
    delete tpi.profile_debug;
    delete tpi.comparison_debug;
    copy.top_page_insights = tpi;
  }
  if (copy.action_plan && typeof copy.action_plan === 'object') {
    const ap = { ...copy.action_plan };
    delete ap.debug;
    copy.action_plan = ap;
  }
  return copy;
}

/**
 * Поля анализа, которые скрываем для клиента. Markdown-отчёты оставляем —
 * это и есть основной видимый результат; режут только raw-метаданные.
 */
const ANALYSIS_TECH_FIELDS = Object.freeze([
  'ranking_factors_debug',
  'llm_meta',
  'prompt_log',
  'token_usage',
]);

function sanitizeAnalysis(analysis, mode) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  if (normalizeMode(mode) !== VIEW_MODES.CLIENT) return analysis;
  const copy = { ...analysis };
  for (const key of ANALYSIS_TECH_FIELDS) delete copy[key];
  if (copy.gsc_snapshot) copy.gsc_snapshot = _sanitizeSnapshot(copy.gsc_snapshot, mode);
  if (copy.ydx_snapshot) copy.ydx_snapshot = _sanitizeSnapshot(copy.ydx_snapshot, mode);
  return copy;
}

module.exports = {
  VIEW_MODES,
  normalizeMode,
  resolveViewMode,
  sanitizeProject,
  sanitizeAnalysis,
  // экспорт для тестов
  _internal: { PROJECT_TECH_FIELDS, SNAPSHOT_TECH_FIELDS, ANALYSIS_TECH_FIELDS, _sanitizeSnapshot },
};
