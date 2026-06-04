'use strict';

/**
 * linkStrategy/donorScorer — детерминированная оценка доноров (сайтов-источников
 * ссылок) по сигналам из CSV-выгрузки GSC (п.1 ТЗ — «оценка рекомендаций по
 * донорам которые стоит купить»).
 *
 * Без сети считает trust_score 0..100 по доступным сигналам:
 *   • объём ссылок с донора (links) — стабильность присутствия;
 *   • доменная зона / тип хоста (гос/edu/спам-зоны);
 *   • похоже ли на агрегатор/каталог (низкое качество).
 * Тематическую релевантность донора (по парсингу его страницы) можно добавить
 * отдельно через parser/scraper — здесь оставлен hook scoreRelevance.
 */

// Зоны/паттерны, повышающие/понижающие доверие к донору.
const TRUSTED_TLDS = ['gov.ru', '.gov', '.edu', '.ac.', 'gosuslugi'];
const RISKY_HINTS = ['xn--', 'blogspot', 'wordpress.com', 'wixsite', 'ucoz', 'narod.ru',
  'free', '.tk', '.ml', '.ga', 'catalog', 'directory', 'doska', 'forum'];

function _host(donor) {
  if (!donor) return '';
  try {
    return new URL(/^https?:\/\//i.test(donor) ? donor : `https://${donor}`).hostname.replace(/^www\./, '');
  } catch (_) {
    return String(donor).toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

/**
 * Оценивает одного донора. relevance — опциональный 0..1 (тематическая близость).
 * @returns {{donor, host, links, trust_score, flags:string[]}}
 */
function scoreDonor(row, { relevance = null } = {}) {
  const host = _host(row.donor);
  const links = Number(row.links) || 0;
  const flags = [];
  let score = 40; // базовый

  // Объём ссылок: больше — стабильнее (но не линейно).
  score += Math.min(25, Math.round(Math.log2(links + 1) * 6));

  if (TRUSTED_TLDS.some((t) => host.includes(t))) { score += 20; flags.push('trusted_zone'); }
  if (RISKY_HINTS.some((t) => host.includes(t))) { score -= 25; flags.push('risky_host'); }

  if (relevance != null) {
    score += Math.round((relevance - 0.5) * 30); // ±15 за релевантность
    if (relevance >= 0.6) flags.push('topically_relevant');
    else if (relevance < 0.3) flags.push('off_topic');
  }

  score = Math.max(0, Math.min(100, score));
  return { donor: row.donor, host, links, trust_score: score, flags };
}

/**
 * Оценивает массив доноров и сортирует по trust_score.
 * @param {Array} donors [{donor, links}]
 * @param {object} [opts] { relevanceByHost: Map<host, number> }
 */
function scoreDonors(donors, opts = {}) {
  const relMap = opts.relevanceByHost instanceof Map ? opts.relevanceByHost : null;
  const scored = (donors || []).map((d) => {
    const host = _host(d.donor);
    const relevance = relMap && relMap.has(host) ? relMap.get(host) : null;
    return scoreDonor(d, { relevance });
  });
  scored.sort((a, b) => b.trust_score - a.trust_score);
  return scored;
}

module.exports = { scoreDonor, scoreDonors, _host };
