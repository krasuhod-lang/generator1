'use strict';

const { normalizeWord, STOP_WORDS } = require('./semantics');

/**
 * metaTags/metaContext — детерминированное обогащение входов GIST-пайплайна.
 *
 * GIST Meta Filter умеет читать `pageAngle` и `missingNodes`
 * (gistMetaFilter._buildCandidateUserPrompt), но при массовой генерации эти
 * поля всегда оставались пустыми, и модель извлекала факты только из summary
 * и brand. Здесь они собираются БЕЗ дополнительных LLM-вызовов — из уже
 * посчитанных ctrAnalysis (serpCtrAnalyzer) и snippetAnalysis
 * (snippetAnalyzer).
 *
 * См. ТЗ «Максимальная кликабельность мета-тегов» §4.
 */

const MAX_MISSING_NODES = 8; // GIST всё равно режет до 8 — не раздуваем промпт
const MAX_AVOID_PATTERNS = 5; // редакторские запреты: длинный список бесполезен

const INTENT_LABELS = {
  Commercial: 'коммерческий интент (выбор и покупка)',
  'Commercial/Transactional': 'коммерческий интент (выбор и покупка)',
  Informational: 'информационный интент (разбор и объяснение)',
  'Informational/Research': 'информационный интент (разбор и объяснение)',
  Comparison: 'сравнительный интент (выбор между вариантами)',
  'Mixed/Unclear': 'смешанный интент',
};

const INTENT_MARKERS = {
  commercial: /купить|заказать|цена|стоимость|доставк|заявк|подобрать|условия|монтаж|услуг[аи]|каталог|рассчитать|оформить/i,
  informational: /как\b|почему|что такое|инструкц|разбор|обзор|объясн|пошаг|совет|правил|ошибк|причин|когда|зачем/i,
  comparison: /сравн|отличи|разниц|против|\bvs\b|выбрать|критери|плюс[ыа]|минус[ыа]|лучше для/i,
};

const GIST_HEURISTICS = {
  failure_mode: /ошибк|риск|проблем|сбой|полом|потер|ошибоч|неправильн|осложнен/i,
  hidden_info: /важно учесть|часто не учитыва|скрыт|заранее|после покуп|мало кто|неочевидн|учтите/i,
  limitation: /не подходит|ограничен|только если|нельзя|не рекомендуется|зависит от|при условии|исключени/i,
  disqualifier: /не выбирайте|не стоит|не используйте|противопоказ|не совместим|не применим|кому не подойд/i,
  quantifiable: /\d[\d\s.,]*(?:%|₽|руб|лет|год|дн|час|мин|кг|м²|м2|шт|мм|см|м)(?=\s|$|[.,;:!?])/i,
};

function _clean(str, limit = 300) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function _plainText(html, plain) {
  return String(plain || html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _countMatches(text, re) {
  const flags = `${re.flags.includes('i') ? 'i' : ''}g`;
  return (String(text || '').match(new RegExp(re.source, flags)) || []).length;
}

function _unique(values, limit = 4) {
  return Array.from(new Set(values.map((v) => _clean(v, 220)).filter(Boolean))).slice(0, limit);
}

function _sentenceSignals(text, re, limit = 3) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => _clean(s, 240))
    .filter((s) => s.length >= 25);
  return _unique(sentences.filter((s) => re.test(s)), limit);
}

function _extractFactualAnchors(text) {
  const out = [];
  const t = String(text || '');
  const numeric = t.match(/\b\d[\d\s.,]*(?:%|₽|руб(?:лей)?|лет|год(?:а|ов)?|дн(?:я|ей)?|час(?:а|ов)?|мин(?:ут)?|кг|м²|м2|шт|мм|см|м)(?=\s|$|[.,;:!?])/gi) || [];
  out.push(...numeric);
  const named = t.match(/\b(?:ГОСТ|ISO|IEC|СНиП|СП|Aqua\s+Stop|E-E-A-T|LSI|API)\s*[A-Za-zА-Яа-я0-9._-]*/gi) || [];
  out.push(...named);
  return _unique(out, 10);
}

function _normalizeIntent(value, fallback = 'Informational/Research') {
  const v = String(value || '').toLowerCase();
  if (/compar|сравн|vs|против/.test(v)) return 'Comparison';
  if (/commercial|transaction|коммерч|покуп|заказ|продаж/.test(v)) return 'Commercial/Transactional';
  if (/inform|research|информац|исслед|обзор|разбор/.test(v)) return 'Informational/Research';
  if (/mixed|unclear|смешан/.test(v)) return 'Mixed/Unclear';
  return fallback;
}

/**
 * buildGistSignals — компактный deterministic contract для GIST meta prompts.
 * Сигналы извлекаются из уже готовой страницы и не являются доказательствами
 * сами по себе: LLM обязан подтвердить выбранный факт по page context.
 */
function buildGistSignals({
  keyword = '', articleType = '', articleHtml = '', plain = '', inputs = {},
  intentHint = '', intentContract = null, ctrAnalysis = null,
} = {}) {
  const text = _plainText(articleHtml, plain).slice(0, 18000);
  const explicit = intentContract?.value || intentContract?.intent || intentHint
    || ctrAnalysis?.serp_intent?.value || '';
  const commercial = _countMatches(`${keyword} ${text}`, INTENT_MARKERS.commercial);
  const informational = _countMatches(`${keyword} ${text}`, INTENT_MARKERS.informational);
  // Comparison section inside an informational article is supporting evidence,
  // not automatically the page intent. Primary comparison is inferred from the
  // query/explicit intent only; this prevents a single H2 from intent drift.
  const comparison = _countMatches(`${keyword} ${intentHint} ${intentContract?.value || ''}`, INTENT_MARKERS.comparison);
  const strongCommercialSignal = articleType === 'link'
    ? commercial > informational + 4
    : commercial > informational + 1;
  const intent = _normalizeIntent(explicit, comparison >= 2
    ? 'Comparison'
    : strongCommercialSignal
      ? 'Commercial/Transactional'
      : 'Informational/Research');
  const confidence = explicit
    ? 0.9
    : Math.min(0.9, 0.55 + Math.min(0.3, Math.abs(commercial - informational) * 0.05));
  const intentContractOut = {
    value: intent,
    label: INTENT_LABELS[intent] || INTENT_LABELS.Informational,
    confidence: Number(confidence.toFixed(2)),
    article_type: articleType || 'article',
    decision_stage: intent === 'Commercial/Transactional' || intent === 'Comparison'
      ? 'choice_or_transaction' : 'research_and_understanding',
    page_job: intent === 'Commercial/Transactional'
      ? 'помочь выбрать или выполнить целевое действие на странице'
      : intent === 'Comparison'
        ? 'показать критерии различия и помочь выбрать вариант'
        : 'быстро ответить на вопрос, снять неопределённость и предотвратить ошибку',
    wrong_click_to_prevent: articleType === 'link'
      ? 'не обещать продажу на донорской странице; дать самостоятельную пользу и честно подготовить переход по анкору'
      : 'не привлекать пользователя обещанием, которого нет в статье',
  };

  const heuristicNodes = {};
  for (const [name, re] of Object.entries(GIST_HEURISTICS)) {
    heuristicNodes[name] = _sentenceSignals(text, re, 3);
  }

  const headings = [];
  const headingRe = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]\s*>/gi;
  let match;
  while ((match = headingRe.exec(String(articleHtml || ''))) !== null && headings.length < 8) {
    const title = _clean(match[1].replace(/<[^>]+>/g, ' '), 140);
    if (title) headings.push(title);
  }

  return {
    intent_contract: intentContractOut,
    heuristic_nodes: heuristicNodes,
    factual_anchors: _extractFactualAnchors(text),
    distinctive_sections: _unique(headings, 8),
    intent_signal_counts: { commercial, informational, comparison },
    input_facts: _unique([
      inputs.summary,
      inputs.brandFacts,
      inputs.page_context,
    ], 5),
  };
}

/**
 * Строит компактную семантику из самой статьи для no-SERP режимов (в первую
 * очередь linkArticle). Это не заменяет SERP semantics: terms остаются
 * candidate vocabulary и проходят intent/readability validation в GIST.
 */
function buildArticleSemantics({ keyword = '', articleHtml = '', plain = '', headings = [] } = {}) {
  const text = _plainText(articleHtml, plain).toLowerCase();
  const headingText = Array.isArray(headings) ? headings.join(' ').toLowerCase() : '';
  const keywordStems = new Set(
    String(keyword || '').toLowerCase().match(/[а-яёa-z0-9-]{4,}/g)?.map(normalizeWord) || [],
  );
  const generic = new Set([
    'статья', 'тема', 'разбор', 'материал', 'информация', 'сайт', 'способ',
    'вариант', 'пример', 'вопрос', 'ответ', 'начало', 'часть', 'итог',
  ].map(normalizeWord));
  const counts = new Map();
  const tokens = text.match(/[а-яёa-z0-9-]{4,}/g) || [];
  tokens.forEach((raw) => {
    const stem = normalizeWord(raw);
    if (!stem || STOP_WORDS.has(stem) || generic.has(stem) || keywordStems.has(stem)) return;
    const bonus = headingText.includes(raw) ? 3 : 1;
    const previous = counts.get(stem) || { word: raw, score: 0 };
    previous.score += bonus;
    counts.set(stem, previous);
  });
  const ranked = [...counts.values()]
    .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word, 'ru'))
    .map((x) => x.word)
    .filter(Boolean);
  const keywordValue = String(keyword || '').trim();
  const titleWords = [keywordValue, ...ranked.slice(0, 3)].filter(Boolean);
  const descriptionWords = ranked.slice(0, 10);
  return {
    title_mandatory_words: titleWords.slice(0, 6),
    description_mandatory_words: descriptionWords,
    obligatory_lsi: ranked.slice(0, 5),
    differentiator_lsi: ranked.slice(5, 10),
  };
}

/**
 * Синтезирует page angle страницы: «страница закрывает {интент} по {ниша}
 * в {топоним} с опорой на {УТП}». Полностью детерминированно.
 *
 * @param {object} args
 * @param {string} [args.keyword]
 * @param {object} [args.inputs]      — { niche, toponym, brand, summary }
 * @param {object} [args.ctrAnalysis] — результат analyzeSerpCtr
 * @returns {string} '' если данных нет вовсе
 */
function buildPageAngle({ keyword = '', inputs = {}, ctrAnalysis = null } = {}) {
  const niche = _clean(inputs.niche || keyword, 120);
  if (!niche) return '';

  const intentValue = (ctrAnalysis && ctrAnalysis.serp_intent && ctrAnalysis.serp_intent.value) || '';
  const intentLabel = INTENT_LABELS[intentValue] || '';
  const toponym = _clean(inputs.toponym, 60);
  const brand = _clean(inputs.brand, 60);
  const usp = _clean(inputs.summary || inputs.page_context, 220);

  const parts = [`Страница закрывает ${intentLabel || 'спрос'} по теме «${niche}»`];
  if (toponym) parts.push(`в регионе ${toponym}`);
  if (brand) parts.push(`от бренда ${brand}`);
  if (usp) parts.push(`с опорой на: ${usp}`);
  return parts.join(' ');
}

/**
 * Собирает missing semantic nodes — смысловые узлы, которых НЕТ у ТОП-10.
 * Это СЫРЬЁ ДЛЯ ФАКТОВ: GIST-пайплайн ставит их первыми кандидатами, поэтому
 * сюда попадает только то, о чём можно написать в сниппете.
 *
 * Инструкции «не повторять штамп X» сюда НЕ попадают: раньше они лежали в том
 * же списке, модель принимала их за факты и писала о собственном процессе
 * отбора («отсеиваем рекламный шум»). Запреты собирает buildAvoidPatterns.
 *
 * Источники:
 *   (а) differentiator_lsi — смыслов нет ни у одного конкурента;
 *   (б) пробелы ТОПа: цена / гео / год, релевантные нашей странице.
 *
 * @param {object} args
 * @param {object} [args.inputs]          — { toponym, price_data, brand }
 * @param {object} [args.semantics]       — extractSemantics()
 * @param {object} [args.ctrAnalysis]     — analyzeSerpCtr()
 * @returns {string[]} до MAX_MISSING_NODES узлов
 */
function buildMissingNodes({
  inputs = {}, semantics = {}, ctrAnalysis = null,
} = {}) {
  const nodes = [];
  const gistSignals = inputs.gistSignals || null;
  const heuristicLabels = {
    failure_mode: 'Failure mode из статьи',
    hidden_info: 'Hidden information из статьи',
    limitation: 'Ограничение из статьи',
    disqualifier: 'Disqualifier из статьи',
    quantifiable: 'Проверяемый измеримый факт из статьи',
  };
  if (gistSignals && gistSignals.heuristic_nodes) {
    for (const key of Object.keys(heuristicLabels)) {
      const value = gistSignals.heuristic_nodes[key]?.[0];
      if (value) nodes.push(`${heuristicLabels[key]}: ${value}`);
    }
  }

  // (а) Уникальные LSI — их нет ни у одного конкурента.
  const differentiators = (semantics.differentiator_lsi || []).filter(Boolean).slice(0, 3);
  if (differentiators.length) {
    nodes.push(`Смыслы, отсутствующие у всего ТОПа: ${differentiators.join(', ')}`);
  }

  const patterns = (ctrAnalysis && ctrAnalysis.patterns) || {};

  // (б) Пробелы выдачи — только те, что мы реально можем закрыть фактом.
  const priceData = inputs.price_data ?? inputs.priceData ?? null;
  if (priceData && (patterns.exact_price_title_frequency ?? 1) < 0.3) {
    nodes.push(`Конкретной цены нет в сниппетах ТОПа, а у нас она подтверждена: ${_clean(priceData, 120)}`);
  }
  if (inputs.toponym && (patterns.geo_frequency ?? 1) < 0.4) {
    nodes.push(`Гео-привязка (${_clean(inputs.toponym, 60)}) почти не используется конкурентами`);
  }
  if ((patterns.year_frequency ?? 1) < 0.3 && String(inputs.current_year ?? '').trim()) {
    nodes.push(`Актуальность (год ${String(inputs.current_year).trim()}) не заявлена у конкурентов`);
  }

  return nodes.map((n) => _clean(n, 240)).filter(Boolean).slice(0, MAX_MISSING_NODES);
}

/**
 * Собирает анти-паттерны выдачи — то, что НЕЛЬЗЯ повторять, чтобы не слиться
 * с ТОПом. Это редакторские ограничения, а не факты о странице: они уходят в
 * промпт отдельным блоком «не повторять» и никогда не становятся кандидатами.
 *
 * @param {object} args
 * @param {object} [args.ctrAnalysis]     — analyzeSerpCtr()
 * @param {object} [args.snippetAnalysis] — analyzeSnippets()
 * @returns {string[]} до MAX_AVOID_PATTERNS пунктов
 */
function buildAvoidPatterns({ ctrAnalysis = null, snippetAnalysis = null } = {}) {
  const out = [];
  const patterns = (ctrAnalysis && ctrAnalysis.patterns) || {};

  const prefixes = (patterns.common_prefixes || []).filter(Boolean).slice(0, 2);
  const suffixes = (patterns.common_suffixes || []).filter(Boolean).slice(0, 2);
  if (prefixes.length || suffixes.length) {
    out.push(
      'Анти-паттерны ТОПа (не повторять): '
      + [...prefixes.map((p) => `начало «${p}…»`), ...suffixes.map((x) => `хвост «…${x}»`)].join('; '),
    );
  }
  const cliches = (snippetAnalysis && (snippetAnalysis.competitor_cliches
    || snippetAnalysis.competitor_noise)) || [];
  if (cliches.length) {
    out.push(`Клише и штампы конкурентов (не повторять): ${cliches.slice(0, 5).join('; ')}`);
  }
  const lexicon = (snippetAnalysis && snippetAnalysis.niche_lexicon) || [];
  if (lexicon.length) {
    out.push(
      `Общая лексика ниши (использовать можно, но это НЕ дифференциатор): ${lexicon.slice(0, 5).join('; ')}`,
    );
  }
  if ((patterns.cta_frequency ?? 1) < 0.3) {
    out.push('CTA в description редок у конкурентов — уместный призыв выделит сниппет');
  }

  return out.map((n) => _clean(n, 240)).filter(Boolean).slice(0, MAX_AVOID_PATTERNS);
}

/**
 * Обогащает inputs полями pageAngle / missingNodes / avoidPatterns. Явно
 * переданные article-specific nodes сохраняются первыми, а deterministic GIST
 * signals добавляются без дублей и с общим лимитом.
 *
 * @returns {object} новый объект inputs
 */
function enrichMetaInputs({
  keyword = '', inputs = {}, semantics = {}, ctrAnalysis = null, snippetAnalysis = null,
} = {}) {
  const out = { ...inputs };
  if (!out.gistSignals || !out.intentContract) {
    const signals = buildGistSignals({
      keyword,
      articleType: out.articleType || out.pageType || '',
      articleHtml: out.articleHtml || '',
      plain: out.articlePlain || out.plain || '',
      inputs: out,
      intentHint: out.intentHint || out.intent_hint || '',
      intentContract: out.intentContract || out.intent_contract || null,
      ctrAnalysis,
    });
    if (!out.gistSignals) out.gistSignals = signals;
    if (!out.intentContract) out.intentContract = signals.intent_contract;
  }
  if (!String(out.pageAngle || out.page_angle || '').trim()) {
    const angle = buildPageAngle({ keyword, inputs: out, ctrAnalysis });
    if (angle) out.pageAngle = angle;
  }
  const existingNodes = Array.isArray(out.missingNodes || out.missing_nodes)
    ? (out.missingNodes || out.missing_nodes).filter(Boolean) : [];
  const generatedNodes = buildMissingNodes({ inputs: out, semantics, ctrAnalysis });
  const mergedNodes = [...new Set([...existingNodes, ...generatedNodes])]
    .map((node) => _clean(node, 240))
    .filter(Boolean)
    .slice(0, MAX_MISSING_NODES);
  if (mergedNodes.length) out.missingNodes = mergedNodes;
  const existingAvoid = out.avoidPatterns || out.avoid_patterns;
  if (!Array.isArray(existingAvoid) || !existingAvoid.length) {
    const avoid = buildAvoidPatterns({ ctrAnalysis, snippetAnalysis });
    if (avoid.length) out.avoidPatterns = avoid;
  }
  return out;
}

module.exports = {
  buildPageAngle,
  buildMissingNodes,
  buildAvoidPatterns,
  buildGistSignals,
  buildArticleSemantics,
  enrichMetaInputs,
  MAX_MISSING_NODES,
  MAX_AVOID_PATTERNS,
};
