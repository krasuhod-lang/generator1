'use strict';

/**
 * contentPolicy/rulesRepo — write-side реестра правил контента (V6, Фаза 2).
 *
 * Фаза 1 дала только чтение (index.refresh() тянет active-правила в кэш) и
 * захардкоженные defaults. Единственный способ добавить правило был — руками
 * в SQL, что противоречит цели V6 «менять политику БЕЗ деплоя».
 *
 * Здесь — CRUD поверх content_policy_rules (migration 097) плюс ЧИСТЫЙ
 * валидатор входа `normalizeRuleInput`, вынесенный отдельно, чтобы его можно
 * было юнит-тестировать без БД. Любая мутация инвалидирует процессный кэш
 * index.refresh({ force:true }), чтобы новое правило подхватилось хот-пасами
 * (stage5.checkAntiWater, qualityGate.finalize) в пределах текущего процесса.
 *
 * Ошибки валидации бросаются как Error с .status=400 и .code — контроллер
 * транслирует их в HTTP 400 без раскрытия внутренностей.
 */

const contentPolicy = require('./index');

// rule_type ∈ enum из migration 097 (шапка content_policy_rules).
const RULE_TYPES = Object.freeze([
  'stop_phrase',
  'banned_formulation',
  'compliance_claim',
  'ymyl_flag',
  'threshold',
  'value_add_catalog',
]);

// scope ∈ { global | project | locale | niche } (migration 097).
const SCOPES = Object.freeze(['global', 'project', 'locale', 'niche']);

// Пороги, которые допустимо переопределять rule_type='threshold'.
// Совпадает с ключами DEFAULT_THRESHOLDS (defaults.js) — защищает от
// опечаток и мусорных ключей в payload.
const THRESHOLD_KEYS = Object.freeze([
  'plagiarismMaxRatio',
  'factConfidenceMin',
  'intentBlockOnMismatch',
  'lsiOverdoseBlockVerdict',
  'minValueAdds',
  'riskBlockLevel',
  'freshnessStaleYears',
]);

function _badRequest(code, message) {
  const e = new Error(message || code);
  e.status = 400;
  e.code = code;
  return e;
}

/**
 * _normalizePhraseList — payload с { phrase } и/или { phrases:[] } →
 * гарантированно непустой массив строк без дублей/пустот.
 * @param {object} payload
 * @param {string} field — 'phrase' (для сообщений об ошибке)
 * @returns {string[]}
 */
function _normalizePhraseList(payload, field) {
  const list = [];
  if (payload && typeof payload.phrase === 'string') list.push(payload.phrase);
  if (payload && Array.isArray(payload.phrases)) list.push(...payload.phrases);
  const cleaned = [];
  const seen = new Set();
  for (const item of list) {
    const s = String(item == null ? '' : item).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(s);
  }
  if (!cleaned.length) {
    throw _badRequest('empty_payload', `payload требует непустой ${field}/${field}s`);
  }
  return cleaned;
}

/**
 * normalizeRuleInput — ЧИСТАЯ валидация/нормализация тела запроса на создание
 * правила. Приводит payload к каноничной форме, которую понимает
 * index.refresh() (switch по rule_type). Бросает 400 при некорректном вводе.
 *
 * @param {object} body — { rule_type, scope?, scope_ref?, payload, active? }
 * @returns {{ rule_type:string, scope:string, scope_ref:(string|null), payload:object, active:boolean }}
 */
function normalizeRuleInput(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const ruleType = String(b.rule_type || '').trim();
  if (!RULE_TYPES.includes(ruleType)) {
    throw _badRequest('invalid_rule_type', `rule_type должен быть одним из: ${RULE_TYPES.join(', ')}`);
  }

  const scope = b.scope == null ? 'global' : String(b.scope).trim();
  if (!SCOPES.includes(scope)) {
    throw _badRequest('invalid_scope', `scope должен быть одним из: ${SCOPES.join(', ')}`);
  }

  // scope_ref обязателен для не-global scope (locale-код / project_id / niche-ключ).
  let scopeRef = b.scope_ref == null ? null : String(b.scope_ref).trim();
  if (scope === 'global') {
    scopeRef = null;
  } else if (!scopeRef) {
    throw _badRequest('scope_ref_required', `scope_ref обязателен для scope='${scope}'`);
  }

  const rawPayload = (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload))
    ? b.payload
    : {};

  let payload;
  switch (ruleType) {
    case 'stop_phrase':
    case 'banned_formulation':
    case 'compliance_claim': {
      payload = { phrases: _normalizePhraseList(rawPayload, 'phrase') };
      break;
    }
    case 'ymyl_flag': {
      // Переиспользуем нормализацию списка, но по ключам keyword/keywords.
      const list = [];
      if (typeof rawPayload.keyword === 'string') list.push(rawPayload.keyword);
      if (Array.isArray(rawPayload.keywords)) list.push(...rawPayload.keywords);
      const kws = _normalizePhraseList({ phrases: list }, 'keyword');
      payload = { keywords: kws };
      break;
    }
    case 'value_add_catalog': {
      const items = _normalizePhraseList(
        { phrases: Array.isArray(rawPayload.items) ? rawPayload.items : [] },
        'item',
      );
      payload = { items };
      break;
    }
    case 'threshold': {
      const out = {};
      for (const [k, v] of Object.entries(rawPayload)) {
        if (!THRESHOLD_KEYS.includes(k)) {
          throw _badRequest('unknown_threshold_key', `неизвестный порог '${k}'. Допустимо: ${THRESHOLD_KEYS.join(', ')}`);
        }
        out[k] = v;
      }
      if (!Object.keys(out).length) {
        throw _badRequest('empty_payload', 'payload threshold должен содержать хотя бы один порог');
      }
      payload = out;
      break;
    }
    default:
      throw _badRequest('invalid_rule_type', 'unreachable');
  }

  const active = b.active == null ? true : !!b.active;

  return { rule_type: ruleType, scope, scope_ref: scopeRef, payload, active };
}

/**
 * _db — pg-клиент по умолчанию.
 */
function _db(db) { return db || require('../../config/db'); }

/**
 * listRules — выборка правил с опциональными фильтрами.
 * @param {object} [opts] — { ruleType, scope, active, limit, db }
 * @returns {Promise<object[]>}
 */
async function listRules(opts = {}) {
  const db = _db(opts.db);
  const where = [];
  const params = [];
  if (opts.ruleType) { params.push(String(opts.ruleType)); where.push(`rule_type = $${params.length}`); }
  if (opts.scope)    { params.push(String(opts.scope));    where.push(`scope = $${params.length}`); }
  if (typeof opts.active === 'boolean') { params.push(opts.active); where.push(`active = $${params.length}`); }
  const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 500));
  const sql =
    `SELECT id, scope, scope_ref, rule_type, payload, active, created_by, created_at, updated_at
       FROM content_policy_rules
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY rule_type, id DESC
      LIMIT ${limit}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

/**
 * createRule — вставка нового правила (после normalizeRuleInput) + инвалидация кэша.
 * @param {object} params — { input, createdBy, db }
 * @returns {Promise<object>} созданная строка
 */
async function createRule({ input, createdBy = null, db } = {}) {
  const norm = normalizeRuleInput(input);
  const client = _db(db);
  const { rows } = await client.query(
    `INSERT INTO content_policy_rules (scope, scope_ref, rule_type, payload, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, scope, scope_ref, rule_type, payload, active, created_by, created_at, updated_at`,
    [norm.scope, norm.scope_ref, norm.rule_type, JSON.stringify(norm.payload), norm.active, createdBy],
  );
  await _invalidateCache(client);
  return rows[0];
}

/**
 * updateRule — частичное обновление правила (payload и/или active).
 * payload, если передан, проходит ту же нормализацию (rule_type берётся из БД).
 * @param {object} params — { id, patch:{ payload?, active? }, db }
 * @returns {Promise<object|null>} обновлённая строка или null, если не найдена
 */
async function updateRule({ id, patch = {}, db } = {}) {
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) throw _badRequest('invalid_id', 'id правила некорректен');
  const client = _db(db);

  const existing = await client.query(
    `SELECT id, scope, scope_ref, rule_type, payload, active FROM content_policy_rules WHERE id = $1`,
    [ruleId],
  );
  if (!existing.rows.length) return null;
  const cur = existing.rows[0];

  let payload = cur.payload;
  if (patch.payload !== undefined) {
    // Нормализуем через тот же валидатор, подставляя текущий rule_type/scope.
    const norm = normalizeRuleInput({
      rule_type: cur.rule_type,
      scope: cur.scope,
      scope_ref: cur.scope_ref,
      payload: patch.payload,
    });
    payload = norm.payload;
  }
  const active = patch.active === undefined ? cur.active : !!patch.active;

  const { rows } = await client.query(
    `UPDATE content_policy_rules
        SET payload = $2, active = $3, updated_at = NOW()
      WHERE id = $1
    RETURNING id, scope, scope_ref, rule_type, payload, active, created_by, created_at, updated_at`,
    [ruleId, JSON.stringify(payload), active],
  );
  await _invalidateCache(client);
  return rows[0];
}

/**
 * deactivateRule — мягкое удаление (active=false). Хранит историю в БД.
 * @param {object} params — { id, db }
 * @returns {Promise<object|null>}
 */
async function deactivateRule({ id, db } = {}) {
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) throw _badRequest('invalid_id', 'id правила некорректен');
  const client = _db(db);
  const { rows } = await client.query(
    `UPDATE content_policy_rules
        SET active = FALSE, updated_at = NOW()
      WHERE id = $1
    RETURNING id, scope, scope_ref, rule_type, payload, active, created_by, created_at, updated_at`,
    [ruleId],
  );
  if (!rows.length) return null;
  await _invalidateCache(client);
  return rows[0];
}

/**
 * _invalidateCache — сбросить процессный кэш реестра, чтобы изменения были
 * видны хот-пасам без рестарта. Ошибки refresh проглатываются (реестр
 * никогда не должен ломать основной поток).
 */
async function _invalidateCache(db) {
  try { await contentPolicy.refresh({ force: true, db }); }
  catch (_e) { /* graceful — кэш обновится по TTL */ }
}

module.exports = {
  RULE_TYPES,
  SCOPES,
  THRESHOLD_KEYS,
  normalizeRuleInput,
  listRules,
  createRule,
  updateRule,
  deactivateRule,
};
