'use strict';

/**
 * masterJson.js — детерминированный слой master JSON для Reddit Mapper V2.
 *
 * Reddit Mapper V2 — это цепочка из 7 этапов, где каждый этап ПРОДОЛЖАЕТ единый
 * накопительный master JSON (Этап 0 отдаёт seed JSON; Этапы 1–6 поэтапно
 * заполняют reddit_source_map / pain_map / language_map / emerging_map /
 * priority_matrix / cluster_architecture). Здесь — только детерминированная,
 * полностью тестируемая логика (без сети/LLM):
 *
 *   - createEmptyMaster()        — пустой каркас с каноническими ключами;
 *   - mergeMasterJson(prev, out) — безопасный merge выхода этапа в master
 *     (никогда не теряем уже заполненные предыдущими этапами секции);
 *   - normalizeStageOutput(raw)  — приведение «грязного» ответа LLM к объекту;
 *   - validateMaster(master)     — структурная валидация + список замечаний;
 *   - buildResearchDigest(master)— компактная «выжимка голоса аудитории»,
 *     которую infoArticle-генератор подаёт в knowledge base (§10).
 *
 * Назначение в продукте (см. ТЗ): дать статье оригинальную пользу /
 * Information Gain / реальный язык и боли аудитории, которых нет в среднем топе.
 */

const SYSTEM_VERSION = 'reddit_mapper_v2';

// Канонические top-level ключи накопительного master JSON (в порядке этапов).
const MASTER_KEYS = Object.freeze([
  'system_version',
  'workflow_mode',
  'project_meta',
  'site_input',
  'research_scope',
  'reddit_source_map',  // Этап 1
  'pain_map',           // Этап 2
  'language_map',       // Этап 3
  'emerging_map',       // Этап 4
  'priority_matrix',    // Этап 5
  'cluster_architecture', // Этап 6
  'quality_control',
  'handoff_flags',
]);

// Какой top-level ключ становится «готов» после какого этапа — для валидации
// прогресса пайплайна и понятных warnings.
const STAGE_OUTPUT_KEY = Object.freeze({
  stage0: 'project_meta',
  stage1: 'reddit_source_map',
  stage2: 'pain_map',
  stage3: 'language_map',
  stage4: 'emerging_map',
  stage5: 'priority_matrix',
  stage6: 'cluster_architecture',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function createEmptyMaster() {
  return {
    system_version: SYSTEM_VERSION,
    workflow_mode: {},
    project_meta: {},
    site_input: {},
    research_scope: {},
    reddit_source_map: {},
    pain_map: {},
    language_map: {},
    emerging_map: {},
    priority_matrix: {},
    cluster_architecture: {},
    quality_control: {},
    handoff_flags: {},
  };
}

/**
 * normalizeStageOutput — приводит ответ LLM (строка/обёрнутый объект) к
 * чистому объекту master-совместимой формы.
 *
 * Допускает форматы:
 *   - уже распарсенный объект;
 *   - JSON-строку (в т.ч. с ```json fences);
 *   - { master_json: {...} } / { master: {...} } / { output: {...} } обёртки.
 */
function normalizeStageOutput(raw) {
  let obj = raw;

  if (typeof obj === 'string') {
    obj = _safeParseJson(obj);
  }
  if (!isPlainObject(obj)) return {};

  // Разворачиваем типовые обёртки, если внутри лежит master-совместимый объект.
  for (const wrapper of ['master_json', 'master', 'output', 'result', 'data']) {
    if (isPlainObject(obj[wrapper]) && _looksLikeMaster(obj[wrapper])) {
      obj = obj[wrapper];
      break;
    }
  }
  return obj;
}

function _looksLikeMaster(obj) {
  if (!isPlainObject(obj)) return false;
  return MASTER_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function _safeParseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // Снимаем markdown-fences ```json ... ```
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(body);
  } catch (_e) {
    // Последняя попытка — вырезать от первой { до последней }.
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(body.slice(first, last + 1)); } catch (_e2) { /* fallthrough */ }
    }
    return null;
  }
}

/**
 * _isEmptyValue — пустое ли значение «по смыслу» (для безопасного merge):
 * null/undefined/'' / [] / {}.
 */
function _isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * _deepMergePreferNonEmpty — рекурсивный merge: значение из `next` перекрывает
 * `prev`, НО пустое значение из `next` не затирает непустое из `prev`. Так этап,
 * который случайно вернул урезанный master, не уничтожает работу прошлых этапов.
 */
function _deepMergePreferNonEmpty(prev, next) {
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out = { ...prev };
    for (const key of Object.keys(next)) {
      const nv = next[key];
      if (key in out) {
        out[key] = _deepMergePreferNonEmpty(out[key], nv);
      } else {
        out[key] = nv;
      }
    }
    return out;
  }
  // Не-объекты: берём next, если он непустой; иначе сохраняем prev.
  if (_isEmptyValue(next)) return _isEmptyValue(prev) ? next : prev;
  return next;
}

/**
 * mergeMasterJson — вливает выход одного этапа в накопительный master.
 * Возвращает НОВЫЙ объект (исходные не мутируются).
 */
function mergeMasterJson(prevMaster, stageOutput) {
  const base = isPlainObject(prevMaster) ? prevMaster : createEmptyMaster();
  const incoming = normalizeStageOutput(stageOutput);
  const merged = _deepMergePreferNonEmpty(base, incoming);
  // system_version всегда фиксирован.
  merged.system_version = SYSTEM_VERSION;
  return merged;
}

/**
 * validateMaster — структурная проверка. Не бросает: возвращает
 * { ok, missingKeys, warnings, readyStages }.
 */
function validateMaster(master) {
  const warnings = [];
  if (!isPlainObject(master)) {
    return { ok: false, missingKeys: MASTER_KEYS.slice(), warnings: ['master не объект'], readyStages: [] };
  }
  const missingKeys = MASTER_KEYS.filter((k) => !(k in master));
  for (const k of missingKeys) warnings.push(`отсутствует ключ "${k}"`);

  if (master.system_version && master.system_version !== SYSTEM_VERSION) {
    warnings.push(`system_version="${master.system_version}" (ожидался "${SYSTEM_VERSION}")`);
  }

  // Какие этапы реально дали наполнение.
  const readyStages = [];
  for (const [stage, key] of Object.entries(STAGE_OUTPUT_KEY)) {
    if (!_isEmptyValue(master[key])) readyStages.push(stage);
  }

  return {
    ok: missingKeys.length === 0,
    missingKeys,
    warnings,
    readyStages,
  };
}

// ── Research digest для infoArticle knowledge base (§10) ──────────────

function _asArray(v) {
  return Array.isArray(v) ? v : [];
}

function _pickStrings(items, fields, limit) {
  const out = [];
  for (const it of _asArray(items)) {
    if (out.length >= limit) break;
    if (typeof it === 'string') {
      if (it.trim()) out.push(it.trim());
      continue;
    }
    if (!isPlainObject(it)) continue;
    for (const f of fields) {
      const val = it[f];
      if (typeof val === 'string' && val.trim()) { out.push(val.trim()); break; }
    }
  }
  return out;
}

/**
 * buildResearchDigest — компактная, machine- и LLM-дружелюбная выжимка
 * «голоса аудитории» из master JSON. Это и есть Information-Gain топливо для
 * статьи: реальные боли, возражения, язык, вопросы, приоритетные темы.
 *
 * Все списки жёстко ограничены, чтобы не раздувать knowledge base.
 */
function buildResearchDigest(master, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 12;
  const m = isPlainObject(master) ? master : {};
  const pain = isPlainObject(m.pain_map) ? m.pain_map : {};
  const lang = isPlainObject(m.language_map) ? m.language_map : {};
  const emerging = isPlainObject(m.emerging_map) ? m.emerging_map : {};
  const prio = isPlainObject(m.priority_matrix) ? m.priority_matrix : {};

  const digest = {
    system_version: SYSTEM_VERSION,
    core_pains:          _pickStrings(pain.core_pains, ['label', 'description'], limit),
    objections:          _pickStrings(pain.objections, ['label', 'description'], limit),
    frictions:           _pickStrings(pain.frictions, ['label', 'description'], limit),
    desired_outcomes:    _pickStrings(pain.desired_outcomes, ['label', 'description'], limit),
    audience_phrases:    _pickStrings(lang.phrases, ['label', 'pattern'], limit),
    question_patterns:   _pickStrings(lang.question_patterns, ['label', 'pattern'], limit),
    comparison_language: _pickStrings(lang.comparison_language, ['label', 'pattern'], limit),
    trust_language:      _pickStrings(lang.trust_language, ['label', 'pattern'], limit),
    emerging_signals:    _pickStrings(emerging.emerging_signals || emerging.signals, ['label', 'pattern', 'interpretation'], limit),
    must_cover_topics:   _pickStrings(prio.must_cover, ['label', 'why_prioritized'], limit),
    should_cover_topics: _pickStrings(prio.should_cover, ['label', 'why_prioritized'], limit),
  };

  // Сводный флаг: есть ли вообще полезная нагрузка (иначе §10 не рендерится).
  digest.has_signal = Object.keys(digest).some(
    (k) => Array.isArray(digest[k]) && digest[k].length > 0,
  );
  return digest;
}

/**
 * renderResearchDigestMarkdown — markdown-рендер дайджеста для knowledge base.
 * Возвращает '' если сигнала нет (graceful).
 */
function renderResearchDigestMarkdown(digest) {
  const d = isPlainObject(digest) ? digest : {};
  if (!d.has_signal) return '';

  const blocks = [];
  const add = (title, arr, n) => {
    const list = _asArray(arr).slice(0, n);
    if (list.length) {
      blocks.push(`### ${title}\n${list.map((x) => `- ${x}`).join('\n')}`);
    }
  };

  add('Боли аудитории (core pains)', d.core_pains, 10);
  add('Возражения / сомнения', d.objections, 8);
  add('Трения и барьеры', d.frictions, 6);
  add('Желаемые результаты (desired outcomes)', d.desired_outcomes, 6);
  add('Реальный язык аудитории (фразы)', d.audience_phrases, 10);
  add('Типовые вопросы (под FAQ / H2)', d.question_patterns, 10);
  add('Язык сравнения / выбора', d.comparison_language, 6);
  add('Язык доверия / недоверия', d.trust_language, 6);
  add('Ранние сдвиги и новые сигналы', d.emerging_signals, 6);
  add('Приоритетные темы (must cover)', d.must_cover_topics, 8);
  add('Темы второго приоритета (should cover)', d.should_cover_topics, 6);

  if (!blocks.length) return '';
  return blocks.join('\n\n');
}

module.exports = {
  SYSTEM_VERSION,
  MASTER_KEYS,
  STAGE_OUTPUT_KEY,
  createEmptyMaster,
  normalizeStageOutput,
  mergeMasterJson,
  validateMaster,
  buildResearchDigest,
  renderResearchDigestMarkdown,
  // экспортируем helpers для unit-тестов
  _isEmptyValue,
  _deepMergePreferNonEmpty,
  _safeParseJson,
};
