/**
 * competitorSignalsRequirements.js — превращает агрегированный
 * `top_aggregate` (Wave 1 SEO-сигналы из утечек Google/Yandex,
 * см. relevance/app/signals.py) в плоский набор «требований к контенту»,
 * пригодный для подмешивания в writer-стадии.
 *
 * Этот модуль — единственная точка интеграции для будущих потребителей:
 *   • backend/src/utils/articleKnowledgeBase.js — добавит новый раздел AKB
 *     «Конкурентные требования топа» (writer/audit видят чеклист);
 *   • backend/src/utils/moduleContext.js — обогатит mandatory_entities /
 *     добавит mandatory_questions / mandatory_schemas / format_wedge;
 *   • backend/src/services/metaTags — title-генератор использует
 *     `title_template.title_chars_median` и список модификаторов;
 *   • backend/src/services/infoArticle/semanticLinkPlanner.js —
 *     `anchor_bank.top_anchors` как кандидаты анкоров перелинковки;
 *   • frontend/src/views/AcfJsonPage.vue — `mandatory_schemas` → авто-выбор
 *     ACF-блоков (FAQPage→faq, HowTo→steps, Product→price).
 *
 * Сейчас helper НЕ привязан ни к одному из этих модулей — он лишь
 * выставляет стабильный API, чтобы переключение можно было сделать
 * единичным PR без правки signals.py заново.
 *
 * Все методы pure / synchronous / без LLM-вызовов.
 */

'use strict';

// Пороги отставания «наш сайт vs медиана топа». Дублируются в
// frontend/src/views/RelevanceResultPage.vue (computed ourVsTopGaps) —
// держать значения в синхронизации.
const GAP_UNDER_THRESHOLD = 0.7;   // o < t * 0.7  → 'under'
const GAP_OVER_THRESHOLD  = 1.5;   // o > t * 1.5  → 'over' (для higher-is-better)
const GAP_OVER_THRESHOLD_INVERSE = 1.3; // для higher-is-worse (длина абзаца)

// Минимальная плотность trust-ссылок на 1000 слов, ниже которой helper
// не считает trust-сигнал «обязательным» — иначе чеклист пухнет на нишах,
// где trust-ссылки в принципе никто не ставит.
const MIN_TRUST_LINKS_PER_1K_WORDS = 0.3;

/**
 * Преобразует `analysisResp.competitor_signals` (или `report.competitor_signals`)
 * в человеко-читаемый чеклист требований.
 *
 * @param {object|null} signalsBlock — { per_url, top_aggregate, algorithm_signals, doc_count }
 * @returns {{
 *   ready: boolean,
 *   doc_count: number,
 *   requirements: object,
 *   checklist: Array<{ id: string, label: string, importance: 'must'|'should'|'nice', source: string }>,
 * }}
 */
function buildCompetitorSignalsRequirements(signalsBlock) {
  if (!signalsBlock || typeof signalsBlock !== 'object') {
    return { ready: false, doc_count: 0, requirements: {}, checklist: [] };
  }
  const top = signalsBlock.top_aggregate || {};
  const alg = signalsBlock.algorithm_signals || {};
  const n   = Number(signalsBlock.doc_count) || 0;
  if (n === 0 || !top || Object.keys(top).length === 0) {
    return { ready: false, doc_count: n, requirements: {}, checklist: [] };
  }

  const titleTpl  = top.title_template || {};
  const schemaP   = top.schema_profile || {};
  const fresh     = top.freshness_profile || {};
  const ux        = top.ux_profile || {};
  const slug      = top.slug_pattern || {};
  const trust     = top.trust_link_quota || {};
  const anchors   = top.anchor_bank || {};
  const exact     = top.exact_query_position_targets || {};
  const hygiene   = top.host_hygiene_checklist || {};

  const requirements = {
    title: {
      length_chars: {
        median: titleTpl.title_chars_median || 0,
        min:    titleTpl.title_chars_min    || 0,
        max:    titleTpl.title_chars_max    || 0,
      },
      pixels_median:        titleTpl.title_pixels_median_est || 0,
      include_year:         (titleTpl.title_has_year_share_pct || 0) >= 50,
      include_number:       (titleTpl.title_has_number_share_pct || 0) >= 50,
      include_parens:       (titleTpl.title_has_parens_share_pct || 0) >= 50,
      include_query_exact:  (titleTpl.exact_query_in_title_share_pct || 0) >= 50,
      title_h1_should_match: (titleTpl.title_h1_match_share_pct || 0) >= 50,
      recommended_modifiers: Array.isArray(titleTpl.modifiers_top)
        ? titleTpl.modifiers_top.filter((m) => Number(m?.share_pct || 0) >= 30).map((m) => m.modifier)
        : [],
      h1_chars_median:      titleTpl.h1_chars_median || 0,
    },
    schemas: {
      mandatory:           Array.isArray(schemaP.mandatory) ? schemaP.mandatory : [],
      all_seen:            Array.isArray(schemaP.types) ? schemaP.types : [],
      pressure:            schemaP.pressure || 0,
    },
    freshness: {
      median_age_modified_days: fresh.median_age_modified_days,
      pressure_pct:             fresh.freshness_pressure || 0,
      include_update_date:      (fresh.share_fresh_180_pct || 0) >= 50,
      mention_current_year:     (fresh.share_fresh_365_pct || 0) >= 50,
      current_year:             fresh.current_year,
    },
    structure: {
      h2_count_median:              ux.h2_count_median,
      h3_count_median:              ux.h3_count_median,
      headings_per_1k_words_median: ux.headings_per_1k_words_median,
      avg_paragraph_chars_median:   ux.avg_paragraph_chars_median,
      above_the_fold_chars_median:  ux.above_the_fold_chars_median,
      should_have_toc:              (ux.share_with_toc_pct || 0) >= 50,
      should_have_faq_early:        (ux.share_with_faq_early_pct || 0) >= 50,
      should_have_tldr:             (ux.share_with_tldr_early_pct || 0) >= 50,
      should_have_first_img_alt:    (ux.share_with_first_img_alt_pct || 0) >= 50,
    },
    slug: {
      length_median:           slug.slug_chars_median,
      depth_median:            slug.depth_slashes_median,
      use_cyrillic:            (slug.share_cyrillic_url_pct || 0) >= 60,
      include_year:            (slug.share_year_in_url_pct || 0) >= 50,
      include_query_token:     (slug.share_slug_has_query_pct || 0) >= 50,
      recommendation_text:     slug.recommendation || '',
    },
    trust: {
      links_median:                 trust.trust_links_median,
      external_links_median:        trust.external_links_median,
      target_per_1000_words:        trust.per_1000_words_target,
      share_topic_with_trust_pct:   trust.share_with_any_trust_pct,
    },
    anchors: {
      top_candidates:       Array.isArray(anchors.top_anchors)
        ? anchors.top_anchors.slice(0, 50)
        : [],
      class_shares_pct:     anchors.class_shares_pct || {},
    },
    exact_query: {
      density_per_1000_words_target: exact.density_target,
      first_100_words_median:        exact.first_100_words_median,
      first_paragraph_median:        exact.first_paragraph_median,
      h2_median:                     exact.in_h2_median,
      h3_median:                     exact.in_h3_median,
      alt_median:                    exact.in_alt_median,
    },
    host_hygiene: {
      must_have:    Array.isArray(hygiene.must_have) ? hygiene.must_have : [],
      shares_pct:   hygiene.shares_pct || {},
      score_target: hygiene.score_target || 0,
    },
    algorithm_signals: {
      google: alg.google || {},
      yandex: alg.yandex || {},
    },
  };

  const checklist = _buildChecklist(requirements);
  return { ready: true, doc_count: n, requirements, checklist };
}

/**
 * Сравнивает сигналы НАШЕГО документа со средним по топу.
 * Возвращает список отставаний, готовых к показу пользователю /
 * подаче в audit-стадию (Stage 5/8).
 *
 * @param {object|null} ourSignals — `report.our_report.competitor_signals`
 * @param {object|null} signalsBlock — `report.competitor_signals` (top_aggregate)
 * @returns {Array<{ key: string, label: string, our: number|string, top_median: number|string, gap: string }>}
 */
function compareOurDocumentToTop(ourSignals, signalsBlock) {
  const out = [];
  if (!ourSignals || ourSignals.empty_reason) return out;
  if (!signalsBlock || !signalsBlock.top_aggregate) return out;
  const top = signalsBlock.top_aggregate;

  const cmp = (key, label, ourVal, topVal, higherIsBetter = true) => {
    if (topVal === null || topVal === undefined) return;
    const o = Number(ourVal) || 0;
    const t = Number(topVal) || 0;
    let gap = 'ok';
    if (higherIsBetter && o < t * GAP_UNDER_THRESHOLD) gap = 'under';
    if (higherIsBetter && o > t * GAP_OVER_THRESHOLD) gap = 'over';
    if (!higherIsBetter && o > t * GAP_OVER_THRESHOLD_INVERSE) gap = 'over';
    out.push({ key, label, our: o, top_median: t, gap });
  };

  const ux  = top.ux_profile || {};
  const exact = top.exact_query_position_targets || {};
  const our_ux = ourSignals.ux_profile || {};
  const our_eo = ourSignals.exact_occurrences || {};
  const our_tl = ourSignals.trust_links || {};
  const trust = top.trust_link_quota || {};

  cmp('h2_count', 'H2-разделов', our_ux.h2_count, ux.h2_count_median);
  cmp('headings_per_1k', 'Заголовков на 1000 слов', our_ux.headings_per_1k_words, ux.headings_per_1k_words_median);
  cmp('above_the_fold_chars', 'Символов до первого H2', our_ux.above_the_fold_chars, ux.above_the_fold_chars_median);
  cmp('avg_paragraph_chars', 'Средняя длина абзаца', our_ux.avg_paragraph_chars, ux.avg_paragraph_chars_median, false);
  cmp('exact_first_100', 'Точных вхождений в первых 100 словах', our_eo.first_100_words, exact.first_100_words_median);
  cmp('exact_in_h2', 'Точных вхождений в H2', our_eo.in_h2, exact.in_h2_median);
  cmp('exact_total', 'Точных вхождений всего', our_eo.total, exact.total_median);
  cmp('trust_links', 'Trust-ссылок на внешние авторитетные домены', our_tl.trust_links, trust.trust_links_median);

  return out;
}

// ── internal ─────────────────────────────────────────────────────────────

function _buildChecklist(req) {
  const out = [];
  const push = (id, label, importance, source) => out.push({ id, label, importance, source });

  // Title
  if (req.title.include_query_exact) {
    push('title_exact_query', 'Включить точную фразу запроса в title', 'must', 'title_template');
  }
  if (req.title.include_year) {
    push('title_year', `Указать год (${req.freshness.current_year || 'актуальный'}) в title`, 'should', 'title_template');
  }
  if (req.title.include_number) {
    push('title_number', 'Использовать число/цифру в title (статистика, год, номер списка)', 'should', 'title_template');
  }
  if (req.title.include_parens) {
    push('title_parens', 'Добавить скобочную часть в title для CTR (например, "(пошагово)")', 'nice', 'title_template');
  }
  if (req.title.title_h1_should_match) {
    push('title_h1_match', 'title и H1 должны совпадать или быть близки (Google titleMatchScore)', 'must', 'title_template');
  }
  if (Array.isArray(req.title.recommended_modifiers) && req.title.recommended_modifiers.length) {
    push(
      'title_modifiers',
      `Рассмотреть CTR-модификаторы в title: ${req.title.recommended_modifiers.slice(0, 5).join(', ')}`,
      'nice',
      'title_template',
    );
  }
  if (req.title.length_chars.median) {
    push(
      'title_length',
      `Длина title ~${Math.round(req.title.length_chars.median)} симв. (диапазон ${req.title.length_chars.min}–${req.title.length_chars.max})`,
      'should',
      'title_template',
    );
  }

  // Schemas
  for (const t of req.schemas.mandatory) {
    push(`schema_${t.toLowerCase()}`, `Добавить schema.org/${t}`, 'must', 'schema_profile');
  }

  // Freshness
  if (req.freshness.include_update_date) {
    push('freshness_update_date', 'Указать дату последнего обновления (видимую) — топ свежий', 'must', 'freshness_profile');
  }
  if (req.freshness.mention_current_year) {
    push('freshness_year', `Упоминать актуальный год (${req.freshness.current_year}) в тексте/title`, 'should', 'freshness_profile');
  }

  // Structure
  if (req.structure.should_have_toc) {
    push('ux_toc', 'Добавить оглавление/Table of Contents', 'must', 'ux_profile');
  }
  if (req.structure.should_have_faq_early) {
    push('ux_faq', 'Включить FAQ-блок (раннее появление в выдаче топа)', 'must', 'ux_profile');
  }
  if (req.structure.should_have_tldr) {
    push('ux_tldr', 'Добавить TL;DR / краткое резюме в начале', 'should', 'ux_profile');
  }
  if (req.structure.should_have_first_img_alt) {
    push('ux_first_img_alt', 'Заполнить ALT первой картинки', 'must', 'ux_profile');
  }
  if (req.structure.h2_count_median) {
    push('ux_h2', `Запланировать ~${Math.round(req.structure.h2_count_median)} H2-разделов`, 'should', 'ux_profile');
  }

  // Slug
  if (req.slug.recommendation_text) {
    push('slug_pattern', `Slug: ${req.slug.recommendation_text}`, 'should', 'slug_pattern');
  }

  // Trust
  if (req.trust.target_per_1000_words >= MIN_TRUST_LINKS_PER_1K_WORDS) {
    push(
      'trust_density',
      `Поставить ~${req.trust.target_per_1000_words.toFixed(1)} ссылок на trust-домены на 1000 слов (.gov/Wikipedia/ГОСТ/крупные СМИ)`,
      'must',
      'trust_link_quota',
    );
  }

  // Exact-query
  if (req.exact_query.first_100_words_median) {
    push(
      'exact_first_100',
      `Точная фраза запроса должна встречаться в первых 100 словах (медиана топа: ${req.exact_query.first_100_words_median})`,
      'must',
      'exact_query_position_targets',
    );
  }
  if (req.exact_query.h2_median) {
    push(
      'exact_h2',
      `Включить точную фразу запроса в ≥${Math.max(1, Math.round(req.exact_query.h2_median))} H2`,
      'should',
      'exact_query_position_targets',
    );
  }

  // Host hygiene
  for (const k of req.host_hygiene.must_have) {
    const labels = {
      has_canonical:        'rel="canonical"',
      has_hreflang:         'hreflang-альтернативы',
      has_open_graph:       'OpenGraph-метатеги',
      has_twitter_cards:    'Twitter Cards',
      has_sitemap_link:     'ссылка на sitemap',
      has_yandex_metrika:   'счётчик Яндекс.Метрики',
      has_google_analytics: 'счётчик Google Analytics',
      has_author_signal:    'JSON-LD Person / meta author / rel=author',
    };
    push(`hygiene_${k}`, `Добавить: ${labels[k] || k}`, 'must', 'host_hygiene');
  }

  return out;
}

module.exports = {
  buildCompetitorSignalsRequirements,
  compareOurDocumentToTop,
};
