'use strict';

/**
 * projects/sourceComparison.js — детерминированное сопоставление данных двух
 * поисковых систем по проекту: Google Search Console (gsc) и Яндекс.Вебмастер
 * (yandex). Сравнивает суммарные показатели и пересечение поисковых запросов,
 * считает дельты позиций и формирует список практических рекомендаций по
 * улучшению. Чистая функция без сети — её результат показывается во вкладке
 * «Сравнение» и может подаваться в LLM-аналитику.
 *
 * Вход (оба источника опциональны — сравниваем то, что есть):
 *   gsc:    { totals:{clicks,impressions,ctr,position}, topQueries:[{key,clicks,impressions,ctr,position}] }
 *   yandex: { totals:{...}, topQueries:[...] }
 *
 * Выход: { totals, queries:{overlap,onlyGoogle,onlyYandex}, recommendations, summary }
 */

function _num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function _round(n, p = 2) { const f = 10 ** p; return Math.round((_num(n)) * f) / f; }
function _normKey(k) { return String(k == null ? '' : k).trim().toLowerCase(); }

function _totals(t) {
  t = t || {};
  return {
    clicks: _num(t.clicks),
    impressions: _num(t.impressions),
    ctr: _num(t.ctr),
    position: _num(t.position),
  };
}

/** Индексирует topQueries по нормализованному ключу запроса. */
function _indexQueries(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((q) => {
    if (!q) return;
    const key = _normKey(q.key);
    if (!key) return;
    // При дублях суммируем клики/показы, позицию усредняем взвешенно по показам.
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        key: String(q.key).trim(),
        clicks: _num(q.clicks),
        impressions: _num(q.impressions),
        ctr: _num(q.ctr),
        position: _num(q.position),
      });
    } else {
      const imp = prev.impressions + _num(q.impressions);
      prev.position = imp
        ? _round((prev.position * prev.impressions + _num(q.position) * _num(q.impressions)) / imp, 2)
        : prev.position;
      prev.clicks += _num(q.clicks);
      prev.impressions = imp;
      prev.ctr = imp ? _round((prev.clicks / imp) * 100, 2) : prev.ctr;
    }
  });
  return map;
}

function _shareRow(label, g, y, key, asPercent) {
  const gv = _num(g[key]);
  const yv = _num(y[key]);
  const total = gv + yv;
  return {
    metric: label,
    google: _round(gv),
    yandex: _round(yv),
    google_share: total ? _round((gv / total) * 100, 1) : 0,
    yandex_share: total ? _round((yv / total) * 100, 1) : 0,
    is_percent: Boolean(asPercent),
  };
}

/**
 * @param {Object} gsc     данные Google (или null/пусто)
 * @param {Object} yandex  данные Яндекса (или null/пусто)
 * @param {Object} [opts]
 * @param {number} [opts.positionGap=3]   значимая разница средней позиции
 * @param {number} [opts.minImpressions=10] порог показов, чтобы запрос учитывался
 * @param {number} [opts.maxRecommendations=20]
 */
function compareSources(gsc, yandex, opts = {}) {
  const positionGap = _num(opts.positionGap) || 3;
  const minImpr = _num(opts.minImpressions) || 10;
  const maxRecs = _num(opts.maxRecommendations) || 20;

  const hasG = Boolean(gsc && (gsc.totals || gsc.topQueries));
  const hasY = Boolean(yandex && (yandex.totals || yandex.topQueries));

  const gTotals = _totals(gsc && gsc.totals);
  const yTotals = _totals(yandex && yandex.totals);

  const totals = [
    _shareRow('Клики', gTotals, yTotals, 'clicks', false),
    _shareRow('Показы', gTotals, yTotals, 'impressions', false),
    { metric: 'CTR, %', google: _round(gTotals.ctr), yandex: _round(yTotals.ctr), is_percent: true },
    { metric: 'Средняя позиция', google: _round(gTotals.position), yandex: _round(yTotals.position), is_percent: false },
  ];

  const gMap = _indexQueries(gsc && gsc.topQueries);
  const yMap = _indexQueries(yandex && yandex.topQueries);

  const overlap = [];
  const onlyGoogle = [];
  const onlyYandex = [];

  gMap.forEach((g, key) => {
    if (yMap.has(key)) {
      const y = yMap.get(key);
      overlap.push({
        query: g.key,
        google: { clicks: g.clicks, impressions: g.impressions, ctr: g.ctr, position: g.position },
        yandex: { clicks: y.clicks, impressions: y.impressions, ctr: y.ctr, position: y.position },
        position_delta: _round(g.position - y.position, 2), // >0 → в Яндексе позиция лучше
      });
    } else if (g.impressions >= minImpr) {
      onlyGoogle.push(g);
    }
  });
  yMap.forEach((y, key) => {
    if (!gMap.has(key) && y.impressions >= minImpr) onlyYandex.push(y);
  });

  overlap.sort((a, b) => Math.abs(b.position_delta) - Math.abs(a.position_delta));
  onlyGoogle.sort((a, b) => b.impressions - a.impressions);
  onlyYandex.sort((a, b) => b.impressions - a.impressions);

  const recommendations = _buildRecommendations({
    hasG, hasY, gTotals, yTotals, overlap, onlyGoogle, onlyYandex, positionGap, minImpr,
  }).slice(0, maxRecs);

  return {
    has_google: hasG,
    has_yandex: hasY,
    totals,
    queries: {
      overlap_count: overlap.length,
      only_google_count: onlyGoogle.length,
      only_yandex_count: onlyYandex.length,
      overlap: overlap.slice(0, 50),
      only_google: onlyGoogle.slice(0, 30),
      only_yandex: onlyYandex.slice(0, 30),
    },
    recommendations,
    summary: _summary({ hasG, hasY, gTotals, yTotals, overlap, onlyGoogle, onlyYandex }),
  };
}

function _rec(priority, title, detail, items) {
  return { priority, title, detail, items: items || [] };
}

function _buildRecommendations(ctx) {
  const { hasG, hasY, gTotals, yTotals, overlap, onlyGoogle, onlyYandex, positionGap, minImpr } = ctx;
  const recs = [];

  if (!hasG && !hasY) {
    recs.push(_rec('info', 'Нет данных для сравнения',
      'Подключите Google Search Console и Яндекс.Вебмастер, чтобы сопоставить трафик из обеих поисковых систем.'));
    return recs;
  }
  if (hasG && !hasY) {
    recs.push(_rec('high', 'Подключите Яндекс.Вебмастер',
      'Подключены только данные Google. Добавьте Яндекс.Вебмастер, чтобы оценить долю Яндекса (в Рунете она часто 40–60%) и найти упущенный трафик.'));
    return recs;
  }
  if (!hasG && hasY) {
    recs.push(_rec('high', 'Подключите Google Search Console',
      'Подключены только данные Яндекса. Добавьте Google Search Console для полной картины видимости в обеих системах.'));
    return recs;
  }

  // Перекос трафика между системами.
  const totalClicks = gTotals.clicks + yTotals.clicks;
  if (totalClicks > 0) {
    const yShare = (yTotals.clicks / totalClicks) * 100;
    if (yShare < 25) {
      recs.push(_rec('high', 'Слабые позиции в Яндексе',
        `Яндекс приносит лишь ${_round(yShare, 1)}% кликов. Усильте факторы ранжирования Яндекса: коммерческие и поведенческие сигналы, региональность (Яндекс.Бизнес), скорость и полнота ответа.`));
    } else if (yShare > 75) {
      recs.push(_rec('high', 'Слабые позиции в Google',
        `Google приносит лишь ${_round(100 - yShare, 1)}% кликов. Проработайте E-E-A-T, ссылочный профиль и техническое SEO под Google.`));
    }
  }

  // CTR-разрыв при сопоставимых показах.
  if (gTotals.impressions > 0 && yTotals.impressions > 0) {
    const ctrGap = gTotals.ctr - yTotals.ctr;
    if (ctrGap >= 1.5) {
      recs.push(_rec('medium', 'CTR в Яндексе ниже, чем в Google',
        `Средний CTR в Google ${_round(gTotals.ctr, 2)}% против ${_round(yTotals.ctr, 2)}% в Яндексе. Оптимизируйте title/description под сниппеты Яндекса, добавьте быстрые ссылки и фавикон.`));
    } else if (ctrGap <= -1.5) {
      recs.push(_rec('medium', 'CTR в Google ниже, чем в Яндексе',
        `Средний CTR в Яндексе ${_round(yTotals.ctr, 2)}% против ${_round(gTotals.ctr, 2)}% в Google. Перепишите мета-теги под сниппеты Google и проверьте структурированные данные.`));
    }
  }

  // Запросы, где одна система ранжирует заметно лучше другой.
  const betterInGoogle = overlap.filter((o) => o.position_delta <= -positionGap
    && o.google.position > 0 && o.yandex.position > 0);
  const betterInYandex = overlap.filter((o) => o.position_delta >= positionGap
    && o.google.position > 0 && o.yandex.position > 0);

  if (betterInYandex.length) {
    recs.push(_rec('high', 'Запросы проседают в Google (хорошо ранжируются в Яндексе)',
      `${betterInYandex.length} запрос(ов) в Яндексе на ${positionGap}+ позиций выше, чем в Google — точечная точка роста для Google.`,
      betterInYandex.slice(0, 10).map((o) => ({
        query: o.query, google_position: o.google.position, yandex_position: o.yandex.position,
      }))));
  }
  if (betterInGoogle.length) {
    recs.push(_rec('high', 'Запросы проседают в Яндексе (хорошо ранжируются в Google)',
      `${betterInGoogle.length} запрос(ов) в Google на ${positionGap}+ позиций выше, чем в Яндексе — точечная точка роста для Яндекса.`,
      betterInGoogle.slice(0, 10).map((o) => ({
        query: o.query, google_position: o.google.position, yandex_position: o.yandex.position,
      }))));
  }

  // Запросы, которые есть только в одной системе (упущенный спрос).
  if (onlyGoogle.length) {
    recs.push(_rec('medium', 'Спрос есть в Google, но не виден в Яндексе',
      `${onlyGoogle.length} запрос(ов) с показами в Google отсутствуют в топе Яндекса (≥${minImpr} показов). Проверьте индексацию и релевантность этих страниц в Яндексе.`,
      onlyGoogle.slice(0, 10).map((q) => ({ query: q.key, google_impressions: q.impressions }))));
  }
  if (onlyYandex.length) {
    recs.push(_rec('medium', 'Спрос есть в Яндексе, но не виден в Google',
      `${onlyYandex.length} запрос(ов) с показами в Яндексе отсутствуют в топе Google (≥${minImpr} показов). Усильте контент и ссылки под эти запросы для Google.`,
      onlyYandex.slice(0, 10).map((q) => ({ query: q.key, yandex_impressions: q.impressions }))));
  }

  if (!recs.length) {
    recs.push(_rec('info', 'Системы сбалансированы',
      'Существенных расхождений между Google и Яндексом не обнаружено. Продолжайте наращивать контент и ссылки равномерно под обе системы.'));
  }
  return recs;
}

function _summary(ctx) {
  const { hasG, hasY, gTotals, yTotals, overlap } = ctx;
  if (!hasG || !hasY) {
    return 'Для полноценного сравнения подключите обе системы — Google Search Console и Яндекс.Вебмастер.';
  }
  const totalClicks = gTotals.clicks + yTotals.clicks;
  const yShare = totalClicks ? _round((yTotals.clicks / totalClicks) * 100, 1) : 0;
  const gShare = totalClicks ? _round((gTotals.clicks / totalClicks) * 100, 1) : 0;
  return `Google: ${gShare}% кликов, Яндекс: ${yShare}% кликов. Совпадающих запросов: ${overlap.length}.`;
}

module.exports = { compareSources };
