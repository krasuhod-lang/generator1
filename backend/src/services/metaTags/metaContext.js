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
 * Собирает missing semantic nodes — смысловые узлы, которых НЕТ у ТОП-10
 * (сырьё для отстройки от конкурентов), и анти-паттерны выдачи.
 *
 * Источники:
 *   (а) differentiator_lsi — слов нет ни у одного конкурента;
 *   (б) пробелы ТОПа: цена / гео / год / CTA, релевантные нашей странице;
 *   (в) анти-паттерны — штампованные начала/хвосты title и «шум» конкурентов.
 *
 * @param {object} args
 * @param {object} [args.inputs]          — { toponym, price_data, brand }
 * @param {object} [args.semantics]       — extractSemantics()
 * @param {object} [args.ctrAnalysis]     — analyzeSerpCtr()
 * @param {object} [args.snippetAnalysis] — analyzeSnippets()
 * @returns {string[]} до MAX_MISSING_NODES узлов
 */
function buildMissingNodes({
  inputs = {}, semantics = {}, ctrAnalysis = null, snippetAnalysis = null,
} = {}) {
  const nodes = [];

  // (а) Уникальные LSI — их нет ни у одного конкурента.
  const differentiators = (semantics.differentiator_lsi || []).filter(Boolean).slice(0, 3);
  if (differentiators.length) {
    nodes.push(`Смыслы, отсутствующие у всего ТОПа: ${differentiators.join(', ')}`);
  }

  const patterns = (ctrAnalysis && ctrAnalysis.patterns) || {};

  // (б) Пробелы выдачи — только те, что мы реально можем закрыть.
  const priceData = inputs.price_data ?? inputs.priceData ?? null;
  if (priceData && (patterns.exact_price_title_frequency ?? 1) < 0.3) {
    nodes.push(`Конкретной цены нет в сниппетах ТОПа, а у нас она подтверждена: ${_clean(priceData, 120)}`);
  }
  if (inputs.toponym && (patterns.geo_frequency ?? 1) < 0.4) {
    nodes.push(`Гео-привязка (${_clean(inputs.toponym, 60)}) почти не используется конкурентами`);
  }
  if ((patterns.cta_frequency ?? 1) < 0.3) {
    nodes.push('CTA в description редок у конкурентов — сильный призыв выделит сниппет');
  }
  if ((patterns.year_frequency ?? 1) < 0.3 && String(inputs.current_year ?? '').trim()) {
    nodes.push(`Актуальность (год ${String(inputs.current_year).trim()}) не заявлена у конкурентов`);
  }

  // (в) Анти-паттерны: что нельзя повторять, чтобы не слиться с ТОПом.
  const prefixes = (patterns.common_prefixes || []).filter(Boolean).slice(0, 2);
  const suffixes = (patterns.common_suffixes || []).filter(Boolean).slice(0, 2);
  if (prefixes.length || suffixes.length) {
    nodes.push(
      'Анти-паттерны ТОПа (не повторять): '
      + [...prefixes.map((p) => `начало «${p}…»`), ...suffixes.map((x) => `хвост «…${x}»`)].join('; '),
    );
  }
  const noise = (snippetAnalysis && snippetAnalysis.competitor_noise) || [];
  if (noise.length) {
    nodes.push(`Штампы конкурентов (не повторять): ${noise.slice(0, 5).join('; ')}`);
  }

  return nodes.map((n) => _clean(n, 240)).filter(Boolean).slice(0, MAX_MISSING_NODES);
}

/**
 * Обогащает inputs полями pageAngle / missingNodes, не затирая явно
 * переданные значения (пайплайны статей передают свои, более точные).
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
    const nodes = buildMissingNodes({ inputs: out, semantics, ctrAnalysis, snippetAnalysis });
    if (nodes.length) out.missingNodes = nodes;
  }
  return out;
}

module.exports = {
  buildPageAngle,
  buildMissingNodes,
  enrichMetaInputs,
  MAX_MISSING_NODES,
};
