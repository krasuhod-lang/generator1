'use strict';

/**
 * personas — детерминированный выбор персоны автора для writer-этапа
 * инфо-статьи.
 *
 * Зачем:
 *   - По ТЗ заказчика: усилить вариативность и человечность контента,
 *     уменьшить узнаваемый «LLM-стиль». Готовые 7 персон с прописанным
 *     тоном/лексикой/anti-hallucination инструкциями.
 *   - Выбор — детерминированный hash(topic + region + brand) → одна из 7,
 *     чтобы при повторном запуске одной задачи получать ту же персону
 *     (стабильность для cached_response и для пользователя).
 *   - При желании можно явно задать persona = '<key>' в task для override.
 *
 * Список персон (по файлам в ./personas/*.txt):
 *   - practitioner       — практик-эксперт, 10+ лет опыта в нише
 *   - science_journalist — научный обозреватель, корректная популяризация
 *   - mentor             — дружелюбный наставник для новичков
 *   - reviewer           — независимый обзорщик, сравнение вариантов
 *   - lifehack           — лайфхак-публицист, динамичный полезный стиль
 *   - historian          — историк-аналитик, исторический контекст
 *   - engineer           — инженер-технолог, чёткие методики/процедуры
 *
 * API:
 *   listPersonas()                      → ключи всех персон
 *   getPersonaPrompt(key)               → содержимое .txt
 *   pickPersonaFor({topic, region, brand}) → детерминированный ключ
 *   buildPersonaSystemBlock(opts)       → готовый блок для system prompt
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PERSONA_DIR = path.join(__dirname, 'personas');

// Порядок важен: индекс используется для детерминированного выбора через hash.
// Менять порядок — это значит сменить персону у уже запущенных задач при
// повторном прогоне (приведёт к cache miss). Только append в конец.
const PERSONA_KEYS = [
  'practitioner',
  'science_journalist',
  'mentor',
  'reviewer',
  'lifehack',
  'historian',
  'engineer',
];

/**
 * Метаданные персоны для байлайна (видимая «подпись автора» в HTML)
 * и JSON-LD Author. По SEO/GEO 2026 авторство — обязательный сигнал
 * E-E-A-T. profile_url оставлен пустым: реальные публичные страницы
 * вымышленных персон не существуют, а ссылка на «битый» URL — плохой
 * сигнал доверия. При появлении реального профиля — заполнять здесь.
 */
const PERSONA_META = Object.freeze({
  practitioner: Object.freeze({
    display_name: 'Анна Воронова',
    role:         'практикующий специалист с 12-летним опытом',
    bio_short:    'Эксперт-практик ниши, описывает реальные кейсы «с земли».',
    profile_url:  '',
  }),
  science_journalist: Object.freeze({
    display_name: 'Сергей Климов',
    role:         'научный обозреватель, популяризатор',
    bio_short:    'Корректно популяризует исследования и стандарты ниши.',
    profile_url:  '',
  }),
  mentor: Object.freeze({
    display_name: 'Мария Литвин',
    role:         'наставник для новичков',
    bio_short:    'Объясняет сложное простым языком, с акцентом на разбор частых ошибок.',
    profile_url:  '',
  }),
  reviewer: Object.freeze({
    display_name: 'Дмитрий Орлов',
    role:         'независимый обзорщик',
    bio_short:    'Сравнивает варианты по измеримым критериям, без рекламных штампов.',
    profile_url:  '',
  }),
  lifehack: Object.freeze({
    display_name: 'Елена Тихая',
    role:         'лайфхак-публицист',
    bio_short:    'Динамичный полезный стиль, ставка на быстрые применимые советы.',
    profile_url:  '',
  }),
  historian: Object.freeze({
    display_name: 'Игорь Безуглов',
    role:         'историк-аналитик',
    bio_short:    'Разбирает темы через исторический контекст и эволюцию подходов.',
    profile_url:  '',
  }),
  engineer: Object.freeze({
    display_name: 'Павел Ильин',
    role:         'инженер-технолог',
    bio_short:    'Чёткие методики, пошаговые алгоритмы, инженерный взгляд.',
    profile_url:  '',
  }),
});

/**
 * Возвращает метаданные персоны по ключу. Для неизвестного ключа —
 * первая (нейтральная) персона.
 */
function getPersonaMeta(key) {
  if (PERSONA_META[key]) return PERSONA_META[key];
  return PERSONA_META[PERSONA_KEYS[0]];
}

const _cache = new Map();

function getPersonaPrompt(key) {
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(PERSONA_DIR, `${key}.txt`);
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[personas] readFile failed for "${key}": ${e.message}`);
    body = '';
  }
  _cache.set(key, body);
  return body;
}

function listPersonas() {
  return PERSONA_KEYS.slice();
}

/**
 * Детерминированный выбор: sha1(topic|region|brand) → 4 байта → mod N.
 * Возвращает ключ персоны. На пустых входах деградирует в 'practitioner'
 * (первая, самая «нейтральная» персона).
 */
function pickPersonaFor({ topic = '', region = '', brand = '' } = {}) {
  const seed = [topic, region, brand]
    .map((s) => String(s || '').trim().toLowerCase())
    .join('|');
  if (!seed.replace(/\|/g, '')) return PERSONA_KEYS[0];
  const h = crypto.createHash('sha1').update(seed).digest();
  const idx = h.readUInt32BE(0) % PERSONA_KEYS.length;
  return PERSONA_KEYS[idx];
}

/**
 * Готовый блок-«пристройка» к существующему system-промпту writer'а.
 *
 * @param {{ topic?:string, region?:string, brand?:string,
 *           persona?: string }} opts — persona override опционален.
 * @returns {{ key: string, block: string }}
 */
function buildPersonaSystemBlock(opts = {}) {
  let key = String(opts.persona || '').trim();
  if (!key || !PERSONA_KEYS.includes(key)) {
    key = pickPersonaFor(opts);
  }
  const body = getPersonaPrompt(key);
  if (!body) {
    return { key, block: '' };
  }
  // Оборачиваем явными маркерами, чтобы writer ясно видел границы блока
  // и не путал с другими секциями system-промпта.
  const block = [
    '',
    '────────────────────────────────────────────────────────────',
    '[АВТОРСКАЯ ПЕРСОНА — ПРИМЕНЯЙ ТОН, ЛЕКСИКУ И ПОДХОД ИЗ ЭТОГО БЛОКА]',
    body.trim(),
    '────────────────────────────────────────────────────────────',
    '',
    '[ANTI-HALLUCINATION HARD RULES — НИКОГДА НЕ НАРУШАЙ]',
    '  • Любая конкретная цифра, дата, имя, бренд, ГОСТ/ТУ, исследование',
    '    или статистика допустимы ТОЛЬКО если они уже фигурируют в одном',
    '    из входных блоков (brand_facts, link_plan, lsi_set, SERP_EVIDENCE,',
    '    user_questions, outline). Иначе — обобщённая формулировка.',
    '  • Не выдумывай «по данным исследований …», «эксперты считают …»,',
    '    «согласно ГОСТ …» с конкретным номером — если этих данных нет.',
    '  • В сомнительных местах используй мягкие маркеры: «как правило»,',
    '    «обычно», «в большинстве случаев», «зависит от условий».',
    '  • Не обещай конкретных гарантированных результатов в числах',
    '    («увеличит … на N %») без основы в исходных данных.',
    '────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
  return { key, block };
}

module.exports = {
  PERSONA_KEYS,
  PERSONA_META,
  listPersonas,
  getPersonaPrompt,
  getPersonaMeta,
  pickPersonaFor,
  buildPersonaSystemBlock,
};
