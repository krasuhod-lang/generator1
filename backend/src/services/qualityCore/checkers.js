'use strict';

/**
 * qualityCore/checkers.js — единый набор ЧИСТЫХ функций-проверок (V1).
 *
 * Каждый checker принимает уже собранные артефакты (HTML, готовые отчёты
 * fact-check/plagiarism/intent/lsi/risk, link_plan) и возвращает
 * нормализованный вердикт единого вида:
 *
 *   { name, pass, blocking, score, verdict, evidence }
 *
 * Ключевая идея: checkers НЕ вызывают LLM и НЕ ходят в БД — вся тяжёлая
 * работа (fact-check, plagiarism-index, intent detection) уже сделана
 * существующими сервисами (infoArticle/*), а здесь мы лишь применяем
 * единые пороги и решаем blocking/не-blocking. Это убирает дубляж логики
 * «что считать провалом» между тремя пайплайнами и делает всё тестируемым
 * без сети.
 *
 * `blocking=true` означает: при этом вердикте нельзя финализировать/публиковать.
 */

const contentPolicy = require('../contentPolicy');

/** Утилита: strip HTML → плоский текст в нижнем регистре. */
function _plainLower(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
}

function _verdict(name, { pass, blocking = false, score = null, verdict = null, evidence = {} }) {
  return { name, pass: !!pass, blocking: !!(blocking && !pass), score, verdict, evidence };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Freshness / current-year policy (V6 FR5)
//    Блокирующим НЕ является (косметика), но выдаёт warning, если статья
//    заявляет устаревшую дату «обновлено» или ссылается только на старые годы.
// ─────────────────────────────────────────────────────────────────────
function checkFreshness(html, { currentYear = new Date().getFullYear(), thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const text = _plainLower(html);
  const years = (text.match(/\b(20\d{2})\b/g) || []).map(Number);
  const maxYear = years.length ? Math.max(...years) : null;

  // Явное заявление устаревшей актуальности: «обновлено … 2021», «актуально на 2020».
  const staleClaim = /(обновлен[оа]?|актуальн[оаы].{0,12}на|дата обновления)[^0-9]{0,20}(20\d{2})/i.exec(String(html || ''));
  const staleClaimYear = staleClaim ? Number(staleClaim[2]) : null;

  const staleByClaim = staleClaimYear != null && (currentYear - staleClaimYear) >= th.freshnessStaleYears;
  const staleByRefs  = maxYear != null && (currentYear - maxYear) >= th.freshnessStaleYears;

  const pass = !staleByClaim && !staleByRefs;
  return _verdict('freshness', {
    pass,
    blocking: false, // freshness — предупреждение, не blocker
    verdict: pass ? 'fresh' : 'stale',
    evidence: { currentYear, maxYearMentioned: maxYear, staleClaimYear, staleByClaim, staleByRefs },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 2. Stop-phrases / anti-water (V4). Источник фраз — реестр политики (V6).
//    Blocking по умолчанию НЕ является (можно включить opts.blocking=true).
// ─────────────────────────────────────────────────────────────────────
function checkStopPhrases(html, { blocking = false, extraPhrases = [] } = {}) {
  const text = _plainLower(html);
  const phrases = contentPolicy._mergeUnique(contentPolicy.getStopPhrasesSync(), extraPhrases);
  const found = phrases.filter((p) => text.includes(String(p).toLowerCase()));
  const pass = found.length === 0;
  return _verdict('stop_phrases', {
    pass,
    blocking,
    score: found.length,
    verdict: pass ? 'clean' : 'water',
    evidence: { found },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 3. Banned formulations (V6). Рискованные обещания/превосходные степени.
//    Blocking по умолчанию TRUE (юридический/репутационный риск).
// ─────────────────────────────────────────────────────────────────────
function checkBannedFormulations(html, { blocking = true, extraPhrases = [] } = {}) {
  const text = _plainLower(html);
  const phrases = contentPolicy._mergeUnique(contentPolicy.getBannedFormulationsSync(), extraPhrases);
  const found = phrases.filter((p) => text.includes(String(p).toLowerCase()));
  const pass = found.length === 0;
  return _verdict('banned_formulations', {
    pass,
    blocking,
    score: found.length,
    verdict: pass ? 'clean' : 'banned',
    evidence: { found },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 4. LSI / keyword overdose (V4). Нормализует verdict из
//    infoArticle/lsiDensity.service.checkLsiOverdose (na|pass|review|fail).
//    Blocking, если verdict совпадает с thresholds.lsiOverdoseBlockVerdict.
// ─────────────────────────────────────────────────────────────────────
function checkLsiOverdose(overdoseReport, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const verdict = overdoseReport && overdoseReport.verdict ? overdoseReport.verdict : 'na';
  const pass = verdict !== 'fail'; // review — не blocking, но не идеально
  const blocking = verdict === th.lsiOverdoseBlockVerdict;
  return _verdict('lsi_overdose', {
    pass,
    blocking,
    verdict,
    score: overdoseReport ? overdoseReport.sections_overdose : null,
    evidence: {
      sections_overdose: overdoseReport ? overdoseReport.sections_overdose : null,
      overspam: overdoseReport ? (overdoseReport.overspam || []).slice(0, 10) : [],
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 5. Plagiarism / near-duplicate (V1). Нормализует отчёт
//    infoArticle/plagiarism.service.runPlagiarismCheck. Blocking, если
//    доля near-dup выше thresholds.plagiarismMaxRatio.
// ─────────────────────────────────────────────────────────────────────
function checkPlagiarism(plagiarismReport, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const summary = (plagiarismReport && plagiarismReport.summary) || {};
  // Ищем долю совпадений в нескольких возможных полях (устойчиво к вариациям схемы).
  const ratio = _firstNumber([
    summary.nearDuplicateRatio, summary.near_duplicate_ratio,
    summary.duplicateRatio, summary.duplicate_ratio,
    summary.matchedRatio, summary.matched_ratio,
    summary.plagiarismRatio, summary.plagiarism_ratio,
  ]);
  if (ratio == null) {
    // Нет данных — не блокируем, но помечаем как не-пройденную проверку данных.
    return _verdict('plagiarism', {
      pass: true, blocking: false, verdict: 'na', score: null,
      evidence: { reason: 'no plagiarism ratio in report' },
    });
  }
  const pass = ratio <= th.plagiarismMaxRatio;
  return _verdict('plagiarism', {
    pass,
    blocking: true,
    score: ratio,
    verdict: pass ? 'original' : 'duplicate',
    evidence: { ratio, threshold: th.plagiarismMaxRatio, topDonors: (plagiarismReport && plagiarismReport.top_donors || []).slice(0, 5) },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 6. Fact confidence (V1). Blocking, если уверенность фактов ниже порога.
// ─────────────────────────────────────────────────────────────────────
function checkFactConfidence(factReport, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const conf = _firstNumber([
    factReport && factReport.confidence,
    factReport && factReport.summary && factReport.summary.confidence,
    factReport && factReport.overall_confidence,
    factReport && factReport.summary && factReport.summary.overall_confidence,
  ]);
  if (conf == null) {
    return _verdict('fact_confidence', {
      pass: true, blocking: false, verdict: 'na', score: null,
      evidence: { reason: 'no confidence in report' },
    });
  }
  const pass = conf >= th.factConfidenceMin;
  return _verdict('fact_confidence', {
    pass,
    blocking: true,
    score: conf,
    verdict: pass ? 'reliable' : 'unreliable',
    evidence: { confidence: conf, threshold: th.factConfidenceMin, unverified: (factReport && factReport.unverified_claims || []).slice(0, 5) },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 7. Intent match (V1). Нормализует infoArticle/intentVerify.verifyIntent.
//    Blocking, если critical mismatch и включена политика.
// ─────────────────────────────────────────────────────────────────────
function checkIntent(intentReport, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  if (!intentReport || intentReport.enabled === false) {
    return _verdict('intent', { pass: true, blocking: false, verdict: 'na', evidence: {} });
  }
  const verdict = intentReport.verdict || 'match';
  const isMismatch = verdict === 'mismatch' || intentReport.mismatch === true;
  const isCritical = intentReport.critical === true;
  const pass = !isMismatch;
  const blocking = th.intentBlockOnMismatch && isCritical;
  return _verdict('intent', {
    pass,
    blocking,
    verdict,
    evidence: {
      article_intent: intentReport.article_intent,
      serp_intent: intentReport.serp_intent,
      critical: isCritical,
      recommendation: intentReport.recommendation,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 8. Link audit (V2 / FR3). Blocking, если в HTML есть ссылка, отсутствующая
//    в плане, битая, noindex/redirect, или конфликтующая с каннибализацией.
//    Принимает нормализованный список ссылок с их состоянием.
//
//    links: [{ href, inPlan, status, indexable, canonicalMatch, cannibalConflict }]
//    (status: 'ok'|'broken'|'redirect'|'unknown')
// ─────────────────────────────────────────────────────────────────────
function checkLinkAudit(links, { requireInPlan = true } = {}) {
  const list = Array.isArray(links) ? links : [];
  const problems = [];
  for (const l of list) {
    const issues = [];
    if (requireInPlan && l.inPlan === false) issues.push('not_in_plan');
    if (l.status === 'broken') issues.push('broken');
    if (l.status === 'redirect') issues.push('redirect');
    if (l.indexable === false) issues.push('noindex');
    if (l.canonicalMatch === false) issues.push('canonical_mismatch');
    if (l.cannibalConflict === true) issues.push('cannibal_conflict');
    if (issues.length) problems.push({ href: l.href, issues });
  }
  const pass = problems.length === 0;
  return _verdict('link_audit', {
    pass,
    blocking: true,
    score: problems.length,
    verdict: pass ? 'valid' : 'invalid_links',
    evidence: { problems: problems.slice(0, 20), totalLinks: list.length },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 9. Risk / compliance (V1, Stage 8). Blocking, если risk-уровень >=
//    thresholds.riskBlockLevel И ниша чувствительная (YMYL).
//    riskReport: { level: 'none'|'low'|'medium'|'high'|'critical', issues:[] }
// ─────────────────────────────────────────────────────────────────────
const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
function checkRisk(riskReport, { thresholds, ymyl = false } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  if (!riskReport) {
    return _verdict('risk', { pass: true, blocking: false, verdict: 'na', evidence: {} });
  }
  const level = riskReport.level || 'none';
  const blockAt = RISK_ORDER[th.riskBlockLevel] != null ? RISK_ORDER[th.riskBlockLevel] : RISK_ORDER.critical;
  const reached = (RISK_ORDER[level] || 0) >= blockAt;
  const pass = !reached;
  return _verdict('risk', {
    pass,
    // риск блокирует всегда, но для YMYL — строго; для не-YMYL тоже блокируем
    // при critical, т.к. это репутационный/юридический риск.
    blocking: true,
    verdict: level,
    evidence: { level, ymyl, issues: (riskReport.issues || []).slice(0, 10) },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 10. Authorship / disclosure (V1). Для YMYL обязательны byline/reviewer/source.
//     Blocking только для YMYL. authorship: { byline, reviewer, sources }
// ─────────────────────────────────────────────────────────────────────
function checkAuthorship(authorship, { ymyl = false } = {}) {
  const a = authorship || {};
  const hasByline   = !!(a.byline && String(a.byline).trim());
  const hasReviewer = !!(a.reviewer && String(a.reviewer).trim());
  const hasSources  = Array.isArray(a.sources) ? a.sources.length > 0 : !!a.sources;
  const complete = hasByline && hasReviewer && hasSources;
  // Для не-YMYL достаточно byline (reviewer/sources — желательны).
  const pass = ymyl ? complete : hasByline;
  return _verdict('authorship', {
    pass,
    blocking: ymyl, // жёстко блокируем только чувствительные темы
    verdict: pass ? 'disclosed' : 'missing_disclosure',
    evidence: { hasByline, hasReviewer, hasSources, ymyl, required: ymyl ? 'byline+reviewer+sources' : 'byline' },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 11. Value-adds (V3). Blocking, если в information_gain_brief меньше
//     thresholds.minValueAdds measurable уникальных добавок.
//     brief: { value_adds: [ 'comparison_table', ... ] | [{ type, ... }] }
// ─────────────────────────────────────────────────────────────────────
function checkValueAdds(brief, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const catalog = new Set(contentPolicy.getValueAddCatalogSync());
  const raw = (brief && brief.value_adds) || [];
  const normalized = raw
    .map((v) => (typeof v === 'string' ? v : (v && (v.type || v.name))))
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  // Считаем только известные из каталога (measurable), уникальные.
  const measurable = [...new Set(normalized.filter((v) => catalog.has(v)))];
  const pass = measurable.length >= th.minValueAdds;
  return _verdict('value_adds', {
    pass,
    blocking: true,
    score: measurable.length,
    verdict: pass ? 'sufficient' : 'insufficient',
    evidence: { measurable, required: th.minValueAdds, provided: normalized.length, catalogUnknown: normalized.filter((v) => !catalog.has(v)) },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 12. GIST Score (ТЗ «GIST Content Logic», Задача B).
//     gist_score = |{параграфов, покрывающих ≥1 тезис дельты}| / |параграфов|.
//     Fail-open: warning, НЕ blocker; при отсутствии дельты — skip (pass).
// ─────────────────────────────────────────────────────────────────────

/** Параграфы контента: p, li, td (видимый текст, ≥ 20 символов). */
function _extractParagraphs(html) {
  const out = [];
  const re = /<(p|li|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 20) out.push(text);
  }
  return out;
}

/** Ключевые слова тезиса дельты: item.keywords | [item.claim] | [item]. */
function _deltaKeywords(item) {
  if (item && typeof item === 'object') {
    if (Array.isArray(item.keywords) && item.keywords.length) return item.keywords.map(String);
    return [String(item.claim || item.thesis || item.topic || '')];
  }
  return [String(item ?? '')];
}

/** Параграф «покрывает» тезис при пересечении значимых слов ≥ 50% (как gist_py m3_gap). */
function _paragraphCoversClaim(paraLower, claimText) {
  const words = (t) => new Set((String(t).toLowerCase().match(/[а-яёa-z0-9]{4,}/g) || []));
  const dw = words(claimText);
  if (!dw.size) return false;
  const pw = words(paraLower);
  let overlap = 0;
  for (const w of dw) if (pw.has(w)) overlap += 1;
  return overlap / dw.size >= 0.5;
}

function checkGistScore(html, informationDelta, { thresholds } = {}) {
  const th = contentPolicy.getThresholds(thresholds);
  const minScore = _firstNumber([th.gistScoreMin]) ?? 0.30;
  const greenScore = _firstNumber([th.gistScoreGreen]) ?? 0.40;

  if (!Array.isArray(informationDelta) || informationDelta.length === 0) {
    return _verdict('gistScore', {
      pass: true,
      blocking: false,
      verdict: 'skipped',
      evidence: { skip: true, reason: 'no_delta_available' },
    });
  }

  const paragraphs = _extractParagraphs(html);
  const deltaClaims = informationDelta.flatMap(_deltaKeywords).filter((k) => k && k.trim());

  let coveredCount = 0;
  for (const para of paragraphs) {
    const paraLower = para.toLowerCase();
    const covers = deltaClaims.some(
      (kw) => paraLower.includes(kw.toLowerCase()) || _paragraphCoversClaim(paraLower, kw),
    );
    if (covers) coveredCount += 1;
  }

  const score = paragraphs.length > 0 ? coveredCount / paragraphs.length : 0;
  const pct = Math.round(score * 100);
  const pass = score >= minScore;
  const level = score >= greenScore ? 'green' : score >= minScore ? 'yellow' : 'red';

  return _verdict('gistScore', {
    pass,
    blocking: false, // warning, не blocker (fail-open)
    score: pct,
    verdict: pass
      ? `GIST Score ${pct}%`
      : `GIST Score ${pct}% < ${Math.round(minScore * 100)}% — информационная дельта не раскрыта`,
    evidence: { level, coveredCount, totalParagraphs: paragraphs.length, deltaClaims: deltaClaims.length },
  });
}

// ─────────────────────────────────────────────────────────────────────
// 13. TZ Compliance (Task C).
//     Stage 7 уже посчитал детерминированный отчёт соблюдения ТЗ. Здесь
//     только переводим его в fail-open warning для единого qualityGate.
// ─────────────────────────────────────────────────────────────────────
function checkTzCompliance(tzCompliance, { minScore = 80 } = {}) {
  if (!tzCompliance || typeof tzCompliance !== 'object') {
    return _verdict('tzCompliance', {
      pass: true,
      blocking: false,
      verdict: 'skipped',
      evidence: { reason: 'no_tz_compliance_report' },
    });
  }

  const score = _firstNumber([tzCompliance.tz_compliance_score, tzCompliance.score]);
  const threshold = _firstNumber([tzCompliance.threshold, minScore]) ?? 80;
  const pass = score == null || score >= threshold;
  return _verdict('tzCompliance', {
    pass,
    blocking: false,
    score,
    verdict: pass ? 'tz_ok' : `tz_score ${score} < ${threshold}`,
    evidence: {
      threshold,
      needs_rewrite: tzCompliance.needs_rewrite || [],
      h1_match: tzCompliance.h1_match || null,
      h2_required_present: tzCompliance.h2_required_present || [],
      lsi_required_coverage: tzCompliance.lsi_required_coverage ?? null,
      lsi_forbidden_violations: tzCompliance.lsi_forbidden_violations || [],
      fail_open: tzCompliance.fail_open === true,
      error: tzCompliance.error || null,
    },
  });
}

// ── helpers ───────────────────────────────────────────────────────────
function _firstNumber(candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

module.exports = {
  checkFreshness,
  checkStopPhrases,
  checkBannedFormulations,
  checkLsiOverdose,
  checkPlagiarism,
  checkFactConfidence,
  checkIntent,
  checkLinkAudit,
  checkRisk,
  checkAuthorship,
  checkValueAdds,
  checkGistScore,
  checkTzCompliance,
  // helpers for tests
  _internal: { _plainLower, _firstNumber, RISK_ORDER, _extractParagraphs },
};
