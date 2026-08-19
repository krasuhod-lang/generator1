'use strict';

const exceljs = require('exceljs');
const queue = require('../services/parserBot/queue');
const { loadAccessibleProject, canAct } = require('../services/projects/projectGrants');

async function checkProjectAccess(projectId, userId) {
  if (!projectId) return true;
  const accessRow = await loadAccessibleProject(projectId, userId);
  if (!accessRow) return false;
  const access = accessRow.access || accessRow;
  return Boolean(access.isOwner || canAct(access, 'read', 'analyses'));
}

function handleError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'internal_error' });
}

function evidenceText(evidence) {
  if (!Array.isArray(evidence)) return '';
  return evidence
    .filter((ev) => ev && (ev.url || ev.quote))
    .map((ev) => `${ev.field ? `[${ev.field}] ` : ''}${ev.url || ''}${ev.quote ? ` — «${ev.quote}»` : ''}`.trim())
    .join('\n');
}

function lines(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value || '';
}

async function createScan(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const urls = req.body?.urls || [];
    const options = req.body?.options || {};
    const projectId = req.body?.project_id || null;
    if (!(await checkProjectAccess(projectId, userId))) {
      return res.status(403).json({ error: 'project_forbidden' });
    }
    const task = await queue.createScan({ userId, projectId, urls, options });
    res.status(201).json({ id: task.id, status: task.status, total: task.total });
  } catch (err) {
    handleError(res, err);
  }
}

async function listScans(req, res) {
  try {
    const items = await queue.listScans(req.user.id, { limit: req.query.limit });
    res.json({ items });
  } catch (err) {
    handleError(res, err);
  }
}

async function getScan(req, res) {
  try {
    const task = await queue.loadTask(req.params.id, req.user.id);
    res.json(task);
  } catch (err) {
    handleError(res, err);
  }
}

async function listItems(req, res) {
  try {
    const items = await queue.listItems(req.params.id, req.user.id, {
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ items });
  } catch (err) {
    handleError(res, err);
  }
}

async function getItem(req, res) {
  try {
    const item = await queue.getItem(req.params.id, req.params.itemId, req.user.id);
    res.json(item);
  } catch (err) {
    handleError(res, err);
  }
}

async function cancelScan(req, res) {
  try {
    const task = await queue.cancelScan(req.params.id, req.user.id);
    res.json(task);
  } catch (err) {
    handleError(res, err);
  }
}

async function retryFailed(req, res) {
  try {
    const task = await queue.retryFailedItems(req.params.id, req.user.id);
    res.json(task);
  } catch (err) {
    handleError(res, err);
  }
}

async function exportJson(req, res) {
  try {
    const task = await queue.loadTask(req.params.id, req.user.id);
    const items = await queue.listAllItems(task.id, req.user.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parser-scan-${task.id}.json"`);
    res.json({ task, items });
  } catch (err) {
    handleError(res, err);
  }
}

async function exportXlsx(req, res) {
  try {
    const task = await queue.loadTask(req.params.id, req.user.id);
    const items = await queue.listAllItems(task.id, req.user.id);
    const workbook = new exceljs.Workbook();
    const sheet = workbook.addWorksheet('Parser Bot');
    sheet.columns = [
      { header: 'URL сайта', key: 'url', width: 30 },
      { header: 'Title главной страницы', key: 'title', width: 30 },
      { header: 'Контакты', key: 'contacts', width: 30 },
      { header: 'О компании', key: 'about', width: 30 },
      { header: 'Список услуг', key: 'services', width: 30 },
      { header: 'Ключевой упор (Фокус)', key: 'focus', width: 30 },
      { header: 'Категории клиентов', key: 'client_segments', width: 40 },
      { header: 'С кем работает', key: 'works_with', width: 30 },
      { header: 'Статус парсинга', key: 'status', width: 20 },
      { header: 'Статус категорий клиентов', key: 'client_segments_status', width: 26 },
      { header: 'Статус поля «С кем работает»', key: 'works_with_status', width: 28 },
      { header: 'Доказательства клиентов', key: 'evidence', width: 60 },
      { header: 'Предупреждения', key: 'warnings', width: 50 },
      { header: 'Количество просканированных страниц', key: 'pages_scanned', width: 22 },
    ];
    for (const item of items) {
      const result = item.result || {};
      const fieldStatus = result.field_status || item.field_status || {};
      const stats = result.stats || item.stats || {};
      sheet.addRow({
        url: result.url || item.normalized_url,
        title: result.title || '',
        contacts: result.contacts || '',
        about: result.about || '',
        services: Array.isArray(result.services) ? result.services.join(', ') : (result.services || ''),
        focus: result.focus || '',
        client_segments: lines(result.client_segments),
        works_with: result.works_with || '',
        status: result.status || item.status,
        client_segments_status: fieldStatus.client_segments || '',
        works_with_status: fieldStatus.works_with || '',
        evidence: evidenceText(result.evidence || item.evidence),
        warnings: lines(result.warnings),
        pages_scanned: stats.pages_scanned ?? '',
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="parser-scan-${task.id}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
}

module.exports = {
  createScan,
  listScans,
  getScan,
  listItems,
  getItem,
  cancelScan,
  retryFailed,
  exportJson,
  exportXlsx,
};
