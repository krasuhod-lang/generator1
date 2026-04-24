'use strict';

/**
 * articleKnowledgeBase — агрегатор «Базы знаний статьи» (ARTICLE_KNOWLEDGE_BASE).
 *
 * Цель: собрать в один детерминированный Markdown-документ всё, что
 * собрано на этапах Pre-Stage 0 → Stage 0 → Stage 1 + Target Page Analysis +
 * Audience/Niche Analyzer. Этот документ затем подаётся в Gemini как нативный
 * `systemInstruction` (и опционально кешируется через `cachedContents`),
 * чтобы Stage 3/5/6 не оплачивали один и тот же ~15 КБ контекст на каждый блок.
 *
 * Принципы:
 *   1. Чисто-JS, без сетевых вызовов и побочных эффектов.
 *   2. Детерминизм: одинаковые входы → одинаковые байты на выходе
 *      (важно для cache hit Gemini; сортировка ключей, обрезка по словам).
 *   3. Graceful degradation: любой отсутствующий вход → секция помечается
 *      «Нет данных», а не падение и не пустая строка.
 *   4. Word-boundary slicing вместо char-slicing: мелкое плавание токенайзера
 *      не должно ломать кэш.
 */

const { buildStrategyDigest } = require('../services/pipeline/preStage0');

// ────────────────────────────────────────────────────────────────────
// Константы лимитов секций (в словах) — подобраны так, чтобы AKB
// уверенно превышал ~4 КБ implicit-cache порога Gemini, но не раздувал
// systemInstruction свыше 25 КБ.
// ────────────────────────────────────────────────────────────────────
const LIMITS = {
  brandFacts:        800,
  serviceDetails:    400,
  proofAssets:       300,
  audiencePersonas:  600,
  contentVoice:      250,
  nicheTerminology:  200,
  nicheDeepDive:     600,
  strategyDigest:    700,
  serpReality:       500,
  competitorFacts:   400,
  requiredEntities:  300,
  communityPains:    300,
  communityQuestions: 200,
  styleCard:         300,
};

/**
 * sliceWords — обрезает строку по границам слов, не по символам.
 * Это даёт стабильный токенайзинг → стабильные cache-ключи Gemini.
 *
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
function sliceWords(text, maxWords) {
  if (!text || typeof text !== 'string') return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ') + ' …';
}

/**
 * ensureString — нормализация значения в строку, исключая «undefined»/«null»/«[object Object]».
 */
function ensureString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v))      return v.filter(Boolean).map(ensureString).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (_) { return ''; }
  }
  return String(v);
}

/**
 * pickFirstNonEmpty — возвращает первое непустое значение из аргументов.
 */
function pickFirstNonEmpty(...candidates) {
  for (const c of candidates) {
    const s = ensureString(c);
    if (s) return s;
  }
  return '';
}

/**
 * formatList — рендерит массив строк/объектов в список markdown.
 * @param {Array} items
 * @param {number} max — верхняя граница длины списка
 * @param {Function} [mapFn] — кастомный конвертер элемента в строку
 */
function formatList(items, max, mapFn) {
  if (!Array.isArray(items) || !items.length) return '';
  const out = items
    .slice(0, max)
    .map(mapFn || ensureString)
    .map(s => (s || '').trim())
    .filter(Boolean)
    .map(s => `- ${s}`);
  return out.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Style Card — нишевая адаптивность без LLM-вызовов.
// Эвристики строятся из detected_business_type + demand_map.
// ────────────────────────────────────────────────────────────────────

/**
 * BUSINESS_STYLE_PRESETS — словарь нишевых пресетов (тон, доказательства, табу).
 * Если detected_business_type содержит соответствующий ключ как подстроку
 * (case-insensitive), пресет применяется.
 */
const BUSINESS_STYLE_PRESETS = [
  {
    match:   ['медиц', 'клиник', 'стоматол', 'врач', 'health', 'medical'],
    label:   'Медицина / здоровье (YMYL)',
    tone:    'экспертно-аккуратный, без обещаний излечения',
    proofs:  'клинические протоколы, лицензии, опыт врачей, ссылки на исследования',
    taboos:  'не давать гарантий 100%-результата; не указывать конкретные дозировки без оговорки про консультацию; избегать «лучший / №1»',
  },
  {
    match:   ['финанс', 'банк', 'инвест', 'кредит', 'fintech', 'bank', 'invest'],
    label:   'Финансы (YMYL)',
    tone:    'строго-фактический, без эмоций; ссылки на регуляции',
    proofs:  'лицензии, цифры из отчётности, ссылки на ЦБ/регуляторов, реальные ставки',
    taboos:  'не гарантировать доходность; не использовать «лёгкие деньги», «без риска»; не давать индивидуальных инвест-советов',
  },
  {
    match:   ['юрид', 'адвокат', 'legal', 'law'],
    label:   'Юридические услуги (YMYL)',
    tone:    'формальный, ссылки на нормы',
    proofs:  'статьи кодексов, судебная практика, кейсы клиентов',
    taboos:  'не давать гарантий исхода дела; не использовать «100%-выигрыш»',
  },
  {
    match:   ['saas', 'b2b', 'enterprise', 'crm', 'erp'],
    label:   'B2B / SaaS',
    tone:    'структурно-аналитический, ROI-ориентированный',
    proofs:  'кейсы с цифрами, бенчмарки, интеграции, security-сертификаты',
    taboos:  'не использовать бытовых аналогий; не «продавать» — фокус на TCO/ROI',
  },
  {
    match:   ['e-comm', 'ecommerce', 'магазин', 'shop', 'retail'],
    label:   'E-commerce / ритейл',
    tone:    'практично-цепкий, с акцентом на цены/доставку/гарантии',
    proofs:  'отзывы покупателей, рейтинги, фотографии, сроки и условия',
    taboos:  'не злоупотреблять «скидка только сегодня»; явно указывать итоговую стоимость',
  },
  {
    match:   ['строит', 'инженер', 'engineering', 'промышл', 'industrial'],
    label:   'Инжиниринг / промышленность',
    tone:    'практикующий инженер: схемы, нормативы, допуски',
    proofs:  'ГОСТ/СНИП/ISO, реальные параметры, чертежи, замеры',
    taboos:  'не использовать маркетинговую «вода»; цифры без диапазона запрещены',
  },
  {
    match:   ['туризм', 'travel', 'тур', 'отел'],
    label:   'Туризм',
    tone:    'живой, эмоционально-описательный, конкретный по логистике',
    proofs:  'фото, отзывы туристов, цены, сезонность, документы',
    taboos:  'не приукрашивать описания; явно про визу/документы',
  },
  {
    match:   ['недвиж', 'realty', 'estate', 'аренд'],
    label:   'Недвижимость',
    tone:    'фактический: метраж, документы, район, инфраструктура',
    proofs:  'цены за м², выписки, инфраструктура, транспортная доступность',
    taboos:  'не «инвестиция века»; не гарантировать рост стоимости',
  },
];

/**
 * detectBusinessPreset — подбирает нишевый пресет по detected_business_type.
 * @param {string} businessType
 * @returns {object|null}
 */
function detectBusinessPreset(businessType) {
  const bt = (businessType || '').toLowerCase();
  if (!bt) return null;
  for (const preset of BUSINESS_STYLE_PRESETS) {
    if (preset.match.some(token => bt.includes(token))) {
      return preset;
    }
  }
  return null;
}

/**
 * buildStyleCard — строит короткую (~250-300 слов) «карточку стиля».
 * Эвристика, не LLM-вызов. Вход:
 *   - businessType (из targetPageAnalysis.detected_business_type)
 *   - intentMix (из strategyContext.demand_map.demand_by_journey, если есть)
 *
 * @param {object} opts
 * @param {string} [opts.businessType]
 * @param {object} [opts.strategyContext]
 * @param {string} [opts.audienceText]
 * @returns {string}
 */
function buildStyleCard({ businessType = '', strategyContext = null, audienceText = '' } = {}) {
  const preset = detectBusinessPreset(businessType);

  const lines = [];
  lines.push(`Тип ниши: ${preset?.label || businessType || 'не классифицирован'}`);
  lines.push(`Тон голоса: ${preset?.tone || 'экспертный, конкретный, без воды и канцелярита'}`);
  lines.push(`Формат доказательств: ${preset?.proofs || 'кейсы, цифры, ссылки на стандарты, отзывы клиентов'}`);
  if (preset?.taboos) {
    lines.push(`Запрещено: ${preset.taboos}`);
  } else {
    lines.push('Запрещено: маркетинговые штампы («лидер», «лучший», «инновационный»), пустые усиления, неподтверждённые цифры.');
  }

  // Микс намерений из demand_map (если есть)
  const dm = strategyContext?.demand_map;
  if (dm && Array.isArray(dm.demand_by_journey) && dm.demand_by_journey.length) {
    const stages = dm.demand_by_journey
      .slice(0, 4)
      .map(j => `${j.stage}`)
      .filter(Boolean);
    if (stages.length) {
      lines.push(`Стадии воронки в фокусе: ${stages.join(' → ')}`);
    }
  }

  // Краткая выжимка про аудиторию (одной строкой)
  if (audienceText) {
    const shortAudience = sliceWords(audienceText.replace(/\s+/g, ' '), 35);
    lines.push(`Аудитория (короткая выжимка): ${shortAudience}`);
  }

  return sliceWords(lines.join('\n'), LIMITS.styleCard);
}

// ────────────────────────────────────────────────────────────────────
// Главная функция-аггрегатор
// ────────────────────────────────────────────────────────────────────

/**
 * buildArticleKnowledgeBase — собирает финальный AKB-документ.
 *
 * @param {object} input
 * @param {object} input.task                        — строка tasks из БД
 * @param {object} [input.targetPageAnalysis]        — результат analyzeTargetPage
 * @param {object} [input.audienceNicheAnalysis]    — результат analyzeAudienceAndNiche
 * @param {object} [input.strategyContext]           — результат runPreStage0
 * @param {object} [input.stage0Result]              — результат runStage0
 * @param {object} [input.stage1Result]              — результат runStage1 (enriched)
 * @param {object} [input.knowledgeGraph]            — { nodes, edges }
 * @returns {string} Markdown-документ AKB
 */
function buildArticleKnowledgeBase(input = {}) {
  const {
    task = {},
    targetPageAnalysis  = null,
    audienceNicheAnalysis = null, // зарезервировано: использовать через task.__*Text
    strategyContext     = null,
    stage0Result        = null,
    stage1Result        = null,
    knowledgeGraph      = null,
    moduleContext       = null,
  } = input;

  // Реальные тексты аудитории/ниши приходят как сериализованные
  // строки на task.__* (см. audienceNicheAnalyzer.serializeAnalysisForPrompt).
  const personasText    = ensureString(task.__audiencePersonasText);
  const nicheDeepDive   = ensureString(task.__nicheDeepDiveText);
  const contentVoice    = ensureString(task.__contentVoiceText);
  const nicheTerminology = ensureString(task.__nicheTerminologyText);

  const brandName    = ensureString(task.input_brand_name);
  const targetService = ensureString(task.input_target_service);
  const region       = ensureString(task.input_region) || 'Россия';
  const audience     = ensureString(task.input_target_audience) || personasText;
  const minChars     = parseInt(task.input_min_chars, 10) || 800;
  const maxChars     = parseInt(task.input_max_chars, 10) || 3500;
  const projectLimits = ensureString(task.input_project_limits);
  const businessType  = ensureString(task.input_business_type) || ensureString(targetPageAnalysis?.detected_business_type);

  const brandFacts   = pickFirstNonEmpty(
    task.input_brand_facts,
    targetPageAnalysis?.brand_facts,
  );
  const serviceDetails = ensureString(targetPageAnalysis?.service_details);
  const proofAssets    = ensureString(targetPageAnalysis?.proof_assets);

  const sections = [];
  sections.push('# ARTICLE KNOWLEDGE BASE');
  sections.push(
    'Это единая база знаний для одной статьи. Все секции ниже — результат отдельной ' +
    'аналитической работы агентов Pre-Stage 0 → Stage 0 → Stage 1 + анализ целевой страницы + ' +
    'аудитория/ниша. Используй эту базу как ИСТОЧНИК ИСТИНЫ при генерации, рефайне и аудите. ' +
    'НЕ выдумывай факты, отсутствующие здесь. НЕ повторяй буквально — синтезируй.'
  );

  // ── 1. Brand & Offer ─────────────────────────────────────────────
  sections.push('\n## 1. Brand & Offer');
  if (brandName) sections.push(`- Бренд: ${brandName}`);
  if (targetService) sections.push(`- Основная услуга/тема: ${targetService}`);
  if (region) sections.push(`- География: ${region}`);
  if (brandFacts) {
    sections.push('### Факты о бренде');
    sections.push(sliceWords(brandFacts, LIMITS.brandFacts));
  }
  if (serviceDetails) {
    sections.push('### Детали услуги');
    sections.push(sliceWords(serviceDetails, LIMITS.serviceDetails));
  }
  if (proofAssets) {
    sections.push('### Доказательства доверия (proof assets)');
    sections.push(sliceWords(proofAssets, LIMITS.proofAssets));
  }
  if (!brandName && !brandFacts && !serviceDetails) {
    sections.push('_Нет данных о бренде/оффере._');
  }

  // ── 2. Audience Personas ────────────────────────────────────────
  sections.push('\n## 2. Audience Personas');
  if (personasText) {
    sections.push(sliceWords(personasText, LIMITS.audiencePersonas));
  } else if (audience) {
    sections.push(`Краткое описание аудитории: ${sliceWords(audience, 80)}`);
  } else {
    sections.push('_Нет данных об аудитории._');
  }

  // ── 3. Voice & Terminology ──────────────────────────────────────
  sections.push('\n## 3. Voice & Terminology');
  if (contentVoice) {
    sections.push('### Тон голоса (Content Voice)');
    sections.push(sliceWords(contentVoice, LIMITS.contentVoice));
  }
  if (nicheTerminology) {
    sections.push('### Профессиональная терминология');
    sections.push(sliceWords(nicheTerminology, LIMITS.nicheTerminology));
  }
  // Сленг/обиходные синонимы из Stage 1C
  const languageMap = stage1Result?.language_map;
  if (languageMap && typeof languageMap === 'object' && !Array.isArray(languageMap)) {
    const entries = Object.entries(languageMap)
      .filter(([k, v]) => k && v)
      .slice(0, 12)
      .map(([k, v]) => `${k} ↔ ${v}`);
    if (entries.length) {
      sections.push('### Сленг / обиходные синонимы (Community Voice)');
      sections.push(entries.map(e => `- ${e}`).join('\n'));
    }
  }
  if (!contentVoice && !nicheTerminology && !languageMap) {
    sections.push('_Нет данных о голосе/терминологии._');
  }

  // ── 4. Niche Deep Dive ──────────────────────────────────────────
  sections.push('\n## 4. Niche Deep Dive');
  if (nicheDeepDive) {
    sections.push(sliceWords(nicheDeepDive, LIMITS.nicheDeepDive));
  } else {
    sections.push('_Нет глубокого анализа ниши._');
  }

  // ── 5. Strategic Context ────────────────────────────────────────
  sections.push('\n## 5. Strategic Context');
  if (strategyContext) {
    // Используем существующий buildStrategyDigest (уже отлажен и применяется в Stage 0/1/2).
    // buildStrategyDigest принимает лимит в СИМВОЛАХ. Переводим из слов:
    // средняя длина русского слова ~5.8 символов + пробел ≈ 6.8, округлили до 6
    // (консервативно: при недооценке лимита просто получим чуть более короткий
    // digest, что не ломает AKB). Финальная обрезка по словам — ниже через sliceWords.
    const digest = buildStrategyDigest(strategyContext, LIMITS.strategyDigest * 6);
    if (digest) {
      sections.push(sliceWords(digest, LIMITS.strategyDigest));
    } else {
      sections.push('_Strategy context пуст._');
    }
  } else {
    sections.push('_Нет стратегического контекста (Pre-Stage 0)._');
  }

  // ── 6. SERP Reality & Gaps ──────────────────────────────────────
  sections.push('\n## 6. SERP Reality & Gaps');
  if (stage0Result) {
    const lines = [];
    if (Array.isArray(stage0Result.content_gaps) && stage0Result.content_gaps.length) {
      lines.push(`### Content gaps (что упущено конкурентами)\n${formatList(stage0Result.content_gaps, 8)}`);
    }
    if (Array.isArray(stage0Result.white_space_opportunities) && stage0Result.white_space_opportunities.length) {
      lines.push(`### White-space opportunities\n${formatList(stage0Result.white_space_opportunities, 6)}`);
    }
    if (Array.isArray(stage0Result.competitor_facts) && stage0Result.competitor_facts.length) {
      const facts = stage0Result.competitor_facts
        .map(f => (typeof f === 'string' ? f : (f.fact || JSON.stringify(f))))
        .filter(Boolean)
        .slice(0, 12);
      lines.push(`### Факты конкурентов (что они указали)\n${formatList(facts, 12)}`);
    }
    if (Array.isArray(stage0Result.trust_triggers) && stage0Result.trust_triggers.length) {
      lines.push(`### Триггеры доверия (часто встречающиеся в SERP)\n${formatList(stage0Result.trust_triggers, 8)}`);
    }
    const joined = lines.join('\n\n');
    sections.push(sliceWords(joined || '_Нет данных Stage 0._', LIMITS.serpReality + LIMITS.competitorFacts));
  } else {
    sections.push('_Нет данных Stage 0._');
  }

  // ── 7. Required Entities (Knowledge Graph top-N) ────────────────
  sections.push('\n## 7. Required Entities');
  if (knowledgeGraph && Array.isArray(knowledgeGraph.nodes) && knowledgeGraph.nodes.length) {
    // Сортируем по salience desc для стабильности.
    const sorted = [...knowledgeGraph.nodes]
      .filter(n => n && n.label)
      .sort((a, b) => (b.salience || 0) - (a.salience || 0))
      .slice(0, 30);
    const formatted = sorted
      .map(n => `${n.label}${n.type ? ` [${n.type}]` : ''}`)
      .join(', ');
    sections.push(sliceWords(`Сущности (top-30 по salience): ${formatted}`, LIMITS.requiredEntities));
  } else if (Array.isArray(stage1Result?.entities) && stage1Result.entities.length) {
    const ent = stage1Result.entities.slice(0, 30).map(ensureString).filter(Boolean).join(', ');
    sections.push(sliceWords(`Сущности: ${ent}`, LIMITS.requiredEntities));
  } else {
    sections.push('_Нет данных Knowledge Graph._');
  }

  // ── 8. Community Voice ──────────────────────────────────────────
  sections.push('\n## 8. Community Voice (боли и вопросы аудитории)');
  const pains = stage1Result?.pain_points;
  const questions = stage1Result?.user_questions;
  let communityAdded = false;
  if (Array.isArray(pains) && pains.length) {
    const painList = pains
      .slice(0, 10)
      .map(p => {
        if (typeof p === 'string') return p;
        const txt = p.pain || p.trigger_phrase || p.text || '';
        return txt;
      })
      .filter(Boolean);
    if (painList.length) {
      sections.push(`### Боли аудитории\n${formatList(painList, 10)}`);
      communityAdded = true;
    }
  }
  if (Array.isArray(questions) && questions.length) {
    const qList = questions
      .slice(0, 10)
      .map(q => {
        if (typeof q === 'string') return q;
        return q.question || q.text || '';
      })
      .filter(Boolean);
    if (qList.length) {
      sections.push(`### Реальные вопросы пользователей\n${formatList(qList, 10)}`);
      communityAdded = true;
    }
  }
  if (!communityAdded) {
    sections.push('_Нет данных Community Voice._');
  }

  // Применяем word-cap на склеенный community-блок
  // (отдельно, потому что pains+questions могут быть большими)
  // — но т.к. оба уже обрезаны по 10 элементов, дальнейшая обрезка не нужна.

  // ── 9. Style Card (нишевая адаптивность) ─────────────────────────
  sections.push('\n## 9. Style Card (как писать в этой нише)');
  sections.push(buildStyleCard({
    businessType,
    strategyContext,
    audienceText: audience,
  }));

  // ── 10. Hard Constraints ────────────────────────────────────────
  sections.push('\n## 10. Hard Constraints');
  const hard = [];
  if (brandName)     hard.push(`Использовать бренд: ${brandName}`);
  if (region)        hard.push(`Регион/география: ${region}`);
  hard.push(`Длина блока (символы): мин ${minChars}, макс ${maxChars}.`);
  if (projectLimits) hard.push(`Ограничения проекта:\n${sliceWords(projectLimits, 200)}`);
  sections.push(hard.join('\n'));

  // ── 11. Module Context (Module 1+2 — детерминированные constraints) ─
  // Pure-derive поверх Stage 0/1/2 (см. backend/src/utils/moduleContext.js).
  // Hard-constraints для writer'а: какие сущности обязательны, какие
  // термины опасны, какой format wedge выбран, какие claims надо доказать.
  if (moduleContext) {
    try {
      const { formatModuleContextForAKB } = require('./moduleContext');
      const md = formatModuleContextForAKB(moduleContext);
      if (md && md.trim()) {
        sections.push('\n## 11. Module Context — hard analytical constraints');
        sections.push(md);
      }
    } catch (_) {
      // graceful: если файл отсутствует/сломан — просто без §11
    }
  }

  return sections.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Helpers для stage3/5/6 — собирают опции callLLM так, чтобы AKB
// уезжал в Gemini как нативный systemInstruction (или через cachedContent),
// и подключают graceful fallback на cache miss.
// ────────────────────────────────────────────────────────────────────

/**
 * geminiCallOpts — собирает доп. опции для callLLM('gemini'):
 *   - cachedContent: имя кэша, если он создан
 *   - tokenBudget:   per-task бюджет input-токенов
 *   - onCacheMiss:   обнуление имени кэша на task при HTTP 404
 *
 * Сам текст AKB передаётся positional `system` через `akbSystem(task)`.
 *
 * @param {object} task
 * @param {object} [extra] — дополнительные опции для merge
 */
function geminiCallOpts(task, extra = {}) {
  const opts = { ...extra };
  // cachedContent — только для Gemini. Для Grok игнорируем (cachedContents
  // у x.ai отсутствует) — callLLM сам пропустит при adapter='grok'.
  if (task?.__geminiCacheName) opts.cachedContent = task.__geminiCacheName;
  if (task?.__tokenBudget)     opts.tokenBudget   = task.__tokenBudget;
  if (task?.__geminiCacheName) {
    opts.onCacheMiss = () => { task.__geminiCacheName = null; };
  }
  return opts;
}

/**
 * akbSystem — возвращает строку для positional `system` аргумента callLLM.
 * Когда Gemini-кэш активен — возвращаем '' (AKB уже в кэше). Для Grok
 * (или когда кэш не используется) — возвращаем сам AKB как system-promt.
 */
function akbSystem(task) {
  if (!task) return '';
  // Если Gemini cache активен И провайдер всё ещё gemini — кэш покрывает AKB.
  // Для Grok нет cachedContent, поэтому всегда передаём AKB как system.
  const provider = (task?.llm_provider || 'gemini').toLowerCase();
  if (provider === 'gemini' && task.__geminiCacheName) return '';
  return task.__articleKnowledgeBase || '';
}

/**
 * llmProvider — нормализованный провайдер для задачи.
 * Возвращает 'gemini' (default) или 'grok'. Используется как первый
 * аргумент callLLM() во всех Stage-вызовах текстовой генерации.
 */
function llmProvider(task) {
  const p = (task?.llm_provider || 'gemini').toString().toLowerCase().trim();
  return p === 'grok' ? 'grok' : 'gemini';
}

module.exports = {
  buildArticleKnowledgeBase,
  buildStyleCard,
  detectBusinessPreset,
  geminiCallOpts,
  akbSystem,
  llmProvider,
  // экспортируем для возможных юнит-тестов / переиспользования
  _internal: { sliceWords, ensureString, formatList },
};
