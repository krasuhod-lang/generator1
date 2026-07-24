'use strict';

/**
 * maintenance/artifactCleanup — единый хелпер «удалить все артефакты задачи с диска».
 *
 * Раньше DELETE-эндпоинты инструментов удаляли только строку в БД (cascade),
 * но НЕ чистили файлы: каталог сгенерированных картинок
 * `storage/images/<taskId>/`, загруженные скриншоты `uploads/report-images/<file>`
 * и исходный DOCX (`input_tz_docx_path`). В итоге диск не освобождался.
 *
 * Этот модуль собирает всю логику unlink в одном месте, чтобы её переиспользовали
 * и ручное удаление (контроллеры), и сервис ретеншена (storageRetention).
 *
 * Принципы:
 *   • best-effort — одна упавшая операция не роняет остальные;
 *   • идемпотентность — отсутствующий файл (ENOENT) не считается ошибкой;
 *   • без бросков — функции никогда не throw'ят, возвращают счётчики.
 */

const fs = require('fs');
const path = require('path');

const { getImageConfig } = require('../images/config');
const { resolveStorageDir } = require('../images/imageStorage.service');

// Корень бэкенда (…/backend). __dirname = …/backend/src/services/maintenance.
const BACKEND_ROOT = path.resolve(__dirname, '../../..');

/**
 * Абсолютный путь к каталогу картинок задачи: <storageDir>/<taskId>.
 * Возвращает null, если taskId пустой.
 */
function taskImageDir(taskId, cfg = getImageConfig()) {
  if (taskId == null || taskId === '') return null;
  return path.join(resolveStorageDir(cfg), String(taskId));
}

/**
 * Рекурсивно и безопасно удалить каталог. ENOENT игнорируется.
 * @returns {Promise<boolean>} true, если что-то было удалено.
 */
async function removeDir(absDir) {
  if (!absDir) return false;
  try {
    await fs.promises.rm(absDir, { recursive: true });
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    console.warn(`[artifactCleanup] Не удалось удалить каталог ${absDir}:`, err.message);
    return false;
  }
}

/**
 * Удалить каталог картинок задачи storage/images/<taskId>.
 * @returns {Promise<boolean>}
 */
async function removeTaskImageDir(taskId, cfg = getImageConfig()) {
  const dir = taskImageDir(taskId, cfg);
  return removeDir(dir);
}

/**
 * Из ссылки/пути на загруженный скриншот вычленить абсолютный путь файла
 * внутри backend/uploads/report-images. Принимает форматы:
 *   • `/api/uploads/report-images/<file>`
 *   • `/uploads/report-images/<file>`
 *   • `uploads/report-images/<file>`
 *   • просто `<file>` (basename)
 * Возвращает null, если распознать не удалось или basename небезопасен.
 */
function resolveUploadPath(ref) {
  if (!ref || typeof ref !== 'string') return null;
  // Работаем только с файлами в report-images: берём часть после
  // последнего сегмента report-images/, иначе — сам basename.
  let name;
  const marker = 'report-images/';
  const idx = ref.indexOf(marker);
  if (idx !== -1) {
    name = ref.slice(idx + marker.length);
  } else if (!ref.includes('/') && !ref.includes('\\')) {
    name = ref;
  } else {
    return null;
  }
  // Отсекаем query/hash.
  name = name.split(/[?#]/)[0];
  // Ожидаем плоское имя файла в report-images. Любые разделители пути или «..»
  // (в т.ч. попытка traversal) — отклоняем целиком, не «спасаем» basename'ом.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!name || name === '.' || name === '..') return null;
  return path.join(BACKEND_ROOT, 'uploads', 'report-images', name);
}

/**
 * Безопасно удалить один файл по абсолютному пути. ENOENT игнорируется.
 * @returns {Promise<boolean>}
 */
async function removeFile(absPath) {
  if (!absPath) return false;
  try {
    await fs.promises.unlink(absPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    console.warn(`[artifactCleanup] Не удалось удалить файл ${absPath}:`, err.message);
    return false;
  }
}

/**
 * Удалить исходный DOCX по пути из БД (input_tz_docx_path). Путь трактуется
 * относительно корня backend, если он не абсолютный.
 * @returns {Promise<boolean>}
 */
async function removeDocx(docxPath) {
  if (!docxPath || typeof docxPath !== 'string') return false;
  const abs = path.isAbsolute(docxPath) ? docxPath : path.resolve(BACKEND_ROOT, docxPath);
  return removeFile(abs);
}

/**
 * Удалить загруженный скриншот отчёта по ссылке/пути/имени.
 * @returns {Promise<boolean>}
 */
async function removeUpload(ref) {
  return removeFile(resolveUploadPath(ref));
}

/**
 * cleanupTaskArtifacts — удалить все файловые артефакты задачи.
 *
 * @param {object}   opts
 * @param {string|number} [opts.taskId]    — id задачи (namespace каталога картинок)
 * @param {string}   [opts.docxPath]        — input_tz_docx_path
 * @param {string[]} [opts.uploadRefs]      — ссылки/пути на uploads/report-images
 * @param {object}   [opts.cfg]             — переопределение image-config (тесты)
 * @returns {Promise<{imageDir:boolean, docx:boolean, uploads:number}>}
 */
async function cleanupTaskArtifacts(opts = {}) {
  const { taskId, docxPath, uploadRefs, cfg = getImageConfig() } = opts;
  const result = { imageDir: false, docx: false, uploads: 0 };

  if (taskId != null && taskId !== '') {
    result.imageDir = await removeTaskImageDir(taskId, cfg);
  }
  if (docxPath) {
    result.docx = await removeDocx(docxPath);
  }
  if (Array.isArray(uploadRefs) && uploadRefs.length) {
    for (const ref of uploadRefs) {
      // eslint-disable-next-line no-await-in-loop
      if (await removeUpload(ref)) result.uploads += 1;
    }
  }
  return result;
}

module.exports = {
  cleanupTaskArtifacts,
  removeTaskImageDir,
  removeDocx,
  removeUpload,
  resolveUploadPath,
  taskImageDir,
  removeDir,
  removeFile,
  BACKEND_ROOT,
};
