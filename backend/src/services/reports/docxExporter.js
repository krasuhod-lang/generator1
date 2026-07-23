'use strict';

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink,
  AlignmentType, ImageRun,
} = require('docx');
const { JSDOM } = require('jsdom');

function _text(v) { return String(v || '').trim(); }
function _safeHref(href) {
  const value = _text(href);
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : '';
}

function _parseBase64Image(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(?:png|jpeg);base64,(.+)$/i);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

function _heading(text, level = HeadingLevel.HEADING_2) {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: _text(text), bold: true })],
  });
}

function _paragraph(text) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun(_text(text))],
  });
}

// TZ Reports Fixes §4: AI-резюме содержит **жирные** тезисы (markdown).
// Разбиваем строку на обычные/жирные фрагменты для корректного DOCX.
function _richRuns(text) {
  const raw = String(text || '');
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) runs.push(new TextRun(raw.slice(last, m.index)));
    runs.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }
  if (last < raw.length) runs.push(new TextRun(raw.slice(last)));
  return runs.length ? runs : [new TextRun(raw)];
}

function _richParagraph(text) {
  return new Paragraph({ spacing: { after: 120 }, children: _richRuns(String(text || '').trim()) });
}

function _htmlToParagraphs(html) {
  const value = _text(html);
  if (!value) return [];
  const dom = new JSDOM(`<div>${value}</div>`);
  const root = dom.window.document.body.firstElementChild;
  const out = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      const plain = node.textContent.trim();
      if (plain) out.push(_paragraph(plain));
      continue;
    }
    if (!node.textContent.trim()) continue;
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      Array.from(node.querySelectorAll('li')).forEach((li) => {
        out.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [new TextRun(li.textContent.trim())],
        }));
      });
      continue;
    }
    if (node.tagName === 'A' && _safeHref(node.getAttribute('href'))) {
      out.push(new Paragraph({
        spacing: { after: 120 },
        children: [
          new ExternalHyperlink({
            children: [new TextRun({ text: node.textContent.trim(), style: 'Hyperlink' })],
            link: _safeHref(node.getAttribute('href')),
          }),
        ],
      }));
      continue;
    }
    const links = Array.from(node.querySelectorAll('a[href]'));
    if (!links.length) {
      out.push(_paragraph(node.textContent.trim()));
      continue;
    }
    const children = [];
    let cursor = 0;
    const full = node.textContent || '';
    for (const link of links) {
      const text = link.textContent || '';
      const idx = full.indexOf(text, cursor);
      if (idx > cursor) children.push(new TextRun(full.slice(cursor, idx)));
      const href = _safeHref(link.getAttribute('href'));
      if (!href) continue;
      children.push(new ExternalHyperlink({
        children: [new TextRun({ text, style: 'Hyperlink' })],
        link: href,
      }));
      cursor = idx + text.length;
    }
    if (cursor < full.length) children.push(new TextRun(full.slice(cursor)));
    out.push(new Paragraph({ spacing: { after: 120 }, children }));
  }
  return out.length ? out : [_paragraph(root.textContent.trim())];
}

function _addChart(children, item) {
  const img = _parseBase64Image(item?.data_url);
  if (!img) return;
  children.push(_heading(item.title || 'График', HeadingLevel.HEADING_3));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: [new ImageRun({ data: img, transformation: { width: 640, height: 240 } })],
  }));
}

async function buildReportDocx(payload = {}) {
  const children = [];
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: [new TextRun({ text: _text(payload.title || 'SEO-отчёт'), bold: true, size: 34 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 260 },
    children: [new TextRun({ text: _text(payload.period || ''), color: '666666' })],
  }));

  if (payload.project?.name) children.push(_paragraph(`Проект: ${payload.project.name}`));
  if (payload.project?.url) children.push(_paragraph(`Сайт: ${payload.project.url}`));

  // KPI Totals
  const kpiLines = [];
  const gscTotals = payload.data?.gsc?.totals;
  if (gscTotals) {
    kpiLines.push(`Google клики: ${Number(gscTotals.clicks || 0).toLocaleString('ru-RU')}`);
    kpiLines.push(`Google показы: ${Number(gscTotals.impressions || 0).toLocaleString('ru-RU')}`);
    if (gscTotals.ctr != null) kpiLines.push(`Google CTR: ${Number(gscTotals.ctr).toFixed(2)}%`);
    if (gscTotals.position != null) kpiLines.push(`Google ср. позиция: ${Number(gscTotals.position).toFixed(1)}`);
  }
  const ywmTotals = payload.data?.ywm?.totals;
  if (ywmTotals) {
    kpiLines.push(`Яндекс клики: ${Number(ywmTotals.clicks || 0).toLocaleString('ru-RU')}`);
    kpiLines.push(`Яндекс показы: ${Number(ywmTotals.impressions || 0).toLocaleString('ru-RU')}`);
    if (ywmTotals.ctr != null) kpiLines.push(`Яндекс CTR: ${Number(ywmTotals.ctr).toFixed(2)}%`);
  }
  const keysCurrent = payload.data?.keys_so?.current;
  if (keysCurrent) {
    if (keysCurrent.visibility != null) kpiLines.push(`Видимость Keys.so: ${Number(keysCurrent.visibility).toFixed(2)}`);
    kpiLines.push(`ТОП-10: ${Number(keysCurrent.top10 || 0).toLocaleString('ru-RU')}`);
    kpiLines.push(`ТОП-50: ${Number(keysCurrent.top50 || 0).toLocaleString('ru-RU')}`);
  }
  if (kpiLines.length) {
    children.push(_heading('Ключевые показатели'));
    kpiLines.forEach((line) => {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun(line)] }));
    });
  }

  if (payload.summary?.executive_summary) {
    children.push(_heading('Executive Summary'));
    for (const part of String(payload.summary.executive_summary).split(/\n{2,}/)) {
      if (part.trim()) children.push(_richParagraph(part.trim()));
    }
  } else {
    children.push(_heading('Executive Summary'));
    children.push(_paragraph('Резюме не сформировано. Сгенерируйте AI-резюме в редакторе отчёта.'));
  }

  if (payload.summary?.next_month_forecast) {
    children.push(_heading('Прогноз роста на следующий месяц'));
    children.push(_richParagraph(String(payload.summary.next_month_forecast)));
  }

  if (payload.summary?.highlights?.length) {
    children.push(_heading('Главные достижения'));
    payload.summary.highlights.forEach((item) => {
      const text = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
      if (!text) return;
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun(text)] }));
    });
  }

  for (const chart of payload.chart_images || []) _addChart(children, chart);

  if (payload.summary?.growth_attribution?.length) {
    children.push(_heading('Анализ показателей'));
    payload.summary.growth_attribution.forEach((item) => {
      if (!item) return;
      children.push(_heading(item.metric || 'Метрика', HeadingLevel.HEADING_3));
      if (item.attribution) children.push(_paragraph(item.attribution));
      if (item.conclusion) children.push(_paragraph(`Вывод: ${item.conclusion}`));
      if (item.forecast) children.push(_paragraph(`Прогноз: ${item.forecast}`));
      if (item.weak_zones) children.push(_paragraph(`Точки роста: ${item.weak_zones}`));
    });
  }

  if (payload.summary?.quick_wins?.length) {
    children.push(_heading('Quick Wins'));
    payload.summary.quick_wins.forEach((item) => {
      children.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 60 },
        children: [new TextRun(`${item.query || 'Запрос'} — позиция ${item.position || '—'}. ${item.plan || ''}`.trim())],
      }));
    });
  }

  if (payload.summary?.traffic_value) {
    children.push(_heading('SEO Traffic Value'));
    children.push(_paragraph(payload.summary.traffic_value));
  }

  if (payload.tasks_blocks?.length) {
    children.push(_heading('Выполненные работы'));
    for (const monthBlock of payload.tasks_blocks) {
      children.push(_heading(monthBlock.month || monthBlock.section || 'Период', HeadingLevel.HEADING_3));
      for (const section of monthBlock.sections || []) {
        children.push(_paragraph(section.title || 'Раздел'));
        for (const task of section.tasks || []) {
          children.push(new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80 },
            children: [new TextRun({ text: task.title || 'Задача', bold: true })],
          }));
          for (const p of _htmlToParagraphs(task.description_html || '')) children.push(p);
        }
      }
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
