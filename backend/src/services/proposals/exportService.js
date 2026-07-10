'use strict';

/**
 * proposals/exportService.js — серверный экспорт КП («Фронт работ»).
 *
 *   buildProposalPdf(proposal)  → Buffer (PDF, pdfkit + DejaVuSans для кириллицы)
 *   buildProposalXlsx(proposal) → Buffer (XLSX, exceljs: 3 листа —
 *                                 «Фронт работ», «Стоимость» (с формулами), «Сводка»)
 *
 * proposal: { title, client, manager, horizon, start_date, created_at,
 *             tasks: [...proposal_tasks], pricing: [...proposal_pricing] }
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const FONT_DIR = path.join(__dirname, '../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const PRIORITY_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };

function _text(v) { return String(v == null ? '' : v).trim(); }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _money(v) { return _num(v).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function _date(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}

// Итоги стоимости: по месяцам (null = «Общее») и за весь период.
function buildPricingTotals(pricing = []) {
  const byMonth = new Map();
  let base = 0; let add = 0;
  for (const p of pricing) {
    const key = p.month == null ? 'total' : Number(p.month);
    if (!byMonth.has(key)) byMonth.set(key, { base: 0, add: 0 });
    const b = _num(p.base_budget);
    const a = _num(p.additional_budget);
    byMonth.get(key).base += b;
    byMonth.get(key).add += a;
    base += b; add += a;
  }
  return { byMonth, base, add, grand: base + add };
}

// ─────────────────────────────────────────────────────────────── PDF ──

function buildProposalPdf(proposal = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
      const hasFont = fs.existsSync(FONT_REGULAR);
      if (hasFont) {
        doc.registerFont('body', FONT_REGULAR);
        doc.registerFont('bold', fs.existsSync(FONT_BOLD) ? FONT_BOLD : FONT_REGULAR);
      }
      const FONT = hasFont ? 'body' : 'Helvetica';
      const FONT_B = hasFont ? 'bold' : 'Helvetica-Bold';

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const H = (t, size = 14) => {
        doc.moveDown(0.6).font(FONT_B).fontSize(size).fillColor('#111827').text(_text(t));
        doc.moveDown(0.2);
      };
      const P = (t, opts = {}) => {
        doc.font(FONT).fontSize(opts.size || 10).fillColor(opts.color || '#1f2937').text(_text(t), opts);
      };

      // Шапка
      doc.font(FONT_B).fontSize(18).fillColor('#111827').text(_text(proposal.title) || 'Коммерческое предложение');
      doc.moveDown(0.4);
      P(`Клиент: ${_text(proposal.client) || '—'}`);
      P(`Менеджер: ${_text(proposal.manager) || '—'}`);
      P(`Дата начала: ${_date(proposal.start_date)}`);
      P(`Горизонт: ${_num(proposal.horizon) || 3} мес.`);

      // Фронт работ по месяцам
      const tasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
      const horizon = _num(proposal.horizon) || 3;
      H('Фронт работ', 15);
      for (let m = 1; m <= horizon; m += 1) {
        const monthTasks = tasks.filter((t) => Number(t.month) === m);
        if (!monthTasks.length) continue;
        H(`Месяц ${m}`, 12);
        // Группировка по модулям
        const byModule = new Map();
        for (const t of monthTasks) {
          const key = _text(t.module_name) || `Модуль ${t.module_id || '—'}`;
          if (!byModule.has(key)) byModule.set(key, []);
          byModule.get(key).push(t);
        }
        for (const [modName, list] of byModule) {
          doc.font(FONT_B).fontSize(10.5).fillColor('#374151').text(modName);
          for (const t of list) {
            const prio = PRIORITY_LABEL[t.priority] || '—';
            doc.font(FONT).fontSize(9.5).fillColor('#1f2937')
              .text(`• [${_text(t.task_id) || '—'}] ${_text(t.task_title)} — приоритет: ${prio}${t.tool ? `, инструмент: ${_text(t.tool)}` : ''}${t.responsible ? `, исполнитель: ${_text(t.responsible)}` : ''}`, { indent: 12 });
            if (t.task_description) {
              doc.font(FONT).fontSize(8.5).fillColor('#6b7280')
                .text(_text(t.task_description), { indent: 24 });
            }
          }
          doc.moveDown(0.3);
        }
      }

      // Стоимость
      const pricing = Array.isArray(proposal.pricing) ? proposal.pricing : [];
      if (pricing.length) {
        H('Стоимость', 15);
        const totals = buildPricingTotals(pricing);
        const keys = [...totals.byMonth.keys()].sort((a, b) => {
          if (a === 'total') return 1;
          if (b === 'total') return -1;
          return a - b;
        });
        for (const key of keys) {
          const label = key === 'total' ? 'Общее (без привязки к месяцу)' : `Месяц ${key}`;
          H(label, 11);
          for (const p of pricing.filter((x) => (x.month == null ? 'total' : Number(x.month)) === key)) {
            const add = _num(p.additional_budget);
            let line = `• ${_text(p.item_name)} — ${_money(p.base_budget)} ${_text(p.currency) || 'RUB'}`;
            // Доп. бюджет попадает в экспорт только если заполнен (ТЗ §13).
            if (add > 0) line += ` + доп. ${_money(add)}${p.additional_note ? ` (${_text(p.additional_note)})` : ''}`;
            line += ` = итого ${_money(_num(p.base_budget) + add)}`;
            P(line, { size: 9.5 });
          }
          const t = totals.byMonth.get(key);
          doc.font(FONT_B).fontSize(9.5).fillColor('#111827')
            .text(`Итого: основной ${_money(t.base)} / доп. ${_money(t.add)} / общий ${_money(t.base + t.add)}`);
        }
        doc.moveDown(0.4);
        doc.font(FONT_B).fontSize(12).fillColor('#111827')
          .text(`Итого за весь период: ${_money(totals.grand)} RUB (основной ${_money(totals.base)} + доп. ${_money(totals.add)})`);
      }

      // Footer
      doc.moveDown(1.2);
      doc.font(FONT).fontSize(8.5).fillColor('#9ca3af')
        .text(`Документ сформирован: ${new Date().toLocaleString('ru-RU')}${proposal.manager ? ` • Контакт: ${_text(proposal.manager)}` : ''}`);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ────────────────────────────────────────────────────────────── XLSX ──

async function buildProposalXlsx(proposal = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEO Genius — Фронт работ';
  wb.created = new Date();

  const tasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
  const pricing = Array.isArray(proposal.pricing) ? proposal.pricing : [];
  const totals = buildPricingTotals(pricing);

  // Лист 1 — «Фронт работ»
  const ws1 = wb.addWorksheet('Фронт работ');
  ws1.columns = [
    { header: 'Месяц', key: 'month', width: 8 },
    { header: 'Модуль', key: 'module', width: 26 },
    { header: '№', key: 'task_id', width: 8 },
    { header: 'Задача', key: 'title', width: 44 },
    { header: 'Описание', key: 'description', width: 56 },
    { header: 'Приоритет', key: 'priority', width: 12 },
    { header: 'Инструмент', key: 'tool', width: 24 },
    { header: 'Исполнитель', key: 'responsible', width: 18 },
  ];
  ws1.getRow(1).font = { bold: true };
  const sorted = [...tasks].sort((a, b) => (Number(a.month) - Number(b.month)) || String(a.task_id).localeCompare(String(b.task_id), undefined, { numeric: true }));
  for (const t of sorted) {
    ws1.addRow({
      month: Number(t.month) || 1,
      module: _text(t.module_name),
      task_id: _text(t.task_id),
      title: _text(t.task_title),
      description: _text(t.task_description),
      priority: PRIORITY_LABEL[t.priority] || _text(t.priority),
      tool: _text(t.tool),
      responsible: _text(t.responsible),
    });
  }

  // Лист 2 — «Стоимость» (итоговые формулы Excel)
  const ws2 = wb.addWorksheet('Стоимость');
  ws2.columns = [
    { header: 'Статья', key: 'item', width: 36 },
    { header: 'Месяц', key: 'month', width: 10 },
    { header: 'Основной бюджет', key: 'base', width: 18 },
    { header: 'Доп. бюджет', key: 'add', width: 14 },
    { header: 'Описание доп. бюджета', key: 'note', width: 36 },
    { header: 'Итого', key: 'total', width: 14 },
    { header: 'Валюта', key: 'currency', width: 10 },
  ];
  ws2.getRow(1).font = { bold: true };
  let r = 1;
  for (const p of pricing) {
    r += 1;
    const add = _num(p.additional_budget);
    ws2.addRow({
      item: _text(p.item_name),
      month: p.month == null ? 'Общее' : Number(p.month),
      base: _num(p.base_budget),
      add: add > 0 ? add : null,
      note: add > 0 ? _text(p.additional_note) : '',
      currency: _text(p.currency) || 'RUB',
    });
    ws2.getCell(`F${r}`).value = { formula: `C${r}+IF(ISBLANK(D${r}),0,D${r})` };
  }
  if (r > 1) {
    const totalRow = r + 1;
    ws2.getCell(`A${totalRow}`).value = 'Итого за период';
    ws2.getCell(`A${totalRow}`).font = { bold: true };
    ws2.getCell(`C${totalRow}`).value = { formula: `SUM(C2:C${r})` };
    ws2.getCell(`D${totalRow}`).value = { formula: `SUM(D2:D${r})` };
    ws2.getCell(`F${totalRow}`).value = { formula: `SUM(F2:F${r})` };
    ws2.getRow(totalRow).font = { bold: true };
  }

  // Лист 3 — «Сводка»
  const ws3 = wb.addWorksheet('Сводка');
  ws3.columns = [
    { header: 'Параметр', key: 'k', width: 32 },
    { header: 'Значение', key: 'v', width: 48 },
  ];
  ws3.getRow(1).font = { bold: true };
  const horizon = _num(proposal.horizon) || 3;
  ws3.addRows([
    { k: 'Название КП', v: _text(proposal.title) },
    { k: 'Клиент', v: _text(proposal.client) || '—' },
    { k: 'Менеджер', v: _text(proposal.manager) || '—' },
    { k: 'Горизонт', v: `${horizon} мес.` },
    { k: 'Дата начала', v: _date(proposal.start_date) },
    { k: 'Всего задач', v: tasks.length },
  ]);
  for (let m = 1; m <= horizon; m += 1) {
    ws3.addRow({ k: `Задач в месяце ${m}`, v: tasks.filter((t) => Number(t.month) === m).length });
  }
  ws3.addRows([
    { k: 'Основной бюджет', v: `${_money(totals.base)} RUB` },
    { k: 'Доп. бюджет', v: `${_money(totals.add)} RUB` },
    { k: 'Итоговый бюджет', v: `${_money(totals.grand)} RUB` },
    { k: 'Дата формирования', v: new Date().toLocaleString('ru-RU') },
  ]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildProposalPdf, buildProposalXlsx, buildPricingTotals };
