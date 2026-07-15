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
const _asyncResults = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // async-тест: дожидаемся в конце файла
      _asyncResults.push(
        r.then(() => { passed++; console.log(`  ✔ ${name}`); })
         .catch((e) => { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }),
      );
    } else {
      passed++; console.log(`  ✔ ${name}`);
    }
  } catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
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
// ── checkGistScore (12-й чекер, ТЗ GIST Задача B) ────────────────────
group('checkGistScore', () => {
  test('нет дельты → skip (pass, no delta)', () => {
    const r = checkers.checkGistScore('<p>Просто длинный текст статьи без дельты</p>', []);
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.verdict, 'skipped');
    assert.strictEqual(r.evidence.reason, 'no_delta_available');
  });
  test('дельта покрыта ≥30% параграфов → pass, score', () => {
    const html = '<p>Гарантия 5 лет на монтаж пластиковых окон в договоре</p>' +
                 '<li>гарантия 5 лет монтаж окон подтверждена</li>';
    const r = checkers.checkGistScore(html, ['гарантия 5 лет на монтаж окон']);
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.blocking, false);
    assert.ok(r.score >= 30);
  });
  test('дельта не раскрыта → warning (не blocking)', () => {
    const html = '<p>Первый параграф совсем про другое и длинный</p>' +
                 '<p>Второй параграф тоже не о том, о чём дельта</p>' +
                 '<p>Третий параграф про погоду и природу вокруг</p>';
    const r = checkers.checkGistScore(html, ['криотерапия жидким азотом стоимость сеанса']);
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.blocking, false); // warning, не blocker (fail-open)
    assert.strictEqual(r.evidence.level, 'red');
  });
  test('finalize: низкий gistScore попадает в warnings, canPublish не блокируется', () => {
    const res = qualityGate.finalize('info', {
      html: '<p>Длинный параграф совсем не про информационную дельту</p>',
      currentYear: 2026,
      niche: 'окна',
      informationDelta: ['криотерапия жидким азотом стоимость сеанса'],
    });
    assert.ok(res.gates.some((g) => g.name === 'gistScore'));
    assert.ok(res.warnings.some((w) => w.name === 'gistScore'));
    assert.ok(!res.blockers.some((b) => b.name === 'gistScore'));
  });
});

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

// ── collectArtifacts (Фаза 3 адаптер) ────────────────────────────────
const { collectArtifacts, riskFromEvaluator } = require('../src/services/qualityCore');
group('collectArtifacts', () => {
  test('plagiarism percent (overlapPctTotal) → ratio /100', () => {
    const a = collectArtifacts('info', {
      plagiarismReport: { summary: { overlapPctTotal: 40 } },
    });
    assert.strictEqual(a.plagiarismReport.summary.nearDuplicateRatio, 0.4);
  });
  test('fact-check supportedPct → confidence /100', () => {
    const a = collectArtifacts('info', {
      factReport: { summary: { supportedPct: 85 } },
    });
    assert.strictEqual(a.factReport.confidence, 0.85);
  });
  test('evaluatorReport → riskReport level = max severity', () => {
    const a = collectArtifacts('seo', {
      evaluatorReport: { regulatory_risks: [
        { risk: 'r1', severity: 'low' },
        { risk: 'r2', severity: 'high' },
      ] },
    });
    assert.strictEqual(a.riskReport.level, 'high');
    assert.deepStrictEqual(a.riskReport.issues, ['r1', 'r2']);
  });
  test('explicit riskReport приоритетнее evaluatorReport', () => {
    const a = collectArtifacts('seo', {
      riskReport: { level: 'critical', issues: ['x'] },
      evaluatorReport: { regulatory_risks: [{ risk: 'y', severity: 'low' }] },
    });
    assert.strictEqual(a.riskReport.level, 'critical');
  });
  test('пустые regulatory_risks → level none', () => {
    assert.strictEqual(riskFromEvaluator({ regulatory_risks: [] }).level, 'none');
  });
  test('отсутствующие отчёты не попадают в artifacts (нет ложных checker-ов)', () => {
    const a = collectArtifacts('link', { html: '<p>hi</p>', niche: 'окна' });
    assert.strictEqual(a.plagiarismReport, undefined);
    assert.strictEqual(a.factReport, undefined);
    assert.strictEqual(a.riskReport, undefined);
    assert.strictEqual(a.html, '<p>hi</p>');
  });
});

// ── qualityGate.runForTask (finalize + persist, graceful) ────────────
group('qualityGate.runForTask', () => {
  test('info: чистые сырые отчёты → canPublish + persist по строке на checker', async () => {
    const saved = [];
    const mockDb = { query: async (_sql, params) => { saved.push(params); return { rowCount: 1 }; } };
    const res = await qualityGate.runForTask({
      pipeline: 'info',
      taskId: 123,
      db: mockDb,
      raw: {
        html: '<p>Конкретные шаги. Актуально на 2026.</p>',
        currentYear: 2026,
        niche: 'пластиковые окна',
        plagiarismReport: { summary: { overlapPctTotal: 2 } },   // 2% → 0.02 ratio
        factReport: { summary: { supportedPct: 90 } },           // 90% → 0.9 conf
        intentReport: { enabled: true, verdict: 'match' },
        lsiOverdoseReport: { verdict: 'pass' },
      },
    });
    assert.strictEqual(res.canPublish, true, res.summary);
    assert.ok(res.gates.length >= 1);
    assert.ok(saved.length >= 1, 'persistReport должен записать журнал');
  });

  test('seo: высокий плагиат (percent) → blocking через нормализацию', async () => {
    const res = await qualityGate.runForTask({
      pipeline: 'seo',
      taskId: 5,
      persist: false,
      raw: {
        html: '<p>Текст</p>', niche: 'окна',
        plagiarismReport: { summary: { overlapPctTotal: 50 } }, // 50% → 0.5 > 0.15
      },
    });
    assert.strictEqual(res.canPublish, false);
    assert.ok(res.blockers.some((b) => b.name === 'plagiarism'));
  });

  test('никогда не бросает — при кривом db возвращает safe verdict', async () => {
    const badDb = { query: async () => { throw new Error('db down'); } };
    // finalize пройдёт, persistReport проглотит ошибку внутри → canPublish по контенту
    const res = await qualityGate.runForTask({
      pipeline: 'link', taskId: 1, db: badDb,
      raw: { html: '<p>Гостевая статья 2026</p>', currentYear: 2026, niche: 'окна' },
    });
    assert.ok(res && typeof res.canPublish === 'boolean');
  });

  test('seo из evaluatorReport: risk не блокирует ниже critical', async () => {
    const res = await qualityGate.runForTask({
      pipeline: 'seo', taskId: 9, persist: false,
      raw: {
        html: '<p>Статья 2026</p>', currentYear: 2026, niche: 'окна',
        evaluatorReport: { regulatory_risks: [{ risk: 'спорное утверждение', severity: 'high' }] },
      },
    });
    // high (3) < critical (4) → risk gate pass, canPublish
    assert.strictEqual(res.canPublish, true, res.summary);
  });
});

Promise.all(_asyncResults).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});