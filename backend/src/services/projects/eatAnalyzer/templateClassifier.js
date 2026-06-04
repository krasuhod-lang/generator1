'use strict';

/**
 * eatAnalyzer/templateClassifier — кластеризация топ-страниц проекта по типу
 * шаблона (catalog / product / service / blog / about / contacts / other) по
 * URL-паттерну (п.5 ТЗ). Детерминированно, без сети.
 *
 * Выбирает по N представителей каждого кластера (с наибольшими показами) —
 * именно их парсит eatAnalyzer для оценки E-E-A-T, чтобы не скачивать десятки
 * однотипных URL.
 */

const { getProjectsConfig } = require('../config');

/**
 * Определяет имя шаблона по пути URL (первое совпадение по подстроке).
 * @returns {string} ключ шаблона из cfg.eat.templatePatterns или 'other'
 */
function classifyTemplate(url, patterns) {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (_) {
    path = String(url || '').toLowerCase();
  }
  if (path === '/' || path === '') return 'home';
  for (const [name, markers] of Object.entries(patterns || {})) {
    if (markers.some((m) => path.includes(m))) return name;
  }
  return 'other';
}

/**
 * Группирует топ-страницы по шаблону и выбирает представителей.
 *
 * @param {Array} topPages [{key:url, clicks, impressions, ...}]
 * @param {object} [cfg] getProjectsConfig().eat
 * @returns {{clusters: Array<{template, total, representatives:Array}>}}
 */
function classifyTemplates(topPages, cfg) {
  const eat = cfg || getProjectsConfig().eat;
  const patterns = eat.templatePatterns;
  const groups = new Map();

  (topPages || []).forEach((p) => {
    const url = p.key || p.page || p.url;
    if (!url || typeof url !== 'string') return;
    const tpl = classifyTemplate(url, patterns);
    if (!groups.has(tpl)) groups.set(tpl, []);
    groups.get(tpl).push({ url, clicks: p.clicks || 0, impressions: p.impressions || 0 });
  });

  const clusters = Array.from(groups.entries()).map(([template, pages]) => {
    pages.sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
    return {
      template,
      total: pages.length,
      representatives: pages.slice(0, eat.samplesPerTemplate || 1),
    };
  });

  // Приоритизируем по суммарным показам кластера и режем до maxTemplates.
  clusters.sort((a, b) => {
    const sa = a.representatives.reduce((s, r) => s + r.impressions, 0);
    const sb = b.representatives.reduce((s, r) => s + r.impressions, 0);
    return sb - sa;
  });

  return { clusters: clusters.slice(0, eat.maxTemplates || 6) };
}

module.exports = { classifyTemplate, classifyTemplates };
