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
const {
  TITLE_MAX, TITLE_TARGET_MIN, TITLE_TARGET_MAX,
  DESC_MAX, DESC_TARGET_MIN, DESC_TARGET_MAX,
} = require('./lengthConfig');

// Порог, ниже которого сниппет считается слабым и требует перегенерации.
const CTR_SCORE_THRESHOLD = Number(process.env.META_CTR_SCORE_THRESHOLD || 60);

// GIST-факт: не только число/цена, но и named mechanism/material/process,
// limitation, scenario or comparison criterion — именно такие facts могут быть
// полезнее для informational/blog snippets, даже когда они нечисловые.
const FACT_RE = /(\d+\s*(?:₽|руб|%|лет|год|дн|час|мин|шт|км|м²|кг)|\bот\s+\d|гаранти\w*|сертифиц\w*|лиценз\w*|срок\w*\s+\d|технологи\w*|механизм\w*|материал\w*|состав\w*|процесс\w*|метод\w*|сценари\w*|ограничен\w*|не\s+подходит|подходит\s+для|сравн\w*|критери\w*|пошаг\w*|ГОСТ|ISO|IEC|API)/i;

const COMMERCIAL_RE = /купить|заказать|цена|стоимость|доставк|заявк|подобрать|условия|оформить|монтаж|каталог/i;
const INFORMATIONAL_RE = /как\b|почему|что такое|разбор|обзор|объясн|пошаг|совет|ошибк|причин|когда|зачем|ограничен|не подходит/i;
const COMPARISON_RE = /сравн|отличи|разниц|против|\bvs\b|критери|плюс[ыа]|минус[ыа]|лучше для/i;
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
  //    Полный балл — за целевой коридор, половина — за попадание в жёсткие
  //    границы выдачи (пара читаема, но длиннее/короче оптимума).
  const titleLen = title.length;
  if (titleLen >= TITLE_TARGET_MIN && titleLen <= TITLE_TARGET_MAX) {
    add('title_length', 10, 10, `${titleLen} симв.`);
  } else if (titleLen >= TITLE_TARGET_MIN - 10 && titleLen <= TITLE_MAX) {
    add('title_length', 5, 10, `${titleLen} симв. (около коридора ${TITLE_TARGET_MIN}–${TITLE_TARGET_MAX})`);
  } else {
    add('title_length', 0, 10, `${titleLen} симв. вне коридора ${TITLE_TARGET_MIN}–${TITLE_TARGET_MAX} (максимум ${TITLE_MAX})`);
  }

  const descLen = description.length;
  if (descLen >= DESC_TARGET_MIN && descLen <= DESC_TARGET_MAX) {
    add('description_length', 10, 10, `${descLen} симв.`);
  } else if (descLen >= DESC_TARGET_MIN - 20 && descLen <= DESC_MAX) {
    add('description_length', 5, 10, `${descLen} симв. (около коридора ${DESC_TARGET_MIN}–${DESC_TARGET_MAX})`);
  } else {
    add('description_length', 0, 10, `${descLen} симв. вне коридора ${DESC_TARGET_MIN}–${DESC_TARGET_MAX} (максимум ${DESC_MAX})`);
  }

  // 3. Попадание в p50/p90 ТОПа — 10.
  const patterns = (ctrAnalysis && ctrAnalysis.patterns) || null;
  if (patterns && patterns.length_p50_title) {
    const okTitle = titleLen >= patterns.length_p50_title;
    const okDesc = !patterns.length_p50_desc || descLen >= patterns.length_p50_desc;
    add('serp_length_fit', (okTitle ? 3 : 0) + (okDesc ? 2 : 0), 5,
      `p50 ТОПа: title ${patterns.length_p50_title}, desc ${patterns.length_p50_desc || '—'}`);
  } else {
    // Нет данных выдачи (статьи, link-меты) — начисляем нейтрально.
    add('serp_length_fit', 3, 5, 'нет данных SERP — нейтральная оценка');
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
    add('geo', geoOk ? 3 : 0, 3, geoOk ? 'гео указано' : 'гео задано, но не использовано');
  } else {
    add('geo', 3, 3, 'гео не требуется');
  }

  const yearRelevant = !!String(inputs.current_year ?? '').trim()
    && (!patterns || (patterns.year_frequency ?? 0) >= 0.3);
  if (yearRelevant) {
    add('year', YEAR_RE.test(combined) ? 3 : 0, 3,
      YEAR_RE.test(combined) ? 'год указан' : 'год ожидается выдачей, но не указан');
  } else {
    add('year', 3, 3, 'год не требуется');
  }

  const brand = String(inputs.brand || '').trim();
  if (brand) {
    const brandOk = combined.includes(brand);
    add('brand', brandOk ? 4 : 0, 4, brandOk ? 'бренд указан' : 'бренд задан, но не использован');
  } else {
    add('brand', 4, 4, 'бренд не требуется');
  }

  // 7. Intent-fit — title/description должны выполнять job страницы, а не
  // просто содержать keyword. Это особенно важно для blog/link meta без SERP.
  const intentContract = inputs.intentContract || inputs.intent_contract || {};
  const intentValue = String(
    intentContract.value || intentContract.intent || inputs.intent ||
    (ctrAnalysis && ctrAnalysis.serp_intent && ctrAnalysis.serp_intent.value) ||
    (inputs.articleType === 'link' ? 'Informational/Research' : ''),
  );
  const intentRegex = /compar|сравн|против|vs/i.test(intentValue)
    ? COMPARISON_RE
    : /commercial|transaction|коммерч|покуп|заказ/i.test(intentValue)
      ? COMMERCIAL_RE
      : INFORMATIONAL_RE;
  const intentHits = [title, description].filter((part) => intentRegex.test(part)).length;
  add('intent_fit', intentHits === 2 ? 10 : intentHits === 1 ? 5 : 0, 10,
    `${intentValue || 'не определён'}: ${intentHits}/2 полей отражают intent`);

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
