'use strict';

/**
 * Controller модуля «Фронт работ» (конструктор КП) внутри раздела «Прогнозатор».
 *
 *   GET    /api/proposals                 — список КП (фильтры: q, status, sort)
 *   POST   /api/proposals                 — создать КП
 *   GET    /api/proposals/:id             — КП + задачи + стоимость
 *   PUT    /api/proposals/:id             — обновить (поля + bulk-замена tasks/pricing)
 *   DELETE /api/proposals/:id             — удалить
 *   POST   /api/proposals/:id/clone       — клонировать
 *   GET    /api/proposals/:id/export/pdf  — экспорт PDF
 *   GET    /api/proposals/:id/export/xlsx — экспорт Excel
 *   POST   /api/proposals/:id/share       — выпустить публичную ссылку
 *   DELETE /api/proposals/:id/share       — отозвать
 *
 *   CRUD задач КП:        /api/proposals/:id/tasks[/:taskId]
 *   CRUD стоимости КП:    /api/proposals/:id/pricing[/:priceId]
 *
 *   Справочник (редактируемый — правки сохраняются для всех будущих КП):
 *   GET    /api/proposal-modules              — модули + задачи
 *   POST   /api/proposal-modules              — добавить модуль
 *   PUT    /api/proposal-modules/:id          — изменить модуль
 *   DELETE /api/proposal-modules/:id          — удалить модуль (+его задачи)
 *   POST   /api/proposal-modules/:id/tasks    — добавить задачу в модуль
 *   PUT    /api/proposal-modules/tasks/:taskId    — изменить задачу справочника
 *   DELETE /api/proposal-modules/tasks/:taskId    — удалить задачу справочника
 *
 *   Прайс-лист: GET/POST /api/pricing-templates, PUT/DELETE /api/pricing-templates/:id
 *
 *   Публично (без auth): GET /api/public/proposal/:token
 */

const db = require('../config/db');
const {
  generateShareToken,
  isValidShareToken,
} = require('../services/forecaster/shareToken');
const {
  buildProposalPdf,
  buildProposalXlsx,
  buildPricingTotals,
} = require('../services/proposals/exportService');

const STATUSES = ['draft', 'sent', 'accepted', 'rejected'];
const TASK_STATUSES = ['not_started', 'in_progress', 'done'];
const PRIORITIES = ['high', 'medium', 'low'];

function _s(v, max = 255) { return String(v == null ? '' : v).slice(0, max).trim(); }
function _sOrNull(v, max = 255) { const s = _s(v, max); return s || null; }
function _horizon(v) { return Number(v) === 6 ? 6 : 3; }
function _month(v, horizon) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, horizon || 6);
}
function _monthOrNull(v, horizon) {
  if (v == null || v === '' || v === 'total') return null;
  return _month(v, horizon);
}
function _budget(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1e12);
}
function _budgetOrNull(v) {
  if (v == null || v === '') return null;
  const n = _budget(v);
  return n > 0 ? n : null;
}
function _dateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function _priority(v) { return PRIORITIES.includes(v) ? v : 'medium'; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function _ownedProposal(id, userId, columns = '*') {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await db.query(
    `SELECT ${columns} FROM proposals WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

async function _loadFull(proposal) {
  const [tasks, pricing] = await Promise.all([
    db.query(
      `SELECT * FROM proposal_tasks WHERE proposal_id = $1
       ORDER BY month, module_id, task_id`,
      [proposal.id],
    ),
    db.query(
      `SELECT * FROM proposal_pricing WHERE proposal_id = $1
       ORDER BY month NULLS LAST, created_at`,
      [proposal.id],
    ),
  ]);
  return { ...proposal, tasks: tasks.rows, pricing: pricing.rows };
}

// ─────────────────────────────────────────────────────── Список / CRUD ──

async function listProposals(req, res) {
  try {
    const q = _s(req.query.q, 200);
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const sortDir = req.query.sort === 'asc' ? 'ASC' : 'DESC';

    const params = [req.user.id];
    let where = 'p.user_id = $1';
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (p.title ILIKE $${params.length} OR p.client ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      where += ` AND p.status = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT p.id, p.title, p.client, p.manager, p.horizon, p.start_date,
              p.status, p.cloned_from_id, p.share_token, p.created_at, p.updated_at,
              COALESCE(t.cnt, 0)::int AS tasks_count,
              COALESCE(pr.total, 0)::numeric AS total_budget
       FROM proposals p
       LEFT JOIN (SELECT proposal_id, COUNT(*) AS cnt FROM proposal_tasks GROUP BY proposal_id) t
         ON t.proposal_id = p.id
       LEFT JOIN (SELECT proposal_id, SUM(base_budget + COALESCE(additional_budget, 0)) AS total
                  FROM proposal_pricing GROUP BY proposal_id) pr
         ON pr.proposal_id = p.id
       WHERE ${where}
       ORDER BY p.created_at ${sortDir}
       LIMIT 500`,
      params,
    );
    res.json({ proposals: rows });
  } catch (err) {
    console.error('[proposals] list error:', err.message);
    res.status(500).json({ error: 'Не удалось получить список КП' });
  }
}

async function createProposal(req, res) {
  try {
    const title = _s(req.body.title);
    if (!title) return res.status(400).json({ error: 'Название КП обязательно' });
    const horizon = _horizon(req.body.horizon);

    const { rows } = await db.query(
      `INSERT INTO proposals (user_id, title, client, manager, horizon, start_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.user.id, title, _sOrNull(req.body.client), _sOrNull(req.body.manager),
        horizon, _dateOrNull(req.body.start_date),
        STATUSES.includes(req.body.status) ? req.body.status : 'draft',
      ],
    );
    const proposal = rows[0];
    if (Array.isArray(req.body.tasks)) await _replaceTasks(proposal.id, req.body.tasks, horizon);
    if (Array.isArray(req.body.pricing)) await _replacePricing(proposal.id, req.body.pricing, horizon);
    res.status(201).json({ proposal: await _loadFull(proposal) });
  } catch (err) {
    console.error('[proposals] create error:', err.message);
    res.status(500).json({ error: 'Не удалось создать КП' });
  }
}

async function getProposal(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id);
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    res.json({ proposal: await _loadFull(proposal) });
  } catch (err) {
    console.error('[proposals] get error:', err.message);
    res.status(500).json({ error: 'Не удалось получить КП' });
  }
}

async function _replaceTasks(proposalId, tasks, horizon) {
  await db.query('DELETE FROM proposal_tasks WHERE proposal_id = $1', [proposalId]);
  for (const t of tasks.slice(0, 1000)) {
    await db.query(
      `INSERT INTO proposal_tasks
         (proposal_id, module_id, module_name, task_id, task_title, task_description,
          priority, tool, month, responsible, status, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        proposalId,
        Number.isFinite(Number(t.module_id)) ? Number(t.module_id) : null,
        _sOrNull(t.module_name),
        _sOrNull(t.task_id, 10),
        _s(t.task_title, 500) || 'Задача',
        _sOrNull(t.task_description, 5000),
        _priority(t.priority),
        _sOrNull(t.tool),
        _month(t.month, horizon),
        _sOrNull(t.responsible),
        TASK_STATUSES.includes(t.status) ? t.status : 'not_started',
        _sOrNull(t.comment, 5000),
      ],
    );
  }
}

async function _replacePricing(proposalId, pricing, horizon) {
  await db.query('DELETE FROM proposal_pricing WHERE proposal_id = $1', [proposalId]);
  for (const p of pricing.slice(0, 500)) {
    if (!_s(p.item_name)) continue;
    await db.query(
      `INSERT INTO proposal_pricing
         (proposal_id, item_name, base_budget, additional_budget, additional_note, month, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        proposalId, _s(p.item_name), _budget(p.base_budget),
        _budgetOrNull(p.additional_budget), _sOrNull(p.additional_note, 5000),
        _monthOrNull(p.month, horizon), _s(p.currency, 10) || 'RUB',
      ],
    );
  }
}

async function updateProposal(req, res) {
  try {
    const existing = await _ownedProposal(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'КП не найдено' });

    const b = req.body || {};
    const title = b.title !== undefined ? _s(b.title) : existing.title;
    if (!title) return res.status(400).json({ error: 'Название КП обязательно' });
    const horizon = b.horizon !== undefined ? _horizon(b.horizon) : existing.horizon;

    const { rows } = await db.query(
      `UPDATE proposals SET
         title = $1, client = $2, manager = $3, horizon = $4, start_date = $5,
         status = $6, updated_at = NOW()
       WHERE id = $7 AND user_id = $8 RETURNING *`,
      [
        title,
        b.client !== undefined ? _sOrNull(b.client) : existing.client,
        b.manager !== undefined ? _sOrNull(b.manager) : existing.manager,
        horizon,
        b.start_date !== undefined ? _dateOrNull(b.start_date) : existing.start_date,
        STATUSES.includes(b.status) ? b.status : existing.status,
        req.params.id, req.user.id,
      ],
    );
    if (Array.isArray(b.tasks)) await _replaceTasks(req.params.id, b.tasks, horizon);
    if (Array.isArray(b.pricing)) await _replacePricing(req.params.id, b.pricing, horizon);
    res.json({ proposal: await _loadFull(rows[0]) });
  } catch (err) {
    console.error('[proposals] update error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить КП' });
  }
}

async function deleteProposal(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'КП не найдено' });
    const { rowCount } = await db.query(
      'DELETE FROM proposals WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'КП не найдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить КП' });
  }
}

// ─────────────────────────────────────────────────────── Клонирование ──

async function cloneProposal(req, res) {
  try {
    const original = await _ownedProposal(req.params.id, req.user.id);
    if (!original) return res.status(404).json({ error: 'КП не найдено' });

    const title = _s(req.body.title) || `${original.title} (копия)`;
    const copyPricing = req.body.copy_pricing !== false;

    // Статус → draft; client / start_date / manager — сбрасываются (ТЗ §7).
    const { rows } = await db.query(
      `INSERT INTO proposals (user_id, title, horizon, status, cloned_from_id)
       VALUES ($1, $2, $3, 'draft', $4) RETURNING *`,
      [req.user.id, title, original.horizon, original.id],
    );
    const clone = rows[0];

    await db.query(
      `INSERT INTO proposal_tasks
         (proposal_id, module_id, module_name, task_id, task_title, task_description,
          priority, tool, month, responsible, status, comment)
       SELECT $1, module_id, module_name, task_id, task_title, task_description,
              priority, tool, month, responsible, 'not_started', comment
       FROM proposal_tasks WHERE proposal_id = $2`,
      [clone.id, original.id],
    );
    if (copyPricing) {
      await db.query(
        `INSERT INTO proposal_pricing
           (proposal_id, item_name, base_budget, additional_budget, additional_note, month, currency)
         SELECT $1, item_name, base_budget, additional_budget, additional_note, month, currency
         FROM proposal_pricing WHERE proposal_id = $2`,
        [clone.id, original.id],
      );
    }
    res.status(201).json({ proposal: await _loadFull(clone) });
  } catch (err) {
    console.error('[proposals] clone error:', err.message);
    res.status(500).json({ error: 'Не удалось клонировать КП' });
  }
}

// ─────────────────────────────────────────────────────────── Экспорт ──

function _filename(title, ext) {
  const safe = String(title || 'proposal').replace(/[^\wа-яё .-]+/gi, '_').slice(0, 80) || 'proposal';
  return encodeURIComponent(`${safe}.${ext}`);
}

async function exportProposalPdf(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id);
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    const full = await _loadFull(proposal);
    const buf = await buildProposalPdf(full);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${_filename(full.title, 'pdf')}`);
    res.send(buf);
  } catch (err) {
    console.error('[proposals] pdf export error:', err.message);
    res.status(500).json({ error: 'Не удалось сформировать PDF' });
  }
}

async function exportProposalXlsx(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id);
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    const full = await _loadFull(proposal);
    const buf = await buildProposalXlsx(full);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${_filename(full.title, 'xlsx')}`);
    res.send(buf);
  } catch (err) {
    console.error('[proposals] xlsx export error:', err.message);
    res.status(500).json({ error: 'Не удалось сформировать Excel' });
  }
}

// ──────────────────────────────────────────────────────────── Шаринг ──

async function createProposalShare(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id, share_token');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    if (proposal.share_token) return res.json({ share_token: proposal.share_token });
    const token = generateShareToken();
    await db.query(
      'UPDATE proposals SET share_token = $1, share_created_at = NOW() WHERE id = $2',
      [token, proposal.id],
    );
    res.json({ share_token: token });
  } catch (err) {
    console.error('[proposals] share error:', err.message);
    res.status(500).json({ error: 'Не удалось создать ссылку' });
  }
}

async function revokeProposalShare(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'КП не найдено' });
    const { rowCount } = await db.query(
      'UPDATE proposals SET share_token = NULL, share_created_at = NULL WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'КП не найдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] revoke share error:', err.message);
    res.status(500).json({ error: 'Не удалось отозвать ссылку' });
  }
}

async function getSharedProposal(req, res) {
  try {
    const token = req.params.token;
    if (!isValidShareToken(token)) return res.status(404).json({ error: 'Ссылка не найдена' });
    const { rows } = await db.query(
      `SELECT id, title, client, manager, horizon, start_date, status, created_at
       FROM proposals WHERE share_token = $1`,
      [token],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ссылка не найдена' });
    const full = await _loadFull(rows[0]);
    const totals = buildPricingTotals(full.pricing);
    res.json({
      proposal: {
        title: full.title, client: full.client, manager: full.manager,
        horizon: full.horizon, start_date: full.start_date, created_at: full.created_at,
      },
      tasks: full.tasks.map((t) => ({
        module_id: t.module_id, module_name: t.module_name, task_id: t.task_id,
        task_title: t.task_title, task_description: t.task_description,
        priority: t.priority, tool: t.tool, month: t.month, responsible: t.responsible,
      })),
      pricing: full.pricing.map((p) => ({
        item_name: p.item_name, base_budget: p.base_budget,
        additional_budget: p.additional_budget, additional_note: p.additional_note,
        month: p.month, currency: p.currency,
      })),
      totals: { base: totals.base, additional: totals.add, grand: totals.grand },
    });
  } catch (err) {
    console.error('[proposals] shared error:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить КП' });
  }
}

// ─────────────────────────────────────────── CRUD задач и стоимости КП ──

async function addProposalTask(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id, horizon');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    const t = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO proposal_tasks
         (proposal_id, module_id, module_name, task_id, task_title, task_description,
          priority, tool, month, responsible, status, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        proposal.id,
        Number.isFinite(Number(t.module_id)) ? Number(t.module_id) : null,
        _sOrNull(t.module_name), _sOrNull(t.task_id, 10),
        _s(t.task_title, 500) || 'Задача', _sOrNull(t.task_description, 5000),
        _priority(t.priority), _sOrNull(t.tool), _month(t.month, proposal.horizon),
        _sOrNull(t.responsible),
        TASK_STATUSES.includes(t.status) ? t.status : 'not_started',
        _sOrNull(t.comment, 5000),
      ],
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    console.error('[proposals] add task error:', err.message);
    res.status(500).json({ error: 'Не удалось добавить задачу' });
  }
}

async function updateProposalTask(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id, horizon');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    if (!UUID_RE.test(String(req.params.taskId || ''))) return res.status(404).json({ error: 'Задача не найдена' });
    const { rows: cur } = await db.query(
      'SELECT * FROM proposal_tasks WHERE id = $1 AND proposal_id = $2',
      [req.params.taskId, proposal.id],
    );
    if (!cur[0]) return res.status(404).json({ error: 'Задача не найдена' });
    const e = cur[0]; const t = req.body || {};
    const { rows } = await db.query(
      `UPDATE proposal_tasks SET
         task_title = $1, task_description = $2, priority = $3, tool = $4,
         month = $5, responsible = $6, status = $7, comment = $8, updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [
        t.task_title !== undefined ? (_s(t.task_title, 500) || e.task_title) : e.task_title,
        t.task_description !== undefined ? _sOrNull(t.task_description, 5000) : e.task_description,
        t.priority !== undefined ? _priority(t.priority) : e.priority,
        t.tool !== undefined ? _sOrNull(t.tool) : e.tool,
        t.month !== undefined ? _month(t.month, proposal.horizon) : e.month,
        t.responsible !== undefined ? _sOrNull(t.responsible) : e.responsible,
        TASK_STATUSES.includes(t.status) ? t.status : e.status,
        t.comment !== undefined ? _sOrNull(t.comment, 5000) : e.comment,
        e.id,
      ],
    );
    res.json({ task: rows[0] });
  } catch (err) {
    console.error('[proposals] update task error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить задачу' });
  }
}

async function deleteProposalTask(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    if (!UUID_RE.test(String(req.params.taskId || ''))) return res.status(404).json({ error: 'Задача не найдена' });
    const { rowCount } = await db.query(
      'DELETE FROM proposal_tasks WHERE id = $1 AND proposal_id = $2',
      [req.params.taskId, proposal.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete task error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить задачу' });
  }
}

async function addProposalPricing(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id, horizon');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    const p = req.body || {};
    const itemName = _s(p.item_name);
    if (!itemName) return res.status(400).json({ error: 'Название статьи обязательно' });
    const { rows } = await db.query(
      `INSERT INTO proposal_pricing
         (proposal_id, item_name, base_budget, additional_budget, additional_note, month, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        proposal.id, itemName, _budget(p.base_budget),
        _budgetOrNull(p.additional_budget), _sOrNull(p.additional_note, 5000),
        _monthOrNull(p.month, proposal.horizon), _s(p.currency, 10) || 'RUB',
      ],
    );
    res.status(201).json({ pricing: rows[0] });
  } catch (err) {
    console.error('[proposals] add pricing error:', err.message);
    res.status(500).json({ error: 'Не удалось добавить статью' });
  }
}

async function updateProposalPricing(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id, horizon');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    if (!UUID_RE.test(String(req.params.priceId || ''))) return res.status(404).json({ error: 'Статья не найдена' });
    const { rows: cur } = await db.query(
      'SELECT * FROM proposal_pricing WHERE id = $1 AND proposal_id = $2',
      [req.params.priceId, proposal.id],
    );
    if (!cur[0]) return res.status(404).json({ error: 'Статья не найдена' });
    const e = cur[0]; const p = req.body || {};
    const { rows } = await db.query(
      `UPDATE proposal_pricing SET
         item_name = $1, base_budget = $2, additional_budget = $3,
         additional_note = $4, month = $5, currency = $6
       WHERE id = $7 RETURNING *`,
      [
        p.item_name !== undefined ? (_s(p.item_name) || e.item_name) : e.item_name,
        p.base_budget !== undefined ? _budget(p.base_budget) : e.base_budget,
        p.additional_budget !== undefined ? _budgetOrNull(p.additional_budget) : e.additional_budget,
        p.additional_note !== undefined ? _sOrNull(p.additional_note, 5000) : e.additional_note,
        p.month !== undefined ? _monthOrNull(p.month, proposal.horizon) : e.month,
        p.currency !== undefined ? (_s(p.currency, 10) || 'RUB') : e.currency,
        e.id,
      ],
    );
    res.json({ pricing: rows[0] });
  } catch (err) {
    console.error('[proposals] update pricing error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить статью' });
  }
}

async function deleteProposalPricing(req, res) {
  try {
    const proposal = await _ownedProposal(req.params.id, req.user.id, 'id');
    if (!proposal) return res.status(404).json({ error: 'КП не найдено' });
    if (!UUID_RE.test(String(req.params.priceId || ''))) return res.status(404).json({ error: 'Статья не найдена' });
    const { rowCount } = await db.query(
      'DELETE FROM proposal_pricing WHERE id = $1 AND proposal_id = $2',
      [req.params.priceId, proposal.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete pricing error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить статью' });
  }
}

// ──────────────────────────────── Справочник модулей (редактируемый) ──

async function listModules(req, res) {
  try {
    const [modules, tasks] = await Promise.all([
      db.query('SELECT * FROM proposal_modules ORDER BY sort_order, id'),
      db.query('SELECT * FROM proposal_module_tasks ORDER BY module_id, sort_order, id'),
    ]);
    const byModule = new Map();
    for (const t of tasks.rows) {
      if (!byModule.has(t.module_id)) byModule.set(t.module_id, []);
      byModule.get(t.module_id).push(t);
    }
    res.json({
      modules: modules.rows.map((m) => ({ ...m, tasks: byModule.get(m.id) || [] })),
    });
  } catch (err) {
    console.error('[proposals] modules error:', err.message);
    res.status(500).json({ error: 'Не удалось получить модули' });
  }
}

async function createModule(req, res) {
  try {
    const name = _s(req.body.name);
    if (!name) return res.status(400).json({ error: 'Название модуля обязательно' });
    const { rows } = await db.query(
      `INSERT INTO proposal_modules (name, description, estimated_days, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM proposal_modules), 1))
       RETURNING *`,
      [name, _sOrNull(req.body.description, 5000), _sOrNull(req.body.estimated_days, 100)],
    );
    res.status(201).json({ module: { ...rows[0], tasks: [] } });
  } catch (err) {
    console.error('[proposals] create module error:', err.message);
    res.status(500).json({ error: 'Не удалось добавить модуль' });
  }
}

async function updateModule(req, res) {
  try {
    const moduleId = Number(req.params.id);
    if (!Number.isInteger(moduleId)) return res.status(404).json({ error: 'Модуль не найден' });
    const { rows: cur } = await db.query('SELECT * FROM proposal_modules WHERE id = $1', [moduleId]);
    if (!cur[0]) return res.status(404).json({ error: 'Модуль не найден' });
    const e = cur[0]; const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE proposal_modules SET name = $1, description = $2, estimated_days = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [
        b.name !== undefined ? (_s(b.name) || e.name) : e.name,
        b.description !== undefined ? _sOrNull(b.description, 5000) : e.description,
        b.estimated_days !== undefined ? _sOrNull(b.estimated_days, 100) : e.estimated_days,
        e.id,
      ],
    );
    res.json({ module: rows[0] });
  } catch (err) {
    console.error('[proposals] update module error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить модуль' });
  }
}

async function deleteModule(req, res) {
  try {
    const moduleId = Number(req.params.id);
    if (!Number.isInteger(moduleId)) return res.status(404).json({ error: 'Модуль не найден' });
    const { rowCount } = await db.query('DELETE FROM proposal_modules WHERE id = $1', [moduleId]);
    if (!rowCount) return res.status(404).json({ error: 'Модуль не найден' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete module error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить модуль' });
  }
}

// Следующий свободный id вида "<module>.<n>" внутри модуля.
async function _nextCatalogTaskId(moduleId) {
  const { rows } = await db.query(
    'SELECT id FROM proposal_module_tasks WHERE module_id = $1',
    [moduleId],
  );
  let max = 0;
  for (const r of rows) {
    const n = Number(String(r.id).split('.')[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${moduleId}.${max + 1}`;
}

async function createModuleTask(req, res) {
  try {
    const moduleId = Number(req.params.id);
    if (!Number.isInteger(moduleId)) return res.status(404).json({ error: 'Модуль не найден' });
    const { rows: mod } = await db.query('SELECT id FROM proposal_modules WHERE id = $1', [moduleId]);
    if (!mod[0]) return res.status(404).json({ error: 'Модуль не найден' });
    const title = _s(req.body.title, 500);
    if (!title) return res.status(400).json({ error: 'Название задачи обязательно' });
    const id = await _nextCatalogTaskId(moduleId);
    const { rows } = await db.query(
      `INSERT INTO proposal_module_tasks (id, module_id, title, description, tool, priority, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6,
               COALESCE((SELECT MAX(sort_order) + 1 FROM proposal_module_tasks WHERE module_id = $2), 1))
       RETURNING *`,
      [
        id, moduleId, title, _sOrNull(req.body.description, 5000),
        _sOrNull(req.body.tool), _priority(req.body.priority),
      ],
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    console.error('[proposals] create module task error:', err.message);
    res.status(500).json({ error: 'Не удалось добавить задачу' });
  }
}

async function updateModuleTask(req, res) {
  try {
    const { rows: cur } = await db.query(
      'SELECT * FROM proposal_module_tasks WHERE id = $1',
      [_s(req.params.taskId, 10)],
    );
    if (!cur[0]) return res.status(404).json({ error: 'Задача не найдена' });
    const e = cur[0]; const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE proposal_module_tasks SET
         title = $1, description = $2, tool = $3, priority = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [
        b.title !== undefined ? (_s(b.title, 500) || e.title) : e.title,
        b.description !== undefined ? _sOrNull(b.description, 5000) : e.description,
        b.tool !== undefined ? _sOrNull(b.tool) : e.tool,
        b.priority !== undefined ? _priority(b.priority) : e.priority,
        e.id,
      ],
    );
    res.json({ task: rows[0] });
  } catch (err) {
    console.error('[proposals] update module task error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить задачу' });
  }
}

async function deleteModuleTask(req, res) {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM proposal_module_tasks WHERE id = $1',
      [_s(req.params.taskId, 10)],
    );
    if (!rowCount) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete module task error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить задачу' });
  }
}

// ───────────────────────────────────────── Прайс-лист (типовые цены) ──

async function listPricingTemplates(req, res) {
  try {
    const { rows } = await db.query('SELECT * FROM proposal_pricing_templates ORDER BY item_name');
    res.json({ templates: rows });
  } catch (err) {
    console.error('[proposals] templates error:', err.message);
    res.status(500).json({ error: 'Не удалось получить прайс-лист' });
  }
}

async function createPricingTemplate(req, res) {
  try {
    const itemName = _s(req.body.item_name);
    if (!itemName) return res.status(400).json({ error: 'Название позиции обязательно' });
    const { rows } = await db.query(
      `INSERT INTO proposal_pricing_templates (item_name, base_budget, note, currency)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [itemName, _budget(req.body.base_budget), _sOrNull(req.body.note, 5000), _s(req.body.currency, 10) || 'RUB'],
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    console.error('[proposals] create template error:', err.message);
    res.status(500).json({ error: 'Не удалось добавить позицию' });
  }
}

async function updatePricingTemplate(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Позиция не найдена' });
    const { rows: cur } = await db.query('SELECT * FROM proposal_pricing_templates WHERE id = $1', [req.params.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Позиция не найдена' });
    const e = cur[0]; const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE proposal_pricing_templates SET item_name = $1, base_budget = $2, note = $3, currency = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [
        b.item_name !== undefined ? (_s(b.item_name) || e.item_name) : e.item_name,
        b.base_budget !== undefined ? _budget(b.base_budget) : e.base_budget,
        b.note !== undefined ? _sOrNull(b.note, 5000) : e.note,
        b.currency !== undefined ? (_s(b.currency, 10) || 'RUB') : e.currency,
        e.id,
      ],
    );
    res.json({ template: rows[0] });
  } catch (err) {
    console.error('[proposals] update template error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить позицию' });
  }
}

async function deletePricingTemplate(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Позиция не найдена' });
    const { rowCount } = await db.query('DELETE FROM proposal_pricing_templates WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Позиция не найдена' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[proposals] delete template error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить позицию' });
  }
}

module.exports = {
  listProposals, createProposal, getProposal, updateProposal, deleteProposal,
  cloneProposal, exportProposalPdf, exportProposalXlsx,
  createProposalShare, revokeProposalShare, getSharedProposal,
  addProposalTask, updateProposalTask, deleteProposalTask,
  addProposalPricing, updateProposalPricing, deleteProposalPricing,
  listModules, createModule, updateModule, deleteModule,
  createModuleTask, updateModuleTask, deleteModuleTask,
  listPricingTemplates, createPricingTemplate, updatePricingTemplate, deletePricingTemplate,
};
