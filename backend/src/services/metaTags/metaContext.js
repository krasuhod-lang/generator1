'use strict';

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
  Informational: 'информационный интент (разбор и объяснение)',
  'Mixed/Unclear': 'смешанный интент',
};

function _clean(str, limit = 300) {
  return String(str || '').replace(/\s+/g, ' ').trim().slice(0, limit);
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
 * Обогащает inputs полями pageAngle / missingNodes / avoidPatterns, не затирая
 * явно переданные значения (пайплайны статей передают свои, более точные).
 *
 * @returns {object} новый объект inputs
 */
function enrichMetaInputs({
  keyword = '', inputs = {}, semantics = {}, ctrAnalysis = null, snippetAnalysis = null,
} = {}) {
  const out = { ...inputs };
  if (!String(out.pageAngle || out.page_angle || '').trim()) {
    const angle = buildPageAngle({ keyword, inputs: out, ctrAnalysis });
    if (angle) out.pageAngle = angle;
  }
  const existingNodes = out.missingNodes || out.missing_nodes;
  if (!Array.isArray(existingNodes) || !existingNodes.length) {
    const nodes = buildMissingNodes({ inputs: out, semantics, ctrAnalysis });
    if (nodes.length) out.missingNodes = nodes;
  }
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
  enrichMetaInputs,
  MAX_MISSING_NODES,
  MAX_AVOID_PATTERNS,
};
