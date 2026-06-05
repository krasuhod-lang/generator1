'use strict';

/**
 * projects/rankingFactors.js — детерминированный аудит важных факторов
 * ранжирования: «чего не хватает для большего роста». Работает поверх уже
 * собранного снапшота (GSC + Яндекс) без дополнительных сетевых вызовов и без
 * LLM. Результат:
 *   • подаётся в LLM-сводку (synthesisAnalyzer) как опорные сигналы;
 *   • рендерится отдельной карточкой RankingFactorsCard на фронте;
 *   • даёт честный fallback, если LLM недоступен.
 *
 * Каждый фактор → { key, label, group, weight, status, finding, action,
 * priority }. status: 'ok' | 'gap' | 'critical' | 'unknown'.
 *
 * Полностью graceful: любые отсутствующие срезы → status:'unknown', функция
 * никогда не бросает.
 */

const { getProjectsConfig } = require('./config');

const STATUS_PRIORITY = { critical: 'high', gap: 'medium', ok: 'info', unknown: 'info' };

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _arr(v) { return Array.isArray(v) ? v : []; }

/**
 * Оценивает один фактор. Возвращает { status, finding, action } или null
 * (тогда статус остаётся 'unknown'). gsc/ydx — снапшоты источников.
 */
function _evaluateFactor(key, gsc, ydx) {
  const g = gsc || {};
  switch (key) {
    case 'ctr': {
      const c = g.commercial;
      if (!c || !c.available) return null;
      const anomalies = _arr(c.ctr_anomalies);
      if (anomalies.length >= 5) {
        return {
          status: 'critical',
          finding: `${anomalies.length} запросов с CTR ниже ожидаемого для своей позиции — сниппеты недобирают клики.`,
          action: 'Переписать title/description под выгоду и интент, внедрить rich snippets (rating/price/FAQ) на проблемных страницах.',
        };
      }
      if (anomalies.length > 0) {
        return {
          status: 'gap',
          finding: `${anomalies.length} CTR-аномалий: позиция есть, а кликов мало.`,
          action: 'Усилить сниппеты топ-страниц (title/description, structured data).',
        };
      }
      return { status: 'ok', finding: 'Явных CTR-аномалий не обнаружено.', action: 'Поддерживать сниппеты; точечно A/B-тестировать title.' };
    }
    case 'striking': {
      const c = g.commercial;
      const sd = c && c.available ? _arr(c.striking_distance) : [];
      if (sd.length >= 3) {
        return {
          status: 'gap',
          finding: `${sd.length} коммерческих запросов в зоне быстрого роста (позиции 3–20) — близко к топу.`,
          action: 'Дотянуть эти страницы: расширить контент под интент, перелинковка, ссылки, усиление релевантности.',
        };
      }
      if (sd.length > 0) {
        return { status: 'gap', finding: `${sd.length} запрос(а) у входа в топ.`, action: 'Приоритизировать дотягивание страниц у входа в топ.' };
      }
      return null;
    }
    case 'cannibalization': {
      const c = g.commercial;
      if (!c || !c.available) return null;
      const cann = _arr(c.cannibalization);
      if (cann.length >= 3) {
        return {
          status: 'critical',
          finding: `${cann.length} запросов делят несколько URL — сигнал размывается, ни один не выходит в топ-3.`,
          action: 'Склейка/канонизация дублей, перелинковка на главный URL, разведение интентов страниц.',
        };
      }
      if (cann.length > 0) {
        return { status: 'gap', finding: `${cann.length} случай(ев) каннибализации.`, action: 'Определить главный URL и перелинковать конкурирующие страницы.' };
      }
      return { status: 'ok', finding: 'Каннибализация запросов не выявлена.', action: 'Контролировать при росте числа страниц.' };
    }
    case 'page_decay': {
      const pd = g.page_decay;
      if (!pd || !pd.available) return null;
      const decaying = _num(pd.decaying_count);
      if (decaying >= 3) {
        return {
          status: 'critical',
          finding: `${decaying} страниц теряют трафик (нисходящий тренд кликов).`,
          action: 'Content refresh: обновить данные, добавить недостающие секции/семантику, освежить дату и перелинковку.',
        };
      }
      if (decaying > 0) {
        return { status: 'gap', finding: `${decaying} страниц(ы) деградируют по трафику.`, action: 'Запланировать обновление деградирующих страниц.' };
      }
      return { status: 'ok', finding: 'Заметной деградации страниц нет.', action: 'Поддерживать актуальность ключевых страниц.' };
    }
    case 'eat': {
      const eat = g.eat;
      if (!eat || eat.available === false || eat.avg_score == null) return null;
      const score = _num(eat.avg_score);
      if (score < 50) {
        return {
          status: 'critical',
          finding: `Средний E-E-A-T ${score}/100 — низкий уровень экспертности и доверия.`,
          action: 'Добавить авторов с регалиями, кейсы/сертификаты, отзывы, контакты и юр.инфо по шаблонам страниц.',
        };
      }
      if (score < 70) {
        return { status: 'gap', finding: `Средний E-E-A-T ${score}/100 — есть куда расти.`, action: 'Усилить блоки доверия на слабых шаблонах (автор, отзывы, гарантии).' };
      }
      return { status: 'ok', finding: `E-E-A-T ${score}/100 — приемлемо.`, action: 'Поддерживать актуальность экспертных блоков.' };
    }
    case 'schema': {
      const sa = g.schema_audit;
      if (!sa || sa.available === false) return null;
      const missing = sa.summary ? _num(sa.summary.missing_types) : _arr(sa.items).reduce((s, it) => s + _arr(it.missing_types).length, 0);
      if (missing >= 3) {
        return {
          status: 'gap',
          finding: `Не хватает ${missing} типов Schema.org на ключевых шаблонах.`,
          action: 'Внедрить недостающие JSON-LD (Product/Offer/FAQPage/BreadcrumbList/Article) — важно и для AI Overviews.',
        };
      }
      if (missing > 0) {
        return { status: 'gap', finding: `Пропущено ${missing} тип(а) микроразметки.`, action: 'Добавить недостающую разметку на приоритетные шаблоны.' };
      }
      return { status: 'ok', finding: 'Базовая микроразметка присутствует.', action: 'Поддерживать корректность полей разметки.' };
    }
    case 'links': {
      const la = g.link_audit;
      if (!la || la.available === false) return null;
      const recs = _arr(la.recommendations).length;
      const inferred = la.data_source === 'inferred';
      if (recs > 0) {
        return {
          status: inferred ? 'gap' : 'gap',
          finding: inferred
            ? `Данных GSC по ссылкам нет; по контенту/SERP сформировано ${recs} гипотез линкбилдинга.`
            : `Ссылочный профиль требует усиления: ${recs} рекомендаций по анкорам/донорам.`,
          action: 'Закупать ссылки на коммерческие цели без бэклинков, разнообразить анкоры, избегать переоптимизации.',
        };
      }
      return null;
    }
    case 'mobile': {
      const bd = g.breakdowns;
      const devices = bd && _arr(bd.device);
      if (!devices || !devices.length) return null;
      const total = devices.reduce((s, d) => s + _num(d.clicks), 0) || 1;
      const mobile = devices.find((d) => /mobile/i.test(String(d.key || '')));
      const desktop = devices.find((d) => /desktop/i.test(String(d.key || '')));
      const mobileShare = mobile ? Math.round((_num(mobile.clicks) / total) * 100) : 0;
      if (mobile && desktop && _num(mobile.position) - _num(desktop.position) > 2) {
        return {
          status: 'gap',
          finding: `Мобильная позиция заметно хуже десктопа (${_num(mobile.position)} vs ${_num(desktop.position)}); доля мобильных кликов ${mobileShare}%.`,
          action: 'Проверить mobile UX/скорость (Core Web Vitals), адаптивность, mobile-first вёрстку.',
        };
      }
      return { status: 'ok', finding: `Доля мобильного трафика ${mobileShare}%, явного провала позиций нет.`, action: 'Следить за Core Web Vitals на мобильных.' };
    }
    case 'geo_aeo': {
      const geo = g.geo_aeo;
      if (!geo || geo.available === false) return null;
      const aeo = geo.aeo || {};
      const missingSchema = _arr(aeo.missing_schema).length;
      const recs = _arr(aeo.recommendations).length;
      if (missingSchema > 0 || recs > 0) {
        return {
          status: 'gap',
          finding: 'Сайт не полностью готов к нейровыдаче (AI Overviews / SGE / Perplexity).',
          action: 'AEO-формат ответов (TL;DR, списки, явные сущности), FAQPage/HowTo/Speakable, hreflang, sameAs/mentions.',
        };
      }
      return { status: 'ok', finding: 'Базовая готовность к нейровыдаче есть.', action: 'Поддерживать AEO-формат на новых страницах.' };
    }
    case 'content_gaps': {
      const bp = g.blog_plan;
      if (!bp || bp.available === false) return null;
      const topics = _arr(bp.topics).length;
      if (topics >= 3) {
        return {
          status: 'gap',
          finding: `Найдено ${topics} непокрытых тем (контентные дыры по спросу).`,
          action: 'Запустить публикации по плану блога: закрыть инфо-запросы и вести трафик на коммерческие разделы.',
        };
      }
      if (topics > 0) {
        return { status: 'gap', finding: `${topics} тем(ы) для покрытия спроса.`, action: 'Подготовить статьи по выявленным темам.' };
      }
      return null;
    }
    case 'relevance':
    case 'content_depth': {
      const tpi = g.top_page_insights;
      if (!tpi) return null;
      // Реверс-инжиниринг лидеров есть → даём обобщённую рекомендацию.
      return {
        status: 'gap',
        finding: 'Есть закономерности лидеров топа (объём/структура/семантика), не растиражированные на остальные страницы.',
        action: 'Привести структуру и полноту контента остальных страниц к паттернам лидеров (H2/H3, списки/таблицы, покрытие семантики).',
      };
    }
    default:
      return null;
  }
}

/**
 * Главный билдер. Возвращает { available, factors[], summary, score }.
 * @param {object} gscSnapshot — снапшот GSC (collectSnapshot.snapshot)
 * @param {object|null} ydxSnapshot — снапшот Яндекса (опционально)
 */
function buildRankingFactors(gscSnapshot, ydxSnapshot) {
  const cfg = getProjectsConfig().rankingFactors;
  if (!cfg || !cfg.enabled) return { available: false, reason: 'feature_disabled' };
  const catalog = _arr(cfg.factors);

  const factors = catalog.map((f) => {
    let evald = null;
    try { evald = _evaluateFactor(f.key, gscSnapshot, ydxSnapshot); } catch (_) { evald = null; }
    const status = (evald && evald.status) || 'unknown';
    return {
      key: f.key,
      label: f.label,
      group: f.group || 'other',
      weight: _num(f.weight) || 1,
      status,
      priority: STATUS_PRIORITY[status] || 'info',
      finding: (evald && evald.finding) || 'Недостаточно данных для оценки этого фактора.',
      action: (evald && evald.action) || '',
    };
  });

  // Взвешенный score готовности: ok=1, gap=0.5, critical=0, unknown — не учитываем.
  let wSum = 0;
  let wScore = 0;
  for (const f of factors) {
    if (f.status === 'unknown') continue;
    const w = f.weight;
    wSum += w;
    wScore += w * (f.status === 'ok' ? 1 : f.status === 'gap' ? 0.5 : 0);
  }
  const score = wSum ? Math.round((wScore / wSum) * 100) : null;

  const counts = factors.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] || 0) + 1;
    return acc;
  }, {});

  // Топ-точки роста: critical и gap, отсортированные по весу убыв.
  const gaps = factors
    .filter((f) => f.status === 'critical' || f.status === 'gap')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'critical' ? -1 : 1;
      return b.weight - a.weight;
    });

  const summary = _buildSummary(score, counts, gaps);

  return {
    available: true,
    score,
    counts,
    factors,
    gaps: gaps.map((f) => ({ key: f.key, label: f.label, status: f.status, finding: f.finding, action: f.action })),
    summary,
  };
}

function _buildSummary(score, counts, gaps) {
  const crit = counts.critical || 0;
  const gap = counts.gap || 0;
  const parts = [];
  if (score != null) parts.push(`Готовность по факторам ранжирования: ${score}/100.`);
  if (crit) parts.push(`Критичных зон: ${crit}.`);
  if (gap) parts.push(`Зон роста: ${gap}.`);
  if (gaps.length) {
    const top = gaps.slice(0, 3).map((f) => f.label).join('; ');
    parts.push(`Главное для роста: ${top}.`);
  } else if (score != null) {
    parts.push('Явных пробелов по доступным данным не выявлено.');
  }
  return parts.join(' ');
}

/**
 * Компактные строки для подмешивания в LLM-промпт сводки.
 * @returns {string[]}
 */
function renderRankingFactorsLines(rf) {
  if (!rf || !rf.available) return [];
  const lines = [
    '',
    '[ФАКТОРЫ РАНЖИРОВАНИЯ — детерминированный аудит «чего не хватает для роста»]',
    rf.summary,
    'Статусы по факторам (factor | status | что нашли | действие):',
  ];
  for (const f of rf.factors) {
    lines.push(`- ${f.label} | ${f.status} | ${f.finding}${f.action ? ` | ${f.action}` : ''}`);
  }
  return lines;
}

module.exports = { buildRankingFactors, renderRankingFactorsLines, _evaluateFactor };
