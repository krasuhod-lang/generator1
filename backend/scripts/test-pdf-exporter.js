'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildReportPdf } = require('../src/services/reports/pdfExporter');

const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/reports.controller.js'), 'utf8');
const draftPdfStart = controllerSource.indexOf('async function exportDraftPdf');
const draftPdfEnd = controllerSource.indexOf('async function publicUnlock', draftPdfStart);
const draftPdfSource = controllerSource.slice(draftPdfStart, draftPdfEnd > draftPdfStart ? draftPdfEnd : undefined);
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function commandText(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const pdf = await buildReportPdf({
    title: 'PDF exporter regression',
    period: 'январь 2026 г. — август 2026 г.',
    project: { name: 'Test project', url: 'https://example.com' },
    data: {
      tasks: { items: [] },
    },
    summary: {
      executive_summary: 'Краткое резюме для проверки экспорта.',
      highlights: ['Первый тезис'],
      next_month_forecast: 'Прогноз без HTML.',
    },
    chart_images: [{ key: 'gsc', title: 'График динамики Google', data_url: `data:image/png;base64,${ONE_PIXEL_PNG}` }],
    tasks_blocks: [{
      month: '2026-08',
      sections: [{
        title: 'Контент и ссылки',
        tasks: [{
          title: 'Опубликованные статьи',
          status: 'completed',
          description_html: '<p>Проверили <strong>страницы</strong>.</p><p>Список:</p><ul><li>SEO-аудит</li><li>Ссылочная стратегия</li></ul><p><a href="https://example.com/article">Открыть материал</a><br>Готово.</p>',
        }],
      }],
    }],
  });

  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, 'exporter must return a non-empty PDF buffer');
  const tmpPath = path.join(os.tmpdir(), `generator1-pdf-exporter-${process.pid}.pdf`);
  fs.writeFileSync(tmpPath, pdf);
  try {
    const info = commandText('pdfinfo', [tmpPath]);
    const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1]);
    assert.ok(Number.isInteger(pages) && pages >= 1 && pages <= 3, `fixture should fit into a small PDF, got ${pages} pages`);

    const text = commandText('pdftotext', ['-layout', tmpPath, '-']);
    assert.match(text, /График динамики Google/, 'chart title must be rendered');
    assert.match(text, /Проверили страницы\./, 'paragraph text must be rendered');
    assert.match(text, /SEO-аудит/, 'list item must be rendered');
    assert.match(text, /Открыть материал \(https:\/\/example\.com\/article\)/, 'safe link label and URL must be rendered');
    assert.doesNotMatch(text, /<\/?p>|<\/?ul>|<\/?li>|<a\s|href=/i, 'raw HTML must not leak into PDF text');
    const imageList = commandText('pdfimages', ['-list', tmpPath]);
    assert.match(imageList, /png|image/i, 'chart PNG must be embedded in the PDF');
    assert.ok(draftPdfStart >= 0, 'draft PDF controller must exist');
    assert.match(draftPdfSource, /chart_images:\s*Array\.isArray\(req\.body\?\.chart_images\)/, 'draft PDF controller must forward chart_images');

    const bbox = commandText('pdftotext', ['-bbox', tmpPath, '-']);
    const workHeading = bbox.match(/<word xMin="([0-9.]+)"[^>]*>Выполненные<\/word>/);
    assert.ok(workHeading, 'work heading must be present in PDF bounding boxes');
    assert.ok(Number(workHeading[1]) <= 52, `work heading must start at the left content edge, got x=${workHeading[1]}`);

    for (let page = 1; page <= pages; page += 1) {
      const pageText = commandText('pdftotext', ['-f', String(page), '-l', String(page), '-layout', tmpPath, '-']).trim();
      assert.ok(pageText.length > 20, `page ${page} must not be empty`);
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  console.log('pdf exporter regression: 10/10 passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
