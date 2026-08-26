'use strict';

/**
 * Shared report content helpers.
 *
 * The report editor historically stored month -> section -> task blocks. Newer
 * editors may add subtasks/microtasks/children, so exporters normalize all
 * supported shapes without rewriting the stored JSON. Image resolution is
 * deliberately local-only: data URLs and files previously uploaded to
 * backend/uploads/report-images are allowed; remote HTTP images are never
 * fetched during export.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { resolveUploadPath } = require('../maintenance/artifactCleanup');

const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TO_TYPE = Object.freeze({
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  bmp: 'bmp',
  webp: 'webp',
});
const EXPORTABLE_DOCX_TYPES = new Set(['png', 'jpg', 'gif', 'bmp']);
const EXPORTABLE_PDF_TYPES = new Set(['png', 'jpg']);

function asText(value) {
  return String(value == null ? '' : value).trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function pickTitle(value, fallback = '') {
  if (typeof value === 'string' || typeof value === 'number') return asText(value) || fallback;
  if (!value || typeof value !== 'object') return fallback;
  return asText(value.title || value.name || value.label || value.task || value.text || value.value) || fallback;
}

function normalizeSubtask(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return { title: asText(value), description_html: '', subtasks: [] };
  }
  if (!value || typeof value !== 'object') return null;
  const nested = value.subtasks ?? value.microtasks ?? value.micro_tasks ?? value.children ?? [];
  return {
    ...value,
    title: pickTitle(value, 'Микрозадача'),
    description_html: value.description_html ?? value.description ?? value.details ?? '',
    subtasks: asArray(nested).map(normalizeSubtask).filter(Boolean),
  };
}

function normalizeTask(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return { title: asText(value), description_html: '', subtasks: [] };
  }
  if (!value || typeof value !== 'object') return null;
  const nested = value.subtasks ?? value.microtasks ?? value.micro_tasks ?? value.children ?? [];
  return {
    ...value,
    title: pickTitle(value, 'Задача'),
    description_html: value.description_html ?? value.description ?? value.details ?? '',
    subtasks: asArray(nested).map(normalizeSubtask).filter(Boolean),
  };
}

function normalizeSection(value) {
  if (!value || typeof value !== 'object') {
    return { title: pickTitle(value, 'Раздел'), tasks: [] };
  }
  const taskValues = value.tasks ?? value.items ?? value.children ?? [];
  return {
    ...value,
    title: pickTitle(value, 'Раздел'),
    tasks: asArray(taskValues).map(normalizeTask).filter(Boolean),
  };
}

function normalizeReportBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') {
      return { month: pickTitle(block, 'Выполненные работы'), sections: [] };
    }
    const sectionValues = block.sections ?? block.items ?? block.tasks ?? [];
    return {
      ...block,
      month: pickTitle(block.month || block.period || block.title || block.section, 'Период'),
      sections: asArray(sectionValues).map(normalizeSection).filter(Boolean),
    };
  });
}

function normalizeImageTypeFromMime(mime) {
  const match = String(mime || '').toLowerCase().match(/image\/([a-z0-9.+-]+)/);
  return match ? (IMAGE_MIME_TO_TYPE[match[1]] || '') : '';
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.length >= 24
      && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buffer.slice(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function parseDataImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  let buffer;
  try {
    buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_EMBEDDED_IMAGE_BYTES) return null;
  const detected = detectImageType(buffer);
  const declared = normalizeImageTypeFromMime(match[1]);
  if (!detected || (declared && detected !== declared)) return null;
  return { buffer, type: detected, source: 'data', alt: '' };
}

function localUploadPathFromSource(source) {
  const raw = asText(source);
  if (!raw || /^data:/i.test(raw)) return null;
  let pathname = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//')) return null;
  try {
    pathname = new URL(raw, 'http://report.local').pathname;
  } catch (_) {
    return null;
  }
  if (!/^\/(?:api\/)?uploads\/report-images\//i.test(pathname)) return null;
  return resolveUploadPath(pathname);
}

function readLocalImage(source, alt = '') {
  const absPath = localUploadPathFromSource(source);
  if (!absPath) return null;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EMBEDDED_IMAGE_BYTES) return null;
    const buffer = fs.readFileSync(absPath);
    const type = detectImageType(buffer);
    if (!type) return null;
    return { buffer, type, source: 'upload', alt: asText(alt) };
  } catch (_) {
    return null;
  }
}

function resolveReportImage(source, alt = '') {
  const raw = asText(source);
  if (!raw) return null;
  const data = parseDataImage(raw);
  if (data) return { ...data, alt: asText(alt) };
  return readLocalImage(raw, alt);
}

function extractTaskImages(html) {
  const raw = asText(html);
  if (!raw || !/<img\b/i.test(raw)) return [];
  let root;
  try {
    root = new JSDOM(`<div>${raw}</div>`).window.document.body.firstElementChild;
  } catch (_) {
    return [];
  }
  if (!root) return [];
  return Array.from(root.querySelectorAll('img'))
    .map((img) => resolveReportImage(img.getAttribute('src'), img.getAttribute('alt')))
    .filter(Boolean);
}

function imageDimensions(buffer, type) {
  if (!Buffer.isBuffer(buffer)) return { width: 1200, height: 675 };
  if (type === 'png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (type === 'gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (type === 'bmp' && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (type === 'jpg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 8 < buffer.length) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 1200, height: 675 };
}

function constrainImage(buffer, type, maxWidth, maxHeight) {
  const dims = imageDimensions(buffer, type);
  const width = Number(dims.width) > 0 ? dims.width : 1200;
  const height = Number(dims.height) > 0 ? dims.height : 675;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

module.exports = {
  MAX_EMBEDDED_IMAGE_BYTES,
  EXPORTABLE_DOCX_TYPES,
  EXPORTABLE_PDF_TYPES,
  asText,
  normalizeReportBlocks,
  normalizeTask,
  normalizeSubtask,
  resolveReportImage,
  extractTaskImages,
  detectImageType,
  imageDimensions,
  constrainImage,
};
