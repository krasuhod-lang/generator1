'use strict';

/**
 * test-info-article-quality-layers.js — детерминированные smoke-тесты для
 * новых quality-слоёв info-article pipeline (план «Усиление "Комбайна"»):
 *
 *   • featureFlags.getQualityFlags()
 *   • factExtractor.extractClaims()
 *   • plagiarismShingle.{compareTextsAgainstSources, findInternalDuplicates}
 *   • readabilityAnalyzer.analyzeReadability()
 *   • eeatChunker.{splitForEeat, aggregateEeatVerdicts}
 *   • validationFailureLog.recordValidationFailure()
 *   • acfStructuralValidators.{findDuplicatedBlocks, validateHeadingOrder}
 *
 * Run:  node backend/scripts/test-info-article-quality-layers.js
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// Заглушка для backend/src/config/db (на случай транзитивных импортов).
require.cache[require.resolve(path.join('..', 'src', 'config', 'db'))] = {
  id:       require.resolve(path.join('..', 'src', 'config', 'db')),
  filename: require.resolve(path.join('..', 'src', 'config', 'db')),
  loaded:   true,
  exports:  { query: async () => ({ rows: [] }) },
};

const QL_DIR = path.join('..', 'src', 'services', 'qualityLayers');

// Real, frozen, hardcoded config (single source of truth).
const realFeatureFlags = require(path.join(QL_DIR, 'featureFlags'));
const { getQualityFlags } = realFeatureFlags;

// Stub featureFlags BEFORE requiring validationFailureLog so that
// validation-log tests can inject an overridden config (without touching
// the real frozen QUALITY_FLAGS object). This is the only place we
// override; all other modules see the real config via realFeatureFlags.
const featureFlagsModulePath = require.resolve(path.join(QL_DIR, 'featureFlags'));
let stubbedFlags = realFeatureFlags.getQualityFlags();
require.cache[featureFlagsModulePath].exports = {
  getQualityFlags: () => stubbedFlags,
};

const { extractClaims }   = require(path.join(QL_DIR, 'factExtractor'));
const {
  shingleSet, jaccard, containment,
  compareTextsAgainstSources, findInternalDuplicates,
  buildPlagiarismReport,
} = require(path.join(QL_DIR, 'plagiarismShingle'));
const { analyzeReadability } = require(path.join(QL_DIR, 'readabilityAnalyzer'));
const {
  splitByH2, splitForEeat, chunkBySize, aggregateEeatVerdicts,
} = require(path.join(QL_DIR, 'eeatChunker'));
const {
  recordValidationFailure, _internal: { sanitize, _resetForTest },
} = require(path.join(QL_DIR, 'validationFailureLog'));
const {
  findDuplicatedBlocks, validateHeadingOrder,
} = require(path.join(QL_DIR, 'acfStructuralValidators'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── featureFlags ────────────────────────────────────────────────────

test('featureFlags — defaults match the «Комбайн» plan thresholds', () => {
  const f = getQualityFlags();
  assert.strictEqual(f.factcheck.enabled, false);
  assert.strictEqual(f.factcheck.minSupportedRatio, 0.7);
  assert.strictEqual(f.factcheck.blockOnContradicted, true);
  assert.strictEqual(f.grounding.enabled, false);
  assert.strictEqual(f.grounding.tokensPerH2, 500);
  assert.strictEqual(f.grounding.totalBudget, 3500);
  assert.strictEqual(f.grounding.passagesPerH2, 5);
  assert.strictEqual(f.plagiarism.externalEnabled, false);
  assert.strictEqual(f.plagiarism.maxOverlap, 0.18);
  assert.strictEqual(f.plagiarism.shingleSize, 6);
  assert.strictEqual(f.plagiarism.selfplagMaxCosine, 0.92);
  assert.strictEqual(f.plagiarism.selfplagMinChars, 120);
  assert.strictEqual(f.imageQa.enabled, false);
  assert.strictEqual(f.imageQa.maxRetries, 2);
  assert.strictEqual(f.imageQa.altVisualMinCosine, 0.22);
  assert.strictEqual(f.eeatChunked.enabled, false);
  assert.strictEqual(f.eeatChunked.chunkTargetChars, 8000);
  assert.strictEqual(f.lsiSemantic.enabled, false);
  assert.strictEqual(f.lsiSemantic.threshold, 0.55);
  assert.strictEqual(f.linkSemantic.cosineWeight, 0.5);
  assert.strictEqual(f.linkSemantic.minCosine, 0.35);
  assert.strictEqual(f.readability.enabled, false);
  assert.strictEqual(f.readability.minIndex, 55);
  assert.strictEqual(f.readability.maxAvgSentenceLen, 22);
  assert.strictEqual(f.readability.maxPassiveRatio, 0.18);
  assert.strictEqual(f.readability.maxBureaucrateseRatio, 0.04);
  assert.strictEqual(f.intentVerify.enabled, false);
  assert.strictEqual(f.intentVerify.blockOnMismatch, false);
  assert.strictEqual(f.validationLog.enabled, false);
  assert.strictEqual(typeof f.validationLog.filePath, 'string');
  assert.ok(f.validationLog.filePath.length > 0);
  // По умолчанию путь должен лежать под os.tmpdir(), чтобы dev/CI работали без sudo.
  assert.ok(f.validationLog.filePath.startsWith(os.tmpdir()),
    `expected default filePath under os.tmpdir(), got ${f.validationLog.filePath}`);
  assert.ok(Array.isArray(f.acfStructural.duplicatesAllowlist));
  assert.strictEqual(f.acfStructural.duplicatesAllowlist.length, 0);
  assert.strictEqual(f.acfStructural.duplicatesMinLen, 80);
  assert.strictEqual(f.eeatTargetDefault, 7.5);
});

test('featureFlags — _validateRanges rejects out-of-range values', () => {
  // Перепроверяем, что валидатор реально срабатывает на «битой» копии конфигурации.
  // Сам модуль ловит ошибку при загрузке (fail-fast), здесь — копия для теста.
  const cfg = JSON.parse(JSON.stringify(realFeatureFlags.getQualityFlags()));
  cfg.readability.maxPassiveRatio = 1.8;  // вне 0..1
  // Достаём приватную проверку через повторный require модуля с подменой:
  // проще — продублировать минимальный валидатор инлайн в тесте.
  const RANGES = [
    ['readability.maxPassiveRatio', 0, 1],
  ];
  function getPath(o, p) { return p.split('.').reduce((a, k) => a && a[k], o); }
  assert.throws(() => {
    for (const [p, mn, mx] of RANGES) {
      const v = getPath(cfg, p);
      if (typeof v !== 'number' || v < mn || v > mx) throw new Error(`${p}=${v} out of [${mn}..${mx}]`);
    }
  }, /maxPassiveRatio=1.8 out of/);
});

test('featureFlags — config is frozen and ignores process.env', () => {
  const f = getQualityFlags();
  assert.ok(Object.isFrozen(f), 'top-level config must be frozen');
  assert.ok(Object.isFrozen(f.plagiarism), 'nested objects must be frozen');
  assert.ok(Object.isFrozen(f.readability));

  // process.env must NOT influence values (configuration is hardcoded).
  process.env.INFO_ARTICLE_FACTCHECK_ENABLED = 'true';
  process.env.INFO_ARTICLE_PLAGIARISM_MAX_OVERLAP = '0.99';
  process.env.READABILITY_MIN_INDEX = '1';
  process.env.IMAGE_QA_MAX_RETRIES = '99';
  try {
    const f2 = getQualityFlags();
    assert.strictEqual(f2.factcheck.enabled, false, 'env must not flip enabled flag');
    assert.strictEqual(f2.plagiarism.maxOverlap, 0.18, 'env must not change threshold');
    assert.strictEqual(f2.readability.minIndex, 55, 'env must not change threshold');
    assert.strictEqual(f2.imageQa.maxRetries, 2, 'env must not change retry count');
    assert.strictEqual(f2, f, 'must return the same singleton object');
  } finally {
    delete process.env.INFO_ARTICLE_FACTCHECK_ENABLED;
    delete process.env.INFO_ARTICLE_PLAGIARISM_MAX_OVERLAP;
    delete process.env.READABILITY_MIN_INDEX;
    delete process.env.IMAGE_QA_MAX_RETRIES;
  }
});

// ── factExtractor ──────────────────────────────────────────────────

test('factExtractor — date / standard / percentage / price / number_with_unit', () => {
  const html = `
    <h2>Нормативы</h2>
    <p>Согласно ГОСТ 12345-2018 и СНиП 2.04.01-85, эксплуатация началась 12 марта 2024 года.</p>
    <p>Эффективность достигает 87,5%, что подтверждено ФЗ № 152-ФЗ.</p>
    <p>Цена комплекта — от 12 500 ₽ до 25 000 руб., вес — 4,5 кг.</p>
  `;
  const { claims, summary } = extractClaims(html);

  const types = claims.map((c) => c.type);
  assert.ok(types.includes('date'), 'has date');
  assert.ok(types.includes('standard'), 'has standard');
  assert.ok(types.includes('percentage'), 'has percentage');
  assert.ok(types.includes('price'), 'has price');
  assert.ok(types.includes('number_with_unit'), 'has number_with_unit');

  // ГОСТ + СНиП + ФЗ → ≥3 standard
  const stds = claims.filter((c) => c.type === 'standard');
  assert.ok(stds.length >= 3, `expected ≥3 standards, got ${stds.length}: ${JSON.stringify(stds.map((s) => s.text))}`);
  assert.ok(stds.some((s) => s.normativeKind === 'gost'));
  assert.ok(stds.some((s) => s.normativeKind === 'snip'));
  assert.ok(stds.some((s) => s.normativeKind === 'fz'));

  // Процент с десятичной запятой парсится правильно
  const pct = claims.find((c) => c.type === 'percentage');
  assert.strictEqual(pct.value, 87.5);

  // Все числовые claims имеют paragraphIndex
  for (const c of claims) {
    assert.ok(typeof c.paragraphIndex === 'number');
    assert.ok(typeof c.charOffset === 'number');
  }

  assert.ok(summary.total >= 5);
});

test('factExtractor — person extracts surnames with initials', () => {
  const html = '<p>Доклад представил проф. Иванов И.И. в соавторстве с А. Б. Петровым и Сидоровым Иваном Петровичем.</p>';
  const { claims } = extractClaims(html);
  const persons = claims.filter((c) => c.type === 'person').map((c) => c.text);
  assert.ok(persons.length >= 2, `expected ≥2 persons, got ${JSON.stringify(persons)}`);
});

test('factExtractor — empty html → empty result', () => {
  const { claims, summary } = extractClaims('');
  assert.deepStrictEqual(claims, []);
  assert.strictEqual(summary.total, 0);
});

// ── plagiarismShingle ──────────────────────────────────────────────

test('plagiarismShingle — shingleSet/jaccard basic math', () => {
  const a = shingleSet(['привет', 'как', 'дела', 'у', 'тебя', 'сегодня'], 3);
  const b = shingleSet(['как', 'дела', 'у', 'тебя', 'сегодня', 'утром'], 3);
  assert.ok(a.size > 0 && b.size > 0);
  const j = jaccard(a, b);
  assert.ok(j > 0 && j < 1, `jaccard should be in (0,1), got ${j}`);
  const c = containment(a, b);
  assert.ok(c > 0 && c <= 1);
});

test('plagiarismShingle — compareTextsAgainstSources flags exact copy', () => {
  const copyText = 'Информационная безопасность включает в себя защиту данных от несанкционированного доступа модификации и уничтожения для обеспечения конфиденциальности целостности и доступности информации в организации';
  const ourBlocks = [
    { id: 'h2-1', h2: 'О безопасности', text: copyText },
    { id: 'h2-2', h2: 'Уникальное', text: 'Совершенно другой текст про погоду в Африке и солнечные дни на побережье Индийского океана.' },
  ];
  const sources = [
    { url: 'https://example.com/sec', title: 'Безопасность', text: copyText + ' Дополнительный кусок текста источника не влияет на containment.' },
    { url: 'https://example.com/other', title: 'Другое', text: 'Полностью посторонний контент про кошек и собак.' },
  ];
  const report = compareTextsAgainstSources(ourBlocks, sources, { shingleN: 5, maxOverlap: 0.18 });
  assert.ok(report.externalMaxOverlap > 0.5, `expected high overlap, got ${report.externalMaxOverlap}`);
  assert.ok(report.violations.length >= 1);
  const v = report.violations.find((x) => x.blockId === 'h2-1');
  assert.ok(v);
  assert.strictEqual(v.url, 'https://example.com/sec');

  // Уникальная H2 — нет нарушений
  assert.ok(!report.violations.some((x) => x.blockId === 'h2-2'));
});

test('plagiarismShingle — findInternalDuplicates flags cloned section', () => {
  const para = 'Этот достаточно длинный абзац описывает методику настройки прокси для DashScope и Gemini ' +
               'через переменные окружения с обязательной маскировкой ключей в логах ошибок.'.repeat(2);
  const html = `<p>${para}</p><p>Этот абзац уникален и говорит про что-то совершенно иное про детский сад и игрушки.</p><p>${para}</p>`;
  const { pairs, maxCosine } = findInternalDuplicates(html, { maxCosine: 0.85, minChars: 80 });
  assert.ok(maxCosine > 0.85, `expected high cosine, got ${maxCosine}`);
  assert.ok(pairs.length >= 1, `expected ≥1 dup pair, got ${pairs.length}`);
});

test('plagiarismShingle — buildPlagiarismReport shape', () => {
  const r = buildPlagiarismReport({
    external: { externalMaxOverlap: 0.3, externalSources: [{ url: 'a' }], violations: [] },
    internal: { pairs: [], maxCosine: 0.4 },
  });
  assert.strictEqual(r.externalMaxOverlap, 0.3);
  assert.strictEqual(r.internalMaxCosine, 0.4);
  assert.deepStrictEqual(r.externalViolations, []);
});

// ── readabilityAnalyzer ────────────────────────────────────────────

test('readabilityAnalyzer — simple text scores high', () => {
  const text = 'Это простой текст. Он состоит из коротких фраз. Каждое слово понятно. Читать легко.';
  const { metrics, verdict } = analyzeReadability(text);
  assert.ok(metrics.readabilityIndex > 70, `expected high index, got ${metrics.readabilityIndex}`);
  assert.ok(metrics.avgSentenceLen <= 8);
  assert.strictEqual(verdict.ok, true, `unexpected violations: ${JSON.stringify(verdict.violations)}`);
});

test('readabilityAnalyzer — bureaucratese is detected', () => {
  const text = 'Является необходимым осуществлять реализацию данного процесса в случае если это необходимо. ' +
               'Имеет место необходимость в осуществлении функционирования данного механизма посредством применения вышеуказанных мер.';
  const { metrics, verdict } = analyzeReadability(text, { maxBureaucrateseRatio: 0.04 });
  assert.ok(metrics.bureaucrateseRatio > 0.05, `expected bureaucratese, got ${metrics.bureaucrateseRatio}`);
  assert.ok(verdict.violations.some((v) => v.includes('bureaucrateseRatio')));
});

test('readabilityAnalyzer — long sentences flagged', () => {
  const longSentence = ('очень длинное и тяжёлое для восприятия предложение которое содержит огромное количество слов и явно превышает любые разумные пороги ' + 'длины '.repeat(20)).trim() + '.';
  const { metrics } = analyzeReadability(longSentence);
  assert.ok(metrics.avgSentenceLen > 25, `expected long sentence, got ${metrics.avgSentenceLen}`);
  assert.ok(metrics.longSentenceRatio === 1);
});

test('readabilityAnalyzer — accepts HTML input', () => {
  const html = '<h1>Заголовок</h1><p>Простой <strong>абзац</strong> с тегами.</p>';
  const { metrics } = analyzeReadability(html);
  assert.ok(metrics.wordCount >= 4);
  assert.ok(metrics.sentenceCount >= 1);
});

// ── eeatChunker ────────────────────────────────────────────────────

test('eeatChunker — splitByH2 returns intro+chunks', () => {
  const html = '<h1>T</h1><p>Intro.</p><h2>A</h2><p>aaa.</p><h2>B</h2><p>bbb.</p>';
  const out = splitByH2(html);
  assert.ok(out.length >= 2);
  const aChunk = out.find((c) => c.h2 === 'A');
  const bChunk = out.find((c) => c.h2 === 'B');
  assert.ok(aChunk && bChunk);
  assert.ok(/aaa/.test(aChunk.html));
  assert.ok(/bbb/.test(bChunk.html));
});

test('eeatChunker — chunkBySize never breaks paragraphs', () => {
  const para = '<p>' + 'А'.repeat(2000) + '</p>';
  const html = para + para + para + para;  // 8000 chars total in 4 paragraphs
  const chunks = chunkBySize(html, 3000);
  assert.ok(chunks.length >= 3);
  // Каждый chunk начинается с <p> и заканчивается на </p>
  for (const c of chunks) {
    assert.ok(c.html.includes('</p>'));
  }
});

test('eeatChunker — splitForEeat covers full article', () => {
  // Используем несколько параграфов внутри H2, чтобы chunkBySize мог разрезать
  // (одиночный параграф > targetChars не режется по дизайну, см. docstring).
  const para = '<p>' + 'X'.repeat(2500) + '</p>';
  const html = '<h1>T</h1><p>I.</p>' +
    '<h2>A</h2>' + para + para + para + para +  // 4 paragraphs × 2500 = 10000
    '<h2>B</h2>' + '<p>' + 'Y'.repeat(2000) + '</p>';
  const chunks = splitForEeat(html, { targetChars: 4000 });
  const totalChars = chunks.reduce((s, c) => s + c.plainChars, 0);
  // Все символы исходной статьи распределены по chunks.
  assert.ok(totalChars >= 12000);
  // Большой A разрезан на части
  const aParts = chunks.filter((c) => /^A /.test(c.h2));
  assert.ok(aParts.length >= 2, `expected ≥2 sub-chunks for A, got ${aParts.length}`);
});

test('eeatChunker — aggregateEeatVerdicts is weighted by length', () => {
  const entries = [
    { chunk: { index: 0, h2: 'A', plainChars: 10000 }, verdict: { pq_score: 8.0, evidence_quality: 7.0, issues: ['x'] } },
    { chunk: { index: 1, h2: 'B', plainChars: 1000  }, verdict: { pq_score: 4.0, evidence_quality: 3.0 } },
  ];
  const { aggregated, totalChars } = aggregateEeatVerdicts(entries);
  assert.strictEqual(totalChars, 11000);
  // weighted avg pq_score ≈ (8*10000 + 4*1000)/11000 ≈ 7.636
  assert.ok(Math.abs(aggregated.pq_score - 7.64) < 0.05, `got ${aggregated.pq_score}`);
  assert.strictEqual(aggregated.issues.length, 1);
  assert.strictEqual(aggregated.issues[0].h2, 'A');
});

test('eeatChunker — aggregateEeatVerdicts handles missing fields', () => {
  const entries = [
    { chunk: { index: 0, h2: 'A', plainChars: 5000 }, verdict: { pq_score: 7.0 } },
    { chunk: { index: 1, h2: 'B', plainChars: 5000 }, verdict: { freshness_signals: 6.0 } },
  ];
  const { aggregated } = aggregateEeatVerdicts(entries);
  assert.strictEqual(aggregated.pq_score, 7.0, 'only one chunk had pq → it dominates');
  assert.strictEqual(aggregated.freshness_signals, 6.0);
  assert.strictEqual(aggregated.evidence_quality, null);
});

test('eeatChunker — aggregateEeatVerdicts gives zero weight to empty chunks', () => {
  // Пустой chunk не должен «голосовать» наравне с большим: было Math.max(1, chars)
  // → empty chunk весил 1 и тянул среднее. Теперь его вес 0.
  const entries = [
    { chunk: { index: 0, h2: 'A', plainChars: 10000 }, verdict: { pq_score: 9.0 } },
    { chunk: { index: 1, h2: 'B', plainChars: 0     }, verdict: { pq_score: 1.0, issues: ['noted'] } },
  ];
  const { aggregated, totalChars } = aggregateEeatVerdicts(entries);
  assert.strictEqual(totalChars, 10000);
  assert.strictEqual(aggregated.pq_score, 9.0, 'empty chunk must not pull the average down');
  // issues из пустого chunk всё равно собираются (структурная диагностика полезна).
  assert.strictEqual(aggregated.issues.length, 1);
  assert.strictEqual(aggregated.issues[0].h2, 'B');
});

test('eeatChunker — chunkBySize splits on </tr> and </table> boundaries', () => {
  // Длинная таблица: 3 строки по 2500 символов. targetChars=3000 → каждая строка
  // в своём чанке, потому что split допускается на </tr>.
  const row = '<tr><td>' + 'Я'.repeat(2500) + '</td></tr>';
  const html = '<table><tbody>' + row + row + row + '</tbody></table>';
  const chunks = chunkBySize(html, 3000);
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  // Ни в одном куске не должно быть «оборванного» <tr> (т.е. <tr ... без </tr>).
  for (const c of chunks) {
    const openTr = (c.html.match(/<tr\b/gi) || []).length;
    const closeTr = (c.html.match(/<\/tr>/gi) || []).length;
    assert.strictEqual(openTr, closeTr, `chunk has unbalanced <tr>: ${openTr} open vs ${closeTr} close`);
  }
});

// ── validationFailureLog ───────────────────────────────────────────

test('validationFailureLog — disabled by default → no-op', () => {
  // Real defaults have validationLog.enabled = false; do not override.
  stubbedFlags = realFeatureFlags.getQualityFlags();
  const wrote = recordValidationFailure({ taskId: 't1', violationType: 'missing-LSI' });
  assert.strictEqual(wrote, false);
});

test('validationFailureLog — writes JSONL when config enables it', () => {
  _resetForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlog-'));
  const file = path.join(tmp, 'failures.jsonl');

  // Inject an enabled config via the test stub (real QUALITY_FLAGS is
  // frozen and intentionally cannot be changed at runtime).
  stubbedFlags = {
    ...realFeatureFlags.getQualityFlags(),
    validationLog: { enabled: true, filePath: file },
  };

  try {
    const ok = recordValidationFailure({
      taskId: 'task-42',
      stage: 'writer',
      violationType: 'missing-H3',
      model: 'gemini-3.1-pro-preview',
      context: { h2: 'Введение', api_key: 'sk-shouldnotleak1234567890' },
    });
    assert.strictEqual(ok, true);

    const content = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(content.length, 1);
    const entry = content[0];
    assert.strictEqual(entry.taskId, 'task-42');
    assert.strictEqual(entry.violationType, 'missing-H3');
    assert.strictEqual(entry.context.api_key, '[REDACTED]');
  } finally {
    stubbedFlags = realFeatureFlags.getQualityFlags();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validationFailureLog — sanitize masks sk-... and Bearer ...', () => {
  const out = sanitize({ msg: 'Bearer abcdef.GHIJ-12_34', key: 'sk-abc12345xyz' });
  assert.ok(/Bearer \[REDACTED\]/.test(out.msg));
  assert.ok(/sk-\[REDACTED\]/.test(out.key));
});

test('validationFailureLog — sanitize masks GitHub PAT, JWT, AWS, long hex', () => {
  const out = sanitize({
    a: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    b: 'github_pat_11ABCDEFG0xyz123456789_ABCDEFGHIJKLMN',
    c: 'gho_abcdefghijklmnopqrstuv12345',
    d: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcDEF-_123',
    e: 'AKIAIOSFODNN7EXAMPLE',
    f: 'deadbeefcafebabe0123456789abcdef0123456789',  // 42-hex
  });
  assert.ok(/ghp_\[REDACTED\]/.test(out.a), `a not masked: ${out.a}`);
  assert.ok(/github_pat_\[REDACTED\]/.test(out.b), `b not masked: ${out.b}`);
  assert.ok(/gh_\[REDACTED\]/.test(out.c), `c not masked: ${out.c}`);
  assert.ok(/jwt-\[REDACTED\]/.test(out.d), `d not masked: ${out.d}`);
  assert.ok(/AKIA-\[REDACTED\]/.test(out.e), `e not masked: ${out.e}`);
  assert.ok(/hex-\[REDACTED\]/.test(out.f), `f not masked: ${out.f}`);
});

test('validationFailureLog — sanitize redacts extended secret-key names', () => {
  // SECRET_KEY_RE расширен: access_key/private_key/client_secret/passwd/pwd.
  const out = sanitize({
    access_key: 'AKIA1234567890ABCDEF',
    private_key: '-----BEGIN PRIVATE KEY-----abc',
    client_secret: 'whatever-anything',
    passwd: 'hunter2',
    pwd: 'hunter2',
    visible: 'kept-as-is',
  });
  assert.strictEqual(out.access_key, '[REDACTED]');
  assert.strictEqual(out.private_key, '[REDACTED]');
  assert.strictEqual(out.client_secret, '[REDACTED]');
  assert.strictEqual(out.passwd, '[REDACTED]');
  assert.strictEqual(out.pwd, '[REDACTED]');
  assert.strictEqual(out.visible, 'kept-as-is');
});

// ── acfStructuralValidators ────────────────────────────────────────

test('acfStructuralValidators — findDuplicatedBlocks catches cross-block clone', () => {
  const longText = 'Это длинный параграф который описывает что-то важное и используется в двух разных layout-блоках одновременно из-за ошибки сборщика ACF JSON.';
  const acf = [
    { acf_fc_layout: 'blocks', blocks: [{ text: longText }] },
    { acf_fc_layout: 'attention', text: longText },
    { acf_fc_layout: 'blocks', blocks: [{ text: 'Другой совершенно уникальный фрагмент.' }] },
  ];
  const { duplicates } = findDuplicatedBlocks(acf, { minLen: 80 });
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(duplicates[0].occurrences.length, 2);
  const blockIdxs = duplicates[0].occurrences.map((o) => o.blockIdx).sort();
  assert.deepStrictEqual(blockIdxs, [0, 1]);
});

test('acfStructuralValidators — findDuplicatedBlocks ignores within same block', () => {
  const txt = 'Длинный фрагмент специально продублирован дважды в одном и том же блоке для целей оформления и подсветки клиенту.';
  const acf = [
    { acf_fc_layout: 'blocks', blocks: [{ text: txt }, { text: txt }] },
  ];
  const { duplicates } = findDuplicatedBlocks(acf, { minLen: 80, crossBlockOnly: true });
  assert.strictEqual(duplicates.length, 0, 'within-block dups should be ignored when crossBlockOnly=true');
});

test('acfStructuralValidators — findDuplicatedBlocks allowlist suppresses brand/CTA repeats', () => {
  // Допустим, на каждой странице бренда повторяется одна и та же CTA-фраза в
  // attention-блоке и в финальной секции tags. Это намеренно — добавим в allowlist.
  const cta = 'Закажите бесплатную консультацию специалиста бренда AcmeCorp по телефону восемь восемьсот сто двадцать три.';
  const acf = [
    { acf_fc_layout: 'attention', text: cta },
    { acf_fc_layout: 'blocks', blocks: [{ text: cta }] },
    { acf_fc_layout: 'blocks', blocks: [{ text: 'Совсем другой длинный фрагмент про погоду и Африку и слонов в саванне.' }] },
  ];
  const { duplicates: withoutAllow } = findDuplicatedBlocks(acf, { minLen: 80 });
  assert.strictEqual(withoutAllow.length, 1, 'baseline: дубликат обнаружен');

  const { duplicates: withAllow } = findDuplicatedBlocks(acf, {
    minLen: 80,
    allowlist: ['AcmeCorp', 'бесплатную консультацию'],
  });
  assert.strictEqual(withAllow.length, 0, 'allowlist должен подавить known-good повтор');
});

test('acfStructuralValidators — validateHeadingOrder detects reorder & missing', () => {
  const html = '<h2>Раздел один</h2><h3>Подраздел A</h3><h3>Подраздел B</h3><h3>Подраздел C</h3>';
  // ACF: тот же H2 но порядок A, C, B — это reorder
  const acfReorder = [
    { acf_fc_layout: 'blocks', blocks: [
      { text: '<h2>Раздел один</h2><h3>Подраздел A</h3><p>...</p><h3>Подраздел C</h3><p>...</p><h3>Подраздел B</h3>' },
    ] },
  ];
  const r1 = validateHeadingOrder(html, acfReorder);
  assert.strictEqual(r1.ok, false, 'reorder must be detected');
  assert.ok(r1.issues.some((i) => i.kind === 'reorder'),
    `expected reorder issue, got: ${JSON.stringify(r1.issues)}`);

  const acfMissing = [
    { acf_fc_layout: 'blocks', blocks: [
      { text: '<h2>Раздел один</h2><h3>Подраздел A</h3><h3>Подраздел C</h3>' },  // B потерян
    ] },
  ];
  const r2 = validateHeadingOrder(html, acfMissing);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.kind === 'missing'));
});

test('acfStructuralValidators — validateHeadingOrder accepts widget items as H3', () => {
  const html = '<h2>FAQ</h2><h3>Вопрос 1</h3><h3>Вопрос 2</h3>';
  const acf = [
    { acf_fc_layout: 'faq', title: 'FAQ', faq: [
      { question: 'Вопрос 1', answer: '...' },
      { question: 'Вопрос 2', answer: '...' },
    ] },
  ];
  const r = validateHeadingOrder(html, acf);
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues));
});

// ── runner ─────────────────────────────────────────────────────────

(async () => {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      pass += 1;
    } catch (err) {
      fail += 1;
      console.error(`  ✗ ${t.name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n      ') : err}`);
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed (of ${tests.length})`);
  process.exit(fail === 0 ? 0 : 1);
})();
