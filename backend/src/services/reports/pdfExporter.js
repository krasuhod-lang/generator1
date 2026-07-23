'use strict';

/**
 * reports/pdfExporter.js — серверный экспорт отчёта в PDF (ТЗ §1.4: «Экспорт
 * отчёта в PDF»). В отличие от html2canvas/jsPDF (клиент), рендерим на сервере
 * через PDFKit — текст остаётся выделяемым/искабельным, паритет с docxExporter.
 *
 * Кириллица: встроенный Helvetica (AFM) её не поддерживает, поэтому встраиваем
 * TTF DejaVuSans из backend/assets/fonts (доступен и на node:alpine, где нет
 * системных шрифтов).
 *
 * Контракт payload совпадает с docxExporter.buildReportDocx + payload.data.modules.
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

function _text(v) { return String(v == null ? '' : v).trim(); }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _ru(v) { return _num(v).toLocaleString('ru-RU'); }

/**
 * @param {object} payload {title, period, project:{name,url}, data, summary, tasks_blocks}
 * @returns {Promise<Buffer>}
 */
function buildReportPdf(payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
      const hasFont = fs.existsSync(FONT_REGULAR);
      if (hasFont) {
        doc.registerFont('body', FONT_REGULAR);
        if (fs.existsSync(FONT_BOLD)) doc.registerFont('bold', FONT_BOLD);
        else doc.registerFont('bold', FONT_REGULAR);
      }
      const FONT = hasFont ? 'body' : 'Helvetica';
      const FONT_B = hasFont ? 'bold' : 'Helvetica-Bold';

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const H = (text, size = 14) => {
        doc.moveDown(0.6).font(FONT_B).fontSize(size).fillColor('#111827').text(_text(text));
        doc.moveDown(0.2);
      };
      const P = (text, opts = {}) => {
        doc.font(FONT).fontSize(opts.size || 10).fillColor(opts.color || '#1f2937').text(_text(text), opts);
      };
      const bullet = (text) => {
        doc.font(FONT).fontSize(10).fillColor('#1f2937').text(`•  ${_text(text)}`, { indent: 8 });
      };

      // ── Title ──
      doc.font(FONT_B).fontSize(22).fillColor('#111827').text(_text(payload.title || 'SEO-отчёт'), { align: 'center' });
      doc.moveDown(0.2);
      doc.font(FONT).fontSize(11).fillColor('#6b7280').text(_text(payload.period || ''), { align: 'center' });
      doc.moveDown(0.6);
      if (payload.project?.name) P(`Проект: ${payload.project.name}`);
      if (payload.project?.url) P(`Сайт: ${payload.project.url}`);

      const data = payload.data || {};
      const summary = payload.summary || {};

      // ── KPI ──
      const kpi = [];
      const g = data.gsc?.totals;
      if (g) {
        kpi.push(`Google клики: ${_ru(g.clicks)}`);
        kpi.push(`Google показы: ${_ru(g.impressions)}`);
        if (g.ctr != null) kpi.push(`Google CTR: ${_num(g.ctr).toFixed(2)}%`);
        if (g.position != null) kpi.push(`Google ср. позиция: ${_num(g.position).toFixed(1)}`);
      }
      const y = data.ywm?.totals;
      if (y) {
        kpi.push(`Яндекс клики: ${_ru(y.clicks)}`);
        kpi.push(`Яндекс показы: ${_ru(y.impressions)}`);
      }
      const kc = data.keys_so?.current;
      if (kc) {
        if (kc.visibility != null) kpi.push(`Видимость Keys.so: ${_num(kc.visibility).toFixed(2)}`);
        kpi.push(`ТОП-10: ${_ru(kc.top10)}`);
      }
      if (kpi.length) { H('Ключевые показатели'); kpi.forEach(bullet); }

      // TZ Reports Fixes §4: снимаем markdown-звёздочки жирного (**...**) —
      // PDFKit не рендерит inline-bold внутри абзаца, а «сырые» ** портят текст.
      const _md = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1');

      if (summary.next_month_forecast) {
        H('Прогноз роста на следующий месяц', 12);
        P(_md(String(summary.next_month_forecast)));
      }

      if (Array.isArray(summary.highlights) && summary.highlights.length) {
        H('Главные достижения', 12);
        summary.highlights.forEach((item) => {
          const t = typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim();
          if (t) bullet(t);
        });
      }

      if (Array.isArray(summary.quick_wins) && summary.quick_wins.length) {
        H('Quick Wins', 12);
        summary.quick_wins.forEach((item) => bullet(
          `${item.query || 'Запрос'} — позиция ${item.position || '—'}. ${item.plan || ''}`.trim(),
        ));
      }
      if (summary.traffic_value) { H('SEO Traffic Value', 12); P(summary.traffic_value); }

      // ── Выполненные работы ──
      const blocks = payload.tasks_blocks || [];
      if (blocks.length) {
        H('Выполненные работы');
        for (const monthBlock of blocks) {
          doc.font(FONT_B).fontSize(11).fillColor('#111827').text(_text(monthBlock.month || monthBlock.section || 'Период'));
          for (const section of monthBlock.sections || []) {
            P(section.title || 'Раздел', { color: '#374151' });
            for (const task of section.tasks || []) bullet(task.title || 'Задача');
          }
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildReportPdf };
