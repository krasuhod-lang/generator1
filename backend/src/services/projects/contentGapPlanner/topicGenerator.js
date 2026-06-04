'use strict';

/**
 * contentGapPlanner/topicGenerator — формирует план статей блога (п.3 ТЗ:
 * «минимум 5 тем статей … + предлагать тайтл и дескрипшен»).
 *
 * Слой LLM (DeepSeek + DSPy-усиление промпта) с детерминированным fallback:
 * ВСЕГДА возвращает ≥ cfg.minTopics объектов
 *   { topic, h1, title, description, target_url_intent, supporting_queries[] }.
 * Если LLM недоступен/выключен — строим темы детерминированно из «дыр».
 * Title/description соблюдают лимиты (50-60 / 140-155) через clamp; при наличии
 * Meta Tags пайплайна можно дожать через metaGenerator (lazy, опционально).
 */

const { getProjectsConfig } = require('../config');

const TITLE_MIN = 50; const TITLE_MAX = 60;
const DESC_MIN = 140; const DESC_MAX = 155;

function _cap(s) { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function _clamp(s, max) { s = String(s || '').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; }

function _pad(s, min, filler) {
  s = String(s || '').trim();
  let i = 0;
  while (s.length < min && i < filler.length) { s = `${s} ${filler[i]}`.trim(); i += 1; }
  return s;
}

/**
 * Детерминированно строит тему статьи из «дыры».
 */
function buildTopicFromGap(gap, project) {
  const q = String(gap.query || '').trim();
  const topic = _cap(q);
  const h1 = _cap(q);
  const brand = (project && project.name) ? ` | ${project.name}` : '';
  let title = `${_cap(q)}: гид и инструкция`;
  title = _pad(title, TITLE_MIN, ['пошагово', 'с примерами', 'кратко']);
  // Бренд добавляем только если целиком помещается в лимит (без обрезки слова).
  if (brand && (title.length + brand.length) <= TITLE_MAX) title += brand;
  title = _clamp(title, TITLE_MAX);

  let description = `Разбираем «${q}»: что важно знать, как выбрать и не ошибиться. Практические советы, ответы на частые вопросы и рекомендации экспертов.`;
  description = _pad(description, DESC_MIN, ['Читайте подробный разбор.']);
  description = _clamp(description, DESC_MAX);

  return {
    topic,
    h1,
    title,
    description,
    target_url_intent: gap.reason === 'info_query_on_commerce_page'
      ? 'Отдельная информационная статья (не коммерческая страница), линкуемая на целевой раздел'
      : 'Информационная статья в блоге со ссылкой на релевантный коммерческий раздел',
    supporting_queries: [q],
    source_reason: gap.reason,
  };
}

/**
 * Главная точка. Пытается усилить промпт через DSPy и сгенерировать темы LLM-ом,
 * иначе детерминированный fallback. Всегда ≥ minTopics.
 *
 * @param {object} args { gaps:[], signals, project, llmFn?:async(prompt)=>text, dspyClient? }
 */
async function generateTopics({ gaps = [], signals = {}, project = {}, llmFn = null, dspyClient = null } = {}) {
  const cfg = getProjectsConfig().blogTopics;
  if (!cfg || !cfg.enabled) return null;
  const min = cfg.minTopics || 5;

  // Детерминированная база — гарантирует наполнение и валидность лимитов.
  const base = (gaps || []).map((g) => buildTopicFromGap(g, project));

  let topics = base;
  // Опциональный LLM-слой (graceful): усиливаем формулировки, не ломая контракт.
  if (llmFn && cfg.useLlm !== false && base.length) {
    try {
      let promptSuffix = '';
      if (dspyClient && typeof dspyClient.buildPromptSuffix === 'function') {
        promptSuffix = await dspyClient.buildPromptSuffix('BlogTopicSuggest', { count: min }).catch(() => '');
      }
      const enriched = await _llmRefine({ base, project, min, llmFn, promptSuffix });
      if (Array.isArray(enriched) && enriched.length >= min) topics = enriched;
    } catch (_) { /* graceful: keep deterministic base */ }
  }

  // Добивка до минимума, если «дыр» не хватило.
  const out = topics.slice();
  let i = 1;
  while (out.length < min) {
    out.push(buildTopicFromGap({
      query: `Полезная тема для блога ${project.name || ''} №${i}`.trim(),
      reason: 'backfill',
    }, project));
    i += 1;
  }

  return { available: true, topics: out.slice(0, Math.max(min, out.length)), count: out.length, signals };
}

/**
 * LLM-рефайн: отдаём базовые темы, просим переписать привлекательнее в JSON.
 * Любая ошибка/невалидный JSON → откат на base снаружи.
 */
async function _llmRefine({ base, project, min, llmFn, promptSuffix }) {
  const list = base.slice(0, Math.max(min, base.length))
    .map((t, idx) => `${idx + 1}. ${t.topic} (запрос: ${t.supporting_queries[0]})`).join('\n');
  const prompt = [
    `Ты SEO-редактор блога сайта ${project.name || ''}.`,
    `Перепиши ${Math.max(min, base.length)} тем статей привлекательнее. Для каждой верни JSON-объект:`,
    '{topic, h1, title (50-60 симв), description (140-155 симв), target_url_intent, supporting_queries[]}.',
    'Верни ТОЛЬКО JSON-массив.',
    promptSuffix || '',
    'Темы:',
    list,
  ].filter(Boolean).join('\n');

  const raw = await llmFn(prompt);
  const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) return null;
  return parsed.map((p, idx) => ({
    topic: p.topic || base[idx] && base[idx].topic,
    h1: p.h1 || p.topic,
    title: _clamp(_pad(String(p.title || ''), TITLE_MIN, ['гид', 'инструкция']), TITLE_MAX),
    description: _clamp(_pad(String(p.description || ''), DESC_MIN, ['Подробный разбор и советы.']), DESC_MAX),
    target_url_intent: p.target_url_intent || (base[idx] && base[idx].target_url_intent),
    supporting_queries: Array.isArray(p.supporting_queries) && p.supporting_queries.length
      ? p.supporting_queries : (base[idx] ? base[idx].supporting_queries : []),
    source_reason: base[idx] ? base[idx].source_reason : 'llm',
  }));
}

module.exports = { generateTopics, buildTopicFromGap, TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX };
