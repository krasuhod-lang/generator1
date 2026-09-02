'use strict';

const MAX = Object.freeze({
  genre: 120,
  tone: 180,
  complexity: 120,
  professional_level: 120,
  business_type: 180,
  site_type: 120,
  language: 40,
  audience: 300,
  voice_notes: 500,
});

function clean(value, max) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parse(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeWritingProfile(value = {}, fallback = {}) {
  const source = { ...fallback, ...parse(value) };
  return {
    genre: clean(source.genre || source.content_genre || source.writing_genre, MAX.genre),
    tone: clean(source.tone || source.tone_of_voice || source.content_tone, MAX.tone),
    complexity: clean(source.complexity || source.reading_level, MAX.complexity),
    professional_level: clean(source.professional_level || source.expertise_level, MAX.professional_level),
    business_type: clean(source.business_type || source.input_business_type, MAX.business_type),
    site_type: clean(source.site_type || source.input_site_type, MAX.site_type),
    language: clean(source.language || source.input_language || 'ru', MAX.language) || 'ru',
    audience: clean(source.audience || source.target_audience || source.input_target_audience, MAX.audience),
    voice_notes: clean(source.voice_notes || source.voice || source.style_notes, MAX.voice_notes),
    freshness_required: source.freshness_required === true || source.freshness_required === 'true',
    current_law_required: source.current_law_required === true || source.current_law_required === 'true',
  };
}

function hasExplicitProfile(profile) {
  return ['genre', 'tone', 'complexity', 'professional_level', 'voice_notes']
    .some((key) => Boolean(profile?.[key]));
}

function renderWritingProfileBlock(profile) {
  const p = normalizeWritingProfile(profile);
  const lines = [
    '## WRITING PROFILE (user-provided constraints; not evidence)',
    `- Genre: ${p.genre || 'infer from business type, intent and audience'}`,
    `- Tone: ${p.tone || 'infer from verified brand voice and audience'}`,
    `- Complexity: ${p.complexity || 'adapt to audience'}`,
    `- Professional level: ${p.professional_level || 'adapt to niche and verified author expertise'}`,
  ];
  if (p.voice_notes) lines.push(`- Style notes: ${p.voice_notes}`);
  if (p.freshness_required || p.current_law_required) {
    lines.push(`- Freshness: ${p.freshness_required ? 'required' : 'not explicitly required'}`);
    lines.push(`- Current law/regulation check: ${p.current_law_required ? 'required' : 'not explicitly required'}`);
    lines.push('- Never invent current dates, laws, prices or regulatory claims; use dated verified sources or mark the claim for review.');
  }
  return lines.join('\n');
}

module.exports = { normalizeWritingProfile, hasExplicitProfile, renderWritingProfileBlock, MAX };
