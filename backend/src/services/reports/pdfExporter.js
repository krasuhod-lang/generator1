'use strict';

/**
 * Серверный экспорт Smart Report Builder в PDF.
 *
 * PDF строится из агрегированного report payload и, если frontend передал
 * chart_images, встраивает PNG-графики из текущего ReportRenderer. Текст
 * остаётся выделяемым/искабельным, кириллица поддерживается DejaVuSans.
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { JSDOM } = require('jsdom');

const FONT_DIR = path.join(__dirname, '../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

function _text(v) { return String(v == null ? '' : v).trim(); }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _ru(v) { return _num(v).toLocaleString('ru-RU'); }
function _safeHref(v) { return /^https?:\/\//i.test(_text(v)) ? _text(v) : ''; }
function _md(v) { return _text(v).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'); }

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
  'UL',
]);

function _safeNodeText(node) {
  return String(node?.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Converts the rich HTML stored by the editor into printable text. The PDF
 * exporter deliberately does not pass markup to PDFKit: PDFKit treats HTML as
 * literal characters, which produced <p>, <a>, href and <br> in client PDFs.
 * Links remain useful as `label (URL)` text and lists retain bullet markers.
 */
function _htmlToPlainText(value) {
  const raw = _text(value);
  if (!raw) return '';
  if (!/<\/?[a-z][^>]*>/i.test(raw)) return _md(raw);

  let root;
  try {
    const dom = new JSDOM(`<div>${raw}</div>`);
    root = dom.window.document.body.firstElementChild;
  } catch (_) {
    return _md(raw.replace(/<[^>]+>/g, ' '));
  }
  if (!root) return _md(raw);

  const visit = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return '';
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n────────────\n';
    if (tag === 'A') {
      const label = _safeNodeText(node);
      const href = _safeHref(node.getAttribute('href'));
      if (!label) return href;
      return href && href !== label ? `${label} (${href})` : label;
    }
    const content = Array.from(node.childNodes).map(visit).join('');
    if (tag === 'LI') return `\n• ${content}\n`;
    if (BLOCK_TAGS.has(tag)) return `\n${content}\n`;
    return content;
  };

  return _md(visit(root)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function _parseBase64Image(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (!m) return null;
  try {
    return { buffer: Buffer.from(m[2], 'base64'), format: m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase() };
  } catch (_) {
    return null;
  }
}

function _list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildReportPdf(payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: {
        Title: _text(payload.title || 'SEO-отчёт'),
        Author: 'generator1',
        Subject: 'SEO performance report',
      } });
      const hasFont = fs.existsSync(FONT_REGULAR);
      if (hasFont) {
        doc.registerFont('body', FONT_REGULAR);
        doc.registerFont('bold', fs.existsSync(FONT_BOLD) ? FONT_BOLD : FONT_REGULAR);
      }
      const FONT = hasFont ? 'body' : 'Helvetica';
      const FONT_B = hasFont ? 'bold' : 'Helvetica-Bold';
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const bottom = () => doc.page.height - doc.page.margins.bottom;
      const resetFlowX = () => {
        doc.x = doc.page.margins.left;
      };
      const ensureSpace = (height = 28) => {
        if (doc.y + height > bottom()) doc.addPage();
        resetFlowX();
      };
      const H = (title, size = 14) => {
        resetFlowX();
        ensureSpace(size + 30);
        resetFlowX();
        doc.moveDown(0.55).font(FONT_B).fontSize(size).fillColor('#111827').text(_md(title), {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          lineGap: 2,
        });
        resetFlowX();
        doc.moveDown(0.18);
      };
      const P = (value, opts = {}) => {
        const text = _htmlToPlainText(value);
        if (!text) return;
        ensureSpace(opts.minHeight || 24);
        doc.font(FONT).fontSize(opts.size || 10).fillColor(opts.color || '#1f2937').text(text, {
          width: opts.width || (doc.page.width - doc.page.margins.left - doc.page.margins.right),
          align: opts.align,
          lineGap: opts.lineGap == null ? 2 : opts.lineGap,
          continued: false,
        });
        resetFlowX();
      };
      const bullet = (value) => P(`•  ${value}`, { minHeight: 17, size: 9.6 });
      const rule = () => {
        resetFlowX();
        ensureSpace(12);
        const y = doc.y + 2;
        doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y)
          .strokeColor('#d1d5db').lineWidth(0.5).stroke();
        doc.moveDown(0.35);
      };

      const drawTable = (headers, rows, widths) => {
        const left = doc.page.margins.left;
        const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const normalizedWidths = Array.isArray(widths) && widths.length === headers.length
          ? widths
          : headers.map(() => totalWidth / headers.length);
        const rowHeight = 25;
        const drawRow = (cells, header = false) => {
          ensureSpace(rowHeight + 4);
          const y = doc.y;
          let x = left;
          cells.forEach((cell, index) => {
            const width = normalizedWidths[index] || 80;
            doc.rect(x, y, width, rowHeight).fillAndStroke(header ? '#eef2ff' : '#ffffff', '#d1d5db');
            doc.font(header ? FONT_B : FONT).fontSize(header ? 8.5 : 8.2)
              .fillColor(header ? '#3730a3' : '#1f2937')
              .text(_htmlToPlainText(cell).replace(/\n+/g, ' '), x + 5, y + 7, { width: Math.max(10, width - 10), height: rowHeight - 8, ellipsis: true });
            x += width;
          });
          doc.y = y + rowHeight;
        };
        drawRow(headers, true);
        rows.forEach((row) => drawRow(row, false));
        resetFlowX();
        doc.moveDown(0.4);
      };

      const data = payload.data || {};
      const summary = payload.summary || {};

      // ── Cover ──
      doc.font(FONT_B).fontSize(23).fillColor('#111827').text(_text(payload.title || 'SEO-отчёт'), { align: 'center' });
      doc.moveDown(0.25);
      doc.font(FONT).fontSize(11).fillColor('#6b7280').text(_text(payload.period || ''), { align: 'center' });
      doc.moveDown(0.75);
      if (payload.project?.name) P(`Проект: ${payload.project.name}`, { size: 10 });
      if (payload.project?.url) {
        const href = _safeHref(payload.project.url);
        P(`Сайт: ${payload.project.url}`, { color: href ? '#3730a3' : '#1f2937', size: 10 });
      }
      rule();

      // ── KPI ──
      const kpiRows = [];
      const gsc = data.gsc?.totals;
      if (gsc) {
        kpiRows.push(['Google', 'Клики', _ru(gsc.clicks)]);
        kpiRows.push(['Google', 'Показы', _ru(gsc.impressions)]);
        if (gsc.ctr != null) kpiRows.push(['Google', 'CTR', `${_num(gsc.ctr).toFixed(2)}%`]);
        if (gsc.position != null) kpiRows.push(['Google', 'Средняя позиция', _num(gsc.position).toFixed(1)]);
      }
      const ywm = data.ywm?.totals;
      if (ywm) {
        kpiRows.push(['Яндекс', 'Клики', _ru(ywm.clicks)]);
        kpiRows.push(['Яндекс', 'Показы', _ru(ywm.impressions)]);
        if (ywm.ctr != null) kpiRows.push(['Яндекс', 'CTR', `${_num(ywm.ctr).toFixed(2)}%`]);
        if (ywm.position != null) kpiRows.push(['Яндекс', 'Средняя позиция', _num(ywm.position).toFixed(1)]);
      }
      const keys = data.keys_so?.current;
      if (keys) {
        if (keys.visibility != null) kpiRows.push(['Keys.so', 'Видимость', _num(keys.visibility).toFixed(2)]);
        kpiRows.push(['Keys.so', 'ТОП-10', _ru(keys.top10)]);
        kpiRows.push(['Keys.so', 'ТОП-50', _ru(keys.top50)]);
      }
      if (kpiRows.length) {
        H('Ключевые показатели');
        drawTable(['Источник', 'Метрика', 'Значение'], kpiRows, [120, 245, 105]);
      }

      if (summary.executive_summary) {
        H('Резюме для руководителя', 12);
        P(summary.executive_summary, { size: 10 });
      }
      if (summary.next_month_forecast) {
        H('Прогноз на следующий месяц', 12);
        P(summary.next_month_forecast, { size: 10 });
      }

      if (Array.isArray(summary.highlights) && summary.highlights.length) {
        H('Главные достижения', 12);
        summary.highlights.forEach((item) => {
          const text = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
          if (text) bullet(text);
        });
      }

      // ── Charts captured from the rich ReportRenderer ──
      const charts = _list(payload.chart_images);
      if (charts.length) {
        H('Графики динамики');
        charts.forEach((chart) => {
          const image = _parseBase64Image(chart.data_url);
          if (!image) return;
          ensureSpace(250);
          resetFlowX();
          doc.font(FONT_B).fontSize(10.5).fillColor('#111827').text(_md(chart.title || chart.key || 'График'), {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            lineGap: 2,
          });
          doc.moveDown(0.15);
          try {
            doc.image(image.buffer, {
              fit: [doc.page.width - doc.page.margins.left - doc.page.margins.right, 225],
              align: 'center',
              valign: 'center',
            });
            resetFlowX();
            doc.moveDown(0.35);
          } catch (_) {
            P('График не удалось встроить в PDF.', { color: '#6b7280' });
          }
        });
      }

      if (Array.isArray(summary.growth_attribution) && summary.growth_attribution.length) {
        H('Анализ динамики и точки роста');
        const growthRows = summary.growth_attribution.slice(0, 30).map((item) => [
          item.metric || 'Метрика',
          item.attribution || item.conclusion || '—',
          item.weak_zones || item.forecast || '—',
        ]);
        drawTable(['Метрика', 'Вывод', 'Точка роста / прогноз'], growthRows, [130, 205, 135]);
      }

      if (Array.isArray(summary.quick_wins) && summary.quick_wins.length) {
        H('Quick Wins', 12);
        const quickRows = summary.quick_wins.slice(0, 30).map((item) => [
          item.query || 'Запрос',
          item.position == null ? '—' : String(item.position),
          item.plan || '—',
        ]);
        drawTable(['Запрос', 'Позиция', 'План действий'], quickRows, [165, 70, 235]);
      }

      if (Array.isArray(summary.vulnerabilities) && summary.vulnerabilities.length) {
        H('Уязвимости и риски', 12);
        summary.vulnerabilities.slice(0, 30).forEach((item) => {
          const text = typeof item === 'string' ? item : `${item.title || item.name || ''} ${item.detail || item.description || item.action || ''}`.trim();
          if (text) bullet(text);
        });
      }

      if (Array.isArray(summary.roadmap) && summary.roadmap.length) {
        H('Дорожная карта', 12);
        const roadmapRows = summary.roadmap.slice(0, 30).map((item) => [
          item.period || item.month || item.stage || 'Шаг',
          item.title || item.action || item.task || '—',
          item.expected_result || item.result || item.impact || '—',
        ]);
        drawTable(['Период', 'Действие', 'Ожидаемый результат'], roadmapRows, [95, 245, 130]);
      }

      if (summary.traffic_value) {
        H('Стоимость SEO-трафика', 12);
        P(summary.traffic_value, { size: 10 });
      }

      // ── Completed work ──
      const blocks = _list(payload.tasks_blocks);
      const taskItems = _list(data.tasks?.items);
      if (blocks.length || taskItems.length) {
        H('Выполненные работы');
        if (blocks.length) {
          for (const monthBlock of blocks) {
            H(monthBlock.month || monthBlock.section || 'Период', 11);
            for (const section of monthBlock.sections || []) {
              P(section.title || 'Раздел', { color: '#374151', size: 9.5 });
              for (const task of section.tasks || []) {
                const taskTitle = task.title || task.name || 'Задача';
                const meta = [task.source || task.module, task.status, task.date || task.completed_at]
                  .filter(Boolean).join(' · ');
                bullet(meta ? `${taskTitle} (${meta})` : taskTitle);
                if (task.description_html || task.description) P(task.description_html || task.description, { size: 8.5, color: '#4b5563' });
              }
            }
          }
        } else {
          const rows = taskItems.slice(0, 200).map((task) => [
            task.title || task.name || task.task_type || 'Задача',
            task.status || '—',
            task.completed_at || task.created_at || '—',
          ]);
          drawTable(['Задача', 'Статус', 'Дата'], rows, [310, 100, 130]);
        }
      }

      // ── Source/provenance footer section when available ──
      const sources = _list(data.sources || data.provenance?.sources || summary.sources);
      if (sources.length) {
        H('Источники данных', 11);
        sources.slice(0, 40).forEach((source) => {
          const url = typeof source === 'string' ? source : source.url || source.source_url || '';
          const label = typeof source === 'string' ? source : source.title || source.name || url;
          if (label) bullet(url && url !== label ? `${label}: ${url}` : label);
        });
      }

      // Page chrome is applied only after the content is complete so the total
      // page count is known. It does not alter the content flow.
      const range = doc.bufferedPageRange();
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(index);
        const pageNo = index + 1;
        // PDFKit considers the default bottom margin a hard content boundary.
        // The footer is intentionally inside the physical page, below the
        // content area, so temporarily disable auto page creation for these
        // two fixed-position labels. Without this, every footer line could
        // create a new footer-only page in the exported PDF.
        const previousBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        try {
          doc.font(FONT).fontSize(7.5).fillColor('#6b7280')
            .text('generator1 · SEO report', doc.page.margins.left, doc.page.height - 31, {
              width: 230,
              lineBreak: false,
            });
          doc.text(`Страница ${pageNo} из ${range.count}`, doc.page.width - doc.page.margins.right - 120, doc.page.height - 31, {
            width: 120,
            align: 'right',
            lineBreak: false,
          });
        } finally {
          doc.page.margins.bottom = previousBottomMargin;
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildReportPdf };
