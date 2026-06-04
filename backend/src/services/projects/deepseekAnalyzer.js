'use strict';

/**
 * projects/deepseekAnalyzer.js — «Senior SEO-аналитик» на базе DeepSeek.
 *
 * Получает срез данных GSC за период (топ-запросы, топ-страницы, динамика
 * кликов/позиций) + описание целевой аудитории проекта и возвращает
 * форматированный Markdown-отчёт строго по структуре из ТЗ:
 *   1) Общая оценка ситуации (почему метрики растут/падают)
 *   2) Точки роста
 *   3) Усиление семантических коконов (topic clusters)
 *   4) Рекомендации по постраничной оптимизации
 *   5) Чёткий пошаговый Action Plan
 *
 * Долгий ответ (30–60 c+) — вызывающий код запускает это в фоне. Graceful:
 * никогда не бросает, возвращает { verdict: 'ok'|'skipped'|'error' }.
 */

const { callDeepSeek } = require('../llm/deepseek.adapter');
const { calcCost } = require('../metrics/priceCalculator');
const llmUsageLog = require('../aegis/llmUsageLog');
const { getProjectsConfig } = require('./config');

const SYSTEM_PROMPT = [
  'Ты — Senior SEO-аналитик с 10+ годами опыта в поисковом продвижении.',
  'Тебе передают реальные данные из Google Search Console (динамика кликов,',
  'показов, CTR и средней позиции, топ-запросы и топ-страницы) и описание',
  'целевой аудитории проекта.',
  '',
  'Твоя задача — выдать развёрнутый, практичный отчёт на русском языке в',
  'формате Markdown. Используй заголовки (##), списки, **жирный** для',
  'акцентов и таблицы, где это уместно. Строго соблюдай структуру:',
  '',
  '## 1. Общая оценка текущей ситуации',
  'Почему метрики растут или падают, что говорит динамика позиций и CTR.',
  'Если в данных есть [ЧТО ИЗМЕНИЛОСЬ vs ПРЕДЫДУЩИЙ РАВНЫЙ ПЕРИОД] —',
  'опирайся на ДЕКОМПОЗИЦИЮ Δclicks (вклад спроса vs CTR) и называй',
  'конкретные движущие запросы/страницы. Не ограничивайся фразой «упало',
  'на N%» — раскрой ПРИЧИНУ (спрос упал / позиции просели / CTR провалился).',
  '',
  '## 2. Точки роста',
  'Что стоит усилить в первую очередь (конкретные запросы/страницы).',
  '',
  '## 3. Семантические коконы (topic clusters)',
  'Где и как усилить семантические коконы: какие кластеры достроить,',
  'какие опорные и дочерние страницы создать, как перелинковать.',
  '',
  '## 4. Постраничная оптимизация',
  'Рекомендации по конкретным URL из топа: title/description, контент,',
  'интент, внутренние ссылки. Если есть [PAGE DECAY DETECTOR] — отдельно',
  'выдели страницы с decaying=true и предложи план их content refresh',
  '(что обновить, какие новые секции добавить, как перелинковать).',
  '',
  '## 5. Action Plan на ближайший период',
  'Чёткий пронумерованный пошаговый план развития (что, зачем, ожидаемый',
  'эффект). Приоритизируй шаги.',
  '',
  '## 6. Коммерческий рост',
  'ОБЯЗАТЕЛЬНЫЙ раздел с упором на рост КОММЕРЧЕСКОГО трафика и выручки.',
  'Тебе передан детерминированный [КОММЕРЧЕСКИЙ СРЕЗ]: распределение запросов',
  'по интенту, доля коммерческого/брендового трафика, коммерческие запросы',
  'в зоне быстрого роста (striking distance), CTR-аномалии, каннибализация и',
  'несоответствие интента. На его основе дай приоритизированный план именно',
  'для коммерции: какие коммерческие страницы (каталог/услуги/карточки)',
  'усилить; под какие коммерческие запросы создать или доработать посадочные',
  'страницы; конкретные гипотезы по CTR (title/description/schema/rich',
  'snippets) для аномалий; как устранить каннибализацию (склейка/перелинковка/',
  'канонизация); куда направить пользователей при несоответствии интента;',
  'как развивать небрендовый коммерческий спрос, если доминирует бренд.',
  'Если коммерческого среза нет — кратко объясни, что усилить для коммерции',
  'на основе топ-запросов и страниц.',
  '',
  '## 7. Сегменты: устройства, гео, rich snippets, бренд',
  'Если в данных есть [СРЕЗ ПО УСТРОЙСТВАМ] / [СРЕЗ ПО СТРАНАМ] /',
  '[СРЕЗ ПО SEARCH APPEARANCE] / [БРЕНД vs НЕБРЕНД] — выдай по 1–3 ёмких',
  'наблюдения по каждому сегменту и конкретные действия (mobile-fix,',
  'hreflang/локализация, внедрение/расширение rich-snippets, развитие',
  'небрендового спроса). Если каких-то срезов нет — пропусти подразделы.',
  '',
  '## 8. Ссылочная стратегия (анкоры/доноры)',
  'Если есть [ССЫЛОЧНАЯ СТРАТЕГИЯ] — на её основе дай НЕ МЕНЕЕ 5 конкретных',
  'рекомендаций на закупку ссылок в формате таблицы: «анкор | тип анкора |',
  'тема статьи донора | целевой URL на нашем сайте | приоритет | зачем».',
  'Отдельно оцени доноров (каких стоит покупать, каких избегать) и анкор-профиль',
  '(перекосы, переоптимизация). Если data_source=inferred — честно отметь, что',
  'данных GSC по ссылкам нет и рекомендации построены от контента/SERP.',
  '',
  '## 9. Аудит ссылочного профиля',
  'Если есть [АУДИТ ССЫЛОК] — диагностируй текущий профиль: рискованные доноры,',
  'перекошенные анкоры, целевые страницы без ссылок (орфаны), что поправить',
  '(Disavow, разбавление анкоров, приоритетные цели линкбилдинга).',
  '',
  '## 10. План публикаций в блог (≥5 тем)',
  'Если есть [ПЛАН БЛОГА] — выдай НЕ МЕНЕЕ 5 тем статей таблицей:',
  '«тема | H1 | title (50-60) | description (140-155) | целевой интент URL |',
  'опорные запросы». Опирайся на контентные дыры (striking-distance инфо-запросы,',
  'mismatch, гео-спрос). Темы должны раскрывать спрос и вести трафик на сайт.',
  '',
  '## 11. E-E-A-T по шаблонам страниц',
  'Если есть [E-E-A-T ПО ШАБЛОНАМ] — по каждому шаблону (каталог/услуги/товар/',
  'блог/о компании) назови score, чего не хватает по Experience/Expertise/',
  'Authoritativeness/Trust и дай конкретный план усиления (автор+регалии, кейсы/',
  'фото, отзывы, контакты/юр.инфо, сертификаты, политика).',
  '',
  '## 12. GEO/AEO — нейровыдача (AI Overviews / SGE)',
  'Если есть [GEO/AEO] — дай рекомендации, чтобы сайт попадал в нейровыдачу ИИ',
  '(ChatGPT/Perplexity/Google SGE): AEO-формат ответов (TL;DR в первых 40-80',
  'словах, списки, явные сущности, prompt-friendly заголовки), каких JSON-LD',
  'типов не хватает для AI Overviews, hreflang/локализация, связывание сущностей',
  '(sameAs/mentions), Speakable. Если есть AI-visibility probe — учитывай его.',
  '',
  '## 13. Микроразметка: что добавить и поправить',
  'Если есть [МИКРОРАЗМЕТКА] — по каждому шаблону: какие типы Schema.org есть,',
  'каких не хватает, что битое (нет price/availability/author/datePublished и',
  'т.п.). Дай готовые JSON-LD сниппеты из переданных рекомендаций.',
  '',
  '## 14. Почему страницы в топе и рекомендации для будущих статей',
  'Если есть [РЕВЕРС-ИНЖИНИРИНГ ТОП-СТРАНИЦ] — отдельным этапом проанализируй',
  'страницы-лидеры (высокие показы + высокая позиция): объясни, ПОЧЕМУ они в',
  'топе и ЧТО влияет на позицию (объём, структура H2/H3, списки/таблицы/медиа,',
  'покрытие семантики запросов в тексте, интент). Выяви ЗАКОНОМЕРНОСТИ по',
  'лидерам (типичный объём, структура, форматы) и сведи их в перечень',
  'конкретных РЕКОМЕНДАЦИЙ для написания будущих статей. Раскрой и приоритизируй',
  'переданные детерминированные рекомендации.',
  '',
  'Опирайся только на переданные данные и здравый SEO-смысл, не выдумывай',
  'цифр. Учитывай целевую аудиторию проекта во всех рекомендациях.',
  'Не добавляй преамбулы и заключения вне этой структуры.',
].join('\n');

function _stripFence(text) {
  if (!text) return '';
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function _buildUserPrompt({ project, range, performance, top, commercial, serpVerification,
  breakdowns, periodCompare, pageDecay, brandSplit,
  pageMetaAudit, eat, schemaAudit, linkAudit, blogPlan, geoAeo, topPageInsights }) {
  const lines = [
    '[ПРОЕКТ]',
    `Название: ${project.name || '—'}`,
    `Сайт: ${project.gsc_site_url || project.url || '—'}`,
    `Целевая аудитория: ${project.audience_description || '[не задано]'}`,
    '',
    `[ПЕРИОД] ${range.startDate} — ${range.endDate}`,
    '',
    '[СУММАРНЫЕ МЕТРИКИ]',
    `Клики: ${performance.totals.clicks}`,
    `Показы: ${performance.totals.impressions}`,
    `CTR: ${performance.totals.ctr}%`,
    `Средняя позиция: ${performance.totals.position}`,
    '',
    '[ДИНАМИКА ПО ДНЯМ] (date, clicks, impressions, ctr%, position)',
    JSON.stringify(performance.series.slice(-90)),
    '',
    `[ТОП-${top.topQueries.length} ЗАПРОСОВ] (query, clicks, impressions, ctr%, position)`,
    JSON.stringify(top.topQueries),
    '',
    `[ТОП-${top.topPages.length} СТРАНИЦ] (page, clicks, impressions, ctr%, position)`,
    JSON.stringify(top.topPages),
  ];
  lines.push(..._renderPeriodCompareLines(periodCompare));
  lines.push(..._renderBreakdownLines(breakdowns));
  lines.push(..._renderPageDecayLines(pageDecay));
  lines.push(..._renderBrandSplitLines(brandSplit));
  if (commercial && commercial.available) {
    lines.push(
      '',
      '[КОММЕРЧЕСКИЙ СРЕЗ] (детерминированный анализ для раздела 6)',
      `Доля коммерческого трафика: ${commercial.commercial_clicks_pct}% кликов, ${commercial.commercial_impressions_pct}% показов`,
      `Доля брендового трафика: ${commercial.branded_clicks_pct}% кликов`,
      `Брендовые маркеры: ${(commercial.brand_tokens || []).join(', ') || '—'}`,
      '',
      'Распределение по интенту (intent, queries, clicks, clicksPct):',
      JSON.stringify(commercial.intent_distribution),
      '',
      'Коммерческие запросы в зоне быстрого роста / striking distance (query, intent, impressions, ctr%, position):',
      JSON.stringify(commercial.striking_distance),
      '',
      'CTR-аномалии на коммерческих запросах — CTR ниже ожидаемого для позиции (query, ctr%, expectedCtr%, position, impressions):',
      JSON.stringify(commercial.ctr_anomalies),
      '',
      'Каннибализация коммерческих запросов — один запрос делят несколько URL, ни один не в топ-3 (query, best_position, pages):',
      JSON.stringify(commercial.cannibalization),
      '',
      'Несоответствие интента — коммерческий запрос приземляется на инфо-страницу (query, landing_page, impressions, position):',
      JSON.stringify(commercial.intent_mismatch),
    );
  }
  lines.push(..._renderSerpVerificationLines(serpVerification));
  lines.push(..._renderLinkStrategyLines(linkAudit));
  lines.push(..._renderBlogPlanLines(blogPlan));
  lines.push(..._renderPageMetaAuditLines(pageMetaAudit));
  lines.push(..._renderEatLines(eat));
  lines.push(..._renderGeoAeoLines(geoAeo));
  lines.push(..._renderSchemaAuditLines(schemaAudit));
  lines.push(..._renderTopPageInsightsLines(topPageInsights));
  return lines.join('\n');
}

/**
 * Срез изменений vs предыдущий равный период: тоталы, декомпозиция Δclicks
 * (вклад спроса vs CTR), топ движущих запросов и страниц.
 */
function _renderPeriodCompareLines(pc) {
  if (!pc || !pc.available) return [];
  const lines = [
    '',
    '[ЧТО ИЗМЕНИЛОСЬ vs ПРЕДЫДУЩИЙ РАВНЫЙ ПЕРИОД]',
    'Используй этот срез как ОСНОВУ раздела 1: вместо общих оценок «выросло/',
    'упало» — назови КОНКРЕТНУЮ причину (спрос, позиции или CTR).',
    `Дельты тоталов (clicks, impressions, ctr%, position): ${JSON.stringify(pc.totals.delta)}`,
    `Дельты в %: ${JSON.stringify(pc.totals.pct)}`,
    'Декомпозиция Δclicks ≈ ΔImpr×CTRprev + ImprCurr×ΔCTR:',
    JSON.stringify(pc.totals.decomposition),
    '',
    'Топ растущих запросов (key, delta.clicks, delta.position, clicks_curr, impressions_curr):',
    JSON.stringify((pc.queries.risers || []).map((r) => ({
      key: r.key, delta_clicks: r.delta.clicks, delta_position: r.delta.position,
      clicks_curr: r.clicks_curr, impressions_curr: r.impressions_curr,
    }))),
    'Топ падающих запросов:',
    JSON.stringify((pc.queries.fallers || []).map((r) => ({
      key: r.key, delta_clicks: r.delta.clicks, delta_position: r.delta.position,
      clicks_curr: r.clicks_curr, clicks_prev: r.clicks_prev,
    }))),
    'Новые запросы в выборке (key, clicks_curr, position_curr):',
    JSON.stringify((pc.queries.newcomers || []).map((r) => ({
      key: r.key, clicks_curr: r.clicks_curr, position_curr: r.position_curr,
    }))),
    'Потерянные запросы (key, clicks_prev, position_prev):',
    JSON.stringify((pc.queries.lost || []).map((r) => ({
      key: r.key, clicks_prev: r.clicks_prev, position_prev: r.position_prev,
    }))),
    '',
    'Топ растущих страниц:',
    JSON.stringify((pc.pages.risers || []).map((r) => ({
      key: r.key, delta_clicks: r.delta.clicks, delta_position: r.delta.position,
    }))),
    'Топ падающих страниц:',
    JSON.stringify((pc.pages.fallers || []).map((r) => ({
      key: r.key, delta_clicks: r.delta.clicks, delta_position: r.delta.position,
    }))),
  ];
  return lines;
}

/** Срез по устройствам / странам / searchAppearance. */
function _renderBreakdownLines(breakdowns) {
  if (!breakdowns) return [];
  const out = [];
  if (Array.isArray(breakdowns.device) && breakdowns.device.length) {
    out.push('', '[СРЕЗ ПО УСТРОЙСТВАМ] (key, clicks, impressions, ctr%, position)',
      JSON.stringify(breakdowns.device));
  }
  if (Array.isArray(breakdowns.country) && breakdowns.country.length) {
    out.push('', '[СРЕЗ ПО СТРАНАМ] (key=ISO-3, clicks, impressions, ctr%, position)',
      JSON.stringify(breakdowns.country));
  }
  if (Array.isArray(breakdowns.searchAppearance) && breakdowns.searchAppearance.length) {
    out.push('', '[СРЕЗ ПО SEARCH APPEARANCE] (key=тип rich-result, clicks, impressions, ctr%, position)',
      JSON.stringify(breakdowns.searchAppearance));
  }
  if (out.length) {
    out.push('Используй эти срезы для отдельных гипотез: mobile vs desktop',
      '(скорость/viewport), географическое покрытие (hreflang/локализация),',
      'rich snippets (FAQ/How-to/sitelinks — где недобираем).');
  }
  return out;
}

/** Page-decay detector: страницы-кандидаты на refresh контента. */
function _renderPageDecayLines(pd) {
  if (!pd || !pd.available || !pd.items || pd.items.length === 0) return [];
  return [
    '',
    `[PAGE DECAY DETECTOR] страниц проанализировано: ${pd.pages_analyzed}, в decay: ${pd.decaying_count}`,
    'Страницы с системным падением кликов по неделям — кандидаты на content refresh.',
    'slope_norm — наклон в долях средних кликов в неделю (-0.1 = -10%/нед).',
    'Поле decaying=true — рекомендуй именно их для приоритетного рефреша.',
    JSON.stringify(pd.items.map((it) => ({
      page: it.page, weeks: it.weeks,
      mean_weekly_clicks: it.mean_weekly_clicks,
      slope_norm: it.slope_norm,
      decaying: it.decaying,
    }))),
  ];
}

/** Бренд vs небренд динамика. */
function _renderBrandSplitLines(bs) {
  if (!bs || !bs.available) return [];
  return [
    '',
    '[БРЕНД vs НЕБРЕНД]',
    `Брендовые токены: ${(bs.brand_tokens || []).join(', ') || '—'}`,
    `Branded:    ${JSON.stringify(bs.branded)}`,
    `Non-branded: ${JSON.stringify(bs.nonbranded)}`,
    'Если рост сосредоточен в branded — отдельной задачей предложи как развивать',
    'небрендовый спрос; если небренд проседает на фоне роста бренда — это сигнал',
    'тревоги (теряем «холодную» аудиторию).',
  ];
}

/**
 * Блок проверки каннибализации по реальной топ-выдаче Google. Включается в
 * промт, чтобы LLM рекомендовала склейку разделов ТОЛЬКО там, где выдача это
 * подтверждает (verdict=merge_recommended), а не по одному сигналу из GSC.
 */
function _renderSerpVerificationLines(serpVerification) {
  if (!serpVerification || !serpVerification.available
    || !Array.isArray(serpVerification.items) || serpVerification.items.length === 0) {
    return [];
  }
  return [
    '',
    `[ВЕРИФИКАЦИЯ КАННИБАЛИЗАЦИИ ПО ТОП-ВЫДАЧЕ ${String(serpVerification.engine || 'google').toUpperCase()}]`,
    'Каждый кейс каннибализации сверен с реальной выдачей. Рекомендуй слияние/',
    'склейку разделов ТОЛЬКО для verdict=merge_recommended. Для keep_separate —',
    'НЕ предлагай объединять страницы. Для inconclusive — отметь, что выдачу не',
    'удалось снять, и опирайся на данные GSC.',
    'Кейсы (query, verdict, best_position, site_pages_in_top_count, recommendation):',
    JSON.stringify(serpVerification.items.map((it) => ({
      query: it.query,
      verdict: it.verdict,
      best_position: it.best_position,
      site_pages_in_top_count: it.site_pages_in_top_count,
      recommendation: it.recommendation,
    }))),
  ];
}

/** [ССЫЛОЧНАЯ СТРАТЕГИЯ] + [АУДИТ ССЫЛОК] (разделы 8-9, ≥5 рекомендаций). */
function _renderLinkStrategyLines(link) {
  if (!link || !link.available) return [];
  const out = ['', '[ССЫЛОЧНАЯ СТРАТЕГИЯ] (раздел 8 — выдай ≥5 рекомендаций)',
    `data_source: ${link.data_source} (gsc_csv = есть выгрузка GSC; inferred = построено от контента/SERP)`,
    `Рекомендации на закупку ссылок (anchor, anchor_type, donor_topic, target_url, priority, why):`,
    JSON.stringify((link.recommendations || []).slice(0, 20))];
  if (link.audit && link.audit.available) {
    const a = link.audit;
    out.push('', '[АУДИТ ССЫЛОК] (раздел 9)',
      `Анкор-профиль (distribution): ${JSON.stringify(a.anchors && a.anchors.distribution)}`,
      `Предупреждения по анкорам: ${JSON.stringify((a.anchors && a.anchors.warnings) || [])}`,
      `Топ-доноры (host, trust_score, flags): ${JSON.stringify((a.donors || []).slice(0, 15))}`,
      `Орфаны — топ-страницы без ссылок (url, impressions): ${JSON.stringify((a.orphans || []).map((o) => ({ url: o.url, impressions: o.impressions })))}`,
      `Проблемы: ${JSON.stringify(a.issues || [])}`);
  }
  return out;
}

/** [ПЛАН БЛОГА] (раздел 10, ≥5 тем). */
function _renderBlogPlanLines(blog) {
  if (!blog || !blog.available || !Array.isArray(blog.topics) || blog.topics.length === 0) return [];
  return ['', '[ПЛАН БЛОГА] (раздел 10 — выдай ≥5 тем статей)',
    'Темы (topic, h1, title, description, target_url_intent, supporting_queries):',
    JSON.stringify(blog.topics),
    `Гео-сигналы: ${JSON.stringify((blog.gap_signals && blog.gap_signals.geo) || [])}`];
}

/** [ПОСТРАНИЧНЫЙ МЕТА-АУДИТ] (усиливает раздел 4). */
function _renderPageMetaAuditLines(meta) {
  if (!meta || !meta.available || !Array.isArray(meta.pages) || meta.pages.length === 0) return [];
  const rows = meta.pages.map((p) => ({
    url: p.url, reason: p.reason,
    before: p.before, lengths: p.lengths,
    suggested: p.suggested || null,
  }));
  return ['', '[ПОСТРАНИЧНЫЙ МЕТА-АУДИТ] (используй в разделе 4: таблица «было → стало»)',
    'Для страниц с suggested!=null покажи готовые рекомендованные title/description/H1.',
    'Для остальных — предложи усиление по выявленным issues длины/дублей.',
    JSON.stringify(rows)];
}

/** [E-E-A-T ПО ШАБЛОНАМ] (раздел 11). */
function _renderEatLines(eat) {
  if (!eat || !eat.available || !Array.isArray(eat.templates) || eat.templates.length === 0) return [];
  const rows = eat.templates.map((t) => ({
    template: t.template, sample_url: t.sample_url, score: t.score, level: t.level,
    dimensions: t.dimensions, gaps: t.gaps, strengths: t.strengths,
  }));
  return ['', '[E-E-A-T ПО ШАБЛОНАМ] (раздел 11)',
    `Средний score: ${eat.avg_score}`,
    JSON.stringify(rows)];
}

/** [GEO/AEO] (раздел 12). */
function _renderGeoAeoLines(geo) {
  if (!geo || !geo.available || !geo.aeo || !geo.aeo.available) return [];
  const a = geo.aeo;
  const out = ['', '[GEO/AEO] (раздел 12 — нейровыдача AI Overviews / SGE)',
    `AEO-форматы ответов по запросам: ${JSON.stringify((a.aeo_answers || []).slice(0, 10))}`,
    `Не хватает JSON-LD типов для AI Overviews: ${JSON.stringify(a.missing_schema || [])}`,
    `Гео-спрос вне основного региона: ${JSON.stringify(a.geo || [])}`,
    `Рекомендации: ${JSON.stringify(a.recommendations || [])}`];
  if (geo.ai_visibility && Array.isArray(geo.ai_visibility.probes) && geo.ai_visibility.probes.length) {
    out.push(`AI-visibility probe (query, sge_includes_us, ai_opportunity): ${JSON.stringify(geo.ai_visibility.probes)}`);
  }
  return out;
}

/** [МИКРОРАЗМЕТКА] (раздел 13). */
function _renderSchemaAuditLines(schema) {
  if (!schema || !schema.available || !Array.isArray(schema.items) || schema.items.length === 0) return [];
  return ['', '[МИКРОРАЗМЕТКА] (раздел 13)',
    `Сводка: ${JSON.stringify(schema.summary)}`,
    'По шаблонам (template, present_types, missing_types, broken_fields, actions, snippets):',
    JSON.stringify(schema.items)];
}

/**
 * [РЕВЕРС-ИНЖИНИРИНГ ТОП-СТРАНИЦ] (п.3 — почему страницы в топе + рекомендации
 * для будущих статей). Отдаём профили лидеров, выявленные закономерности и
 * детерминированные рекомендации, чтобы нарратив объяснил факторы позиции.
 */
function _renderTopPageInsightsLines(tpi) {
  if (!tpi || !tpi.available || !Array.isArray(tpi.pages) || tpi.pages.length === 0) return [];
  const rows = tpi.pages
    .filter((p) => p && !p.error)
    .map((p) => ({
      url: p.url,
      position: p.position,
      impressions: p.impressions,
      profile: p.profile,
      coverage_pct: p.coverage && p.coverage.coverage_pct,
      ranking_factors: p.ranking_factors,
    }));
  return ['', '[РЕВЕРС-ИНЖИНИРИНГ ТОП-СТРАНИЦ] (используй: объясни, ПОЧЕМУ эти страницы в топе и что влияет на позицию)',
    `Закономерности по лидерам выдачи: ${JSON.stringify(tpi.patterns || {})}`,
    'Профили страниц-лидеров (url, position, impressions, profile, coverage_pct, ranking_factors):',
    JSON.stringify(rows),
    'Рекомендации для будущих статей (детерминированные — раскрой и приоритизируй):',
    JSON.stringify(tpi.recommendations || [])];
}

/**
 * Возвращает имя «провайдера» для priceCalculator/llmUsageLog в зависимости
 * от выбранной модели DeepSeek. Reasoner тарифицируется отдельным тарифом
 * (см. priceCalculator.PRICES.deepseek_reasoner).
 */
function _providerName(model) {
  return /reasoner|r1/i.test(String(model || '')) ? 'deepseek-reasoner' : 'deepseek';
}

/**
 * Запускает анализ. Возвращает объект-результат (никогда не бросает).
 */
async function runProjectAnalysis(payload) {
  const cfg = getProjectsConfig().deepseek;
  if (!cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };

  const userPrompt = _buildUserPrompt(payload);
  try {
    const t0 = Date.now();
    const resp = await callDeepSeek(SYSTEM_PROMPT, userPrompt, {
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      model: cfg.model,
    });
    const tIn = resp.tokensIn || 0;
    const tOut = resp.tokensOut || 0;
    const cached = resp.cacheHitTokens || 0;
    const provider = _providerName(cfg.model);
    const cost = calcCost(provider, tIn, tOut, { cachedTokens: cached });
    const durationMs = Date.now() - t0;
    // Эгида: учитываем расход LLM в сквозной cost-аналитике (graceful, не бросает).
    try {
      llmUsageLog.recordUsage({
        provider,
        kind: 'project_seo_analysis',
        outcome: 'ok',
        tokensIn: tIn,
        tokensOut: tOut,
        cachedTokens: cached,
        costUsd: cost,
        latencyMs: durationMs,
      });
    } catch (_) { /* no-op */ }
    return {
      verdict: 'ok',
      markdown: _stripFence(resp.text || ''),
      tokens_in: tIn,
      tokens_out: tOut,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: resp.model || cfg.model || 'deepseek',
      duration_ms: durationMs,
    };
  } catch (err) {
    try {
      llmUsageLog.recordUsage({ provider: _providerName(cfg.model), kind: 'project_seo_analysis', outcome: 'error' });
    } catch (_) { /* no-op */ }
    return { verdict: 'error', reason: (err && err.message) ? err.message : String(err) };
  }
}

module.exports = { runProjectAnalysis, runProjectAnalysisBatched, SYSTEM_PROMPT, _buildUserPrompt };

// ── Порционный (map-reduce) режим для больших наборов данных ───────────

const { buildChunks, runMapReduce, estimateWorkload, shouldBatch } = require('./batchAnalyzer');

// MAP: ёмкое извлечение выводов и гипотез по одной порции данных.
const MAP_SYSTEM_PROMPT = [
  'Ты — SEO-аналитик. Тебе дают ПОРЦИЮ строк Google Search Console',
  '(query × page: клики, показы, CTR%, позиция). Это часть большого набора.',
  'Выдели только САМОЕ ВАЖНОЕ по этой порции в виде коротких буллетов на',
  'русском, без воды и преамбул, максимально ёмко:',
  '• точки роста (запросы/страницы у входа в топ);',
  '• подозрения на каннибализацию (один запрос — несколько URL);',
  '• несоответствие интента (коммерческий запрос на инфо-странице);',
  '• заметные CTR-аномалии и гипотезы по их причинам.',
  'Не выдумывай данных. Не более 12 буллетов. Только буллеты.',
].join('\n');

function _buildMapUserPrompt(chunk) {
  return [
    `[ПОРЦИЯ ${chunk.index}/${chunk.total}] строк query×page: ${chunk.items.length}`,
    '(query, page, clicks, impressions, ctr%, position)',
    JSON.stringify(chunk.items.map((r) => ({
      query: r.query, page: r.page, clicks: r.clicks,
      impressions: r.impressions, ctr: r.ctr, position: r.position,
    }))),
  ].join('\n');
}

async function _callDeepSeekTracked(system, user, cfg, kind) {
  const t0 = Date.now();
  const resp = await callDeepSeek(system, user, {
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    model: cfg.model,
  });
  const tIn = resp.tokensIn || 0;
  const tOut = resp.tokensOut || 0;
  const cached = resp.cacheHitTokens || 0;
  const provider = _providerName(cfg.model);
  const cost = calcCost(provider, tIn, tOut, { cachedTokens: cached });
  const durationMs = Date.now() - t0;
  try {
    llmUsageLog.recordUsage({
      provider, kind, outcome: 'ok',
      tokensIn: tIn, tokensOut: tOut, cachedTokens: cached,
      costUsd: cost, latencyMs: durationMs,
    });
  } catch (_) { /* no-op */ }
  return { text: resp.text || '', tIn, tOut, cached, cost, model: resp.model || cfg.model || 'deepseek', durationMs };
}

/**
 * Порционный анализ: режет тяжёлый срез (query×page) на порции, по каждой
 * извлекает выводы/гипотезы (map), затем сводит общий пул в единый отчёт
 * (reduce). Включается в analysisRunner при большом объёме данных.
 * Graceful: при провале map-reduce откатывается на обычный runProjectAnalysis.
 */
async function runProjectAnalysisBatched(payload) {
  const cfg = getProjectsConfig();
  const dcfg = cfg.deepseek;
  const bcfg = cfg.batch;
  if (!dcfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };
  if (!process.env.DEEPSEEK_API_KEY) return { verdict: 'skipped', reason: 'no_api_key' };

  const slice = {
    topQueries: (payload.top && payload.top.topQueries) || [],
    queryPage: Array.isArray(payload.queryPage) ? payload.queryPage : [],
  };
  const chunks = buildChunks(slice, bcfg);
  // Слишком мало порций — нет смысла в map-reduce, обычный путь.
  if (chunks.length < 2) return runProjectAnalysis(payload);

  try {
    let mapTokIn = 0; let mapTokOut = 0; let mapCost = 0;
    const mapFn = async (chunk) => {
      const r = await _callDeepSeekTracked(
        MAP_SYSTEM_PROMPT, _buildMapUserPrompt(chunk), dcfg, 'project_seo_analysis_map',
      );
      mapTokIn += r.tIn; mapTokOut += r.tOut; mapCost += r.cost;
      const text = _stripFence(r.text).trim();
      return text ? { index: chunk.index, total: chunk.total, text } : null;
    };

    const reduceFn = async (partials) => {
      const base = _buildUserPrompt(payload);
      const poolLines = partials.map(
        (p) => `— Порция ${p.index}/${p.total}:\n${p.text}`,
      );
      const reduceUser = [
        base,
        '',
        '[СВЕДЁННЫЙ ПУЛ ВЫВОДОВ И ГИПОТЕЗ ПО ПОРЦИЯМ]',
        'Данные были обработаны порционно. Ниже — ёмкие выводы по каждой порции.',
        'Сведи их в единый непротиворечивый отчёт по структуре выше, убери',
        'дубли, расставь приоритеты. Держи изложение ёмким, чётким и понятным.',
        '',
        poolLines.join('\n\n'),
      ].join('\n');
      const r = await _callDeepSeekTracked(
        SYSTEM_PROMPT, reduceUser, dcfg, 'project_seo_analysis_reduce',
      );
      return r;
    };

    const { result: reduced, stats } = await runMapReduce({
      chunks, mapFn, reduceFn, concurrency: bcfg.concurrency,
    });

    const tokIn = mapTokIn + reduced.tIn;
    const tokOut = mapTokOut + reduced.tOut;
    const cost = mapCost + reduced.cost;
    return {
      verdict: 'ok',
      markdown: _stripFence(reduced.text),
      tokens_in: tokIn,
      tokens_out: tokOut,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: reduced.model,
      duration_ms: reduced.durationMs,
      batched: true,
      batch_stats: stats,
    };
  } catch (err) {
    // Любой сбой порционного режима — мягкий откат на одиночный анализ.
    try {
      llmUsageLog.recordUsage({ provider: _providerName(dcfg.model), kind: 'project_seo_analysis_batched', outcome: 'error' });
    } catch (_) { /* no-op */ }
    return runProjectAnalysis(payload);
  }
}

// Реэкспорт утилит для analysisRunner (решение о порционном режиме).
module.exports.estimateWorkload = estimateWorkload;
module.exports.shouldBatch = shouldBatch;
