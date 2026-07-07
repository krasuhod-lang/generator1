'use strict';

/**
 * targetSiteStyle.js — анализ сайта-площадки для блог-статьи.
 *
 * Бизнес-требование: «в статье для блога важно анализ сайта делать куда будет
 * идти публикация, т.е. мы парсим контент и на основании него делаем
 * генерацию, учитываем стилистику и формат написания».
 *
 * Как работает:
 *   1. Пользователь указывает target_site_url (обычно раздел блога площадки).
 *   2. Мы парсим стартовую страницу + до 2 внутренних «статейных» страниц
 *      (по эвристике: тот же хост, длинный путь / blog|news|articles|stati).
 *   3. Отдаём собранный текст в DeepSeek и получаем style_profile —
 *      тон, формат, структуру и лексические паттерны площадки.
 *   4. Профиль уходит в IAKB §9c — writer (Gemini) обязан писать в стиле
 *      площадки публикации.
 *
 * Полностью graceful: любая ошибка (SSRF, сеть, LLM) ⇒ null, pipeline идёт
 * дальше без стилевого профиля.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { callLLM }  = require('../llm/callLLM');
const { scrapeUrl, sanitizeUrl } = require('../parser/scraper');
const { assertPublicHost } = require('../siteCrawler/ssrfGuard');

const MAX_SAMPLE_PAGES  = 3;      // стартовая + до 2 внутренних
const PAGE_TEXT_LIMIT   = 6000;   // символов текста с одной страницы в промпт
const DISCOVER_TIMEOUT  = 15000;
const ARTICLE_PATH_HINT = /(blog|news|articles?|stati|post|zhurnal|journal|media|wiki|baza-znanij|knowledge)/i;

const STYLE_ANALYSIS_PROMPT = `Ты — редактор-аналитик. Тебе дан контент нескольких страниц сайта-площадки, куда будет опубликована новая статья для блога.
Твоя задача — выделить стилистику и формат написания этой площадки, чтобы новая статья выглядела «родной».

Проанализируй тексты и верни СТРОГО JSON без markdown-обёртки по схеме:
{
  "style_label": "краткое название стиля (до 120 символов)",
  "tone": "тон изложения (например: экспертный дружелюбный, официально-деловой, разговорный)",
  "formality": "formal | neutral | informal",
  "person": "от какого лица пишут (мы / компания / нейтрально / автор от первого лица)",
  "sentence_length": "short | medium | long — типичная длина предложений",
  "audience_address": "как обращаются к читателю (на вы / на ты / безлично)",
  "formatting_patterns": ["типичные приёмы форматирования: списки, таблицы, врезки, FAQ, подзаголовки-вопросы и т.п."],
  "vocabulary_notes": "лексические особенности: терминология, жаргон, эмоциональность, канцелярит",
  "structure_notes": "как обычно устроены статьи площадки: вступление, длина секций, выводы, CTA",
  "dos": ["3-6 правил, что ОБЯЗАТЕЛЬНО делать, чтобы попасть в стиль площадки"],
  "donts": ["3-6 правил, чего избегать"]
}

Не выдумывай: опирайся только на предоставленный контент. Если данных мало — заполни поля осторожными обобщениями по имеющемуся тексту.`;

// ─── Дискавери внутренних «статейных» ссылок ────────────────────────
async function _discoverArticleLinks(entryUrl) {
  try {
    const u = new URL(entryUrl);
    await assertPublicHost(u.hostname);
    const resp = await axios.get(entryUrl, {
      timeout: DISCOVER_TIMEOUT,
      maxRedirects: 4,
      maxContentLength: 3 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const $ = cheerio.load(String(resp.data || ''));
    const host = u.hostname.replace(/^www\./i, '');
    const scored = new Map();
    $('a[href]').each((_, el) => {
      const href = String($(el).attr('href') || '').trim();
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
      let abs;
      try { abs = new URL(href, entryUrl); } catch { return; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
      if (abs.hostname.replace(/^www\./i, '') !== host) return;
      const path = abs.pathname || '/';
      if (path === '/' || path === u.pathname) return;
      const segments = path.split('/').filter(Boolean);
      if (!segments.length) return;
      // Скоринг: статейные пути — длинные слаги внутри blog/news/articles.
      let score = 0;
      if (ARTICLE_PATH_HINT.test(path)) score += 2;
      const lastSeg = segments[segments.length - 1];
      if (lastSeg.length >= 15 || /-/.test(lastSeg)) score += 2;
      if (segments.length >= 2) score += 1;
      if (/\.(jpg|jpeg|png|gif|webp|pdf|zip|xml|css|js)$/i.test(path)) score = -1;
      if (score > 0) {
        abs.hash = '';
        abs.search = '';
        const key = abs.toString();
        scored.set(key, Math.max(scored.get(key) || 0, score));
      }
    });
    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SAMPLE_PAGES - 1)
      .map(([url]) => url);
  } catch {
    return [];
  }
}

/**
 * analyzeTargetSiteStyle(targetSiteUrl, ctx) →
 *   { style_profile, sampled_pages: [{url,title}], analyzed_at } | null
 */
async function analyzeTargetSiteStyle(targetSiteUrl, ctx = {}) {
  const entryUrl = sanitizeUrl(targetSiteUrl);
  if (!entryUrl) return null;

  try {
    await assertPublicHost(new URL(entryUrl).hostname);
  } catch {
    return null; // приватный/локальный хост — молча пропускаем
  }

  // 1. Собираем страницы-образцы: entry + внутренние статьи.
  const extraLinks = await _discoverArticleLinks(entryUrl);
  const urls = [entryUrl, ...extraLinks].slice(0, MAX_SAMPLE_PAGES);

  const pages = [];
  for (const url of urls) {
    try {
      const page = await scrapeUrl(url, 20000);
      const text = String(page?.markdown || '').trim();
      if (text.length >= 300) {
        pages.push({ url, title: String(page.title || '').slice(0, 200), text: text.slice(0, PAGE_TEXT_LIMIT) });
      }
    } catch { /* один плохой URL не валит анализ */ }
  }
  if (!pages.length) return null;

  // 2. LLM-анализ стилистики.
  const user = pages
    .map((p, i) => `[СТРАНИЦА ${i + 1}] ${p.url}\nTitle: ${p.title}\n---\n${p.text}`)
    .join('\n\n=====\n\n');

  let profile = null;
  try {
    profile = await callLLM(
      'deepseek',
      STYLE_ANALYSIS_PROMPT,
      user,
      { retries: 3, temperature: 0.2, callLabel: 'InfoArticle Target Site Style', ...ctx },
    );
  } catch {
    return null;
  }
  if (!profile || typeof profile !== 'object' || (!profile.tone && !profile.style_label)) return null;

  return {
    style_profile: profile,
    sampled_pages: pages.map((p) => ({ url: p.url, title: p.title })),
    analyzed_at: new Date().toISOString(),
  };
}

/**
 * renderTargetSiteStyleSection(analysis) — markdown для IAKB §9c.
 */
function renderTargetSiteStyleSection(analysis) {
  const p = analysis && analysis.style_profile;
  if (!p || typeof p !== 'object') return '';
  const out = [];
  out.push('Статья будет опубликована на внешней площадке. ОБЯЗАТЕЛЬНО пиши в её стилистике и формате (профиль ниже собран из реального контента площадки):');
  if (p.style_label)       out.push(`- **Стиль площадки:** ${p.style_label}`);
  if (p.tone)              out.push(`- **Тон:** ${p.tone}`);
  if (p.formality)         out.push(`- **Формальность:** ${p.formality}`);
  if (p.person)            out.push(`- **Лицо повествования:** ${p.person}`);
  if (p.sentence_length)   out.push(`- **Длина предложений:** ${p.sentence_length}`);
  if (p.audience_address)  out.push(`- **Обращение к читателю:** ${p.audience_address}`);
  if (Array.isArray(p.formatting_patterns) && p.formatting_patterns.length) {
    out.push(`- **Форматирование:** ${p.formatting_patterns.slice(0, 8).join('; ')}`);
  }
  if (p.vocabulary_notes)  out.push(`- **Лексика:** ${p.vocabulary_notes}`);
  if (p.structure_notes)   out.push(`- **Структура статей:** ${p.structure_notes}`);
  if (Array.isArray(p.dos) && p.dos.length) {
    out.push('\n**Обязательно:**\n' + p.dos.slice(0, 6).map((d) => `- ${d}`).join('\n'));
  }
  if (Array.isArray(p.donts) && p.donts.length) {
    out.push('\n**Избегать:**\n' + p.donts.slice(0, 6).map((d) => `- ${d}`).join('\n'));
  }
  return out.join('\n');
}

module.exports = { analyzeTargetSiteStyle, renderTargetSiteStyleSection };
