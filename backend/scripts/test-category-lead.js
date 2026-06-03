'use strict';

/**
 * Smoke-tests для инструмента «Lead-text + Фасетный SEO-оптимизатор»
 * (categoryLead). Без сетевых вызовов и без LLM — проверяем чистые функции:
 *  • парсинг фильтров (ручной ввод + HTML),
 *  • кластеризацию интентов по показам,
 *  • нормализацию ответов Прохода 1/2,
 *  • мост к мета-тегам (виртуальные ключи).
 *
 * Запуск: `node backend/scripts/test-category-lead.js`
 */

const assert = require('assert');

const {
  parseManualFilters, extractFiltersFromHtml, renderFiltersForPrompt,
} = require('../src/services/categoryLead/filterParser');
const {
  clusterIntents, normalizeQueryRows, renderIntentsForPrompt,
} = require('../src/services/categoryLead/intentClustering');
const { normalizeLeadResult } = require('../src/services/categoryLead/leadGenerator');
const { normalizeFacetResult } = require('../src/services/categoryLead/facetOptimizer');
const { buildVirtualKeys, buildMetaBridge } = require('../src/services/categoryLead/metaBridge');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

console.log('\n=== filterParser: manual ===');
{
  const g = parseManualFilters('Бренд: Samsung, LG; Цвет: красный, синий');
  ok('two groups parsed', g.length === 2, JSON.stringify(g));
  ok('brand group name', g[0].group === 'Бренд');
  ok('brand values', g[0].values.join(',') === 'Samsung,LG');
  ok('color values', g[1].values.join(',') === 'красный,синий');

  const dedup = parseManualFilters('Бренд: Samsung, samsung, LG');
  ok('values deduped case-insensitive', dedup[0].values.length === 2, JSON.stringify(dedup));

  const merged = parseManualFilters('Бренд: Samsung\nБренд: LG');
  ok('same group merged', merged.length === 1 && merged[0].values.length === 2, JSON.stringify(merged));

  ok('empty input → []', parseManualFilters('').length === 0);
  ok('render contains group', renderFiltersForPrompt(g).includes('Бренд: Samsung, LG'));
  ok('render empty placeholder', renderFiltersForPrompt([]).includes('не заданы'));
}

console.log('\n=== filterParser: HTML ===');
{
  const html = `
    <aside class="catalog-filters">
      <div class="filter-group">
        <h3 class="title">Бренд</h3>
        <label><input type="checkbox" value="Samsung"> Samsung</label>
        <label><input type="checkbox" value="LG"> LG</label>
      </div>
    </aside>`;
  const g = extractFiltersFromHtml(html);
  ok('html: group found', g.length >= 1, JSON.stringify(g));
  ok('html: values found', g[0] && g[0].values.length >= 2, JSON.stringify(g));
  ok('html: empty string → []', extractFiltersFromHtml('').length === 0);
  ok('html: non-string → []', extractFiltersFromHtml(null).length === 0);
}

console.log('\n=== intentClustering ===');
{
  const rows = [
    { query: 'купить электросамокат', impressions: 1000, clicks: 50 },
    { query: 'электросамокат для брусчатки', impressions: 800, clicks: 10 },
    { query: 'какой запас хода у самоката', impressions: 1200, clicks: 5 },
    { query: 'заказать самокат недорого', impressions: 300, clicks: 20 },
  ];
  const res = clusterIntents(rows);
  ok('clusters produced', res.clusters.length >= 1, JSON.stringify(res.clusters.map((c) => c.intent)));
  ok('total_queries counted', res.total_queries === 4);
  // Сортировка по показам: верхний кластер должен иметь максимум показов.
  const maxImpr = Math.max(...res.clusters.map((c) => c.total_impressions));
  ok('top cluster has max impressions', res.clusters[0].total_impressions === maxImpr);

  ok('normalizeQueryRows strings', normalizeQueryRows(['a', 'b']).length === 2);
  ok('normalizeQueryRows drops empty', normalizeQueryRows(['', '  ', 'x']).length === 1);

  const txt = renderIntentsForPrompt(res, ['какой самокат для 100+ кг?']);
  ok('render includes manual question', txt.includes('100+ кг'));
}

console.log('\n=== normalizeLeadResult ===');
{
  const r = normalizeLeadResult({
    paragraphs: ['абзац 1', 'абзац 2', 'абзац 3'],
    anchor_suggestions: [{ anchor: 'пневмоколёса', target_hint: '/pnevmo' }, { anchor: '' }],
    category_meta_draft: { title: 'T', description: 'D', h1: 'H' },
    used_filter_entities: ['Samsung', ''],
  });
  ok('paragraphs kept', r.paragraphs.length === 3);
  ok('lead_text_html synthesized', r.lead_text_html.includes('<p>абзац 1</p>'));
  ok('anchors filtered', r.anchor_suggestions.length === 1);
  ok('meta draft present', r.category_meta_draft.title === 'T');
  ok('entities filtered', r.used_filter_entities.length === 1);

  const empty = normalizeLeadResult(null);
  ok('null-safe', Array.isArray(empty.paragraphs) && empty.paragraphs.length === 0);
}

console.log('\n=== normalizeFacetResult ===');
{
  const r = normalizeFacetResult({
    rows: [
      { current: 'Тип: Для игр', seo_name: 'Назначение: Игровые', action: 'rename', index_priority: 'high' },
      { current: 'Гарантия', seo_name: '', action: 'New', index_priority: 'x' },
      { current: 'Мусор', seo_name: 'Мусор', action: 'delete', index_priority: 'low' },
    ],
    top_recommendations: ['r1', 'r2'],
    noindex_list: ['junk1'],
  });
  ok('empty row dropped', r.rows.length === 3, JSON.stringify(r.rows));
  ok('action normalized', r.rows[0].action === 'Rename');
  ok('priority normalized High', r.rows[0].index_priority === 'High');
  ok('unknown priority → Med', r.rows[1].index_priority === 'Med');
  ok('recommendations kept', r.top_recommendations.length === 2);
  ok('noindex kept', r.noindex_list.length === 1);
}

console.log('\n=== metaBridge ===');
{
  const facet = normalizeFacetResult({
    rows: [
      { current: 'Назначение: Игровые', seo_name: 'Назначение: Игровые ноутбуки', action: 'Rename', index_priority: 'High' },
      { current: 'ОЗУ: 16', seo_name: 'Оперативная память: 16 ГБ', action: 'Rename', index_priority: 'High' },
      { current: 'Цвет: розовый', seo_name: 'Цвет: розовый', action: 'Delete', index_priority: 'High' },
      { current: 'Прочее', seo_name: 'Прочее', action: 'Rename', index_priority: 'Low' },
    ],
  });
  const keys = buildVirtualKeys('Ноутбуки', facet.rows);
  ok('only High & non-Delete → keys', keys.length === 2, JSON.stringify(keys));
  ok('key built with category prefix', keys[0].startsWith('Ноутбуки '), keys[0]);
  ok('key takes value after colon', keys.includes('Ноутбуки Игровые ноутбуки'), JSON.stringify(keys));
  ok('Delete excluded', !keys.some((k) => k.includes('розовый')));
  ok('Low excluded', !keys.some((k) => k.includes('Прочее')));

  const bridge = buildMetaBridge({
    category: 'Ноутбуки',
    leadResult: { category_meta_draft: { title: 'T', description: 'D', h1: 'H' } },
    facetResult: { ...facet, noindex_list: ['Цвет: розовый'] },
  });
  ok('bridge keeps meta draft', bridge.category_meta_draft.title === 'T');
  ok('bridge virtual keys', bridge.virtual_keys.length === 2);
  ok('bridge noindex', bridge.noindex_recommendations.length === 1);
}

// ─── leadContext: префилл формы из последнего успешного project_analyses ──
console.log('\n=== leadContext: build from analysis ===');
{
  const { buildLeadContextFromAnalysis } = require('../src/services/projects/leadContext');
  const project = { id: 7, name: 'Acme Shop', url: 'https://acme.example/', gsc_site_url: 'sc-domain:acme.example' };
  const analysis = {
    id: 'a-1',
    completed_at: new Date('2026-05-10T10:00:00Z'),
    gsc_snapshot: {
      top_queries: [
        { key: 'купить кроссовки', impressions: 5000, clicks: 100 },
        { key: 'кроссовки adidas', impressions: 3000, clicks: 60 },
        { key: 'кроссовки nike', impressions: 2000, clicks: 40 },
      ],
      commercial: {
        striking_distance: [
          { query: 'купить кроссовки nike', position: 12, impressions: 800 },
          { query: 'кроссовки распродажа',  position: 14, impressions: 600 },
        ],
        intent_distribution: [
          { intent: 'commercial', clicksPct: 60 },
          { intent: 'informational', clicksPct: 25 },
        ],
        brand_tokens: ['acme', 'acme.example'],
      },
      brand_split: { brand_tokens: ['Acme', 'acme.example'] },
    },
  };

  const ctx = buildLeadContextFromAnalysis({ project, analysis });
  ok('source_analysis_id propagated', ctx.source_analysis_id === 'a-1');
  ok('source_completed_at present', !!ctx.source_analysis_completed_at);
  ok('suggested_core has top queries', Array.isArray(ctx.suggested_core) && ctx.suggested_core.length >= 3);
  ok('suggested_questions includes striking', Array.isArray(ctx.suggested_questions)
     && ctx.suggested_questions.some((q) => /кроссовки/.test(q)));
  ok('brand_tokens deduped+lowercased', Array.isArray(ctx.brand_tokens)
     && new Set(ctx.brand_tokens.map((b) => b.toLowerCase())).size === ctx.brand_tokens.length);
  ok('intent_distribution forwarded', Array.isArray(ctx.intent_distribution)
     && ctx.intent_distribution.length === 2);

  // Edge: пустой snapshot — не падаем, suggestions пусты, но brand_tokens из проекта.
  const empty = buildLeadContextFromAnalysis({ project, analysis: { id: 'a-2', completed_at: null, gsc_snapshot: {} } });
  ok('empty snapshot → empty core', Array.isArray(empty.suggested_core) && empty.suggested_core.length === 0);
  ok('empty snapshot → analysis id kept', empty.source_analysis_id === 'a-2');

  // Edge: analysis отсутствует — все suggestions пусты.
  const none = buildLeadContextFromAnalysis({ project, analysis: null });
  ok('no analysis → null id', none.source_analysis_id === null);
  ok('no analysis → empty questions', Array.isArray(none.suggested_questions) && none.suggested_questions.length === 0);
}

// ─── projects/aegisBridge: pages mapping + reward ──
console.log('\n=== projects/aegisBridge: snapshot → pages ===');
{
  const { mapSnapshotToPages, computeProjectReward, _siteKeyForProject } = require('../src/services/projects/aegisBridge');
  const project = { id: 9, name: 'Shop', url: 'https://shop.example/', gsc_site_url: 'sc-domain:shop.example' };
  const snapshot = {
    top_pages: [
      { key: 'https://shop.example/cat/a', clicks: 50, impressions: 1000, position: 4.2, ctr: 0.05 },
      { key: 'https://shop.example/cat/b', clicks: 20, impressions: 500,  position: 8.1, ctr: 0.04 },
    ],
    commercial: {
      cannibalization: [
        { query: 'купить штуку', pages: ['https://shop.example/cat/a', 'https://shop.example/cat/c'], impressions: 200 },
      ],
    },
    page_decay: {
      declining_pages: [
        { page: 'https://shop.example/cat/d', last_position: 15, last_clicks: 1, last_impressions: 100 },
      ],
    },
    period_compare: { available: true, totals: { clicks_pct: 30 } },
  };
  const pages = mapSnapshotToPages(snapshot, project);
  ok('pages collected', pages.length === 4); // a, b, c (cannib new), d (decay)
  ok('pages dedup by url', new Set(pages.map((p) => p.url)).size === pages.length);
  const a = pages.find((p) => p.url.endsWith('/cat/a'));
  ok('top page keeps clicks', a && a.clicks === 50);
  const c = pages.find((p) => p.url.endsWith('/cat/c'));
  ok('cannib-only page → ambiguous', c && c.intent === 'ambiguous');
  const d = pages.find((p) => p.url.endsWith('/cat/d'));
  ok('decay page → declining cluster', d && d.cluster === 'declining');

  ok('reward in [-1,1]', computeProjectReward(snapshot) === 0.3);
  ok('reward null when no period_compare', computeProjectReward({}) === null);
  ok('reward clamped on huge growth',
     computeProjectReward({ period_compare: { totals: { clicks_pct: 999 } } }) === 1);

  ok('site_key uses gsc sc-domain', _siteKeyForProject(project) === 'gsc:shop.example');
  ok('site_key falls back to url host',
     _siteKeyForProject({ url: 'https://other.example/x' }) === 'gsc:other.example');
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
