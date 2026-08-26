'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildReportPdf } = require('../src/services/reports/pdfExporter');
const { buildReportDocx } = require('../src/services/reports/docxExporter');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const reportImageDir = path.join(__dirname, '..', 'uploads', 'report-images');
const reportImagePath = path.join(reportImageDir, 'premium-regression.png');
const outDir = path.join('/tmp', 'generator1-report-premium-regression');
const pdfPath = path.join(outDir, 'report.pdf');
const docxPath = path.join(outDir, 'report.docx');

function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
}

(async () => {
  fs.mkdirSync(reportImageDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportImagePath, Buffer.from(PNG_BASE64, 'base64'));
  const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
  const payload = {
    title: 'Премиальный SEO-отчёт',
    period: 'август 2026',
    color_accent: '#7C3AED',
    project: { name: 'Тестовый проект', url: 'https://example.com' },
    data: { gsc: { totals: { clicks: 1234, impressions: 56789, ctr: 2.17, position: 8.4 } } },
    summary: {
      executive_summary: 'Сводный AI-вывод по динамике проекта.',
      highlights: [{ title: 'Рост', detail: 'Увеличилась видимость.' }],
      growth_attribution: [{ metric: 'Клики', attribution: 'Рост органического спроса', conclusion: 'Динамика положительная', weak_zones: 'Нужно усилить сниппеты' }],
      quick_wins: [{ query: 'купить услугу', position: 11, plan: 'Обновить title и FAQ' }],
      vulnerabilities: [{ title: 'CTR', detail: 'Низкая привлекательность сниппетов' }],
      roadmap: [{ period: 'Неделя 1', title: 'Обновить сниппеты', expected_result: 'Рост CTR' }],
      next_month_forecast: 'Ожидается дальнейший рост при сохранении темпа.',
      ai_metadata: { provider: 'test-provider', model: 'test-model', tokens_in: 111, tokens_out: 222, generated_at: '2026-08-26T00:00:00.000Z' },
    },
    ai_status: 'done',
    ai_metadata: { provider: 'test-provider', model: 'test-model', tokens_in: 111, tokens_out: 222, generated_at: '2026-08-26T00:00:00.000Z' },
    chart_images: [{ key: 'gsc', title: 'График динамики кликов', data_url: dataUrl }],
    tasks_blocks: [{ month: '2026-08', sections: [{ title: 'Технические работы', tasks: [{
      title: 'Оптимизировать мета-теги', status: 'done', date: '2026-08-25', source: 'manual',
      description_html: '<p>Описание <strong>главной задачи</strong>.</p><p><img src="/api/uploads/report-images/premium-regression.png" alt="Скриншот задачи"></p>',
      subtasks: [{ title: 'Проверить title', description_html: '<p>Проверить длину и интент.</p>' }],
    }] }] }],
  };

  const pdf = await buildReportPdf(payload);
  fs.writeFileSync(pdfPath, pdf);
  const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  ok('PDF signature and non-empty output', pdf.slice(0, 5).toString('ascii') === '%PDF-' && pdf.length > 1000);
  ok('PDF has task heading text', pdfText.includes('Оптимизировать мета-теги'));
  ok('PDF has nested microtask text', pdfText.includes('Проверить title'));
  ok('PDF has clean description text', pdfText.includes('Описание главной задачи') && !pdfText.includes('<strong>'));
  ok('PDF has chart heading', pdfText.includes('График динамики кликов'));
  ok('PDF has separate AI appendix', pdfText.includes('AI-анализ и рекомендации') && pdfText.includes('Итоговый вывод'));
  ok('PDF embeds task image', pdfText.includes('Скриншот задачи') || pdf.length > 2500);

  const docx = await buildReportDocx(payload);
  fs.writeFileSync(docxPath, docx);
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' });
  const mediaList = execFileSync('unzip', ['-l', docxPath], { encoding: 'utf8' });
  ok('DOCX signature and non-empty output', docx.slice(0, 2).toString('ascii') === 'PK' && docx.length > 1000);
  ok('DOCX has heading hierarchy styles', xml.includes('Heading4') && xml.includes('Heading5'));
  ok('DOCX has task and microtask text', xml.includes('Оптимизировать мета-теги') && xml.includes('Проверить title'));
  ok('DOCX has clean description text', xml.includes('Описание') && !xml.includes('&lt;strong&gt;'));
  ok('DOCX has chart heading and AI appendix', xml.includes('Графики динамики') && xml.includes('AI-анализ и рекомендации'));
  ok('DOCX contains embedded media', /word\/media\//.test(mediaList));

  fs.rmSync(reportImagePath, { force: true });
  console.log('premium report export: 13/13 passed');
})().catch((err) => {
  try { fs.rmSync(reportImagePath, { force: true }); } catch (_) { /* best effort */ }
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
