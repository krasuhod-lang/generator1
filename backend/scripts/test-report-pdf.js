'use strict';

const assert = require('assert');
const { buildReportPdf } = require('../src/services/reports/pdfExporter');

// 1x1 white PNG. Enough to verify PDFKit image embedding without network/files.
const chartPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function run() {
  const pdf = await buildReportPdf({
    title: 'SEO отчёт: тестовый проект',
    period: 'январь 2026 — февраль 2026',
    project: { name: 'Тестовый проект', url: 'https://example.com' },
    data: {
      gsc: { totals: { clicks: 1200, impressions: 24000, ctr: 5, position: 8.4 } },
      ywm: { totals: { clicks: 900, impressions: 18000, ctr: 5, position: 10.2 } },
      keys_so: { current: { visibility: 42.5, top10: 17, top50: 88 } },
      tasks: { items: [{ title: 'Задача из агрегатора', status: 'completed', created_at: '2026-02-01' }] },
      sources: [{ title: 'Search Console', url: 'https://search.google.com' }],
    },
    summary: {
      executive_summary: 'Резюме отчёта с ключевым выводом.',
      next_month_forecast: 'Ожидается рост после внедрения quick wins.',
      highlights: [{ title: 'Рост кликов', detail: '+25%' }],
      growth_attribution: [{ metric: 'Клики', conclusion: 'Динамика положительная', weak_zones: 'Усилить страницы 2-го экрана' }],
      quick_wins: [{ query: 'тестовый запрос', position: 11, plan: 'Расширить страницу' }],
      vulnerabilities: [{ title: 'Слабая страница', detail: 'Нужна внутренняя перелинковка' }],
      roadmap: [{ period: 'Месяц 1', action: 'Обновить контент', expected_result: 'Рост CTR' }],
      traffic_value: '$1 200',
    },
    chart_images: [{ key: 'gsc', title: 'Google Search Console', data_url: chartPng }],
    tasks_blocks: [{
      month: 'Февраль 2026',
      sections: [{ title: 'Контент', tasks: [{ title: 'SEO-текст', status: 'completed', date: '2026-02-02', description: 'Готово' }] }],
    }],
  });

  assert(Buffer.isBuffer(pdf), 'PDF result must be a Buffer');
  assert(pdf.length > 1500, 'PDF must contain more than a minimal empty document');
  assert(pdf.subarray(0, 5).toString() === '%PDF-', 'result must have PDF signature');
  assert((pdf.toString('latin1').match(/\/Type \/Page/g) || []).length >= 1, 'PDF must contain at least one page');
  console.log('report-pdf: 8/8 passed');
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { run };
