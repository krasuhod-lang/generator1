'use strict';
/**
 * markerSelectorV2 — правильный выбор ГЛАВНОГО запроса и очистка ядра.
 *
 * Проблема наивной логики (max частотность там, где сайт в топе): выбирает
 * узкие ГЕО-хвосты, где легко попасть в топ из-за отсутствия конкуренции
 * (пример: юрфирма → «фрязино юрист»).
 *
 * Методика (Маркин + DrMax, подтверждена диагностикой на law-bureau.com):
 *   1. отсечь ИНФО-запросы (как/что/почему…);
 *   2. отсечь ГЕО-хвосты (запрос = ядро + топоним) — гео это НАДСТРОЙКА,
 *      а не критерий выбора главного;
 *   3. определить ЦЕНТР ядра (самый частотный значимый токен по объёму);
 *   4. главный = самый частотный КОММЕРЧЕСКИЙ запрос БЕЗ гео, содержащий центр.
 *
 * Чистая функция (без API) — легко тестируется. ИЗОЛЯЦИЯ: новый модуль.
 */

// Стоп-слова (не считаются «ядром»).
const STOP = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'от', 'до', 'за', 'к', 'ко', 'у', 'о', 'об',
  'при', 'под', 'над', 'из', 'а', 'но', 'или', 'это', 'же', 'бы', 'то', 'так',
  'для', 'без', 'про', 'the', 'a', 'ru', 'com',
]);

// Инфо-маркеры (запрос информационный, не коммерческий).
const INFO = [
  'как ', 'что ', 'почему', 'зачем', 'сколько', 'можно ли', 'нужно ли', 'какой',
  'какие', 'какая', 'чем ', 'кто ', 'стоит ли', ' ли ', 'своими руками', 'пример',
  'образец', 'бесплатно', 'скачать', 'форум', 'отзывы', 'значит', 'это такое',
];

// Общие коммерческие маркеры (нишенезависимые сигналы «за деньги/услуга»).
// Плюс к ним — «стем ядра» ловит нишевое слово (юрист/ремонт/окна…).
const COMM = [
  'услуг', 'цена', 'цены', 'стоимост', 'купить', 'заказать', 'заказ', 'под ключ',
  'консультац', 'помощь', 'срочн', 'недорого', 'сопровожд', 'оформлен', 'вызов',
  'монтаж', 'установк', 'ремонт', 'доставк', 'прайс', 'тариф', 'запис',
];

// Топонимы: миллионники + частые города/районы/пригороды МО (расширяемо).
// Не претендует на полноту — плюс есть эвристика «редкий хвостовой токен».
const CITIES = new Set([
  'москва', 'москве', 'мск', 'московская', 'подмосковье', 'спб', 'питер',
  'санкт-петербург', 'петербург', 'екатеринбург', 'новосибирск', 'казань', 'самара',
  'нижний', 'новгород', 'ростов', 'уфа', 'пермь', 'омск', 'челябинск', 'воронеж',
  'волгоград', 'красноярск', 'тюмень', 'краснодар', 'саратов', 'томск', 'минск',
  'фрязино', 'щёлково', 'щелково', 'мытищи', 'королёв', 'королев', 'пушкино',
  'балашиха', 'химки', 'подольск', 'реутов', 'ивантеевка', 'красноармейск',
  'лосино', 'петровский', 'монино', 'звенигород', 'егорьевск', 'апрелевка',
  'электрогорск', 'протвино', 'строгино', 'царицыно', 'электрозаводская',
  'зеленоград', 'домодедово', 'люберцы', 'одинцово', 'красногорск', 'дмитров',
  'ногинск', 'орехово', 'зуево', 'серпухов', 'коломна', 'жуковский', 'долгопрудный',
]);

function _norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
function _tokens(s) {
  return _norm(s).replace(/[^a-zа-я0-9\- ]/gi, ' ').split(/\s+/).filter(Boolean);
}

function isInfo(phrase) {
  const p = ' ' + _norm(phrase) + ' ';
  return INFO.some((w) => p.includes(_norm(w)));
}

function isComm(phrase) {
  const p = _norm(phrase);
  return COMM.some((w) => p.includes(w));
}

/** Стем токена (корень ~5 символов) — устойчивость к морфологии (юрист/юриста). */
function _stem(t) { return _norm(t).slice(0, 5); }
/** Есть ли в фразе токен с тем же корнем, что у центра ядра. */
function _hasCoreStem(phrase, coreStem) {
  if (!coreStem) return false;
  return _tokens(phrase).some((t) => _stem(t) === coreStem);
}

/** Есть ли в запросе топоним (город/район/метро/«рядом со мной»). */
function isGeo(phrase, rareTokens) {
  const toks = _tokens(phrase);
  if (toks.some((t) => CITIES.has(t))) return true;
  const p = _norm(phrase);
  if (p.includes('метро') || p.includes('рядом со мной') || p.includes('рядом')) return true;
  // Эвристика неизвестного топонима: применяем ТОЛЬКО к коротким запросам
  // (ровно 2 слова, «ядро + хвост») и без коммерческого маркера — иначе
  // «юрист по страховым случаям» ложно улетит в гео из-за редкого «случаям».
  if (rareTokens && toks.length === 2 && !isComm(phrase)) {
    const last = toks[toks.length - 1];
    if (last.length >= 4 && rareTokens.has(last)) return true;
  }
  return false;
}

/**
 * Определяет «центр» ядра — самый частотный значимый токен (по сумме объёма
 * запросов, где он встречается). Исключает стоп-слова, гео и числа.
 */
function coreToken(keywords) {
  const weight = new Map();
  for (const k of keywords) {
    const seen = new Set();
    for (const t of _tokens(k.phrase)) {
      if (STOP.has(t) || CITIES.has(t) || /^\d+$/.test(t) || t.length < 3) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      weight.set(t, (weight.get(t) || 0) + (Number(k.volume) || 1));
    }
  }
  let best = null;
  for (const [t, w] of weight) if (!best || w > best.w) best = { t, w };
  return best ? best.t : '';
}

/** Токены, встречающиеся в ≤maxDocs запросах (кандидаты в топонимы-хвосты). */
function _rareTokens(keywords, maxDocs = 2) {
  const docs = new Map();
  for (const k of keywords) {
    for (const t of new Set(_tokens(k.phrase))) {
      if (t.length < 4 || STOP.has(t) || /^\d+$/.test(t)) continue;
      docs.set(t, (docs.get(t) || 0) + 1);
    }
  }
  const rare = new Set();
  for (const [t, c] of docs) if (c <= maxDocs) rare.add(t);
  return rare;
}

/**
 * @param {Array<{phrase, volume, position}>} keywords — ключи домена (keys.so)
 * @param {object} [opts]
 * @param {number} [opts.markersCount] сколько маркеров-кандидатов вернуть (10)
 * @returns {{
 *   main_query: string,
 *   main: object|null,
 *   markers: Array,       // топ коммерческих запросов без гео (кандидаты в маркеры)
 *   core_token: string,   // центр ядра
 *   core_keywords: Array, // очищенное ядро (без инфо; гео помечены)
 *   stats: object,
 * }}
 */
function selectMarkerV2(keywords, opts = {}) {
  const list = Array.isArray(keywords) ? keywords.filter((k) => k && k.phrase) : [];
  const markersCount = opts.markersCount || 10;
  if (!list.length) {
    return { main_query: '', main: null, markers: [], core_token: '', core_keywords: [], stats: { total: 0 } };
  }

  const rare = _rareTokens(list);
  const core = coreToken(list);
  const coreStem = _stem(core);

  // Классифицируем.
  const enriched = list.map((k) => ({
    ...k,
    _info: isInfo(k.phrase),
    _geo: isGeo(k.phrase, rare),
    _hasCore: _hasCoreStem(k.phrase, coreStem),
    _comm: isComm(k.phrase),
  }));

  const byFreq = enriched.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0));

  // Маркеры: не инфо + без гео + «в теме» (коммерческий маркер ИЛИ корень ядра).
  // Это отсекает и гео-хвосты («фрязино юрист»), и шум-имена («геннадий поляков»).
  const markers = byFreq.filter((k) => !k._info && !k._geo && (k._comm || k._hasCore));
  // Фолбэк-цепочка, если строгий фильтр всё вычистил.
  const pool = markers.length ? markers
    : byFreq.filter((k) => !k._info && !k._geo).length
      ? byFreq.filter((k) => !k._info && !k._geo)
      : byFreq.filter((k) => !k._info);

  const main = pool[0] || byFreq[0] || null;

  // Очищенное ядро: без инфо; гео оставляем, но помечены (пригодятся для гео-страниц).
  const coreKeywords = enriched.filter((k) => !k._info);

  return {
    main_query: main ? main.phrase : '',
    main: main ? { phrase: main.phrase, volume: main.volume, position: main.position } : null,
    markers: pool.slice(0, markersCount).map((k) => ({ phrase: k.phrase, volume: k.volume, position: k.position })),
    core_token: core,
    core_keywords: coreKeywords.map((k) => ({ phrase: k.phrase, volume: k.volume, position: k.position, geo: k._geo })),
    stats: {
      total: list.length,
      info: enriched.filter((k) => k._info).length,
      geo: enriched.filter((k) => k._geo).length,
      commercial_no_geo: markers.length,
    },
  };
}

module.exports = { selectMarkerV2, isGeo, isInfo, coreToken };
