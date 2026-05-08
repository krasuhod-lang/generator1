'use strict';

/**
 * imageQa.service — Phase 1 / P0-4 deterministic Image QA.
 *
 * Назначение: после того как NanoBananaPro вернул base64-изображения
 * (см. runImageGeneration в infoArticlePipeline), сверяем каждый слот
 * по объективным критериям, которые можно проверить БЕЗ LLM, БЕЗ
 * сетевых запросов и БЕЗ внешних бинарников/доп.зависимостей —
 * только Node std (Buffer + crypto).
 *
 * Контракт:
 *   • быстро (< 100 ms на 6 изображений размером 1–3 МБ),
 *   • воспроизводимо (тот же вход → тот же отчёт),
 *   • никогда не падает с throw — все ошибки попадают в issues[].
 *
 * Что проверяется (per-slot):
 *   1. status              — статус генерации (skip slots со status='error')
 *   2. decode              — валидный заголовок PNG/JPEG/WebP/GIF; иначе issue
 *   3. byte_size           — слишком маленький (< MIN_BYTES) или слишком
 *                            большой (> MAX_BYTES); первое почти всегда
 *                            «битая» картинка/плейсхолдер ошибки
 *   4. dimensions          — width/height извлекаются из бинарной шапки;
 *                            < MIN_DIM по любой стороне → issue
 *   5. aspect_ratio        — отношение w/h; cover (slot=1) ожидаем «landscape»
 *                            (≥ COVER_MIN_AR), inline — любое из ALLOWED_ARS
 *   6. duplicate_cover     — sha256 base64 совпал с другим слотом → пометить
 *                            оба, чтобы пользователь увидел дубль cover/inline
 *   7. alt_text            — пустой alt_ru → issue (доступность + SEO)
 *
 * Чего НЕ делает (out of scope):
 *   • не определяет watermark / логотипы (требует CV/vision-модели),
 *   • не оценивает «эстетику» / «правильность» отображения сюжета,
 *   • не делает OCR.
 *
 * Вердикт по статье:
 *   • na     — нет ни одного слота со status='done' (нечего проверять)
 *   • pass   — нет ошибок (errors=0) И нет дублей; warnings допустимы
 *   • review — есть warnings или duplicates, но нет hard-errors
 *   • fail   — есть хотя бы один hard-error (decode/byte/dim/aspect)
 *              ИЛИ cover (slot=1) отсутствует/error
 */

const crypto = require('crypto');

// ── Параметры (env-overridable) ────────────────────────────────────

// Порог «слишком мелкий» в байтах (сжатый PNG/JPEG). 5 КБ — ниже почти
// всегда означает поломанный декодер на стороне модели или 1-pixel
// «empty» плейсхолдер.
const MIN_BYTES = Math.max(512,
  parseInt(process.env.INFO_ARTICLE_IMAGE_QA_MIN_BYTES, 10) || 5 * 1024,
);

// Порог «слишком большой» — защищает БД/SSE/UI от 20+ МБ артефактов.
// 8 МБ покрывает 4096×4096 PNG с запасом.
const MAX_BYTES = Math.max(MIN_BYTES * 4,
  parseInt(process.env.INFO_ARTICLE_IMAGE_QA_MAX_BYTES, 10) || 8 * 1024 * 1024,
);

// Минимальная сторона (px) — ниже считаем «миниатюра, не для статьи».
const MIN_DIM = Math.max(64,
  parseInt(process.env.INFO_ARTICLE_IMAGE_QA_MIN_DIM, 10) || 512,
);

// Cover-обложка должна быть «горизонтальной», иначе плохо ложится в
// шапку статьи под H1. 1.2 ≈ 6:5 — нижняя граница «не-портрета».
const COVER_MIN_AR = (() => {
  const v = parseFloat(process.env.INFO_ARTICLE_IMAGE_QA_COVER_MIN_AR);
  return Number.isFinite(v) && v > 0.5 && v < 5 ? v : 1.2;
})();

// Допустимый общий диапазон AR для inline-изображений.
// Слишком узкие столбцы (AR < 0.4) и панорамы (AR > 4) обычно ошибка.
const INLINE_MIN_AR = 0.4;
const INLINE_MAX_AR = 4.0;

// ── Декодеры заголовков (only header bytes, без раскодирования пикселей) ──

/**
 * Извлекает { format, width, height } из первых байт бинарного буфера.
 * Возвращает null, если формат не распознан / данных не хватает.
 *
 * Поддерживаются: PNG, JPEG (SOFn), WebP (VP8/VP8L/VP8X), GIF87a/89a.
 * Этого достаточно для всего, что отдают NanoBananaPro / Gemini Image.
 */
function decodeImageHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR at offset 8 → width@16, height@20 (BE).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { format: 'png', width, height };
  }

  // GIF87a / GIF89a: "GIF8" then 7a/9a at offset 4, width@6 (LE), height@8 (LE).
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    if (buf.length < 10) return null;
    const width  = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { format: 'gif', width, height };
  }

  // WebP: "RIFF" .... "WEBP".
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    if (buf.length < 30) return null;
    const fourcc = buf.slice(12, 16).toString('ascii');
    if (fourcc === 'VP8 ') {
      // Lossy: width@26 (LE) & 0x3FFF, height@28 (LE) & 0x3FFF.
      const w = buf.readUInt16LE(26) & 0x3FFF;
      const h = buf.readUInt16LE(28) & 0x3FFF;
      return { format: 'webp', width: w, height: h };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 14-bit width-1, 14-bit height-1, packed at offset 21..24 (LE).
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width  = 1 + (((b1 & 0x3F) << 8) | b0);
      const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
      return { format: 'webp', width, height };
    }
    if (fourcc === 'VP8X') {
      // Extended: 24-bit width-1 & height-1 at offset 24 / 27 (LE).
      const width  = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'webp', width, height };
    }
    return null;
  }

  // JPEG: starts with FF D8, scan for SOFn marker (C0..CF except C4/C8/CC).
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      // Skip fill bytes 0xFF.
      while (i < buf.length && buf[i] === 0xFF) i += 1;
      if (i >= buf.length) break;
      const marker = buf[i]; i += 1;
      // Markers without payload.
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
        continue;
      }
      if (i + 1 >= buf.length) break;
      const segLen = buf.readUInt16BE(i);
      // SOFn (Start Of Frame): C0..CF, кроме DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xC0 && marker <= 0xCF
          && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 7 >= buf.length) break;
        const height = buf.readUInt16BE(i + 3);
        const width  = buf.readUInt16BE(i + 5);
        return { format: 'jpeg', width, height };
      }
      i += segLen;
    }
    return null;
  }

  return null;
}

// ── Per-slot проверки ──────────────────────────────────────────────

/**
 * Каноничная классификация AR.
 *   landscape  >= 1.2
 *   portrait   <= 0.83  (≈ 1/1.2)
 *   square     иначе
 */
function arClass(ar) {
  if (!Number.isFinite(ar) || ar <= 0) return 'unknown';
  if (ar >= 1.2) return 'landscape';
  if (ar <= 1 / 1.2) return 'portrait';
  return 'square';
}

/**
 * Анализ одного слота. Возвращает плоский объект-отчёт с issues[].
 * Каждый issue: { code, level: 'error'|'warn', message }.
 *
 * issue.level === 'error' → влияет на итоговый verdict (fail).
 * issue.level === 'warn'  → review.
 */
function analyzeSlot(slot, opts = {}) {
  const out = {
    slot:        Number(slot && slot.slot) || 0,
    section_h2:  String(slot && slot.section_h2 || ''),
    status:      String(slot && slot.status || 'unknown'),
    has_image:   false,
    bytes:       0,
    sha256:      null,
    format:      null,
    width:       null,
    height:      null,
    aspect_ratio: null,
    aspect_class: 'unknown',
    alt_present:  Boolean(slot && slot.alt_ru && String(slot.alt_ru).trim()),
    issues:      [],
  };

  // 1. Статус генерации
  if (out.status === 'error') {
    out.issues.push({
      code: 'generation_failed',
      level: 'error',
      message: `slot ${out.slot}: генерация вернула ошибку (${String(slot.error || 'no detail').slice(0, 120)})`,
    });
    return out;
  }
  if (out.status !== 'done' || !slot.image_base64) {
    out.issues.push({
      code: 'no_image',
      level: 'error',
      message: `slot ${out.slot}: status=${out.status}, image_base64 отсутствует`,
    });
    return out;
  }

  // 2. Декод base64 + sha256
  let buf;
  try {
    buf = Buffer.from(String(slot.image_base64), 'base64');
  } catch (e) {
    out.issues.push({
      code: 'base64_decode_failed',
      level: 'error',
      message: `slot ${out.slot}: невалидный base64 — ${e.message}`,
    });
    return out;
  }
  out.has_image = true;
  out.bytes     = buf.length;
  out.sha256    = crypto.createHash('sha256').update(buf).digest('hex');

  // 3. Размер файла
  const minBytes = opts.minBytes != null ? opts.minBytes : MIN_BYTES;
  const maxBytes = opts.maxBytes != null ? opts.maxBytes : MAX_BYTES;
  if (out.bytes < minBytes) {
    out.issues.push({
      code: 'too_small_bytes',
      level: 'error',
      message: `slot ${out.slot}: файл ${out.bytes} B < ${minBytes} B (вероятно битая/пустая картинка)`,
    });
    // Декодировать дальше всё равно стоит — диагностика полнее.
  } else if (out.bytes > maxBytes) {
    out.issues.push({
      code: 'too_large_bytes',
      level: 'warn',
      message: `slot ${out.slot}: файл ${out.bytes} B > ${maxBytes} B (загромождает БД/SSE)`,
    });
  }

  // 4. Декод заголовка → размеры
  const hdr = decodeImageHeader(buf);
  if (!hdr) {
    out.issues.push({
      code: 'header_decode_failed',
      level: 'error',
      message: `slot ${out.slot}: формат изображения не распознан (PNG/JPEG/WebP/GIF)`,
    });
  } else {
    out.format = hdr.format;
    out.width  = hdr.width;
    out.height = hdr.height;

    const minDim = opts.minDim != null ? opts.minDim : MIN_DIM;
    if (!hdr.width || !hdr.height || hdr.width < minDim || hdr.height < minDim) {
      out.issues.push({
        code: 'too_small_dimensions',
        level: 'error',
        message: `slot ${out.slot}: ${hdr.width}×${hdr.height}px, требуется ≥ ${minDim}px по каждой стороне`,
      });
    }

    if (hdr.width && hdr.height) {
      const ar = hdr.width / hdr.height;
      out.aspect_ratio = Math.round(ar * 1000) / 1000;
      out.aspect_class = arClass(ar);

      // 5. Аспект: cover vs inline.
      const isCover = out.slot === 1;
      const coverMinAr = opts.coverMinAr != null ? opts.coverMinAr : COVER_MIN_AR;
      if (isCover && ar < coverMinAr) {
        out.issues.push({
          code: 'cover_not_landscape',
          level: 'warn',
          message: `slot 1 (cover): AR=${out.aspect_ratio} < ${coverMinAr} — обложка лучше горизонтальная`,
        });
      }
      if (ar < INLINE_MIN_AR || ar > INLINE_MAX_AR) {
        out.issues.push({
          code: 'aspect_out_of_range',
          level: 'error',
          message: `slot ${out.slot}: AR=${out.aspect_ratio} вне допустимого [${INLINE_MIN_AR}, ${INLINE_MAX_AR}]`,
        });
      }
    }
  }

  // 6. Alt-text
  if (!out.alt_present) {
    out.issues.push({
      code: 'missing_alt',
      level: 'warn',
      message: `slot ${out.slot}: alt_ru пуст (плохо для accessibility/SEO)`,
    });
  }

  return out;
}

// ── Дубли (sha256) ─────────────────────────────────────────────────

/**
 * Помечает группы слотов с одинаковым sha256: добавляет каждому issue
 * 'duplicate_image' (level=warn для inline-дублей, level=error для
 * cover==inline или несколько одинаковых cover).
 *
 * Mutates slotReports in place (и возвращает массив групп для удобства).
 */
function detectDuplicates(slotReports) {
  const byHash = new Map();
  for (const r of slotReports) {
    if (!r.sha256) continue;
    if (!byHash.has(r.sha256)) byHash.set(r.sha256, []);
    byHash.get(r.sha256).push(r);
  }
  const groups = [];
  for (const [sha, group] of byHash.entries()) {
    if (group.length < 2) continue;
    const slots = group.map((r) => r.slot).sort((a, b) => a - b);
    const includesCover = slots.includes(1);
    groups.push({ sha256: sha, slots, includes_cover: includesCover });
    for (const r of group) {
      r.issues.push({
        code: 'duplicate_image',
        level: includesCover ? 'error' : 'warn',
        message: `slot ${r.slot}: байт-в-байт дубль слотов [${slots.join(', ')}]` +
          (includesCover ? ' (cover дублируется!)' : ''),
      });
    }
  }
  return groups;
}

// ── Агрегат + verdict ──────────────────────────────────────────────

function summarizeImageQa(slotReports, opts = {}) {
  const total = slotReports.length;
  const done  = slotReports.filter((r) => r.status === 'done' && r.has_image).length;
  const failed = slotReports.filter((r) => r.status === 'error').length;
  let errors = 0;
  let warnings = 0;
  for (const r of slotReports) {
    for (const it of r.issues) {
      if (it.level === 'error') errors += 1;
      else warnings += 1;
    }
  }

  // Cover (slot=1) присутствует и без error?
  const cover = slotReports.find((r) => r.slot === 1);
  const coverOk = Boolean(cover && cover.status === 'done' && cover.has_image
    && cover.issues.every((it) => it.level !== 'error'));

  let verdict;
  if (total === 0 || done === 0) verdict = 'na';
  else if (errors > 0 || !coverOk) verdict = 'fail';
  else if (warnings > 0) verdict = 'review';
  else verdict = 'pass';

  const formatHistogram = {};
  for (const r of slotReports) {
    if (r.format) formatHistogram[r.format] = (formatHistogram[r.format] || 0) + 1;
  }

  return {
    totalSlots:    total,
    doneSlots:     done,
    failedSlots:   failed,
    errors,
    warnings,
    coverPresent:  Boolean(cover && cover.has_image),
    coverOk,
    formats:       formatHistogram,
    verdict,
    thresholds: {
      minBytes:    opts.minBytes != null ? opts.minBytes : MIN_BYTES,
      maxBytes:    opts.maxBytes != null ? opts.maxBytes : MAX_BYTES,
      minDim:      opts.minDim   != null ? opts.minDim   : MIN_DIM,
      coverMinAr:  opts.coverMinAr != null ? opts.coverMinAr : COVER_MIN_AR,
      inlineMinAr: INLINE_MIN_AR,
      inlineMaxAr: INLINE_MAX_AR,
    },
  };
}

// ── Фасад ──────────────────────────────────────────────────────────

/**
 * Главная точка входа. Принимает массив image_prompts (как сохраняется в
 * info_article_tasks.image_prompts после runImageGeneration) и опции
 * (используются в основном тестами для override порогов).
 *
 * Гарантия: НИКОГДА не throw. Любая внутренняя ошибка попадает в
 * report.summary.error и verdict='na'.
 */
function runImageQa(imagePrompts, opts = {}) {
  try {
    const list = Array.isArray(imagePrompts) ? imagePrompts : [];
    const slots = list.map((p) => analyzeSlot(p, opts));
    const duplicateGroups = detectDuplicates(slots);
    const summary = summarizeImageQa(slots, opts);
    return {
      summary,
      slots,
      duplicate_groups: duplicateGroups,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      summary: {
        totalSlots: Array.isArray(imagePrompts) ? imagePrompts.length : 0,
        doneSlots: 0, failedSlots: 0, errors: 0, warnings: 0,
        coverPresent: false, coverOk: false, formats: {},
        verdict: 'na',
        error: String(err && err.message || err),
      },
      slots: [],
      duplicate_groups: [],
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = {
  runImageQa,
  // Экспортируется для unit-тестов:
  decodeImageHeader,
  analyzeSlot,
  detectDuplicates,
  summarizeImageQa,
  arClass,
  MIN_BYTES,
  MAX_BYTES,
  MIN_DIM,
  COVER_MIN_AR,
  INLINE_MIN_AR,
  INLINE_MAX_AR,
};
