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

// Нормализация для сравнения «title vs тема»: без регистра, пунктуации и кавычек.
function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"'`.,:;!?()\-—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _capitalize(s) {
  const t = String(s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

function _cleanSeed(seed) {
  return String(seed || '')
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _stripWords(text, words) {
  let out = ` ${String(text || '')} `;
  words.forEach((w) => {
    out = out.replace(new RegExp(`\\s${w}\\s`, 'giu'), ' ');
  });
  return out.replace(/\s+/g, ' ').trim();
}

function _cityTopic(seed) {
  const s = _cleanSeed(seed);
  const direct = s.match(/\b(?:в|во)\s+([а-яё-]+)$/iu);
  if (direct) return `Как продвигать сайт в ${direct[1]}: локальное SEO и заявки из поиска`;

  // Частые гео-анкоры приходят без предлога: «продвижение сайта новосибирск».
  const cities = [
    'москва', 'новосибирск', 'омск', 'красноярск', 'самара', 'челябинск',
    'нижний новгород', 'казань', 'крым', 'уфа',
  ];
  const city = cities.find((c) => new RegExp(`(?:^|\\s)${c}(?:$|\\s)`, 'iu').test(s));
  if (!city) return '';
  const prep = city === 'крым' ? 'в' : 'в';
  return `Как продвигать сайт ${prep} ${city}: локальное SEO и заявки из поиска`;
}

/**
 * Детерминированная готовая тема вместо сырого «анкор = тема». Нужна, когда
 * LLM-слой недоступен/сломался: в UI всё равно должна быть конкретная тема
 * статьи под интент анкора, а не строка вида «по теме «анализ сайта»».
 */
function _fallbackReadyTopic(seed) {
  const s = _cleanSeed(seed);
  if (!s) return '';

  if (/(^|\s)анализ\s+сайта($|\s)/iu.test(s)) {
    return 'Как провести анализ сайта и найти точки роста в SEO';
  }
  if (/(^|\s)семантическ\w*\s+ядр\w*/iu.test(s)) {
    if (/(^|\s)(цен[аы]|стоимост\w*)($|\s)/iu.test(s)) {
      return 'Сколько стоит сбор семантического ядра и от чего зависит цена';
    }
    return 'Как собрать семантическое ядро для SEO и не упустить спрос';
  }
  if (/\bjoomla\b|(^|\s)джумл/iu.test(s)) {
    return 'Как продвигать сайт на Joomla: SEO-настройки и типовые ошибки';
  }
  if (/(^|\s)по\s+позици/iu.test(s)) {
    return 'Как продвигать сайт по позициям и контролировать рост видимости';
  }

  const city = _cityTopic(s);
  if (city) return city;

  if (/(^|\s)(цен[аы]|стоимост\w*|умерен\w*)($|\s)/iu.test(s)) {
    const base = _stripWords(s, ['цена', 'цены', 'стоимость', 'стоимости', 'умеренная', 'умеренные']);
    return `Сколько стоит ${base || s}: факторы цены и как оценить бюджет`;
  }

  if (/(^|\s)продвижен\w*|seo-?продвижен\w*/iu.test(s)) {
    let niche = _stripWords(s, [
      'seo', 'seo-продвижение', 'продвижение', 'продвижения', 'сайт', 'сайта',
      'сайтов', 'услуги', 'в', 'во',
    ]);
    niche = niche.replace(/^и\s+/, '').trim();
    if (/недвижим/iu.test(niche)) {
      return 'Как продвигать сайт недвижимости и получать целевые заявки из поиска';
    }
    if (/новост/iu.test(niche)) {
      return 'Как продвигать новостной сайт и растить поисковый трафик';
    }
    if (niche) return `Как продвигать сайт ${niche}: SEO-стратегия и рост заявок`;
    return 'Как продвигать сайт в SEO: стратегия, ссылки и контроль результата';
  }

  return `${_capitalize(s)}: экспертный разбор интента и практические рекомендации`;
}

/**
 * title обязан отличаться от темы статьи (ТЗ п.3): интриговать и раскрывать
 * интент, а не дублировать тему. Если LLM вернул title, совпадающий/входящий в
 * тему (или наоборот), считаем его непригодным и возвращаем '' (фолбэк-логика
 * выше сохранит поведение без дубля).
 */
function _distinctTitle(title, topic) {
  const t = _norm(title);
  const top = _norm(topic);
  if (!t) return '';
  if (!top) return title;
  if (t === top || t.includes(top) || top.includes(t)) return '';
  return title;
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
 * В промт прокидываем тематику бизнеса (название/сайт/аудитория) и сами анкоры —
 * чтобы тема была максимально релевантна нише и поисковому интенту (п.1 ТЗ).
 */
function _buildBusinessContext(project) {
  if (!project) return [];
  const lines = [];
  if (project.name) lines.push(`— Бизнес/сайт: ${_clip(project.name, 160)}`);
  const site = project.gsc_site_url || project.url;
  if (site) lines.push(`— URL: ${_clip(site, 160)}`);
  if (project.audience_description) {
    lines.push(`— Целевая аудитория/ниша: ${_clip(project.audience_description, 300)}`);
  }
  return lines.length ? ['Тематика бизнеса (учитывай при подборе тем):', ...lines, ''] : [];
}

function _buildPrompt({ project, targets }) {
  const list = targets.map((t, idx) => `${idx + 1}. анкор/запрос: "${t.donor_topic_seed}"`).join('\n');
  return [
    `Ты контент-стратег внутреннего инструмента «Темы статей» сайта ${project && project.name ? project.name : ''}.`,
    'Задача: под каждый анкор/поисковый запрос предложить ОДНУ готовую, конкретную',
    'тему статьи для размещения на сайте-доноре с естественной ссылкой на наш раздел.',
    '',
    ..._buildBusinessContext(project),
    'СТРОГИЕ ПРАВИЛА (анти-галлюцинации):',
    '— Тема должна раскрывать ИМЕННО смысл анкора/запроса и поисковый интент за ним,',
    '  и быть релевантной нише бизнеса выше — а не уводить в сторону.',
    '— Запрещено выдумывать бренды, числа, цены, гарантии и сущности, которых нет в анкоре.',
    '— Тема — это рабочий заголовок экспертной статьи (как пишет эксперт), а НЕ сам анкор',
    '  дословно и не «статья про <анкор>». Сделай её конкретной и полезной.',
    '— Пиши на языке анкора (как правило русский).',
    '',
    'ОТДЕЛЬНО к каждой теме обязателен SEO-title и meta-description:',
    '— title — кликабельный, интригующий заголовок (45–60 символов), который РАСКРЫВАЕТ',
    '  интент анкора и вызывает желание прочитать. title НЕ должен дословно повторять',
    '  тему статьи (ready_topic) и не должен быть на неё похож — это другой ракурс/крючок.',
    '— description — meta-description 140–160 символов: суть статьи + выгода для читателя,',
    '  естественно отражает интент анкора, без кликбейта-обмана и выдуманных фактов.',
    '',
    `Верни ТОЛЬКО JSON-массив РОВНО из ${targets.length} объектов в том же порядке:`,
    '{"ready_topic": "готовая тема статьи (рабочий заголовок)", "h1": "H1 статьи", "title": "интригующий SEO-title, раскрывает интент, не похож на тему", "description": "meta-description 140–160 символов", "angle": "угол раскрытия одним предложением"}',
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

  targets.forEach((rec) => {
    const ready = _clip(_fallbackReadyTopic(rec.donor_topic_seed), 200);
    if (!ready) return;
    rec.donor_topic_ready = ready;
    rec.donor_topic_h1 = ready;
    rec.donor_topic = wrapDonorTopic(ready);
    result.enriched += 1;
  });

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
    // SEO-title (интригует, раскрывает интент, НЕ похож на тему) + meta-description.
    const title = _distinctTitle(item && item.title, ready);
    if (title) rec.donor_topic_title = _clip(title, 70);
    if (item && item.description) rec.donor_topic_description = _clip(item.description, 170);
    // Итоговая строка — всегда в обязательном формате-обёртке.
    rec.donor_topic = wrapDonorTopic(ready);
  });
  return result;
}

module.exports = { enrichDonorTopics };
