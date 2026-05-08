'use strict';

/**
 * test-image-qa.js — юнит-тесты для imageQa.service.js (Phase 1, P0-4).
 *
 * Всё в памяти, без сети, без БД. Покрывает:
 *   • decodeImageHeader: PNG / JPEG / WebP (VP8, VP8L, VP8X) / GIF, мусор
 *   • analyzeSlot: status=error → generation_failed; status=done без base64;
 *     битый base64; малый размер; формат не распознан; малые размеры;
 *     AR вне диапазона; cover не landscape; пустой alt
 *   • detectDuplicates: дубль cover+inline → error, дубль inline+inline → warn
 *   • summarizeImageQa: pass / review / fail / na, coverOk
 *   • runImageQa (фасад): orchestration, всегда возвращает структуру,
 *     никогда не throw'ит
 *
 * Запуск:  node backend/scripts/test-image-qa.js
 */

const assert = require('assert');
const path   = require('path');

const {
  runImageQa,
  decodeImageHeader,
  analyzeSlot,
  detectDuplicates,
  summarizeImageQa,
  arClass,
  MIN_BYTES,
  MIN_DIM,
  COVER_MIN_AR,
  INLINE_MIN_AR,
  INLINE_MAX_AR,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'imageQa.service'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
  }
}

// ── Builders для синтетических заголовков изображений ──────────────

/** Минимальный валидный PNG-заголовок 1024×768 (24-байтовая шапка). */
function makePngHeader(width, height) {
  const buf = Buffer.alloc(24);
  // Signature 89 50 4E 47 0D 0A 1A 0A
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
  buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
  // IHDR length (13) + 'IHDR' tag (8..15) — content начинается с 16.
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width,  16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** GIF87a / GIF89a 10-байтовая шапка. */
function makeGifHeader(width, height) {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width,  6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** WebP / VP8 (lossy) — 30 байт. */
function makeWebpVp8Header(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4); // size после RIFF
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16); // chunk size
  // VP8 width@26 (LE) & 0x3FFF
  buf.writeUInt16LE(width & 0x3FFF, 26);
  buf.writeUInt16LE(height & 0x3FFF, 28);
  return buf;
}

/** WebP / VP8L (lossless) — 30 байт. */
function makeWebpVp8lHeader(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x2F; // VP8L signature
  // 14-bit (width-1) и 14-bit (height-1) starting at byte 21:
  // b0 = lower 8 bits of (width-1)
  // b1 = upper 6 bits of (width-1) | (lower 2 bits of (height-1) << 6)
  // b2 = bits 2..9 of (height-1)
  // b3 = upper 4 bits of (height-1)
  const w1 = (width  - 1) & 0x3FFF;
  const h1 = (height - 1) & 0x3FFF;
  buf[21] = w1 & 0xFF;
  buf[22] = ((w1 >> 8) & 0x3F) | ((h1 & 0x03) << 6);
  buf[23] = (h1 >> 2) & 0xFF;
  buf[24] = (h1 >> 10) & 0x0F;
  return buf;
}

/** WebP / VP8X (extended) — 30 байт. */
function makeWebpVp8xHeader(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // flags @20, reserved @21..23, width-1 (24-bit LE) @24, height-1 @27.
  const w1 = width  - 1;
  const h1 = height - 1;
  buf[24] = w1 & 0xFF; buf[25] = (w1 >> 8) & 0xFF; buf[26] = (w1 >> 16) & 0xFF;
  buf[27] = h1 & 0xFF; buf[28] = (h1 >> 8) & 0xFF; buf[29] = (h1 >> 16) & 0xFF;
  return buf;
}

/**
 * Минимальный валидный JPEG: SOI + APP0 (JFIF) + SOF0 c заявленными
 * размерами + EOI. Достаточно для нашего парсера, который ищет SOFn.
 */
function makeJpegBuffer(width, height) {
  // SOI (2) + SOF0 (2 marker + 2 segLen + 1 precision + 2 H + 2 W + 1 nf + 0 cmp = 11) + EOI (2)
  const buf = Buffer.alloc(2 + 11 + 2);
  let i = 0;
  buf[i++] = 0xFF; buf[i++] = 0xD8;            // SOI
  buf[i++] = 0xFF; buf[i++] = 0xC0;            // SOF0
  buf.writeUInt16BE(11, i); i += 2;            // segLen (включает свои 2 байта)
  buf[i++] = 8;                                 // precision
  buf.writeUInt16BE(height, i); i += 2;
  buf.writeUInt16BE(width,  i); i += 2;
  buf[i++] = 0;                                 // num components
  buf[i++] = 0xFF; buf[i++] = 0xD9;            // EOI
  return buf;
}

function pad(buf, totalBytes) {
  if (buf.length >= totalBytes) return buf;
  return Buffer.concat([buf, Buffer.alloc(totalBytes - buf.length, 0)]);
}

function buildSlot(slot, opts = {}) {
  const buf = opts.buffer || pad(makePngHeader(opts.width || 1024, opts.height || 768),
    opts.totalBytes || MIN_BYTES + 1024);
  return {
    slot,
    section_h2:    opts.section_h2 || `Section ${slot}`,
    visual_prompt: 'prompt',
    negative_prompt: '',
    alt_ru:        opts.alt_ru === undefined ? `Alt for slot ${slot}` : opts.alt_ru,
    status:        opts.status || 'done',
    image_base64:  opts.image_base64 !== undefined ? opts.image_base64 : buf.toString('base64'),
    mime_type:     'image/png',
    error:         opts.error || null,
  };
}

// ── Test 1: decodeImageHeader ──────────────────────────────────────

console.log('\n=== Test 1: decodeImageHeader ===');
check('PNG 1024×768', () => {
  const r = decodeImageHeader(makePngHeader(1024, 768));
  assert.deepStrictEqual(r, { format: 'png', width: 1024, height: 768 });
});
check('GIF 200×100', () => {
  const r = decodeImageHeader(makeGifHeader(200, 100));
  assert.deepStrictEqual(r, { format: 'gif', width: 200, height: 100 });
});
check('JPEG 1280×720 (SOF0 scan)', () => {
  const r = decodeImageHeader(makeJpegBuffer(1280, 720));
  assert.deepStrictEqual(r, { format: 'jpeg', width: 1280, height: 720 });
});
check('WebP VP8 (lossy) 800×600', () => {
  const r = decodeImageHeader(makeWebpVp8Header(800, 600));
  assert.deepStrictEqual(r, { format: 'webp', width: 800, height: 600 });
});
check('WebP VP8L (lossless) 333×444', () => {
  const r = decodeImageHeader(makeWebpVp8lHeader(333, 444));
  assert.deepStrictEqual(r, { format: 'webp', width: 333, height: 444 });
});
check('WebP VP8X (extended) 4096×2160', () => {
  const r = decodeImageHeader(makeWebpVp8xHeader(4096, 2160));
  assert.deepStrictEqual(r, { format: 'webp', width: 4096, height: 2160 });
});
check('garbage → null', () => {
  assert.strictEqual(decodeImageHeader(Buffer.from('hello world! not an image, нет')), null);
});
check('empty buf → null', () => {
  assert.strictEqual(decodeImageHeader(Buffer.alloc(0)), null);
});
check('non-buffer → null', () => {
  assert.strictEqual(decodeImageHeader('PNG'), null);
  assert.strictEqual(decodeImageHeader(null), null);
});

// ── Test 2: arClass ────────────────────────────────────────────────

console.log('\n=== Test 2: arClass ===');
check('1.78 (16:9) → landscape', () => assert.strictEqual(arClass(1.78), 'landscape'));
check('0.56 (9:16) → portrait',  () => assert.strictEqual(arClass(0.5625), 'portrait'));
check('1.0 (square)',            () => assert.strictEqual(arClass(1.0), 'square'));
check('1.2 boundary → landscape',() => assert.strictEqual(arClass(1.2), 'landscape'));
check('0 → unknown',             () => assert.strictEqual(arClass(0), 'unknown'));

// ── Test 3: analyzeSlot ────────────────────────────────────────────

console.log('\n=== Test 3: analyzeSlot ===');

check('status=error → generation_failed (error)', () => {
  const r = analyzeSlot(buildSlot(1, { status: 'error', error: 'Quota exceeded',
    image_base64: null }));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.has_image, false);
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].code, 'generation_failed');
  assert.strictEqual(r.issues[0].level, 'error');
});

check('status=done но image_base64 пустой → no_image (error)', () => {
  const r = analyzeSlot(buildSlot(1, { image_base64: null }));
  assert.ok(r.issues.some((it) => it.code === 'no_image' && it.level === 'error'));
});

check('валидный PNG cover landscape — без ошибок', () => {
  const r = analyzeSlot(buildSlot(1, { width: 1920, height: 1080 }));
  assert.strictEqual(r.has_image, true);
  assert.strictEqual(r.format, 'png');
  assert.strictEqual(r.width, 1920);
  assert.strictEqual(r.height, 1080);
  assert.strictEqual(r.aspect_class, 'landscape');
  assert.strictEqual(r.issues.length, 0, JSON.stringify(r.issues));
});

check('файл < MIN_BYTES → too_small_bytes (error)', () => {
  // 100-байтовая шапка PNG, без паддинга
  const buf = makePngHeader(1024, 768);
  const r = analyzeSlot(buildSlot(1, {
    image_base64: buf.toString('base64'),
    totalBytes: 0, // pass-through
  }));
  // Перепишем, т.к. buildSlot ниже padит: используем raw base64 напрямую.
  const r2 = analyzeSlot({
    slot: 1, status: 'done', section_h2: '', alt_ru: 'a',
    image_base64: buf.toString('base64'),
  });
  assert.ok(r2.bytes < MIN_BYTES, `bytes=${r2.bytes}`);
  assert.ok(r2.issues.some((it) => it.code === 'too_small_bytes' && it.level === 'error'));
});

check('файл > maxBytes (override) → too_large_bytes (warn)', () => {
  const big = pad(makePngHeader(1024, 768), 200 * 1024); // 200 KB
  const r = analyzeSlot({
    slot: 2, status: 'done', section_h2: '', alt_ru: 'a',
    image_base64: big.toString('base64'),
  }, { maxBytes: 50 * 1024 });
  assert.ok(r.issues.some((it) => it.code === 'too_large_bytes' && it.level === 'warn'),
    JSON.stringify(r.issues));
});

check('битый base64 (без padding) — analyzed без crash', () => {
  // Buffer.from в strict mode молча игнорирует invalid chars; зато header_decode_failed.
  const r = analyzeSlot({
    slot: 1, status: 'done', section_h2: '', alt_ru: 'a',
    image_base64: 'не_base64_вообще_~~~',
  });
  assert.strictEqual(r.has_image, true); // buffer создан (пусть и мусорный)
  assert.ok(r.issues.some((it) => it.code === 'header_decode_failed' && it.level === 'error'));
});

check('не распознанный формат → header_decode_failed', () => {
  const buf = pad(Buffer.from('NOT_A_REAL_IMAGE_HEADER_AT_ALL_____'), MIN_BYTES + 100);
  const r = analyzeSlot({
    slot: 1, status: 'done', section_h2: '', alt_ru: 'a',
    image_base64: buf.toString('base64'),
  });
  assert.ok(r.issues.some((it) => it.code === 'header_decode_failed'));
  assert.strictEqual(r.format, null);
});

check('размеры < MIN_DIM → too_small_dimensions', () => {
  const r = analyzeSlot(buildSlot(1, { width: 100, height: 100 }));
  assert.ok(r.issues.some((it) => it.code === 'too_small_dimensions' && it.level === 'error'),
    JSON.stringify(r.issues));
});

check('cover (slot=1) AR=1.0 → cover_not_landscape (warn)', () => {
  const r = analyzeSlot(buildSlot(1, { width: 1024, height: 1024 }));
  assert.ok(r.issues.some((it) => it.code === 'cover_not_landscape' && it.level === 'warn'),
    JSON.stringify(r.issues));
});

check('inline (slot=2) AR=1.0 — не triggers cover_not_landscape', () => {
  const r = analyzeSlot(buildSlot(2, { width: 1024, height: 1024 }));
  assert.ok(!r.issues.some((it) => it.code === 'cover_not_landscape'));
});

check('AR > INLINE_MAX_AR → aspect_out_of_range (error)', () => {
  const r = analyzeSlot(buildSlot(2, { width: 4500, height: 800 })); // ≈ 5.6
  assert.ok(r.issues.some((it) => it.code === 'aspect_out_of_range'),
    JSON.stringify(r.issues));
});

check('пустой alt_ru → missing_alt (warn)', () => {
  const r = analyzeSlot(buildSlot(1, { width: 1920, height: 1080, alt_ru: '' }));
  assert.ok(r.issues.some((it) => it.code === 'missing_alt' && it.level === 'warn'));
});

check('alt из пробелов → missing_alt', () => {
  const r = analyzeSlot(buildSlot(1, { width: 1920, height: 1080, alt_ru: '   \t  ' }));
  assert.ok(r.issues.some((it) => it.code === 'missing_alt'));
});

check('sha256 заполнен на done-слоте', () => {
  const r = analyzeSlot(buildSlot(1, { width: 1920, height: 1080 }));
  assert.strictEqual(typeof r.sha256, 'string');
  assert.strictEqual(r.sha256.length, 64);
});

// ── Test 4: detectDuplicates ───────────────────────────────────────

console.log('\n=== Test 4: detectDuplicates ===');

check('два слота с одинаковым PNG → duplicate_image; warn (без cover)', () => {
  const buf = pad(makePngHeader(1024, 768), MIN_BYTES + 1024);
  const b64 = buf.toString('base64');
  const slots = [
    analyzeSlot(buildSlot(2, { image_base64: b64 })),
    analyzeSlot(buildSlot(3, { image_base64: b64 })),
  ];
  const groups = detectDuplicates(slots);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].slots, [2, 3]);
  assert.strictEqual(groups[0].includes_cover, false);
  for (const s of slots) {
    const dup = s.issues.find((it) => it.code === 'duplicate_image');
    assert.ok(dup, `slot ${s.slot} missing dup issue`);
    assert.strictEqual(dup.level, 'warn');
  }
});

check('cover дублируется → duplicate_image error', () => {
  const buf = pad(makePngHeader(1920, 1080), MIN_BYTES + 1024);
  const b64 = buf.toString('base64');
  const slots = [
    analyzeSlot(buildSlot(1, { image_base64: b64 })),
    analyzeSlot(buildSlot(2, { image_base64: b64 })),
  ];
  const groups = detectDuplicates(slots);
  assert.strictEqual(groups[0].includes_cover, true);
  assert.ok(slots[0].issues.find((it) => it.code === 'duplicate_image' && it.level === 'error'));
  assert.ok(slots[1].issues.find((it) => it.code === 'duplicate_image' && it.level === 'error'));
});

check('разные картинки → нет дублей', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { width: 1920, height: 1080 })),
    analyzeSlot(buildSlot(2, { width: 1024, height: 768 })),
  ];
  const groups = detectDuplicates(slots);
  assert.strictEqual(groups.length, 0);
});

// ── Test 5: summarizeImageQa + verdict ─────────────────────────────

console.log('\n=== Test 5: summarizeImageQa ===');

check('na — пустой массив', () => {
  const s = summarizeImageQa([]);
  assert.strictEqual(s.verdict, 'na');
  assert.strictEqual(s.totalSlots, 0);
});

check('na — все error/no-image', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { status: 'error', error: 'X', image_base64: null })),
  ];
  const s = summarizeImageQa(slots);
  assert.strictEqual(s.doneSlots, 0);
  // total>0 + done==0 → na
  assert.strictEqual(s.verdict, 'na');
});

check('pass — 1 cover landscape без issues', () => {
  const slots = [analyzeSlot(buildSlot(1, { width: 1920, height: 1080 }))];
  const s = summarizeImageQa(slots);
  assert.strictEqual(s.verdict, 'pass');
  assert.strictEqual(s.coverOk, true);
  assert.strictEqual(s.errors, 0);
  assert.strictEqual(s.warnings, 0);
});

check('review — cover ok + inline missing_alt warn', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { width: 1920, height: 1080 })),
    analyzeSlot(buildSlot(2, { width: 1024, height: 1024, alt_ru: '' })),
  ];
  const s = summarizeImageQa(slots);
  assert.strictEqual(s.verdict, 'review', `expected review, got ${s.verdict} ` +
    JSON.stringify(slots.map(x => x.issues)));
  assert.strictEqual(s.errors, 0);
  assert.ok(s.warnings >= 1);
});

check('fail — cover отсутствует (status=error)', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { status: 'error', error: 'X', image_base64: null })),
    analyzeSlot(buildSlot(2, { width: 1024, height: 768 })),
  ];
  const s = summarizeImageQa(slots);
  assert.strictEqual(s.verdict, 'fail');
  assert.strictEqual(s.coverOk, false);
});

check('fail — cover ok, но inline aspect_out_of_range error', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { width: 1920, height: 1080 })),
    analyzeSlot(buildSlot(2, { width: 4500, height: 800 })),
  ];
  const s = summarizeImageQa(slots);
  assert.strictEqual(s.verdict, 'fail');
});

check('summary.formats гистограмма', () => {
  const slots = [
    analyzeSlot(buildSlot(1, { width: 1920, height: 1080 })), // PNG
    analyzeSlot(buildSlot(2, { width: 1920, height: 1080 })), // PNG
  ];
  const s = summarizeImageQa(slots);
  assert.deepStrictEqual(s.formats, { png: 2 });
});

// ── Test 6: runImageQa (фасад) ─────────────────────────────────────

console.log('\n=== Test 6: runImageQa (facade) ===');

check('returns structure with slots + summary + duplicate_groups', () => {
  const r = runImageQa([
    buildSlot(1, { width: 1920, height: 1080 }),
    buildSlot(2, { width: 1024, height: 768 }),
  ]);
  assert.ok(r.summary);
  assert.ok(Array.isArray(r.slots));
  assert.ok(Array.isArray(r.duplicate_groups));
  assert.strictEqual(r.slots.length, 2);
  assert.strictEqual(r.summary.verdict, 'pass');
  assert.strictEqual(typeof r.generated_at, 'string');
});

check('non-array → na, не throw', () => {
  const r = runImageQa(null);
  assert.strictEqual(r.summary.verdict, 'na');
  assert.strictEqual(r.summary.totalSlots, 0);
});

check('runImageQa никогда не throw на странных данных', () => {
  // Сломанные слоты внутри массива — не должны валить facade.
  const r = runImageQa([
    null,
    {},
    { slot: 5, status: 'done', image_base64: 'AAA=', alt_ru: 'a' },
  ]);
  assert.ok(r);
  assert.ok(Array.isArray(r.slots));
  assert.strictEqual(r.slots.length, 3);
});

check('thresholds возвращаются в summary', () => {
  const r = runImageQa([buildSlot(1, { width: 1920, height: 1080 })]);
  assert.strictEqual(r.summary.thresholds.minDim, MIN_DIM);
  assert.strictEqual(r.summary.thresholds.coverMinAr, COVER_MIN_AR);
  assert.strictEqual(r.summary.thresholds.inlineMinAr, INLINE_MIN_AR);
  assert.strictEqual(r.summary.thresholds.inlineMaxAr, INLINE_MAX_AR);
});

check('e2e: cover дублируется + inline ok → fail', () => {
  const buf = pad(makePngHeader(1920, 1080), MIN_BYTES + 1024);
  const b64 = buf.toString('base64');
  const r = runImageQa([
    buildSlot(1, { image_base64: b64 }),
    buildSlot(2, { image_base64: b64 }),
  ]);
  assert.strictEqual(r.summary.verdict, 'fail');
  assert.strictEqual(r.duplicate_groups.length, 1);
  assert.strictEqual(r.duplicate_groups[0].includes_cover, true);
});

// ── Итог ───────────────────────────────────────────────────────────

console.log(`\n${_pass}/${_cases} passed`);
process.exit(_pass === _cases ? 0 : 1);
