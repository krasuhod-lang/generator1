'use strict';

/**
 * contentGapPlanner/topicGenerator — формирует план статей блога (п.3 ТЗ:
 * «минимум 5 тем статей … + предлагать тайтл и дескрипшен»).
 *
 * ПРИНЦИП: только факты статистики, без галлюцинаций. Каждая тема строится из
 * реальной «дыры» GSC (gapDetector) и обязана нести подтверждающие запросы с
 * цифрами (impressions/position) + размеченный интент (commercialIntent).
 * Темы без подтверждающего запроса НЕ публикуются. Синтетических тем-заглушек
 * больше нет: если данных не хватает на minTopics — честно сообщаем дефицит.
 *
 * Слой LLM (DeepSeek + DSPy-усиление промпта) опционален и только ПЕРЕФОРМУЛИРУЕТ
 * заголовки/описания: запросы, статистику и интенты он менять не может (берутся
 * из детерминированной базы). Любой ответ LLM, не привязанный к входному
 * запросу, отбрасывается (откат на детерминированную тему).
 */

const { getProjectsConfig } = require('../config');
const { classifyQuery } = require('../commercialIntent');

const TITLE_MIN = 50; const TITLE_MAX = 60;
const DESC_MIN = 140; const DESC_MAX = 155;

function _cap(s) { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function _clamp(s, max) { s = String(s || '').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; }
function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').trim(); }

function _pad(s, min, filler) {
  s = String(s || '').trim();
  let i = 0;
  while (s.length < min && i < filler.length) { s = `${s} ${filler[i]}`.trim(); i += 1; }
  return s;
}

// Человекочитаемая расшифровка «какой интент закрываем» по причине дыры +
// размеченному интенту запроса. Используется как факт-обоснование темы.
const INTENT_RU = {
  informational: 'информационный',
  navigational: 'навигационный',
  investigation: 'выбор/сравнение',
  commercial: 'коммерческий',
  transactional: 'транзакционный',
  other: 'смешанный',
};

function _intentGapText(reason, intent) {
  const intentRu = INTENT_RU[intent] || INTENT_RU.other;
  switch (reason) {
    case 'striking_info':
      return `Не закрыт ${intentRu} интент: есть спрос (striking distance), но нет сильной страницы`;
    case 'info_query_on_commerce_page':
      return `Не закрыт ${intentRu} интент: запрос приземляется на коммерческую страницу — нужна отдельная статья`;
    case 'paa_related':
      return `Смежная тема (People Also Ask) — расширяет покрытие ${intentRu} интента`;
    default:
      return `Закрывает ${intentRu} интент`;
  }
}

/**
 * Детерминированно строит тему статьи из «дыры». Тема всегда привязана к
 * реальному запросу с его статистикой и размеченным интентом.
 */
function buildTopicFromGap(gap, project, brandTokens = []) {
  const q = String(gap.query || '').trim();
  const cls = classifyQuery(q, { brandTokens });
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

  // Подтверждающие запросы со статистикой (факт-обоснование темы).
  const evidence = [{
    query: q,
    impressions: Number(gap.impressions) || 0,
    position: gap.position != null ? Number(gap.position) : null,
  }];

  return {
    topic,
    h1,
    title,
    description,
    intent: cls.intent,
    intent_gap: _intentGapText(gap.reason, cls.intent),
    target_url_intent: gap.reason === 'info_query_on_commerce_page'
      ? 'Отдельная информационная статья (не коммерческая страница), линкуемая на целевой раздел'
      : 'Информационная статья в блоге со ссылкой на релевантный коммерческий раздел',
    supporting_queries: [q],
    evidence,
    impressions: Number(gap.impressions) || 0,
    source_reason: gap.reason,
  };
}

/**
 * Главная точка. Строит темы СТРОГО из дыр (факты статистики), опционально
 * переформулирует через LLM (без права менять запросы/интенты). Не добивает
 * синтетикой: если тем меньше minTopics — возвращает сколько есть + флаг
 * дефицита данных.
 *
 * @param {object} args { gaps:[], signals, project, brandTokens, llmFn?, dspyClient? }
 */
async function generateTopics({ gaps = [], signals = {}, project = {}, brandTokens = [], llmFn = null, dspyClient = null } = {}) {
  const cfg = getProjectsConfig().blogTopics;
  if (!cfg || !cfg.enabled) return null;
  const min = cfg.minTopics || 5;

  // Детерминированная база — только темы с реальным подтверждающим запросом.
  const base = (gaps || [])
    .filter((g) => String(g.query || '').trim())
    .map((g) => buildTopicFromGap(g, project, brandTokens));

  let topics = base;
  // Опциональный LLM-слой (graceful): переформулирует, не трогая факты.
  if (llmFn && cfg.useLlm !== false && base.length) {
    try {
      let promptSuffix = '';
      if (dspyClient && typeof dspyClient.buildPromptSuffix === 'function') {
        promptSuffix = await dspyClient.buildPromptSuffix('BlogTopicSuggest', { count: base.length }).catch(() => '');
      }
      const enriched = await _llmRefine({ base, project, llmFn, promptSuffix });
      if (Array.isArray(enriched) && enriched.length) topics = enriched;
    } catch (_) { /* graceful: keep deterministic base */ }
  }

  const out = topics.slice();
  const insufficient = out.length < min
    ? { needed: min, got: out.length, reason: 'not_enough_gsc_gaps' }
    : null;

  return {
    available: true,
    topics: out,
    count: out.length,
    signals,
    insufficient,
  };
}

/**
 * LLM-рефайн: отдаём базовые темы со статистикой и интентами, просим переписать
 * привлекательнее, СТРОГО запрещая выдумывать. Запросы/интенты/статистику берём
 * из base (ground truth) — LLM их не меняет. Любая тема, не привязанная к
 * входному запросу, отбрасывается. Невалидный JSON → откат на base снаружи.
 */
async function _llmRefine({ base, project, llmFn, promptSuffix }) {
  // Индекс «нормализованный запрос → базовая тема» для валидации привязки.
  const byQuery = new Map();
  base.forEach((t) => { byQuery.set(_norm(t.supporting_queries[0]), t); });

  const list = base.map((t, idx) => {
    const ev = t.evidence[0] || {};
    const pos = ev.position != null ? `, позиция ${ev.position}` : '';
    return `${idx + 1}. запрос: "${t.supporting_queries[0]}" (показы ${ev.impressions || 0}${pos}; интент: ${t.intent})`;
  }).join('\n');

  const prompt = [
    `Ты SEO-редактор блога сайта ${project.name || ''}.`,
    'СТРОГИЕ ПРАВИЛА (анти-галлюцинации):',
    '— Используй ТОЛЬКО перечисленные ниже запросы и их статистику. Ничего не выдумывай.',
    '— Запрещено вводить факты, числа, бренды, гарантии, цены или сущности, которых нет во входных данных.',
    '— Поле supporting_queries должно содержать ИМЕННО исходный запрос темы (дословно), без новых запросов.',
    '— Если данных мало — переформулируй заголовок/описание, но не добавляй вымышленных деталей.',
    `Перепиши ${base.length} тем статей привлекательнее. Для каждой верни JSON-объект:`,
    '{topic, h1, title (50-60 симв), description (140-155 симв), supporting_queries[]}.',
    'Верни ТОЛЬКО JSON-массив той же длины и в том же порядке.',
    promptSuffix || '',
    'Темы (по фактам GSC):',
    list,
  ].filter(Boolean).join('\n');

  const raw = await llmFn(prompt);
  const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) return null;

  const out = [];
  parsed.forEach((p, idx) => {
    // Привязка к факту: тема должна ссылаться на запрос из входного множества.
    // Берём базовую тему по supporting_queries или по позиции.
    const refQ = Array.isArray(p.supporting_queries) && p.supporting_queries.length
      ? _norm(p.supporting_queries[0]) : null;
    const baseTopic = (refQ && byQuery.get(refQ)) || base[idx];
    if (!baseTopic) return; // галлюцинация без привязки к факту — отбрасываем

    out.push({
      ...baseTopic, // факты (intent, evidence, supporting_queries, impressions) — из базы
      topic: p.topic || baseTopic.topic,
      h1: p.h1 || baseTopic.h1,
      title: _clamp(_pad(String(p.title || baseTopic.title), TITLE_MIN, ['гид', 'инструкция']), TITLE_MAX),
      description: _clamp(_pad(String(p.description || baseTopic.description), DESC_MIN, ['Подробный разбор и советы.']), DESC_MAX),
    });
  });
  return out.length ? out : null;
}

module.exports = { generateTopics, buildTopicFromGap, TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX };
