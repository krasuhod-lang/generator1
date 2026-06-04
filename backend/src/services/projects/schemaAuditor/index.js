'use strict';

/**
 * schemaAuditor/index — оркестратор аудита микроразметки (п.8 ТЗ).
 *
 * Вход — результат eat-слоя (snapshot.eat.templates + транзитные _scans с
 * hiddenLayers). Не делает собственного fetch: переиспускает уже скачанные
 * парсером данные. Полностью детерминированный, graceful.
 */

const { getProjectsConfig } = require('../config');
const { inventoryTemplate } = require('./schemaInventory');
const { recommendSchema } = require('./schemaRecommender');

/**
 * @param {object} args { eatResult, project }
 *   eatResult — объект из eatAnalyzer.analyzeEat (templates + _scans)
 * @returns {{available:boolean, items:Array, summary:object}|null}
 */
function auditSchema({ eatResult, project } = {}) {
  const cfg = getProjectsConfig().schemaAudit;
  if (!cfg || !cfg.enabled) return null;
  if (!eatResult || !eatResult.available || !Array.isArray(eatResult.templates)) {
    return { available: false, reason: 'no_eat_data' };
  }
  const scansByTpl = new Map();
  (eatResult._scans || []).forEach((s) => scansByTpl.set(s.template, s.hiddenLayers));

  const inventories = eatResult.templates
    .filter((t) => !t.error)
    .map((t) => inventoryTemplate(t, scansByTpl.get(t.template), cfg));

  const ctx = {
    siteUrl: (project && (project.gsc_site_url || project.url)) || '',
    projectName: (project && project.name) || '',
  };
  return recommendSchema(inventories, ctx);
}

module.exports = { auditSchema, inventoryTemplate, recommendSchema };
