'use strict';

/**
 * Детерминированный анализ SERP-сниппетов конкурентов для GIST Meta Filter.
 * Без LLM: повторяющиеся фразы, CTA, длины и «шум» ТОПа, который нельзя
 * копировать в генерации.
 */

const { normalizeWord, STOP_WORDS } = require('./semantics');

const CTA_DEFS = [
  ['узнайте', /узна[йй]те?/i],
  ['записывайтесь', /запис(?:ывайтесь|ать(?:ся)?|итесь|ьтесь)/i],
  ['подробнее', /подробн/i],
  ['закажите', /закаж(?:ите|и|ем|ать)/i],
  ['купите', /куп(?:ите|ить|и)/i],
  ['звоните', /звон(?:ите|ок|и)/i],
  ['оставьте заявку', /оставьте?\s+заявк/i],
  ['получите', /получ(?:ите|ить)/i],
  ['выберите', /выбер(?:ите|и)|выберите/i],
  ['скачайте', /скач(?:айте|ать)/i],
];

const CLICHES = [
  'высокое качество',
  'лучший выбор',
  'доступные цены',
  'широкий ассортимент',
  'индивидуальный подход',
  'выгодные условия',
];

function _serpTitle(item) {
  return String(item.serp_title || item.title || '').replace(/\s+/g, ' ').trim();
}

function _serpDescription(item) {
  return String(item.serp_description || item.snippet || item.description || '')
    .replace(/\s+/g, ' ').trim();
}

function _stats(values) {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return { min: 0, max: 0, avg: 0 };
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    avg: Math.round(sum / nums.length),
  };
}

function _tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^а-яёa-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter(({ raw, norm }) => (
      norm.length > 2 && !STOP_WORDS.has(norm) && !/^\d+$/.test(raw)
    ));
}

function _collectRepeatedPhrases(items) {
  const phraseDocs = new Map();
  items.forEach((item, docIdx) => {
    const tokens = _tokens(`${_serpTitle(item)} ${_serpDescription(item)}`);
    const seenInDoc = new Set();
    for (const size of [2, 3]) {
      for (let i = 0; i <= tokens.length - size; i += 1) {
        const slice = tokens.slice(i, i + size);
        const key = slice.map((t) => t.norm).join(' ');
        if (seenInDoc.has(key)) continue;
        seenInDoc.add(key);
        if (!phraseDocs.has(key)) {
          phraseDocs.set(key, { phrase: slice.map((t) => t.raw).join(' '), docs: new Set() });
        }
        phraseDocs.get(key).docs.add(docIdx);
      }
    }
  });
  return [...phraseDocs.values()]
    .filter((entry) => entry.docs.size >= 2)
    .sort((a, b) => b.docs.size - a.docs.size || a.phrase.localeCompare(b.phrase, 'ru'))
    .map((entry) => entry.phrase)
    .slice(0, 20);
}

function _collectCtas(items) {
  const counts = new Map();
  items.forEach((item) => {
    const text = `${_serpTitle(item)} ${_serpDescription(item)}`;
    const seen = new Set();
    CTA_DEFS.forEach(([label, re]) => {
      if (re.test(text)) seen.add(label);
    });
    seen.forEach((label) => counts.set(label, (counts.get(label) || 0) + 1));
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
}

function _titlePattern(title) {
  const t = String(title || '').trim();
  if (!t) return 'plain';
  if (/[?？]$/.test(t) || /^(как|что|почему|где|когда|сколько|какой)\b/i.test(t)) {
    return 'question';
  }
  if (/^(?:топ|top|рейтинг|№)\s*-?\s*\d+|\b\d+\s+(?:лучших|способов|причин|вариантов)\b/i.test(t)) {
    return 'listicle-number';
  }
  const parts = t.split(/\s[|—-]\s/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const suffix = parts[parts.length - 1];
    if (/[A-ZА-ЯЁ]{2,}|[«"“”„]/.test(suffix) || suffix.length <= 18) {
      return 'brand-suffix';
    }
    if (parts[0].length <= 35) return 'keyword-first';
  }
  return 'plain';
}

function _dominantPattern(titles) {
  const counts = new Map();
  titles.forEach((title) => {
    const p = _titlePattern(title);
    counts.set(p, (counts.get(p) || 0) + 1);
  });
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'plain';
}

function _cliches(items) {
  const found = new Set();
  items.forEach((item) => {
    const text = `${_serpTitle(item)} ${_serpDescription(item)}`.toLowerCase();
    CLICHES.forEach((phrase) => {
      if (text.includes(phrase)) found.add(phrase);
    });
  });
  return [...found].sort((a, b) => a.localeCompare(b, 'ru'));
}

function analyzeSnippets(serpSnippets) {
  const items = Array.isArray(serpSnippets) ? serpSnippets.filter(Boolean).slice(0, 10) : [];
  const titles = items.map(_serpTitle);
  const descriptions = items.map(_serpDescription);
  const allText = `${titles.join(' ')} ${descriptions.join(' ')}`;
  const repeatedPhrases = _collectRepeatedPhrases(items);
  const ctaEntries = _collectCtas(items);
  const ctaPatterns = ctaEntries.map(([label]) => label);
  const ctaNoise = ctaEntries.filter(([, count]) => count >= 2).map(([label]) => label);
  const noise = [...new Set([...repeatedPhrases, ...ctaNoise, ..._cliches(items)])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'ru'));

  return {
    dominant_title_pattern: _dominantPattern(titles),
    repeated_phrases: repeatedPhrases,
    used_numbers: /\d/.test(allText),
    used_year: /\b20\d{2}\b/.test(allText),
    cta_patterns: ctaPatterns,
    competitor_title_lengths: _stats(titles.map((t) => t.length)),
    competitor_desc_lengths: _stats(descriptions.map((d) => d.length)),
    competitor_noise: noise,
  };
}

module.exports = {
  analyzeSnippets,
  CTA_DEFS,
  CLICHES,
};
