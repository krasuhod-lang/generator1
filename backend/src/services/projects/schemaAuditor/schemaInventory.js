'use strict';

/**
 * schemaAuditor/schemaInventory — инвентаризация и валидация микроразметки
 * (п.8 ТЗ). Использует structured_data (jsonld + microdata), уже извлечённую
 * парсером (parser/hiddenLayers) в eat-слое — без повторного fetch.
 *
 * Для каждого шаблона: какие @type найдены, какие ключевые поля битые/пустые,
 * каких ожидаемых для этого типа страницы типов не хватает.
 */

const { getProjectsConfig } = require('../config');
const { collectJsonLdTypes } = require('../eatAnalyzer/blockDetector');

/**
 * Достаёт «плоский» список объектов JSON-LD (разворачивает @graph/массивы),
 * чтобы проверять обязательные поля по каждому объекту-типу.
 */
function flattenJsonLdObjects(jsonld) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node['@graph']) { walk(node['@graph']); }
    if (node['@type']) out.push(node);
    Object.keys(node).forEach((k) => {
      if (k !== '@graph' && node[k] && typeof node[k] === 'object') walk(node[k]);
    });
  };
  walk(jsonld);
  return out;
}

function _typeNames(obj) {
  const t = obj['@type'];
  if (Array.isArray(t)) return t.map(String);
  return t ? [String(t)] : [];
}

/**
 * Проверяет валидность полей одного JSON-LD объекта по requiredFields.
 * @returns {Array<{type, missing_fields:string[]}>}
 */
function validateObject(obj, requiredFields) {
  const issues = [];
  _typeNames(obj).forEach((type) => {
    const req = requiredFields[type];
    if (!req) return;
    const missing = req.filter((f) => {
      const v = obj[f];
      if (v == null) return true;
      if (typeof v === 'string' && v.trim() === '') return true;
      if (Array.isArray(v) && v.length === 0) return true;
      return false;
    });
    if (missing.length) issues.push({ type, missing_fields: missing });
  });
  return issues;
}

/**
 * Инвентаризация микроразметки одного шаблона (по его представителю).
 *
 * @param {object} template — элемент snapshot.eat.templates (template, schema_types, sample_url)
 * @param {object} hiddenLayers — hiddenLayers представителя (для глубокой валидации)
 * @param {object} [cfg] getProjectsConfig().schemaAudit
 */
function inventoryTemplate(template, hiddenLayers, cfg) {
  const sc = cfg || getProjectsConfig().schemaAudit;
  const sd = (hiddenLayers && hiddenLayers.structured_data) || {};
  const objects = [];
  (sd.jsonld || []).forEach((j) => flattenJsonLdObjects(j).forEach((o) => objects.push(o)));

  const presentTypes = new Set();
  (template.schema_types || []).forEach((t) => presentTypes.add(t));
  objects.forEach((o) => _typeNames(o).forEach((t) => presentTypes.add(t)));

  // Валидация обязательных полей.
  const brokenFields = [];
  objects.forEach((o) => {
    validateObject(o, sc.requiredFields).forEach((iss) => brokenFields.push(iss));
  });

  // Каких типов не хватает для этого шаблона.
  const expected = sc.expectedByTemplate[template.template] || [];
  const present = Array.from(presentTypes);
  const presentLc = present.map((t) => t.toLowerCase());
  const missingTypes = expected.filter((t) => !presentLc.includes(t.toLowerCase()));

  return {
    template: template.template,
    sample_url: template.sample_url,
    present_types: present,
    expected_types: expected,
    missing_types: missingTypes,
    broken_fields: brokenFields,
    microdata_count: (sd.microdata || []).length,
  };
}

module.exports = { flattenJsonLdObjects, validateObject, inventoryTemplate };
