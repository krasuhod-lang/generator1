'use strict';

const { richTextToPlain } = require('../../utils/stripHtmlTags');

/**
 * relevanceArtifacts — единый extractor «всего полезного» из relevance_report.
 *
 * Зачем: исторически infoArticleKnowledgeBase сам ходит в БД, разбирает
 * report{} и собирает §9b. Те же данные нужны и linkArticle, и metaTags,
 * и semanticLinkPlanner. Дублировать парсинг плохо — собираем единый
 * нормализованный артефакт RelevanceArtifact и переиспользуем.
 *
 * Структура артефакта (все поля опциональны, могут быть [] или null):
 *   {
 *     report_id, our_url,
 *     important_lsi:  [{ lemma, df_share_pct, median_count }],
 *     additional_lsi: [{ lemma, df_share_pct }],
 *     top_ngrams:     [{ phrase, df, df_share_pct }],
 *     shared_headings:[{ sample, df, df_share_pct, levels:['h2','h3'] }],
 *     h2_drafts:      [string]   — только h2 (или levels пустые)
 *     h3_drafts:      [string]   — только h3
 *     mandatory_entities: [{ text, df_share_pct }],
 *     competitor_signals: { ... },
 *     competitor_signals_digest: { has_jsonld, has_faq, host_hygiene_pct, ... },
 *     schema_recommendation_markdown: string,
 *     voice_of_customer: { target_audience, niche_features, brand_facts },
 *     cocoon_plan: { ... } | null,
 *   }
 *
 * loadArtifact(db, { reportId, userId }) — graceful, при ошибках/отсутствии
 * возвращает null.
 *
 * fromReportRow(row) — pure-function вариант (для тестов), принимает строку
 * {report, our_report, our_url, llm_enrichment, id, cocoon_plan}.
 */

const MAX_IMPORTANT_LSI = 50;
const MAX_ADDITIONAL_LSI = 30;
const MAX_NGRAMS = 40;
const MAX_HEADINGS = 40;
const MAX_H_DRAFTS = 25;
const MAX_ENTITIES = 25;

function _arr(x) { return Array.isArray(x) ? x : []; }

function _splitHeadingsByLevel(headings) {
  const h2 = [];
  const h3 = [];
  for (const h of headings) {
    if (!h) continue;
    const sample = String(h.sample || h.text || '').trim();
    if (!sample) continue;
    const levels = Array.isArray(h.levels) ? h.levels.map((s) => String(s).toLowerCase()) : [];
    if (!levels.length) {
      // Без явного уровня — кладём в h2 (наиболее распространённый случай).
      if (h2.length < MAX_H_DRAFTS) h2.push(sample);
      continue;
    }
    if (levels.includes('h2')) {
      if (h2.length < MAX_H_DRAFTS) h2.push(sample);
    } else if (levels.includes('h3')) {
      if (h3.length < MAX_H_DRAFTS) h3.push(sample);
    } else if (levels.includes('h4')) {
      // Не используем h4 отдельно; добавим как h3-черновик.
      if (h3.length < MAX_H_DRAFTS) h3.push(sample);
    }
  }
  return { h2, h3 };
}

function _digestSignals(csig) {
  if (!csig || typeof csig !== 'object') return null;
  const top = csig.top_aggregate || {};
  const schema = (top.schema_profile && top.schema_profile.summary) || {};
  const host = top.host_hygiene || {};
  return {
    has_jsonld: !!(schema.has_jsonld_in_top_count && Number(schema.has_jsonld_in_top_count) > 0),
    has_faq: !!(schema.has_faq_in_top_count && Number(schema.has_faq_in_top_count) > 0),
    has_breadcrumb: !!(schema.has_breadcrumb_in_top_count && Number(schema.has_breadcrumb_in_top_count) > 0),
    host_hygiene_pct: Number(host.hygiene_pct) || null,
    median_words: Number(top.median_word_count) || null,
    title_template: (top.title_templates && top.title_templates[0] && top.title_templates[0].template) || null,
  };
}

function fromReportRow(row) {
  if (!row) return null;
  const rep = row.report || {};
  const our = row.our_report || {};
  const voc = row.llm_enrichment || rep.llm_enrichment || null;

  const vocab = _arr(rep.vocabulary);
  const important = vocab
    .filter((v) => v && v.status === 'important')
    .sort((a, b) => (b.df_share_pct || 0) - (a.df_share_pct || 0));
  const additional = vocab
    .filter((v) => v && v.status === 'additional')
    .sort((a, b) => (b.df_share_pct || 0) - (a.df_share_pct || 0));

  const ngramsArr = _arr(rep.ngrams);
  const headsArr  = _arr(rep.headings_intersection);
  const { h2, h3 } = _splitHeadingsByLevel(headsArr);

  const csig = rep.competitor_signals || null;
  const topAgg = (csig && csig.top_aggregate) || {};

  return {
    report_id: row.id || null,
    our_url:   our.url || row.our_url || '',
    important_lsi:  important.slice(0, MAX_IMPORTANT_LSI),
    additional_lsi: additional.slice(0, MAX_ADDITIONAL_LSI),
    top_ngrams:     ngramsArr.slice(0, MAX_NGRAMS),
    shared_headings: headsArr.slice(0, MAX_HEADINGS),
    h2_drafts: h2,
    h3_drafts: h3,
    mandatory_entities:
      ((topAgg.entity_coverage && topAgg.entity_coverage.mandatory_entities) || [])
        .slice(0, MAX_ENTITIES),
    competitor_signals: csig,
    competitor_signals_digest: _digestSignals(csig),
    serp_intent: topAgg.serp_intent || null,
    schema_recommendation_markdown:
      (topAgg.schema_profile
        && topAgg.schema_profile.summary
        && topAgg.schema_profile.summary.recommendation_markdown) || '',
    voice_of_customer: voc ? {
      target_audience: richTextToPlain(voc.input_target_audience || voc.target_audience || ''),
      niche_features:  richTextToPlain(voc.input_niche_features  || voc.niche_features  || ''),
      brand_facts:     richTextToPlain(voc.input_brand_facts     || voc.brand_facts     || ''),
    } : null,
    cocoon_plan: row.cocoon_plan || null,
  };
}

async function loadArtifact(db, { reportId, userId } = {}) {
  if (!db || !reportId || !userId) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, report, our_report, our_url, llm_enrichment, cocoon_plan
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2 AND status = 'done'
        LIMIT 1`,
      [reportId, userId],
    );
    if (!rows.length) return null;
    return fromReportRow(rows[0]);
  } catch (e) {
    console.warn('[relevanceArtifacts] load failed:', e.message);
    return null;
  }
}

/**
 * renderForPromptBrief — короткий человекочитаемый блок ≤2.5KB, чтобы
 * прокидывать в user-prompts linkArticle/metaTags БЕЗ полного KB.
 * Содержит самые «ударные» поля: top LSI, top ngrams, h2 drafts, h3 drafts.
 */
function renderForPromptBrief(art, opts = {}) {
  if (!art) return '';
  const lsiLimit = Number(opts.lsiLimit) || 15;
  const ngLimit  = Number(opts.ngramsLimit) || 12;
  const h2Limit  = Number(opts.h2Limit) || 10;
  const h3Limit  = Number(opts.h3Limit) || 8;

  const out = ['[RELEVANCE_ARTIFACT]'];
  if (art.important_lsi && art.important_lsi.length) {
    out.push('LSI (обязательные, ≥51% топа): ' +
      art.important_lsi.slice(0, lsiLimit).map((v) => v.lemma).join(', '));
  }
  if (art.top_ngrams && art.top_ngrams.length) {
    out.push('N-граммы топа: ' +
      art.top_ngrams.slice(0, ngLimit).map((n) => `"${n.phrase}"`).join(', '));
  }
  if (art.h2_drafts && art.h2_drafts.length) {
    out.push('H2-наброски (из общих заголовков топа):');
    art.h2_drafts.slice(0, h2Limit).forEach((h, i) => out.push(`  ${i + 1}. ${h}`));
  }
  if (art.h3_drafts && art.h3_drafts.length) {
    out.push('H3-наброски:');
    art.h3_drafts.slice(0, h3Limit).forEach((h, i) => out.push(`  ${i + 1}. ${h}`));
  }
  if (art.mandatory_entities && art.mandatory_entities.length) {
    out.push('Сущности (NER, обязательные): ' +
      art.mandatory_entities.slice(0, 12).map((e) => (e.text || e)).join(', '));
  }
  out.push('[/RELEVANCE_ARTIFACT]');
  return out.join('\n');
}

/**
 * buildRelevanceStageBrief — развёрнутый бриф релевантности для DeepSeek-стадий
 * генерации блог-статьи (intents / white-space / outline).
 *
 * В отличие от renderForPromptBrief (короткий бриф для writer'а), этот бриф
 * передаёт МАКСИМУМ собранных данных релевантности — важные и дополнительные
 * LSI c частотностью, n-граммы с числом сайтов (df), общие H2/H3 топа, сущности
 * (NER) и голос аудитории — чтобы структура и семантика статьи строились из
 * реальных данных топа, а не только у финального writer'а. Бизнес-требование:
 * «все данные по релевантности передавались и связывались со всеми этапами
 * генерации».
 *
 * @param {object|null} art — артефакт из loadArtifact/fromReportRow.
 * @param {object} [opts]
 * @returns {string} — многострочный [RELEVANCE_STAGE_BRIEF] или ''.
 */
function buildRelevanceStageBrief(art, opts = {}) {
  if (!art) return '';
  const impLimit  = Number(opts.lsiLimit)      || MAX_IMPORTANT_LSI;
  const addLimit  = Number(opts.additionalLsiLimit) || MAX_ADDITIONAL_LSI;
  const ngLimit   = Number(opts.ngramsLimit)   || MAX_NGRAMS;
  const headLimit = Number(opts.headingsLimit) || MAX_HEADINGS;
  const entLimit  = Number(opts.entitiesLimit) || MAX_ENTITIES;

  const out = ['[RELEVANCE_STAGE_BRIEF]',
    'Данные релевантности из анализа топа выдачи. Используй их как жёсткие',
    'ориентиры: раскрой обязательные LSI/n-граммы, закрой общие подтемы топа.'];

  const imp = Array.isArray(art.important_lsi) ? art.important_lsi : [];
  if (imp.length) {
    out.push('', 'Важные LSI (обязательные, ≥51% топа) [лемма | % топа | медиана вхождений]:');
    out.push(imp.slice(0, impLimit).map((v) => {
      const pct = v.df_share_pct != null ? `${v.df_share_pct}%` : '?';
      const med = v.median_count != null ? `, медиана ${v.median_count}` : '';
      return `- ${v.lemma} (${pct}${med})`;
    }).join('\n'));
  }

  const add = Array.isArray(art.additional_lsi) ? art.additional_lsi : [];
  if (add.length) {
    out.push('', 'Дополнительные LSI (желательные):');
    out.push(add.slice(0, addLimit).map((v) => {
      const pct = v.df_share_pct != null ? ` (${v.df_share_pct}%)` : '';
      return `- ${v.lemma}${pct}`;
    }).join('\n'));
  }

  const ngrams = Array.isArray(art.top_ngrams) ? art.top_ngrams : [];
  if (ngrams.length) {
    out.push('', 'N-граммы топа [фраза | df=число сайтов | % топа]:');
    out.push(ngrams.slice(0, ngLimit).map((n) => {
      const df  = n.df != null ? `df=${n.df}` : '';
      const pct = n.df_share_pct != null ? ` (${n.df_share_pct}%)` : '';
      return `- "${n.phrase}"${df ? ` — ${df}${pct}` : ''}`;
    }).join('\n'));
  }

  const heads = Array.isArray(art.shared_headings) ? art.shared_headings : [];
  if (heads.length) {
    out.push('', 'Общие заголовки топа (must-cover подтемы):');
    out.push(heads.slice(0, headLimit).map((h) => {
      const sample = h.sample || h.text || String(h);
      const meta = h.df != null ? ` (на ${h.df} сайтах${h.df_share_pct != null ? `, ${h.df_share_pct}%` : ''})` : '';
      return `- ${sample}${meta}`;
    }).join('\n'));
  }

  if (Array.isArray(art.h2_drafts) && art.h2_drafts.length) {
    out.push('', 'H2-наброски (из общих заголовков топа):');
    art.h2_drafts.slice(0, Number(opts.h2Limit) || 25).forEach((h, i) => out.push(`  ${i + 1}. ${h}`));
  }
  if (Array.isArray(art.h3_drafts) && art.h3_drafts.length) {
    out.push('', 'H3-наброски:');
    art.h3_drafts.slice(0, Number(opts.h3Limit) || 25).forEach((h, i) => out.push(`  ${i + 1}. ${h}`));
  }

  const ent = Array.isArray(art.mandatory_entities) ? art.mandatory_entities : [];
  if (ent.length) {
    out.push('', 'Обязательные сущности (NER):');
    out.push(ent.slice(0, entLimit).map((e) => {
      const text = e && (e.text || e);
      const pct  = e && e.df_share_pct != null ? ` (${e.df_share_pct}%)` : '';
      return `- ${text}${pct}`;
    }).join('\n'));
  }

  if (art.serp_intent) {
    out.push('', `Доминирующий интент выдачи: ${art.serp_intent}`);
  }

  const voc = art.voice_of_customer || null;
  if (voc && (voc.target_audience || voc.niche_features || voc.brand_facts)) {
    out.push('', 'Голос аудитории (VoC):');
    if (voc.target_audience) out.push(`- аудитория: ${String(voc.target_audience).slice(0, 400)}`);
    if (voc.niche_features)  out.push(`- особенности ниши: ${String(voc.niche_features).slice(0, 400)}`);
    if (voc.brand_facts)     out.push(`- факты бренда: ${String(voc.brand_facts).slice(0, 400)}`);
  }

  out.push('[/RELEVANCE_STAGE_BRIEF]');
  return out.join('\n');
}

/**
 * relevanceSeedTerms — плоский список ключевых терминов (важные LSI + n-граммы)
 * для подмешивания в LSI-seed синтеза (Stage 2B блог-статьи), чтобы итоговый
 * LSI-набор гарантированно содержал термины топа выдачи.
 *
 * @param {object|null} art
 * @param {object} [opts]
 * @returns {string[]}
 */
function relevanceSeedTerms(art, opts = {}) {
  if (!art) return [];
  const lsiLimit = Number(opts.lsiLimit) || MAX_IMPORTANT_LSI;
  const ngLimit  = Number(opts.ngramsLimit) || MAX_NGRAMS;
  const terms = [];
  for (const v of (Array.isArray(art.important_lsi) ? art.important_lsi : []).slice(0, lsiLimit)) {
    if (v && v.lemma) terms.push(String(v.lemma));
  }
  for (const n of (Array.isArray(art.top_ngrams) ? art.top_ngrams : []).slice(0, ngLimit)) {
    if (n && n.phrase) terms.push(String(n.phrase));
  }
  // dedupe, сохраняем порядок
  const seen = new Set();
  return terms.filter((t) => {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = {
  loadArtifact,
  fromReportRow,
  renderForPromptBrief,
  buildRelevanceStageBrief,
  relevanceSeedTerms,
  _splitHeadingsByLevel,
  _digestSignals,
};
