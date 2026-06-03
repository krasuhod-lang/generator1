'use strict';

/**
 * projects/leadContext.js — извлекает «контекст проекта» для префилла формы
 * инструмента «Lead-text + Фасетный SEO-оптимизатор».
 *
 * Цель: когда пользователь выбирает GSC-проект на странице Lead-text,
 * автоматически подтягивать всё, что уже посчитано в последнем успешном
 * `project_analyses` (commercial / brandSplit / page_decay), плюс
 * базовые поля проекта (`url`, `audience_description`, `name`).
 *
 * Возвращает компактный объект (без сырых снапшотов на сотни KB) — фронт
 * использует его для аккуратного префилла «только если поле пустое».
 *
 * Тестируется чистой функцией `buildLeadContextFromAnalysis(...)` без БД.
 */

const { deriveBrandTokens } = require('./commercialIntent');

const DEFAULT_LIMITS = Object.freeze({
  maxQuestions: 12,
  maxSemanticCore: 50,
  maxSampleQueriesPerCluster: 4,
});

function _str(v, max = 1000) {
  if (v == null) return '';
  return String(v).slice(0, max).trim();
}

function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Превращает распиленный snapshot последнего успешного анализа в:
 *   {
 *     suggested_questions:   [string, ...]   // боли/интенты для form.questions
 *     suggested_core:        [string, ...]   // топ-запросы для form.semantic_core
 *     brand_tokens:          [string, ...]   // объединённые brand-токены
 *     intent_distribution:   [{intent,queries,clicks,clicksPct}]  // для UI-бейджа
 *   }
 *
 * Источники (в порядке приоритета):
 *   - snapshot.commercial.cannibalization     → острые «проблемные» запросы
 *   - snapshot.commercial.striking_distance    → запросы 11-20 поз. (потенциал)
 *   - snapshot.commercial.ctr_anomalies        → запросы со «слабым» CTR
 *   - snapshot.top_queries                     → семантическое ядро
 *   - snapshot.brand_split.brand_tokens / commercial.brand_tokens → расширение brand
 *
 * Все источники graceful: если каких-то срезов нет — просто пропускаем.
 */
function buildLeadContextFromAnalysis({ project = {}, analysis = null, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };

  const baseTokens = deriveBrandTokens({
    name: project.name,
    siteUrl: project.gsc_site_url,
    url: project.url,
  }) || [];
  const tokens = new Set(baseTokens.map((t) => String(t).toLowerCase()));

  const questions = [];
  const seenQuestions = new Set();
  function pushQuestion(q) {
    const s = _str(q, 200);
    if (!s) return;
    const key = s.toLowerCase();
    if (seenQuestions.has(key)) return;
    seenQuestions.add(key);
    questions.push(s);
  }

  const core = [];
  const seenCore = new Set();
  function pushCore(q) {
    const s = _str(q, 200);
    if (!s) return;
    const key = s.toLowerCase();
    if (seenCore.has(key)) return;
    seenCore.add(key);
    core.push(s);
  }

  let intentDistribution = [];
  const snapshot = (analysis && _isObj(analysis.gsc_snapshot)) ? analysis.gsc_snapshot : null;

  if (snapshot) {
    // 1) brand-tokens из brand_split / commercial.brand_tokens — расширяем.
    const bs = _isObj(snapshot.brand_split) ? snapshot.brand_split : null;
    if (bs && Array.isArray(bs.brand_tokens)) {
      for (const t of bs.brand_tokens) {
        const s = String(t || '').toLowerCase().trim();
        if (s) tokens.add(s);
      }
    }
    const commercial = _isObj(snapshot.commercial) ? snapshot.commercial : null;
    if (commercial && Array.isArray(commercial.brand_tokens)) {
      for (const t of commercial.brand_tokens) {
        const s = String(t || '').toLowerCase().trim();
        if (s) tokens.add(s);
      }
    }

    // 2) Вопросы из commercial-среза (наиболее «болевые»).
    if (commercial) {
      const sd = Array.isArray(commercial.striking_distance) ? commercial.striking_distance : [];
      for (const r of sd.slice(0, lim.maxQuestions)) {
        if (r) pushQuestion(r.query || r.key);
      }
      const ctrAnom = Array.isArray(commercial.ctr_anomalies) ? commercial.ctr_anomalies : [];
      for (const r of ctrAnom.slice(0, lim.maxQuestions)) {
        if (r) pushQuestion(r.query || r.key);
      }
      const cann = Array.isArray(commercial.cannibalization) ? commercial.cannibalization : [];
      for (const r of cann.slice(0, lim.maxQuestions)) {
        if (r) pushQuestion(r.query || r.key);
      }
      if (Array.isArray(commercial.intent_distribution)) {
        intentDistribution = commercial.intent_distribution.slice(0, 8).map((b) => ({
          intent: _str(b && b.intent, 40),
          queries: Number(b && b.queries) || 0,
          clicks: Number(b && b.clicks) || 0,
          clicks_pct: Number(b && (b.clicksPct ?? b.clicks_pct)) || 0,
        }));
      }
    }

    // 3) Семантическое ядро — top_queries по показам.
    const tq = Array.isArray(snapshot.top_queries) ? snapshot.top_queries : [];
    const sortedTq = [...tq].sort((a, b) => (Number(b && b.impressions) || 0) - (Number(a && a.impressions) || 0));
    for (const r of sortedTq.slice(0, lim.maxSemanticCore)) {
      if (r) pushCore(r.key || r.query);
    }
  }

  return {
    suggested_questions: questions.slice(0, lim.maxQuestions),
    suggested_core: core.slice(0, lim.maxSemanticCore),
    brand_tokens: [...tokens],
    intent_distribution: intentDistribution,
    source_analysis_id: analysis ? (analysis.id || null) : null,
    source_analysis_completed_at: analysis ? (analysis.completed_at || null) : null,
  };
}

/**
 * buildLeadContext — высокоуровневая сборка для контроллера.
 *
 * @param {object} db — pg-клиент (с методом query)
 * @param {object} project — строка из таблицы projects (как минимум id/name/url/audience_description/gsc_site_url/gsc_connected)
 * @param {object} [opts]
 * @returns {Promise<object>}  payload для GET /api/projects/:id/lead-context
 */
async function buildLeadContext(db, project, opts = {}) {
  if (!project || !project.id) {
    return { project: null, context: null, has_analysis: false };
  }

  let analysis = null;
  try {
    const { rows } = await db.query(
      `SELECT id, gsc_snapshot, completed_at
         FROM project_analyses
        WHERE project_id = $1 AND status = 'done'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1`,
      [project.id],
    );
    analysis = rows[0] || null;
  } catch (_e) {
    analysis = null;
  }

  const context = buildLeadContextFromAnalysis({ project, analysis, limits: opts.limits });

  return {
    project: {
      id: project.id,
      name: project.name || '',
      url: project.url || '',
      audience_description: project.audience_description || '',
      gsc_connected: !!project.gsc_connected,
      gsc_site_url: project.gsc_site_url || '',
    },
    context,
    has_analysis: !!analysis,
  };
}

module.exports = {
  buildLeadContext,
  buildLeadContextFromAnalysis,
  DEFAULT_LIMITS,
};
