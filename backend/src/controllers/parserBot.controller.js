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
    .map((ev) => {
      const type = ev.evidence_type ? `/${ev.evidence_type}` : '';
      const confidence = ev.confidence != null ? `, confidence=${ev.confidence}` : '';
      const supports = Array.isArray(ev.supports_segments) && ev.supports_segments.length
        ? `; supports=${ev.supports_segments.join(' | ')}` : '';
      const works = ev.supports_works_with ? '; supports=works_with' : '';
      return `${ev.field ? `[${ev.field}${type}${confidence}] ` : ''}${ev.url || ''}${ev.quote ? ` — «${ev.quote}»` : ''}${supports}${works}`.trim();
    })
    .join('\n');
}

function formatListItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return String(value || '').trim();
  const segment = value.segment || value.category || value.client || value.audience || value.industry || '';
  const service = value.service || value.solution || value.offer || value.need || '';
  if (segment) return service ? `${segment} — ${service}` : String(segment);
  return JSON.stringify(value);
}

function lines(value) {
  if (Array.isArray(value)) return value.map(formatListItem).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return formatListItem(value);
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
      { header: 'ID запуска', key: 'run_id', width: 38 },
      { header: 'ID элемента запуска', key: 'item_id', width: 38 },
      { header: 'Источник результата', key: 'result_source', width: 18 },
      { header: 'URL сайта', key: 'url', width: 30 },
      { header: 'Title главной страницы', key: 'title', width: 30 },
      { header: 'Контакты', key: 'contacts', width: 30 },
      { header: 'О компании', key: 'about', width: 30 },
      { header: 'Список услуг', key: 'services', width: 30 },
      { header: 'Ключевой упор (Фокус)', key: 'focus', width: 30 },
      { header: 'Категории клиентов', key: 'client_segments', width: 40 },
      { header: 'С кем работает', key: 'works_with', width: 30 },
      { header: 'Статус парсинга', key: 'status', width: 20 },
      { header: 'Статус обхода', key: 'crawl_status', width: 18 },
      { header: 'Статус AI', key: 'ai_status', width: 18 },
      { header: 'Статус данных', key: 'data_status', width: 18 },
      { header: 'Статус категорий клиентов', key: 'client_segments_status', width: 26 },
      { header: 'Статус поля «С кем работает»', key: 'works_with_status', width: 28 },
      { header: 'Доказательства клиентов', key: 'evidence', width: 60 },
      { header: 'Предупреждения', key: 'warnings', width: 50 },
      { header: 'Количество просканированных страниц', key: 'pages_scanned', width: 22 },
      { header: 'Статус доступа к сайту', key: 'access_status', width: 24 },
      { header: 'Код ошибки', key: 'error_code', width: 30 },
      { header: 'Попытки ИИ', key: 'llm_attempts', width: 14 },
      { header: 'Ошибки AI по попыткам', key: 'llm_attempt_errors', width: 60 },
      { header: 'Код/причина доступа', key: 'access_reason', width: 42 },
      { header: 'Диагностика доступа', key: 'access_diagnostics', width: 50 },
      { header: 'Покрытие доказательствами', key: 'evidence_coverage', width: 30 },
      { header: 'Типы доказательств', key: 'evidence_types', width: 28 },
      { header: 'Sitemap-кандидаты', key: 'sitemap_candidates', width: 18 },
      { header: 'HTML-кандидаты', key: 'html_candidates', width: 18 },
      { header: 'Уникальные кандидаты', key: 'unique_candidates', width: 20 },
      { header: 'Попытки загрузки страниц', key: 'pages_fetch_attempted', width: 24 },
      { header: 'Успешно загружено страниц', key: 'pages_fetch_succeeded', width: 24 },
      { header: 'Ошибки загрузки страниц', key: 'pages_fetch_failed', width: 22 },
      { header: 'Осталось в очереди discovery', key: 'queue_remaining', width: 24 },
      { header: 'Причины ошибок подстраниц', key: 'subpage_error_summary', width: 42 },
      { header: 'Примеры ошибок подстраниц', key: 'subpage_error_examples', width: 65 },
      { header: 'AI-категорий получено', key: 'ai_segments_received', width: 22 },
      { header: 'AI-категорий удалено', key: 'dropped_segments', width: 20 },
    ];
    for (const item of items) {
      const result = item.result || {};
      const fieldStatus = result.field_status || item.field_status || {};
      const stats = result.stats || item.stats || {};
      const execution = result.execution || {};
      const access = result.access || {};
      const accessReason = [
        access.status_code ? `HTTP ${access.status_code}` : '',
        result.error_code || '',
        access.reason || '',
      ].filter(Boolean).join('; ') || result.error || '';
      const diagnostics = access.diagnostics || {};
      const coverage = result.evidence_coverage || {};
      const discovery = stats.discovery || {};
      const evidenceCoverage = coverage.total_segments != null
        ? `${coverage.verified_segments || 0}/${coverage.total_segments || 0} (${Math.round((coverage.coverage_ratio || 0) * 100)}%); AI=${coverage.ai_segments_received || 0}; dropped=${coverage.dropped_segments || 0}`
        : '';
      const evidenceTypes = Object.entries(coverage.evidence_types || {})
        .map(([key, value]) => `${key}=${value}`).join(', ');
      const llmAttemptErrors = Array.isArray(stats.llm_attempt_errors)
        ? stats.llm_attempt_errors.map((entry) => `${entry.attempt || '-'}:${entry.stage || 'unknown'} — ${entry.error || ''}`).join('\n')
        : '';
      const subpageErrorCounts = discovery.subpage_error_counts || {};
      const subpageErrorSummary = Object.entries(subpageErrorCounts)
        .map(([key, value]) => `${key}=${value}`).join(', ');
      const subpageErrorExamples = (result.subpage_errors || discovery.subpage_errors || [])
        .slice(0, 10)
        .map((entry) => `${entry.status_code || '-'} ${entry.reason || 'unknown'} ${entry.url || ''}`.trim())
        .join('\n');
      const accessDiagnostics = [
        diagnostics.score != null ? `score=${diagnostics.score}` : '',
        diagnostics.visible_text_chars != null ? `visible_text_chars=${diagnostics.visible_text_chars}` : '',
        Array.isArray(diagnostics.strong_markers) && diagnostics.strong_markers.length
          ? `strong=${diagnostics.strong_markers.join(', ')}` : '',
        Array.isArray(diagnostics.soft_markers) && diagnostics.soft_markers.length
          ? `soft=${diagnostics.soft_markers.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      sheet.addRow({
        run_id: execution.run_id || task.id,
        item_id: execution.item_id || item.id,
        result_source: execution.result_source || 'fresh',
        url: result.url || item.normalized_url,
        title: result.title || '',
        contacts: result.contacts || '',
        about: result.about || '',
        services: Array.isArray(result.services) ? result.services.join(', ') : (result.services || ''),
        focus: result.focus || '',
        client_segments: lines(result.client_segments),
        works_with: result.works_with || '',
        status: result.status || item.status,
        crawl_status: result.crawl_status || '',
        ai_status: result.ai_status || '',
        data_status: result.data_status || '',
        client_segments_status: fieldStatus.client_segments || '',
        works_with_status: fieldStatus.works_with || '',
        evidence: evidenceText(result.evidence || item.evidence),
        warnings: lines(result.warnings),
        pages_scanned: stats.pages_scanned ?? '',
        error_code: result.error_code || item.error_code || '',
        llm_attempts: stats.llm_attempts ?? '',
        llm_attempt_errors: llmAttemptErrors,
        access_status: access.status || (result.status === 'blocked' ? 'blocked' : ''),
        access_reason: accessReason,
        access_diagnostics: accessDiagnostics,
        evidence_coverage: evidenceCoverage,
        evidence_types: evidenceTypes,
        sitemap_candidates: discovery.sitemap_candidates ?? '',
        html_candidates: discovery.html_candidates ?? '',
        unique_candidates: discovery.unique_candidates ?? '',
        pages_fetch_attempted: discovery.pages_fetch_attempted ?? '',
        pages_fetch_succeeded: discovery.pages_fetch_succeeded ?? '',
        pages_fetch_failed: discovery.pages_fetch_failed ?? '',
        queue_remaining: discovery.queue_remaining ?? '',
        subpage_error_summary: subpageErrorSummary,
        subpage_error_examples: subpageErrorExamples,
        ai_segments_received: coverage.ai_segments_received ?? '',
        dropped_segments: coverage.dropped_segments ?? '',
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
