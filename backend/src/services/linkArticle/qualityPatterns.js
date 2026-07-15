'use strict';

const BANNED_INTRO_PATTERNS = [
  { label: 'в современном мире', re: /(^|[^\p{L}])в\s+современном\s+мире($|[^\p{L}])/iu },
  { label: 'многие задаются вопросом', re: /(^|[^\p{L}])многие\s+задаются\s+вопросом($|[^\p{L}])/iu },
  { label: 'не секрет, что', re: /(^|[^\p{L}])не\s+секрет\s*,?\s+что($|[^\p{L}])/iu },
  { label: 'как известно', re: /(^|[^\p{L}])как\s+известно($|[^\p{L}])/iu },
  { label: 'в наше время', re: /(^|[^\p{L}])в\s+наше\s+время($|[^\p{L}])/iu },
  { label: 'сегодня сложно представить', re: /(^|[^\p{L}])сегодня\s+сложно\s+представить($|[^\p{L}])/iu },
];

function stripTags(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s—-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParagraphs(html) {
  const out = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const text = normalizeText(stripTags(match[1]));
    if (text && text.split(/\s+/).length >= 4) out.push(text);
  }
  return out;
}

function structuralSignature(paragraph) {
  const words = paragraph.split(/\s+/).filter(Boolean);
  const first = words[0] || '';
  const dashIsPattern = /^[\p{L}\p{N}\s-]{2,60}\s+[—-]\s+это\b/u.test(paragraph);
  const isThisPattern = words.slice(0, 4).includes('это');
  return dashIsPattern || isThisPattern ? 'x-это' : first;
}

function similarLength(a, b) {
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  return max > 0 && min / max >= 0.85;
}

function hasRepetitiveStructure(paragraphs) {
  for (let i = 0; i <= paragraphs.length - 3; i += 1) {
    const a = paragraphs[i];
    const b = paragraphs[i + 1];
    const c = paragraphs[i + 2];
    const sig = structuralSignature(a);
    if (
      sig &&
      structuralSignature(b) === sig &&
      structuralSignature(c) === sig &&
      similarLength(a, b) &&
      similarLength(b, c)
    ) {
      return true;
    }
  }
  return false;
}

function detectBannedPatterns(html) {
  const plain = normalizeText(stripTags(html));
  const bannedIntros = BANNED_INTRO_PATTERNS
    .filter((p) => p.re.test(plain))
    .map((p) => p.label);
  const paragraphs = extractParagraphs(html);
  const repetitiveStructure = hasRepetitiveStructure(paragraphs);
  const hasTableOrList = /<(table|ul|ol)\b/i.test(String(html || ''));

  return {
    banned_intros: bannedIntros,
    repetitive_structure: repetitiveStructure,
    has_table_or_list: hasTableOrList,
    ok: bannedIntros.length === 0 && !repetitiveStructure && hasTableOrList,
  };
}

module.exports = {
  detectBannedPatterns,
  _internal: {
    stripTags,
    extractParagraphs,
    structuralSignature,
    hasRepetitiveStructure,
  },
};
