'use strict';

/**
 * proposals/exportService.js — серверный экспорт КП («Фронт работ»).
 *
 *   buildProposalPdf(proposal)  → Buffer (PDF, pdfkit + DejaVuSans для кириллицы;
 *                                 медиа-план «месяцы × работы» + расшифровка работ
 *                                 по месяцам + стоимость)
 *   buildProposalXlsx(proposal) → Buffer (XLSX, exceljs: 4 листа —
 *                                 «Фронт работ», «Медиа-план» (месяцы × работы,
 *                                 закрашенные ячейки), «Стоимость» (с формулами),
 *                                 «Сводка»)
 *
 * Свёртку «работа → месяцы» и периодичность считает общий билдер
 * services/proposals/mediaPlan.js — тот же, что отдаёт публичная ссылка,
 * поэтому экран клиента, PDF и Excel всегда совпадают.
 *
 * proposal: { title, client, manager, horizon, start_date, created_at,
 *             tasks: [...proposal_tasks], pricing: [...proposal_pricing] }
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const { buildMediaPlan } = require('./mediaPlan');

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

/**
 * Таблица медиа-плана в PDF: слева работы (модуль + задача + периодичность),
 * сверху месяцы, закрашенная ячейка = работа выполняется в этом месяце.
 * Переносится на новую страницу с повтором шапки.
 */
function _drawMediaPlanTable(doc, plan, { FONT, FONT_B }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const monthCount = plan.months.length;
  const monthW = Math.max(26, Math.min(46, (right - left) * 0.45 / Math.max(monthCount, 1)));
  const titleW = right - left - monthW * monthCount;

  const drawHead = () => {
    const y = doc.y;
    doc.rect(left, y, right - left, 20).fill('#eef2ff');
    doc.font(FONT_B).fontSize(9).fillColor('#312e81')
      .text('Работа', left + 5, y + 6, { width: titleW - 10 });
    plan.months.forEach((m, i) => {
      doc.font(FONT_B).fontSize(8.5).fillColor('#312e81')
        .text(`М${m}`, left + titleW + i * monthW, y + 6, { width: monthW, align: 'center' });
    });
    doc.y = y + 20;
  };

  drawHead();

  for (const row of plan.rows) {
    const label = `${row.task_id ? `[${row.task_id}] ` : ''}${row.task_title}`;
    const sub = [row.module_name, row.recurrence_label].filter(Boolean).join(' · ');
    doc.font(FONT).fontSize(8.5);
    const labelH = doc.heightOfString(label, { width: titleW - 10 });
    doc.fontSize(7.5);
    const subH = sub ? doc.heightOfString(sub, { width: titleW - 10 }) : 0;
    const rowH = Math.max(20, labelH + subH + 8);

    if (doc.y + rowH > bottom) {
      doc.addPage();
      drawHead();
    }

    const y = doc.y;
    doc.font(FONT).fontSize(8.5).fillColor('#111827')
      .text(label, left + 5, y + 4, { width: titleW - 10 });
    if (sub) {
      doc.font(FONT).fontSize(7.5).fillColor('#6b7280')
        .text(sub, left + 5, y + 4 + labelH, { width: titleW - 10 });
    }
    plan.months.forEach((m, i) => {
      const x = left + titleW + i * monthW;
      const active = row.months.includes(m);
      doc.roundedRect(x + 3, y + 4, monthW - 6, Math.min(rowH - 8, 12), 3)
        .fillAndStroke(active ? '#6366f1' : '#f3f4f6', active ? '#4f46e5' : '#e5e7eb');
    });
    doc.strokeColor('#e5e7eb').lineWidth(0.5)
      .moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    doc.y = y + rowH;
    doc.x = left;
  }

  doc.moveDown(0.5);
  doc.font(FONT).fontSize(8).fillColor('#6b7280')
    .text('■ — месяц, в котором выполняется работа', left, doc.y);
  doc.fillColor('#1f2937');
}

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

      // Медиа-план: месяцы сверху, работы слева (тот же вид, что видит клиент
      // по публичной ссылке и на листе «Медиа-план» в Excel).
      const tasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
      const plan = buildMediaPlan(tasks, _num(proposal.horizon) || 3);
      const horizon = plan.horizon;
      if (plan.rows.length) {
        H('Медиа-план работ', 15);
        _drawMediaPlanTable(doc, plan, { FONT, FONT_B });
      }

      // Фронт работ по месяцам
      H('Расшифровка работ по месяцам', 15);
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

  // Лист 2 — «Медиа-план»: месяцы сверху, работы слева, закрашенные ячейки.
  const plan = buildMediaPlan(tasks, _num(proposal.horizon) || 3);
  const horizonMp = plan.horizon;
  const ws1b = wb.addWorksheet('Медиа-план');
  ws1b.columns = [
    { header: 'Модуль', key: 'module', width: 26 },
    { header: 'Задача', key: 'title', width: 44 },
    { header: 'Описание', key: 'description', width: 56 },
    { header: 'Периодичность', key: 'recurrence', width: 20 },
    ...Array.from({ length: horizonMp }, (_, i) => ({ header: `Месяц ${i + 1}`, key: `m${i + 1}`, width: 10 })),
  ];
  ws1b.getRow(1).font = { bold: true };
  ws1b.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  for (const rowData of plan.rows) {
    const row = ws1b.addRow({
      module: rowData.module_name,
      title: `${rowData.task_id ? `${rowData.task_id} · ` : ''}${rowData.task_title}`,
      description: rowData.task_description,
      recurrence: rowData.recurrence_label,
    });
    for (let m = 1; m <= horizonMp; m += 1) {
      if (rowData.months.includes(m)) {
        const cell = row.getCell(4 + m);
        cell.value = '✓';
        cell.alignment = { horizontal: 'center' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      }
    }
  }

  // Лист 3 — «Стоимость» (итоговые формулы Excel)
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

  // Лист 4 — «Сводка»
  const ws3 = wb.addWorksheet('Сводка');
  ws3.columns = [
    { header: 'Параметр', key: 'k', width: 32 },
    { header: 'Значение', key: 'v', width: 48 },
  ];
  ws3.getRow(1).font = { bold: true };
  const horizon = plan.horizon;
  ws3.addRows([
    { k: 'Название КП', v: _text(proposal.title) },
    { k: 'Клиент', v: _text(proposal.client) || '—' },
    { k: 'Менеджер', v: _text(proposal.manager) || '—' },
    { k: 'Горизонт', v: `${horizon} мес.` },
    { k: 'Дата начала', v: _date(proposal.start_date) },
    { k: 'Всего работ (уникальных)', v: plan.total_tasks },
    { k: 'Всего задач с учётом повторов', v: plan.total_slots },
  ]);
  for (let m = 1; m <= horizon; m += 1) {
    ws3.addRow({ k: `Задач в месяце ${m}`, v: plan.counts_by_month[m] || 0 });
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
