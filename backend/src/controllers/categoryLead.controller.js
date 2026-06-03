'use strict';

/**
 * Controller для инструмента «Lead-text + Фасетный SEO-оптимизатор».
 *
 *   GET    /api/category-lead                — список задач пользователя
 *   POST   /api/category-lead                — создать и запустить задачу
 *   GET    /api/category-lead/:id            — детальная задача
 *   DELETE /api/category-lead/:id            — удалить
 *   GET    /api/category-lead/:id/export.csv — таблица фасет-оптимизатора (CSV)
 *   GET    /api/category-lead/:id/export.md  — lead-text + рекомендации (Markdown)
 */

const db = require('../config/db');
const { processCategoryLeadTask } = require('../services/categoryLead/pipeline');
const { getCategoryLeadConfig } = require('../services/categoryLead/config');
const { withUserSlot } = require('../utils/perUserConcurrency');
const { normalizeGeminiCopywritingModel } = require('../services/llm/geminiModels');

function clipStr(s, max) {
  if (s == null) return '';
  return String(s).slice(0, max).trim();
}

// ─── Нормализация входа ───────────────────────────────────────────
function parseInputs(body) {
  const lim = getCategoryLeadConfig().limits;
  const category = clipStr(body.category, lim.categoryLen);

  // Фильтры: строка или массив групп. Передаём «как есть» в parseManualFilters,
  // здесь только грубо ограничиваем размер строки.
  let filters = body.filters;
  if (typeof filters === 'string') filters = filters.slice(0, 20000);

  // Вопросы покупателей: массив строк или текст с переводами строк.
  let questions = body.questions;
  if (typeof questions === 'string') {
    questions = questions.split(/\r?\n/);
  }
  questions = Array.isArray(questions)
    ? questions.map((q) => clipStr(q, lim.questionLen)).filter(Boolean).slice(0, lim.maxQuestions)
    : [];

  // Семантическое ядро (опц.): массив строк/объектов или текст.
  let semanticCore = body.semantic_core;
  if (typeof semanticCore === 'string') {
    semanticCore = semanticCore.split(/\r?\n/);
  }
  semanticCore = Array.isArray(semanticCore)
    ? semanticCore.slice(0, lim.maxSemanticCore)
    : [];

  const categoryUrl = clipStr(body.category_url, 2000);
  const gscProjectId = clipStr(body.gsc_project_id, 64) || null;

  const options = {
    gemini_model: normalizeGeminiCopywritingModel(body.gemini_model),
  };

  return { category, filters, questions, semantic_core: semanticCore, category_url: categoryUrl, gsc_project_id: gscProjectId, options };
}

// ─── GET /api/category-lead ───────────────────────────────────────
async function listCategoryLeadTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, category, status, error_message,
              llm_model, tokens_in, tokens_out, cost_usd,
              created_at, started_at, completed_at
         FROM category_lead_tasks
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ tasks: rows });
  } catch (err) {
    return next(err);
  }
}

// ─── POST /api/category-lead ──────────────────────────────────────
async function createCategoryLeadTask(req, res, next) {
  try {
    const body = req.body || {};
    const inputs = parseInputs(body);

    if (!inputs.category) {
      return res.status(400).json({ error: 'Укажите название категории' });
    }

    const hasFilters = (typeof inputs.filters === 'string' && inputs.filters.trim())
      || (Array.isArray(inputs.filters) && inputs.filters.length);
    if (!hasFilters && !inputs.category_url) {
      return res.status(400).json({
        error: 'Укажите список фильтров или URL категории для их парсинга',
      });
    }

    const name = clipStr(body.name, 200) || inputs.category;

    const { rows } = await db.query(
      `INSERT INTO category_lead_tasks (user_id, name, category, status, inputs)
       VALUES ($1, $2, $3, 'queued', $4::jsonb)
       RETURNING id, name, category, status, created_at`,
      [req.user.id, name, inputs.category, JSON.stringify(inputs)],
    );
    const task = rows[0];

    setImmediate(() => {
      withUserSlot(req.user.id, () => processCategoryLeadTask(task.id)).catch((err) => {
        console.error('[categoryLead] background task failed:', err.message);
      });
    });

    return res.status(201).json({ task });
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/category-lead/:id ───────────────────────────────────
async function getCategoryLeadTask(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM category_lead_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ task: rows[0] });
  } catch (err) {
    return next(err);
  }
}

// ─── DELETE /api/category-lead/:id ────────────────────────────────
async function deleteCategoryLeadTask(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM category_lead_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Задача не найдена' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

// ─── CSV-helpers ──────────────────────────────────────────────────
function csvCell(val) {
  let s = val == null ? '' : String(val);
  s = s.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function safeFileName(name, fallback) {
  return String(name || fallback)
    .replace(/[^a-zA-Z0-9_\-а-яА-ЯёЁ]+/g, '_')
    .slice(0, 80) || fallback;
}

// ─── GET /api/category-lead/:id/export.csv (таблица фасетов) ───────
async function exportCategoryLeadCsv(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT name, facet_table FROM category_lead_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });

    const { name, facet_table } = rows[0];
    const tableRows = (facet_table && Array.isArray(facet_table.rows)) ? facet_table.rows : [];

    const headers = [
      'Текущий Фильтр/Значение', 'Предлагаемое SEO-название',
      'Тип действия', 'Обоснование', 'Приоритет индексации',
    ];
    const sep = ';';
    let csv = '\uFEFF' + headers.map(csvCell).join(sep) + '\r\n';
    for (const r of tableRows) {
      csv += [
        csvCell(r.current),
        csvCell(r.seo_name),
        csvCell(r.action),
        csvCell(r.reason),
        csvCell(r.index_priority),
      ].join(sep) + '\r\n';
    }

    const fname = `${safeFileName(name, 'facets')}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(csv);
  } catch (err) {
    return next(err);
  }
}

// ─── GET /api/category-lead/:id/export.md (lead-text + рекомендации) ─
async function exportCategoryLeadMarkdown(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT name, category, lead_text, facet_table, meta
         FROM category_lead_tasks WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Задача не найдена' });

    const { name, category, lead_text, facet_table, meta } = rows[0];
    const lead = lead_text || {};
    const facet = facet_table || {};
    const m = meta || {};

    const lines = [];
    lines.push(`# Lead-text: ${category || name || ''}`.trim());
    lines.push('');
    for (const p of (Array.isArray(lead.paragraphs) ? lead.paragraphs : [])) {
      lines.push(p); lines.push('');
    }
    if (lead.ux_rationale) {
      lines.push('## UX-обоснование'); lines.push(''); lines.push(lead.ux_rationale); lines.push('');
    }
    if (Array.isArray(lead.anchor_suggestions) && lead.anchor_suggestions.length) {
      lines.push('## Анкоры на подкатегории'); lines.push('');
      for (const a of lead.anchor_suggestions) {
        lines.push(`- **${a.anchor}** → ${a.target_hint || ''}`.trim());
      }
      lines.push('');
    }
    if (lead.json_ld) {
      lines.push('## JSON-LD'); lines.push('');
      lines.push('```json'); lines.push(JSON.stringify(lead.json_ld, null, 2)); lines.push('```');
      lines.push('');
    }
    if (m.category_meta_draft && (m.category_meta_draft.title || m.category_meta_draft.h1)) {
      lines.push('## Черновик мета-тегов категории'); lines.push('');
      lines.push(`- **Title:** ${m.category_meta_draft.title || ''}`);
      lines.push(`- **Description:** ${m.category_meta_draft.description || ''}`);
      lines.push(`- **H1:** ${m.category_meta_draft.h1 || ''}`);
      lines.push('');
    }
    if (Array.isArray(facet.top_recommendations) && facet.top_recommendations.length) {
      lines.push('## Топ-рекомендации по фасетам'); lines.push('');
      facet.top_recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
      lines.push('');
    }
    if (Array.isArray(m.virtual_keys) && m.virtual_keys.length) {
      lines.push('## Ключи для мета-тегов (High-фасеты)'); lines.push('');
      for (const k of m.virtual_keys) lines.push(`- ${k}`);
      lines.push('');
    }
    if (Array.isArray(m.noindex_recommendations) && m.noindex_recommendations.length) {
      lines.push('## Закрыть от индексации (noindex)'); lines.push('');
      for (const n of m.noindex_recommendations) lines.push(`- ${n}`);
      lines.push('');
    }

    const fname = `${safeFileName(name, 'lead-text')}_${Date.now()}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(lines.join('\n'));
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listCategoryLeadTasks,
  createCategoryLeadTask,
  getCategoryLeadTask,
  deleteCategoryLeadTask,
  exportCategoryLeadCsv,
  exportCategoryLeadMarkdown,
};
