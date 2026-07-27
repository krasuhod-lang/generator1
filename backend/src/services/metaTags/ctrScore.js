'use strict';

/**
 * metaTags/ctrScore — детерминированная метрика кликабельности сниппета
 * (0–100). Без сети и без LLM: одинаковый вход → одинаковый выход.
 *
 * Считается поверх готовой пары title/description (после lsi_check) во всех
 * четырёх пайплайнах: инструмент мета-тегов, аудит страниц проекта,
 * ссылочные статьи, статьи блога / основной SEO-пайплайн (через metaFacade).
 *
 * См. ТЗ «Максимальная кликабельность мета-тегов» §8.
 */

const { checkKeywordPosition } = require('./semantics');
const { hasCta, splitCta } = require('./lengthHelpers');

const TITLE_MIN = 70;
const TITLE_MAX = 80;
const DESC_MIN = 180;
const DESC_MAX = 190;

// Порог, ниже которого сниппет считается слабым и требует перегенерации.
const CTR_SCORE_THRESHOLD = Number(process.env.META_CTR_SCORE_THRESHOLD || 60);

// GIST-факт: число, цена, срок, гарантия, процент, «от N».
const FACT_RE = /(\d+\s*(?:₽|руб|%|лет|год|дн|час|мин|шт|км|м²|кг)|\bот\s+\d|гаранти\w*|сертифиц\w*|лиценз\w*|срок\w*\s+\d)/i;
const YEAR_RE = /\b20\d{2}\b/;

function _pct(part, total) {
  return total > 0 ? part / total : 0;
}

function _tokens(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^а-яёa-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

/** Максимальная доля повторов одного токена в тексте (прокси keyword stuffing). */
function _maxTokenDensity(str) {
  const tokens = _tokens(str);
  if (tokens.length < 6) return 0;
  const counts = new Map();
  tokens.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  let max = 0;
  counts.forEach((c) => { if (c > max) max = c; });
  return max / tokens.length;
}

/**
 * Считает CTR-скор пары мета-тегов.
 *
 * @param {object} args
 * @param {object} args.metas             — { title, description, h1 }
 * @param {string} [args.keyword]
 * @param {object} [args.inputs]          — { brand, toponym, current_year }
 * @param {object} [args.ctrAnalysis]     — analyzeSerpCtr() (p50/p90, штампы)
 * @param {object} [args.snippetAnalysis] — analyzeSnippets() (шум ТОПа)
 * @returns {{score:number, breakdown:object[], penalties:object[], needs_review:boolean}}
 */
function snippetCtrScore({
  metas = {}, keyword = '', inputs = {}, ctrAnalysis = null, snippetAnalysis = null,
} = {}) {
  const title = String(metas.title || '').trim();
  const description = String(metas.description || '').trim();
  const h1 = String(metas.h1 || '').trim();

  const breakdown = [];
  const penalties = [];
  let score = 0;

  const add = (name, points, max, detail) => {
    score += points;
    breakdown.push({ name, points, max, detail: detail || '' });
  };
  const penalize = (name, points, detail) => {
    score -= points;
    penalties.push({ name, points, detail: detail || '' });
  };

  // 1. Ключ в начале title (первые 40% / 35 символов) — 20.
  if (keyword && title) {
    const pos = checkKeywordPosition(title, keyword);
    if (pos.ok) add('keyword_position', 20, 20, `ключ стартует на позиции ${pos.position}`);
    else if (pos.position >= 0) add('keyword_position', 8, 20, `ключ есть, но поздно (позиция ${pos.position})`);
    else add('keyword_position', 0, 20, 'главного ключа нет в title');
  } else {
    add('keyword_position', 0, 20, 'нет ключа или title');
  }

  // 2. Длины в целевых коридорах — 20 (по 10 на title/description).
  const titleLen = title.length;
  if (titleLen >= TITLE_MIN && titleLen <= TITLE_MAX) add('title_length', 10, 10, `${titleLen} симв.`);
  else if (titleLen >= TITLE_MIN - 10 && titleLen <= TITLE_MAX + 5) add('title_length', 5, 10, `${titleLen} симв. (около коридора)`);
  else add('title_length', 0, 10, `${titleLen} симв. вне коридора ${TITLE_MIN}–${TITLE_MAX}`);

  const descLen = description.length;
  if (descLen >= DESC_MIN && descLen <= DESC_MAX) add('description_length', 10, 10, `${descLen} симв.`);
  else if (descLen >= DESC_MIN - 20 && descLen <= DESC_MAX + 5) add('description_length', 5, 10, `${descLen} симв. (около коридора)`);
  else add('description_length', 0, 10, `${descLen} симв. вне коридора ${DESC_MIN}–${DESC_MAX}`);

  // 3. Попадание в p50/p90 ТОПа — 10.
  const patterns = (ctrAnalysis && ctrAnalysis.patterns) || null;
  if (patterns && patterns.length_p50_title) {
    const okTitle = titleLen >= patterns.length_p50_title;
    const okDesc = !patterns.length_p50_desc || descLen >= patterns.length_p50_desc;
    add('serp_length_fit', (okTitle ? 5 : 0) + (okDesc ? 5 : 0), 10,
      `p50 ТОПа: title ${patterns.length_p50_title}, desc ${patterns.length_p50_desc || '—'}`);
  } else {
    // Нет данных выдачи (статьи, link-меты) — начисляем нейтрально.
    add('serp_length_fit', 5, 10, 'нет данных SERP — нейтральная оценка');
  }

  // 4. GIST-факт (число / цена / срок / гарантия) — 20.
  const factInTitle = FACT_RE.test(title);
  const factInDesc = FACT_RE.test(description);
  add('gist_fact', (factInTitle ? 12 : 0) + (factInDesc ? 8 : 0), 20,
    `факт в title: ${factInTitle ? 'да' : 'нет'}, в description: ${factInDesc ? 'да' : 'нет'}`);

  // 5. CTA в конце description — 15.
  if (hasCta(description)) {
    const { cta } = splitCta(description);
    add('cta', cta ? 15 : 10, 15, cta ? `CTA в конце: «${cta}»` : 'CTA есть, но не в конце');
  } else {
    add('cta', 0, 15, 'CTA отсутствует');
  }

  // 6. Гео / год / бренд — по 5, только если релевантны.
  const combined = `${title} ${description}`;
  const geoRelevant = !!String(inputs.toponym || '').trim();
  if (geoRelevant) {
    const geoOk = combined.toLowerCase().includes(String(inputs.toponym).toLowerCase().slice(0, 5));
    add('geo', geoOk ? 5 : 0, 5, geoOk ? 'гео указано' : 'гео задано, но не использовано');
  } else {
    add('geo', 5, 5, 'гео не требуется');
  }

  const yearRelevant = !!String(inputs.current_year ?? '').trim()
    && (!patterns || (patterns.year_frequency ?? 0) >= 0.3);
  if (yearRelevant) {
    add('year', YEAR_RE.test(combined) ? 5 : 0, 5,
      YEAR_RE.test(combined) ? 'год указан' : 'год ожидается выдачей, но не указан');
  } else {
    add('year', 5, 5, 'год не требуется');
  }

  const brand = String(inputs.brand || '').trim();
  if (brand) {
    const brandOk = combined.includes(brand);
    add('brand', brandOk ? 5 : 0, 5, brandOk ? 'бренд указан' : 'бренд задан, но не использован');
  } else {
    add('brand', 5, 5, 'бренд не требуется');
  }

  // ── Штрафы ──
  const prefixes = (patterns && patterns.common_prefixes) || [];
  const suffixes = (patterns && patterns.common_suffixes) || [];
  const lowerTitle = title.toLowerCase();
  const stamp = [...prefixes, ...suffixes]
    .filter(Boolean)
    .find((p) => String(p).length >= 4 && lowerTitle.includes(String(p).toLowerCase()));
  if (stamp) penalize('serp_stamp', 10, `title повторяет штамп ТОПа «${stamp}»`);

  const noise = (snippetAnalysis && snippetAnalysis.competitor_noise) || [];
  const lowerCombined = combined.toLowerCase();
  const noiseHit = noise
    .filter(Boolean)
    .find((n) => String(n).length >= 6 && lowerCombined.includes(String(n).toLowerCase()));
  if (noiseHit) penalize('competitor_noise', 5, `использован штамп конкурентов «${noiseHit}»`);

  const density = _maxTokenDensity(combined);
  if (density > 0.15) {
    penalize('keyword_stuffing', 10, `плотность повторов ${(density * 100).toFixed(0)}% > 15%`);
  }

  if (h1 && title && h1.toLowerCase() === title.toLowerCase()) {
    penalize('h1_duplicate', 5, 'H1 полностью совпадает с Title');
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: finalScore,
    breakdown,
    penalties,
    needs_review: finalScore < CTR_SCORE_THRESHOLD,
    threshold: CTR_SCORE_THRESHOLD,
  };
}

module.exports = {
  snippetCtrScore,
  CTR_SCORE_THRESHOLD,
  _maxTokenDensity,
  _pct,
};
