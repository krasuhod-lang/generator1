'use strict';

/**
 * topPageInsights/contentProfiler — детерминированные хелперы реверс-инжиниринга
 * топовых страниц (п.3 ТЗ): выбор страниц-лидеров по показам/позиции, профиль
 * контента из markdown, привязка GSC-запросов, агрегация закономерностей и
 * формирование рекомендаций для будущих статей.
 *
 * Полностью без сети/LLM — тестируется офлайн. Парсинг страниц и оркестрация
 * живут в index.js.
 */

const { normalizeWord, STOP_WORDS } = require('../../metaTags/semantics');

/**
 * Выбирает страницы-лидеры: высокие показы И высокая позиция (низкое число).
 * Сортировка по показам убыв. Возвращает [{ url, impressions, position, ctr,
 * clicks }] длиной ≤ maxPages.
 *
 * @param {Array} topPages [{key, impressions, position, ctr, clicks}]
 * @param {object} cfg { minImpressions, maxPosition, maxPages }
 */
function selectTopPages(topPages, cfg = {}) {
  const minImpressions = Number(cfg.minImpressions) || 0;
  const maxPosition = Number(cfg.maxPosition) || 10;
  const maxPages = Number(cfg.maxPages) || 6;
  if (!Array.isArray(topPages)) return [];
  return topPages
    .filter((p) => p && p.key
      && (Number(p.impressions) || 0) >= minImpressions
      && Number(p.position) > 0
      && Number(p.position) <= maxPosition)
    .slice()
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, maxPages)
    .map((p) => ({
      url: p.key,
      impressions: p.impressions || 0,
      position: p.position || 0,
      ctr: p.ctr || 0,
      clicks: p.clicks || 0,
    }));
}

/**
 * Привязывает GSC-запросы к URL из матрицы query×page (топ по показам).
 * @returns {Array<{query, impressions, position, ctr}>}
 */
function queriesForPage(queryPage, url, limit = 12) {
  if (!Array.isArray(queryPage)) return [];
  return queryPage
    .filter((r) => r && r.page === url && r.query)
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, limit)
    .map((r) => ({
      query: r.query,
      impressions: r.impressions || 0,
      position: r.position || 0,
      ctr: r.ctr || 0,
    }));
}

function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^а-яёa-z0-9]+/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Профилирует контент страницы из markdown: объём, структура заголовков,
 * списки/таблицы/изображения, длина интро. Детерминированно.
 *
 * @param {string} markdown
 * @param {string} title
 * @returns {object} профиль
 */
function profileContent(markdown, title) {
  const md = String(markdown || '');
  const lines = md.split(/\r?\n/);

  const h1 = [];
  const h2 = [];
  const h3 = [];
  lines.forEach((ln) => {
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!m) return;
    const level = m[1].length;
    const text = m[2].trim();
    if (level === 1) h1.push(text);
    else if (level === 2) h2.push(text);
    else if (level === 3) h3.push(text);
  });

  const words = _tokenize(md);
  const wordCount = words.length;

  // Списки: строки, начинающиеся с маркера или "1." нумерации.
  const listItems = lines.filter((ln) => /^\s*([-*+]|\d+\.)\s+/.test(ln)).length;
  // Таблицы markdown: строки с разделителями "| --- |".
  const hasTables = lines.some((ln) => /\|\s*:?-{2,}/.test(ln));
  // Изображения markdown.
  const imageCount = (md.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
  // Внешние/внутренние ссылки.
  const linkCount = (md.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;

  // Интро = текст до первого H2 (в словах).
  let introWords = 0;
  for (const ln of lines) {
    if (/^#{2,6}\s+/.test(ln)) break;
    if (/^#\s+/.test(ln)) continue;
    introWords += _tokenize(ln).length;
  }

  return {
    word_count: wordCount,
    h1_count: h1.length,
    h2_count: h2.length,
    h3_count: h3.length,
    headings: h2.slice(0, 20),
    list_items: listItems,
    has_lists: listItems >= 3,
    has_tables: hasTables,
    image_count: imageCount,
    link_count: linkCount,
    intro_words: introWords,
    title_words: _tokenize(title).length,
  };
}

/**
 * Доля слов из GSC-запросов страницы, реально встречающихся в контенте
 * (по нормализованной форме). Сигнал релевантности «запрос → текст».
 *
 * @returns {{coverage_pct:number, covered:string[], missing:string[]}}
 */
function computeQueryCoverage(markdown, queries) {
  const list = Array.isArray(queries) ? queries : [];
  if (list.length === 0) return { coverage_pct: 0, covered: [], missing: [] };

  const contentStems = new Set(
    _tokenize(markdown).map((w) => normalizeWord(w)).filter(Boolean),
  );

  // Набор значимых стемов запросов (без стоп-слов/коротких/чисел).
  const queryStems = new Map(); // stem → original query word
  list.forEach((q) => {
    _tokenize(q.query).forEach((w) => {
      const s = normalizeWord(w);
      if (s.length > 2 && !STOP_WORDS.has(s) && !/^\d+$/.test(s)) {
        if (!queryStems.has(s)) queryStems.set(s, w);
      }
    });
  });

  const covered = [];
  const missing = [];
  queryStems.forEach((word, stem) => {
    if (contentStems.has(stem)) covered.push(word);
    else missing.push(word);
  });
  const total = covered.length + missing.length;
  const coveragePct = total ? Math.round((covered.length / total) * 100) : 0;
  return { coverage_pct: coveragePct, covered, missing: missing.slice(0, 20) };
}

function _median(nums) {
  const arr = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

function _avg(nums) {
  const arr = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);
}

/**
 * Агрегирует закономерности по успешно профилированным страницам: типичный
 * объём, структура, медианная позиция, доля страниц со списками/таблицами и т.п.
 *
 * @param {Array} pages — entries с полем profile (и coverage)
 * @returns {object|null}
 */
function aggregatePatterns(pages) {
  const profiled = (pages || []).filter((p) => p && p.profile);
  if (profiled.length === 0) return null;
  const profiles = profiled.map((p) => p.profile);
  const n = profiled.length;
  const share = (pred) => Math.round((profiles.filter(pred).length / n) * 100);

  return {
    pages_analyzed: n,
    median_word_count: _median(profiles.map((p) => p.word_count)),
    avg_word_count: _avg(profiles.map((p) => p.word_count)),
    median_h2_count: _median(profiles.map((p) => p.h2_count)),
    avg_intro_words: _avg(profiles.map((p) => p.intro_words)),
    median_position: _median(profiled.map((p) => p.position)),
    avg_query_coverage_pct: _avg(profiled.map((p) => (p.coverage && p.coverage.coverage_pct) || 0)),
    pct_with_lists: share((p) => p.has_lists),
    pct_with_tables: share((p) => p.has_tables),
    pct_with_images: share((p) => p.image_count > 0),
    pct_with_h1: share((p) => p.h1_count > 0),
  };
}

/**
 * Формирует детерминированные рекомендации для будущих статей на основе
 * выявленных закономерностей. ВСЕГДА возвращает ≥ minRecommendations.
 *
 * @param {object} patterns — результат aggregatePatterns
 * @param {object} cfg { minRecommendations }
 * @returns {string[]}
 */
function buildRecommendations(patterns, cfg = {}) {
  const min = Number(cfg.minRecommendations) || 5;
  const recs = [];
  if (patterns) {
    const targetWords = Math.max(patterns.median_word_count, patterns.avg_word_count);
    if (targetWords > 0) {
      recs.push(`Целевой объём статьи — ориентир ~${targetWords} слов: столько в среднем у страниц из топа по этой нише.`);
    }
    if (patterns.median_h2_count > 0) {
      recs.push(`Структурируйте материал минимум на ${patterns.median_h2_count} смысловых разделов (H2) — медиана у лидеров выдачи.`);
    }
    if (patterns.avg_intro_words > 0) {
      recs.push(`Дайте содержательное вступление (~${patterns.avg_intro_words} слов) с ответом на запрос в первом экране.`);
    }
    if (patterns.pct_with_lists >= 50) {
      recs.push(`Используйте списки: ${patterns.pct_with_lists}% топовых страниц содержат маркированные/нумерованные перечни.`);
    }
    if (patterns.pct_with_tables >= 40) {
      recs.push(`Добавьте сравнительные таблицы — они есть у ${patterns.pct_with_tables}% лидеров выдачи.`);
    }
    if (patterns.pct_with_images >= 50) {
      recs.push(`Иллюстрируйте материал: ${patterns.pct_with_images}% топовых страниц используют изображения.`);
    }
    if (patterns.avg_query_coverage_pct > 0) {
      recs.push(`Покрывайте семантику запросов в тексте: у лидеров в среднем ${patterns.avg_query_coverage_pct}% слов из поисковых запросов присутствуют в контенте.`);
    }
  }

  // Страховочный добор универсальными SEO-рекомендациями до минимума.
  const fallback = [
    'Закрывайте интент запроса в первом абзаце — это повышает удержание и поведенческие факторы.',
    'Добавляйте уникальную экспертизу (E-E-A-T): авторство, опыт, источники, кейсы.',
    'Используйте семантически связанные подзаголовки (LSI) под реальные поисковые запросы.',
    'Обновляйте и расширяйте контент регулярно — свежесть влияет на позицию.',
    'Прорабатывайте перелинковку на тематически близкие страницы раздела.',
  ];
  let fi = 0;
  while (recs.length < min && fi < fallback.length) {
    if (!recs.includes(fallback[fi])) recs.push(fallback[fi]);
    fi += 1;
  }
  return recs.slice(0, Math.max(min, recs.length));
}

/**
 * Детерминированные наблюдения «почему страница в топе» для одной страницы.
 * @param {object} entry { position, impressions, profile, coverage, overspam }
 * @returns {string[]}
 */
function explainRanking(entry) {
  const out = [];
  const pr = entry && entry.profile;
  if (!pr) return out;
  if (entry.position && entry.position <= 3) {
    out.push(`Высокая позиция (${entry.position}) при ${entry.impressions} показах — сильный сигнал релевантности.`);
  }
  if (pr.word_count >= 1500) out.push(`Большой объём контента (${pr.word_count} слов) — полнота раскрытия темы.`);
  if (pr.h2_count >= 4) out.push(`Глубокая структура (${pr.h2_count} разделов H2).`);
  if (pr.has_lists) out.push('Списки улучшают читаемость и попадание в расширенные сниппеты.');
  if (pr.has_tables) out.push('Сравнительные таблицы повышают полезность.');
  if (pr.image_count > 0) out.push(`Визуальный контент (${pr.image_count} изображ.).`);
  if (entry.coverage && entry.coverage.coverage_pct >= 60) {
    out.push(`Высокое покрытие семантики запросов (${entry.coverage.coverage_pct}%).`);
  }
  // КФ6/переспам — вывод делаем ТОЛЬКО на основе уже распарсенного контента.
  if (entry.overspam && entry.overspam.level === 'risk') {
    out.push(`⚠ Риск переспама (КФ6): score ${entry.overspam.overspam_score}/100 — страница в топе ВОПРЕКИ переоптимизации, её не следует копировать как эталон.`);
  }
  return out;
}

// ── КФ6 / переспам ───────────────────────────────────────────────────

/**
 * Считает число точных (подстрочных) вхождений фразы в текст. Детерминированно.
 */
function _countPhrase(haystack, phrase) {
  const h = String(haystack || '').toLowerCase();
  const p = String(phrase || '').toLowerCase().trim();
  if (!p || p.length < 3) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(p, idx)) !== -1) {
    count += 1;
    idx += p.length;
  }
  return count;
}

/**
 * Профиль переспама (КФ6) одной страницы — детерминированный анализ
 * переоптимизации по УЖЕ РАСПАРСЕННОМУ контенту: плотность ключей из реальных
 * GSC-запросов, повтор точных фраз, переспам title. Выводы о переспаме
 * делаются исключительно из текста страницы, а не из метрик выдачи.
 *
 * @param {string} markdown — распарсенный контент страницы
 * @param {string} title
 * @param {Array} queries — [{query}] (GSC-запросы страницы)
 * @param {object} cfg — getProjectsConfig().topPageInsights.overspam
 * @returns {object} { overspam_score 0..100, level, signals[], top_terms[] }
 */
function profileOverspam(markdown, title, queries, cfg = {}) {
  const opts = {
    maxTermDensityPct: Number(cfg.maxTermDensityPct) || 3.5,
    watchTermDensityPct: Number(cfg.watchTermDensityPct) || 2.5,
    maxPhraseRepeat: Number(cfg.maxPhraseRepeat) || 4,
    minWordsForDensity: Number(cfg.minWordsForDensity) || 80,
    riskScore: Number(cfg.riskScore) || 60,
    watchScore: Number(cfg.watchScore) || 35,
  };
  const md = String(markdown || '');
  const words = _tokenize(md);
  const total = words.length;
  if (total < opts.minWordsForDensity) {
    return {
      overspam_score: 0,
      level: 'unknown',
      signals: [`Недостаточно текста для оценки переспама (${total} слов).`],
      top_terms: [],
      max_density_pct: 0,
      max_phrase: null,
      title_repeat: 0,
      words: total,
    };
  }

  // Частоты нормализованных основ контента.
  const freq = new Map();
  words.forEach((w) => {
    const s = normalizeWord(w);
    if (s) freq.set(s, (freq.get(s) || 0) + 1);
  });

  // Значимые основы из GSC-запросов (без стоп-слов/коротких/чисел).
  const list = Array.isArray(queries) ? queries : [];
  const queryStems = new Map(); // stem → original word
  list.forEach((q) => {
    _tokenize(q && q.query != null ? q.query : q).forEach((w) => {
      const s = normalizeWord(w);
      if (s.length > 2 && !STOP_WORDS.has(s) && !/^\d+$/.test(s) && !queryStems.has(s)) {
        queryStems.set(s, w);
      }
    });
  });

  const terms = [];
  queryStems.forEach((word, stem) => {
    const count = freq.get(stem) || 0;
    const density = total ? (count / total) * 100 : 0;
    terms.push({ term: word, count, density_pct: Math.round(density * 100) / 100 });
  });
  terms.sort((a, b) => b.density_pct - a.density_pct);
  const maxDensity = terms.length ? terms[0].density_pct : 0;

  // Повтор точной многословной фразы запроса.
  let maxPhrase = { phrase: '', count: 0 };
  list.forEach((q) => {
    const phrase = String(q && q.query != null ? q.query : q || '').trim();
    if (phrase.split(/\s+/).filter(Boolean).length < 2) return;
    const c = _countPhrase(md, phrase);
    if (c > maxPhrase.count) maxPhrase = { phrase, count: c };
  });

  // Переспам title: повтор основы ключа в заголовке.
  const titleFreq = new Map();
  _tokenize(title).forEach((w) => {
    const s = normalizeWord(w);
    if (s && queryStems.has(s)) titleFreq.set(s, (titleFreq.get(s) || 0) + 1);
  });
  let titleRepeat = 0;
  titleFreq.forEach((c) => { if (c > titleRepeat) titleRepeat = c; });

  let score = 0;
  const signals = [];
  const densityRatio = opts.maxTermDensityPct > 0 ? maxDensity / opts.maxTermDensityPct : 0;
  score += Math.min(densityRatio, 1.6) * 40;
  if (terms.length && maxDensity >= opts.maxTermDensityPct) {
    signals.push(`Высокая плотность ключа «${terms[0].term}» — ${maxDensity}% (порог ${opts.maxTermDensityPct}%).`);
  } else if (terms.length && maxDensity >= opts.watchTermDensityPct) {
    signals.push(`Повышенная плотность ключа «${terms[0].term}» — ${maxDensity}%.`);
  }
  if (maxPhrase.count > opts.maxPhraseRepeat) {
    const over = maxPhrase.count - opts.maxPhraseRepeat;
    score += Math.min(over, 6) * 6;
    signals.push(`Точное вхождение «${maxPhrase.phrase}» повторяется ${maxPhrase.count} раз (порог ${opts.maxPhraseRepeat}).`);
  }
  if (titleRepeat >= 2) {
    score += 12;
    signals.push(`Ключ повторяется в title ${titleRepeat} раза — переспам заголовка.`);
  }
  score = Math.round(Math.max(0, Math.min(100, score)));

  let level = 'ok';
  if (score >= opts.riskScore) level = 'risk';
  else if (score >= opts.watchScore) level = 'watch';
  if (level === 'ok' && signals.length === 0) {
    signals.push('Явных признаков переспама (КФ6) не выявлено.');
  }

  return {
    overspam_score: score,
    level,
    signals,
    top_terms: terms.slice(0, 8),
    max_density_pct: maxDensity,
    max_phrase: maxPhrase.count > 0 ? maxPhrase : null,
    title_repeat: titleRepeat,
    words: total,
  };
}

/**
 * Агрегирует переспам по набору страниц: распределение по уровням и список
 * рискованных URL. @param {Array} pages — entries с полем overspam.
 */
function aggregateOverspam(pages) {
  const scored = (pages || []).filter((p) => p && p.overspam && p.overspam.level && p.overspam.level !== 'unknown');
  if (scored.length === 0) return null;
  const byLevel = { ok: 0, watch: 0, risk: 0 };
  const risky = [];
  scored.forEach((p) => {
    const lvl = p.overspam.level;
    if (byLevel[lvl] != null) byLevel[lvl] += 1;
    if (lvl === 'risk' || lvl === 'watch') {
      risky.push({ url: p.url, level: lvl, overspam_score: p.overspam.overspam_score, signals: p.overspam.signals });
    }
  });
  risky.sort((a, b) => (b.overspam_score || 0) - (a.overspam_score || 0));
  return {
    pages_scored: scored.length,
    by_level: byLevel,
    avg_score: _avg(scored.map((p) => p.overspam.overspam_score)),
    risky_pages: risky.slice(0, 10),
  };
}

/**
 * Топ-10 дифференциал: что есть у страниц из топа, чего НЕТ (или заметно меньше)
 * у остальных страниц (с показами, но позицией хуже топа). Детерминированно
 * сравнивает усреднённые профили двух групп. @returns {object}
 */
function buildTopDifferential(topEntries, restEntries) {
  const top = (topEntries || []).filter((p) => p && p.profile);
  const rest = (restEntries || []).filter((p) => p && p.profile);
  if (top.length === 0 || rest.length === 0) {
    return {
      available: false,
      reason: top.length === 0 ? 'no_top' : 'no_comparison',
      top_count: top.length,
      rest_count: rest.length,
    };
  }
  const metric = (arr, fn) => _avg(arr.map(fn));
  const pct = (arr, pred) => Math.round((arr.filter(pred).length / arr.length) * 100);

  const dims = [
    { label: 'Объём текста (слов)', top: metric(top, (p) => p.profile.word_count), rest: metric(rest, (p) => p.profile.word_count) },
    { label: 'Разделов H2', top: metric(top, (p) => p.profile.h2_count), rest: metric(rest, (p) => p.profile.h2_count) },
    { label: 'Покрытие семантики запросов, %', top: metric(top, (p) => (p.coverage && p.coverage.coverage_pct) || 0), rest: metric(rest, (p) => (p.coverage && p.coverage.coverage_pct) || 0) },
    { label: 'Доля страниц с таблицами, %', top: pct(top, (p) => p.profile.has_tables), rest: pct(rest, (p) => p.profile.has_tables) },
    { label: 'Доля страниц со списками, %', top: pct(top, (p) => p.profile.has_lists), rest: pct(rest, (p) => p.profile.has_lists) },
    { label: 'Изображений на странице', top: metric(top, (p) => p.profile.image_count), rest: metric(rest, (p) => p.profile.image_count) },
    { label: 'Объём вступления (слов)', top: metric(top, (p) => p.profile.intro_words), rest: metric(rest, (p) => p.profile.intro_words) },
  ];

  const advantages = [];
  dims.forEach((d) => {
    const delta = d.top - d.rest;
    if (delta <= 0) return;
    const rel = d.rest > 0 ? delta / d.rest : 1;
    if (rel >= 0.15 || (d.rest === 0 && d.top > 0)) {
      advantages.push({
        factor: d.label,
        top_value: d.top,
        rest_value: d.rest,
        delta: Math.round(delta * 100) / 100,
        rel_pct: Math.round(rel * 100),
      });
    }
  });
  advantages.sort((a, b) => b.rel_pct - a.rel_pct);

  const summary = advantages.map((a) => (a.rest_value === 0
    ? `У страниц из топа есть «${a.factor}» (${a.top_value}), а у остальных — практически нет.`
    : `${a.factor}: у топа ${a.top_value} против ${a.rest_value} у остальных (+${a.rel_pct}%).`));

  return {
    available: true,
    top_count: top.length,
    rest_count: rest.length,
    dimensions: dims.map((d) => ({ factor: d.label, top_value: d.top, rest_value: d.rest })),
    advantages,
    summary,
  };
}

module.exports = {
  selectTopPages,
  queriesForPage,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
  profileOverspam,
  aggregateOverspam,
  buildTopDifferential,
};
