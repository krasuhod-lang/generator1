'use strict';

/**
 * geoAeo/aeoOptimizer — детерминированные рекомендации под нейровыдачу
 * (AI Overviews / SGE) и Answer Engine Optimization (п.7 ТЗ).
 *
 * На вход: топ-запросы, результат E-E-A-T/schema-парсинга (какие JSON-LD типы
 * есть на шаблонах), breakdowns.country. На выход — конкретные действия:
 *   • AEO-формат ответа (TL;DR в первых N словах, списки, явные сущности);
 *   • каких критичных для AI Overviews JSON-LD типов не хватает;
 *   • hreflang/локализация при гео-спросе;
 *   • sitemap-of-knowledge (sameAs/mentions).
 */

const { getProjectsConfig } = require('../config');
const { classifyQuery } = require('../commercialIntent');

/**
 * Собирает множество уже присутствующих JSON-LD типов из schema/eat-результата.
 */
function _presentSchemaTypes(schemaAudit) {
  const present = new Set();
  if (schemaAudit && Array.isArray(schemaAudit.templates)) {
    schemaAudit.templates.forEach((t) => {
      (t.found_types || t.types || []).forEach((ty) => present.add(String(ty)));
    });
  }
  return present;
}

/**
 * @param {object} args { topQueries, schemaAudit, breakdowns, brandTokens }
 * @returns {{available, aeo_answers:Array, missing_schema:Array, geo:Array, recommendations:Array}}
 */
function buildAeo({ topQueries = [], schemaAudit = null, breakdowns = null, brandTokens = [] } = {}) {
  const cfg = getProjectsConfig().geoAeo;
  if (!cfg || !cfg.enabled) return null;

  const tldr = cfg.tldrWords || { min: 40, max: 80 };
  const recommendations = [];

  // 1) AEO-формат для топ-инфо-запросов (TL;DR + списки + сущности).
  const aeoAnswers = (topQueries || [])
    .slice(0, cfg.maxProbeQueries || 10)
    .map((r) => {
      const q = r.key || r.query;
      const intent = classifyQuery(q, { brandTokens }).intent;
      return {
        query: q,
        intent,
        answer_format: {
          tldr: `Дайте прямой ответ на «${q}» в первых ${tldr.min}-${tldr.max} словах.`,
          structure: ['Короткий TL;DR-абзац', 'Нумерованный/маркированный список шагов',
            'Таблица сравнения при наличии', 'Явные сущности и определения'],
          prompt_friendly_heading: `${q[0] ? q[0].toUpperCase() + q.slice(1) : q}?`,
        },
      };
    });

  // 2) Каких критичных JSON-LD типов не хватает для нейровыдачи.
  const present = _presentSchemaTypes(schemaAudit);
  const missingSchema = (cfg.aiCriticalSchemaTypes || []).filter((t) => !present.has(t));
  if (missingSchema.length) {
    recommendations.push({
      kind: 'schema',
      priority: 'high',
      message: `Добавьте JSON-LD для AI Overviews: ${missingSchema.join(', ')}.`,
      types: missingSchema,
    });
  }

  // 3) hreflang / локализация при гео-спросе вне основного гео.
  const geo = [];
  if (breakdowns && Array.isArray(breakdowns.country) && breakdowns.country.length > 1) {
    const sorted = breakdowns.country.slice().sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
    sorted.slice(1).forEach((c) => {
      if ((c.impressions || 0) >= (cfg.minImpressions || 30)) {
        geo.push({ country: c.key || c.country, impressions: c.impressions });
      }
    });
    if (geo.length) {
      recommendations.push({
        kind: 'hreflang',
        priority: 'medium',
        message: `Есть спрос вне основного гео (${geo.map((g) => g.country).join(', ')}) — настройте hreflang и локализованные версии.`,
      });
    }
  }

  // 4) Sitemap-of-knowledge: связи сущностей.
  recommendations.push({
    kind: 'entities',
    priority: 'medium',
    message: 'Свяжите сущности через sameAs/mentions в JSON-LD (бренд, авторы, продукты) — это усиливает понимание сайта ИИ-моделями.',
  });

  // 5) Speakable для голосовых/ИИ-ассистентов.
  if (!present.has('Speakable')) {
    recommendations.push({
      kind: 'speakable',
      priority: 'low',
      message: 'Добавьте Speakable-разметку ключевых ответов для голосовой/нейровыдачи.',
    });
  }

  return {
    available: true,
    aeo_answers: aeoAnswers,
    missing_schema: missingSchema,
    geo,
    recommendations,
  };
}

module.exports = { buildAeo };
