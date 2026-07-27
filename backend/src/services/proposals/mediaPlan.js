'use strict';

/**
 * proposals/mediaPlan.js — единый билдер медиа-плана КП («Фронт работ»).
 *
 * В БД задача КП хранится по строке на каждый месяц выполнения
 * (proposal_tasks.month). Для показа клиенту нужен обратный вид:
 * работа = строка, месяцы = колонки. Этот модуль — единственный источник
 * истины такой свёртки: его используют публичная ссылка (клиентский вид),
 * экспорт PDF и экспорт XLSX, чтобы цифры и раскладка везде совпадали.
 *
 *   buildMediaPlan(tasks, horizon) → {
 *     horizon,                 // фактический горизонт (учитывает месяцы > horizon)
 *     months: [1..horizon],
 *     rows:   [{ module_id, module_name, task_id, task_title, task_description,
 *                priority, tool, months: [1,3], recurrence, recurrence_label }],
 *     modules: [{ module_id, module_name, rows: [...] }],
 *     counts_by_month: { 1: 4, 2: 3, ... },
 *     total_tasks,             // уникальных работ
 *     total_slots,             // работ×месяцев (сколько всего «включений»)
 *   }
 */

const RECURRENCE_LABELS = {
  once: 'Разово',
  monthly: 'Ежемесячно',
  every_2_months: 'Раз в 2 месяца',
  custom: 'По графику',
};

function _text(v) { return String(v == null ? '' : v).trim(); }

function _monthNum(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Периодичность работы по набору месяцев в рамках горизонта.
 * once / monthly / every_2_months / custom — те же значения, что и в
 * proposal_tasks.recurrence (migrations/111_proposal_tasks_months.sql).
 */
function detectRecurrence(months = [], horizon = 3) {
  const uniq = [...new Set(months.map(_monthNum))].sort((a, b) => a - b);
  const h = Math.max(1, Number(horizon) || uniq[uniq.length - 1] || 1);
  if (uniq.length <= 1) return 'once';
  if (uniq.length === h && uniq[0] === 1 && uniq[uniq.length - 1] === h) return 'monthly';
  const steps = uniq.slice(1).map((m, i) => m - uniq[i]);
  if (steps.every((s) => s === 2)) return 'every_2_months';
  return 'custom';
}

/**
 * Человекочитаемая подпись периодичности («Ежемесячно», «М1, М3»).
 */
function recurrenceLabel(months = [], horizon = 3) {
  const uniq = [...new Set(months.map(_monthNum))].sort((a, b) => a - b);
  const rec = detectRecurrence(uniq, horizon);
  if (rec === 'once') return `Разово · М${uniq[0] || 1}`;
  if (rec === 'monthly') return RECURRENCE_LABELS.monthly;
  if (rec === 'every_2_months') return `${RECURRENCE_LABELS.every_2_months} · ${uniq.map((m) => `М${m}`).join(', ')}`;
  return uniq.map((m) => `М${m}`).join(', ');
}

function buildMediaPlan(tasks = [], horizon = 3) {
  const list = Array.isArray(tasks) ? tasks : [];
  // Горизонт «защищённый»: если в задачах остались месяцы больше горизонта
  // (например, горизонт уменьшили), работы не должны исчезать из плана.
  const maxTaskMonth = list.reduce((max, t) => Math.max(max, _monthNum(t.month)), 0);
  const effHorizon = Math.max(1, Number(horizon) || 3, maxTaskMonth);
  const months = Array.from({ length: effHorizon }, (_, i) => i + 1);

  const map = new Map();
  for (const t of list) {
    const key = [t.module_id ?? _text(t.module_name), _text(t.task_id), _text(t.task_title)].join('·');
    if (!map.has(key)) {
      map.set(key, {
        module_id: t.module_id ?? null,
        module_name: _text(t.module_name),
        task_id: _text(t.task_id),
        task_title: _text(t.task_title),
        task_description: _text(t.task_description),
        priority: _text(t.priority) || 'medium',
        tool: _text(t.tool),
        months: [],
      });
    }
    const row = map.get(key);
    const m = Math.min(_monthNum(t.month), effHorizon);
    if (!row.months.includes(m)) row.months.push(m);
    // Описание/инструмент могли быть заполнены не во всех строках-месяцах.
    if (!row.task_description && t.task_description) row.task_description = _text(t.task_description);
    if (!row.tool && t.tool) row.tool = _text(t.tool);
  }

  const rows = [...map.values()]
    .map((row) => {
      row.months.sort((a, b) => a - b);
      return {
        ...row,
        recurrence: detectRecurrence(row.months, effHorizon),
        recurrence_label: recurrenceLabel(row.months, effHorizon),
      };
    })
    .sort((a, b) => (a.months[0] - b.months[0])
      || ((a.module_id || 0) - (b.module_id || 0))
      || String(a.task_id).localeCompare(String(b.task_id), 'ru', { numeric: true }));

  const modules = [];
  const moduleIndex = new Map();
  for (const row of rows) {
    // Модуль мог не проставиться (module_id и module_name пустые) — такие
    // работы собираем в одну общую группу, а не в отдельную на каждую строку.
    const name = row.module_name || 'Прочие работы';
    const key = row.module_id ?? `name:${name}`;
    let group = moduleIndex.get(key);
    if (!group) {
      group = { module_id: row.module_id, module_name: name, rows: [] };
      moduleIndex.set(key, group);
      modules.push(group);
    }
    group.rows.push(row);
  }

  const countsByMonth = {};
  for (const m of months) countsByMonth[m] = 0;
  let totalSlots = 0;
  for (const row of rows) {
    for (const m of row.months) {
      countsByMonth[m] = (countsByMonth[m] || 0) + 1;
      totalSlots += 1;
    }
  }

  return {
    horizon: effHorizon,
    months,
    rows,
    modules,
    counts_by_month: countsByMonth,
    total_tasks: rows.length,
    total_slots: totalSlots,
  };
}

module.exports = {
  buildMediaPlan,
  detectRecurrence,
  recurrenceLabel,
  RECURRENCE_LABELS,
};
