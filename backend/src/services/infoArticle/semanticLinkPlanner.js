'use strict';

/**
 * semanticLinkPlanner — гибрид LLM + детерминированной математики для
 * выбора 1–2 коммерческих ссылок на каждый <h2> статьи.
 *
 * Поток:
 *   1. Построение "семантических профилей":
 *        – профиль h2: bag-of-stems из (h2 + descriptor + lsi_focus + jtbd_cluster + covers_user_questions);
 *        – профиль ссылки: bag-of-stems из h1 коммерческой страницы + slug-токены из URL.
 *   2. TF-IDF веса по корпусу h2-секций (для контрастирования общеупотребимых слов).
 *   3. Для каждой H2: вычисляем (cosine-TFIDF · 0.7 + Jaccard · 0.3) к каждой ссылке,
 *      берём top-K shortlist (по умолчанию 5).
 *   4. DeepSeek Stage 2C получает только short-list'ы и решает, какие 1–2 ссылки на H2.
 *   5. Пост-валидатор:
 *        – min/max ссылок на H2 (1..2);
 *        – url не повторяется чаще MAX_REPEATS_PER_URL;
 *        – semantic_score ≥ MIN_SEMANTIC_SCORE;
 *        – anchor_text — естественная фраза 2–5 слов, не URL и не «здесь/тут/click»;
 *        – «матриархальная» закономерность: первая ссылка role='primary' из top-3 short-list'a.
 *      Все исправимые нарушения (уберём дубль, заменим anchor) исправляются программно;
 *      непоправимые (нет минимум 1 ссылки на H2) — лечатся подстановкой top-1 short-list'a.
 *
 * Выход: { link_plan, graph_pattern, deterministic_audit, llm_raw }.
 */

const { callLLM } = require('../llm/callLLM');
const { loadInfoArticlePrompt } = require('../../prompts/infoArticle');
const { russianStem } = require('../../utils/russianStem');

const MAX_LINKS_PER_H2 = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MAX_LINKS_PER_H2, 10);
  return Number.isFinite(v) && v >= 1 && v <= 3 ? v : 2;
})();
const MIN_LINKS_PER_H2 = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MIN_LINKS_PER_H2, 10);
  return Number.isFinite(v) && v >= 1 && v <= MAX_LINKS_PER_H2 ? v : 1;
})();
const MAX_REPEATS_PER_URL = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_MAX_REPEATS_PER_URL, 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 2;
})();
const MIN_SEMANTIC_SCORE = (() => {
  const v = parseFloat(process.env.INFO_ARTICLE_MIN_SEMANTIC_SCORE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.18;
})();
const SHORTLIST_SIZE = 5;

const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','с','со','как','а','то','от','для','до',
  'из','за','к','о','об','по','при','про','у','же','бы','ли','же','или','но',
  'если','есть','быть','был','была','было','были','это','эта','этот','эти',
  'мой','моя','моё','наш','свой','свою','свой','их','им','ими','один','одна',
  'два','три','очень','можно','нужно','надо','услуга','услуги','цена','цены','купить',
]);
const ANCHOR_BLACKLIST = [
  /^здесь$/i, /^тут$/i, /^по\s+ссылке$/i, /^клик$/i, /^click(\s+here)?$/i,
  /^читайте\s+ещё$/i, /^подробнее$/i, /^больше$/i, /^see\s+more$/i,
  /^ссылк[аи]$/i, /^перейти$/i,
];

// ── Tokenization / stems ─────────────────────────────────────────────

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .split(/[^а-яa-z0-9-]+/i)
    .filter((w) => w && w.length >= 3 && !STOPWORDS.has(w));
}
function stemKey(word) {
  if (/^[a-z0-9-]+$/i.test(word)) return word.toLowerCase();
  return russianStem(word);
}
function stemBag(text, weight = 1) {
  const bag = new Map();
  for (const t of tokenize(text)) {
    const k = stemKey(t);
    bag.set(k, (bag.get(k) || 0) + weight);
  }
  return bag;
}
function mergeBag(target, source) {
  for (const [k, v] of source) target.set(k, (target.get(k) || 0) + v);
  return target;
}
function urlSlugTokens(url) {
  try {
    const u = new URL(url);
    const parts = decodeURIComponent(u.pathname || '')
      .split('/')
      .flatMap((p) => p.split(/[-_.]+/))
      .filter(Boolean);
    return parts;
  } catch (_) { return []; }
}

// ── Profiles ─────────────────────────────────────────────────────────

function buildH2Profile(section) {
  const bag = new Map();
  mergeBag(bag, stemBag(section?.h2 || '', 3));
  mergeBag(bag, stemBag(section?.descriptor || '', 1));
  mergeBag(bag, stemBag(section?.jtbd_cluster || '', 2));
  for (const lf of Array.isArray(section?.lsi_focus) ? section.lsi_focus : []) {
    mergeBag(bag, stemBag(lf, 2));
  }
  for (const q of Array.isArray(section?.covers_user_questions) ? section.covers_user_questions : []) {
    mergeBag(bag, stemBag(q, 0.5));
  }
  for (const e of Array.isArray(section?.must_include_entities) ? section.must_include_entities : []) {
    mergeBag(bag, stemBag(e, 1));
  }
  return bag;
}

function buildLinkProfile(link) {
  const bag = new Map();
  mergeBag(bag, stemBag(link?.h1 || '', 3));
  for (const t of urlSlugTokens(link?.url || '')) {
    if (t.length >= 3) {
      const k = stemKey(t);
      bag.set(k, (bag.get(k) || 0) + 1);
    }
  }
  return bag;
}

// ── TF-IDF + Cosine + Jaccard ────────────────────────────────────────

function buildIdf(profiles) {
  const N = profiles.length || 1;
  const df = new Map();
  for (const bag of profiles) {
    for (const k of bag.keys()) df.set(k, (df.get(k) || 0) + 1);
  }
  const idf = new Map();
  for (const [k, d] of df) {
    idf.set(k, Math.log(1 + N / d));
  }
  return idf;
}

function tfidfVector(bag, idf) {
  const v = new Map();
  for (const [k, tf] of bag) {
    const w = (idf.get(k) || 0.5) * (1 + Math.log(tf));
    v.set(k, w);
  }
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  if (!na || !nb) return 0;
  // iterate the smaller map
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, w] of small) {
    const w2 = big.get(k);
    if (w2) dot += w * w2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const k of small.keys()) if (big.has(k)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * Computes shortlist per h2. Returns {
 *   shortlistByH2: { [section_index]: [{url, h1, score, h1_stems, matched_lsi}] },
 *   sectionMeta:   [{ index, h2 }],
 * }
 */
function computeShortlists({ outline, links, k = SHORTLIST_SIZE }) {
  const sections = Array.isArray(outline?.sections) ? outline.sections : [];
  if (!sections.length || !Array.isArray(links) || !links.length) {
    return { shortlistByH2: {}, sectionMeta: [] };
  }

  const h2Profiles   = sections.map(buildH2Profile);
  const linkProfiles = links.map(buildLinkProfile);
  const idfCorpus    = buildIdf([...h2Profiles, ...linkProfiles]);

  const h2Vectors   = h2Profiles.map((b) => tfidfVector(b, idfCorpus));
  const linkVectors = linkProfiles.map((b) => tfidfVector(b, idfCorpus));

  const shortlistByH2 = {};
  const sectionMeta = [];

  sections.forEach((sec, i) => {
    const idx = sec.index || (i + 1);
    sectionMeta.push({ index: idx, h2: sec.h2 || '' });
    const scored = links.map((lnk, j) => {
      const cos = cosine(h2Vectors[i], linkVectors[j]);
      const jac = jaccard(h2Profiles[i], linkProfiles[j]);
      const score = 0.7 * cos + 0.3 * jac;
      const matched = [];
      for (const [stem] of linkProfiles[j]) if (h2Profiles[i].has(stem)) matched.push(stem);
      return {
        url:           lnk.url,
        h1:            lnk.h1,
        score:         Math.round(score * 1000) / 1000,
        h1_stems:      Array.from(linkProfiles[j].keys()).slice(0, 16),
        matched_lsi:   matched.slice(0, 12),
      };
    }).sort((a, b) => b.score - a.score).slice(0, k);
    shortlistByH2[idx] = scored;
  });

  return { shortlistByH2, sectionMeta };
}

// ── Anchor sanitization ──────────────────────────────────────────────

function isCleanAnchor(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/[<>]/.test(t)) return false;
  for (const re of ANCHOR_BLACKLIST) if (re.test(t)) return false;
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2 || wordCount > 6) return false;
  return true;
}

/**
 * Fallback: derive a reasonable anchor from the H1 of the commercial page.
 * Strategy: take last 2–4 significant words, lower-case.
 */
function fallbackAnchor(h1) {
  const words = String(h1 || '')
    .replace(/[«»"',\-–—|()]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  const pick = words.slice(-3).join(' ').toLowerCase();
  return pick && pick.length >= 4 ? pick : (h1 || '').toLowerCase().slice(0, 60);
}

// ── Post-validator ───────────────────────────────────────────────────

function postValidate({ link_plan, shortlistByH2, sectionMeta }) {
  const issues = [];
  const allowedByH2 = new Map();
  for (const [idx, list] of Object.entries(shortlistByH2)) allowedByH2.set(Number(idx), list);

  const urlUsage = new Map();
  const fixedPlan = [];

  // Make sure every section has an entry, in the section order.
  const planByIdx = new Map();
  for (const p of Array.isArray(link_plan) ? link_plan : []) {
    if (p && Number.isInteger(p.h2_index)) planByIdx.set(p.h2_index, p);
  }

  for (const meta of sectionMeta) {
    const slot = planByIdx.get(meta.index) || { h2_index: meta.index, h2_text: meta.h2, picks: [] };
    const shortlist = allowedByH2.get(meta.index) || [];
    const allowedUrls = new Set(shortlist.map((s) => s.url));
    const sortedPicks = Array.isArray(slot.picks) ? slot.picks : [];

    const sanitized = [];
    for (const pick of sortedPicks) {
      if (!pick || typeof pick !== 'object') continue;
      // 1) URL must be in shortlist (no LLM-invented URLs).
      if (!allowedUrls.has(pick.url)) {
        issues.push({ h2_index: meta.index, kind: 'invalid_url', url: pick.url });
        continue;
      }
      // 2) MIN_SEMANTIC_SCORE.
      const slEntry = shortlist.find((s) => s.url === pick.url);
      const score = (typeof pick.semantic_score === 'number' && Number.isFinite(pick.semantic_score))
        ? pick.semantic_score : (slEntry?.score || 0);
      if (score < MIN_SEMANTIC_SCORE) {
        issues.push({ h2_index: meta.index, kind: 'low_score', url: pick.url, score });
        continue;
      }
      // 3) Anchor sanitization.
      let anchor = (pick.anchor_text || '').trim();
      if (!isCleanAnchor(anchor)) {
        anchor = fallbackAnchor(slEntry?.h1 || pick.h1 || '');
        issues.push({ h2_index: meta.index, kind: 'anchor_replaced', url: pick.url, original: pick.anchor_text, used: anchor });
      }
      // 4) Per-URL repeat cap.
      const used = urlUsage.get(pick.url) || 0;
      if (used >= MAX_REPEATS_PER_URL) {
        issues.push({ h2_index: meta.index, kind: 'url_overused', url: pick.url, count: used });
        continue;
      }
      sanitized.push({
        url:            pick.url,
        h1:             slEntry?.h1 || pick.h1 || '',
        anchor_text:    anchor,
        role:           sanitized.length === 0 ? 'primary' : 'supporting',
        semantic_score: Math.round(score * 1000) / 1000,
        reason:         (typeof pick.reason === 'string' ? pick.reason.trim() : '').slice(0, 280) ||
                        `Семантическое соответствие jtbd-кластеру H2 (cosine-tfidf+jaccard score=${score.toFixed(2)}).`,
      });
      urlUsage.set(pick.url, used + 1);
      if (sanitized.length >= MAX_LINKS_PER_H2) break;
    }

    // 5) Ensure MIN_LINKS_PER_H2 — fallback to top of shortlist if needed.
    if (sanitized.length < MIN_LINKS_PER_H2 && shortlist.length) {
      for (const cand of shortlist) {
        if (sanitized.length >= MIN_LINKS_PER_H2) break;
        if (cand.score < MIN_SEMANTIC_SCORE) continue;
        const used = urlUsage.get(cand.url) || 0;
        if (used >= MAX_REPEATS_PER_URL) continue;
        if (sanitized.some((s) => s.url === cand.url)) continue;
        sanitized.push({
          url:            cand.url,
          h1:             cand.h1,
          anchor_text:    fallbackAnchor(cand.h1),
          role:           sanitized.length === 0 ? 'primary' : 'supporting',
          semantic_score: cand.score,
          reason:         `Программная подстановка из shortlist (LLM пропустил минимум ${MIN_LINKS_PER_H2} ссылки на H2).`,
        });
        urlUsage.set(cand.url, used + 1);
        issues.push({ h2_index: meta.index, kind: 'auto_filled', url: cand.url });
      }
    }

    fixedPlan.push({
      h2_index: meta.index,
      h2_text:  meta.h2,
      picks:    sanitized,
    });
  }

  // Build graph_pattern (deterministic, ground-truth).
  const urlUsageCount = {};
  for (const [u, c] of urlUsage) urlUsageCount[u] = c;

  const audit = {
    every_h2_has_min_link: fixedPlan.every((p) => p.picks.length >= MIN_LINKS_PER_H2),
    no_h2_exceeds_max:     fixedPlan.every((p) => p.picks.length <= MAX_LINKS_PER_H2),
    no_url_exceeds_repeats:Object.values(urlUsageCount).every((c) => c <= MAX_REPEATS_PER_URL),
    anchors_natural:       fixedPlan.every((p) => p.picks.every((pk) => isCleanAnchor(pk.anchor_text))),
    primary_supporting_logic: fixedPlan.every((p) => !p.picks.length || p.picks[0].role === 'primary'),
    issues,
  };

  return { link_plan: fixedPlan, url_usage_count: urlUsageCount, audit };
}

// ── Public: planning entrypoint (LLM + deterministic post) ───────────

/**
 * @param {object} args
 * @param {object} args.task
 * @param {object} args.outline       — Stage 2 result
 * @param {object[]} args.links       — normalized [{url, h1}]
 * @param {string}   [args.adapter]   — 'deepseek'
 * @param {object}   [args.callContext] — { taskId, stageName, onLog, onTokens }
 * @returns {Promise<{link_plan, graph_pattern, deterministic_audit, llm_raw, shortlistByH2}>}
 */
async function planSemanticLinks({ task, outline, links, adapter = 'deepseek', callContext = {} }) {
  const { shortlistByH2, sectionMeta } = computeShortlists({ outline, links });
  if (!sectionMeta.length) {
    return { link_plan: [], graph_pattern: { url_usage_count: {} }, deterministic_audit: { audit: { issues: [{ kind: 'no_sections' }] } }, llm_raw: null, shortlistByH2: {} };
  }
  if (!Object.values(shortlistByH2).some((arr) => arr.length)) {
    return { link_plan: [], graph_pattern: { url_usage_count: {} }, deterministic_audit: { audit: { issues: [{ kind: 'empty_shortlists' }] } }, llm_raw: null, shortlistByH2 };
  }

  // Build user payload — only short-lists, never full 200-link list.
  const system = loadInfoArticlePrompt('stage2cLink');
  const userPayload = {
    topic:               task.topic || '',
    region:              task.region || '',
    outline_sections:    sectionMeta.map((m) => {
      const sec = outline.sections.find((s) => (s.index || 0) === m.index) || {};
      return {
        index:                  m.index,
        h2:                     m.h2,
        descriptor:             sec.descriptor || '',
        jtbd_cluster:           sec.jtbd_cluster || '',
        lsi_focus:              Array.isArray(sec.lsi_focus) ? sec.lsi_focus : [],
        covers_user_questions:  Array.isArray(sec.covers_user_questions) ? sec.covers_user_questions : [],
      };
    }),
    shortlist_per_h2:    shortlistByH2,
    links_per_h2:        { min: MIN_LINKS_PER_H2, max: MAX_LINKS_PER_H2 },
    max_repeats_per_url: MAX_REPEATS_PER_URL,
    total_h2_count:      sectionMeta.length,
  };

  let llmRaw = null;
  try {
    llmRaw = await callLLM(adapter, system, JSON.stringify(userPayload), {
      ...callContext,
      callLabel: 'Stage 2C Link planner',
    });
  } catch (err) {
    // Fail-soft: LLM упал — даём пустой план; пост-валидатор подставит из top-1 shortlist.
    llmRaw = { link_plan: [], placement_self_audit: { issues: [`llm_error: ${err.message}`] } };
  }

  const post = postValidate({
    link_plan: Array.isArray(llmRaw?.link_plan) ? llmRaw.link_plan : [],
    shortlistByH2,
    sectionMeta,
  });

  return {
    link_plan:           post.link_plan,
    graph_pattern:       { url_usage_count: post.url_usage_count },
    deterministic_audit: post.audit,
    llm_raw:             llmRaw,
    shortlistByH2,
  };
}

// ── Public: HTML link-audit (для Stage 5b ground-truth) ──────────────

/**
 * Парсит готовый article_html, мапит каждую <a href> к её ближайшему <h2>,
 * сравнивает с link_plan и возвращает структурированный отчёт.
 * Не использует LLM — это пост-проверка.
 */
function auditHtmlAgainstPlan({ html, link_plan }) {
  const text = typeof html === 'string' ? html : '';
  // Простая стабильная сегментация по <h2>: разрезаем на блоки между <h2>.
  // Каждый блок — секция с index = position+1 (соответствует link_plan).
  const segments = [];
  const re = /<h2\b[^>]*>(.*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi;
  let m;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    idx += 1;
    const title = m[1].replace(/<[^>]+>/g, '').trim();
    segments.push({ index: idx, title, body: m[2] || '' });
  }

  // Все ссылки в article (с владельцем h2).
  const allAnchors = [];
  for (const seg of segments) {
    const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(seg.body)) !== null) {
      allAnchors.push({
        href:           am[1],
        anchor_text:    am[2].replace(/<[^>]+>/g, '').trim(),
        h2_owner_index: seg.index,
      });
    }
  }

  const planByIdx = new Map();
  const allPlannedUrls = new Set();
  for (const p of Array.isArray(link_plan) ? link_plan : []) {
    if (Number.isInteger(p?.h2_index)) {
      planByIdx.set(p.h2_index, Array.isArray(p.picks) ? p.picks : []);
      for (const pk of p.picks || []) allPlannedUrls.add(pk.url);
    }
  }

  const missing = [];
  const misplacements = [];
  let totalPlanned = 0, totalInserted = 0;

  for (const [h2Idx, picks] of planByIdx) {
    for (const pk of picks) {
      totalPlanned += 1;
      // Was this URL inserted anywhere?
      const hits = allAnchors.filter((a) => a.href === pk.url);
      if (!hits.length) {
        missing.push({ h2_index: h2Idx, url: pk.url, anchor_text: pk.anchor_text });
        continue;
      }
      totalInserted += 1;
      // Was it in the right H2?
      if (!hits.some((h) => h.h2_owner_index === h2Idx)) {
        misplacements.push({
          url: pk.url,
          expected_h2_index: h2Idx,
          actual_h2_index:   hits[0].h2_owner_index,
          anchor_text:       hits[0].anchor_text,
        });
      }
    }
  }

  // extras = anchors whose href is not in plan at all (informational links allowed only inside plan)
  const extras = allAnchors
    .filter((a) => !allPlannedUrls.has(a.href) && /^https?:\/\//i.test(a.href))
    .filter((a) => {
      // Heuristic: ignore anchors to widely-known portals (we can't tell here, so be permissive).
      // We only flag commercial-style links that look like the user's own links (best-effort by host equality
      // to any planned URL host). If user's host is mixed, allow them silently.
      try {
        const aHost = new URL(a.href).host;
        const plannedHosts = new Set();
        for (const u of allPlannedUrls) {
          try { plannedHosts.add(new URL(u).host); } catch (_) { /* skip */ }
        }
        return plannedHosts.has(aHost);
      } catch (_) { return false; }
    })
    .map((a) => ({ h2_index: a.h2_owner_index, href: a.href, anchor_text: a.anchor_text }));

  // Per-h2 density + per-url usage.
  const densityViolations = [];
  for (const seg of segments) {
    const planned = planByIdx.get(seg.index);
    if (!planned) continue;
    const inserted = allAnchors.filter((a) => a.h2_owner_index === seg.index && allPlannedUrls.has(a.href)).length;
    if (inserted < MIN_LINKS_PER_H2) {
      densityViolations.push({ h2_index: seg.index, actual_count: inserted, expected_min: MIN_LINKS_PER_H2 });
    }
    if (inserted > MAX_LINKS_PER_H2) {
      densityViolations.push({ h2_index: seg.index, actual_count: inserted, expected_max: MAX_LINKS_PER_H2 });
    }
  }

  const usage = {};
  for (const a of allAnchors) {
    if (allPlannedUrls.has(a.href)) usage[a.href] = (usage[a.href] || 0) + 1;
  }
  const repeatViolations = [];
  for (const [url, cnt] of Object.entries(usage)) {
    if (cnt > MAX_REPEATS_PER_URL) {
      repeatViolations.push({ url, count: cnt, max_allowed: MAX_REPEATS_PER_URL });
    }
  }

  const coveragePct = totalPlanned ? Math.round((totalInserted / totalPlanned) * 1000) / 10 : 100;
  const verdict = (
    coveragePct === 100
    && !misplacements.length
    && !missing.length
    && !extras.length
    && !densityViolations.length
    && !repeatViolations.length
  ) ? 'pass' : (extras.length || missing.length / Math.max(1, totalPlanned) > 0.3 ? 'reject' : 'refine');

  return {
    coverage_pct:        coveragePct,
    total_planned:       totalPlanned,
    total_inserted:      totalInserted,
    missing,
    misplacements,
    extras,
    density_violations:  densityViolations,
    repeat_violations:   repeatViolations,
    url_usage_count:     usage,
    h2_titles_in_html:   segments.map((s) => s.title),
    anchors_found_in_html: allAnchors,
    verdict,
  };
}

module.exports = {
  computeShortlists,
  planSemanticLinks,
  postValidate,
  auditHtmlAgainstPlan,
  isCleanAnchor,
  fallbackAnchor,
  // constants for tests
  MAX_LINKS_PER_H2, MIN_LINKS_PER_H2, MAX_REPEATS_PER_URL, MIN_SEMANTIC_SCORE,
  _internal: { tokenize, stemKey, buildH2Profile, buildLinkProfile, cosine, jaccard, urlSlugTokens },
};
