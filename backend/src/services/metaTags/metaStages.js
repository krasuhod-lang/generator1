'use strict';

/**
 * metaTags/metaStages — общий staged-хелпер генерации мета-тегов.
 *
 * Инкапсулирует ту же последовательность этапов, что и основной инструмент
 * мета-тегов (pipeline.js):
 *   1) fetchYandexSerp        — анализ поисковой выдачи (XMLStock)
 *   2) extractSemantics       — TF-IDF семантика конкурентов
 *   3) generateDrMaxMeta      — Title / Description / H1 (Gemini/Grok)
 *   4) checkLsiUsage          — LSI-верификация готовых тегов
 * + разовый buildAudienceNicheDigest (analyzeAudienceAndNiche), который
 *   запускается ОДИН раз на набор страниц/ключей.
 *
 * Вынесено отдельным модулем, чтобы переиспользовать и в инструменте мета-тегов
 * (pipeline.js), и в анализе проектов (projects/pageMetaAudit), не дублируя
 * логику этапов и LSI-проверки.
 */

const { fetchYandexSerp } = require('./xmlstockClient');
const { extractSemantics, checkLsiUsage } = require('./semantics');
const { generateDrMaxMeta } = require('./metaGenerator');
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

  // 3) Gemini/Grok → Title + Description + H1.
  const metas = await generateDrMaxMeta({ keyword, semantics: merged, serpData: serp, inputs });

  // 4) LSI-верификация по объединённому тексту Title + Description + H1.
  const combinedMetaText = [
    metas.title || '',
    metas.description || '',
    metas.h1 || '',
  ].join(' ');
  const lsiTitleCheck = checkLsiUsage(combinedMetaText, merged.title_mandatory_words || []);
  const lsiDescCheck = checkLsiUsage(combinedMetaText, merged.description_mandatory_words || []);
  metas.lsi_check = {
    title: lsiTitleCheck,
    description: lsiDescCheck,
    missed_lsi: [...lsiTitleCheck.missed_lsi, ...lsiDescCheck.missed_lsi],
  };

  return { serp, semantics: merged, metas };
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
