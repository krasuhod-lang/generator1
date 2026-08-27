'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {
  buildInventory,
  resolveInventoryFile,
  safeRelativePath,
  getKnownStoragePaths,
} = require('../src/services/maintenance/storageAdmin');

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'generator-storage-inventory-'));
  try {
    await fsp.mkdir(path.join(root, 'reports', '2026'), { recursive: true });
    await fsp.mkdir(path.join(root, 'cache'), { recursive: true });
    await fsp.writeFile(path.join(root, 'reports', '2026', 'large.pdf'), Buffer.alloc(4096, 1));
    await fsp.writeFile(path.join(root, 'reports', '2026', 'small.txt'), 'hello');
    await fsp.writeFile(path.join(root, 'cache', 'response.json'), '{"ok":true}');

    const inventory = await buildInventory(
      { key: 'uploads', label: 'Uploads', path: root, fileCleanup: true },
      { page: 1, limit: 2, sort: 'size', order: 'desc' },
    );
    assert.strictEqual(inventory.summary.file_count, 3);
    assert.strictEqual(inventory.summary.bytes, 4112);
    assert.strictEqual(inventory.files.length, 2);
    assert.strictEqual(inventory.files[0].relative_path, 'reports/2026/large.pdf');
    assert.strictEqual(inventory.pagination.total_files, 3);
    assert.strictEqual(inventory.pagination.has_more, true);
    assert.strictEqual(inventory.largest_files[0].relative_path, 'reports/2026/large.pdf');
    assert.strictEqual(inventory.largest_files[0].bytes, 4096);
    assert.ok(inventory.folders.some((folder) => folder.relative_path === 'reports/2026' && folder.bytes === 4101));
    assert.ok(inventory.folders.some((folder) => folder.relative_path === 'reports' && folder.bytes === 4101));

    const searched = await buildInventory(
      { key: 'uploads', label: 'Uploads', path: root, fileCleanup: true },
      { search: 'large.pdf', limit: 100 },
    );
    assert.strictEqual(searched.pagination.total_files, 1);
    assert.strictEqual(searched.files[0].name, 'large.pdf');

    assert.strictEqual(safeRelativePath('../outside.txt'), null);
    assert.strictEqual(safeRelativePath('/etc/passwd'), null);
    assert.strictEqual(safeRelativePath('reports/../cache/response.json'), 'cache/response.json');
    assert.throws(() => resolveInventoryFile({ path: root }, '../outside.txt'), /Небезопасный relative_path|Путь выходит/);
    assert.throws(() => resolveInventoryFile({ path: root }, '/etc/passwd'), /Небезопасный relative_path|Путь выходит/);
    assert.strictEqual(resolveInventoryFile({ path: root }, 'reports/2026/large.pdf').relative, 'reports/2026/large.pdf');
    assert.strictEqual(inventory.largest_files.length, 3);
    const appRoot = getKnownStoragePaths().find((entry) => entry.key === 'app_root');
    assert.ok(appRoot && appRoot.fileCleanup === false);
    assert.notStrictEqual(appRoot.path, '/', 'inventory must never scan the whole container filesystem');
    assert.ok(appRoot.path.endsWith('generator1') || appRoot.path === '/app');

    console.log('storage inventory regression: 18/18 passed');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    try {
      const queues = require('../src/queue/queue');
      await Promise.all(Object.values(queues).filter((queue) => queue && typeof queue.close === 'function').map((queue) => queue.close()));
    } catch (_) { /* queue may be unavailable in offline tests */ }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
