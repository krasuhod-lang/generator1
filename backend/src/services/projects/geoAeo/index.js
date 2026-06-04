'use strict';

/**
 * geoAeo/index — оркестратор GEO/AEO слоя (п.7 ТЗ). Детерминированный AEO-план
 * (всегда) + опциональный сетевой AI-visibility probe (graceful). Probe по
 * умолчанию выключен внутри пайплайна анализа (бережём лимиты ключа) и
 * запускается отдельным ручным эндпоинтом.
 */

const { getProjectsConfig } = require('../config');
const { buildAeo } = require('./aeoOptimizer');
const { probeAiVisibility } = require('./aiVisibilityProbe');

/**
 * @param {object} args { project, topQueries, schemaAudit, breakdowns, brandTokens,
 *   runProbe?:boolean, fetchSerp? }
 * @returns {Promise<object|null>} snapshot.geo_aeo
 */
async function buildGeoAeo({ project, topQueries, schemaAudit, breakdowns, brandTokens,
  runProbe = false, fetchSerp = null } = {}) {
  const cfg = getProjectsConfig().geoAeo;
  if (!cfg || !cfg.enabled) return null;
  try {
    const aeo = buildAeo({ topQueries, schemaAudit, breakdowns, brandTokens }) || { available: false };
    let visibility = null;
    if (runProbe) {
      visibility = await probeAiVisibility({ project, topQueries, fetchSerp });
    }
    return {
      available: true,
      aeo,
      ai_visibility: visibility,
    };
  } catch (err) {
    return { available: false, error: String((err && err.message) || err) };
  }
}

module.exports = { buildGeoAeo, probeAiVisibility };
