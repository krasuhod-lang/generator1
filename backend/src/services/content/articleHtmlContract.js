'use strict';

/**
 * Deterministic article HTML contract.
 *
 * This is intentionally independent from any LLM self_audit. The writer may
 * claim that a block exists; this module checks the rendered HTML itself.
 */

function countMatches(text, re) {
  return String(text || '').match(re)?.length || 0;
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const m = String(attrs || '').match(re);
  return m ? m[2] : '';
}

function hasClass(attrs, className) {
  return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b`, 'i').test(String(attrs || ''));
}

function stripTags(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return stripTags(text).split(/\s+/).filter(Boolean);
}

function normalize(text) {
  return stripTags(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function getBlocks(html, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return Array.from(String(html || '').matchAll(re)).map((m) => ({
    attrs: m[1] || '',
    inner: m[2] || '',
    full: m[0],
    index: m.index || 0,
    end: (m.index || 0) + m[0].length,
  }));
}

function issue(severity, category, message) {
  return { severity, category, message };
}

function issueText(item) {
  return `[${item.severity}|${item.category}] ${item.message}`;
}

function isSpecialHeading(h2) {
  const text = normalize(h2.inner);
  const id = attr(h2.attrs, 'id').toLowerCase();
  return id === 'sec-faq'
    || id === 'sec-summary'
    || id === 'sec-conclusion'
    || /часто задаваемые вопросы|^итоги$|^заключение$/i.test(text);
}

function resolveExpectedSections(outline) {
  const source = outline && Array.isArray(outline.sections) ? outline.sections : [];
  return source
    .map((section) => ({
      index: section && section.index != null ? String(section.index) : '',
      title: section && (section.h2 || section.title || '') ? String(section.h2 || section.title) : '',
    }))
    .filter((section) => section.index && section.title);
}

/**
 * @param {string} html
 * @param {object} options
 * @returns {{ok:boolean, issues:object[], issueTexts:string[], counts:object}}
 */
function validateArticleHtmlContract(html, options = {}) {
  const {
    pipeline = 'info',
    outline = null,
    currentYear = new Date().getFullYear(),
    today = new Date().toISOString().slice(0, 10),
    requireByline = true,
    requireLeadAnswer = true,
    requireToc = true,
    requireAnswerLead = true,
    requireExpertOpinion = true,
    requireFaq = true,
    requireSummary = true,
    requireConclusion = true,
    faqMin = 4,
    faqMax = 6,
    summaryMin = 3,
    summaryMax = 6,
  } = options;

  const issues = [];
  const add = (severity, category, message) => issues.push(issue(severity, category, message));
  const source = String(html || '');
  if (!source.trim()) {
    add('blocker', 'html_empty', 'article_html пустой.');
    return { ok: false, issues, issueTexts: issues.map(issueText), counts: {} };
  }

  const h1s = getBlocks(source, 'h1');
  const h2s = getBlocks(source, 'h2');
  const h3s = getBlocks(source, 'h3');
  const bylines = getBlocks(source, 'p').filter((b) => hasClass(b.attrs, 'byline'));
  const leads = getBlocks(source, 'p').filter((b) => hasClass(b.attrs, 'lead-answer'));
  const answerLeads = getBlocks(source, 'p').filter((b) => hasClass(b.attrs, 'answer-lead'));
  const tocs = getBlocks(source, 'nav').filter((b) => hasClass(b.attrs, 'toc'));
  const experts = getBlocks(source, 'blockquote').filter((b) => hasClass(b.attrs, 'expert-opinion'));
  const summaries = getBlocks(source, 'section').filter((b) => hasClass(b.attrs, 'summary'));
  const faqHeadings = h2s.filter((h2) => attr(h2.attrs, 'id').toLowerCase() === 'sec-faq'
    || /часто задаваемые вопросы/i.test(normalize(h2.inner)));
  const summaryHeadings = h2s.filter((h2) => attr(h2.attrs, 'id').toLowerCase() === 'sec-summary'
    || /^итоги$/i.test(normalize(h2.inner)));
  const conclusionHeadings = h2s.filter((h2) => attr(h2.attrs, 'id').toLowerCase() === 'sec-conclusion'
    || /^заключение$/i.test(normalize(h2.inner)));

  if (h1s.length !== 1) add('blocker', 'h1_count', `<h1> должен встречаться ровно 1 раз; найдено ${h1s.length}.`);

  const h1End = h1s[0]?.end || 0;
  const afterH1 = source.slice(h1End);
  const firstTagAfterH1 = afterH1.match(/^\s*(?:<!--[\s\S]*?-->\s*)*<([a-z0-9]+)\b/i)?.[1]?.toLowerCase() || '';

  if (requireByline) {
    if (bylines.length !== 1) {
      add('blocker', 'byline', `Byline должен встречаться ровно 1 раз; найдено ${bylines.length}.`);
    } else if (firstTagAfterH1 !== 'p' || !hasClass(afterH1.match(/^\s*<p\b([^>]*)>/i)?.[1] || '', 'byline')) {
      add('blocker', 'byline_position', 'Byline должен идти непосредственно после <h1>.');
    }
  }

  if (requireLeadAnswer) {
    if (leads.length !== 1) {
      add('blocker', 'lead_answer', `<p class="lead-answer"> должен встречаться ровно 1 раз; найдено ${leads.length}.`);
    } else {
      const leadBeforeToc = tocs.length ? leads[0].index < tocs[0].index : true;
      if (!leadBeforeToc) add('blocker', 'lead_answer_position', 'lead-answer должен находиться до TOC.');
      if (words(leads[0].inner).length > 100) add('major', 'lead_answer_length', 'lead-answer превышает 100 слов.');
    }
  }

  if (requireToc) {
    if (tocs.length !== 1) {
      add('blocker', 'toc', `<nav class="toc"> должен встречаться ровно 1 раз; найдено ${tocs.length}.`);
    }
  }

  const expectedSections = resolveExpectedSections(outline);
  const mainH2s = expectedSections.length
    ? expectedSections.map((section) => ({
      expected: section,
      actual: h2s.find((h2) => attr(h2.attrs, 'id') === `sec-${section.index}`),
    }))
    : h2s.filter((h2) => !isSpecialHeading(h2)).map((h2) => ({
      expected: { index: attr(h2.attrs, 'id').replace(/^sec-/i, ''), title: stripTags(h2.inner) },
      actual: h2,
    }));

  for (const item of mainH2s) {
    if (!item.actual) {
      add('blocker', 'h2_anchor', `Отсутствует основной H2-якорь #sec-${item.expected.index}.`);
      continue;
    }
    if (requireAnswerLead) {
      const tail = source.slice(item.actual.end);
      const nextH2 = tail.search(/<h2\b/i);
      const sectionBody = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
      if (!/^\s*<p\b[^>]*class\s*=\s*["'][^"']*\banswer-lead\b/i.test(sectionBody)) {
        add('blocker', 'answer_lead', `Секция #sec-${item.expected.index} должна начинаться с <p class="answer-lead">.`);
      }
    }
  }

  if (tocs.length === 1) {
    const tocAnchors = Array.from(tocs[0].inner.matchAll(/<a\b([^>]*)>/gi))
      .map((m) => attr(m[1], 'href'))
      .filter((href) => href.startsWith('#'));
    const h2Ids = new Set(h2s.map((h2) => attr(h2.attrs, 'id')).filter(Boolean));
    for (const href of tocAnchors) {
      if (!h2Ids.has(href.slice(1))) add('blocker', 'dead_toc_anchor', `TOC содержит несуществующий якорь ${href}.`);
    }
    for (const item of mainH2s) {
      const anchor = `#sec-${item.expected.index}`;
      if (!tocAnchors.includes(anchor)) add('blocker', 'toc_coverage', `TOC не содержит ссылку ${anchor}.`);
    }
  }

  if (requireExpertOpinion) {
    if (experts.length !== 1) {
      add('blocker', 'expert_opinion', `expert-opinion должен встречаться ровно 1 раз; найдено ${experts.length}.`);
    } else {
      const body = experts[0].inner;
      if (!/<footer\b|<cite\b|мнение\s+эксперта/i.test(body)) {
        add('blocker', 'expert_attribution', 'expert-opinion должен содержать обезличенную атрибуцию через footer/cite.');
      }
    }
  }

  if (requireFaq) {
    if (faqHeadings.length !== 1) {
      add('blocker', 'faq_block', `FAQ должен иметь ровно один H2; найдено ${faqHeadings.length}.`);
    } else {
      const tail = source.slice(faqHeadings[0].end);
      const nextH2 = tail.search(/<h2\b/i);
      const faqBody = nextH2 >= 0 ? tail.slice(0, nextH2) : tail;
      const count = countMatches(faqBody, /<h3\b/gi);
      if (count < faqMin || count > faqMax) {
        add('blocker', 'faq_questions', `FAQ должен содержать ${faqMin}–${faqMax} вопросов; найдено ${count}.`);
      }
      if (summaryHeadings.length && summaryHeadings[0].index < faqHeadings[0].index) {
        add('blocker', 'faq_order', 'FAQ должен находиться до блока «Итоги».');
      }
    }
  }

  if (requireSummary) {
    if (summaries.length !== 1 || summaryHeadings.length !== 1) {
      add('blocker', 'summary_block', 'Нужен ровно один <section class="summary"><h2 id="sec-summary">Итоги</h2>…</section>.');
    } else {
      const count = countMatches(summaries[0].inner, /<li\b/gi);
      if (count < summaryMin || count > summaryMax) {
        add('blocker', 'summary_items', `Блок «Итоги» должен содержать ${summaryMin}–${summaryMax} пунктов; найдено ${count}.`);
      }
    }
  }

  if (requireConclusion && conclusionHeadings.length !== 1) {
    add('blocker', 'conclusion', `Нужен ровно один <h2 id="sec-conclusion">Заключение</h2>; найдено ${conclusionHeadings.length}.`);
  }

  if (bylines.length === 1) {
    const time = getBlocks(bylines[0].inner, 'time')[0];
    const date = time ? attr(time.attrs, 'datetime') : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      add('blocker', 'byline_date', 'Byline должен содержать <time datetime="YYYY-MM-DD">.');
    } else if (date > today) {
      add('blocker', 'future_date', `Дата обновления ${date} не может быть позже текущей даты ${today}.`);
    } else if (Number(date.slice(0, 4)) > Number(currentYear)) {
      add('blocker', 'future_year', `Год обновления ${date.slice(0, 4)} превышает current_year ${currentYear}.`);
    }
  }

  const blockerCount = issues.filter((item) => item.severity === 'blocker').length;
  return {
    ok: issues.length === 0,
    issues,
    issueTexts: issues.map(issueText),
    blockers: blockerCount,
    warnings: issues.length - blockerCount,
    counts: {
      h1: h1s.length,
      h2: h2s.length,
      h3: h3s.length,
      byline: bylines.length,
      leadAnswer: leads.length,
      toc: tocs.length,
      answerLeads: answerLeads.length,
      expertOpinion: experts.length,
      faq: faqHeadings.length,
      summary: summaries.length,
      conclusion: conclusionHeadings.length,
    },
    pipeline,
  };
}

module.exports = {
  validateArticleHtmlContract,
  stripTags,
  getBlocks,
};
