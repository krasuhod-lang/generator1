'use strict';

/**
 * test-meta-facade — E2E-проверка единой точки входа генерации мета-тегов
 * (metaTags/metaFacade) с замоканными SERP и LLM.
 *
 * Проверяется каскад деградации (§1 ТЗ):
 *   1) SERP доступен  → gist_serp
 *   2) SERP упал      → gist (без выдачи)
 *   3) GIST упал      → legacy seoMeta.service
 *   4) всё упало      → детерминированный fallback (source=legacy_deterministic*)
 * + kill-switch META_FACADE_ENABLED и сборка summary из HTML.
 *
 * Запуск: node backend/scripts/test-meta-facade.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const META_DIR = path.join(__dirname, '..', 'src', 'services', 'metaTags');
const resolve = (f) => require.resolve(path.join(META_DIR, f));

// ── Моки модулей (подменяем в require.cache до загрузки фасада) ────
const state = {
  serpFails: false,
  gistFails: false,
  legacyFails: false,
  serpCalls: 0,
  gistCalls: 0,
  linkCalls: 0,
  forceCostUsd: null,
  legacyCalls: 0,
};

const DEMO_META = {
  title: 'Монтаж вентиляции в Москве за 3 дня — гарантия 5 лет по договору',
  description: 'Монтаж вентиляции под ключ за 3 дня с гарантией 5 лет, проект от '
    + 'инженера с допуском СРО и фиксированной ценой от 45 000 ₽ без доплат. '
    + 'Закажите бесплатный расчёт.',
  h1: 'Монтаж вентиляции под ключ',
  description_mobile: 'Монтаж вентиляции за 3 дня, гарантия 5 лет. Закажите расчёт.',
  winner_fact: 'монтаж за 3 дня с гарантией 5 лет',
  post_validation_notes: [],
  // Движки GIST возвращают только токены — стоимость считает сам фасад.
  _meta: { tokensIn: 1200, tokensOut: 400, model: 'mock-model', provider: 'gemini' },
};

function mock(file, exports) {
  const id = resolve(file);
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  require.cache[id] = m;
}

mock('metaStages.js', {
  runMetaStagesForKeyword: async ({ inputs }) => {
    state.serpCalls += 1;
    if (state.serpFails) throw new Error('mock: SERP недоступен');
    return {
      serp: [{ title: 'Конкурент', snippet: 'Описание' }],
      semantics: {},
      metas: {
        ...DEMO_META,
        ctr_score: { score: 82, needs_review: false, threshold: 60 },
        context_used: {
          page_angle: inputs.pageAngle || '',
          missing_nodes: inputs.missingNodes || [],
          standalone_exposure: inputs.standalone_exposure === true,
        },
      },
    };
  },
  buildAudienceNicheDigest: async () => '',
});

mock('metaGenerator.js', {
  generateDrMaxMeta: async () => {
    state.gistCalls += 1;
    if (state.gistFails) throw new Error('mock: GIST недоступен');
    return state.forceCostUsd
      ? { ...DEMO_META, _meta: { ...DEMO_META._meta, costUsd: state.forceCostUsd } }
      : { ...DEMO_META };
  },
});

// Движок ссылочных статей: фасад обязан звать именно его для pipeline='link'.
mock('gistMetaFilter.js', {
  generateLinkArticleMeta: async () => {
    state.linkCalls += 1;
    if (state.gistFails) throw new Error('mock: GIST недоступен');
    return { ...DEMO_META, standalone_exposure: true, winner_source: 'fallback_structural' };
  },
});

// Заглушка legacy-движка (infoArticle/seoMeta.service).
{
  const legacyId = require.resolve(
    path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'seoMeta.service.js'),
  );
  const m = new Module(legacyId, null);
  m.filename = legacyId;
  m.loaded = true;
  m.exports = {
    generateSeoMeta: async ({ topic }) => {
      state.legacyCalls += 1;
      if (state.legacyFails) throw new Error('mock: legacy движок недоступен');
      return {
        title: `${topic} — услуги под ключ с гарантией и выездом мастера сегодня`,
        description: `${topic}: подробное описание услуги, сроки, гарантии и `
          + 'условия работы по договору с фиксированной стоимостью без доплат.',
        source: 'deterministic',
      };
    },
  };
  require.cache[legacyId] = m;
}

const { calcCost } = require(path.join(__dirname, '..', 'src', 'services', 'metrics', 'priceCalculator'));
const { generateMetaForContent, buildSummaryFromContent, extractH1 } = require(resolve('metaFacade.js'));

const HTML = '<h1>Монтаж вентиляции под ключ</h1>'
  + '<p>Проектируем и монтируем приточно-вытяжные системы за 3 дня с гарантией 5 лет.</p>';
const PLAIN = 'Монтаж вентиляции под ключ\n\nПроектируем и монтируем приточно-вытяжные системы.';

const BASE = {
  keyword: 'монтаж вентиляции',
  html: HTML,
  plain: PLAIN,
  context: {
    brand: 'ВентПро',
    toponym: 'Москва',
    brandFacts: 'Собственная монтажная бригада, 12 лет на рынке',
    pageAngle: 'Страница закрывает коммерческий интент',
    missingNodes: ['Пробел ТОПа: нет точной цены'],
  },
};

(async () => {
  console.log('metaFacade — summary и H1:');
  {
    check('extractH1 достаёт заголовок', extractH1(HTML) === 'Монтаж вентиляции под ключ');
    const summary = buildSummaryFromContent({
      html: HTML, plain: PLAIN, brandFacts: 'Факты бренда',
    });
    check('summary содержит H1 и лид', summary.includes('H1:') && summary.includes('Лид:'));
    check('summary содержит факты бренда', summary.includes('Факты бренда'));
    check('summary не длиннее 1500 символов', summary.length <= 1500);
  }

  console.log('\nmetaFacade — каскад деградации:');

  // 1) SERP доступен.
  {
    state.serpFails = false; state.gistFails = false;
    const tokens = [];
    const res = await generateMetaForContent({
      ...BASE,
      pipeline: 'seo',
      ctx: { onTokens: (provider, i, o, c) => tokens.push([provider, i, o, c]) },
    });
    check('ветка 1: source=gist_serp', res.source === 'gist_serp');
    check('ветка 1: единый контракт заполнен',
      !!res.title && !!res.description && res.h1 === DEMO_META.h1
      && res.gist_fact === DEMO_META.winner_fact);
    check('ветка 1: usage прокинут в ctx.onTokens (provider, in, out, cost)',
      tokens.length === 1 && tokens[0][0] === 'gemini'
      && tokens[0][1] === 1200 && tokens[0][2] === 400
      && Math.abs(tokens[0][3] - calcCost('gemini', 1200, 400)) < 1e-12
      && tokens[0][3] > 0);
    check('ветка 1: контекст (pageAngle/missingNodes) дошёл до движка',
      res.context_used && res.context_used.missing_nodes.length === 1);
  }

  // 2) SERP упал → GIST без выдачи.
  {
    state.serpFails = true; state.gistFails = false;
    const before = state.gistCalls;
    const res = await generateMetaForContent({ ...BASE, pipeline: 'info' });
    check('ветка 2: source=gist', res.source === 'gist');
    check('ветка 2: GIST вызван', state.gistCalls === before + 1);
    check('ветка 2: CTR-скор посчитан', res.ctr_score && typeof res.ctr_score.score === 'number');
  }

  // 2b) Ссылочная статья: свой движок без выдачи + реальная стоимость.
  {
    state.serpFails = false; state.gistFails = false;
    const beforeLink = state.linkCalls;
    const beforeSerp = state.serpCalls;
    const tokens = [];
    const res = await generateMetaForContent({
      ...BASE,
      pipeline: 'link',
      context: { ...BASE.context, useSerp: false, anchorText: 'купить вентиляцию' },
      ctx: { onTokens: (provider, i, o, c) => tokens.push([provider, i, o, c]) },
    });
    check('link: SERP не запрашивается', state.serpCalls === beforeSerp);
    check('link: вызван generateLinkArticleMeta', state.linkCalls === beforeLink + 1);
    check('link: source=gist_link', res.source === 'gist_link');
    check('link: standalone_exposure проброшен в контракт',
      res.context_used && res.context_used.standalone_exposure === true);
    check('link: winner_source сохранён как gist_fact_source',
      res.gist_fact_source === 'fallback_structural');
    check('link: CTR-скор посчитан', res.ctr_score && typeof res.ctr_score.score === 'number');
    check('link: usage прокинут', tokens.length === 1 && tokens[0][0] === 'gemini');
  }

  // 2c) Если движок вернул costUsd — фасад его уважает и не пересчитывает.
  {
    state.serpFails = true; state.gistFails = false;
    state.forceCostUsd = 0.0021;
    const tokens = [];
    await generateMetaForContent({
      ...BASE,
      pipeline: 'info',
      ctx: { onTokens: (provider, i, o, c) => tokens.push([provider, i, o, c]) },
    });
    check('явный costUsd движка не пересчитывается', tokens.length === 1 && tokens[0][3] === 0.0021);
    state.forceCostUsd = null;
  }

  // 3) GIST упал → legacy seoMeta.service.
  {
    state.serpFails = true; state.gistFails = true; state.legacyFails = false;
    const before = state.legacyCalls;
    const res = await generateMetaForContent({ ...BASE, pipeline: 'link' });
    check('ветка 3: source начинается с legacy_', res.source.startsWith('legacy_'));
    check('ветка 3: legacy-движок вызван', state.legacyCalls === before + 1);
    check('ветка 3: title/description непустые', !!res.title && !!res.description);
  }

  // 4) всё упало → безопасный контракт без исключения.
  {
    state.legacyFails = true;
    const res = await generateMetaForContent({ ...BASE, pipeline: 'meta_tool' });
    check('ветка 4: source=failed', res.source === 'failed');
    check('ветка 4: исключение не выброшено, контракт цел',
      res.title === '' && Array.isArray(res.notes) && res.manual_review_required === true);
    state.legacyFails = false;
  }

  // 5) Kill-switch.
  {
    state.serpFails = false; state.gistFails = false;
    process.env.META_FACADE_ENABLED = 'false';
    const before = state.serpCalls;
    const res = await generateMetaForContent({ ...BASE, pipeline: 'seo' });
    check('kill-switch: GIST не вызывается', state.serpCalls === before);
    check('kill-switch: используется legacy-движок', res.source.startsWith('legacy_'));
    delete process.env.META_FACADE_ENABLED;
  }

  // 6) META_FACADE_SERP_ENABLED=false — сразу GIST без выдачи.
  {
    process.env.META_FACADE_SERP_ENABLED = 'false';
    const beforeSerp = state.serpCalls;
    const res = await generateMetaForContent({ ...BASE, pipeline: 'seo' });
    check('SERP kill-switch: поход в выдачу пропущен', state.serpCalls === beforeSerp);
    check('SERP kill-switch: source=gist', res.source === 'gist');
    delete process.env.META_FACADE_SERP_ENABLED;
  }

  console.log(`\n✅ Все проверки пройдены: ${passed}`);
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
