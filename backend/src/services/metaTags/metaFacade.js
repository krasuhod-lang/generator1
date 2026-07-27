'use strict';

/**
 * metaTags/metaFacade — единая точка входа генерации мета-тегов для ВСЕХ
 * контентных пайплайнов (основной SEO-пайплайн, статьи блога, ссылочные
 * статьи, инструмент мета-тегов).
 *
 * До появления фасада самый сильный движок проекта — GIST Meta Filter —
 * работал только в инструменте мета-тегов и в аудите страниц проекта, а
 * статьи получали мету от примитивного одиночного вызова DeepSeek
 * (infoArticle/seoMeta.service) либо не получали её вовсе (Stage 7).
 *
 * Каскад деградации (никогда не роняет пайплайн):
 *   1) SERP доступен  → runMetaStagesForKeyword (SERP → семантика → GIST → LSI)
 *   2) SERP недоступен → generateDrMaxMeta с пустым serpData (GIST без выдачи)
 *   3) GIST упал       → infoArticle/seoMeta.service (LLM + детерминированный
 *                        fallback из H1/первого абзаца)
 *
 * ENV:
 *   META_FACADE_ENABLED      — 'false' полностью отключает фасад (остаётся
 *                              только seoMeta.service — прежнее поведение);
 *   META_FACADE_SERP_ENABLED — 'false' запрещает поход в SERP (ветка 2).
 *
 * См. ТЗ «Максимальная кликабельность мета-тегов» §1.
 */

const { snippetCtrScore } = require('./ctrScore');

const SUMMARY_MAX = 1500;

function _envFlag(name, def = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return String(raw).toLowerCase() !== 'false';
}

function isFacadeEnabled() {
  return _envFlag('META_FACADE_ENABLED', true);
}

function isSerpEnabled() {
  return _envFlag('META_FACADE_SERP_ENABLED', true);
}

/** Достаёт текст первого <h1> (без тегов). */
function extractH1(html) {
  const m = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Первый осмысленный абзац HTML/plain-текста. */
function firstParagraph(html, plain) {
  const fromHtml = String(html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (fromHtml) {
    const text = fromHtml[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) return text;
  }
  const para = String(plain || '')
    .split(/\n{2,}|\n/)
    .map((s) => s.trim())
    .find((s) => s.length >= 40);
  return para || String(plain || '').replace(/\s+/g, ' ').trim();
}

/**
 * Строит компактный summary статьи для GIST: H1 + первый абзац + факты бренда.
 * Лимит SUMMARY_MAX символов — промпт кандидатов и так насыщен.
 */
function buildSummaryFromContent({ html = '', plain = '', brandFacts = '', extra = '' } = {}) {
  const parts = [];
  const h1 = extractH1(html);
  if (h1) parts.push(`H1: ${h1}`);
  const lead = firstParagraph(html, plain);
  if (lead) parts.push(`Лид: ${lead}`);
  if (brandFacts) parts.push(`Факты бренда: ${String(brandFacts).replace(/\s+/g, ' ').trim()}`);
  if (extra) parts.push(String(extra).replace(/\s+/g, ' ').trim());
  return parts.join(' | ').slice(0, SUMMARY_MAX);
}

function _emptyUsage() {
  return { tokensIn: 0, tokensOut: 0, cost: 0, model: '' };
}

function _usageFromMeta(meta = {}) {
  return {
    tokensIn: Number(meta.tokensIn) || 0,
    tokensOut: Number(meta.tokensOut) || 0,
    cost: Number(meta.costUsd) || 0,
    model: meta.model || '',
    provider: meta.provider || '',
  };
}

function _contract(metas, source, extra = {}) {
  return {
    title: String(metas.title || ''),
    description: String(metas.description || ''),
    h1: String(metas.h1 || ''),
    description_mobile: String(metas.description_mobile || ''),
    source,
    gist_fact: metas.winner_fact || null,
    ctr_score: metas.ctr_score || null,
    lsi_check: metas.lsi_check || null,
    context_used: metas.context_used || null,
    manual_review_required: metas.manual_review_required === true,
    notes: Array.isArray(metas.post_validation_notes) ? metas.post_validation_notes : [],
    usage: _usageFromMeta(metas._meta || {}),
    ...extra,
  };
}

/**
 * Единая генерация мета-тегов по готовому контенту.
 *
 * @param {object} args
 * @param {string} args.keyword          — главный запрос / тема страницы
 * @param {string} [args.pipeline]       — 'seo' | 'info' | 'link' | 'meta_tool'
 * @param {string} [args.html]           — финальный HTML (для summary/H1)
 * @param {string} [args.plain]          — plain-текст
 * @param {object} [args.context]        — { brand, niche, toponym, phone, summary,
 *   price_data, pageAngle, missingNodes, standalone_exposure, audienceNicheDigest,
 *   relevanceBrief, llm_provider, gemini_model, lr, brandFacts }
 * @param {object} [args.ctx]            — { taskId, log, onTokens }
 * @returns {Promise<object>} единый контракт (см. _contract)
 */
async function generateMetaForContent({
  keyword = '', pipeline = 'seo', html = '', plain = '', context = {}, ctx = {},
} = {}) {
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const onTokens = typeof ctx.onTokens === 'function' ? ctx.onTokens : null;
  const kw = String(keyword || '').trim();

  const summary = String(context.summary || '').trim()
    || buildSummaryFromContent({
      html, plain, brandFacts: context.brandFacts, extra: context.extraFacts,
    });

  const inputs = {
    niche: context.niche || kw,
    brand: context.brand || '',
    toponym: context.toponym || '',
    phone: context.phone || '',
    summary,
    page_context: summary,
    price_data: context.price_data || null,
    pageAngle: context.pageAngle || '',
    missingNodes: Array.isArray(context.missingNodes) ? context.missingNodes.filter(Boolean) : [],
    standalone_exposure: context.standalone_exposure === true,
    audienceNicheDigest: context.audienceNicheDigest || '',
    relevanceBrief: context.relevanceBrief || '',
    llm_provider: context.llm_provider || 'gemini',
    gemini_model: context.gemini_model || '',
  };

  const report = (result) => {
    if (onTokens && result && result.usage) {
      try {
        onTokens(result.usage.tokensIn, result.usage.tokensOut, result.usage.cost);
      } catch (_) { /* graceful */ }
    }
    return result;
  };

  if (!kw) {
    log('Мета-теги: пустой keyword — фасад пропущен', 'warn');
    return report(await _seoMetaFallback({ keyword: kw, context, html, plain, ctx }));
  }

  if (!isFacadeEnabled()) {
    log('Мета-теги: META_FACADE_ENABLED=false — используем seoMeta.service', 'info');
    return report(await _seoMetaFallback({ keyword: kw, context, html, plain, ctx }));
  }

  // ── Ветка 1: SERP + полный staged-пайплайн ────────────────────────
  if (isSerpEnabled() && context.useSerp !== false) {
    try {
      const { runMetaStagesForKeyword } = require('./metaStages');
      const { metas } = await runMetaStagesForKeyword({
        keyword: kw,
        inputs,
        lr: context.lr || '',
      });
      log(`Мета-теги: GIST + SERP готовы (CTR-скор ${metas.ctr_score ? metas.ctr_score.score : '—'}/100)`, 'info');
      return report(_contract(metas, 'gist_serp'));
    } catch (err) {
      log(`Мета-теги: ветка SERP не отработала (${err.message}) — пробуем GIST без выдачи`, 'warn');
    }
  }

  // ── Ветка 2: GIST без SERP ────────────────────────────────────────
  try {
    const { generateDrMaxMeta } = require('./metaGenerator');
    const metas = await generateDrMaxMeta({
      keyword: kw, semantics: {}, serpData: [], inputs,
    });
    metas.ctr_score = snippetCtrScore({ metas, keyword: kw, inputs });
    metas.context_used = {
      page_angle: inputs.pageAngle || '',
      missing_nodes: inputs.missingNodes || [],
      standalone_exposure: inputs.standalone_exposure,
    };
    log(`Мета-теги: GIST без SERP готов (CTR-скор ${metas.ctr_score.score}/100)`, 'info');
    return report(_contract(metas, 'gist'));
  } catch (err) {
    log(`Мета-теги: GIST не отработал (${err.message}) — деградируем до seoMeta.service`, 'warn');
  }

  // ── Ветка 3: legacy seoMeta.service (LLM + детерминированный fallback) ──
  return report(await _seoMetaFallback({ keyword: kw, context, html, plain, ctx }));
}

/** Ветка 3 каскада: прежний одиночный вызов + детерминированная деградация. */
async function _seoMetaFallback({ keyword, context = {}, html = '', plain = '', ctx = {} }) {
  try {
    const { generateSeoMeta } = require('../infoArticle/seoMeta.service');
    const seo = await generateSeoMeta({
      topic: keyword,
      region: context.toponym || '',
      brand: context.brand || '',
      articleHtml: html,
      articlePlain: plain,
      ctx: { taskId: ctx.taskId || null, onLog: ctx.log || null },
    });
    const metas = { title: seo.title, description: seo.description, h1: '' };
    return _contract(
      {
        ...metas,
        ctr_score: snippetCtrScore({ metas, keyword, inputs: context }),
        post_validation_notes: ['Мета-теги собраны запасным движком (seoMeta.service).'],
        _meta: {},
      },
      `legacy_${seo.source}`,
    );
  } catch (err) {
    return {
      title: '', description: '', h1: '', description_mobile: '',
      source: 'failed',
      gist_fact: null,
      ctr_score: null,
      lsi_check: null,
      context_used: null,
      manual_review_required: true,
      notes: [`Мета-теги не сгенерированы: ${err.message}`],
      usage: _emptyUsage(),
    };
  }
}

module.exports = {
  generateMetaForContent,
  buildSummaryFromContent,
  extractH1,
  firstParagraph,
  isFacadeEnabled,
  isSerpEnabled,
  SUMMARY_MAX,
};
