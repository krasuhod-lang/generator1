'use strict';

const crypto = require('crypto');
const dbDefault = require('../../config/db');

const MODULE_CONFIG = Object.freeze({
  striking_distance: {
    category: 'striking_distance',
    title: (item) => `Запрос «${item.query || item.keyword || 'без названия'}» близок к ТОП-10`,
    target: (item) => ({ query: item.query || item.keyword || null, url: item.url || item.landing_page || null }),
    successMetric: 'Позиция запроса и клики по нему за следующий полный период',
    recommendation: 'Усилить релевантную страницу: закрыть интент, расширить доказательные блоки и улучшить внутреннюю перелинковку.',
  },
  ctr_gap: {
    category: 'ctr_gap',
    title: (item) => `Низкий CTR страницы${item.url ? `: ${item.url}` : ''}`,
    target: (item) => ({ url: item.url || null, query: item.query || null }),
    successMetric: 'CTR и клики страницы при сопоставимых показах в следующем периоде',
    recommendation: 'Проверить соответствие title/description интенту и переработать сниппет на основе фактов страницы.',
  },
  content_health: {
    category: 'content',
    title: (item) => `Контент требует доработки${item.url ? `: ${item.url}` : ''}`,
    target: (item) => ({ url: item.url || null }),
    successMetric: 'Органические клики, CTR и покрытие целевой семантики после обновления',
    recommendation: 'Сопоставить страницу с интентом, устранить content gaps и проверить E-E-A-T/evidence блоки.',
  },
  off_page: {
    category: 'off_page',
    title: (item) => `Ссылочный профиль требует проверки${item.url ? `: ${item.url}` : ''}`,
    target: (item) => ({ url: item.url || null, donor_domain: item.donor_domain || null }),
    successMetric: 'Количество валидных доноров и индексируемых ссылок после исправлений',
    recommendation: 'Проверить битые ссылки, индексацию доноров и тематическое соответствие площадок.',
  },
  tech_audit: {
    category: 'technical',
    title: (item) => `Техническая проблема страницы${item.url ? `: ${item.url}` : ''}`,
    target: (item) => ({ url: item.url || null }),
    successMetric: 'HTTP/technical status и повторный audit pass после исправления',
    recommendation: 'Исправить техническую причину и подтвердить результат повторным аудитом, а не предположением.',
  },
});

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableKey(category, item, index) {
  const target = [
    item.query,
    item.keyword,
    item.url,
    item.landing_page,
    item.donor_domain,
    item.id,
  ].filter(Boolean).join('|') || String(index);
  return `${category}:${crypto.createHash('sha1').update(target).digest('hex').slice(0, 20)}`;
}

function inferPriority(item, summary = {}) {
  const explicit = String(item.priority || '').toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(explicit)) return explicit;
  const impact = safeNumber(
    item.opportunity_clicks ?? item.total_opportunity_clicks ?? item.lost_clicks ?? item.impressions,
  );
  if (impact != null && impact >= 1000) return 'high';
  if (impact != null && impact >= 100) return 'medium';
  if (summary.critical || item.critical) return 'high';
  return 'medium';
}

function priorityScore(item, summary = {}) {
  const values = [
    safeNumber(item.priority_score),
    safeNumber(item.opportunity_clicks),
    safeNumber(item.total_opportunity_clicks),
    safeNumber(item.lost_clicks),
    safeNumber(item.impressions),
  ].filter((value) => value != null);
  const value = values[0] || 0;
  return Math.min(100, Math.max(0, Number(value) ? Math.log10(Number(value) + 1) * 20 : (summary.critical ? 70 : 40)));
}

function candidateFromItem(moduleName, item, index, context = {}) {
  const config = MODULE_CONFIG[moduleName];
  if (!config || !item || typeof item !== 'object') return null;
  const category = config.category;
  const priority = inferPriority(item, context.summary || {});
  const target = config.target(item);
  const observedFact = item.client_safe_summary || item.reason || item.issue || item.description || null;
  const evidence = [{
    source: context.source || 'project_analysis',
    module: moduleName,
    url: target.url || null,
    query: target.query || null,
    observed_at: context.observedAt || new Date().toISOString(),
    fact: observedFact,
    metrics: Object.fromEntries(Object.entries(item).filter(([key, value]) => (
      ['position', 'clicks', 'impressions', 'ctr', 'lost_clicks', 'opportunity_clicks', 'score', 'http_status'].includes(key)
      && value !== undefined && value !== null
    ))),
  }];
  return {
    opportunityKey: stableKey(category, item, index),
    category,
    priority,
    priorityScore: priorityScore(item, context.summary || {}),
    title: config.title(item),
    target,
    currentMetric: Object.fromEntries(Object.entries(item).filter(([key, value]) => (
      ['position', 'clicks', 'impressions', 'ctr', 'lost_clicks', 'opportunity_clicks', 'score', 'http_status'].includes(key)
      && value !== undefined && value !== null
    ))),
    targetMetric: {},
    impact: {
      opportunity_clicks: safeNumber(item.opportunity_clicks ?? item.total_opportunity_clicks),
      lost_clicks: safeNumber(item.lost_clicks),
      impressions: safeNumber(item.impressions),
    },
    effort: item.effort || null,
    confidence: safeNumber(item.confidence) ?? (observedFact ? 0.8 : 0.6),
    observedFact,
    hypothesis: item.hypothesis || null,
    recommendation: item.recommendation || config.recommendation,
    successMetric: item.success_metric || config.successMetric,
    evidence,
    targetUrl: target.url || null,
  };
}

function normalizeOpportunities(modules = {}, context = {}) {
  const output = [];
  for (const [moduleName, config] of Object.entries(MODULE_CONFIG)) {
    if (!config) continue;
    const module = modules[moduleName];
    const items = Array.isArray(module?.items) ? module.items : [];
    items.forEach((item, index) => {
      const candidate = candidateFromItem(moduleName, item, index, {
        ...context,
        summary: module?.summary || {},
      });
      if (candidate) output.push(candidate);
    });
  }
  return output.sort((a, b) => b.priorityScore - a.priorityScore);
}

async function upsertGrowthOpportunities({ projectId, analysisId = null, snapshotId = null, modules = {}, source = 'report_aggregation', observedAt = null }, database = dbDefault) {
  if (!projectId) return { count: 0, opportunities: [] };
  const opportunities = normalizeOpportunities(modules, { source, observedAt });
  for (const item of opportunities) {
    await database.query(
      `INSERT INTO project_growth_opportunities
        (project_id, analysis_id, snapshot_id, opportunity_key, category, status, priority,
         priority_score, title, target, current_metric, target_metric, impact, effort,
         confidence, observed_fact, hypothesis, recommendation, success_metric, evidence,
         last_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,
               $14,$15,$16,$17,$18,$19::jsonb,NOW(),NOW())
       ON CONFLICT (project_id, opportunity_key) DO UPDATE SET
         analysis_id=COALESCE(EXCLUDED.analysis_id, project_growth_opportunities.analysis_id),
         snapshot_id=COALESCE(EXCLUDED.snapshot_id, project_growth_opportunities.snapshot_id),
         category=EXCLUDED.category,
         priority=EXCLUDED.priority,
         priority_score=EXCLUDED.priority_score,
         title=EXCLUDED.title,
         target=EXCLUDED.target,
         current_metric=EXCLUDED.current_metric,
         target_metric=EXCLUDED.target_metric,
         impact=EXCLUDED.impact,
         effort=EXCLUDED.effort,
         confidence=EXCLUDED.confidence,
         observed_fact=EXCLUDED.observed_fact,
         hypothesis=EXCLUDED.hypothesis,
         recommendation=EXCLUDED.recommendation,
         success_metric=EXCLUDED.success_metric,
         evidence=EXCLUDED.evidence,
         status=CASE WHEN project_growth_opportunities.status='resolved' THEN 'open' ELSE project_growth_opportunities.status END,
         last_seen_at=NOW(), updated_at=NOW()`,
      [
        projectId,
        analysisId,
        snapshotId,
        item.opportunityKey,
        item.category,
        item.priority,
        item.priorityScore,
        item.title,
        JSON.stringify(item.target),
        JSON.stringify(item.currentMetric),
        JSON.stringify(item.targetMetric),
        JSON.stringify(item.impact),
        item.effort,
        item.confidence,
        item.observedFact,
        item.hypothesis,
        item.recommendation,
        item.successMetric,
        JSON.stringify(item.evidence),
      ],
    );
  }
  return { count: opportunities.length, opportunities };
}

async function resolveOwnedOpportunityId(opportunityId, projectId, database = dbDefault) {
  if (!opportunityId || !projectId) return null;
  const { rows } = await database.query(
    `SELECT id FROM project_growth_opportunities
      WHERE id=$1 AND project_id=$2`,
    [opportunityId, projectId],
  );
  return rows[0]?.id || null;
}

async function listGrowthOpportunities(projectId, options = {}, database = dbDefault) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
  const status = options.status || 'open';
  const params = [projectId];
  let statusClause = '';
  if (status !== 'all') {
    params.push(status);
    statusClause = ` AND status=$${params.length}`;
  }
  params.push(limit);
  const { rows } = await database.query(
    `SELECT * FROM project_growth_opportunities
      WHERE project_id=$1${statusClause}
      ORDER BY priority_score DESC NULLS LAST, updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function updateGrowthOpportunity(opportunityId, patch = {}, database = dbDefault) {
  const allowed = {
    status: ['open', 'in_progress', 'blocked', 'resolved'],
    priority: ['critical', 'high', 'medium', 'low'],
  };
  const sets = [];
  const values = [opportunityId];
  let index = 2;
  for (const key of Object.keys(allowed)) {
    if (patch[key] !== undefined && allowed[key].includes(String(patch[key]))) {
      sets.push(`${key}=$${index++}`);
      values.push(String(patch[key]));
    }
  }
  for (const [key, type] of [['measurement', 'jsonb'], ['next_check_at', 'date']]) {
    if (patch[key] !== undefined) {
      sets.push(`${key}=$${index++}${type === 'jsonb' ? '::jsonb' : ''}`);
      values.push(type === 'jsonb' ? JSON.stringify(patch[key] || {}) : patch[key]);
    }
  }
  if (patch.status === 'resolved') sets.push('resolved_at=COALESCE(resolved_at,NOW()), measured_at=COALESCE(measured_at,NOW())');
  if (!sets.length) return null;
  sets.push('updated_at=NOW()');
  const { rows } = await database.query(
    `UPDATE project_growth_opportunities SET ${sets.join(', ')} WHERE id=$1 RETURNING *`,
    values,
  );
  return rows[0] || null;
}

async function linkGrowthOpportunityTask(opportunityId, taskId, projectId, database = dbDefault) {
  const task = await database.query(
    `UPDATE tasks_auto_log SET opportunity_id=$1
      WHERE id=$2 AND project_id=$3
      RETURNING id, project_id, title, task_type`,
    [opportunityId, taskId, projectId],
  );
  if (!task.rows[0]) return null;
  const { rows } = await database.query(
    `UPDATE project_growth_opportunities
        SET linked_task_ids = (
          SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value), '[]'::jsonb)
            FROM (
              SELECT DISTINCT value
                FROM jsonb_array_elements_text(COALESCE(linked_task_ids, '[]'::jsonb) || jsonb_build_array($2::text)) AS elements(value)
            ) deduped
        ), updated_at=NOW()
      WHERE id=$1
      RETURNING *`,
    [opportunityId, String(taskId)],
  );
  return rows[0] ? { opportunity: rows[0], task: task.rows[0] } : null;
}

module.exports = {
  normalizeOpportunities,
  upsertGrowthOpportunities,
  listGrowthOpportunities,
  resolveOwnedOpportunityId,
  updateGrowthOpportunity,
  linkGrowthOpportunityTask,
};
