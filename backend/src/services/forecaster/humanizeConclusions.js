'use strict';
/**
 * humanizeConclusions — «переводчик» аналитических выводов прогноза на
 * человеческий язык для ВЛАДЕЛЬЦА бизнеса.
 *
 * Отдельный ДОПОЛНИТЕЛЬНЫЙ шаг: берёт уже готовые выводы (runDeepSeekAnalysis)
 * и пересказывает главное простыми словами. Ничего не пересчитывает и не
 * меняет — только переформулирует. Важные технические факторы (E-E-A-T,
 * Core Web Vitals, каннибализация…) НЕ выкидывает, а объясняет в скобках.
 *
 * Graceful: любой сбой → verdict 'skipped'/'error', детальные выводы остаются.
 * ИЗОЛЯЦИЯ: новый модуль, существующий анализ не меняет.
 */
const { callAnalyticLLM, analyticCallCost, hasAnalyticLLMKey } = require('./analyticLLM');

/** Надёжный разбор JSON из ответа модели (с обрезкой мусора вокруг {...}). */
function _safeParse(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* ниже — вытащим {...} */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { /* no-op */ }
  }
  return null;
}

const SYSTEM_PROMPT = [
  'Ты — переводчик с «сеошного» языка на человеческий. На вход — готовые',
  'аналитические выводы по SEO-прогнозу (их написал аналитик). Задача: пересказать',
  'ГЛАВНОЕ простым языком для ВЛАДЕЛЬЦА БИЗНЕСА, который НЕ разбирается в SEO.',
  '',
  'ПРАВИЛА:',
  '• Пиши как живой человек: короткие предложения, без канцелярита, чтобы «ложилось на ухо».',
  '• Ничего НЕ придумывай и НЕ меняй цифры — только пересказывай то, что уже есть во входных выводах.',
  '• Важные технические факторы НЕ выкидывай (E-E-A-T, Core Web Vitals, каннибализация,',
  '  ссылочный профиль, поведенческие и т.п.) — упоминай их, но при ПЕРВОМ появлении',
  '  сразу объясняй простыми словами в скобках или через тире. Пример:',
  '  «E-E-A-T — доверие поисковика к сайту: реальные специалисты, опыт, отзывы, дипломы».',
  '  «Core Web Vitals — техническая скорость и удобство: быстро грузится, не прыгает на телефоне».',
  '• Никаких терминов БЕЗ расшифровки (momentum, CR, intent, ramp-up — переводи в простые слова).',
  '• Тон — уверенный и доброжелательный, как эксперт объясняет клиенту. Без обещаний «гарантий».',
  '',
  'СТРУКТУРА (по сути): суть в 2–4 предложениях + 2–4 пункта «что это значит и что делать».',
  '',
  'Ответ СТРОГО один JSON-объект, на русском, без markdown и без текста вне JSON:',
  '{',
  '  "headline": "одна фраза — суть вывода в двух словах",',
  '  "summary": "2–4 живых предложения: есть ли спрос, сколько недобираете, за какой срок реально выйти на прогноз",',
  '  "points": ["2–4 пункта: важные факторы с расшифровкой терминов и что делать"]',
  '}',
].join('\n');

/** Компактно собирает текст входных выводов для переводчика. */
function _buildInput(ds) {
  const parts = [];
  const push = (label, val) => {
    if (!val) return;
    if (Array.isArray(val)) {
      const items = val.map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') {
          // ranking_factors: {factor, status, note}
          return [x.factor, x.status, x.note].filter(Boolean).join(' — ');
        }
        return '';
      }).filter(Boolean);
      if (items.length) parts.push(`${label}:\n- ${items.join('\n- ')}`);
    } else if (typeof val === 'string') {
      parts.push(`${label}: ${val}`);
    }
  };
  push('Главный вывод', ds.summary);
  push('Спрос', ds.demand_analysis);
  push('Трафик', ds.traffic_analysis);
  push('Заявки', ds.leads_analysis);
  push('Ключевые наблюдения', ds.bullets);
  push('Факторы ранжирования', ds.ranking_factors);
  push('Подводные камни', ds.pitfalls);
  push('Рекомендации', ds.recommendations);
  return parts.join('\n\n');
}

/**
 * @param {object} ds — результат runDeepSeekAnalysis (выводы)
 * @param {object} [opts] — { taskId, callLabel }
 * @returns {Promise<{verdict:'ok'|'skipped'|'error', reason?:string,
 *   headline?:string, summary?:string, points?:string[],
 *   tokens_in?:number, tokens_out?:number, cost_usd?:number}>}
 */
async function humanizeConclusionsV2(ds, opts = {}) {
  if (!ds || ds.verdict !== 'ok') {
    return { verdict: 'skipped', reason: 'no_analysis' };
  }
  if (!hasAnalyticLLMKey()) return { verdict: 'skipped', reason: 'no_api_key' };
  const input = _buildInput(ds);
  if (!input.trim()) return { verdict: 'skipped', reason: 'empty_analysis' };

  try {
    // callAnalyticLLM сам добивает усечённый ответ (reasoning-модель) и умеет
    // фолбэк на Gemini. Даём щедрый лимит — вывод короткий.
    const { resp, provider } = await callAnalyticLLM(SYSTEM_PROMPT, input, {
      temperature: 0.4,
      maxTokens: 3000,
      timeoutMs: opts.timeoutMs || 60000,
    });
    const parsed = _safeParse(resp.text || '');
    const summary = parsed?.summary ? String(parsed.summary).trim() : '';
    const points = Array.isArray(parsed?.points)
      ? parsed.points.map((p) => String(p || '').trim()).filter(Boolean)
      : [];

    if (!parsed || (!summary && points.length === 0)) {
      return {
        verdict: 'error', reason: 'bad_llm_output',
        raw_text: String(resp.text || '').slice(0, 300),
        tokens_in: resp.tokensIn || 0, tokens_out: resp.tokensOut || 0,
      };
    }
    const cost = (typeof analyticCallCost === 'function') ? analyticCallCost(provider, resp) : 0;
    return {
      verdict: 'ok',
      headline: String(parsed.headline || '').trim(),
      summary,
      points,
      tokens_in: resp.tokensIn || 0,
      tokens_out: resp.tokensOut || 0,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      model: resp.model || provider,
    };
  } catch (err) {
    return { verdict: 'error', reason: err.message };
  }
}

module.exports = { humanizeConclusionsV2, _buildInput };
