/**
 * SEO-метатеги для генератора информационной статьи в блог (Часть 1 эпика).
 *
 * После того как статья сгенерирована и финализирована, этот модуль просит
 * ИИ (DeepSeek) вернуть структурированный JSON с двумя полями:
 *   • title       — SEO-заголовок, 70–80 символов (строго ≤ 80);
 *   • description — meta description, 180–190 символов (строго ≤ 190).
 *
 * Метатеги обязаны соответствовать тематике сгенерированного текста и
 * содержать основные ключевые слова (тему/бренд). Если ИИ недоступен
 * (нет DEEPSEEK_API_KEY) или вернул мусор — деградируем детерминированно:
 * строим title из <h1>/темы, а description из первого абзаца статьи.
 *
 * Паттерн graceful-degradation повторяет forecaster/deepseekAnalyzer.js:
 * генерация статьи НЕ должна падать из-за метатегов.
 */
'use strict';

const { callLLM } = require('../llm/callLLM');

const TITLE_MIN = 70;
const TITLE_MAX = 80;
const DESC_MIN = 180;
const DESC_MAX = 190;

const SYSTEM_PROMPT = [
  'Ты — Senior SEO-специалист. По готовому тексту статьи для блога ты',
  'составляешь идеальные SEO-метатеги на русском языке.',
  '',
  'Верни СТРОГО валидный JSON без markdown-обёртки и комментариев, формата:',
  '{"title": "...", "description": "..."}',
  '',
  'Требования:',
  `• title — от ${TITLE_MIN} до ${TITLE_MAX} символов включительно, цепляющий, с главным`,
  '  ключевым словом ближе к началу.',
  `• description — от ${DESC_MIN} до ${DESC_MAX} символов включительно, раскрывает суть`,
  '  статьи и содержит основные ключевые слова.',
  '• Оба поля строго соответствуют тематике текста, без воды и кликбейта,',
  '  без эмодзи и без кавычек внутри значений.',
  '• Не превышай лимиты по символам ни при каких условиях.',
].join('\n');

/** Схлопывает пробелы и обрезает строку до limit символов по границе слова. */
function clampText(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Режем по последнему пробелу, только если так не потеряем слишком много.
  if (lastSpace > limit * 0.6) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

/** Достаёт текст первого <h1> из HTML (без тегов). */
function extractH1(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Достаёт первый осмысленный абзац из plain-текста статьи. */
function firstParagraph(plain) {
  if (typeof plain !== 'string') return '';
  const para = plain
    .split(/\n{2,}|\n/)
    .map((s) => s.trim())
    .find((s) => s.length >= 40);
  return para || plain.replace(/\s+/g, ' ').trim();
}

/**
 * Детерминированный fallback: строит метатеги без ИИ.
 * Используется при отсутствии API-ключа или ошибке LLM.
 */
function deterministicMeta({ topic, brand, articleHtml, articlePlain }) {
  const h1 = extractH1(articleHtml);
  const baseTitle = h1 || topic || '';
  const title = clampText(brand && !baseTitle.includes(brand)
    ? `${baseTitle} — ${brand}`
    : baseTitle, TITLE_MAX) || clampText(topic, TITLE_MAX);
  const description = clampText(firstParagraph(articlePlain), DESC_MAX)
    || clampText(`${topic}. Подробное руководство и практические советы.`, DESC_MAX);
  return { title, description, source: 'deterministic' };
}

/**
 * Генерирует SEO title + description для статьи.
 *
 * @param {Object} p
 * @param {string} p.topic          тема статьи
 * @param {string} [p.region]       регион (для локальной релевантности)
 * @param {string} [p.brand]        бренд (войдёт в title при наличии места)
 * @param {string} p.articleHtml    финальный HTML статьи
 * @param {string} p.articlePlain   plain-текст статьи
 * @param {Object} [p.ctx]          { taskId, onLog } для логирования
 * @returns {Promise<{title:string, description:string, source:string}>}
 */
async function generateSeoMeta(p = {}) {
  const { topic = '', region = '', brand = '', articleHtml = '', articlePlain = '', ctx = {} } = p;
  const fallback = deterministicMeta({ topic, brand, articleHtml, articlePlain });

  if (!process.env.DEEPSEEK_API_KEY) {
    return { ...fallback, source: 'deterministic_no_key' };
  }

  // Берём ограниченный срез текста, чтобы не раздувать промпт.
  const excerpt = (articlePlain || extractH1(articleHtml) || topic).slice(0, 6000);
  const user = [
    '[INPUTS]',
    `topic: ${topic || '[не задано]'}`,
    `region: ${region || '[не задано]'}`,
    `brand: ${brand || '[не задано]'}`,
    `h1: ${extractH1(articleHtml) || '[нет]'}`,
    '',
    '[ARTICLE_TEXT]',
    excerpt,
  ].join('\n');

  try {
    const result = await callLLM('deepseek', SYSTEM_PROMPT, user, {
      retries: 2,
      temperature: 0.3,
      maxTokens: 400,
      timeoutMs: 60000,
      stageName: 'info_article_seo_meta',
      callLabel: 'InfoArticle SEO meta',
      taskId: ctx.taskId || null,
      onLog: ctx.onLog || null,
    });

    const title = clampText(result && result.title, TITLE_MAX);
    const description = clampText(result && result.description, DESC_MAX);
    if (!title || !description) {
      return { ...fallback, source: 'deterministic_empty_llm' };
    }
    return { title, description, source: 'deepseek' };
  } catch (e) {
    if (ctx.onLog) ctx.onLog(`⚠ SEO meta LLM failed: ${e.message}`, 'warn');
    return { ...fallback, source: 'deterministic_error' };
  }
}

module.exports = {
  generateSeoMeta,
  // экспортируем хелперы для unit-тестов
  clampText,
  extractH1,
  firstParagraph,
  deterministicMeta,
  TITLE_MAX,
  DESC_MAX,
};
