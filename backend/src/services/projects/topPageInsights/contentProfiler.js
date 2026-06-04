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
 * @param {object} entry { position, impressions, profile, coverage }
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
  return out;
}

module.exports = {
  selectTopPages,
  queriesForPage,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
};
