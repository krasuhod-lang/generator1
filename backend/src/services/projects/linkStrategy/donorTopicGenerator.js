'use strict';

/**
 * linkStrategy/donorTopicGenerator — обогащает рекомендации на закупку ссылок
 * ГОТОВОЙ, конкретной темой статьи-донора под каждый анкор, опираясь на
 * внутренний инструмент «Темы статей» (services/articleTopics — тот же принцип:
 * из анкора/запроса собрать проработанную тему статьи с углом раскрытия).
 *
 * Зачем: раньше `donor_topic` был просто обёрткой вокруг сырого анкора
 * («Экспертная статья по теме «греется тормозной диск с одной стороны» …»),
 * то есть тема = сам анкор. Менеджеру нужна СРАЗУ готовая тема под анкор.
 *
 * Принцип (как в contentGapPlanner/topicGenerator — blogTopics):
 *   • один батч-LLM-вызов на весь набор анкоров (не вызов на каждую рекомендацию);
 *   • LLM-слой ОПЦИОНАЛЕН и graceful: без llmFn / при сбое / на невалидном
 *     ответе остаётся детерминированная обёртка (внешний контракт не ломается);
 *   • итоговая строка `donor_topic` ВСЕГДА в требуемом формате
 *     «Экспертная статья по теме «…» с естественной ссылкой на ваш раздел»;
 *   • тематический seed берём из donor_topic_seed (реальный поисковый запрос
 *     GSC). Анкоры без seed (брендовые/безанкорные) НЕ обогащаем — для них
 *     готовая тема статьи не имеет смысла.
 */

const { getProjectsConfig } = require('../config');
const { wrapDonorTopic } = require('./linkRecommender');

function _clip(s, max) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Кандидаты на обогащение: только рекомендации с тематическим seed
 * (реальный запрос/анкор), ограниченные cfg.maxAnchors.
 */
function _enrichable(recommendations, max) {
  const out = [];
  for (const r of recommendations || []) {
    const seed = r && String(r.donor_topic_seed || '').trim();
    if (seed) out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Строит батч-промт «Темы статей под анкоры». Анти-галлюцинации: тема обязана
 * раскрывать именно тему анкора; запрещены выдуманные бренды/цифры/гарантии.
 */
function _buildPrompt({ project, targets }) {
  const list = targets.map((t, idx) => `${idx + 1}. анкор/запрос: "${t.donor_topic_seed}"`).join('\n');
  return [
    `Ты контент-стратег внутреннего инструмента «Темы статей» сайта ${project && project.name ? project.name : ''}.`,
    'Задача: под каждый анкор/поисковый запрос предложить ОДНУ готовую, конкретную',
    'тему статьи для размещения на сайте-доноре с естественной ссылкой на наш раздел.',
    '',
    'СТРОГИЕ ПРАВИЛА (анти-галлюцинации):',
    '— Тема должна раскрывать ИМЕННО смысл анкора/запроса, а не уводить в сторону.',
    '— Запрещено выдумывать бренды, числа, цены, гарантии и сущности, которых нет в анкоре.',
    '— Тема — это рабочий заголовок экспертной статьи (как пишет эксперт), а НЕ сам анкор',
    '  дословно и не «статья про <анкор>». Сделай её конкретной и полезной.',
    '— Пиши на языке анкора (как правило русский).',
    '',
    `Верни ТОЛЬКО JSON-массив РОВНО из ${targets.length} объектов в том же порядке:`,
    '{"ready_topic": "готовая тема статьи (рабочий заголовок)", "h1": "H1 статьи", "angle": "угол раскрытия одним предложением"}',
    '',
    'Анкоры/запросы:',
    list,
  ].join('\n');
}

function _parseArray(raw, expectedLen) {
  const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch (_) { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  // Длина может слегка отличаться — сопоставляем по позиции, лишнее игнорируем.
  return parsed.slice(0, expectedLen);
}

/**
 * Обогащает рекомендации готовыми темами статей-доноров.
 *
 * @param {object} args
 * @param {Array}  args.recommendations  результат recommendLinks (мутируется in-place)
 * @param {object} args.project
 * @param {Function} [args.llmFn]  async (prompt) => string|{text}
 * @returns {Promise<{enriched:number, attempted:number, used_llm:boolean}>}
 */
async function enrichDonorTopics({ recommendations, project, llmFn } = {}) {
  const cfg = (getProjectsConfig().linkStrategy && getProjectsConfig().linkStrategy.donorTopics) || {};
  const result = { enriched: 0, attempted: 0, used_llm: false };
  if (!cfg.enabled) return result;
  if (!Array.isArray(recommendations) || !recommendations.length) return result;

  const targets = _enrichable(recommendations, cfg.maxAnchors || 20);
  result.attempted = targets.length;
  if (!targets.length) return result;
  if (cfg.useLlm === false || typeof llmFn !== 'function') return result;

  let arr = null;
  try {
    const raw = await llmFn(_buildPrompt({ project, targets }), {
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
    });
    arr = _parseArray(raw, targets.length);
  } catch (_) {
    arr = null; // graceful: оставляем детерминированную обёртку
  }
  if (!arr) return result;

  result.used_llm = true;
  targets.forEach((rec, idx) => {
    const item = arr[idx];
    const ready = item && _clip(item.ready_topic || item.topic || item.title, 200);
    if (!ready) return; // нет готовой темы для этой позиции — оставляем фолбэк
    rec.donor_topic_ready = ready;
    rec.donor_topic_h1 = _clip((item && item.h1) || ready, 200);
    if (item && item.angle) rec.donor_topic_angle = _clip(item.angle, 240);
    // Итоговая строка — всегда в обязательном формате-обёртке.
    rec.donor_topic = wrapDonorTopic(ready);
    result.enriched += 1;
  });
  return result;
}

module.exports = { enrichDonorTopics };
