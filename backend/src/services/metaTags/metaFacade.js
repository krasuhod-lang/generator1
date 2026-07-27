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
const { calcCost } = require('../metrics/priceCalculator');

const SUMMARY_MAX = 1500;

/** Имя стадии для телеметрии (pipeline_traces / task_stages). */
const META_STAGE_NAME = 'meta_tags';

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
  return {
    tokensIn: 0, tokensOut: 0, thoughtsTokens: 0, cachedTokens: 0,
    cost: 0, model: '', provider: '',
  };
}

/**
 * Провайдер → модель тарификатора. GIST зовёт адаптеры напрямую (минуя
 * callLLM), поэтому стоимость мета-генерации считаем здесь сами; 'mixed'
 * тарифицируем как gemini — консервативная (более дорогая) оценка.
 */
function _priceModel(provider) {
  const p = String(provider || '').toLowerCase();
  if (p.startsWith('deepseek')) return 'deepseek';
  if (p.startsWith('grok')) return 'grok';
  return 'gemini';
}

/** Провайдер для колонок метрик (deepseek/grok/gemini). */
function _metricsProvider(provider) {
  return _priceModel(provider);
}

function _usageFromMeta(meta = {}) {
  const tokensIn = Number(meta.tokensIn) || 0;
  const tokensOut = Number(meta.tokensOut) || 0;
  const thoughtsTokens = Number(meta.thoughtsTokens) || 0;
  const cachedTokens = Number(meta.cachedTokens) || 0;
  const provider = meta.provider || '';
  // _meta движка GIST не содержит costUsd — считаем сами по тем же тарифам,
  // что и callLLM, иначе расход мета-тегов уходит в отчётность нулём.
  const cost = Number(meta.costUsd) > 0
    ? Number(meta.costUsd)
    : calcCost(_priceModel(provider), tokensIn, tokensOut, { thoughtsTokens, cachedTokens });
  return {
    tokensIn,
    tokensOut,
    thoughtsTokens,
    cachedTokens,
    cost: Number.isFinite(cost) ? cost : 0,
    model: meta.model || '',
    provider,
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
    gist_fact_source: metas.winner_source || null,
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
 * Персист расхода мета-генерации. GIST зовёт адаптеры напрямую, поэтому
 * штатный учёт callLLM (task_stages + task_metrics) её не видит и стоимость
 * мета-тегов терялась целиком.
 *
 * - pipeline 'seo' → task_metrics/task_stages (taskId ссылается на tasks);
 * - остальные пайплайны ведут собственные счётчики (recordTextTokens),
 *   поэтому здесь только телеметрия pipeline_traces.
 *
 * Полностью fail-open: любая ошибка БД — только warn в консоль.
 */
async function _persistUsage({ pipeline, taskId, usage, source, durationMs }) {
  if (!taskId || !usage) return;
  try {
    const { recordTrace } = require('../llm/pipelineTrace');
    await recordTrace({
      stage: META_STAGE_NAME,
      pipeline: pipeline === 'seo' || pipeline === 'info' || pipeline === 'link' ? pipeline : 'seo',
      taskId,
      model: usage.model || _metricsProvider(usage.provider),
      inputTokens: usage.tokensIn,
      outputTokens: usage.tokensOut,
      durationMs: durationMs == null ? null : durationMs,
    });
  } catch (err) {
    console.warn(`[metaFacade] recordTrace failed: ${err.message}`);
  }

  if (pipeline !== 'seo') return;
  if (!usage.tokensIn && !usage.tokensOut) return;

  const provider = _metricsProvider(usage.provider);
  const cols = provider === 'deepseek'
    ? { in: 'deepseek_tokens_in', out: 'deepseek_tokens_out', cost: 'deepseek_cost_usd' }
    : provider === 'grok'
      ? { in: 'grok_tokens_in', out: 'grok_tokens_out', cost: 'grok_cost_usd' }
      : { in: 'gemini_tokens_in', out: 'gemini_tokens_out', cost: 'gemini_cost_usd' };

  try {
    const db = require('../../config/db');
    await db.query(
      `INSERT INTO task_metrics (task_id, ${cols.in}, ${cols.out}, ${cols.cost}, total_tokens, total_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id) DO UPDATE SET
         ${cols.in}     = task_metrics.${cols.in}     + EXCLUDED.${cols.in},
         ${cols.out}    = task_metrics.${cols.out}    + EXCLUDED.${cols.out},
         ${cols.cost}   = task_metrics.${cols.cost}   + EXCLUDED.${cols.cost},
         total_tokens   = task_metrics.total_tokens   + EXCLUDED.total_tokens,
         total_cost_usd = task_metrics.total_cost_usd + EXCLUDED.total_cost_usd,
         updated_at     = NOW()`,
      [
        taskId, usage.tokensIn, usage.tokensOut, usage.cost,
        usage.tokensIn + usage.tokensOut, usage.cost,
      ],
    );
    await db.query(
      `INSERT INTO task_stages
         (task_id, stage_name, call_label, status, model_used, prompt_size,
          tokens_in, tokens_out, cost_usd, started_at, completed_at)
       VALUES ($1,$2,$3,'completed',$4,0,$5,$6,$7,NOW(),NOW())`,
      [
        taskId, META_STAGE_NAME, `meta:${source || 'unknown'}`,
        usage.model || provider, usage.tokensIn, usage.tokensOut, usage.cost,
      ],
    );
  } catch (err) {
    console.warn(`[metaFacade] persist meta metrics failed: ${err.message}`);
  }
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
 *   price_data, pageAngle, missingNodes, avoidPatterns, standalone_exposure,
 *   audienceNicheDigest, relevanceBrief, llm_provider, gemini_model, lr, brandFacts }
 * @param {object} [args.ctx]            — { taskId, log, onTokens, persistMetrics }
 *   `onTokens(provider, tokensIn, tokensOut, costUsd)` — та же сигнатура, что у
 *   оркестратора и `recordTextTokens` инфо-/ссылочных статей.
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
    // Запреты (анти-паттерны ТОПа, клише) идут отдельно от фактов-кандидатов —
    // иначе модель берёт их в текст мета-тегов как содержание.
    avoidPatterns: Array.isArray(context.avoidPatterns) ? context.avoidPatterns.filter(Boolean) : [],
    standalone_exposure: context.standalone_exposure === true,
    audienceNicheDigest: context.audienceNicheDigest || '',
    relevanceBrief: context.relevanceBrief || '',
    llm_provider: context.llm_provider || 'gemini',
    gemini_model: context.gemini_model || '',
  };

  const startedAt = Date.now();
  const report = async (result) => {
    if (result && result.usage) {
      const provider = _metricsProvider(result.usage.provider);
      if (onTokens) {
        try {
          // Единая для проекта сигнатура: (provider, tokensIn, tokensOut, costUsd).
          onTokens(provider, result.usage.tokensIn, result.usage.tokensOut, result.usage.cost);
        } catch (_) { /* graceful */ }
      }
      if (ctx.persistMetrics !== false) {
        await _persistUsage({
          pipeline,
          taskId: ctx.taskId,
          usage: result.usage,
          source: result.source,
          durationMs: Date.now() - startedAt,
        });
      }
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
  // Для ссылочных статей используем специализированный движок
  // generateLinkArticleMeta: он не ходит в выдачу (статья публикуется на
  // внешнем доноре), повторяет полный пайплайн и при полном провале всё
  // равно собирает пару через MetaPairAssembler.
  try {
    let metas;
    if (pipeline === 'link') {
      const { generateLinkArticleMeta } = require('./gistMetaFilter');
      metas = await generateLinkArticleMeta({
        topic: kw,
        anchorText: context.anchorText || '',
        articlePlain: plain || String(html || '').replace(/<[^>]+>/g, ' '),
        focusNotes: context.focusNotes || context.summary || '',
        geminiModel: context.gemini_model || '',
      });
    } else {
      const { generateDrMaxMeta } = require('./metaGenerator');
      metas = await generateDrMaxMeta({
        keyword: kw, semantics: {}, serpData: [], inputs,
      });
    }
    metas.ctr_score = snippetCtrScore({ metas, keyword: kw, inputs });
    metas.context_used = {
      page_angle: inputs.pageAngle || '',
      missing_nodes: inputs.missingNodes || [],
      standalone_exposure: metas.standalone_exposure === true || inputs.standalone_exposure === true,
    };
    log(`Мета-теги: GIST без SERP готов (CTR-скор ${metas.ctr_score.score}/100)`, 'info');
    return report(_contract(metas, pipeline === 'link' ? 'gist_link' : 'gist'));
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
