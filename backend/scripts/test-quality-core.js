'use strict';

/**
 * Тесты для services/qualityCore (checkers + qualityGate.finalize, V1).
 *
 * Не требует Postgres/сети — все checkers чистые, а persistReport здесь
 * не вызывается. contentPolicy работает на defaults.
 *
 * Запуск: node backend/scripts/test-quality-core.js
 */

const assert = require('assert');
const { checkers, qualityGate } = require('../src/services/qualityCore');
const policy = require('../src/services/contentPolicy');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

policy._resetCache();

// ── checkFreshness ────────────────────────────────────────────────────
group('checkFreshness', () => {
  test('свежий год → pass, не blocking', () => {
    const r = checkers.checkFreshness('<p>Актуально на 2026 год</p>', { currentYear: 2026 });
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.blocking, false);
  });
  test('устаревшее «обновлено 2021» при 2026 → stale warning', () => {
    const r = checkers.checkFreshness('<p>Обновлено: 2021</p>', { currentYear: 2026 });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, false); // freshness — warning, не blocker
    assert.strictEqual(r.verdict, 'stale');
  });
});

// ── checkStopPhrases / banned ────────────────────────────────────────
group('checkStopPhrases & banned', () => {
  test('чистый текст → pass', () => {
    const r = checkers.checkStopPhrases('<p>Конкретные шаги установки окна</p>');
    assert.strictEqual(r.pass, true);
  });
  test('вода из реестра → находит фразу', () => {
    const r = checkers.checkStopPhrases('<p>В современном мире всё сложно</p>');
    assert.strictEqual(r.pass, false);
    assert.ok(r.evidence.found.length >= 1);
  });
  test('banned formulation → blocking', () => {
    const r = checkers.checkBannedFormulations('<p>Мы даём 100% гарантия результата</p>');
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
});

// ── checkLsiOverdose ─────────────────────────────────────────────────
group('checkLsiOverdose', () => {
  test('verdict=fail → blocking', () => {
    const r = checkers.checkLsiOverdose({ verdict: 'fail', sections_overdose: 3, overspam: [] });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('verdict=review → pass, не blocking', () => {
    const r = checkers.checkLsiOverdose({ verdict: 'review', sections_overdose: 1 });
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.blocking, false);
  });
  test('verdict=na → pass', () => {
    const r = checkers.checkLsiOverdose({ verdict: 'na' });
    assert.strictEqual(r.pass, true);
  });
});

// ── checkPlagiarism ──────────────────────────────────────────────────
group('checkPlagiarism', () => {
  test('ratio ниже порога → original', () => {
    const r = checkers.checkPlagiarism({ summary: { nearDuplicateRatio: 0.05 } });
    assert.strictEqual(r.pass, true);
  });
  test('ratio выше порога → blocking duplicate', () => {
    const r = checkers.checkPlagiarism({ summary: { near_duplicate_ratio: 0.4 } });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('нет данных → na, не blocking', () => {
    const r = checkers.checkPlagiarism({ summary: {} });
    assert.strictEqual(r.verdict, 'na');
    assert.strictEqual(r.blocking, false);
  });
});

// ── checkFactConfidence ──────────────────────────────────────────────
group('checkFactConfidence', () => {
  test('confidence >= 0.7 → reliable', () => {
    const r = checkers.checkFactConfidence({ confidence: 0.85 });
    assert.strictEqual(r.pass, true);
  });
  test('confidence < 0.7 → blocking unreliable', () => {
    const r = checkers.checkFactConfidence({ summary: { confidence: 0.4 } });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
});

// ── checkIntent ──────────────────────────────────────────────────────
group('checkIntent', () => {
  test('critical mismatch → blocking', () => {
    const r = checkers.checkIntent({ enabled: true, verdict: 'mismatch', mismatch: true, critical: true });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('non-critical mismatch (review) → не blocking', () => {
    const r = checkers.checkIntent({ enabled: true, verdict: 'mismatch', mismatch: true, critical: false });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, false);
  });
  test('disabled → na pass', () => {
    const r = checkers.checkIntent({ enabled: false });
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.blocking, false);
  });
});

// ── checkLinkAudit ───────────────────────────────────────────────────
group('checkLinkAudit', () => {
  test('все ссылки валидны → pass', () => {
    const r = checkers.checkLinkAudit([
      { href: '/a', inPlan: true, status: 'ok', indexable: true, canonicalMatch: true },
    ]);
    assert.strictEqual(r.pass, true);
  });
  test('битая ссылка → blocking', () => {
    const r = checkers.checkLinkAudit([{ href: '/x', inPlan: true, status: 'broken' }]);
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
    assert.deepStrictEqual(r.evidence.problems[0].issues, ['broken']);
  });
  test('каннибализация + noindex → несколько issues', () => {
    const r = checkers.checkLinkAudit([
      { href: '/y', inPlan: true, status: 'ok', indexable: false, cannibalConflict: true },
    ]);
    assert.strictEqual(r.pass, false);
    assert.ok(r.evidence.problems[0].issues.includes('noindex'));
    assert.ok(r.evidence.problems[0].issues.includes('cannibal_conflict'));
  });
});

// ── checkRisk ────────────────────────────────────────────────────────
group('checkRisk', () => {
  test('critical → blocking', () => {
    const r = checkers.checkRisk({ level: 'critical', issues: ['мед. обещание'] }, { ymyl: true });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('low → pass', () => {
    const r = checkers.checkRisk({ level: 'low' });
    assert.strictEqual(r.pass, true);
  });
});

// ── checkAuthorship ──────────────────────────────────────────────────
group('checkAuthorship', () => {
  test('YMYL без reviewer/sources → blocking', () => {
    const r = checkers.checkAuthorship({ byline: 'Иван' }, { ymyl: true });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('YMYL полный disclosure → pass', () => {
    const r = checkers.checkAuthorship({ byline: 'Иван', reviewer: 'Пётр', sources: ['a'] }, { ymyl: true });
    assert.strictEqual(r.pass, true);
  });
  test('не-YMYL только byline → pass, не blocking', () => {
    const r = checkers.checkAuthorship({ byline: 'Иван' }, { ymyl: false });
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.blocking, false);
  });
});

// ── checkValueAdds ───────────────────────────────────────────────────
group('checkValueAdds', () => {
  test('>= 3 measurable → sufficient', () => {
    const r = checkers.checkValueAdds({ value_adds: ['comparison_table', 'calculator', 'real_faq'] });
    assert.strictEqual(r.pass, true);
  });
  test('< 3 measurable → blocking insufficient', () => {
    const r = checkers.checkValueAdds({ value_adds: ['comparison_table'] });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, true);
  });
  test('неизвестные из каталога не считаются', () => {
    const r = checkers.checkValueAdds({ value_adds: ['random_thing', { type: 'checklist' }, { type: 'case_study' }, { type: 'pricing_ranges' }] });
    assert.strictEqual(r.score, 3);
    assert.strictEqual(r.pass, true);
  });
});

// ── qualityGate.finalize ─────────────────────────────────────────────
group('qualityGate.finalize', () => {
  test('чистая info-статья → canPublish', () => {
    const res = qualityGate.finalize('info', {
      html: '<p>Конкретные шаги. Актуально на 2026.</p>',
      currentYear: 2026,
      niche: 'пластиковые окна',
      plagiarismReport: { summary: { nearDuplicateRatio: 0.02 } },
      factReport: { confidence: 0.9 },
      intentReport: { enabled: true, verdict: 'match' },
      lsiOverdoseReport: { verdict: 'pass' },
      links: [{ href: '/a', inPlan: true, status: 'ok', indexable: true, canonicalMatch: true }],
      informationGainBrief: { value_adds: ['comparison_table', 'calculator', 'real_faq'] },
    });
    assert.strictEqual(res.canPublish, true, qualityGate.summarize(res));
    assert.strictEqual(res.blockers.length, 0);
  });

  test('плагиат + мало value-adds → заблокировано, несколько blockers', () => {
    const res = qualityGate.finalize('seo', {
      html: '<p>Текст</p>',
      niche: 'окна',
      plagiarismReport: { summary: { nearDuplicateRatio: 0.5 } },
      informationGainBrief: { value_adds: ['comparison_table'] },
    });
    assert.strictEqual(res.canPublish, false);
    const names = res.blockers.map((b) => b.name).sort();
    assert.ok(names.includes('plagiarism'));
    assert.ok(names.includes('value_adds'));
  });

  test('YMYL ниша без authorship → blocking authorship (авто-детект)', () => {
    const res = qualityGate.finalize('info', {
      html: '<p>Как лечить болезнь</p>',
      niche: 'лечение болезни',
    });
    assert.strictEqual(res.ymyl, true);
    assert.ok(res.blockers.some((b) => b.name === 'authorship'));
  });

  test('link-пайплайн не требует value-adds', () => {
    const res = qualityGate.finalize('link', {
      html: '<p>Гостевая статья на 2026 год</p>',
      currentYear: 2026,
      niche: 'окна',
      links: [{ href: 'https://donor.ru/a', inPlan: true, status: 'ok', indexable: true, canonicalMatch: true }],
    });
    assert.strictEqual(res.canPublish, true, qualityGate.summarize(res));
  });

  test('summarize даёт человекочитаемую причину', () => {
    const res = qualityGate.finalize('seo', {
      html: '<p>x</p>', niche: 'окна',
      plagiarismReport: { summary: { nearDuplicateRatio: 0.9 } },
      informationGainBrief: { value_adds: ['comparison_table', 'calculator', 'real_faq'] },
    });
    const s = qualityGate.summarize(res);
    assert.ok(/Заблокировано/.test(s));
    assert.ok(/plagiarism/.test(s));
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
