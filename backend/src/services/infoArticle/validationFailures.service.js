'use strict';

/**
 * validationFailures.service — Phase 2 / С1. Регресс-трекер ошибок
 * валидации writer'а (validateWriterOutput) на протяжении всех проходов
 * (initial + corrective + refine).
 *
 * До этой версии код просто логировал «⚠ Статья не прошла валидацию: N
 * проблем» в task_logs. Это удобно человеку, но невозможно агрегировать
 * по корпусу задач: «какие классы issues регрессируют чаще всего?»,
 * «после какого проходa остались?».
 *
 * Этот трекер:
 *   • собирает per-pass массив `{ pass, stage, count, issues, ts }`;
 *   • классифицирует каждую issue по `kind` (по подстроке-паттерну);
 *   • после всех проходов вычисляет агрегат:
 *       { total_passes, initial_count, final_count, fixed_kinds, persistent_kinds }.
 *   • storage — JSONB-колонка `validation_report` в info_article_tasks;
 *     серверная миграция добавляется в server.js (idempotent ALTER ADD COLUMN).
 *
 * Контракт без БД-зависимости: модуль не делает SQL — только готовит JSON.
 * Persist делает orchestrator (через saveColumn).
 */

// ── Классификация issues ──────────────────────────────────────────────

const ISSUE_PATTERNS = [
  { kind: 'h1_count',           re: /<h1>/i },
  { kind: 'expert_opinion',     re: /мнение эксперта|expert-opinion/i },
  { kind: 'faq_block',          re: /faq|часто задаваемые/i },
  { kind: 'faq_questions',      re: /вопросов \(<h3>\)/i },
  { kind: 'hallucination',      re: /галлюцинац|подозрение/i },
  { kind: 'link_coverage',      re: /покрытие плана ссылок/i },
  { kind: 'link_misplaced',     re: /не в свои h2|вставлены не в свои/i },
  { kind: 'link_extras',        re: /неожиданные ссылки|вне link_plan/i },
  { kind: 'link_density',       re: /нарушена плотность/i },
  { kind: 'link_repeat',        re: /повтор|max_repeat/i },
  { kind: 'too_short',          re: /слишком коротк|пуст/i },
  { kind: 'lsi_missing',        re: /lsi_missing|lsi/i },
];

function classifyIssue(text) {
  if (typeof text !== 'string') {
    if (text && typeof text === 'object' && typeof text.text === 'string') {
      return classifyIssue(text.text);
    }
    return 'other';
  }
  for (const p of ISSUE_PATTERNS) {
    if (p.re.test(text)) return p.kind;
  }
  return 'other';
}

/**
 * Создаёт пустой трекер. Использовать так:
 *   const tracker = createValidationTracker();
 *   tracker.recordPass('writer_initial', issuesArray);
 *   ...
 *   const report = tracker.toReport();
 *   await saveColumn(taskId, 'validation_report', report);
 */
function createValidationTracker() {
  const passes = [];

  function recordPass(stage, issues) {
    const arr = Array.isArray(issues) ? issues : [];
    const passEntry = {
      pass:     passes.length + 1,
      stage:    String(stage || 'unknown'),
      ts:       new Date().toISOString(),
      count:    arr.length,
      issues:   arr.slice(0, 50).map((it) => {
        const text = (typeof it === 'string') ? it : (it && it.text) || JSON.stringify(it);
        return {
          kind: classifyIssue(text),
          text: String(text).slice(0, 500),
        };
      }),
      by_kind:  countByKind(arr),
    };
    passes.push(passEntry);
    return passEntry;
  }

  function countByKind(arr) {
    const out = {};
    for (const it of arr) {
      const text = (typeof it === 'string') ? it : (it && it.text) || JSON.stringify(it);
      const k = classifyIssue(text);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function toReport() {
    if (!passes.length) {
      return {
        total_passes: 0,
        initial_count: 0,
        final_count: 0,
        fixed_kinds: [],
        persistent_kinds: [],
        new_kinds: [],
        passes: [],
      };
    }
    const initial = passes[0];
    const final   = passes[passes.length - 1];
    const initialKinds = new Set(Object.keys(initial.by_kind));
    const finalKinds   = new Set(Object.keys(final.by_kind));
    const fixed       = Array.from(initialKinds).filter((k) => !finalKinds.has(k));
    const persistent  = Array.from(initialKinds).filter((k) => finalKinds.has(k));
    const newKinds    = Array.from(finalKinds).filter((k) => !initialKinds.has(k));

    return {
      total_passes:     passes.length,
      initial_count:    initial.count,
      final_count:      final.count,
      fixed_kinds:      fixed,
      persistent_kinds: persistent,
      new_kinds:        newKinds,
      passes,
    };
  }

  return { recordPass, toReport, _passes: passes };
}

module.exports = {
  createValidationTracker,
  classifyIssue,
  ISSUE_PATTERNS,
};
