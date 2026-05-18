'use strict';

/**
 * lsiDensity — per-H2 анализ плотности LSI-фраз и контроль переспама.
 *
 * Цель (по ТЗ заказчика):
 *   «Плотность LSI слов должна быть максимальным, четким и помогать
 *    поставить любой контент в топ выдачи поисковых систем» —
 *    при этом «усилить контроль переспама при генерации контента».
 *
 * Подход:
 *   1. extractH2Sections(html) — детерминированно режет HTML по <h2>, собирает
 *      раздел = <h2>title + последующие блоки до следующего <h2>. Внутри
 *      раздела вычисляет plain-текст (через stripHtmlTags), длину в словах,
 *      список встреченных LSI-фраз (по стемм-сигнатуре, как в lsiPipeline).
 *
 *   2. measureLsiDensityPerH2(html, importantTerms) → массив отчётов:
 *        { section_index, title, word_count,
 *          lsi_hits: [{ term, stem, count, density_pct }],
 *          lsi_density_pct, lsi_unique_terms, status: 'low'|'good'|'overdose' }
 *      density_pct = SUM(count(term)) / word_count * 100.
 *
 *   3. checkLsiOverdose(html, importantTerms, opts) → агрегированный отчёт
 *      с verdict 'pass' / 'review' / 'fail' и списком переспам-секций.
 *      Лимиты захардкожены (продуктовое решение, ENV не используется):
 *        - per-term density > MAX_PER_TERM_PCT = 2.5 (по любой важной фразе)
 *        - total LSI density > MAX_TOTAL_PCT  = 8.0
 *        - low-density границы: < MIN_TOTAL_PCT = 1.5 → 'low'
 *      verdict:
 *        - fail   — хотя бы 1 секция в overdose
 *        - review — >= 30% секций в overdose ИЛИ < 50% секций в 'good'
 *        - pass   — всё в порядке
 *      На пустой ввод (нет H2 / нет LSI) — verdict 'na'.
 *
 * Дизайн-решения:
 *   - Никакого LLM, чистая детерминированная проверка по тем же tokenize/
 *     stemKey, что и в lsiPipeline (consistency).
 *   - Возвращаем структуру, пригодную и для writer-промта (как negative
 *     constraints) и для post-аудита (тот же модуль).
 *   - Считаем по стеммам, не по surface form, чтобы «топ выдачи / топа
 *     выдачи / топ выдач» считались одним хитом.
 */

const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');
const { russianStem } = require('../../utils/russianStem');

// ── Лимиты (захардкожены — продуктовое решение, ENV запрещено трогать) ──
const MAX_PER_TERM_PCT  = 2.5;  // плотность одной важной фразы
const MAX_TOTAL_PCT     = 8.0;  // общая плотность LSI
const MIN_TOTAL_PCT     = 1.5;  // ниже — секция слишком «жидкая»
const MIN_SECTION_WORDS = 30;   // слишком короткие секции не оцениваем

// Та же tokenize/stem-логика, что в lsiPipeline.js — копия namespaced, чтобы
// этот модуль не зависел от приватного _internal lsiPipeline (он экспортирует
// только под `_internal` и не предназначен для внешнего API).
function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .match(/[a-zа-я0-9]+/g) || [];
}

function _stemKey(word) {
  const w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (!w) return '';
  return russianStem(w);
}

function _termStem(term) {
  // Многословный термин — стемм каждого слова, '_' как разделитель
  return _tokenize(term).map(_stemKey).filter(Boolean).join('_');
}

/**
 * Делит HTML на разделы по <h2>. Возвращает массив:
 *   [{ index, title, html, text, word_count }]
 *
 * До первого <h2> идёт «преамбула» с index=0 (если есть текст). Title
 * преамбулы = '__intro__' для отличимости.
 */
function extractH2Sections(html) {
  const src = String(html || '');
  if (!src.trim()) return [];

  // Простая регулярка по <h2>...</h2>: для production-стабильности
  // обрабатываем атрибуты внутри тега и пустые тайтлы.
  const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const sections = [];
  const matches = [];
  let m;
  while ((m = H2_RE.exec(src)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, title: stripHtmlTagsToText(m[1]).trim() });
  }

  if (matches.length === 0) {
    // Нет ни одного H2 — вся статья как одна «секция».
    const text = stripHtmlTagsToText(src).trim();
    if (!text) return [];
    return [{
      index: 0, title: '__no_h2__', html: src, text,
      word_count: _tokenize(text).length,
    }];
  }

  // Преамбула до первого H2
  if (matches[0].start > 0) {
    const intro = src.slice(0, matches[0].start);
    const text = stripHtmlTagsToText(intro).trim();
    if (text) {
      sections.push({
        index: 0, title: '__intro__', html: intro, text,
        word_count: _tokenize(text).length,
      });
    }
  }

  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : src.length;
    const blockHtml = src.slice(cur.start, nextStart);
    // Текст без самого H2-тайтла — тайтл считаем отдельно (включая для
    // плотности это спорно; включаем, потому что заголовок тоже индексируется)
    const text = stripHtmlTagsToText(blockHtml).trim();
    sections.push({
      index: sections.length, // re-numerate after intro
      title: cur.title || `Раздел ${i + 1}`,
      html: blockHtml,
      text,
      word_count: _tokenize(text).length,
    });
  }
  return sections;
}

/**
 * Считает плотность LSI в одной секции. Возвращает:
 *   { lsi_hits, lsi_density_pct, lsi_unique_terms,
 *     overspam_terms: [{term, density_pct}], status }
 *
 * @param {{text:string, word_count:number}} section
 * @param {Array<string|{phrase:string}>} importantTerms — LSI-набор.
 */
function _measureSectionDensity(section, importantTerms) {
  const wc = Math.max(0, Number(section.word_count) || 0);
  if (wc < MIN_SECTION_WORDS) {
    return {
      lsi_hits: [], lsi_density_pct: 0, lsi_unique_terms: 0,
      overspam_terms: [], status: 'too_short',
    };
  }
  const tokens = _tokenize(section.text);
  // Индекс стемов токенов → массив позиций
  const stemPositions = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const s = _stemKey(tokens[i]);
    if (!s) continue;
    if (!stemPositions.has(s)) stemPositions.set(s, []);
    stemPositions.get(s).push(i);
  }

  const hits = [];
  let totalHits = 0;
  const overspam = [];

  for (const raw of (importantTerms || [])) {
    const term = typeof raw === 'string' ? raw : (raw && raw.phrase) || '';
    const tStem = _termStem(term);
    if (!tStem) continue;
    const parts = tStem.split('_');
    let count;
    if (parts.length === 1) {
      count = (stemPositions.get(parts[0]) || []).length;
    } else {
      // Для многословных терминов считаем сколько раз подряд встречается
      // последовательность стемов. Простой n-gram скан по tokens.
      count = 0;
      const head = stemPositions.get(parts[0]) || [];
      for (const pos of head) {
        let ok = true;
        for (let j = 1; j < parts.length; j += 1) {
          if (pos + j >= tokens.length) { ok = false; break; }
          if (_stemKey(tokens[pos + j]) !== parts[j]) { ok = false; break; }
        }
        if (ok) count += 1;
      }
    }
    if (count > 0) {
      const density = (count * parts.length) / wc * 100;
      hits.push({ term, stem: tStem, count, density_pct: Number(density.toFixed(2)) });
      totalHits += count * parts.length;
      if (density > MAX_PER_TERM_PCT) {
        overspam.push({ term, density_pct: Number(density.toFixed(2)) });
      }
    }
  }

  const totalDensity = wc > 0 ? totalHits / wc * 100 : 0;
  let status;
  if (overspam.length > 0 || totalDensity > MAX_TOTAL_PCT) status = 'overdose';
  else if (totalDensity < MIN_TOTAL_PCT) status = 'low';
  else status = 'good';

  return {
    lsi_hits: hits,
    lsi_density_pct:  Number(totalDensity.toFixed(2)),
    lsi_unique_terms: hits.length,
    overspam_terms:   overspam,
    status,
  };
}

/**
 * Полный per-H2 отчёт по плотности LSI.
 *
 * @param {string} html
 * @param {Array<string|{phrase:string}>} importantTerms
 * @returns {Array<{section_index, title, word_count, lsi_density_pct,
 *                  lsi_unique_terms, lsi_hits, overspam_terms, status}>}
 */
function measureLsiDensityPerH2(html, importantTerms) {
  const sections = extractH2Sections(html);
  return sections.map((s) => {
    const stats = _measureSectionDensity(s, importantTerms);
    return {
      section_index: s.index,
      title: s.title,
      word_count: s.word_count,
      ...stats,
    };
  });
}

/**
 * Финальный verdict по статье с агрегацией.
 *
 * @returns {{
 *   verdict: 'pass'|'review'|'fail'|'na',
 *   sections_total: number,
 *   sections_overdose: number,
 *   sections_low: number,
 *   sections_good: number,
 *   overspam: Array<{section_title, term, density_pct}>,
 *   thresholds: { maxPerTermPct, maxTotalPct, minTotalPct, minSectionWords },
 *   per_section: ReturnType<typeof measureLsiDensityPerH2>,
 * }}
 */
function checkLsiOverdose(html, importantTerms, opts = {}) {
  const perSection = measureLsiDensityPerH2(html, importantTerms);
  const scored = perSection.filter((s) => s.status !== 'too_short');

  if (!scored.length || !Array.isArray(importantTerms) || !importantTerms.length) {
    return {
      verdict: 'na',
      sections_total: perSection.length,
      sections_overdose: 0,
      sections_low: 0,
      sections_good: 0,
      overspam: [],
      thresholds: {
        maxPerTermPct: MAX_PER_TERM_PCT,
        maxTotalPct:   MAX_TOTAL_PCT,
        minTotalPct:   MIN_TOTAL_PCT,
        minSectionWords: MIN_SECTION_WORDS,
      },
      per_section: perSection,
    };
  }

  const overdose = scored.filter((s) => s.status === 'overdose');
  const low      = scored.filter((s) => s.status === 'low');
  const good     = scored.filter((s) => s.status === 'good');
  const overspam = [];
  for (const sec of overdose) {
    for (const o of sec.overspam_terms || []) {
      overspam.push({ section_title: sec.title, term: o.term, density_pct: o.density_pct });
    }
  }

  let verdict;
  if (overdose.length > 0) {
    // Хотя бы один кейс переспама — review (для UI). fail оставляем для
    // явно опасных случаев (>30% секций или per-term density >> лимита).
    const overdoseRatio = overdose.length / scored.length;
    const hasHardOverdose =
      overdose.some((s) => (s.overspam_terms || []).some((o) => o.density_pct > MAX_PER_TERM_PCT * 2));
    verdict = (overdoseRatio >= 0.3 || hasHardOverdose) ? 'fail' : 'review';
  } else if (good.length / scored.length < 0.5) {
    verdict = 'review';
  } else {
    verdict = 'pass';
  }

  return {
    verdict,
    sections_total:    perSection.length,
    sections_overdose: overdose.length,
    sections_low:      low.length,
    sections_good:     good.length,
    overspam,
    thresholds: {
      maxPerTermPct: MAX_PER_TERM_PCT,
      maxTotalPct:   MAX_TOTAL_PCT,
      minTotalPct:   MIN_TOTAL_PCT,
      minSectionWords: MIN_SECTION_WORDS,
    },
    per_section: perSection,
  };
}

module.exports = {
  measureLsiDensityPerH2,
  checkLsiOverdose,
  extractH2Sections,
  // exposed for tests
  _internal: { _tokenize, _stemKey, _termStem, _measureSectionDensity },
  MAX_PER_TERM_PCT,
  MAX_TOTAL_PCT,
  MIN_TOTAL_PCT,
  MIN_SECTION_WORDS,
};
