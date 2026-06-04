'use strict';

/**
 * schemaAuditor/schemaRecommender — диагностика «что есть / чего не хватает /
 * что битое» по микроразметке шаблона + готовые JSON-LD сниппеты-скелеты
 * (через services/seo/geoSchema) для недостающих типов (п.8 ТЗ).
 *
 * geoSchema подгружается лениво и graceful: если генератор сниппета недоступен
 * или данных мало — отдаём текстовую рекомендацию без сниппета.
 */

const { getProjectsConfig } = require('../config');

// Маппинг «недостающий тип → как сгенерировать скелет JSON-LD».
function _snippetFor(type, ctx) {
  let geo = null;
  try { geo = require('../../seo/geoSchema'); } catch (_) { return null; }
  const site = ctx.siteUrl || '';
  const name = ctx.projectName || '';
  try {
    switch (type) {
      case 'Organization':
        return geo.buildOrganizationJsonLd({ name, url: site });
      case 'BreadcrumbList':
        return geo.buildBreadcrumbListJsonLd([
          { name: 'Главная', url: site },
          { name: ctx.template || 'Раздел', url: ctx.sampleUrl || site },
        ]);
      case 'FAQPage':
        return geo.buildFaqPageJsonLd([
          { question: 'Вопрос 1', answer: 'Ответ 1' },
          { question: 'Вопрос 2', answer: 'Ответ 2' },
        ]);
      case 'Article':
      case 'BlogPosting':
        return geo.buildArticleJsonLd({
          headline: ctx.sampleTitle || name, url: ctx.sampleUrl || site,
          authorName: 'Автор', datePublished: ctx.today,
        });
      case 'HowTo':
        return geo.buildHowToJsonLd({
          name: ctx.sampleTitle || 'Инструкция',
          steps: [{ name: 'Шаг 1', text: '...' }, { name: 'Шаг 2', text: '...' }],
        });
      default:
        return null;
    }
  } catch (_) {
    return null;
  }
}

/**
 * Строит рекомендации по микроразметке для набора инвентаризированных шаблонов.
 *
 * @param {Array} inventories — результат schemaInventory.inventoryTemplate[]
 * @param {object} ctx { siteUrl, projectName }
 * @returns {{available:boolean, items:Array, summary:object}}
 */
function recommendSchema(inventories, ctx = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const items = (inventories || []).map((inv) => {
    const snippets = {};
    (inv.missing_types || []).forEach((type) => {
      const snip = _snippetFor(type, { ...ctx, template: inv.template, sampleUrl: inv.sample_url, today });
      if (snip) snippets[type] = snip;
    });
    const actions = [];
    (inv.missing_types || []).forEach((t) => actions.push(`Добавить микроразметку ${t}.`));
    (inv.broken_fields || []).forEach((bf) => {
      actions.push(`Заполнить поля ${bf.missing_fields.join(', ')} в ${bf.type}.`);
    });
    return {
      template: inv.template,
      sample_url: inv.sample_url,
      present_types: inv.present_types,
      missing_types: inv.missing_types,
      broken_fields: inv.broken_fields,
      actions,
      snippets,
    };
  });

  const totalMissing = items.reduce((s, i) => s + (i.missing_types || []).length, 0);
  const totalBroken = items.reduce((s, i) => s + (i.broken_fields || []).length, 0);
  return {
    available: items.length > 0,
    items,
    summary: { templates: items.length, missing_types: totalMissing, broken_fields: totalBroken },
  };
}

module.exports = { recommendSchema, getProjectsConfig };
