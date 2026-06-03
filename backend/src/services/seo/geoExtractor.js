'use strict';

/**
 * geoExtractor — извлекает из финального HTML статьи блоки, нужные для
 * сборки JSON-LD: H1, FAQ Q&A, HowTo шаги, описание (lead-answer / первый абзац),
 * cover-картинку.
 *
 * Используется в info/linkArticle pipeline после Stage 3, перед сохранением.
 * Намеренно не использует внешние парсеры HTML — лёгкие regex'ы достаточны
 * для подмножества тегов, которые мы сами генерируем.
 *
 * API:
 *   extractH1(html)               → string
 *   extractCoverImage(html)       → string|null
 *   extractLeadAnswer(html)       → string  (текст из <p class="lead-answer">)
 *   extractFirstParagraph(html)   → string  (fallback если lead-answer нет)
 *   extractFaqItems(html)         → [{question, answer}]
 *   extractHowToSteps(html)       → [{name?, text}]
 *   buildArticleDescription(html) → string  (lead-answer || первый абзац, обрезано до 600)
 */

const { sanitizeText } = require('./geoSchema');

function _strip(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractH1(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? _strip(m[1]) : '';
}

function extractCoverImage(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<img[^>]*\bsrc\s*=\s*"([^"]+)"/i);
  if (!m) return null;
  const src = m[1];
  if (!/^https?:\/\//i.test(src)) return null;
  return src;
}

function extractLeadAnswer(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/<p[^>]*class\s*=\s*"[^"]*\blead-answer\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  return m ? _strip(m[1]) : '';
}

function extractFirstParagraph(html) {
  if (typeof html !== 'string') return '';
  // Берём первый <p>, не являющийся byline/answer-lead заголовком.
  const re = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/class\s*=\s*"[^"]*\b(byline|toc|summary)\b/i.test(attrs)) continue;
    const txt = _strip(m[2]);
    if (txt.length >= 40) return txt;
  }
  return '';
}

/**
 * Извлекает FAQ Q&A из секции <h2>Часто задаваемые вопросы</h2>.
 * Идём от этого H2 до следующего H2 (или до конца), собираем пары <h3>/<p>.
 */
function extractFaqItems(html) {
  if (typeof html !== 'string') return [];
  const startRe = /<h2[^>]*>\s*(?:часто\s+задаваемые\s+вопросы|faq|вопросы\s+и\s+ответы)\s*<\/h2>/i;
  const start = html.search(startRe);
  if (start < 0) return [];
  const tail = html.slice(start);
  const nextH2 = tail.slice(1).search(/<h2[^>]*>/i);
  const block = nextH2 >= 0 ? tail.slice(0, nextH2 + 1) : tail;

  const items = [];
  const pairRe = /<h3[^>]*>([\s\S]*?)<\/h3>\s*((?:<p[^>]*>[\s\S]*?<\/p>\s*)+)/gi;
  let m;
  while ((m = pairRe.exec(block)) !== null) {
    const q = _strip(m[1]);
    const a = _strip(m[2]);
    if (q && a) items.push({ question: q, answer: a });
  }
  return items;
}

/**
 * Извлекает шаги HowTo:
 *  • из <ol class="howto"><li>… или
 *  • из любого <ol> непосредственно после <h2>, если в <li> начинаются с «Шаг N»/«Step N».
 */
function extractHowToSteps(html) {
  if (typeof html !== 'string') return [];
  const olRe = /<ol([^>]*)>([\s\S]*?)<\/ol>/gi;
  let best = [];
  let m;
  while ((m = olRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2];
    const isHowTo = /class\s*=\s*"[^"]*\bhowto\b/i.test(attrs);
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    const steps = [];
    let lm;
    while ((lm = liRe.exec(body)) !== null) {
      const txt = _strip(lm[1]);
      if (!txt) continue;
      const stepMatch = txt.match(/^(?:шаг|step|этап)\s{0,4}\d+[\s.:\-—)]+(.+)$/i);
      if (stepMatch) {
        steps.push({ text: stepMatch[1].trim() });
      } else if (isHowTo) {
        steps.push({ text: txt });
      }
    }
    if (steps.length >= 2 && steps.length > best.length) best = steps;
  }
  return best;
}

function buildArticleDescription(html) {
  const lead = extractLeadAnswer(html);
  if (lead) return sanitizeText(lead, 600);
  const fp = extractFirstParagraph(html);
  return sanitizeText(fp, 600);
}

module.exports = {
  extractH1,
  extractCoverImage,
  extractLeadAnswer,
  extractFirstParagraph,
  extractFaqItems,
  extractHowToSteps,
  buildArticleDescription,
};
