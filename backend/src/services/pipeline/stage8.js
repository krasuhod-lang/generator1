'use strict';

/**
 * Stage 8 — Optional Quality Evaluator (LLM-as-judge)
 *
 * Запускается ПОСЛЕ Stage 7 (после финального HTML), только если
 * включён флаг `STAGE8_EVALUATOR_ENABLED=true`. Default OFF — нулевое
 * влияние на текущий пайплайн.
 *
 * Архитектура:
 *   - Один DeepSeek-вызов (дешёвый, ~$0.001/задача).
 *   - Промт построен на основе официального
 *     `backend/src/prompts/source/19-Regulatory & Risk Scanner.txt`
 *     (Module 3 ТЗ), но компактно: только проверочный чек-лист.
 *   - Ground truth берётся из task.__moduleContext (Module 1+2):
 *     mandatory_entities, avoid_ambiguous_terms, claims_to_prove.
 *   - Возвращает JSON c покрытием и issues. Сохраняется в
 *     `tasks.evaluator_report` (миграция 014) и публикуется через SSE.
 *
 * НЕ блокирует и НЕ перегенерирует контент. Это аналитический отчёт
 * для последующей DSPy-MIPROv2 оптимизации (если будете её запускать).
 */

const { callLLM } = require('../llm/callLLM');
const db          = require('../../config/db');

const SYSTEM_PROMPT = `Ты — Quality Evaluator. Твоя задача — оценить готовую SEO-статью по объективному чек-листу,
основанному на детерминированном Module Context (mandatory_entities, avoid_ambiguous_terms,
claims_to_prove, trust_complexity, jtbd_to_close).

ТРИ ИЗМЕРЕНИЯ ОЦЕНКИ:
  1. Coverage — насколько обязательные сущности и JTBD действительно раскрыты в HTML.
  2. Compliance — соблюдены ли trust-требования и нет ли неподтверждённых claims.
  3. Risk — есть ли регуляторные/этические/фактологические риски (см. промт 19 — Regulatory & Risk Scanner).

ВАЖНО:
  - Считай вхождения по морфологическим корням (склонения тоже считаются).
  - Не анализируй стиль/читаемость — для этого есть Stage 5/6.
  - Не генерируй переписанный текст — только отчёт.

ВЫХОД: ровно один JSON-объект (без markdown, без префиксов) со схемой:
{
  "mandatory_entity_coverage": { "covered_count": int, "total": int, "missing": ["..."] },
  "ambiguous_term_violations": [ { "term": "...", "context": "первые 80 символов вокруг" } ],
  "claims_supported":          { "supported_count": int, "unsupported": ["..."] },
  "jtbd_closed":               { "closed_count": int, "total": int, "uncovered": ["..."] },
  "regulatory_risks":          [ { "risk": "...", "severity": "low|medium|high", "evidence": "..." } ],
  "trust_complexity_match":    { "expected": "low|medium|high", "observed_signals": ["..."], "ok": true|false },
  "total_score":               number (0..10),
  "issues":                    [ { "severity": "low|medium|high", "issue": "...", "fix_hint": "..." } ]
}`;

function safeStringify(obj, max = 6000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (_) {
    return '{}';
  }
}

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  // js/bad-tag-filter-safe: HTML5-парсер допускает атрибуты и whitespace
  // в закрывающем теге (`</script foo bar>`, `</style\n>`), поэтому матчим
  // `</tag[^>]*>` — всё, кроме самого '>'. Лимит длины — защита от ReDoS.
  if (html.length > 5_000_000) return ''; // 5 MB hard cap
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEvaluatorUserPrompt({ moduleContext, finalHTML, task }) {
  // Сжимаем moduleContext до самого важного, чтобы не раздувать промт.
  const mc = {
    mandatory_entities:     (moduleContext?.mandatory_entities || []).slice(0, 25)
                              .map(e => ({ entity: e.entity, type: e.type })),
    avoid_ambiguous_terms:  (moduleContext?.avoid_ambiguous_terms || []).slice(0, 12)
                              .map(t => t.term),
    claims_to_prove:        (moduleContext?.claims_to_prove || []).slice(0, 10)
                              .map(c => ({ claim: c.claim, type: c.type })),
    jtbd_to_close:          (moduleContext?.jtbd_to_close || []).slice(0, 10)
                              .map(j => j.jtbd),
    trust_complexity:       moduleContext?.trust_complexity || { level: 'medium' },
    format_wedge:           moduleContext?.format_wedge?.primary || null,
  };

  const text = stripHtml(finalHTML);
  // Cap длины текста: ~12 КБ. DeepSeek max=100K, но evaluator должен быть быстрым.
  const TEXT_CAP = parseInt(process.env.STAGE8_TEXT_CAP, 10) || 12000;
  const cappedText = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + '…' : text;

  return `===== INPUTS =====
NICHE: ${(task?.input_target_service || '').slice(0, 200)}
REGION: ${(task?.input_region || 'Россия').slice(0, 80)}
BRAND: ${(task?.input_brand_name || '—').slice(0, 80)}

===== MODULE CONTEXT (ground truth) =====
${safeStringify(mc, 5000)}

===== ARTICLE TEXT (HTML stripped) =====
${cappedText}

===== TASK =====
Заполни JSON по схеме из system-промпта. Считай морфологически. Verdict — total_score 0..10:
  - 9-10: всё обязательное покрыто, claims подтверждены, рисков нет.
  - 7-8:  единичные пропуски, рисков нет.
  - 5-6:  >=20% обязательных сущностей не раскрыты ИЛИ unsupported claims есть.
  - <5:   серьёзные пропуски + регуляторные риски.

Только JSON. Никаких пояснений.`;
}

/**
 * isStage8Enabled — true если включено через ENV.
 * @returns {boolean}
 */
function isStage8Enabled() {
  return String(process.env.STAGE8_EVALUATOR_ENABLED || '').toLowerCase() === 'true';
}

/**
 * runStage8Evaluator — запускает оценщика. Не выбрасывает наружу — на любую
 * ошибку возвращает null и пишет warn-лог.
 *
 * @param {object} task
 * @param {object} ctx       — { log, taskId, onTokens }
 * @param {object} input
 * @param {string} input.finalHTML
 * @param {object} input.moduleContext
 * @returns {Promise<object|null>} evaluator_report или null
 */
async function runStage8Evaluator(task, ctx, input) {
  const { log, taskId, onTokens } = ctx;
  const { finalHTML, moduleContext } = input || {};

  if (!isStage8Enabled()) {
    return null;
  }

  if (!finalHTML || !moduleContext) {
    log('Stage 8 Evaluator: пропускаем — нет finalHTML или moduleContext.', 'warn');
    return null;
  }

  log('Stage 8 Evaluator: запуск (DeepSeek LLM-as-judge)...', 'info');
  const startedAt = Date.now();

  let report = null;
  try {
    const userPrompt = buildEvaluatorUserPrompt({ moduleContext, finalHTML, task });
    const promptSize = (SYSTEM_PROMPT + userPrompt).length;
    log(`Stage 8 Evaluator: промпт ${promptSize} символов (~${Math.round(promptSize / 4)} токенов)`, 'info');

    report = await callLLM('deepseek', SYSTEM_PROMPT, userPrompt, {
      retries:     2,
      taskId,
      stageName:   'stage8',
      callLabel:   'Quality Evaluator',
      temperature: 0.1,
      log,
      onTokens,
    });
  } catch (e) {
    log(`Stage 8 Evaluator ОШИБКА: ${e.message} — пропускаем`, 'warn');
    return null;
  }

  if (!report || typeof report !== 'object') {
    log('Stage 8 Evaluator: модель вернула пустой/невалидный JSON — пропускаем', 'warn');
    return null;
  }

  // Нормализуем total_score
  const ts = Number(report.total_score);
  report.total_score = Number.isFinite(ts) ? Math.max(0, Math.min(10, ts)) : null;
  report.elapsed_ms  = Date.now() - startedAt;
  report.generated_at = new Date().toISOString();

  // Сохраняем в БД (graceful — не падаем при ошибке)
  try {
    await db.query(
      `UPDATE tasks SET evaluator_report = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(report), taskId]
    );
  } catch (dbErr) {
    log(`Stage 8 Evaluator: не удалось сохранить отчёт в БД (${dbErr.message})`, 'warn');
  }

  log(
    `Stage 8 Evaluator завершён за ${report.elapsed_ms}ms. ` +
    `Score: ${report.total_score ?? '—'}/10 | ` +
    `Issues: ${(report.issues || []).length} | ` +
    `Missing entities: ${(report.mandatory_entity_coverage?.missing || []).length}`,
    'success'
  );

  return report;
}

module.exports = {
  runStage8Evaluator,
  isStage8Enabled,
  // экспорт для тестов
  _internal: { buildEvaluatorUserPrompt, stripHtml, SYSTEM_PROMPT },
};
