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
const {
  normalizeReportBlocks,
  extractTaskImages,
  resolveReportImage,
  constrainImage,
  EXPORTABLE_PDF_TYPES,
} = require('./reportContent');

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

function _safeColor(value, fallback = '#4f46e5') {
  return /^#[0-9a-f]{6}$/i.test(_text(value)) ? _text(value) : fallback;
}

function buildReportPdf(payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 52, bufferPages: true, info: {
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
      const ACCENT = _safeColor(payload.color_accent || payload.project?.color_accent);
      const INK = '#172033';
      const MUTED = '#667085';
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
      const H = (title, size = 14, opts = {}) => {
        const indent = Math.max(0, Number(opts.indent) || 0);
        resetFlowX();
        ensureSpace(size + 30);
        doc.x = doc.page.margins.left + indent;
        if (opts.rule !== false) {
          const y = doc.y + 1;
          doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + (opts.ruleWidth || 3), y)
            .strokeColor(opts.ruleColor || ACCENT).lineWidth(opts.ruleWidth || 3).stroke();
        }
        doc.font(FONT_B).fontSize(size).fillColor(opts.color || INK).text(_md(title), {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right - indent,
          lineGap: opts.lineGap == null ? 2 : opts.lineGap,
        });
        resetFlowX();
        doc.moveDown(opts.after == null ? 0.18 : opts.after);
      };
      const P = (value, opts = {}) => {
        const text = _htmlToPlainText(value);
        if (!text) return;
        const indent = Math.max(0, Number(opts.indent) || 0);
        const width = opts.width || (doc.page.width - doc.page.margins.left - doc.page.margins.right - indent);
        ensureSpace(opts.minHeight || 24);
        doc.x = doc.page.margins.left + indent;
        doc.font(opts.bold ? FONT_B : FONT).fontSize(opts.size || 10).fillColor(opts.color || '#344054').text(text, {
          width,
          align: opts.align,
          lineGap: opts.lineGap == null ? 3 : opts.lineGap,
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

      const drawImage = (image, opts = {}) => {
        if (!image || !EXPORTABLE_PDF_TYPES.has(image.type)) return false;
        const maxWidth = opts.maxWidth || (doc.page.width - doc.page.margins.left - doc.page.margins.right);
        const maxHeight = opts.maxHeight || 220;
        const dimensions = constrainImage(image.buffer, image.type, maxWidth, maxHeight);
        ensureSpace(dimensions.height + 30);
        const x = doc.page.margins.left + (maxWidth - dimensions.width) / 2;
        const y = doc.y;
        try {
          doc.image(image.buffer, x, y, { width: dimensions.width, height: dimensions.height });
          doc.y = y + dimensions.height + 8;
          if (opts.caption) P(opts.caption, { size: 8, color: MUTED, align: 'center', minHeight: 12 });
          else doc.moveDown(0.2);
          resetFlowX();
          return true;
        } catch (_) {
          return false;
        }
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
      doc.rect(0, 0, doc.page.width, 13).fill(ACCENT);
      doc.moveDown(1.15);
      doc.font(FONT_B).fontSize(25).fillColor(INK).text(_text(payload.title || 'SEO-отчёт'), { align: 'center', lineGap: 3 });
      doc.moveDown(0.25);
      doc.font(FONT).fontSize(11).fillColor(MUTED).text(_text(payload.period || ''), { align: 'center' });
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
          const image = resolveReportImage(chart.data_url, chart.title || chart.key || '');
          if (!image || !EXPORTABLE_PDF_TYPES.has(image.type)) return;
          ensureSpace(250);
          resetFlowX();
          doc.font(FONT_B).fontSize(10.5).fillColor('#111827').text(_md(chart.title || chart.key || 'График'), {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            lineGap: 2,
          });
          doc.moveDown(0.15);
          if (!drawImage(image, { maxHeight: 225 })) {
            P('График не удалось встроить в PDF.', { color: MUTED });
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

      // ── Completed work: explicit task/subtask hierarchy ──
      const blocks = normalizeReportBlocks(_list(payload.tasks_blocks));
      const taskItems = _list(data.tasks?.items);
      if (blocks.length || taskItems.length) {
        H('Выполненные работы', 16, { ruleColor: ACCENT });
        if (blocks.length) {
          for (const monthBlock of blocks) {
            H(monthBlock.month || 'Период', 13, { ruleColor: '#818cf8' });
            for (const section of monthBlock.sections || []) {
              H(section.title || 'Раздел', 11.5, { ruleColor: '#c7d2fe', ruleWidth: 2, indent: 4 });
              for (const task of section.tasks || []) {
                const taskTitle = task.title || task.name || 'Задача';
                ensureSpace(58);
                doc.roundedRect(doc.page.margins.left, doc.y - 2, doc.page.width - doc.page.margins.left - doc.page.margins.right, 2, 1)
                  .fill(ACCENT);
                H(taskTitle, 13, { rule: false, indent: 8, after: 0.13 });
                const meta = [task.source || task.module, task.status, task.date || task.completed_at]
                  .filter(Boolean).join(' · ');
                if (meta) P(meta, { size: 8.4, color: MUTED, indent: 8, minHeight: 14 });
                const description = task.description_html || task.description || '';
                if (description) P(description, { size: 10, color: '#344054', indent: 8, lineGap: 3.4 });
                extractTaskImages(description).forEach((image) => {
                  if (EXPORTABLE_PDF_TYPES.has(image.type)) {
                    drawImage(image, { maxWidth: doc.page.width - doc.page.margins.left - doc.page.margins.right - 16, maxHeight: 220, caption: image.alt || '' });
                  }
                });
                for (const subtask of task.subtasks || []) {
                  H(subtask.title || 'Микрозадача', 10.5, {
                    ruleColor: '#d0d5dd', ruleWidth: 1.5, indent: 22, color: '#344054', after: 0.1,
                  });
                  const subDescription = subtask.description_html || subtask.description || '';
                  if (subDescription) P(subDescription, { size: 9.5, color: '#475467', indent: 30, lineGap: 3.1 });
                  extractTaskImages(subDescription).forEach((image) => {
                    if (EXPORTABLE_PDF_TYPES.has(image.type)) {
                      drawImage(image, { maxWidth: doc.page.width - doc.page.margins.left - doc.page.margins.right - 30, maxHeight: 190, caption: image.alt || '' });
                    }
                  });
                }
                rule('#eaecf0');
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

      // ── Separate AI appendix ──
      const aiMeta = payload.ai_metadata || summary.ai_metadata || {};
      const aiHasContent = Boolean(summary.executive_summary
        || summary.next_month_forecast
        || (Array.isArray(summary.highlights) && summary.highlights.length)
        || (Array.isArray(summary.growth_attribution) && summary.growth_attribution.length)
        || (Array.isArray(summary.quick_wins) && summary.quick_wins.length)
        || (Array.isArray(summary.vulnerabilities) && summary.vulnerabilities.length)
        || (Array.isArray(summary.roadmap) && summary.roadmap.length));
      doc.addPage();
      H('AI-анализ и рекомендации', 18, { ruleColor: ACCENT });
      P('Отдельное приложение с результатами AI-анализа, сохранёнными в отчёте. Экспорт не запускает новую генерацию.', {
        size: 9.5, color: MUTED, lineGap: 3,
      });
      drawTable(['Параметр', 'Значение'], [
        ['Статус', payload.ai_status || (aiHasContent ? 'done' : 'не сформирован')],
        ['Модель', aiMeta.model || '—'],
        ['Провайдер', aiMeta.provider || '—'],
        ['Сформирован', aiMeta.generated_at || payload.ai_generated_at || '—'],
        ['Токены input / output', `${_ru(aiMeta.tokens_in || 0)} / ${_ru(aiMeta.tokens_out || 0)}`],
      ], [190, 350]);
      if (!aiHasContent) {
        P('AI-анализ для этого отчёта ещё не сформирован. Сначала запустите AI-резюме, дождитесь статуса «Готово», затем скачайте файл повторно.', {
          size: 10, color: '#7a271a', lineGap: 3.4,
        });
      } else {
        if (summary.executive_summary) {
          H('Итоговый вывод', 13, { ruleColor: '#818cf8' });
          P(summary.executive_summary, { size: 10, lineGap: 3.4 });
        }
        if (summary.next_month_forecast) {
          H('Прогноз', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          P(summary.next_month_forecast, { size: 10 });
        }
        if (Array.isArray(summary.highlights) && summary.highlights.length) {
          H('Положительная динамика', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          summary.highlights.forEach((item) => {
            const text = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
            if (text) bullet(text);
          });
        }
        if (Array.isArray(summary.growth_attribution) && summary.growth_attribution.length) {
          H('Атрибуция роста', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          summary.growth_attribution.slice(0, 30).forEach((item) => {
            H(item.metric || 'Метрика', 10.5, { ruleColor: '#d0d5dd', ruleWidth: 1.5, indent: 8 });
            if (item.attribution) P(item.attribution, { size: 9.5, indent: 16 });
            if (item.conclusion) P(`Вывод: ${item.conclusion}`, { size: 9.5, indent: 16 });
            if (item.forecast) P(`Прогноз: ${item.forecast}`, { size: 9.5, indent: 16 });
            if (item.weak_zones) P(`Точки роста: ${item.weak_zones}`, { size: 9.5, indent: 16 });
          });
        }
        if (Array.isArray(summary.quick_wins) && summary.quick_wins.length) {
          H('Приоритетные действия', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          summary.quick_wins.slice(0, 30).forEach((item) => bullet(`${item.query || 'Запрос'} — ${item.plan || 'план не указан'}`, { size: 9.5 }));
        }
        if (Array.isArray(summary.vulnerabilities) && summary.vulnerabilities.length) {
          H('Риски', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          summary.vulnerabilities.slice(0, 30).forEach((item) => {
            const text = typeof item === 'string' ? item : `${item.title || item.name || ''} ${item.detail || item.description || item.action || ''}`.trim();
            if (text) bullet(text, { size: 9.5 });
          });
        }
        if (Array.isArray(summary.roadmap) && summary.roadmap.length) {
          H('Дорожная карта AI', 12, { ruleColor: '#c7d2fe', ruleWidth: 2 });
          const roadmapRows = summary.roadmap.slice(0, 30).map((item) => [
            item.period || item.month || item.stage || 'Шаг',
            item.title || item.action || item.task || '—',
            item.expected_result || item.result || item.impact || '—',
          ]);
          drawTable(['Период', 'Действие', 'Результат'], roadmapRows, [95, 245, 130]);
        }
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
