'use strict';

/**
 * cannibalization/aiExplainer.js — опциональный AI-вердикт по кластерам
 * каннибализации: какую страницу оставить канонической, какие слить и почему.
 * Модель-агностично, через общий llmAnalyst (Gemini→DeepSeek fallback).
 * Год в промпте — динамический (memory «content freshness»).
 *
 * Тихо возвращает null, если провайдер недоступен или ответ нераспарсился —
 * AI-вывод не является обязательным для отчёта.
 */

const llm = require('../projects/llmAnalyst');

const SYSTEM = [
  'Ты — SEO-аналитик. Тебе дают кластеры страниц одного сайта, которые',
  'каннибализируют друг друга (делят одинаковые URL в поисковой выдаче).',
  'Для каждого кластера коротко (1–3 предложения) порекомендуй: какую страницу',
  'оставить канонической (главной), какие слить/сделать редирект, и почему.',
  'Отвечай строго JSON-массивом объектов вида',
  '{"cluster_id": <number>, "keep": "<url|query>", "merge": ["<url>",...], "reason": "<текст>"}.',
  'Без markdown, без пояснений вне JSON.',
].join(' ');

function _buildUser(clusters) {
  const year = new Date().getFullYear();
  const lines = [`Актуальный год: ${year}.`, 'Кластеры каннибализации:'];
  for (const c of clusters) {
    lines.push(`\n[Кластер ${c.id}] общих URL до ${c.maxCommon}:`);
    for (const m of c.members) {
      lines.push(`  - "${m.query}" → ${m.source_url || '(url неизвестен)'}`);
    }
  }
  return lines.join('\n');
}

function _parse(text) {
  if (!text) return null;
  try {
    const m = text.match(/\[[\s\S]*\]/);
    const json = m ? m[0] : text;
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch (_) { return null; }
}

/** @returns {Promise<Array|null>} массив вердиктов по кластерам или null. */
async function explain(clusters, opts = {}) {
  if (!clusters || !clusters.length) return null;
  if (!llm.analystAvailable()) return null;
  // Ограничиваем контекст — не больше 20 кластеров за раз.
  const slice = clusters.slice(0, 20);
  const res = await llm.runAnalyst(SYSTEM, _buildUser(slice), {
    kind: 'cannibalization_explain',
    maxTokens: opts.maxTokens || 1500,
  });
  if (!res || res.verdict !== 'ok') return null;
  return _parse(res.markdown);
}

module.exports = { explain, _buildUser, _parse, SYSTEM };
