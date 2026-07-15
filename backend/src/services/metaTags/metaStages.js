'use strict';

/**
 * metaTags/metaStages — общий staged-хелпер генерации мета-тегов.
 *
 * Инкапсулирует ту же последовательность этапов, что и основной инструмент
 * мета-тегов (pipeline.js):
 *   1) fetchYandexSerp        — анализ поисковой выдачи (XMLStock)
 *   2) extractSemantics       — TF-IDF семантика конкурентов
 *   3) generateDrMaxMeta      — GIST Meta Filter Pipeline (11 шагов):
 *      кандидаты → фильтр/ранкер → пара title/description + conflict check
 *   4) checkLsiUsage          — LSI-верификация готовых тегов
 * + разовый buildAudienceNicheDigest (analyzeAudienceAndNiche), который
 *   запускается ОДИН раз на набор страниц/ключей.
 *
 * Вынесено отдельным модулем, чтобы переиспользовать и в инструменте мета-тегов
 * (pipeline.js), и в анализе проектов (projects/pageMetaAudit), не дублируя
 * логику этапов и LSI-проверки.
 */

const { fetchYandexSerp } = require('./xmlstockClient');
const { extractSemantics, checkLsiUsage, checkKeywordPosition } = require('./semantics');
const { generateDrMaxMeta } = require('./metaGenerator');
const { analyzeSerpCtr } = require('./serpCtrAnalyzer');
const { analyzeSnippets } = require('./snippetAnalyzer');
const {
  analyzeAudienceAndNiche,
  serializeAnalysisForPrompt,
} = require('../parser/audienceNicheAnalyzer');

/**
 * Прогоняет один ключ через все этапы генерации мета-тега и навешивает
 * lsi_check (как в pipeline.js). Сеть/LLM-ошибки пробрасываются наружу —
 * вызывающий решает, обрабатывать ли поштучно.
 *
 * @param {object} args
 * @param {string} args.keyword       — главный поисковый запрос страницы
 * @param {object} args.inputs        — контекст для generateDrMaxMeta
 *   (brand/phone/niche/toponym/summary/audienceNicheDigest/llm_provider…)
 * @param {string} [args.lr]          — регион Яндекса (lr) для SERP
 * @param {object} [args.semantics]   — предзаготовленная семантика (из GSC);
 *   если передана — обогащается семантикой выдачи, иначе строится из SERP
 * @returns {Promise<{serp:Array, semantics:object, metas:object}>}
 */
async function runMetaStagesForKeyword({ keyword, inputs = {}, lr = '', semantics = null } = {}) {
  // 1) SERP (анализ выдачи).
  const serp = await fetchYandexSerp(keyword, { lr });

  // 2) Семантика (TF-IDF). Если предзадана из GSC — объединяем со SERP-словами,
  //    не теряя приоритет реального спроса страницы.
  const serpSemantics = extractSemantics(keyword, serp) || {};
  const merged = semantics
    ? _mergeSemantics(semantics, serpSemantics)
    : serpSemantics;

  // 2.5) Анализ кликабельности выдачи (ТЗ §2.1) — детерминированный
  //      «фактчекинг конкурентов»: длины, CTA/USP/гео/год, формулы, штампы.
  //      Передаём в генератор как inputs.ctrAnalysis для усиления промпта.
  const ctrAnalysis = analyzeSerpCtr(serp, { keyword, semantics: merged });
  const snippetAnalysis = analyzeSnippets(serp);

  // 3) Gemini/Grok → Title + Description + H1.
  const metas = await generateDrMaxMeta({
    keyword,
    semantics: merged,
    serpData: serp,
    inputs: { ...inputs, ctrAnalysis, snippetAnalysis },
  });

  // 4) LSI-верификация по объединённому тексту Title + Description + H1.
  const combinedMetaText = [
    metas.title || '',
    metas.description || '',
    metas.h1 || '',
  ].join(' ');
  const lsiTitleCheck = checkLsiUsage(combinedMetaText, merged.title_mandatory_words || []);
  const lsiDescCheck = checkLsiUsage(combinedMetaText, merged.description_mandatory_words || []);
  // Двухуровневый LSI (ТЗ §2.3): отдельно проверяем «обязательные» и «дифференциаторы».
  const obligatoryCheck     = checkLsiUsage(combinedMetaText, merged.obligatory_lsi     || []);
  const differentiatorCheck = checkLsiUsage(combinedMetaText, merged.differentiator_lsi || []);
  const keywordPositionCheck = checkKeywordPosition(metas.title || '', keyword);

  metas.lsi_check = {
    title: lsiTitleCheck,
    description: lsiDescCheck,
    missed_lsi: [...lsiTitleCheck.missed_lsi, ...lsiDescCheck.missed_lsi],
    obligatory_used:        obligatoryCheck.used_lsi,
    obligatory_missed:      obligatoryCheck.missed_lsi,
    differentiators_used:   differentiatorCheck.used_lsi,
    differentiators_missed: differentiatorCheck.missed_lsi,
    keyword_position_ok:    keywordPositionCheck.ok,
    keyword_position:       keywordPositionCheck.position,
  };
  metas.ctr_analysis_used = {
    matched_obligatory_lsi:  obligatoryCheck.used_lsi,
    applied_differentiators: differentiatorCheck.used_lsi,
    formula: (ctrAnalysis && ctrAnalysis.recommendations && ctrAnalysis.recommendations.suggested_title_formula) || '',
  };

  // Заметки для UI: чего не хватает и почему важно.
  metas.post_validation_notes = Array.isArray(metas.post_validation_notes)
    ? metas.post_validation_notes : [];
  if (obligatoryCheck.missed_lsi.length) {
    const total = merged.serp_doc_count || (Array.isArray(serp) ? serp.length : 0);
    metas.post_validation_notes.push(
      `Пропущены обязательные LSI (есть у ≥50% ТОП-${total}): `
      + `${obligatoryCheck.missed_lsi.join(', ')} — без них ниже CTR.`,
    );
  }
  if ((merged.differentiator_lsi || []).length && !differentiatorCheck.used_lsi.length) {
    metas.post_validation_notes.push(
      'Метатег не использует уникальные LSI — есть риск однотипности с ТОП-10.',
    );
  }

  return { serp, semantics: merged, ctrAnalysis, snippetAnalysis, metas };
}

/**
 * Объединяет GSC-семантику со словами анализа выдачи. SERP-слова идут после
 * GSC-слов (реальный спрос страницы важнее), без дублей, с лимитами.
 */
function _mergeSemantics(target, extra) {
  const out = {
    title_mandatory_words: Array.isArray(target.title_mandatory_words)
      ? target.title_mandatory_words.slice() : [],
    description_mandatory_words: Array.isArray(target.description_mandatory_words)
      ? target.description_mandatory_words.slice() : [],
    obligatory_lsi: Array.isArray(target.obligatory_lsi)
      ? target.obligatory_lsi.slice() : [],
    differentiator_lsi: Array.isArray(target.differentiator_lsi)
      ? target.differentiator_lsi.slice() : [],
    df_map: { ...(target.df_map || {}) },
    serp_doc_count: target.serp_doc_count || 0,
  };
  const merge = (key, max) => {
    const seen = new Set(out[key]);
    (extra[key] || []).forEach((w) => {
      if (w && !seen.has(w)) { seen.add(w); out[key].push(w); }
    });
    out[key] = out[key].slice(0, max);
  };
  merge('title_mandatory_words', 6);
  merge('description_mandatory_words', 10);
  merge('obligatory_lsi', 8);
  merge('differentiator_lsi', 5);
  // df_map берём от extra (SERP) если в target пуст — SERP-данные точнее по выдаче.
  if (extra.df_map && !Object.keys(out.df_map).length) out.df_map = { ...extra.df_map };
  if (!out.serp_doc_count && extra.serp_doc_count) out.serp_doc_count = extra.serp_doc_count;
  return out;
}

/**
 * Разовый анализ ЦА и ниши (analyzeAudienceAndNiche — та же функция, что в
 * основном SEO-пайплайне). Возвращает компактный текст-digest (≤1500 симв.)
 * для подстановки в user-prompt генератора мета-тегов; '' если анализ пуст.
 *
 * @param {object} args
 * @param {string} [args.niche]    — тема/услуга страницы
 * @param {string} [args.brand]    — бренд
 * @param {string} [args.toponym]  — регион
 * @param {string} [args.summary]  — УТП / факты
 * @param {object} [args.ctx]      — { taskId, onTokens, log } для analyzeAudienceAndNiche
 * @returns {Promise<string>}
 */
async function buildAudienceNicheDigest({ niche, brand, toponym, summary, ctx = {} } = {}) {
  const syntheticTask = {
    input_target_service: niche || 'Нет данных',
    input_brand_name: brand || '',
    input_business_type: '',
    input_region: toponym || 'Россия',
    input_brand_facts: summary || '',
    input_target_audience: '',
    input_niche_features: '',
  };

  const safeCtx = {
    taskId: ctx.taskId || null,
    onTokens: typeof ctx.onTokens === 'function' ? ctx.onTokens : () => {},
    log: typeof ctx.log === 'function' ? ctx.log : () => {},
  };

  const analysis = await analyzeAudienceAndNiche(syntheticTask, safeCtx);
  if (!analysis) return '';

  const { personasText, nicheDeepDiveText, contentVoiceText, nicheTerminologyText } =
    serializeAnalysisForPrompt(analysis);

  const parts = [];
  if (contentVoiceText) parts.push(`▸ Тон/голос:\n${contentVoiceText}`);
  if (nicheDeepDiveText) parts.push(`▸ Инсайты ниши:\n${nicheDeepDiveText.slice(0, 600)}`);
  if (personasText) parts.push(`▸ Ключевая персона ЦА:\n${personasText.slice(0, 500)}`);
  if (nicheTerminologyText) parts.push(`▸ Терминология ниши: ${nicheTerminologyText.slice(0, 200)}`);

  return parts.join('\n\n').slice(0, 1500);
}

module.exports = {
  runMetaStagesForKeyword,
  buildAudienceNicheDigest,
  _mergeSemantics,
};
