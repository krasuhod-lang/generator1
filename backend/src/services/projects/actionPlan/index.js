'use strict';

/**
 * projects/actionPlan — «План действий» с железными аргументами (ТЗ п.3).
 *
 * Назначение: превратить уже собранные срезы анализа (CTR-аномалии, striking
 * distance, page decay, каннибализация, контент-гэпы, мета-аудит) в КОНКРЕТНЫЕ,
 * посчитанные рекомендации вида «поменять X на Y, потому что Z, ожидаемый
 * эффект +N кликов». Это не «просто», а связывание сигналов в логические
 * цепочки с количественной оценкой потенциала по эталонной CTR-кривой.
 *
 * Слой состоит из:
 *   • детерминированной математики (expectedClicksAtPosition, expectedExtraClicks,
 *     selectMetaTargets, buildStrikingDistance, buildContentRefresh,
 *     buildCannibalization, buildArticleTopics, summarize) — тестируется без сети;
 *   • асинхронного оркестратора buildActionPlan, который ДОПОЛНИТЕЛЬНО получает
 *     конкретные значения мета-тегов (было→стало) через мета-генератор +
 *     анализ выдачи xmlstock + парсинг страниц (pageMetaAudit.regenerateMetaForPages).
 *
 * Всё graceful: при отсутствии ключей LLM / ошибке генерации остаётся
 * детерминированная диагностика и расчёт недобора кликов без значения «стало».
 */

const { getProjectsConfig } = require('../config');

function _round(n, p = 0) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Эталонный CTR (доля 0..1) для позиции по таблице commercial.ctrBenchmark.
 * Для позиций хуже таблицы — tailCtr. Дробные позиции — линейная интерполяция
 * между соседними целыми, чтобы оценка была плавной.
 */
function expectedClicksAtPosition(position, benchmark, tailCtr = 0.01) {
  const ctr = ctrForPosition(position, benchmark, tailCtr);
  return ctr;
}

function ctrForPosition(position, benchmark, tailCtr = 0.01) {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos <= 0) return 0;
  const bench = benchmark || {};
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const at = (k) => {
    if (bench[k] != null) return Number(bench[k]);
    return Number(tailCtr) || 0;
  };
  if (lo === hi) return at(lo);
  const frac = pos - lo;
  return at(lo) + (at(hi) - at(lo)) * frac;
}

/**
 * Сколько дополнительных кликов даст выход с текущей позиции на целевую.
 * extra = impressions × (CTR(target) − CTR(current_factual)). Если фактический
 * CTR не передан — берём эталонный для текущей позиции. Никогда не отрицательно.
 *
 * @returns {{current_ctr_pct:number, target_ctr_pct:number, extra_clicks:number}}
 */
function expectedExtraClicks({ impressions, currentCtrPct, position, targetPosition, benchmark, tailCtr = 0.01 }) {
  const impr = Math.max(0, Number(impressions) || 0);
  const tgt = Math.min(Number(targetPosition) || 3, Number(position) || 999);
  const targetCtr = ctrForPosition(tgt, benchmark, tailCtr);
  const currentCtr = (currentCtrPct != null && Number.isFinite(Number(currentCtrPct)))
    ? Math.max(0, Number(currentCtrPct) / 100)
    : ctrForPosition(position, benchmark, tailCtr);
  const gain = Math.max(0, targetCtr - currentCtr);
  return {
    current_ctr_pct: _round(currentCtr * 100, 2),
    target_ctr_pct: _round(targetCtr * 100, 2),
    extra_clicks: _round(impr * gain, 0),
  };
}

/**
 * Приоритет причины аудита: чем меньше число, тем выше в плане.
 */
const REASON_PRIORITY = {
  ctr_anomaly: 1,
  page_decay: 2,
  intent_mismatch: 3,
  top_impressions: 4,
};

/**
 * Выбирает страницы под конкретную мета-регенерацию из готового page_meta_audit.
 * Приоритет: CTR-аномалия → decay → intent mismatch → топ показов. Берём только
 * успешно распарсенные (есть before) и с привязанными запросами.
 */
function selectMetaTargets(pageMetaAudit, max) {
  const pages = (pageMetaAudit && Array.isArray(pageMetaAudit.pages)) ? pageMetaAudit.pages : [];
  const usable = pages.filter((p) => p && p.url && p.before && !p.error
    && Array.isArray(p.queries) && p.queries.length > 0);
  usable.sort((a, b) => (REASON_PRIORITY[a.reason] || 9) - (REASON_PRIORITY[b.reason] || 9));
  return usable.slice(0, Math.max(0, Number(max) || 0));
}

/** Человекочитаемая расшифровка причины правки мета-тегов. */
const REASON_RU = {
  ctr_anomaly: 'CTR ниже ожидаемого для позиции — слабый сниппет (title/description)',
  page_decay: 'страница затухает — обновление мета-тегов поддержит refresh контента',
  intent_mismatch: 'несоответствие интента — мета-теги не отражают запрос пользователя',
  top_impressions: 'высокие показы при недоборе кликов — потенциал усиления сниппета',
};

/** Список проблем длины текущих тегов на человеческом языке. */
const ISSUE_RU = {
  empty_title: 'нет title',
  title_too_short: 'title короче 50 символов',
  title_too_long: 'title длиннее 60 символов',
  empty_description: 'нет description',
  description_too_short: 'description короче 140 символов',
  description_too_long: 'description длиннее 155 символов',
  empty_h1: 'нет H1',
  h1_too_long: 'H1 длиннее 70 символов',
  h1_duplicates_title: 'H1 дублирует title',
};

/**
 * Собирает конкретные правки мета-тегов: было → стало + аргумент + ожидаемый
 * эффект в кликах (по CTR-аномалиям страницы). suggestedByUrl — карта url→{title,
 * description,h1} от LLM-генерации (может быть пустой).
 */
function buildMetaChanges({ pageMetaAudit, commercial, suggestedByUrl = {}, benchmark, cfg }) {
  const targets = selectMetaTargets(pageMetaAudit, cfg.maxMetaTargets);
  if (targets.length === 0) return [];

  // Карта url → недобор кликов по CTR-аномалиям коммерческих запросов.
  const anomalyByPage = _ctrAnomalyByPage(pageMetaAudit, commercial, benchmark, cfg);

  return targets.map((p) => {
    const issues = (p.lengths && Array.isArray(p.lengths.issues)) ? p.lengths.issues : [];
    const issueText = issues.map((i) => ISSUE_RU[i] || i).filter(Boolean);
    const suggested = suggestedByUrl[p.url] || (p.suggested || null);
    const topQuery = (p.queries[0] && p.queries[0].query) || '';
    const anomaly = anomalyByPage.get(p.url) || null;

    const whyParts = [REASON_RU[p.reason] || p.reason];
    if (issueText.length) whyParts.push(`Проблемы тегов: ${issueText.join('; ')}`);
    if (topQuery) whyParts.push(`Главный запрос страницы: «${topQuery}»`);

    let expectedEffect = null;
    if (anomaly) {
      whyParts.push(`Фактический CTR ${anomaly.ctr}% против ~${anomaly.expectedCtr}% эталона на позиции ${anomaly.position} → недобор ~${anomaly.extra_clicks} кликов/период`);
      expectedEffect = { extra_clicks: anomaly.extra_clicks, basis: 'ctr_anomaly' };
    }

    return {
      url: p.url,
      reason: p.reason,
      priority: REASON_PRIORITY[p.reason] || 9,
      keyword: topQuery,
      before: p.before,
      lengths: p.lengths || null,
      mandatory_words: p.mandatory_words || [],
      suggested: suggested ? {
        title: suggested.title || '',
        description: suggested.description || '',
        h1: suggested.h1 || '',
      } : null,
      lsi_check: p.lsi_check || null,
      serp_analyzed: Boolean(p.serp_analyzed),
      why: whyParts.join('. '),
      expected_effect: expectedEffect,
    };
  });
}

/** Карта url → агрегированный недобор кликов по CTR-аномалиям запросов страницы. */
function _ctrAnomalyByPage(pageMetaAudit, commercial, benchmark, cfg) {
  const map = new Map();
  const anomalies = (commercial && Array.isArray(commercial.ctr_anomalies)) ? commercial.ctr_anomalies : [];
  if (anomalies.length === 0) return map;
  const pages = (pageMetaAudit && Array.isArray(pageMetaAudit.pages)) ? pageMetaAudit.pages : [];
  const anomalyByQuery = new Map(anomalies.map((a) => [String(a.query || '').toLowerCase(), a]));
  for (const p of pages) {
    if (!p || !Array.isArray(p.queries)) continue;
    for (const q of p.queries) {
      const a = anomalyByQuery.get(String(q.query || '').toLowerCase());
      if (!a) continue;
      const exp = expectedExtraClicks({
        impressions: a.impressions, currentCtrPct: a.ctr, position: a.position,
        targetPosition: a.position, benchmark, tailCtr: cfg.tailCtr,
      });
      // На той же позиции: потенциал = доведение CTR до эталона.
      const targetCtr = ctrForPosition(a.position, benchmark, cfg.tailCtr);
      const gain = Math.max(0, targetCtr - (Number(a.ctr) || 0) / 100);
      const extra = _round((Number(a.impressions) || 0) * gain, 0);
      const prev = map.get(p.url) || { extra_clicks: 0, ctr: a.ctr, expectedCtr: a.expectedCtr, position: a.position };
      map.set(p.url, {
        extra_clicks: prev.extra_clicks + extra,
        ctr: a.ctr, expectedCtr: a.expectedCtr, position: a.position,
        _exp: exp,
      });
    }
  }
  return map;
}

/**
 * Точки быстрого роста (striking distance): запросы на позициях 4–20 с расчётом
 * ожидаемых дополнительных кликов при выходе в топ-N.
 */
function buildStrikingDistance({ commercial, benchmark, cfg, queryPage }) {
  const sd = (commercial && Array.isArray(commercial.striking_distance)) ? commercial.striking_distance : [];
  const minImpr = Number(cfg.minImpressions) || 0;
  const pageByQuery = _bestPageMap(queryPage);
  return sd
    .filter((r) => (Number(r.impressions) || 0) >= minImpr)
    .map((r) => {
      const exp = expectedExtraClicks({
        impressions: r.impressions, currentCtrPct: r.ctr, position: r.position,
        targetPosition: cfg.targetPosition, benchmark, tailCtr: cfg.tailCtr,
      });
      return {
        query: r.query,
        intent: r.intent,
        page: pageByQuery.get(String(r.query || '').toLowerCase()) || null,
        position: r.position,
        impressions: r.impressions,
        ctr: r.ctr,
        target_position: Math.min(cfg.targetPosition, r.position),
        expected_extra_clicks: exp.extra_clicks,
        current_ctr_pct: exp.current_ctr_pct,
        target_ctr_pct: exp.target_ctr_pct,
        action: `Усилить страницу под «${r.query}»: дополнить контент по интенту, перелинковать с авторитетных страниц, обновить title/description под запрос`,
        why: `Позиция ${r.position} при ${r.impressions} показах — близко к топу. Выход на позицию ${Math.min(cfg.targetPosition, r.position)} поднимет CTR с ~${exp.current_ctr_pct}% до ~${exp.target_ctr_pct}% → +${exp.extra_clicks} кликов/период`,
      };
    })
    .filter((r) => r.expected_extra_clicks > 0)
    .sort((a, b) => b.expected_extra_clicks - a.expected_extra_clicks)
    .slice(0, Number(cfg.maxStrikingDistance) || 15);
}

function _bestPageMap(queryPage) {
  const map = new Map();
  if (!Array.isArray(queryPage)) return map;
  for (const r of queryPage) {
    const key = String(r.query || '').toLowerCase();
    const prev = map.get(key);
    if (!prev || (Number(r.impressions) || 0) > prev.impressions) {
      map.set(key, { page: r.page, impressions: Number(r.impressions) || 0 });
    }
  }
  // Возвращаем только url.
  const out = new Map();
  for (const [k, v] of map.entries()) out.set(k, v.page);
  return out;
}

/** Затухающие страницы → конкретный план content refresh с цифрами тренда. */
function buildContentRefresh({ pageDecay, cfg }) {
  const items = (pageDecay && Array.isArray(pageDecay.items)) ? pageDecay.items : [];
  return items
    .filter((it) => it && it.decaying)
    .slice(0, Number(cfg.maxContentRefresh) || 10)
    .map((it) => {
      const pctPerWeek = _round((Number(it.slope_norm) || 0) * 100, 1);
      return {
        url: it.page,
        weeks: it.weeks,
        mean_weekly_clicks: it.mean_weekly_clicks,
        slope_pct_per_week: pctPerWeek,
        total_clicks: it.total_clicks,
        action: 'Обновить контент: актуализировать данные/цены/год, добавить новые секции под смежные запросы, обновить дату публикации, усилить внутреннюю перелинковку на страницу',
        why: `Страница системно теряет трафик: тренд ${pctPerWeek}% кликов/неделю на окне ${it.weeks} недель при ~${it.mean_weekly_clicks} кликах/нед. Refresh затухающей страницы — самый ROI-эффективный класс задач`,
        expected_effect: { basis: 'recover_decay', restore_weekly_clicks: it.mean_weekly_clicks },
      };
    });
}

/** Каннибализация: какие URL конкурируют + вердикт проверки выдачи + действие. */
function buildCannibalization({ commercial, serpVerification }) {
  const cann = (commercial && Array.isArray(commercial.cannibalization)) ? commercial.cannibalization : [];
  const verdicts = new Map();
  if (serpVerification && Array.isArray(serpVerification.items)) {
    for (const v of serpVerification.items) {
      if (v && v.query) verdicts.set(String(v.query).toLowerCase(), v);
    }
  }
  return cann.map((c) => {
    const v = verdicts.get(String(c.query || '').toLowerCase()) || null;
    const verdict = v ? v.verdict : 'inconclusive';
    let action;
    if (verdict === 'merge_recommended') {
      action = 'Объединить конкурирующие страницы в одну, настроить 301-редирект второстепенных URL на основную, собрать ссылочный вес на одной странице';
    } else if (verdict === 'keep_separate') {
      action = 'Развести интенты страниц: уточнить разные подзапросы, скорректировать заголовки и внутренние ссылки, чтобы каждая страница ранжировалась по своему кластеру';
    } else {
      action = 'Проверить, какие URL делят запрос: при дублировании интента — объединить, при разном — развести title/контент';
    }
    return {
      query: c.query,
      intent: c.intent,
      best_position: c.best_position,
      pages: c.pages,
      verdict,
      action,
      why: `Запрос «${c.query}» делят ${(c.pages || []).length} URL, лучшая позиция ${c.best_position} (ни один не в топ-3). Каннибализация распыляет релевантность и ссылочный вес`,
    };
  });
}

/** Конкретные темы статей из контент-гэпов + реверс-инжиниринга топ-страниц. */
function buildArticleTopics({ blogPlan, topPageInsights, cfg }) {
  const out = [];
  const topics = (blogPlan && Array.isArray(blogPlan.topics)) ? blogPlan.topics : [];
  for (const t of topics) {
    const ev = (Array.isArray(t.evidence) && t.evidence[0]) || {};
    out.push({
      source: 'content_gap',
      title: t.title,
      h1: t.h1,
      description: t.description,
      intent: t.intent,
      target_keywords: t.supporting_queries || (ev.query ? [ev.query] : []),
      evidence: t.evidence || [],
      why: t.intent_gap || 'Незакрытый спрос по данным GSC',
      placement: t.target_url_intent || 'Информационная статья в блоге',
      expected_effect: ev.impressions
        ? { basis: 'capture_demand', impressions_in_demand: ev.impressions }
        : null,
    });
  }
  // Дополняем рекомендациями реверс-инжиниринга (что повторить у лидеров).
  const recs = (topPageInsights && Array.isArray(topPageInsights.recommendations))
    ? topPageInsights.recommendations : [];
  for (const r of recs) {
    const text = typeof r === 'string' ? r : (r && (r.text || r.recommendation));
    if (text) out.push({ source: 'top_page_pattern', recommendation: text });
  }
  return out.slice(0, Number(cfg.maxArticleTopics) || 10);
}

/** Сводка с «железным» числом суммарного потенциала кликов. */
function summarize({ metaChanges, strikingDistance, contentRefresh, cannibalization, articleTopics }) {
  const metaExtra = metaChanges.reduce((s, m) => s + ((m.expected_effect && m.expected_effect.extra_clicks) || 0), 0);
  const sdExtra = strikingDistance.reduce((s, r) => s + (r.expected_extra_clicks || 0), 0);
  const recoverable = contentRefresh.reduce((s, r) => s + ((r.expected_effect && r.expected_effect.restore_weekly_clicks) || 0), 0);
  return {
    meta_changes_count: metaChanges.length,
    striking_distance_count: strikingDistance.length,
    content_refresh_count: contentRefresh.length,
    cannibalization_count: cannibalization.length,
    article_topics_count: articleTopics.filter((t) => t.title).length,
    est_extra_clicks: _round(metaExtra + sdExtra, 0),
    est_recoverable_weekly_clicks: _round(recoverable, 0),
  };
}

/**
 * Главный оркестратор плана действий. Детерминированно связывает срезы и,
 * если включено (cfg.autoMeta) и передан metaFn, добирает конкретные значения
 * мета-тегов (было→стало) через мета-генератор + xmlstock + парсинг.
 *
 * @param {object} args
 * @param {object} args.project
 * @param {object} args.snapshot — собранный срез (commercial, page_meta_audit,
 *   page_decay, serp_verification, blog_plan, top_page_insights)
 * @param {Array}  [args.queryPage] — матрица query×page (для привязки URL)
 * @param {Function} [args.metaFn] — pageMetaAudit.regenerateMetaForPages
 * @returns {Promise<object|null>} snapshot.action_plan
 */
async function buildActionPlan({ project, snapshot, queryPage = [], metaFn } = {}) {
  const cfg = getProjectsConfig().actionPlan;
  if (!cfg || !cfg.enabled) return null;
  try {
    const benchmark = getProjectsConfig().commercial.ctrBenchmark;
    const commercial = snapshot && snapshot.commercial;
    const pageMetaAudit = snapshot && snapshot.page_meta_audit;

    // 1) Конкретные мета-теги (LLM + SERP) для приоритетных страниц.
    let suggestedByUrl = {};
    if (cfg.autoMeta && typeof metaFn === 'function') {
      const targets = selectMetaTargets(pageMetaAudit, cfg.maxMetaTargets);
      if (targets.length > 0) {
        try {
          const regen = await metaFn({
            project,
            pages: targets.map((p) => ({
              url: p.url, reason: p.reason, before: p.before,
              lengths: p.lengths, queries: p.queries, mandatory_words: p.mandatory_words,
            })),
          });
          if (regen && Array.isArray(regen.pages)) {
            for (const rp of regen.pages) {
              if (rp && rp.url && rp.suggested) suggestedByUrl[rp.url] = rp.suggested;
            }
          }
        } catch (_) { suggestedByUrl = {}; }
      }
    }

    const metaChanges = buildMetaChanges({ pageMetaAudit, commercial, suggestedByUrl, benchmark, cfg });
    const strikingDistance = buildStrikingDistance({ commercial, benchmark, cfg, queryPage });
    const contentRefresh = buildContentRefresh({ pageDecay: snapshot && snapshot.page_decay, cfg });
    const cannibalization = buildCannibalization({
      commercial, serpVerification: snapshot && snapshot.serp_verification,
    });
    const articleTopics = buildArticleTopics({
      blogPlan: snapshot && snapshot.blog_plan,
      topPageInsights: snapshot && snapshot.top_page_insights,
      cfg,
    });

    const summary = summarize({ metaChanges, strikingDistance, contentRefresh, cannibalization, articleTopics });
    const hasAny = summary.meta_changes_count || summary.striking_distance_count
      || summary.content_refresh_count || summary.cannibalization_count || summary.article_topics_count;

    return {
      available: Boolean(hasAny),
      generated_meta: Object.keys(suggestedByUrl).length > 0,
      summary,
      meta_changes: metaChanges,
      striking_distance: strikingDistance,
      content_refresh: contentRefresh,
      cannibalization,
      article_topics: articleTopics,
    };
  } catch (err) {
    return { available: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  buildActionPlan,
  // детерминированные хелперы (тестируются без сети)
  ctrForPosition,
  expectedClicksAtPosition,
  expectedExtraClicks,
  selectMetaTargets,
  buildMetaChanges,
  buildStrikingDistance,
  buildContentRefresh,
  buildCannibalization,
  buildArticleTopics,
  summarize,
};
