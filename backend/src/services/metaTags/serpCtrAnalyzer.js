'use strict';

/**
 * metaTags/serpCtrAnalyzer — детерминированный «фактчекинг конкурентов»
 * (анализ кликабельности тайтлов/дескрипшенов ТОП-10 выдачи).
 *
 * Запускается между fetchYandexSerp и generateDrMaxMeta. ЧИСТАЯ функция: без
 * сети / без LLM. Используется генератором мета-тегов, чтобы построить
 * Title/Description «лучше конкурентов» (длина в p50–p90, CTA/USP/гео/год,
 * обязательные LSI, дифференциация).
 *
 * См. план ТЗ §2.1–2.2 «Мета-теги: фаза анализа кликабельности в выдаче».
 */

const { normalizeWord, STOP_WORDS } = require('./semantics');

const CTA_PATTERNS = [
  /(?:^|[\s«"„])(закаж[иое]те?|заказ[аы]ть)/i,
  /(?:^|[\s«"„])(купи[тл]ь?|купите|купим)/i,
  /(?:^|[\s«"„])(оставьте?|оставить)\s+заявк/i,
  /(?:^|[\s«"„])(звон(?:и|ите|ок))/i,
  /(?:^|[\s«"„])(запиш[иь]те?ся|запис(?:ать|аться))/i,
  /(?:^|[\s«"„])(узна[йй]те?|подробн)/i,
  /(?:^|[\s«"„])(заходите|посет(?:и|ите))/i,
  /(?:^|[\s«"„])(оформ(?:и|ите)|оформить)/i,
];

const USP_PATTERNS = [
  /бесплат/i, /гаранти/i, /скидк/i, /акци/i,
  /доставк/i, /быстр/i, /под ключ/i, /в день обращени/i,
  /опыт/i, /профессионал/i, /лиценз/i, /сертифик/i,
  /(?:^|\s)(от|до)\s*\d/i, /\d+\s*лет(?:\s|$|\.|,)/i, /\d+%/,
];

const PRICE_PATTERNS = [
  /(?:^|\s)от\s+\d/i, /цен[ауы]?(?:\s|$|\.|,)/i, /\d+\s*(?:руб|₽|р\.)/i,
  /(?:стоимост|тариф)/i,
];

const QUESTION_PATTERNS = [/\?$/, /(?:^|\s)(как|почему|где|когда|сколько|какой)\s/i];

const COMMERCIAL_INTENT_PATTERNS = [
  /(?:^|\W)(цен[ауы]?|стоимост|руб(?:\.|лей)?|₽)(?:\W|$)/i,
  /(?:^|\W)(купить|заказать|доставка|интернет-магазин|каталог)(?:\W|$)/i,
];

const INFORMATIONAL_INTENT_PATTERNS = [
  /(?:^|\W)(как|почему|отзывы?|обзор|своими\s+руками|топ|рейтинг)(?:\W|$)/i,
];

const GEO_PATTERNS = [
  /москв/i, /санкт-петербург/i, /питере?(?:\s|$|\.|,)/i, /екатеринбург/i,
  /новосибирск/i, /казан/i, /краснодар/i, /сочи(?:\s|$|\.|,)/i,
  /(?:^|\s)в\s+[А-ЯЁ][а-яё]+(е|у)(?:\s|$|\.|,)/, // «в Москве», «в России»
];

const BRAND_PATTERNS = [
  /[«»“”„"][^«»“”„"]{2,40}[«»“”„"]/,                  // «бренд» в кавычках
  /[A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]{2,})?/,        // CamelCase / TitleCase
];

const EMOTIONAL_PATTERNS = [
  /(выгодн|надёжн|надежн|лучш|идеальн|уникальн|эксклюзивн|премиум|элитн)/i,
  /(новинк|хит|топ|№\s?1|лидер)(?:\s|$|\.|,)/i,
  /[!]{1,3}/,
];

function _matches(text, patterns) {
  const s = String(text || '');
  return patterns.some((re) => re.test(s));
}

function _percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function _normalizedTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^а-яёa-z0-9]/g, ' ')
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function _profileTitle(item, keyword) {
  const title = item.title || '';
  const length = title.length;
  const yearMatch = title.match(/\b(20\d{2})\b/);
  const keywordTokens = new Set(_normalizedTokens(keyword));
  const titleTokens = _normalizedTokens(title);
  const tokensInQuery = titleTokens.filter((t) => keywordTokens.has(t)).length;

  let formula = 'plain';
  if (yearMatch && _matches(title, PRICE_PATTERNS)) formula = 'year+price';
  else if (_matches(title, GEO_PATTERNS) && yearMatch) formula = 'geo+year';
  else if (_matches(title, GEO_PATTERNS)) formula = 'keyword+geo';
  else if (yearMatch) formula = 'keyword+year';
  else if (_matches(title, BRAND_PATTERNS)) formula = 'brand+keyword';
  else if (_matches(title, QUESTION_PATTERNS)) formula = 'question';

  return {
    url:               item.url || item.link || '',
    title,
    length,
    has_brand:         _matches(title, BRAND_PATTERNS),
    has_year:          !!yearMatch,
    has_number:        /\d/.test(title),
    has_question:      _matches(title, QUESTION_PATTERNS),
    has_pricing:       _matches(title, PRICE_PATTERNS),
    has_exact_price:   /\d[\d\s]*(?:руб(?:\.|лей)?|₽|р\.)/i.test(title),
    has_geo:           _matches(title, GEO_PATTERNS),
    emotional_triggers: _matches(title, EMOTIONAL_PATTERNS),
    tokens_in_query:   tokensInQuery,
    formula_tag:       formula,
  };
}

function _detectSerpIntent(items) {
  const total = items.length;
  if (!total) {
    return {
      value: 'Mixed/Unclear',
      commercial_frequency: 0,
      informational_frequency: 0,
      confidence: 0,
    };
  }

  let commercial = 0;
  let informational = 0;
  items.forEach((item) => {
    const text = `${item.title || ''} ${item.snippet || item.description || ''} ${item.url || item.link || ''}`;
    if (_matches(text, COMMERCIAL_INTENT_PATTERNS)) commercial += 1;
    if (_matches(text, INFORMATIONAL_INTENT_PATTERNS)) informational += 1;
  });

  const commercialFrequency = commercial / total;
  const informationalFrequency = informational / total;
  let value = 'Mixed/Unclear';
  if (commercialFrequency > 0.5 && commercialFrequency >= informationalFrequency) {
    value = 'Commercial/Transactional';
  } else if (informationalFrequency > 0.5) {
    value = 'Informational';
  }

  return {
    value,
    commercial_frequency: +commercialFrequency.toFixed(2),
    informational_frequency: +informationalFrequency.toFixed(2),
    confidence: +Math.max(commercialFrequency, informationalFrequency).toFixed(2),
  };
}

function _profileDescription(item) {
  const description = item.snippet || item.description || '';
  return {
    url:             item.url || item.link || '',
    description,
    length:          description.length,
    has_cta:         _matches(description, CTA_PATTERNS),
    has_usp:         _matches(description, USP_PATTERNS),
    has_price_signal: _matches(description, PRICE_PATTERNS),
  };
}

/**
 * Детерминированная оценка CTR-потенциала сниппета конкурента (0–100).
 * Эвристика по проверенным CTR-факторам: вхождение запроса, год, цифры,
 * цена, гео, эмоциональные триггеры в Title + CTA/USP/цена в Description.
 * Используется ПЕРЕД генерацией, чтобы показать модели «лучших» конкурентов
 * и потребовать написать версию сильнее их (DSPy-style усиление промпта).
 */
function _ctrScore(titleProfile, descProfile) {
  let score = 0;
  // Title-факторы (до 60 баллов)
  score += Math.min(3, titleProfile.tokens_in_query || 0) * 8; // вхождение запроса
  if (titleProfile.has_year)           score += 8;
  if (titleProfile.has_number)         score += 6;
  if (titleProfile.has_pricing)        score += 8;
  if (titleProfile.has_geo)            score += 6;
  if (titleProfile.emotional_triggers) score += 8;
  // Description-факторы (до 30 баллов)
  if (descProfile) {
    if (descProfile.has_cta)          score += 12;
    if (descProfile.has_usp)          score += 10;
    if (descProfile.has_price_signal) score += 8;
  }
  // Длина Title в «рабочем» диапазоне (до 10 баллов)
  if (titleProfile.length >= 40 && titleProfile.length <= 80) score += 10;
  else if (titleProfile.length >= 25) score += 4;
  return Math.min(100, score);
}

// Слова-маркеры интента для LSI-анализа (нормализованные корни сравниваются
// через normalizeWord, поэтому здесь — исходные формы).
const COMMERCIAL_LSI_MARKERS = [
  'купить', 'заказать', 'цена', 'стоимость', 'недорого', 'доставка',
  'каталог', 'магазин', 'прайс', 'скидка', 'акция', 'оптом', 'аренда',
  'услуга', 'установка', 'монтаж', 'ремонт', 'производитель', 'гарантия',
];
const INFORMATIONAL_LSI_MARKERS = [
  'как', 'почему', 'обзор', 'отзывы', 'рейтинг', 'сравнение', 'инструкция',
  'своими', 'руками', 'выбрать', 'топ', 'гайд', 'советы', 'виды', 'типы',
  'отличия', 'характеристики',
];

/**
 * Анализ интента на основании LSI-семантики выдачи (ТЗ «усиление мета-тегов»,
 * п.4). Дополняет частотный SERP-интент: смотрит, какие LSI реально
 * доминируют в семантике ТОПа (title_mandatory + description_mandatory +
 * obligatory_lsi), и классифицирует их на коммерческие / информационные.
 *
 * ЧИСТАЯ функция, без сети/LLM.
 *
 * @param {object} semantics — результат extractSemantics
 * @returns {{value:string, commercial_lsi:string[], informational_lsi:string[],
 *            neutral_lsi:string[], confidence:number}}
 */
function analyzeLsiIntent(semantics = {}) {
  const commercialSet = new Set(COMMERCIAL_LSI_MARKERS.map(normalizeWord));
  const informationalSet = new Set(INFORMATIONAL_LSI_MARKERS.map(normalizeWord));

  const seen = new Set();
  const allLsi = [];
  [
    ...(semantics.title_mandatory_words || []),
    ...(semantics.description_mandatory_words || []),
    ...(semantics.obligatory_lsi || []),
  ].forEach((w) => {
    const n = normalizeWord(String(w || '').toLowerCase());
    if (n && !seen.has(n)) { seen.add(n); allLsi.push({ raw: String(w), norm: n }); }
  });

  const commercial = [];
  const informational = [];
  const neutral = [];
  allLsi.forEach(({ raw, norm }) => {
    if (commercialSet.has(norm)) commercial.push(raw);
    else if (informationalSet.has(norm)) informational.push(raw);
    else neutral.push(raw);
  });

  const signalTotal = commercial.length + informational.length;
  let value = 'Mixed/Unclear';
  if (signalTotal > 0) {
    if (commercial.length > informational.length) value = 'Commercial/Transactional';
    else if (informational.length > commercial.length) value = 'Informational';
  }
  const confidence = signalTotal
    ? +(Math.max(commercial.length, informational.length) / signalTotal).toFixed(2)
    : 0;

  return {
    value,
    commercial_lsi: commercial,
    informational_lsi: informational,
    neutral_lsi: neutral,
    confidence,
  };
}

function _commonPrefixSuffix(titles, minRepeat = 2) {
  const prefixes = new Map();
  const suffixes = new Map();
  titles.forEach((t) => {
    const s = String(t || '').trim();
    if (s.length < 6) return;
    // Берём первые 18 символов и последние 18 символов как «штамп».
    const pre = s.slice(0, 18).toLowerCase();
    const suf = s.slice(-18).toLowerCase();
    prefixes.set(pre, (prefixes.get(pre) || 0) + 1);
    suffixes.set(suf, (suffixes.get(suf) || 0) + 1);
  });
  const repeat = (map) => [...map.entries()]
    .filter(([_, c]) => c >= minRepeat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s);
  return { common_prefixes: repeat(prefixes), common_suffixes: repeat(suffixes) };
}

/**
 * Главная функция анализа кликабельности выдачи.
 *
 * @param {Array<{title:string, snippet?:string, url?:string}>} serp - ТОП-выдача
 * @param {object} opts
 * @param {string}   opts.keyword       - главный поисковый запрос
 * @param {object}   [opts.semantics]   - объект из extractSemantics
 *   (используем df_map, obligatory_lsi, differentiator_lsi)
 * @returns {object} структура competitor_titles / competitor_descriptions
 *   / patterns / recommendations
 */
function analyzeSerpCtr(serp, { keyword = '', semantics = null } = {}) {
  const arr = Array.isArray(serp) ? serp.slice(0, 10) : [];
  const competitorTitles = arr.map((it) => _profileTitle(it, keyword));
  const competitorDescriptions = arr.map(_profileDescription);
  // Оценка CTR каждого конкурента (0–100) ПЕРЕД генерацией — чтобы промпт
  // мог показать «лучших» и потребовать написать версию сильнее их.
  competitorTitles.forEach((tp, i) => {
    tp.ctr_score = _ctrScore(tp, competitorDescriptions[i]);
  });

  const total = arr.length || 1;
  const titleLengths = competitorTitles.map((p) => p.length).filter((n) => n > 0);
  const descLengths  = competitorDescriptions.map((p) => p.length).filter((n) => n > 0);

  const ctaCount   = competitorDescriptions.filter((p) => p.has_cta).length;
  const yearCount  = competitorTitles.filter((p) => p.has_year).length;
  const priceCount = competitorTitles.filter((p) => p.has_pricing).length
                   + competitorDescriptions.filter((p) => p.has_price_signal).length;
  const geoCount   = competitorTitles.filter((p) => p.has_geo).length;
  const brandCount = competitorTitles.filter((p) => p.has_brand).length;
  const exactPriceTitleCount = competitorTitles.filter((p) => p.has_exact_price).length;
  const serpIntent = _detectSerpIntent(arr);

  const { common_prefixes, common_suffixes } = _commonPrefixSuffix(arr.map((d) => d.title));

  // Слабые конкуренты: короткие тайтлы без USP/года.
  const titleP50 = _percentile(titleLengths, 50);
  const weakTitles = competitorTitles
    .filter((p) => p.length > 0 && p.length < Math.max(35, titleP50 - 12) && !p.emotional_triggers && !p.has_year)
    .slice(0, 5)
    .map((p) => p.title);

  const patterns = {
    common_prefixes,
    common_suffixes,
    length_p50_title: titleP50,
    length_p90_title: _percentile(titleLengths, 90),
    length_p50_desc:  _percentile(descLengths, 50),
    length_p90_desc:  _percentile(descLengths, 90),
    cta_frequency:    +(ctaCount   / total).toFixed(2),
    year_frequency:   +(yearCount  / total).toFixed(2),
    price_frequency:  +(Math.min(total, priceCount) / total).toFixed(2),
    geo_frequency:    +(geoCount   / total).toFixed(2),
    brand_frequency:  +(brandCount / total).toFixed(2),
    exact_price_title_frequency: +(exactPriceTitleCount / total).toFixed(2),
    questionable_titles: weakTitles,
  };

  // LSI: какие уже эксплуатируют ТОПы (obligatory) → надо иметь, какие нет ни у кого
  // (differentiator) → можно выгодно выделиться.
  const obligatoryLsi      = (semantics && semantics.obligatory_lsi)     || [];
  const differentiatorLsi  = (semantics && semantics.differentiator_lsi) || [];

  const recommendations = {
    must_have: [],
    must_avoid: [],
    differentiation: [],
    suggested_title_formula: '',
  };

  if (patterns.year_frequency >= 0.8) {
    recommendations.must_have.push(`Указать current_year — год есть у ${Math.round(patterns.year_frequency * 100)}% ТОПа`);
  } else if (patterns.year_frequency >= 0.4) {
    recommendations.must_have.push(`Указать год (${new Date().getFullYear()}) — есть у ${Math.round(patterns.year_frequency * 100)}% ТОПа`);
  }
  if (patterns.exact_price_title_frequency >= 0.9) {
    recommendations.must_have.push('Указать точную подтверждённую цену в рублях — она есть в Title у ≥90% конкурентов');
  } else if (patterns.price_frequency >= 0.4) {
    recommendations.must_have.push('Сигнал цены / «от X ₽» — конкуренты в выдаче делают то же');
  }
  if (patterns.cta_frequency >= 0.5) {
    recommendations.must_have.push('CTA в Description («Закажите», «Оставьте заявку») — норма выдачи');
  }
  if (patterns.geo_frequency >= 0.4) {
    recommendations.must_have.push('Гео-маркер («в Москве», регион) — у большинства ТОПа');
  }
  if (obligatoryLsi.length) {
    recommendations.must_have.push(
      `Обязательные LSI (≥${Math.round(((semantics && semantics.serp_doc_count) ? 0.5 : 0.5) * 100)}% ТОПа): ${obligatoryLsi.slice(0, 6).join(', ')}`,
    );
  }

  if (common_prefixes.length) {
    recommendations.must_avoid.push(`Не начинать тайтл с штампа «${common_prefixes[0]}…» — повтор ТОПа снизит CTR`);
  }
  if (patterns.geo_frequency >= 0.4) {
    recommendations.must_avoid.push('Не игнорировать гео — иначе сниппет проиграет локальным конкурентам');
  }

  if (differentiatorLsi.length) {
    recommendations.differentiation.push(
      `Уникальные LSI (нет ни у кого в ТОП-10): ${differentiatorLsi.slice(0, 3).join(', ')} — добавьте 1–2 ради уникальности`,
    );
  }
  if (patterns.cta_frequency < 0.3) {
    recommendations.differentiation.push('CTA редок у конкурентов — сильный CTA сразу выделит сниппет');
  }
  if (patterns.price_frequency < 0.2) {
    recommendations.differentiation.push('Цены/«от X ₽» нет в выдаче — добавив, выгодно отстроитесь');
  }

  // Формула тайтла — самая частая среди ТОПа (но не слабая).
  const formulaCounts = {};
  competitorTitles.forEach((p) => {
    if (p.formula_tag && p.formula_tag !== 'plain') {
      formulaCounts[p.formula_tag] = (formulaCounts[p.formula_tag] || 0) + 1;
    }
  });
  const topFormula = Object.entries(formulaCounts).sort((a, b) => b[1] - a[1])[0];
  const formulaMap = {
    'year+price':  'USP + Запрос + Гео + Год + Цена',
    'geo+year':    'Запрос + Гео + Год',
    'keyword+geo': 'Запрос + Гео + Бренд',
    'keyword+year': 'Запрос + Год + USP',
    'brand+keyword': 'Бренд — Запрос + USP',
    'question':    'Вопрос + Запрос + Ответ',
  };
  recommendations.suggested_title_formula = topFormula
    ? formulaMap[topFormula[0]] || 'Запрос + USP + Гео'
    : 'Запрос + USP + Гео + Год';

  return {
    serp_intent:              serpIntent,
    // Интент на основании LSI-семантики выдачи (п.4 ТЗ «усиление мета-тегов»).
    lsi_intent:               analyzeLsiIntent(semantics || {}),
    competitor_titles:       competitorTitles,
    competitor_descriptions: competitorDescriptions,
    patterns,
    recommendations,
  };
}

module.exports = {
  analyzeSerpCtr,
  analyzeLsiIntent,
  // экспорт для тестов
  _percentile,
  _profileTitle,
  _profileDescription,
  _detectSerpIntent,
  _ctrScore,
};
