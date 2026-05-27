'use strict';

/**
 * Smoke-test для aegis/_paths и косвенно для promptAudit/featureFlags.
 *
 * Запуск:  node backend/scripts/test-aegis-paths.js
 *
 * Падал бы исторический баг с REPO_ROOT='/' в контейнере: PROMPTS_ROOT
 * указывал в несуществующий /backend/src/prompts, scanPromptFiles возвращал [].
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  findPromptsDir,
  findBackendRoot,
  findBrainStateDir,
  findRepoRoot,
} = require('../src/services/aegis/_paths');

function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); return true; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); return false; }
}

let failed = 0;

console.log('aegis/_paths resolution');

failed += !check('findPromptsDir() возвращает существующий каталог', () => {
  const dir = findPromptsDir();
  assert(dir, 'prompts dir not found');
  assert(fs.statSync(dir).isDirectory(), `${dir} is not a directory`);
});

failed += !check('promptsDir содержит хотя бы один .txt промт', () => {
  const dir = findPromptsDir();
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { const hit = walk(full); if (hit) return hit; }
      else if (/\.txt$/.test(e.name)) return full;
    }
    return null;
  }
  const txt = walk(dir);
  assert(txt, `no .txt prompt found under ${dir}`);
});

failed += !check('findBackendRoot() содержит package.json и server.js', () => {
  const root = findBackendRoot();
  assert(fs.statSync(path.join(root, 'package.json')).isFile(), 'package.json missing');
  assert(fs.statSync(path.join(root, 'server.js')).isFile(), 'server.js missing');
});

failed += !check('findBrainStateDir() — путь определён', () => {
  const dir = findBrainStateDir();
  assert(dir && path.isAbsolute(dir), `bad brain_state dir: ${dir}`);
});

failed += !check('findRepoRoot() — путь определён и абсолютный', () => {
  const r = findRepoRoot();
  assert(r && path.isAbsolute(r), `bad repo root: ${r}`);
});

console.log('\npromptAudit.scanPromptFiles');

failed += !check('scanPromptFiles() возвращает непустой инвентарь', () => {
  const pa = require('../src/services/aegis/promptAudit');
  pa._resetCache();
  const prompts = pa.scanPromptFiles();
  assert(Array.isArray(prompts), 'not an array');
  assert(prompts.length > 0, `scan returned 0 prompts (regression of the Docker REPO_ROOT bug)`);
  const writer = prompts.find((p) => p.role === 'writer');
  assert(writer, 'no writer-role prompt detected');
});

failed += !check('resolvePromptHash() стабилен для известного ключа', () => {
  const pa = require('../src/services/aegis/promptAudit');
  const inv = pa.scanPromptFiles();
  if (!inv.length) throw new Error('skip: inventory empty');
  const sample = inv[0].prompt_key;
  const h1 = pa.resolvePromptHash(sample);
  const h2 = pa.resolvePromptHash(sample);
  assert.strictEqual(h1, h2);
  assert(/^[a-f0-9]{64}$/.test(h1), `bad sha256: ${h1}`);
});

console.log('\nfeatureFlags.brainState.rootDir');

failed += !check('brainState.rootDir — абсолютный путь', () => {
  const { getAegisFlags } = require('../src/services/aegis/featureFlags');
  const f = getAegisFlags();
  assert(f.brainState && f.brainState.rootDir, 'rootDir missing');
  assert(path.isAbsolute(f.brainState.rootDir), `not absolute: ${f.brainState.rootDir}`);
});

if (failed) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
}
console.log('\n✅ all aegis-path tests passed');
