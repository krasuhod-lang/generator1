'use strict';

/**
 * qualityCore/collectArtifacts — тонкий адаптер сбора артефактов (V1, Фаза 3).
 *
 * Каждый из трёх пайплайнов (seo / link / info) хранит свои отчёты качества
 * в собственной схеме (percent vs ratio, разные имена полей, LLM-evaluator
 * вместо явного risk-объекта). Чтобы НЕ дублировать маппинг «сырой отчёт →
 * контракт finalize()» в трёх местах, вся нормализация собрана здесь.
 *
 * Ключевые нормализации:
 *   • plagiarism: infoArticle/plagiarism.service отдаёт summary.overlapPctTotal
 *     в ПРОЦЕНТАХ (0..100), а checkPlagiarism сравнивает near-duplicate RATIO
 *     (0..1) с thresholds.plagiarismMaxRatio → делим на 100.
 *   • fact-check: summary.supportedPct (проценты) → factReport.confidence (0..1).
 *   • risk: SEO Stage 8 evaluator отдаёт regulatory_risks[{severity}] — сводим
 *     к { level, issues } для checkRisk.
 *
 * Отсутствующие отчёты просто не попадают в результат — соответствующий
 * checker в finalize() тогда пропускается (не даёт ложных блокировок).
 *
 * Модуль чистый: без БД, без сети, без побочных эффектов.
 */

const SEVERITY_TO_LEVEL = { low: 'low', medium: 'medium', high: 'high', critical: 'critical' };
const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * riskFromEvaluator — свести Stage 8 evaluator_report к { level, issues }.
 * @param {object} evaluator — отчёт stage8 (regulatory_risks[], issues[])
 * @returns {{ level:string, issues:string[] }|null}
 */
function riskFromEvaluator(evaluator) {
  if (!evaluator || typeof evaluator !== 'object') return null;
  const regs = Array.isArray(evaluator.regulatory_risks) ? evaluator.regulatory_risks : [];
  if (!regs.length) {
    // Нет регуляторных рисков — явный «none», чтобы checkRisk был информативен.
    return { level: 'none', issues: [] };
  }
  let maxLevel = 'none';
  const issues = [];
  for (const r of regs) {
    const sev = SEVERITY_TO_LEVEL[String(r && r.severity || '').toLowerCase()] || 'low';
    if ((RISK_ORDER[sev] || 0) > (RISK_ORDER[maxLevel] || 0)) maxLevel = sev;
    if (r && r.risk) issues.push(String(r.risk));
  }
  return { level: maxLevel, issues };
}

/**
 * collectArtifacts — нормализовать «сырые» пайплайн-отчёты в контракт finalize().
 *
 * @param {string} pipeline — 'seo' | 'link' | 'info' (влияет только на трактовку
 *                            evaluatorReport как источника risk).
 * @param {object} raw — сырые данные пайплайна. Поддерживаемые ключи:
 *   { html, niche, currentYear, ymyl,
 *     plagiarismReport, factReport, intentReport, lsiOverdoseReport,
 *     links, riskReport, evaluatorReport, authorship, informationGainBrief }
 * @returns {object} artifacts для qualityGate.finalize()
 */
function collectArtifacts(pipeline, raw = {}) {
  const out = {};

  if (typeof raw.html === 'string' && raw.html) out.html = raw.html;
  if (raw.niche) out.niche = raw.niche;
  if (raw.currentYear) out.currentYear = raw.currentYear;
  if (typeof raw.ymyl === 'boolean') out.ymyl = raw.ymyl;

  // ── Plagiarism: percent → ratio ─────────────────────────────────────
  const plag = raw.plagiarismReport;
  if (plag && plag.summary && typeof plag.summary === 'object') {
    const pct = _num(plag.summary.overlapPctTotal);
    if (pct != null && plag.summary.nearDuplicateRatio == null) {
      out.plagiarismReport = {
        ...plag,
        summary: { ...plag.summary, nearDuplicateRatio: pct / 100 },
      };
    } else {
      out.plagiarismReport = plag;
    }
  } else if (plag) {
    out.plagiarismReport = plag;
  }

  // ── Fact-check: supportedPct → confidence ratio ─────────────────────
  const fc = raw.factReport;
  if (fc && fc.summary && typeof fc.summary === 'object') {
    const pct = _num(fc.summary.supportedPct);
    if (pct != null && fc.confidence == null) {
      out.factReport = { ...fc, confidence: pct / 100 };
    } else {
      out.factReport = fc;
    }
  } else if (fc) {
    out.factReport = fc;
  }

  // ── Pass-through отчёты (checkers уже понимают их схему) ─────────────
  if (raw.intentReport) out.intentReport = raw.intentReport;
  if (raw.lsiOverdoseReport) out.lsiOverdoseReport = raw.lsiOverdoseReport;
  if (Array.isArray(raw.links)) out.links = raw.links;
  if (raw.authorship) out.authorship = raw.authorship;
  if (raw.informationGainBrief) out.informationGainBrief = raw.informationGainBrief;

  // ── Risk: явный riskReport приоритетнее, иначе — из Stage 8 evaluator ─
  if (raw.riskReport) {
    out.riskReport = raw.riskReport;
  } else if (raw.evaluatorReport) {
    const risk = riskFromEvaluator(raw.evaluatorReport);
    if (risk) out.riskReport = risk;
  }

  return out;
}

module.exports = { collectArtifacts, riskFromEvaluator, _internal: { RISK_ORDER } };
