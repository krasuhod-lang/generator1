'use strict';

/**
 * test-plagiarism.js — юнит-тесты для plagiarism.service.js (Phase 1, P0-3).
 *
 * Всё в памяти, без сети, без БД. Покрывает:
 *   • tokenize: нижний регистр, дефис в составе токена, пунктуация → разделитель,
 *     цифры, кириллица + латиница
 *   • buildNGrams: размер n, пропуск all-stop n-gram
 *   • buildNGramIndex: дедуп внутри сниппета, сбор статистики
 *   • computeSentenceOverlap: clean / suspicious / plagiarism, donors сортированы
 *   • greedy расширение run'а (длинная цитата = один матч, не сумма)
 *   • короткое предложение (< MIN_SENTENCE_TOKENS) → не идёт в overlap_pct_total
 *   • multi-source dedup в top_sentences (один URL — одна запись)
 *   • summarizePlagiarism: pass / review / fail / na
 *   • runPlagiarismCheck (фасад): top_sentences, top_donors, index_stats
 *
 * Запуск:  node backend/scripts/test-plagiarism.js
 */

const assert = require('assert');
const path   = require('path');

const {
  runPlagiarismCheck,
  buildNGramIndex,
  analyzeArticle,
  summarizePlagiarism,
  computeSentenceOverlap,
  tokenize,
  isStop,
  buildNGrams,
  N_GRAM_SIZE,
  SUSPICIOUS_THRESHOLD,
  PLAGIARISM_THRESHOLD,
  MIN_SENTENCE_TOKENS,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'plagiarism.service'));

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

// ── Test 1: tokenize ────────────────────────────────────────────────

console.log('\n=== Test 1: tokenize ===');
check('lowercase + кириллица + цифры + латиница', () => {
  assert.deepStrictEqual(
    tokenize('Hello, мир! 2024 — top10'),
    ['hello', 'мир', '2024', 'top10'],
  );
});
check('hyphenated word stays one token', () => {
  assert.deepStrictEqual(
    tokenize('Эстетико-косметический уход — топ-10'),
    ['эстетико-косметический', 'уход', 'топ-10'],
  );
});
check('punctuation flattens, multiple separators collapse', () => {
  assert.deepStrictEqual(
    tokenize('"один". (два) - три, четыре!'),
    ['один', 'два', 'три', 'четыре'],
  );
});
check('empty / null safe', () => {
  assert.deepStrictEqual(tokenize(''),    []);
  assert.deepStrictEqual(tokenize(null),  []);
  assert.deepStrictEqual(tokenize(123),   []);
});

// ── Test 2: stop-words ──────────────────────────────────────────────

console.log('\n=== Test 2: stop-words ===');
check('basic stop tokens identified', () => {
  for (const t of ['и', 'в', 'не', 'это', 'the', 'and', 'is']) {
    assert.ok(isStop(t), `expected ${t} to be stop`);
  }
});
check('content tokens are NOT stop', () => {
  for (const t of ['процедура', 'эстетический', 'клиника', 'patient', 'therapy']) {
    assert.ok(!isStop(t), `expected ${t} to be content`);
  }
});

// ── Test 3: buildNGrams ─────────────────────────────────────────────

console.log('\n=== Test 3: buildNGrams ===');
check('emits sliding n-grams of given size', () => {
  const tokens = ['a', 'b', 'c', 'd', 'e', 'f'];
  const ngs = buildNGrams(tokens, 3);
  // a/b/c — все content (нет в STOP), 4 n-gram'а ожидается.
  assert.strictEqual(ngs.length, 4);
  assert.strictEqual(ngs[0].key, 'a\u0001b\u0001c');
  assert.strictEqual(ngs[3].startIdx, 3);
});
check('skips n-grams composed entirely of stop-words', () => {
  // 'и в не это и' — все 5 стоп. Любой 3-gram из этих → skip.
  const tokens = ['и', 'в', 'не', 'это', 'и', 'клиника', 'эстетика'];
  const ngs = buildNGrams(tokens, 3);
  // Содержательные триграммы начинаются с index 3 ('это' хоть и stop, но 'клиника' — content).
  for (const ng of ngs) {
    const parts = ng.key.split('\u0001');
    const allStop = parts.every((t) => isStop(t));
    assert.ok(!allStop, `all-stop n-gram leaked: ${ng.key}`);
  }
  // Должен быть как минимум один валидный n-gram (последний триграм с content).
  assert.ok(ngs.length >= 1);
});
check('returns [] when token count < n', () => {
  assert.deepStrictEqual(buildNGrams(['a', 'b'], 5), []);
  assert.deepStrictEqual(buildNGrams([],         5), []);
});

// ── Test 4: buildNGramIndex ─────────────────────────────────────────

console.log('\n=== Test 4: buildNGramIndex ===');
check('builds index across multiple URLs and snippets', () => {
  const ev = {
    evidence: [
      { url: 'a.ru', h1: 'A', snippets: [
        { text: 'эстетическая косметология процедуры клиники топ' },
      ] },
      { url: 'b.ru', h1: 'B', snippets: [
        { text: 'процедуры клиники топ десять рейтинг лучшие' },
      ] },
    ],
  };
  const info = buildNGramIndex(ev, 3);
  assert.strictEqual(info.stats.snippets, 2);
  assert.ok(info.stats.uniqueNgrams > 0);
  assert.strictEqual(info.stats.n, 3);
});
check('dedupes same n-gram within ONE snippet (no double count)', () => {
  const ev = {
    evidence: [
      { url: 'a.ru', snippets: [
        { text: 'процедура клиника топ процедура клиника топ процедура клиника топ' },
      ] },
    ],
  };
  const info = buildNGramIndex(ev, 3);
  // n-gram "процедура\u0001клиника\u0001топ" должен быть в индексе ровно один раз
  // с одним донором (a.ru sIdx 0), а не три.
  const key = ['процедура', 'клиника', 'топ'].join('\u0001');
  const donors = info.index.get(key);
  assert.ok(donors, 'n-gram missing from index');
  assert.strictEqual(donors.length, 1, `expected 1 donor, got ${donors.length}`);
});
check('same n-gram across DIFFERENT snippets → multiple donors', () => {
  const ev = {
    evidence: [
      { url: 'a.ru', snippets: [{ text: 'процедура клиника топ десять рейтинг' }] },
      { url: 'b.ru', snippets: [{ text: 'процедура клиника топ описание услуг' }] },
    ],
  };
  const info = buildNGramIndex(ev, 3);
  const key = ['процедура', 'клиника', 'топ'].join('\u0001');
  const donors = info.index.get(key);
  assert.strictEqual(donors.length, 2);
});

// ── Test 5: computeSentenceOverlap ──────────────────────────────────

console.log('\n=== Test 5: computeSentenceOverlap ===');

// Универсальный helper-fixture: сниппет содержит длинную дословную фразу.
const evFixture = {
  evidence: [
    { url: 'donor-a.ru', h1: 'Donor A', snippets: [
      { text: 'эстетическая косметология включает процедуры пилинга чистки и массажа лица для улучшения качества кожи в любом возрасте' },
    ] },
    { url: 'donor-b.ru', h1: 'Donor B', snippets: [
      { text: 'современные клиники предлагают аппаратные методы восстановления упругости и эластичности кожи для женщин старше тридцати лет' },
    ] },
  ],
};
const idxInfo = buildNGramIndex(evFixture, 5);

check('clean sentence (нет совпадений 5-gram)', () => {
  const r = computeSentenceOverlap(
    'Наша клиника готова обсудить индивидуальный план ухода с каждым пациентом отдельно.',
    idxInfo,
  );
  assert.strictEqual(r.status, 'clean', `got status=${r.status} overlap=${r.overlapPct}`);
  assert.strictEqual(r.matchedTokens, 0);
  assert.deepStrictEqual(r.donors, []);
});
check('plagiarism sentence (длинная дословная цитата)', () => {
  // Точная цитата из donor-a, дополнена short tail для естественности.
  const r = computeSentenceOverlap(
    'эстетическая косметология включает процедуры пилинга чистки и массажа лица для улучшения качества кожи в любом возрасте без дополнительных условий',
    idxInfo,
  );
  assert.ok(r.overlapPct >= PLAGIARISM_THRESHOLD,
    `expected overlap ≥ ${PLAGIARISM_THRESHOLD}, got ${r.overlapPct}`);
  assert.strictEqual(r.status, 'plagiarism');
  assert.ok(r.donors.length >= 1);
  assert.strictEqual(r.donors[0].url, 'donor-a.ru');
});
check('suspicious sentence (часть фразы перефразирована)', () => {
  // Берём 6-7 совпадающих токенов из donor-b и добавляем своих ~10.
  const r = computeSentenceOverlap(
    'Программа разработана так, что современные клиники предлагают аппаратные методы восстановления упругости и наши специалисты подбирают курс под каждого клиента индивидуально.',
    idxInfo,
  );
  assert.ok(r.overlapPct >= SUSPICIOUS_THRESHOLD && r.overlapPct < PLAGIARISM_THRESHOLD,
    `expected overlap in [${SUSPICIOUS_THRESHOLD}, ${PLAGIARISM_THRESHOLD}), got ${r.overlapPct}`);
  assert.strictEqual(r.status, 'suspicious');
});
check('short sentence flagged (shortSentence=true, status=clean)', () => {
  const r = computeSentenceOverlap('Очень короткая фраза.', idxInfo);
  assert.strictEqual(r.shortSentence, true);
  assert.strictEqual(r.status, 'clean');
});
check('greedy: вся длинная цитата покрывается одним run\'ом, без двойного счёта', () => {
  // Если бы мы суммировали перекрывающиеся 5-gram, overlap > 100% было бы возможно.
  // greedy должен дать overlap ≤ 1.
  const r = computeSentenceOverlap(
    'эстетическая косметология включает процедуры пилинга чистки и массажа лица для улучшения качества кожи в любом возрасте',
    idxInfo,
  );
  assert.ok(r.overlapPct <= 1.0, `overlap >100% (double-counted): ${r.overlapPct}`);
  assert.ok(r.matchedTokens <= r.tokens, 'matchedTokens > totalTokens');
});

// ── Test 6: donors дедуп и сортировка ───────────────────────────────

console.log('\n=== Test 6: donors ───');
check('donors сортируются по убыванию matchedNgrams', () => {
  const ev = {
    evidence: [
      // weak-донор — содержит 1 общий 5-gram
      { url: 'weak.ru', snippets: [{
        text: 'когда нужна эстетическая косметология для лица без особых противопоказаний',
      }] },
      // strong-донор — содержит несколько overlapping 5-gram (длинная фраза)
      { url: 'strong.ru', snippets: [{
        text: 'эстетическая косметология включает процедуры пилинга чистки и массажа лица для общего улучшения',
      }] },
    ],
  };
  const info = buildNGramIndex(ev, 5);
  const r = computeSentenceOverlap(
    'эстетическая косметология включает процедуры пилинга чистки и массажа лица для улучшения цвета',
    info,
  );
  assert.ok(r.donors.length >= 1);
  // strong.ru должен быть первым (больше matchedNgrams)
  assert.strictEqual(r.donors[0].url, 'strong.ru');
});

// ── Test 7: summarizePlagiarism ─────────────────────────────────────

console.log('\n=== Test 7: summarizePlagiarism ===');
check('verdict=na for empty', () => {
  const s = summarizePlagiarism([]);
  assert.strictEqual(s.verdict, 'na');
  assert.strictEqual(s.totalSentences, 0);
});
check('verdict=pass when all clean and overlap minimal', () => {
  const per = [
    { status: 'clean',      tokens: 20, matchedTokens: 0, shortSentence: false },
    { status: 'clean',      tokens: 25, matchedTokens: 1, shortSentence: false },
  ];
  const s = summarizePlagiarism(per);
  assert.strictEqual(s.verdict, 'pass');
  assert.strictEqual(s.cleanCount, 2);
});
check('verdict=review with single plagiarism sentence (article overlap remains low)', () => {
  // 1 plagiarism sentence (16/20 matched = 80%) + 9 clean (each 30 tokens, 0 matched).
  // overlap_pct_total = 16 / (20 + 9*30) = 16/290 ≈ 5.5% < ARTICLE_REVIEW_PCT (10%),
  // но plagiarismCount === 1 → verdict=review. Это и проверяем.
  const per = [
    { status: 'plagiarism', tokens: 20, matchedTokens: 16, shortSentence: false },
    ...Array.from({ length: 9 }, () => ({
      status: 'clean', tokens: 30, matchedTokens: 0, shortSentence: false,
    })),
  ];
  const s = summarizePlagiarism(per);
  assert.strictEqual(s.plagiarismCount, 1);
  assert.ok(s.overlapPctTotal < 10, `overlapPctTotal=${s.overlapPctTotal} >= 10 (would force fail)`);
  assert.strictEqual(s.verdict, 'review');
});
check('verdict=fail with >1 plagiarism sentence', () => {
  const per = [
    { status: 'plagiarism', tokens: 20, matchedTokens: 16, shortSentence: false },
    { status: 'plagiarism', tokens: 20, matchedTokens: 16, shortSentence: false },
  ];
  const s = summarizePlagiarism(per);
  assert.strictEqual(s.verdict, 'fail');
});
check('verdict=fail when overlap_pct_total ≥ 20%', () => {
  // 4 предложения, по 25 токенов; matched 6 каждое → 24% overlap
  const per = Array.from({ length: 4 }, () => ({
    status: 'suspicious', tokens: 25, matchedTokens: 6, shortSentence: false,
  }));
  const s = summarizePlagiarism(per);
  assert.ok(s.overlapPctTotal >= 20, `got ${s.overlapPctTotal}`);
  assert.strictEqual(s.verdict, 'fail');
});
check('short sentences NOT counted in overlap_pct_total', () => {
  const per = [
    { status: 'clean', tokens: 0, matchedTokens: 0, shortSentence: true },   // skip
    { status: 'clean', tokens: 30, matchedTokens: 0, shortSentence: false },
  ];
  const s = summarizePlagiarism(per);
  assert.strictEqual(s.scoredSentences, 1);
  assert.strictEqual(s.totalSentences, 2);
  assert.strictEqual(s.overlapPctTotal, 0);
});

// ── Test 8: runPlagiarismCheck (E2E facade) ─────────────────────────

console.log('\n=== Test 8: runPlagiarismCheck (E2E) ===');
check('returns full report with summary, top_sentences, top_donors, index_stats', () => {
  const html = `
    <h2>Что такое эстетическая косметология</h2>
    <p>эстетическая косметология включает процедуры пилинга чистки и массажа лица для улучшения качества кожи в любом возрасте без особых противопоказаний.</p>
    <p>Наши специалисты разработают индивидуальную программу ухода специально для вас исходя из типа кожи и пожеланий клиента.</p>
  `;
  const report = runPlagiarismCheck(html, evFixture);
  assert.ok(report.summary);
  assert.ok(Array.isArray(report.top_sentences));
  assert.ok(Array.isArray(report.top_donors));
  assert.ok(report.index_stats);
  assert.ok(report.index_stats.snippets >= 1);
  assert.ok(report.top_sentences.length >= 1, 'expected ≥1 flagged sentence');
  // Первое (самое проблемное) — точная цитата из donor-a.
  assert.strictEqual(report.top_sentences[0].status, 'plagiarism');
  assert.ok(report.top_sentences[0].donors.some((d) => d.url === 'donor-a.ru'));
  // top_donors — дедуплицированы по URL.
  const urls = report.top_donors.map((d) => d.url);
  assert.strictEqual(new Set(urls).size, urls.length, 'top_donors not deduped');
});
check('empty evidence → verdict=pass (нечем сверять, нет совпадений)', () => {
  const html = `<p>Любой текст без совпадений потому что evidence пустой и индекс пуст.</p>`;
  const report = runPlagiarismCheck(html, { evidence: [] });
  assert.strictEqual(report.summary.plagiarismCount, 0);
  assert.strictEqual(report.summary.suspiciousCount, 0);
  assert.notStrictEqual(report.summary.verdict, 'fail');
});
check('top_sentences donors deduped by URL', () => {
  // Создадим evidence где один URL имеет 2 сниппета с одинаковыми n-gram.
  const ev = {
    evidence: [
      { url: 'dup.ru', snippets: [
        { text: 'эстетическая косметология включает процедуры пилинга чистки лица для всех' },
        { text: 'эстетическая косметология включает процедуры пилинга чистки лица для женщин' },
      ] },
    ],
  };
  const html = '<p>эстетическая косметология включает процедуры пилинга чистки лица для всех клиентов нашей клиники.</p>';
  const report = runPlagiarismCheck(html, ev);
  if (report.top_sentences.length > 0) {
    const urls = report.top_sentences[0].donors.map((d) => d.url);
    assert.strictEqual(new Set(urls).size, urls.length, 'donors not deduped per sentence');
  }
});

console.log('\n' + '─'.repeat(60));
if (_pass === _cases) {
  console.log(`✅ All ${_cases} plagiarism tests passed`);
  process.exit(0);
} else {
  console.log(`❌ ${_cases - _pass}/${_cases} plagiarism tests failed`);
  process.exit(1);
}
