'use strict';

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asTextArray(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === 'string' || typeof item === 'number') return [String(item)];
        if (item && typeof item === 'object') {
          const preferred = item.text || item.name || item.label || item.title || item.value;
          return preferred ? [String(preferred)] : Object.values(item).filter((v) => typeof v === 'string');
        }
        return [];
      })
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== value) return asTextArray(parsed);
    } catch (_) {
      // Plain model text is handled as newline/semicolon-delimited values.
    }
    return trimmed
      .split(/[\n;|]+/)
      .map((item) => item.replace(/^[-•*\d.)]+\s*/, '').trim())
      .filter(Boolean);
  }
  if (value && typeof value === 'object') return asTextArray(Object.values(value));
  return [];
}

function missingField(label) {
  return `Информация не обнаружена: ${label}. Не использовать неподтверждённые утверждения.`;
}

function normalizeTargetPageAnalysis(raw) {
  const input = asObject(raw);
  const listFields = [
    'niche_features',
    'project_limits',
    'eeat_signals_present',
    'eeat_signals_missing',
    'client_segments',
    'works_with',
  ];
  const result = { ...input };
  for (const field of listFields) result[field] = asTextArray(input[field]);

  const aliases = {
    client_segments: ['category_clients', 'customer_categories', 'client_categories'],
    works_with: ['working_with', 'who_works_with', 'target_clients'],
  };
  for (const [canonical, candidates] of Object.entries(aliases)) {
    if (!result[canonical].length) {
      for (const candidate of candidates) {
        const values = asTextArray(input[candidate]);
        if (values.length) {
          result[canonical] = values;
          break;
        }
      }
    }
  }

  for (const field of [
    'target_audience',
    'brand_name',
    'brand_facts',
    'service_details',
    'proof_assets',
    'detected_region',
    'detected_business_type',
    'detected_business_goal',
    'detected_site_type',
  ]) {
    const value = asText(input[field]);
    result[field] = value || null;
  }

  const missingFields = [];
  if (!result.client_segments.length) missingFields.push('client_segments');
  if (!result.works_with.length) missingFields.push('works_with');
  if (!result.eeat_signals_present.length) missingFields.push('eeat_signals_present');
  if (!result.eeat_signals_missing.length) missingFields.push('eeat_signals_missing');
  if (!result.project_limits.length) missingFields.push('project_limits');
  result.data_completeness = {
    status: missingFields.length ? 'partial' : 'complete',
    missing_fields: missingFields,
    missing_markers: missingFields.map((field) => missingField(field)),
  };
  return result;
}

function normalizeAudienceNicheAnalysis(raw) {
  const input = asObject(raw);
  const result = { ...input };
  result.audience_personas = Array.isArray(input.audience_personas)
    ? input.audience_personas.filter((item) => item && typeof item === 'object')
    : [];
  result.niche_deep_dive = Array.isArray(input.niche_deep_dive)
    ? input.niche_deep_dive.filter((item) => item && typeof item === 'object')
    : [];
  result.niche_terminology = asTextArray(input.niche_terminology);
  result.niche_red_flags = Array.isArray(input.niche_red_flags)
    ? input.niche_red_flags.filter((item) => item && typeof item === 'object')
    : [];
  result.content_voice = asObject(input.content_voice);
  const missingFields = [];
  if (!result.audience_personas.length) missingFields.push('audience_personas');
  if (!result.niche_deep_dive.length) missingFields.push('niche_deep_dive');
  if (!result.niche_terminology.length) missingFields.push('niche_terminology');
  if (!Object.keys(result.content_voice).length) missingFields.push('content_voice');
  result.data_completeness = {
    status: missingFields.length ? 'partial' : 'complete',
    missing_fields: missingFields,
    missing_markers: missingFields.map((field) => missingField(field)),
  };
  return result;
}

module.exports = {
  asObject,
  asText,
  asTextArray,
  normalizeTargetPageAnalysis,
  normalizeAudienceNicheAnalysis,
};
