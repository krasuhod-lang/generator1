'use strict';

/**
 * forecaster/arsenkinClient.js — HTTP-клиент API «ARSENKIN TOOLS».
 *
 * Назначение: по списку ключевых запросов собрать СЕЗОННОСТЬ — помесячную
 * частотность Яндекс.Вордстат за последние 24 месяца по каждой фразе.
 * Результат конвертируется в структуру, совместимую с parser.js
 * (rows: [{phrase,total,byPeriod}] + monthCols), и дальше едет в обычный
 * пайплайн прогнозатора (агрегация → аномалии → прогноз на 12 мес).
 *
 * Официальная документация API (кратко):
 *   • Все запросы — POST, JSON, заголовок Authorization с Bearer-токеном
 *   • Постановка задачи:      POST https://arsenkin.ru/api/tools/set
 *       body: { tools_name: "<инструмент>", data: { ...параметры } }
 *       ответ: { task_id } (или { data: { task_id } })
 *   • Инструмент «Проверка сезонности запросов» (официальные параметры):
 *       tools_name: "wordstat"
 *       data: {
 *         type:      3,                — тип проверки (3 = сезонность)
 *         queries:   ["фраза", …],     — массив фраз
 *         region:    213,              — lr региона Яндекса (число, НЕ массив)
 *         device:    "",               — "" (опускается) либо desktop/mobile
 *         group:     "month",          — группировка month/week/day
 *         startdate: "2024-06-01",     — начальная дата (YYYY-MM-DD)
 *         enddate:   "2025-05-31",     — конечная дата (YYYY-MM-DD)
 *       }
 *     Важно: статистика «по месяцам» доступна только для ПОЛНЫХ календарных
 *     месяцев (минимум 3); «по неделям» — полные недели (пн–вс, минимум 3);
 *     «по дням» — только последние 60 дней без текущего. Данные по последнему
 *     завершившемуся периоду публикуются с лагом ~7–14 дней: в начале месяца
 *     запрос «до конца прошлого месяца» отвергается с HTTP 422
 *     {"code":"WRONG_WORDSTAT_DATES"}. На эту ошибку клиент авто-повторяет
 *     задачу, сжимая окно на месяц с обеих сторон (до 3 раз) — см. _runOneTask.
 *   • Проверка статуса:        POST https://arsenkin.ru/api/tools/check
 *       body: { task_id }   → { data: { status_id } }  (1 = в работе, 2 = готово)
 *   • Получение результата:    POST https://arsenkin.ru/api/tools/get
 *       body: { task_id }   → JSON либо CSV-строка (зависит от инструмента).
 *       Для сезонности (type=3) типичная форма:
 *         { status:"ok", data:[ { query:"…", seasonal:[{month:"01",count:…}, …] } ] }
 *       Внимание: месяцы приходят БЕЗ года ("01".."12") — клиент восстанавливает
 *       год из окна сезонности (_monthYearResolver).
 *   • Лимиты: ≤5 задач одновременно (очередь 50), ≤30 запросов/мин ко всем
 *     endpoint'ам; при превышении — {"status":"Error","code":"429"}.
 *
 * ENV (прописываются в корневом .env, backend получает через env_file):
 *   ARSENKIN_API_TOKEN          — обязательный. Токен из «Данные профиля»
 *                                 (тариф STANDARD/КОРПОРАТИВНЫЙ).
 *   ARSENKIN_TOOL_NAME          — имя инструмента (по умолчанию "wordstat").
 *   ARSENKIN_WORDSTAT_TYPE      — тип задачи внутри инструмента wordstat
 *                                 (по умолчанию 3 — проверка сезонности,
 *                                 согласно официальной документации).
 *   ARSENKIN_WORDSTAT_DEVICE    — устройство: desktop или mobile; пустая
 *                                 строка (или иное значение) = поле опускается
 *                                 и статистика собирается по всем устройствам.
 *   ARSENKIN_WORDSTAT_GROUP     — группировка month/week/day (default month).
 *   ARSENKIN_WORDSTAT_EXTRA     — JSON-объект, домердживается в data ПОВЕРХ
 *                                 остальных полей (можно переопределить
 *                                 startdate/enddate и т.п.). Не добавляйте
 *                                 сюда поля, которых нет в документации, —
 *                                 API отвечает HTTP 422.
 *   ARSENKIN_BATCH_SIZE         — фраз в одной задаче (по умолчанию 100).
 *   ARSENKIN_POLL_INTERVAL_MS   — период поллинга статуса (default 10000;
 *                                 не ставьте < 3000 — упрётесь в 30 req/min).
 *   ARSENKIN_TIMEOUT_MIN        — максимум ожидания одной задачи (default 30).
 *
 * Graceful-политика как у keyssoClient: без токена → {verdict:'skipped'},
 * сетевые/HTTP ошибки → {verdict:'error', reason}; исключения наружу не летят
 * только из collectSeasonality-обёртки нет — пайплайн сам решает, фатально ли.
 */

const { parseForecasterInput } = require('./parser');
const { getForecasterConfig } = require('./config');

const API_SET   = 'https://arsenkin.ru/api/tools/set';
const API_CHECK = 'https://arsenkin.ru/api/tools/check';
const API_GET   = 'https://arsenkin.ru/api/tools/get';

function _cfg() {
  let extra = {};
  try {
    if (process.env.ARSENKIN_WORDSTAT_EXTRA) {
      const parsed = JSON.parse(process.env.ARSENKIN_WORDSTAT_EXTRA);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
    }
  } catch (_) { /* некорректный JSON в env — игнорируем */ }
  return {
    token:        String(process.env.ARSENKIN_API_TOKEN || '').trim(),
    toolName:     String(process.env.ARSENKIN_TOOL_NAME || 'wordstat').trim(),
    wordstatType: Number(process.env.ARSENKIN_WORDSTAT_TYPE) || 3,
    device:       String(process.env.ARSENKIN_WORDSTAT_DEVICE || '').trim(),
    group:        String(process.env.ARSENKIN_WORDSTAT_GROUP || 'month').trim() || 'month',
    extra,
    batchSize:    Math.max(1, Number(process.env.ARSENKIN_BATCH_SIZE) || 100),
    pollMs:       Math.max(3000, Number(process.env.ARSENKIN_POLL_INTERVAL_MS) || 10000),
    timeoutMin:   Math.max(1, Number(process.env.ARSENKIN_TIMEOUT_MIN) || 30),
    commToolName: String(process.env.ARSENKIN_COMM_TOOL_NAME || '').trim(),
    wizardToolName: String(process.env.ARSENKIN_WIZARD_TOOL_NAME || '').trim(),
    historyMonths: Math.max(12, Number(getForecasterConfig().forecast?.historyMonths) || 24),
  };
}

// ── Регион: произвольный текст пользователя → Yandex lr ────────────
// Арсенкин принимает ID регионов Яндекса. Минимальный mapping ходовых
// обозначений; по умолчанию 225 (Россия).
const _REGION_ALIASES = {
  'россия': 225, 'russia': 225, 'ru': 225, 'рф': 225,
  'москва': 213, 'moscow': 213, 'мск': 213,
  'санкт-петербург': 2, 'спб': 2, 'питер': 2, 'spb': 2, 'saint petersburg': 2,
  'екатеринбург': 54, 'екб': 54,
  'новосибирск': 65,
  'казань': 43,
  'нижний новгород': 47,
  'краснодар': 35,
  'самара': 51,
  'ростов-на-дону': 39, 'ростов': 39,
  'уфа': 172,
  'челябинск': 56,
  'воронеж': 193,
  'пермь': 50,
  'волгоград': 38,
  'красноярск': 62,
  'омск': 66,
  'тюмень': 55,
};

function resolveRegionLr(label) {
  const s = String(label || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!s) return 225;
  if (/^\d{1,6}$/.test(s)) return parseInt(s, 10); // уже числовой lr
  if (_REGION_ALIASES[s] != null) return _REGION_ALIASES[s];
  // частичное вхождение («Москва и область» → москва)
  for (const [alias, lr] of Object.entries(_REGION_ALIASES)) {
    if (s.includes(alias)) return lr;
  }
  return 225;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── нормализация поля device ───────────────────────────────────────
// Валидатор Арсенкина для «Проверки сезонности запросов» принимает поле
// device только со значениями «пустота или desktop/mobile». Пустая строка
// ("") НЕ считается «пустотой» — на неё API отвечает
//   HTTP 422 {"code":"JSON_VALIDATION_ERROR", "msg":"Ошибки в поле device…"}.
// Поэтому: пустое/неизвестное значение → поле НЕ добавляем в payload (omit),
// а варианты phone/tablet сводим к mobile. Регистр значения не важен.
const _DEVICE_ALIASES = {
  desktop: 'desktop', pc: 'desktop', 'дескоп': 'desktop', 'десктоп': 'desktop',
  mobile: 'mobile', phone: 'mobile', smartphone: 'mobile', tablet: 'mobile',
  'моб': 'mobile', 'мобайл': 'mobile', 'телефон': 'mobile', 'планшет': 'mobile',
};

function normalizeDevice(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return ''; // «пустота» → поле нужно ОПУСТИТЬ, а не слать ""
  return _DEVICE_ALIASES[s] || '';
}

// ── диапазон дат для сезонности ────────────────────────────────────
// Статистика «по месяцам» доступна только для ПОЛНЫХ календарных месяцев,
// поэтому окно: с 1-го числа месяца (historyMonths назад) по последний день
// предыдущего месяца. По умолчанию берём 24 месяца: два годовых цикла нужны
// Holt-Winters, а не только fallback-модели.
// «По неделям» — полные недели пн–вс; «по дням» — максимум 60 дней
// без учёта текущего дня.
//
// monthOffset — СЖАТИЕ окна на указанное число месяцев с обеих сторон
// (для group=month): enddate уезжает на off месяцев назад, startdate — на off
// месяцев вперёд. Нужен для авто-повтора при ошибке WRONG_WORDSTAT_DATES:
// данные Яндекс.Вордстат по последнему завершившемуся месяцу публикуются с
// лагом ~7–14 дней, а история хранится лишь ~24 месяца от последнего
// ОПУБЛИКОВАННОГО месяца. Сдвиг всего окна назад целиком выталкивал startdate
// за пределы ретеншена — и все повторы падали с тем же 422; сжатие окна
// одновременно чинит и «слишком новый» enddate, и «слишком старый» startdate
// (см. _runOneTask). Для group=day/week окно короткое и просто сдвигается.
function seasonalityDateRange(group = 'month', now = new Date(), monthOffset = 0, historyMonths = null) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const off = Math.max(0, Number(monthOffset) || 0);
  // Опорная дата, сдвинутая на off месяцев назад (день сохраняем — нормализация
  // JS Date корректно обработает переполнение дней в коротких месяцах).
  const ref = off
    ? new Date(now.getFullYear(), now.getMonth() - off, now.getDate())
    : now;
  if (group === 'day') {
    const end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 60);
    return { startdate: iso(start), enddate: iso(end) };
  }
  if (group === 'week') {
    // последнее полное воскресенье и понедельник 52 недели назад
    const dow = (ref.getDay() + 6) % 7; // 0 = понедельник
    const end = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - dow - 1);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 52 * 7 + 1);
    return { startdate: iso(start), enddate: iso(end) };
  }
  // month (default): последние historyMonths полных календарных месяцев.
  // При off>0 окно СЖИМАЕТСЯ: enddate — от ref (off месяцев назад),
  // startdate — от now, но на off месяцев ВПЕРЁД (защита от ретеншена
  // Вордстат ~24 мес). Гарантируем минимум один полный месяц в окне.
  const hm = Math.max(1, Number(historyMonths) || Number(getForecasterConfig().forecast?.historyMonths) || 24);
  const endMonthIdx = now.getMonth() - off; // индексы месяцев относительно now (JS нормализует)
  const end = new Date(now.getFullYear(), endMonthIdx, 0);
  const startMonthIdx = Math.min(now.getMonth() - hm + off, endMonthIdx - 1);
  const start = new Date(now.getFullYear(), startMonthIdx, 1);
  return { startdate: iso(start), enddate: iso(end) };
}

// Признак ошибки Арсенкина «указанный период не подходит для этого запроса».
// Данные Вордстат по последнему завершившемуся месяцу ещё не опубликованы —
// повторяем задачу с окном, сжатым на месяц с обеих сторон.
function _isWrongDatesError(err) {
  const msg = String((err && err.message) || err || '');
  return /WRONG_WORDSTAT_DATES/i.test(msg)
    || /период\s+не\s+подходит/i.test(msg);
}

// ── низкоуровневый POST с retry на 429 ─────────────────────────────
async function _post(url, body, token, { retries = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      lastErr = err;
      await _sleep(3000 * (attempt + 1));
      continue;
    }
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* не JSON — возможно CSV */ }

    const is429 = resp.status === 429
      || (json && String(json.code) === '429')
      || (json && /too many requests/i.test(String(json.error || '')));
    if (is429) {
      lastErr = new Error('Arsenkin 429 Too Many Requests');
      await _sleep(15000 * (attempt + 1)); // ждём восстановления минутного лимита
      continue;
    }
    if (!resp.ok) {
      const detail = (json && (json.error || json.message))
        || (text ? String(text).slice(0, 300) : '')
        || '';
      throw new Error(`Arsenkin API: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`);
    }
    if (json && String(json.status || '').toLowerCase() === 'error') {
      throw new Error(`Arsenkin API: ${json.error || json.code || 'unknown error'}`);
    }
    return { json, text };
  }
  throw lastErr || new Error('Arsenkin API: request failed');
}

// ── постановка + ожидание + получение одной задачи ─────────────────
// Максимальное число сжатий окна при ошибке WRONG_WORDSTAT_DATES.
// Каждое сжатие двигает enddate на месяц назад и startdate на месяц вперёд:
// это перекрывает и лаг публикации последнего месяца (~7–14 дней), и
// ретеншен Вордстат (~24 месяца от последнего опубликованного месяца).
const _DATE_RETRY_MAX = 3;

async function _runOneTaskOnce({ phrases, regionLr, cfg, monthOffset }) {
  // Формат по официальной документации «Проверка сезонности запросов»:
  // type=3, region — ЧИСЛО lr Яндекса (не массив), device/group/даты обязательны.
  const range = seasonalityDateRange(cfg.group, new Date(), monthOffset, cfg.historyMonths);
  const { startdate, enddate } = range;
  const data = {
    type:      cfg.wordstatType,
    queries:   phrases,
    region:    regionLr,
    group:     cfg.group,
    startdate,
    enddate,
    ...cfg.extra,
  };
  // device: валидатор Арсенкина принимает только «пустота или desktop/mobile».
  // Пустую строку API отвергает (HTTP 422), поэтому поле добавляем ТОЛЬКО при
  // валидном значении; в остальных случаях (пусто/неизвестно) — опускаем.
  // cfg.extra может переопределить device — нормализуем итоговое значение.
  const deviceVal = normalizeDevice('device' in data ? data.device : cfg.device);
  if (deviceVal) data.device = deviceVal;
  else delete data.device;
  const setResp = await _post(API_SET, { tools_name: cfg.toolName, data }, cfg.token);
  const sj = setResp.json || {};
  const taskId = sj.task_id ?? sj.data?.task_id ?? sj.id ?? sj.data?.id;
  if (taskId == null) {
    throw new Error(`Arsenkin API: /set не вернул task_id (ответ: ${JSON.stringify(sj).slice(0, 300)})`);
  }

  const deadline = Date.now() + cfg.timeoutMin * 60 * 1000;
  for (;;) {
    await _sleep(cfg.pollMs);
    if (Date.now() > deadline) {
      throw new Error(`Arsenkin API: задача ${taskId} не завершилась за ${cfg.timeoutMin} мин`);
    }
    const chk = await _post(API_CHECK, { task_id: taskId }, cfg.token);
    const cj = chk.json || {};
    const statusId = cj.data?.status_id ?? cj.status_id;
    const statusStr = String(cj.data?.status ?? cj.status ?? '').toLowerCase();
    const finished = statusId === 2 || statusId === '2'
      || ['finish', 'finished', 'done', 'complete', 'completed'].includes(statusStr);
    const failed = ['error', 'failed', 'fail'].includes(statusStr);
    if (failed) throw new Error(`Arsenkin API: задача ${taskId} завершилась с ошибкой`);
    if (finished) break;
  }

  const got = await _post(API_GET, { task_id: taskId }, cfg.token);
  return { taskId, json: got.json, text: got.text, range };
}

// Обёртка с авто-повтором на WRONG_WORDSTAT_DATES: если Вордстат ещё не
// опубликовал данные за последний завершившийся период (лаг ~7–14 дней), запрос
// «до конца прошлого месяца» отвергается с HTTP 422. Та же ошибка приходит,
// если startdate старше ретеншена Вордстат (~24 мес). Пробуем окно, сжатое
// на месяц с обеих сторон, пока не получим ответ либо не исчерпаем повторы.
async function _runOneTask({ phrases, regionLr, cfg }) {
  let lastErr = null;
  for (let monthOffset = 0; monthOffset <= _DATE_RETRY_MAX; monthOffset++) {
    try {
      return await _runOneTaskOnce({ phrases, regionLr, cfg, monthOffset });
    } catch (err) {
      lastErr = err;
      if (!_isWrongDatesError(err) || monthOffset === _DATE_RETRY_MAX) throw err;
      // иначе — сжимаем окно на месяц с обеих сторон и повторяем
    }
  }
  throw lastErr || new Error('Arsenkin API: request failed');
}

// ── нормализация результата → rows/{phrase,total,byPeriod} ─────────
const _MONTH_KEY_RE = /^(20\d{2})[-./](0?[1-9]|1[0-2])$/;

function _periodFromAny(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(20\d{2})[-./](0?[1-9]|1[0-2])/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  m = s.match(/^(0?[1-9]|1[0-2])[-./](20\d{2})/);
  if (m) return `${m[2]}-${String(+m[1]).padStart(2, '0')}`;
  return null;
}

/**
 * Извлекает номер месяца (1–12) из значения БЕЗ года — инструмент сезонности
 * Арсенкина (type=3) отдаёт месяцы как "01"…"12" (или 1…12). Возвращает
 * целое 1–12 либо null. Осторожно: НЕ трактует "2024"/большие числа как месяц.
 */
function _monthNumFromAny(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^(0?[1-9]|1[0-2])$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * Строит резолвер для month-only ответа Арсенкина. Для 24-месячного окна
 * номер месяца сам по себе неоднозначен ("01" встречается дважды), поэтому
 * массивы точек маппим по индексу от startdate. Для объектов {"01": n} остаётся
 * legacy-маппинг по enddate: такой формат физически не может хранить 24 значения.
 */
function _monthYearResolver(group = 'month', now = new Date(), monthOffset = 0) {
  const range = seasonalityDateRange(group, now, monthOffset);
  return _resolverFromRange(range.startdate, range.enddate);
}

function _addMonthsPeriod(startPeriod, idx) {
  const m = String(startPeriod || '').match(/^(\d{4})-(\d{2})/);
  if (!m || !Number.isFinite(Number(idx))) return null;
  const base = (Number(m[1]) * 12) + (Number(m[2]) - 1) + Number(idx);
  const y = Math.floor(base / 12);
  const mo = (base % 12) + 1;
  return `${y}-${String(mo).padStart(2, '0')}`;
}

function _resolverFromRange(startdate, enddate) {
  const start = String(startdate || '').match(/^(\d{4})-(\d{2})/);
  const legacy = _resolverFromEnddate(enddate);
  return (monthNum, index = null) => {
    if (!(monthNum >= 1 && monthNum <= 12)) return null;
    if (start && Number.isFinite(Number(index))) {
      const p = _addMonthsPeriod(`${start[1]}-${start[2]}`, index);
      // Индексный маппинг применяем только если номер месяца совпал с точкой.
      if (p && Number(p.slice(5, 7)) === monthNum) return p;
    }
    return legacy(monthNum);
  };
}

/**
 * Legacy-резолвер «номер месяца → YYYY-MM» по дате конца 12-месячного окна.
 * Для 24-месячных массивов используйте _resolverFromRange(startdate,enddate),
 * иначе одноимённые месяцы разных лет будут схлопнуты.
 */
function _resolverFromEnddate(enddate) {
  const m = String(enddate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return () => null;
  const endYear  = Number(m[1]);
  const endMonth = Number(m[2]);
  return (monthNum) => {
    if (!(monthNum >= 1 && monthNum <= 12)) return null;
    const year = monthNum <= endMonth ? endYear : endYear - 1;
    return `${year}-${String(monthNum).padStart(2, '0')}`;
  };
}

function _rowFromHistory(phrase, history, resolveMonth = null) {
  const byPeriod = {};
  if (Array.isArray(history)) {
    // [{month|date|period, count|value|freq|ws}, ...]
    for (let i = 0; i < history.length; i++) {
      const pt = history[i];
      if (!pt || typeof pt !== 'object') continue;
      const rawKey = pt.month ?? pt.date ?? pt.period;
      let period = _periodFromAny(rawKey);
      if (!period && resolveMonth) {
        const mn = _monthNumFromAny(rawKey);
        if (mn) period = resolveMonth(mn, i);
      }
      const val = Number(pt.count ?? pt.value ?? pt.freq ?? pt.ws ?? pt.shows);
      if (period && Number.isFinite(val)) byPeriod[period] = val;
    }
  } else if (history && typeof history === 'object') {
    // {"2024-01": 123, ...} или {"01": 123, …} (month-only сезонность)
    for (const [k, v] of Object.entries(history)) {
      let period = _periodFromAny(k);
      if (!period && resolveMonth) {
        const mn = _monthNumFromAny(k);
        if (mn) period = resolveMonth(mn);
      }
      const val = Number(v);
      if (period && Number.isFinite(val)) byPeriod[period] = val;
    }
  }
  const total = Object.values(byPeriod).reduce((a, b) => a + b, 0);
  return { phrase, total, byPeriod };
}

// Служебные ключи ответа Арсенкина, которые НЕ являются ключевыми фразами
// (в envelope /get: {"code":"TASK_RESULT","task_id":…,"result":{"type":…,
// "task_id":…,"queries":[…], <данные сезонности>}}). При обходе объекта как
// карты «фраза → история» такие ключи нужно пропускать, иначе они попадают в
// rows как пустые фразы и портят выдачу.
const _META_KEYS = new Set([
  'code', 'type', 'status', 'status_id', 'statusid', 'error', 'message',
  'task_id', 'taskid', 'id', 'tools_name', 'toolsname', 'queries',
  'region', 'regions', 'group', 'device', 'startdate', 'enddate', 'ws',
]);

// Ключи-кандидаты, под которыми Арсенкин может отдавать помесячные данные
// сезонности (массив, выровненный с queries, либо массив per-query объектов,
// либо карта «фраза → история»).
const _SEASONAL_KEYS = [
  'seasonal', 'seasonality', 'result', 'results', 'data', 'values',
  'graph', 'history', 'months', 'dynamics', 'frequency', 'stats', 'rows',
];

// Разворачивает вложенный envelope /get до полезной нагрузки. Поддерживает
// как {data|result|results:…}, так и двойную вложенность result.result.
function _unwrapPayload(json) {
  if (!json || typeof json !== 'object') return null;
  let p = json.data ?? json.result ?? json.results ?? json;
  // Иногда результат завёрнут дважды: {result:{result:{…}}} — но НЕ разворачиваем
  // объект, который сам по себе уже несёт queries/сезонные данные.
  if (p && typeof p === 'object' && !Array.isArray(p)
      && !Array.isArray(p.queries)
      && (p.result != null || p.data != null)
      && !_SEASONAL_KEYS.some((k) => _looksLikeHistory(p[k]))) {
    const inner = p.data ?? p.result;
    if (inner && typeof inner === 'object') p = inner;
  }
  return p;
}

// Похоже ли значение на помесячную историю (массив точек / карту месяцев)?
function _looksLikeHistory(v) {
  if (Array.isArray(v)) {
    return v.some((pt) => pt && typeof pt === 'object'
      && (pt.month != null || pt.date != null || pt.period != null
          || pt.count != null || pt.value != null));
  }
  if (v && typeof v === 'object') {
    return Object.keys(v).some((k) => _periodFromAny(k) || _monthNumFromAny(k));
  }
  return false;
}

// Массив per-phrase объектов: [{phrase|query|…, seasonal|history|…}] либо
// объекты с помесячными полями прямо в корне ("2024-01": n).
function _rowsFromArray(arr, resolveMonth) {
  const rows = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const phrase = String(item.phrase ?? item.query ?? item.keyword ?? item.word ?? '').trim();
    if (!phrase) continue;
    let hist = null;
    for (const k of _SEASONAL_KEYS) {
      if (item[k] != null) { hist = item[k]; break; }
    }
    if (hist == null && item.data != null) hist = item.data;
    if (hist != null) {
      rows.push(_rowFromHistory(phrase, hist, resolveMonth));
    } else {
      // помесячные значения лежат прямо в полях item ("2024-01": n)
      const flat = {};
      for (const [k, v] of Object.entries(item)) {
        if (_MONTH_KEY_RE.test(String(k).trim())) flat[k] = v;
      }
      if (Object.keys(flat).length > 0) rows.push(_rowFromHistory(phrase, flat, resolveMonth));
    }
  }
  return rows;
}

// Карта «фраза → история»: {"<фраза>": {"2024-01": n} | [ {month,count} ]}.
// Служебные ключи envelope (_META_KEYS) пропускаются.
function _rowsFromObjectMap(obj, resolveMonth) {
  const rows = [];
  for (const [key, val] of Object.entries(obj)) {
    const phrase = String(key).trim();
    if (!phrase || _META_KEYS.has(phrase.toLowerCase()) || val == null) continue;
    if (typeof val === 'object') {
      let hist = null;
      for (const k of _SEASONAL_KEYS) {
        if (val[k] != null) { hist = val[k]; break; }
      }
      if (hist == null) hist = val;
      const r = _rowFromHistory(phrase, hist, resolveMonth);
      if (Object.keys(r.byPeriod).length > 0) rows.push(r);
    }
  }
  return rows;
}

// Реальный envelope Арсенкина: result.queries — массив строк-фраз, а помесячные
// данные лежат в ПАРАЛЛЕЛЬНОЙ структуре под одним из _SEASONAL_KEYS. Собираем
// строки, сопоставляя queries[i] с элементом данных: либо по индексу (массив
// точек/чисел на фразу), либо по ключу-фразе (карта), либо элемент сам несёт
// свою фразу (массив per-query объектов).
function _rowsFromQueriesEnvelope(payload, resolveMonth) {
  const queries = payload.queries.map((q) => String(q == null ? '' : q).trim());

  // 1. Ищем параллельную структуру данных под известными ключами.
  for (const k of _SEASONAL_KEYS) {
    const data = payload[k];
    if (data == null) continue;

    if (Array.isArray(data)) {
      // 1a. Массив per-query объектов, каждый несёт свою фразу.
      const withPhrase = _rowsFromArray(data, resolveMonth);
      if (withPhrase.length > 0) return withPhrase;

      // 1b. Массив, выровненный с queries по индексу (история на фразу).
      const rows = [];
      for (let i = 0; i < data.length && i < queries.length; i++) {
        if (!queries[i]) continue;
        const r = _rowFromHistory(queries[i], data[i], resolveMonth);
        if (Object.keys(r.byPeriod).length > 0) rows.push(r);
      }
      if (rows.length > 0) return rows;
    } else if (typeof data === 'object') {
      // 1c. Карта «фраза → история».
      const rows = _rowsFromObjectMap(data, resolveMonth);
      if (rows.length > 0) return rows;
    }
  }
  return [];
}

/**
 * Пытается вытащить rows из произвольного JSON-ответа /get.
 * Поддерживаются типовые формы:
 *   • Реальный envelope Арсенкина:
 *     { code:"TASK_RESULT", result:{ type, task_id, queries:[…], <сезонность> } }
 *     где помесячные данные лежат под seasonal/data/result/… параллельно queries.
 *   • { data: [ {phrase|query|keyword, history|months|dynamics|seasonality|seasonal: …} ] }
 *   • { data: { "<фраза>": {"2024-01": n, …} | [ {month,count} ] } }
 *   • Инструмент «Проверка сезонности» (type=3): месяцы приходят БЕЗ года
 *     ("01"…"12") в ключе `seasonal` — маппятся в YYYY-MM через resolveMonth.
 *   • CSV-строка (фраза + помесячные колонки) — через parseForecasterInput.
 *
 * @param {Function|null} resolveMonth — (monthNum:1-12,index?)=>'YYYY-MM' для
 *   month-only ответов; см. _monthYearResolver.
 */
function _normalizeResult({ json, text, resolveMonth = null }) {
  const payload = _unwrapPayload(json);

  let rows = [];
  if (Array.isArray(payload)) {
    rows = _rowsFromArray(payload, resolveMonth);
  } else if (payload && typeof payload === 'object') {
    // Реальный envelope: result.queries[] + параллельные сезонные данные.
    if (Array.isArray(payload.queries)) {
      rows = _rowsFromQueriesEnvelope(payload, resolveMonth);
    }
    // Иначе (или если envelope не дал строк) — трактуем объект как карту
    // «фраза → история», пропуская служебные ключи.
    if (rows.length === 0) {
      rows = _rowsFromObjectMap(payload, resolveMonth);
    }
  }

  if (rows.length > 0) return rows;

  // fallback: CSV-строка (как у инструмента кластеризации) —
  // прогоняем через штатный парсер выгрузок Wordstat.
  if (typeof text === 'string' && text.trim().length > 0 && !json) {
    const parsed = parseForecasterInput(text, { filename: 'arsenkin.csv' });
    if (parsed.rowsCount > 0 && parsed.monthCols.length > 0) return parsed.rows;
  }
  return [];
}


const _SKIP_LOGGED = new Set();
function _logSkipOnce(key, msg) {
  if (_SKIP_LOGGED.has(key)) return;
  _SKIP_LOGGED.add(key);
  console.warn(msg);
}

async function _runCustomTool({ phrases, regionLr, cfg, toolName }) {
  const data = { queries: phrases, region: regionLr };
  const setResp = await _post(API_SET, { tools_name: toolName, data }, cfg.token);
  const sj = setResp.json || {};
  const taskId = sj.task_id ?? sj.data?.task_id ?? sj.id ?? sj.data?.id;
  if (taskId == null) throw new Error(`Arsenkin API: /set не вернул task_id (ответ: ${JSON.stringify(sj).slice(0, 300)})`);

  const deadline = Date.now() + cfg.timeoutMin * 60 * 1000;
  for (;;) {
    await _sleep(cfg.pollMs);
    if (Date.now() > deadline) throw new Error(`Arsenkin API: задача ${taskId} не завершилась за ${cfg.timeoutMin} мин`);
    const chk = await _post(API_CHECK, { task_id: taskId }, cfg.token);
    const cj = chk.json || {};
    const statusId = cj.data?.status_id ?? cj.status_id;
    const statusStr = String(cj.data?.status ?? cj.status ?? '').toLowerCase();
    const finished = statusId === 2 || statusId === '2'
      || ['finish', 'finished', 'done', 'complete', 'completed'].includes(statusStr);
    const failed = ['error', 'failed', 'fail'].includes(statusStr);
    if (failed) throw new Error(`Arsenkin API: задача ${taskId} завершилась с ошибкой`);
    if (finished) break;
  }
  const got = await _post(API_GET, { task_id: taskId }, cfg.token);
  return { taskId, json: got.json, text: got.text };
}

function _walkNumbers(v, keysRe, out = []) {
  if (v == null) return out;
  if (Array.isArray(v)) {
    for (const it of v) _walkNumbers(it, keysRe, out);
    return out;
  }
  if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (keysRe.test(String(k))) {
        const n = Number(val);
        if (Number.isFinite(n)) out.push(n > 1 ? n / 100 : n);
      }
      _walkNumbers(val, keysRe, out);
    }
  }
  return out;
}

function _normalizeCommercialization(res) {
  const payload = _unwrapPayload(res && res.json);
  const nums = _walkNumbers(payload, /(comm|commercial|коммерц|percent|share|value|score)/i)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (nums.length === 0) return null;
  const avg = nums.reduce((a, b) => a + Math.min(1, b), 0) / nums.length;
  return Math.max(0, Math.min(1, Math.round(avg * 10000) / 10000));
}

function _featureType(raw) {
  const s = String(raw || '').toLowerCase().replace(/ё/g, 'е');
  if (/директ|direct|реклам/.test(s)) return 'direct';
  if (/карт|maps|map/.test(s)) return 'maps';
  if (/маркет|market/.test(s)) return 'market';
  if (/товар|галере|goods|gallery/.test(s)) return 'goods_gallery';
  return 'other';
}

function _collectFeatureCounts(v, acc) {
  if (v == null) return;
  if (Array.isArray(v)) {
    for (const it of v) _collectFeatureCounts(it, acc);
    return;
  }
  if (typeof v === 'object') {
    const typeVal = v.type ?? v.name ?? v.title ?? v.element ?? v.feature ?? v.kind;
    if (typeVal != null) {
      const type = _featureType(typeVal);
      const count = Math.max(1, Number(v.count ?? v.qty ?? v.n ?? 1) || 1);
      acc.set(type, (acc.get(type) || 0) + count);
    }
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number' && /(директ|direct|карт|maps|маркет|market|товар|галере|goods|wizard|колдун)/i.test(k)) {
        const type = _featureType(k);
        acc.set(type, (acc.get(type) || 0) + Math.max(0, val));
      } else {
        _collectFeatureCounts(val, acc);
      }
    }
  }
}

function _normalizeSerpFeatures(res) {
  const payload = _unwrapPayload(res && res.json);
  const acc = new Map();
  _collectFeatureCounts(payload, acc);
  return [...acc.entries()]
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }));
}

async function collectCommercialization({ phrases, regionLabel }) {
  const cfg = _cfg();
  if (!cfg.commToolName) {
    _logSkipOnce('comm_tool', '[Forecaster] ARSENKIN_COMM_TOOL_NAME не задан — коммерциализация пропущена');
    return null;
  }
  if (!cfg.token) return null;
  const list = (Array.isArray(phrases) ? phrases : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  try {
    const res = await _runCustomTool({ phrases: list, regionLr: resolveRegionLr(regionLabel), cfg, toolName: cfg.commToolName });
    return _normalizeCommercialization(res);
  } catch (err) {
    console.warn('[Forecaster] Сбор коммерциализации Арсенкин пропущен:', (err && err.message) || String(err));
    return null;
  }
}

async function collectSerpFeatures({ phrases, regionLabel }) {
  const cfg = _cfg();
  if (!cfg.wizardToolName) {
    _logSkipOnce('wizard_tool', '[Forecaster] ARSENKIN_WIZARD_TOOL_NAME не задан — колдунщики SERP пропущены');
    return null;
  }
  if (!cfg.token) return null;
  const list = (Array.isArray(phrases) ? phrases : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  try {
    const res = await _runCustomTool({ phrases: list, regionLr: resolveRegionLr(regionLabel), cfg, toolName: cfg.wizardToolName });
    return _normalizeSerpFeatures(res);
  } catch (err) {
    console.warn('[Forecaster] Сбор колдунщиков Арсенкин пропущен:', (err && err.message) || String(err));
    return null;
  }
}

/**
 * Главный API: собрать сезонность (помесячная частотность за 24 месяца)
 * по списку фраз через Арсенкин.
 *
 * @param {Object} p
 *   - phrases:     string[] — УЖЕ отфильтрованные от стоп-слов запросы
 *   - regionLabel: string   — регион из формы («Москва», «213», пусто = Россия)
 * @returns {Promise<{
 *   verdict: 'ok'|'skipped'|'error',
 *   reason?: string,
 *   rows?: Array<{phrase,total,byPeriod}>,
 *   region_lr?: number,
 *   requested?: number, matched?: number,
 *   tasks?: Array<{task_id, phrases_count}>,
 *   duration_ms?: number,
 * }>}
 */
async function collectSeasonality({ phrases, regionLabel }) {
  const cfg = _cfg();
  if (!cfg.token) return { verdict: 'skipped', reason: 'no_api_key' };
  const list = (Array.isArray(phrases) ? phrases : [])
    .map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_phrases' };

  const regionLr = resolveRegionLr(regionLabel);
  // Резолвер года по умолчанию — для неполноценных ответов без range; для каждой
  // задачи ниже строим отдельный резолвер по фактически применённому окну
  // (авто-повтор WRONG_WORDSTAT_DATES мог сжать окно на месяц-два).
  const defaultResolveMonth = _monthYearResolver(cfg.group);
  const t0 = Date.now();
  const allRows = [];
  const tasksMeta = [];
  let lastRawSample = null;
  let lastRawJson = null;

  try {
    // Батчим и выполняем ПОСЛЕДОВАТЕЛЬНО: лимит Арсенкина — 5 одновременных
    // задач на пользователя и 30 запросов/мин; параллельные батчи легко
    // выбивают 429 и место в очереди других инструментов.
    for (let i = 0; i < list.length; i += cfg.batchSize) {
      const batch = list.slice(i, i + cfg.batchSize);
      const res = await _runOneTask({ phrases: batch, regionLr, cfg });
      tasksMeta.push({ task_id: res.taskId, phrases_count: batch.length });
      lastRawSample = _rawSample(res);
      lastRawJson = res.json ?? null;
      const resolveMonth = res.range
        ? _resolverFromRange(res.range.startdate, res.range.enddate)
        : defaultResolveMonth;
      const rows = _normalizeResult({ ...res, resolveMonth });
      allRows.push(...rows);
    }
  } catch (err) {
    const baseReason = (err && err.message) || String(err);
    // Если даже после сжатий окна Вордстат отвергает период —
    // добавляем понятную подсказку про лаг публикации данных.
    const reason = _isWrongDatesError(err)
      ? `${baseReason} (Яндекс.Вордстат ещё не опубликовал данные за запрошенный период — `
        + `помесячная статистика выходит с лагом ~7–14 дней; попробуйте перезапустить задачу позже `
        + `или задайте более раннее окно через ARSENKIN_WORDSTAT_EXTRA {startdate,enddate}).`
      : baseReason;
    return {
      verdict: 'error',
      reason,
      rows: allRows,
      region_lr: regionLr,
      requested: list.length,
      matched: allRows.length,
      tasks: tasksMeta,
      duration_ms: Date.now() - t0,
    };
  }

  if (allRows.length === 0) {
    // Добавляем усечённый образец сырого ответа /get — без него причину
    // «пустого результата» (неизвестный формат ответа vs пустая выдача vs
    // лимиты) невозможно диагностировать по логам.
    const diag = _diagnoseEmpty(lastRawJson);
    const hint = lastRawSample
      ? ` Ответ /get (образец): ${lastRawSample}`
      : '';
    return {
      verdict: 'error',
      reason: diag + hint,
      region_lr: regionLr,
      requested: list.length,
      matched: 0,
      tasks: tasksMeta,
      duration_ms: Date.now() - t0,
    };
  }

  return {
    verdict: 'ok',
    rows: allRows,
    region_lr: regionLr,
    requested: list.length,
    matched: allRows.length,
    tasks: tasksMeta,
    duration_ms: Date.now() - t0,
  };
}

/**
 * Формирует человекочитаемую причину пустого результата на основе сырого JSON
 * ответа /get. Ключевая эвристика: если Арсенкин вернул РЕЗУЛЬТАТ ПАРСИНГА ФРАЗ
 * (type=2 — только список `queries`, без помесячной сезонности) вместо проверки
 * сезонности (type=3), значит инструмент/тип задачи выбран неверно — прямо
 * подсказываем выставить ARSENKIN_WORDSTAT_TYPE=3.
 */
function _diagnoseEmpty(json) {
  const base = 'Арсенкин вернул пустой результат (проверьте ARSENKIN_TOOL_NAME/ARSENKIN_WORDSTAT_TYPE и лимиты аккаунта).';
  try {
    const inner = (json && typeof json === 'object')
      ? (json.result ?? json.data ?? json)
      : null;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const type = Number(inner.type);
      const hasQueries = Array.isArray(inner.queries);
      const hasSeasonal = _SEASONAL_KEYS.some((k) => _looksLikeHistory(inner[k]));
      if (!hasSeasonal && hasQueries && type === 2) {
        return 'Арсенкин вернул результат парсинга фраз (type=2), а не помесячную сезонность (type=3). '
          + 'Задайте ARSENKIN_WORDSTAT_TYPE=3 (проверка сезонности) и ARSENKIN_WORDSTAT_GROUP=month.';
      }
      if (!hasSeasonal && hasQueries) {
        return 'Арсенкин вернул только список запросов без помесячных данных сезонности. '
          + 'Проверьте, что ARSENKIN_WORDSTAT_TYPE=3 и тариф аккаунта включает проверку сезонности.';
      }
    }
  } catch (_) { /* диагностика best-effort */ }
  return base;
}

/**
 * Усечённый безопасный образец сырого ответа /get для диагностики
 * «пустого результата». Кроме укороченного дампа, отдельно перечисляет
 * структурные ключи envelope и его вложенного result — иначе при огромном
 * массиве `queries` реальные ключи с данными сезонности выпадают за лимит
 * усечения и причину сбоя не видно в логах.
 */
function _rawSample(res) {
  try {
    if (res && res.json != null && typeof res.json === 'object') {
      const parts = [];
      const topKeys = Object.keys(res.json);
      if (topKeys.length) parts.push(`keys=[${topKeys.join(',')}]`);
      const inner = res.json.result ?? res.json.data;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const innerKeys = Object.keys(inner).map((k) => {
          const v = inner[k];
          if (Array.isArray(v)) return `${k}[${v.length}]`;
          if (v && typeof v === 'object') return `${k}{}`;
          return k;
        });
        parts.push(`result.keys=[${innerKeys.join(',')}]`);
      }
      const dump = JSON.stringify(res.json).slice(0, 600);
      parts.push(dump);
      return parts.join(' ');
    }
    if (res && res.json != null) {
      return JSON.stringify(res.json).slice(0, 600);
    }
    if (res && typeof res.text === 'string' && res.text.trim()) {
      return res.text.trim().slice(0, 600);
    }
  } catch (_) { /* циклический JSON и пр. — игнорируем */ }
  return null;
}

module.exports = {
  collectSeasonality,
  collectCommercialization,
  collectSerpFeatures,
  resolveRegionLr,
  seasonalityDateRange,
  normalizeDevice,
  // internals для тестов
  _normalizeResult,
  _rowFromHistory,
  _monthYearResolver,
  _resolverFromEnddate,
  _resolverFromRange,
  _isWrongDatesError,
};
