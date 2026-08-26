'use strict';

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink,
  AlignmentType, ImageRun, PageBreak, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, Footer,
} = require('docx');
const { JSDOM } = require('jsdom');
const {
  normalizeReportBlocks,
  extractTaskImages,
  resolveReportImage,
  constrainImage,
  EXPORTABLE_DOCX_TYPES,
} = require('./reportContent');

const BODY_FONT = 'Aptos';
const DISPLAY_FONT = 'Aptos Display';
const INK = '172033';
const MUTED = '667085';
const ACCENT = '4F46E5';
const BORDER = 'D9DEEA';

function _text(v) { return String(v == null ? '' : v).trim(); }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _ru(v) { return _num(v).toLocaleString('ru-RU'); }
function _safeColor(value, fallback = ACCENT) {
  const clean = _text(value).replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(clean) ? clean.toUpperCase() : fallback;
}
function _safeHref(href) {
  const value = _text(href);
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : '';
}

function _heading(text, level = HeadingLevel.HEADING_2, opts = {}) {
  return new Paragraph({
    heading: level,
    keepNext: opts.keepNext !== false,
    spacing: { before: opts.before == null ? 240 : opts.before, after: opts.after == null ? 100 : opts.after, line: 280 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [new TextRun({
      text: _text(text),
      bold: true,
      font: opts.display ? DISPLAY_FONT : BODY_FONT,
      size: opts.size || (level === HeadingLevel.HEADING_1 ? 27 : level === HeadingLevel.HEADING_2 ? 20 : level === HeadingLevel.HEADING_3 ? 16 : level === HeadingLevel.HEADING_4 ? 15 : 13),
      color: opts.color || INK,
    })],
  });
}

function _paragraph(text, opts = {}) {
  return new Paragraph({
    alignment: opts.alignment,
    keepLines: opts.keepLines !== false,
    spacing: { before: opts.before || 0, after: opts.after == null ? 120 : opts.after, line: opts.line || 300 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [new TextRun({
      text: _text(text), font: opts.font || BODY_FONT, size: opts.size || 20,
      color: opts.color || '344054', bold: !!opts.bold, italics: !!opts.italics,
    })],
  });
}

// TZ Reports Fixes §4: AI-резюме содержит **жирные** тезисы (markdown).
// Разбиваем строку на обычные/жирные фрагменты для корректного DOCX.
function _richRuns(text, opts = {}) {
  const raw = String(text || '');
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0; let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: raw.slice(last, m.index), font: BODY_FONT, size: opts.size || 20, color: opts.color || '344054' }));
    runs.push(new TextRun({ text: m[1], bold: true, font: BODY_FONT, size: opts.size || 20, color: opts.color || INK }));
    last = m.index + m[0].length;
  }
  if (last < raw.length) runs.push(new TextRun({ text: raw.slice(last), font: BODY_FONT, size: opts.size || 20, color: opts.color || '344054' }));
  return runs.length ? runs : [new TextRun({ text: raw, font: BODY_FONT, size: opts.size || 20, color: opts.color || '344054' })];
}

function _richParagraph(text, opts = {}) {
  return new Paragraph({
    keepLines: true,
    spacing: { after: opts.after == null ? 120 : opts.after, line: opts.line || 300 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: _richRuns(String(text || '').trim(), opts),
  });
}

function _runsFromNode(node, inherited = {}) {
  if (!node) return [];
  if (node.nodeType === 3) {
    if (!node.textContent) return [];
    return [new TextRun({
      text: node.textContent,
      font: BODY_FONT,
      size: inherited.size || 20,
      color: inherited.color || '344054',
      bold: !!inherited.bold,
      italics: !!inherited.italics,
    })];
  }
  if (node.nodeType !== 1) return [];
  const tag = node.tagName;
  if (tag === 'IMG' || tag === 'BR' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return [];
  if (tag === 'A') {
    const href = _safeHref(node.getAttribute('href'));
    const children = Array.from(node.childNodes).flatMap((child) => _runsFromNode(child, { ...inherited, color: '3730A3' }));
    return href ? [new ExternalHyperlink({ children, link: href })] : children;
  }
  const next = {
    ...inherited,
    bold: inherited.bold || tag === 'STRONG' || tag === 'B',
    italics: inherited.italics || tag === 'EM' || tag === 'I',
  };
  return Array.from(node.childNodes).flatMap((child) => _runsFromNode(child, next));
}

function _paragraphFromNode(node, opts = {}) {
  const children = _runsFromNode(node, { size: opts.size || 20, color: opts.color || '344054' });
  if (!children.length) return null;
  return new Paragraph({
    keepLines: true,
    spacing: { after: opts.after == null ? 120 : opts.after, line: opts.line || 300 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children,
  });
}

function _htmlToParagraphs(html, opts = {}) {
  const value = _text(html);
  if (!value) return [];
  let root;
  try {
    root = new JSDOM(`<div>${value}</div>`).window.document.body.firstElementChild;
  } catch (_) {
    return [_richParagraph(value.replace(/<[^>]+>/g, ' '), opts)];
  }
  if (!root) return [];
  const out = [];
  const addNode = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      if (node.textContent.trim()) out.push(_richParagraph(node.textContent, opts));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'UL' || tag === 'OL') {
      Array.from(node.children).filter((item) => item.tagName === 'LI').forEach((li) => {
        const children = _runsFromNode(li, { size: opts.size || 20, color: opts.color || '344054' });
        if (children.length) out.push(new Paragraph({
          bullet: { level: 0 }, keepLines: true,
          spacing: { after: 60, line: 280 },
          indent: { left: (opts.indent || 0) + 220 }, children,
        }));
      });
      return;
    }
    if (tag === 'IMG' || tag === 'BR') return;
    const hasBlockChildren = Array.from(node.children).some((child) => ['P', 'DIV', 'UL', 'OL', 'BLOCKQUOTE'].includes(child.tagName));
    if (hasBlockChildren && !['P', 'BLOCKQUOTE'].includes(tag)) {
      Array.from(node.childNodes).forEach(addNode);
      return;
    }
    const p = _paragraphFromNode(node, opts);
    if (p) out.push(p);
  };
  Array.from(root.childNodes).forEach(addNode);
  return out;
}

function _imageParagraph(image, opts = {}) {
  if (!image || !EXPORTABLE_DOCX_TYPES.has(image.type)) return null;
  const transformation = constrainImage(image.buffer, image.type, opts.maxWidth || 640, opts.maxHeight || 300);
  const children = [new ImageRun({ data: image.buffer, type: image.type, transformation })];
  if (image.alt) children.push(new TextRun({ text: `\\n${image.alt}`, font: BODY_FONT, size: 16, color: MUTED, italics: true }));
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: false,
    spacing: { before: 100, after: 160 },
    children,
  });
}

function _addChart(children, item, accent = ACCENT) {
  const image = resolveReportImage(item?.data_url, item?.title || item?.key || '');
  if (!image || !EXPORTABLE_DOCX_TYPES.has(image.type)) return;
  children.push(_heading(item.title || item.key || 'График', HeadingLevel.HEADING_3, { color: accent, size: 14, before: 160 }));
  const paragraph = _imageParagraph(image, { maxWidth: 640, maxHeight: 280 });
  if (paragraph) children.push(paragraph);
}

function _metaTable(rows) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: BORDER };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map(([label, value], index) => new TableRow({ children: [
      new TableCell({
        width: { size: 34, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: index === 0 ? 'EEF0FF' : 'F8F9FC' },
        children: [_paragraph(label, { size: 18, bold: true, color: ACCENT, after: 50 })],
      }),
      new TableCell({
        width: { size: 66, type: WidthType.PERCENTAGE },
        children: [_paragraph(value, { size: 18, color: '344054', after: 50 })],
      }),
    ] })),
  });
}

function _hasAiContent(summary = {}) {
  return Boolean(summary.executive_summary || summary.next_month_forecast
    || (Array.isArray(summary.highlights) && summary.highlights.length)
    || (Array.isArray(summary.growth_attribution) && summary.growth_attribution.length)
    || (Array.isArray(summary.quick_wins) && summary.quick_wins.length)
    || (Array.isArray(summary.vulnerabilities) && summary.vulnerabilities.length)
    || (Array.isArray(summary.roadmap) && summary.roadmap.length));
}

async function buildReportDocx(payload = {}) {
  const children = [];
  const accent = _safeColor(payload.color_accent);
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text: _text(payload.title || 'SEO-отчёт'), bold: true, font: DISPLAY_FONT, size: 34, color: INK })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 260 },
    children: [new TextRun({ text: _text(payload.period || ''), font: BODY_FONT, size: 21, color: MUTED })],
  }));
  if (payload.project?.name) children.push(_paragraph(`Проект: ${payload.project.name}`, { size: 20, bold: true, color: INK }));
  if (payload.project?.url) children.push(_paragraph(`Сайт: ${payload.project.url}`, { size: 20, color: '3730A3' }));

  const kpiLines = [];
  const gscTotals = payload.data?.gsc?.totals;
  if (gscTotals) {
    kpiLines.push(['Google клики', _ru(gscTotals.clicks)]);
    kpiLines.push(['Google показы', _ru(gscTotals.impressions)]);
    if (gscTotals.ctr != null) kpiLines.push(['Google CTR', `${_num(gscTotals.ctr).toFixed(2)}%`]);
    if (gscTotals.position != null) kpiLines.push(['Google средняя позиция', _num(gscTotals.position).toFixed(1)]);
  }
  const ywmTotals = payload.data?.ywm?.totals;
  if (ywmTotals) {
    kpiLines.push(['Яндекс клики', _ru(ywmTotals.clicks)]);
    kpiLines.push(['Яндекс показы', _ru(ywmTotals.impressions)]);
    if (ywmTotals.ctr != null) kpiLines.push(['Яндекс CTR', `${_num(ywmTotals.ctr).toFixed(2)}%`]);
  }
  const keysCurrent = payload.data?.keys_so?.current;
  if (keysCurrent) {
    if (keysCurrent.visibility != null) kpiLines.push(['Видимость Keys.so', _num(keysCurrent.visibility).toFixed(2)]);
    kpiLines.push(['ТОП-10', _ru(keysCurrent.top10)]);
    kpiLines.push(['ТОП-50', _ru(keysCurrent.top50)]);
  }
  if (kpiLines.length) {
    children.push(_heading('Ключевые показатели', HeadingLevel.HEADING_1, { color: accent, display: true }));
    children.push(_metaTable(kpiLines));
  }

  if (payload.summary?.executive_summary) {
    children.push(_heading('Резюме для руководителя', HeadingLevel.HEADING_2, { color: accent }));
    children.push(_richParagraph(payload.summary.executive_summary, { size: 20, line: 320 }));
  }
  if (payload.summary?.next_month_forecast) {
    children.push(_heading('Прогноз на следующий месяц', HeadingLevel.HEADING_2, { color: accent }));
    children.push(_richParagraph(payload.summary.next_month_forecast, { size: 20, line: 320 }));
  }
  if (payload.summary?.highlights?.length) {
    children.push(_heading('Главные достижения', HeadingLevel.HEADING_2, { color: accent }));
    payload.summary.highlights.forEach((item) => {
      const text = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
      if (text) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 70, line: 280 }, children: _richRuns(text, { size: 20 }) }));
    });
  }

  const charts = Array.isArray(payload.chart_images) ? payload.chart_images : [];
  if (charts.length) {
    children.push(_heading('Графики динамики', HeadingLevel.HEADING_1, { color: accent, display: true }));
    charts.forEach((chart) => _addChart(children, chart, accent));
  }
  if (payload.summary?.growth_attribution?.length) {
    children.push(_heading('Анализ динамики и точки роста', HeadingLevel.HEADING_1, { color: accent, display: true }));
    payload.summary.growth_attribution.forEach((item) => {
      if (!item) return;
      children.push(_heading(item.metric || 'Метрика', HeadingLevel.HEADING_3, { color: accent, size: 14 }));
      if (item.attribution) children.push(_richParagraph(item.attribution));
      if (item.conclusion) children.push(_paragraph(`Вывод: ${item.conclusion}`));
      if (item.forecast) children.push(_paragraph(`Прогноз: ${item.forecast}`));
      if (item.weak_zones) children.push(_paragraph(`Точки роста: ${item.weak_zones}`));
    });
  }
  if (payload.summary?.quick_wins?.length) {
    children.push(_heading('Quick Wins', HeadingLevel.HEADING_2, { color: accent }));
    payload.summary.quick_wins.forEach((item) => children.push(new Paragraph({
      bullet: { level: 0 }, spacing: { after: 70, line: 280 },
      children: _richRuns(`${item.query || 'Запрос'} — позиция ${item.position || '—'}. ${item.plan || ''}`.trim(), { size: 20 }),
    })));
  }
  if (payload.summary?.traffic_value) {
    children.push(_heading('Стоимость SEO-трафика', HeadingLevel.HEADING_2, { color: accent }));
    children.push(_paragraph(payload.summary.traffic_value));
  }

  const blocks = normalizeReportBlocks(Array.isArray(payload.tasks_blocks) ? payload.tasks_blocks : []);
  if (blocks.length) {
    children.push(_heading('Выполненные работы', HeadingLevel.HEADING_1, { color: accent, display: true }));
    for (const monthBlock of blocks) {
      children.push(_heading(monthBlock.month || 'Период', HeadingLevel.HEADING_2, { color: accent }));
      for (const section of monthBlock.sections || []) {
        children.push(_heading(section.title || 'Раздел', HeadingLevel.HEADING_3, { color: accent, size: 16 }));
        for (const task of section.tasks || []) {
          children.push(_heading(task.title || task.name || 'Задача', HeadingLevel.HEADING_4, { color: INK, size: 15, before: 180 }));
          const meta = [task.source || task.module, task.status, task.date || task.completed_at].filter(Boolean).join(' · ');
          if (meta) children.push(_paragraph(meta, { size: 16, color: MUTED, after: 80 }));
          const description = task.description_html || task.description || '';
          if (description) children.push(..._htmlToParagraphs(description, { size: 20, line: 320, indent: 220 }));
          extractTaskImages(description).forEach((image) => {
            const p = _imageParagraph(image, { maxWidth: 620, maxHeight: 300 });
            if (p) children.push(p);
          });
          for (const subtask of task.subtasks || []) {
            children.push(_heading(subtask.title || 'Микрозадача', HeadingLevel.HEADING_5, { color: '475467', size: 13, indent: 360, before: 140 }));
            const subDescription = subtask.description_html || subtask.description || '';
            if (subDescription) children.push(..._htmlToParagraphs(subDescription, { size: 19, line: 300, indent: 520 }));
            extractTaskImages(subDescription).forEach((image) => {
              const p = _imageParagraph(image, { maxWidth: 560, maxHeight: 260 });
              if (p) children.push(p);
            });
          }
        }
      }
    }
  }

  const sources = Array.isArray(payload.data?.sources || payload.data?.provenance?.sources || payload.summary?.sources)
    ? (payload.data?.sources || payload.data?.provenance?.sources || payload.summary?.sources) : [];
  if (sources.length) {
    children.push(_heading('Источники данных', HeadingLevel.HEADING_1, { color: accent, display: true }));
    sources.slice(0, 40).forEach((source) => {
      const url = typeof source === 'string' ? source : source.url || source.source_url || '';
      const label = typeof source === 'string' ? source : source.title || source.name || url;
      if (label) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60, line: 280 }, children: [new TextRun({ text: url && url !== label ? `${label}: ${url}` : label, font: BODY_FONT, size: 18, color: '344054' })] }));
    });
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(_heading('AI-анализ и рекомендации', HeadingLevel.HEADING_1, { color: accent, display: true }));
  children.push(_paragraph('Отдельное приложение с результатами AI-анализа, сохранёнными в отчёте. Экспорт не запускает новую генерацию.', { size: 18, color: MUTED, line: 280 }));
  const aiMeta = payload.ai_metadata || payload.summary?.ai_metadata || {};
  const aiHasContent = _hasAiContent(payload.summary || {});
  children.push(_metaTable([
    ['Статус', payload.ai_status || (aiHasContent ? 'done' : 'не сформирован')],
    ['Модель', aiMeta.model || '—'],
    ['Провайдер', aiMeta.provider || '—'],
    ['Сформирован', aiMeta.generated_at || payload.ai_generated_at || '—'],
    ['Токены input / output', `${_ru(aiMeta.tokens_in || 0)} / ${_ru(aiMeta.tokens_out || 0)}`],
  ]));
  if (!aiHasContent) {
    children.push(_paragraph('AI-анализ для этого отчёта ещё не сформирован. Запустите AI-резюме, дождитесь статуса «Готово», затем скачайте файл повторно.', { size: 20, color: '7A271A', before: 180, line: 320 }));
  } else {
    if (payload.summary?.executive_summary) {
      children.push(_heading('Итоговый вывод', HeadingLevel.HEADING_2, { color: accent }));
      children.push(_richParagraph(payload.summary.executive_summary, { size: 20, line: 320 }));
    }
    if (payload.summary?.next_month_forecast) {
      children.push(_heading('Прогноз', HeadingLevel.HEADING_2, { color: accent }));
      children.push(_richParagraph(payload.summary.next_month_forecast, { size: 20, line: 320 }));
    }
    if (payload.summary?.highlights?.length) {
      children.push(_heading('Положительная динамика', HeadingLevel.HEADING_2, { color: accent }));
      payload.summary.highlights.forEach((item) => {
        const text = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
        if (text) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 70, line: 280 }, children: _richRuns(text, { size: 20 }) }));
      });
    }
    if (payload.summary?.growth_attribution?.length) {
      children.push(_heading('Атрибуция роста', HeadingLevel.HEADING_2, { color: accent }));
      payload.summary.growth_attribution.slice(0, 30).forEach((item) => {
        children.push(_heading(item.metric || 'Метрика', HeadingLevel.HEADING_3, { color: accent, size: 14 }));
        if (item.attribution) children.push(_richParagraph(item.attribution, { size: 19 }));
        if (item.conclusion) children.push(_paragraph(`Вывод: ${item.conclusion}`, { size: 19 }));
        if (item.forecast) children.push(_paragraph(`Прогноз: ${item.forecast}`, { size: 19 }));
        if (item.weak_zones) children.push(_paragraph(`Точки роста: ${item.weak_zones}`, { size: 19 }));
      });
    }
    if (payload.summary?.quick_wins?.length) {
      children.push(_heading('Приоритетные действия', HeadingLevel.HEADING_2, { color: accent }));
      payload.summary.quick_wins.slice(0, 30).forEach((item) => children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 70, line: 280 }, children: _richRuns(`${item.query || 'Запрос'} — ${item.plan || 'план не указан'}`, { size: 19 }) })));
    }
    if (payload.summary?.vulnerabilities?.length) {
      children.push(_heading('Риски', HeadingLevel.HEADING_2, { color: accent }));
      payload.summary.vulnerabilities.slice(0, 30).forEach((item) => {
        const text = typeof item === 'string' ? item : `${item.title || item.name || ''} ${item.detail || item.description || item.action || ''}`.trim();
        if (text) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 70, line: 280 }, children: _richRuns(text, { size: 19 }) }));
      });
    }
    if (payload.summary?.roadmap?.length) {
      children.push(_heading('Дорожная карта AI', HeadingLevel.HEADING_2, { color: accent }));
      payload.summary.roadmap.slice(0, 30).forEach((item) => children.push(_paragraph(`${item.period || item.month || item.stage || 'Шаг'}: ${item.title || item.action || item.task || '—'} — ${item.expected_result || item.result || item.impact || '—'}`, { size: 19 })));
    }
  }

  const doc = new Document({
    creator: 'generator1',
    title: _text(payload.title || 'SEO-отчёт'),
    description: 'Premium SEO performance report',
    styles: { default: { document: { run: { font: BODY_FONT, size: 20, color: '344054' }, paragraph: { spacing: { after: 120, line: 300 } } } } },
    sections: [{
      properties: { page: { margin: { top: 720, right: 900, bottom: 720, left: 900 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 140 }, children: [new TextRun({ text: 'generator1 · SEO report', font: BODY_FONT, size: 15, color: MUTED })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
