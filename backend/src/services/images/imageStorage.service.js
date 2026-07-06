'use strict';

/**
 * imageStorage.service — production-доставка изображений.
 *
 * Режимы (IMAGE_PIPELINE_STORAGE_MODE):
 *   • inline_base64 — текущий draft/fallback: изображение остаётся base64,
 *     url не выдаётся (embed использует data:URI).
 *   • cdn_upload    — production: изображение сохраняется как файл по
 *     slug-based пути и отдаётся публичный URL. В этой реализации файл
 *     кладётся в локальный STORAGE_DIR (том, который на проде монтируется
 *     под CDN/nginx). Слой namespaced и подготовлен под будущее
 *     S3-совместимое хранилище (putObject-адаптер).
 *
 * Контракт результата на слот:
 *   { storage_mode, image_url, filename, filesize_bytes, width, height,
 *     mime_type, stored }
 *
 * Гарантия: одна упавшая запись не роняет остальные (ошибка → слот
 * помечается storage error, но пайплайн продолжается).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getImageConfig } = require('./config');
const { decodeImageHeader } = require('../infoArticle/imageQa.service');
const { slugify } = require('./slug');

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function _ext(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || 'png';
}

/**
 * Резолвит директорию хранения. Дефолт — <cwd>/storage/images, чтобы
 * работать без доп. настройки на dev/CI. На проде задаётся
 * IMAGE_PIPELINE_STORAGE_DIR (том под CDN).
 */
function resolveStorageDir(cfg) {
  const base = cfg.storageDir || path.join(process.cwd(), 'storage', 'images');
  return path.isAbsolute(base) ? base : path.join(process.cwd(), base);
}

/**
 * Строит публичный URL. Если PUBLIC_BASE_URL не задан — отдаём
 * относительный путь /images/<taskId>/<file>, который сервится статикой.
 */
function buildPublicUrl(cfg, relPath) {
  const rel = relPath.split(path.sep).join('/');
  if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl}/${rel}`;
  return `/images/${rel}`;
}

/**
 * storeSlot — сохраняет один слот. taskId используется как namespace.
 * Возвращает объект-патч для слота (не мутирует вход).
 */
async function storeSlot(slot, taskId, cfg) {
  const out = {
    storage_mode: cfg.storageMode,
    image_url: null,
    filename: null,
    filesize_bytes: 0,
    width: slot.width || null,
    height: slot.height || null,
    mime_type: slot.mime_type || 'image/png',
    stored: false,
  };

  if (!slot || slot.status !== 'done' || !slot.image_base64) {
    return out;
  }

  // inline_base64 — ничего не пишем на диск, url остаётся null.
  if (cfg.storageMode !== 'cdn_upload') {
    out.storage_mode = 'inline_base64';
    return out;
  }

  try {
    const buf = Buffer.from(String(slot.image_base64), 'base64');
    out.filesize_bytes = buf.length;
    const hdr = decodeImageHeader(buf);
    if (hdr) {
      out.width = hdr.width;
      out.height = hdr.height;
      out.mime_type = `image/${hdr.format === 'jpg' ? 'jpeg' : hdr.format}`;
    }

    const dir = path.join(resolveStorageDir(cfg), String(taskId || 'misc'));
    await fs.promises.mkdir(dir, { recursive: true });

    const base = slugify(slot.filename_slug || slot.alt_ru || `slot-${slot.slot}`, { maxLen: 60 });
    // Короткий хэш для уникальности при коллизии slug между слотами.
    const shortHash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const filename = `${base}-${shortHash}.${_ext(out.mime_type)}`;
    const abs = path.join(dir, filename);
    await fs.promises.writeFile(abs, buf);

    out.filename = filename;
    out.image_url = buildPublicUrl(cfg, path.join(String(taskId || 'misc'), filename));
    out.stored = true;
  } catch (err) {
    out.error = String(err && err.message || err).slice(0, 300);
  }
  return out;
}

/**
 * persistImages — обрабатывает все слоты. Возвращает НОВЫЙ массив слотов
 * с добавленными storage-полями (storage_mode/image_url/filename/…).
 * Никогда не бросает: ошибки отдельных слотов попадают в slot.storage_error.
 *
 * @param {Array} imagePrompts
 * @param {string|number} taskId
 * @param {object} [cfg] — переопределение конфигурации (для тестов)
 */
async function persistImages(imagePrompts, taskId, cfg = getImageConfig()) {
  const list = Array.isArray(imagePrompts) ? imagePrompts : [];
  const results = [];
  for (const slot of list) {
    const copy = { ...slot };
    try {
      const patch = await storeSlot(slot, taskId, cfg);
      copy.storage_mode = patch.storage_mode;
      copy.image_url = patch.image_url;
      copy.filename_slug = copy.filename_slug || (patch.filename ? patch.filename.replace(/\.[a-z0-9]+$/i, '') : null);
      copy.filename = patch.filename;
      copy.filesize_bytes = patch.filesize_bytes;
      if (patch.width) copy.width = patch.width;
      if (patch.height) copy.height = patch.height;
      if (patch.mime_type) copy.mime_type = patch.mime_type;
      if (patch.error) copy.storage_error = patch.error;
    } catch (err) {
      copy.storage_error = String(err && err.message || err).slice(0, 300);
      copy.storage_mode = cfg.storageMode;
    }
    results.push(copy);
  }
  return results;
}

module.exports = {
  persistImages,
  storeSlot,
  resolveStorageDir,
  buildPublicUrl,
  MIME_EXT,
};
