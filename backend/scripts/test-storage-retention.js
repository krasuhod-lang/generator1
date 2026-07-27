'use strict';

/**
 * Smoke-tests для сервиса ретеншена хранилища и хелпера artifactCleanup.
 *
 * Покрывает:
 *   • artifactCleanup.resolveUploadPath — разбор ссылок + защита от traversal;
 *   • artifactCleanup — реальное удаление каталога картинок / DOCX / uploads;
 *   • идемпотентность (повторное удаление и ENOENT не падают);
 *   • storageRetention._buildSelectSql — оба возрастных условия в WHERE;
 *   • sweepTable — выборка/удаление батчами, счётчики файлов;
 *   • dry-run — строки НЕ удаляются, но файлы считаются, один проход;
 *   • runStorageRetention — агрегирование totals по таблицам + VACUUM только
 *     по затронутым таблицам.
 *
 * БД замокана (deps.db), файловые операции — на реальном tmp-каталоге.
 *
 * Запуск:  node backend/scripts/test-storage-retention.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// db мокаем на уровне модуля — на случай, если что-то дернёт дефолтный db.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const artifactCleanup = require('../src/services/maintenance/artifactCleanup');
const retention = require('../src/services/maintenance/storageRetention');

let failures = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); } else { console.log(`  ✗ ${name}`); failures += 1; }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[retention] artifactCleanup.resolveUploadPath — разбор + безопасность');
{
  const r = artifactCleanup.resolveUploadPath;
  ok('/api/uploads/report-images/x.png → …/uploads/report-images/x.png',
    r('/api/uploads/report-images/x.png').endsWith(path.join('uploads', 'report-images', 'x.png')));
  ok('/uploads/report-images/y.jpg распознаётся',
    r('/uploads/report-images/y.jpg').endsWith(path.join('uploads', 'report-images', 'y.jpg')));
  ok('голый basename распознаётся',
    r('z.webp').endsWith(path.join('uploads', 'report-images', 'z.webp')));
  ok('query-строка отсекается',
    r('/api/uploads/report-images/a.png?v=2').endsWith(path.join('report-images', 'a.png')));
  ok('path-traversal отклоняется (../)', r('report-images/../../etc/passwd') === null);
  ok('чужой путь без report-images отклоняется', r('/some/other/path/f.png') === null);
  ok('пустая ссылка → null', r('') === null && r(null) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[retention] artifactCleanup — реальное удаление файлов + идемпотентность');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  try {
    const cfg = { storageDir: path.join(tmp, 'storage', 'images') };

    // Каталог картинок задачи storage/images/<taskId>.
    const taskDir = artifactCleanup.taskImageDir('task-42', cfg);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'img.png'), 'x');
    ok('taskImageDir указывает внутрь storageDir', taskDir.startsWith(cfg.storageDir));

    // DOCX относительно backend root.
    const docxAbs = path.join(tmp, 'my.docx');
    fs.writeFileSync(docxAbs, 'docx');

    const res = await artifactCleanup.cleanupTaskArtifacts({
      taskId: 'task-42', docxPath: docxAbs, cfg,
    });
    ok('imageDir удалён', res.imageDir === true && !fs.existsSync(taskDir));
    ok('docx удалён', res.docx === true && !fs.existsSync(docxAbs));

    // Идемпотентность — повторный вызов не падает и возвращает false.
    const res2 = await artifactCleanup.cleanupTaskArtifacts({
      taskId: 'task-42', docxPath: docxAbs, cfg,
    });
    ok('повторное удаление idempotent (imageDir=false)', res2.imageDir === false);
    ok('повторное удаление idempotent (docx=false)', res2.docx === false);

    // ENOENT на отдельном файле не бросает.
    const removed = await artifactCleanup.removeFile(path.join(tmp, 'nope.bin'));
    ok('removeFile на несуществующем → false, без throw', removed === false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[retention] _buildSelectSql — оба возрастных условия');
  {
    const desc = retention.TABLES.find((t) => t.table === 'tasks');
    const sql = retention._buildSelectSql(desc);
    ok('содержит success-условие по completedAgeExpr', sql.includes(desc.completedAgeExpr));
    ok('содержит failed-условие по failedAgeExpr', sql.includes(desc.failedAgeExpr));
    ok('выбирает docx-колонку для tasks', sql.includes('input_tz_docx_path'));
    ok('есть LIMIT $4', sql.includes('LIMIT $4'));
  }

  // Фейковый db, отдающий заранее заданные наборы строк по очереди.
  function fakeDb(batches) {
    const q = batches.slice();
    const calls = { selects: 0, deletes: [], vacuums: [] };
    return {
      calls,
      query: async (text, params) => {
        if (/^\s*SELECT/i.test(text)) {
          calls.selects += 1;
          return { rows: q.length ? q.shift() : [], rowCount: 0 };
        }
        if (/^\s*DELETE/i.test(text)) {
          calls.deletes.push(params[0]);
          return { rowCount: params[0].length };
        }
        if (/^\s*VACUUM/i.test(text)) {
          calls.vacuums.push(text.trim());
          return { rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  const singleDesc = [retention.TABLES.find((t) => t.table === 'link_article_tasks')];

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[retention] sweepTable — батчи и счётчики файлов');
  {
    // Два полных батча (по 2) + пустой → цикл останавливается.
    const db = fakeDb([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }, { id: 'd' }],
      [],
    ]);
    const cleaned = [];
    const cleanup = async ({ taskId }) => { cleaned.push(taskId); return { imageDir: true, docx: false }; };
    const cfg = retention.getRetentionConfig({ batchSize: 2, maxBatches: 10, dryRun: false });
    const stat = await retention.sweepTable(singleDesc[0], cfg, { db, cleanup });
    ok('удалено 4 строки за 2 батча', stat.deleted === 4 && stat.batches === 2);
    ok('cleanup вызван на каждой строке', cleaned.length === 4);
    ok('imageDirs посчитаны', stat.imageDirs === 4);
    ok('DELETE отправлен дважды', db.calls.deletes.length === 2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[retention] dry-run — строки НЕ удаляются, файлы считаются, один проход');
  {
    const db = fakeDb([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }, { id: 'd' }],
    ]);
    let cleanupCalls = 0;
    const cleanup = async () => { cleanupCalls += 1; return { imageDir: true, docx: true }; };
    const cfg = retention.getRetentionConfig({ batchSize: 2, dryRun: true });
    const stat = await retention.sweepTable(singleDesc[0], cfg, { db, cleanup });
    ok('нет DELETE в dry-run', db.calls.deletes.length === 0 && stat.deleted === 0);
    ok('только один SELECT (нет зацикливания)', db.calls.selects === 1);
    ok('файлы всё равно посчитаны в dry-run', cleanupCalls === 2 && stat.docx === 2);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n[retention] runStorageRetention — totals + VACUUM только по затронутым');
  {
    const twoTables = [
      retention.TABLES.find((t) => t.table === 'link_article_tasks'),
      retention.TABLES.find((t) => t.table === 'meta_tag_tasks'),
    ];
    // link_article: 1 строка; meta_tag: 0 строк.
    const db = fakeDb([
      [{ id: 'a' }], // link_article batch 1
      [],            // link_article batch 2 (стоп)
      [],            // meta_tag batch 1 (пусто)
    ]);
    const cleanup = async () => ({ imageDir: true, docx: false });
    const out = await retention.runStorageRetention(
      { batchSize: 50, vacuum: true, vacuumFull: false },
      { db, cleanup, tables: twoTables },
    );
    ok('totals.deleted === 1', out.totals.deleted === 1);
    ok('totals.imageDirs === 1', out.totals.imageDirs === 1);
    ok('VACUUM только по link_article_tasks', db.calls.vacuums.length === 1
      && db.calls.vacuums[0].includes('link_article_tasks'));
    ok('обычный VACUUM (не FULL)', db.calls.vacuums[0].includes('VACUUM (ANALYZE)'));
  }

  console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
