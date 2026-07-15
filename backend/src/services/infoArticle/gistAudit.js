'use strict';

/**
 * GIST Stage 5C helpers — нормализация аудита покрытия information_delta.
 * Чистые функции экспортируются для unit-тестов без LLM/HTTP.
 */

function _normCoverage(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'yes' || v === 'covered' || v === 'да') return 'yes';
  if (v === 'partial' || v === 'partly' || v === 'частично') return 'partial';
  if (v === 'no' || v === 'missing' || v === 'нет') return 'no';
  return 'no';
}

function computeGistCoverageScore(thesisCoverage) {
  const items = Array.isArray(thesisCoverage) ? thesisCoverage : [];
  if (!items.length) return 100;
  let points = 0;
  for (const item of items) {
    const coverage = _normCoverage(item && (item.coverage || item.status || item.covered));
    if (coverage === 'yes') points += 1;
    else if (coverage === 'partial') points += 0.5;
  }
  return Math.round((points / items.length) * 1000) / 10;
}

function normalizeGistAuditReport(raw, informationDelta = []) {
  const report = raw && typeof raw === 'object' ? raw : {};
  const thesisCoverage = Array.isArray(report.thesis_coverage)
    ? report.thesis_coverage
    : (Array.isArray(report.information_delta_coverage) ? report.information_delta_coverage : []);
  const sectionAudit = Array.isArray(report.section_audit)
    ? report.section_audit
    : (Array.isArray(report.sections) ? report.sections : []);
  const needsRewrite = Array.isArray(report.needs_rewrite) ? report.needs_rewrite : [];
  const score = Number(report.gist_coverage_score);
  return {
    thesis_coverage: thesisCoverage.map((it, idx) => ({
      thesis: String(it && (it.thesis || it.claim) || informationDelta[idx] || '').slice(0, 500),
      coverage: _normCoverage(it && (it.coverage || it.status || it.covered)),
      evidence: String(it && (it.evidence || it.where || it.comment) || '').slice(0, 500),
    })),
    section_audit: sectionAudit.map((it) => ({
      section_index: it && (it.section_index ?? it.index ?? null),
      h2: String(it && (it.h2 || it.section_h2 || it.title) || '').slice(0, 240),
      gist_redundancy: _normRedundancy(it && (it.gist_redundancy || it.redundancy)),
      reason: String(it && (it.reason || it.comment) || '').slice(0, 500),
    })),
    gist_coverage_score: Number.isFinite(score)
      ? Math.max(0, Math.min(100, Math.round(score * 10) / 10))
      : computeGistCoverageScore(thesisCoverage),
    needs_rewrite: needsRewrite.map((it) => ({
      section_index: it && (it.section_index ?? it.index ?? null),
      h2: String(it && (it.h2 || it.title || '')).slice(0, 240),
      reason: String(it && (it.reason || it.problem || it) || '').slice(0, 500),
    })),
  };
}

function _normRedundancy(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'high' || v === 'высокая') return 'high';
  if (v === 'medium' || v === 'средняя') return 'medium';
  return 'low';
}

function buildGistRewriteIssues(auditReport) {
  const report = auditReport && typeof auditReport === 'object' ? auditReport : {};
  const highSections = (Array.isArray(report.section_audit) ? report.section_audit : [])
    .filter((s) => s.gist_redundancy === 'high')
    .map((s) => ({
      section_index: s.section_index,
      h2: s.h2,
      reason: s.reason || 'секция повторяет общий шум конкурентов и не раскрывает GIST-дельту',
    }));
  const needs = Array.isArray(report.needs_rewrite) ? report.needs_rewrite : [];
  const merged = [...needs, ...highSections];
  const seen = new Set();
  return merged.filter((it) => {
    const key = `${it.section_index || ''}|${it.h2 || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8).map((it) => ({
    severity: 'major',
    category: 'gist_delta',
    where: it.section_index != null ? `H2 #${it.section_index}` : (it.h2 || 'section'),
    problem: it.reason || 'GIST-дельта раскрыта слабо или секция слишком похожа на конкурентов',
    fix_instruction: 'Перепиши блок вокруг тезисов §11 GIST Delta: добавь конкретный факт/сценарий/пример/сравнение или перечень ошибок, убери общие определения.',
  }));
}

module.exports = {
  computeGistCoverageScore,
  normalizeGistAuditReport,
  buildGistRewriteIssues,
  _normCoverage,
};
