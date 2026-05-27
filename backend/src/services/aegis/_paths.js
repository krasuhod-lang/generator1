'use strict';

/**
 * aegis/_paths — устойчивая резолюция корня репозитория и каталога с
 * промтами/brain_state.
 *
 * Зачем: исторически и `featureFlags.js`, и `promptAudit.js` считали
 *   REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
 * что справедливо только в dev-раскладке (когда `backend/` лежит внутри
 * корня репо). В Docker'е же контекст сборки backend-контейнера — `./backend`,
 * Dockerfile делает `WORKDIR /app` + `COPY . .` → файлы оказываются в /app
 * без префикса `backend/`. Поэтому
 *   path.resolve('/app/src/services/aegis', '../../../..') === '/'
 * и PROMPTS_ROOT превращается в `/backend/src/prompts` (не существует),
 * а brainState.rootDir — в `/brain_state` (не существует). В результате
 * аудит промтов не пишется, история мозга всегда пуста.
 *
 * Этот модуль ищет «якорь» восходящим обходом каталогов и возвращает
 * фактические пути на диске, корректные и в dev, и в контейнере.
 */

const fs = require('fs');
const path = require('path');

const MAX_ASCENT = 8;

function _ascend(startDir, predicate) {
  let dir = startDir;
  for (let i = 0; i < MAX_ASCENT; i++) {
    const hit = predicate(dir);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

/**
 * Найти каталог с промтами (`backend/src/prompts` в dev,
 * `src/prompts` внутри `/app` в контейнере).
 *
 * @returns {string|null} абсолютный путь до prompts-каталога или null
 *   если он действительно отсутствует (например, dist-сборка без промтов).
 */
function findPromptsDir() {
  return _ascend(__dirname, (dir) => {
    const a = path.join(dir, 'backend', 'src', 'prompts');
    if (_existsDir(a)) return a;
    const b = path.join(dir, 'src', 'prompts');
    if (_existsDir(b)) return b;
    return null;
  });
}

/**
 * Найти каталог `brain_state/`. Возвращает первый существующий
 * (dev — рядом с backend/, контейнер — `/app/brain_state` если смонтирован),
 * иначе — ожидаемый путь (`<backendRoot>/brain_state`), чтобы код мог
 * писать в него при первом retrain'е (родительский каталог гарантированно
 * существует — это `/app`).
 */
function findBrainStateDir() {
  // 1) Существующий каталог: ищем у предка и непосредственно рядом с backend.
  const existing = _ascend(__dirname, (dir) => {
    const candidate = path.join(dir, 'brain_state');
    return _existsDir(candidate) ? candidate : null;
  });
  if (existing) return existing;
  // 2) Иначе — конструируем разумный путь относительно корня backend-приложения.
  const backendRoot = findBackendRoot();
  return path.join(backendRoot, 'brain_state');
}

/**
 * Корень backend-приложения (где лежит package.json + server.js). В dev это
 * `<repo>/backend`, в контейнере — `/app`.
 */
function findBackendRoot() {
  const hit = _ascend(__dirname, (dir) => {
    const pkg = path.join(dir, 'package.json');
    const server = path.join(dir, 'server.js');
    try {
      if (fs.statSync(pkg).isFile() && fs.statSync(server).isFile()) return dir;
    } catch (_) { /* skip */ }
    return null;
  });
  return hit || path.resolve(__dirname, '..', '..', '..');
}

/**
 * «Корень репо» в традиционном понимании — для путей вида
 * `path.relative(REPO_ROOT, file)` в логах. Возвращает каталог,
 * содержащий backend/, либо сам backendRoot если выше backend/ нет.
 */
function findRepoRoot() {
  const promptsDir = findPromptsDir();
  if (promptsDir) {
    // backend/src/prompts → repo = ../../../  от prompts
    //                src/prompts → repo = ../../  (контейнер: /app)
    const isBackendNested = path.basename(path.resolve(promptsDir, '..', '..', '..')) !== ''
      && fs.existsSync(path.resolve(promptsDir, '..', '..', '..', 'backend'));
    if (isBackendNested) return path.resolve(promptsDir, '..', '..', '..');
    return path.resolve(promptsDir, '..', '..');
  }
  return findBackendRoot();
}

module.exports = {
  findPromptsDir,
  findBrainStateDir,
  findBackendRoot,
  findRepoRoot,
};
