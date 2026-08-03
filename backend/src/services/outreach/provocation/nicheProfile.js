'use strict';
/**
 * nicheProfile — делает провокационное письмо нишенезависимым.
 *
 * По нише (её уже определяет nicheExpander) отдаёт:
 *   • lead_unit_gen  — слово-единица в форме ПОСЛЕ ЧИСЛА (родительный мн.ч.):
 *                      «150 пациентов / заявок / заказов / обращений».
 *   • lead_unit_one  — единственное число («пациент», для заголовков).
 *   • conversion_rate — доля визит→заявка для оценки «~N заявок/мес».
 *   • matched        — сработавший пресет (или 'default').
 *
 * Стратегия — ГИБРИД:
 *   1) getNicheProfile()      — синхронный, по таблице пресетов (мгновенно).
 *   2) resolveNicheProfile()  — асинхронный: пресет, а если ниша незнакомая —
 *      фолбэк на DeepSeek (через тот же callLLM, что и nicheExpander).
 *
 * ВАЖНО: это отдельный новый модуль. Существующий код рассылки он не трогает.
 */

// Нейтральный дефолт — если нишу не распознали, пишем «заявок».
const DEFAULT_PROFILE = Object.freeze({
  lead_unit_gen: 'заявок',
  lead_unit_one: 'заявка',
  conversion_rate: 0.03,
  matched: 'default',
});

/**
 * Пресеты частых ниш. Каждый: набор подстрок-маркеров (ищем в нише+keyword,
 * в нижнем регистре) → форма единицы и конверсия.
 * Порядок важен: первый сработавший выигрывает, поэтому более узкие — выше.
 */
const PRESETS = [
  {
    key: 'medical',
    markers: ['стоматолог', 'имплант', 'клиник', 'медицин', 'врач', 'лечен', 'зуб', 'ортодонт', 'дерматолог', 'гинеколог', 'узи', 'анализ'],
    lead_unit_gen: 'пациентов', lead_unit_one: 'пациент', conversion_rate: 0.03,
  },
  {
    key: 'beauty',
    markers: ['косметолог', 'салон красот', 'маникюр', 'барбершоп', 'парикмахер', 'депиляц', 'эпиляц', 'массаж', 'ногт', 'бров', 'ресниц'],
    lead_unit_gen: 'записей', lead_unit_one: 'запись', conversion_rate: 0.04,
  },
  {
    key: 'legal',
    markers: ['юрист', 'юридическ', 'адвокат', 'юруслуг', 'банкротств', 'арбитраж', 'нотариус'],
    lead_unit_gen: 'обращений', lead_unit_one: 'обращение', conversion_rate: 0.04,
  },
  {
    key: 'windows',
    markers: ['окна', 'остеклен', 'пластиков', 'двери', 'жалюзи', 'рольставни'],
    lead_unit_gen: 'заказов', lead_unit_one: 'заказ', conversion_rate: 0.03,
  },
  {
    key: 'repair',
    markers: ['ремонт', 'отделк', 'строительств', 'натяжн', 'мебел', 'кухни', 'сантехник', 'электрик', 'плитк', 'дизайн интерьер'],
    lead_unit_gen: 'заявок', lead_unit_one: 'заявка', conversion_rate: 0.025,
  },
  {
    key: 'auto',
    markers: ['автосервис', 'сто ', 'шиномонтаж', 'автозапчаст', 'детейлинг', 'кузовн', 'автомойк', 'эвакуатор'],
    lead_unit_gen: 'записей', lead_unit_one: 'запись', conversion_rate: 0.03,
  },
  {
    key: 'ecom',
    markers: ['магазин', 'интернет-магазин', 'купить', 'доставка', 'товар', 'заказать', 'каталог', 'опт'],
    lead_unit_gen: 'заказов', lead_unit_one: 'заказ', conversion_rate: 0.015,
  },
  {
    key: 'realty',
    markers: ['недвижим', 'новостройк', 'квартир', 'агентство недвиж', 'риелтор', 'ипотек'],
    lead_unit_gen: 'обращений', lead_unit_one: 'обращение', conversion_rate: 0.02,
  },
  {
    key: 'edu',
    markers: ['курс', 'обучен', 'школа', 'образован', 'репетитор', 'тренинг', 'автошкол'],
    lead_unit_gen: 'заявок', lead_unit_one: 'заявка', conversion_rate: 0.03,
  },
  {
    key: 'tourism',
    markers: ['тур', 'отель', 'гостиниц', 'путёвк', 'путевк', 'база отдыха', 'санатор'],
    lead_unit_gen: 'бронирований', lead_unit_one: 'бронирование', conversion_rate: 0.02,
  },
  {
    key: 'b2b',
    markers: ['производств', 'оборудован', 'поставк', 'b2b', 'завод', 'станк', 'спецтехник'],
    lead_unit_gen: 'заявок', lead_unit_one: 'заявка', conversion_rate: 0.02,
  },
];

/** Нормализует строку для поиска маркеров. */
function _norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Синхронный профиль ниши по пресетам.
 * @param {string} niche — ниша (из nicheExpander)
 * @param {{ businessType?: string, keyword?: string }} [ctx]
 * @returns {{lead_unit_gen:string, lead_unit_one:string, conversion_rate:number, matched:string}}
 */
function getNicheProfile(niche, ctx = {}) {
  const hay = _norm([niche, ctx.keyword, ctx.businessType].filter(Boolean).join(' '));
  if (!hay) return { ...DEFAULT_PROFILE };

  for (const p of PRESETS) {
    if (p.markers.some((m) => hay.includes(_norm(m)))) {
      return {
        lead_unit_gen: p.lead_unit_gen,
        lead_unit_one: p.lead_unit_one,
        conversion_rate: p.conversion_rate,
        matched: p.key,
      };
    }
  }
  return { ...DEFAULT_PROFILE };
}

/**
 * Оценка «~N единиц/мес» из трафика: возвращает вилку [min, max]
 * вокруг traffic × conversion_rate (±25 %), округлённую до «красивых» чисел.
 * @param {number} trafficMonth — визитов/мес
 * @param {number} conversionRate — доля визит→заявка
 * @returns {{min:number, max:number}}
 */
function estimateLeads(trafficMonth, conversionRate) {
  const t = Math.max(0, Number(trafficMonth) || 0);
  const cr = Number(conversionRate) > 0 ? Number(conversionRate) : DEFAULT_PROFILE.conversion_rate;
  const mid = t * cr;
  if (mid <= 0) return { min: 0, max: 0 };
  const round = (v) => {
    if (v < 10) return Math.max(1, Math.round(v));
    if (v < 100) return Math.round(v / 5) * 5;
    return Math.round(v / 10) * 10;
  };
  return { min: round(mid * 0.75), max: round(mid * 1.25) };
}

// ── Опциональный LLM-фолбэк для незнакомых ниш ──────────────────────────────
// Ленивая загрузка callLLM, чтобы модуль оставался чистым и тестируемым.
let _callLLM = null;
function _getCallLLM() {
  if (_callLLM === null) {
    try { _callLLM = require('../../llm/callLLM').callLLM; }
    catch (_) { _callLLM = undefined; }
  }
  return _callLLM;
}

const LLM_SYSTEM = `Ты — маркетолог. По нише бизнеса определи, как называется одна заявка/клиент в этой сфере.
Отвечай ТОЛЬКО валидным JSON без markdown:
{"lead_unit_gen":"форма ПОСЛЕ ЧИСЛА, родительный мн.ч. (напр. пациентов, заявок, заказов, обращений)","lead_unit_one":"единственное число (напр. пациент, заявка)","conversion_rate":0.03}
conversion_rate — доля посетителей сайта, которые оставляют заявку (0.01–0.06).`;

/**
 * Асинхронный профиль: сначала пресет; если не распознали (matched==='default')
 * и доступен LLM — уточняем через DeepSeek. Всегда возвращает валидный профиль.
 * @returns {Promise<{lead_unit_gen:string, lead_unit_one:string, conversion_rate:number, matched:string}>}
 */
async function resolveNicheProfile(niche, ctx = {}) {
  const base = getNicheProfile(niche, ctx);
  if (base.matched !== 'default') return base;

  const callLLM = _getCallLLM();
  if (!callLLM || !niche) return base;

  try {
    const r = await callLLM('deepseek', LLM_SYSTEM, String(niche), {
      retries: 1, temperature: 0.1, maxTokens: 200, callLabel: 'outreach.nicheProfile',
    });
    const gen = String(r?.lead_unit_gen || '').trim();
    const one = String(r?.lead_unit_one || '').trim();
    const cr = Number(r?.conversion_rate);
    if (gen && one) {
      return {
        lead_unit_gen: gen,
        lead_unit_one: one,
        conversion_rate: cr > 0 && cr <= 0.2 ? cr : base.conversion_rate,
        matched: 'llm',
      };
    }
  } catch (_) { /* тихий фолбэк на пресет */ }

  return base;
}

module.exports = {
  getNicheProfile,
  resolveNicheProfile,
  estimateLeads,
  DEFAULT_PROFILE,
  PRESETS,
};
