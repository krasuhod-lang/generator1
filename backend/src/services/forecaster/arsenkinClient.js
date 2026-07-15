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
 *     {"code":"WRONG_WORDSTAT_DATES"}. Поэтому в первые дни месяца
 *     (день < ARSENKIN_WORDSTAT_LAG_DAYS, по умолчанию 20) окно сразу
 *     заканчивается на месяц раньше, а startdate — historyMonths (24 мес)
 *     назад от enddate. Если период всё равно отвергнут, клиент авто-повторяет
 *     задачу: сначала с периодом, подсказанным сервером в тексте ошибки,
 *     затем сжимая окно на месяц с обеих сторон (до 6 раз) — см. _runOneTask.
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
 *                                 API отвечает HTTP 422. При авто-повторе
 *                                 WRONG_WORDSTAT_DATES заданные здесь даты
 *                                 заменяются вычисленным (сжатым) окном.
 *   ARSENKIN_WORDSTAT_LAG_DAYS  — день месяца, до которого последний
 *                                 завершившийся месяц считается ещё не
 *                                 опубликованным Вордстатом (default 20).
 *   ARSENKIN_BATCH_SIZE         — фраз в одной задаче (по умолчанию 100).
 *   ARSENKIN_CONCURRENCY        — сколько задач гоняем параллельно (default 3,
 *                                 клампится в 1..5 под официальный лимит
 *                                 Арсенкина «5 одновременных задач и 30 req/min»).
 *                                 Для 1000 фраз даёт ~3× ускорение по сравнению
 *                                 с последовательной обработкой.
 *   ARSENKIN_POLL_INTERVAL_MS   — период поллинга статуса (default 10000;
 *                                 не ставьте < 3000 — упрётесь в 30 req/min).
 *   ARSENKIN_FIRST_CHECK_MS     — пауза перед ПЕРВЫМ /check (default 3000,
 *                                 минимум 1000). Дальше клиент растит паузу
 *                                 геометрически (×1.6) до pollMs. Экономит
 *                                 5–10с на быстрых задачах сезонности.
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

// Санитизация токена из ENV: частые ошибки при вставке в .env — значение в
// кавычках (docker `env_file` НЕ снимает кавычки — они уезжают в заголовок
// Authorization как есть), префикс схемы «Bearer», переводы строк/пробелы внутри
// скопированного значения. Всё это приводит к HTTP 401 USER_NOT_FOUND,
// хотя сам токен верный. Приводим значение к «голому» токену.
function _sanitizeToken(raw) {
  let t = String(raw || '').trim();
  // снимаем одинарные/двойные кавычки по краям (в т.ч. парные)
  t = t.replace(/^['"]+/, '').replace(/['"]+$/, '');
  // убираем случайно скопированный префикс схемы авторизации
  t = t.replace(/^Bearer\s+/i, '');
  // выкидываем внутренние пробельные символы (перенос строки при копировании)
  t = t.replace(/\s+/g, '');
  return t;
}

function _cfg() {
  let extra = {};
  try {
    if (process.env.ARSENKIN_WORDSTAT_EXTRA) {
      const parsed = JSON.parse(process.env.ARSENKIN_WORDSTAT_EXTRA);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
    }
  } catch (_) {
    // некорректный JSON в env — игнорируем, но предупреждаем один раз:
    // частая причина — inline-комментарий после значения в .env
    _logSkipOnce('bad_extra_json',
      '[Forecaster] ARSENKIN_WORDSTAT_EXTRA содержит невалидный JSON и проигнорирован '
      + '(проверьте, что после значения в .env нет inline-комментария)');
  }
  return {
    token:        _sanitizeToken(process.env.ARSENKIN_API_TOKEN),
    toolName:     String(process.env.ARSENKIN_TOOL_NAME || 'wordstat').trim(),
    wordstatType: Number(process.env.ARSENKIN_WORDSTAT_TYPE) || 3,
    device:       String(process.env.ARSENKIN_WORDSTAT_DEVICE || '').trim(),
    group:        String(process.env.ARSENKIN_WORDSTAT_GROUP || 'month').trim() || 'month',
    extra,
    batchSize:    Math.max(1, Number(process.env.ARSENKIN_BATCH_SIZE) || 100),
    pollMs:       Math.max(3000, Number(process.env.ARSENKIN_POLL_INTERVAL_MS) || 10000),
    // Пауза перед ПЕРВЫМ /check: обычно задача сезонности готова быстрее, чем
    // за pollMs (=10с), поэтому спрашиваем раньше — экономит ~5–7с на батче.
    // Минимум 1с, максимум = pollMs (не имеет смысла делать первый чек позже
    // штатного шага). ENV: ARSENKIN_FIRST_CHECK_MS.
    firstCheckMs: Math.max(1000, Number(process.env.ARSENKIN_FIRST_CHECK_MS) || 3000),
    // Сколько батчей выполняем параллельно. Официальный лимит Арсенкина —
    // 5 одновременных задач на пользователя и 30 запросов/мин суммарно;
    // 3 — безопасное значение по умолчанию (укладывается в 30 req/min при
    // pollMs≥5с, оставляет запас для параллельных инструментов). Значения
    // выше 5 клампятся, ниже 1 — округляются вверх. ENV: ARSENKIN_CONCURRENCY.
    concurrency:  Math.max(1, Math.min(5, Number(process.env.ARSENKIN_CONCURRENCY) || 3)),
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

// Определяет числовой lr задачи: приоритет — уже «вшитый» region_lr (как в
// модуле релевантности, где lr — first-class поле задачи), иначе резолвим
// из текстовой метки региона. Гарантирует, что при создании задачи lr
// фиксируется один раз и дальше не «плывёт» между вызовами.
function _pickRegionLr(regionLr, regionLabel) {
  const n = Number(regionLr);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return resolveRegionLr(regionLabel);
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
//
// Лаг публикации помесячной статистики Вордстат — ~7–14 дней. Чтобы не
// начинать каждый запуск с заведомо провального окна «до конца прошлого
// месяца», в первые дни месяца (день < ARSENKIN_WORDSTAT_LAG_DAYS, по
// умолчанию 20) последний месяц считаем ещё НЕ опубликованным и сразу
// заканчиваем окно на месяц раньше. startdate при этом уезжает на
// historyMonths назад от enddate — т.е. окно всегда «текущая безопасная
// дата минус 2 года» (при historyMonths=24). Авто-повтор monthOffset
// работает поверх этой базы.
const _WORDSTAT_LAG_DAYS = (() => {
  const n = Number(process.env.ARSENKIN_WORDSTAT_LAG_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 28 ? n : 20;
})();

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
  // Базовое окно учитывает лаг публикации: в первые _WORDSTAT_LAG_DAYS дней
  // месяца последний завершившийся месяц считаем неопубликованным и заканчиваем
  // окно на месяц раньше; startdate — ровно historyMonths назад от enddate
  // («текущая дата минус 2 года» при historyMonths=24).
  // При off>0 окно СЖИМАЕТСЯ: enddate — ещё на off месяцев назад,
  // startdate — на off месяцев ВПЕРЁД (защита от ретеншена Вордстат
  // ~24 мес от последнего опубликованного месяца). Гарантируем минимум
  // один полный месяц в окне.
  const hm = Math.max(1, Number(historyMonths) || Number(getForecasterConfig().forecast?.historyMonths) || 24);
  const lagExtra = now.getDate() < _WORDSTAT_LAG_DAYS ? 1 : 0;
  const endMonthIdx = now.getMonth() - lagExtra - off; // индексы месяцев относительно now (JS нормализует)
  const end = new Date(now.getFullYear(), endMonthIdx, 0);
  const startMonthIdx = Math.min(now.getMonth() - lagExtra - hm + off, endMonthIdx - 1);
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

// Пытается вытащить из текста ошибки WRONG_WORDSTAT_DATES ДОПУСТИМЫЙ период,
// который сервер Арсенкина подсказывает в msg («…выберите период с 01.08.2024
// по 30.04.2026» / «…с 2024-08-01 по 2026-04-30»). Возвращает
// {startdate, enddate} в ISO либо null, если дат в сообщении нет.
function _datesFromErrorMessage(err) {
  const msg = String((err && err.message) || err || '');
  const pad = (n) => String(n).padStart(2, '0');
  const found = [];
  // ISO: YYYY-MM-DD (также YYYY.MM.DD / YYYY/MM/DD)
  const isoRe = /(20\d{2})[-./](1[0-2]|0?[1-9])[-./](3[01]|[12]\d|0?[1-9])/g;
  let m;
  while ((m = isoRe.exec(msg)) !== null) {
    found.push({ y: +m[1], mo: +m[2], d: +m[3], idx: m.index });
  }
  // RU: DD.MM.YYYY (также DD-MM-YYYY / DD/MM/YYYY)
  const ruRe = /(3[01]|[12]\d|0?[1-9])[-./](1[0-2]|0?[1-9])[-./](20\d{2})/g;
  while ((m = ruRe.exec(msg)) !== null) {
    // не дублируем совпадения, уже разобранные как ISO
    if (found.some((f) => Math.abs(f.idx - m.index) < 10)) continue;
    found.push({ y: +m[3], mo: +m[2], d: +m[1], idx: m.index });
  }
  if (found.length < 2) return null;
  found.sort((a, b) => a.idx - b.idx);
  const [a, b] = [found[0], found[found.length - 1]];
  const t = (f) => new Date(f.y, f.mo - 1, f.d).getTime();
  const [start, end] = t(a) <= t(b) ? [a, b] : [b, a];
  if (t(start) === t(end)) return null;
  return {
    startdate: `${start.y}-${pad(start.mo)}-${pad(start.d)}`,
    enddate:   `${end.y}-${pad(end.mo)}-${pad(end.d)}`,
  };
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
      // Арсенкин кладёт человекочитаемую причину в json.msg (+ код в json.code);
      // берём их из распарсенного JSON — иначе в ошибку попадает усечённый сырой
      // текст с \u-эскейпами, обрезанный на полуслове, и подсказку сервера
      // (например, допустимый период дат) невозможно прочитать.
      const detail = (json && [json.code, json.msg, json.error, json.message]
        .filter((v) => v != null && String(v).trim() !== '')
        .map((v) => String(v))
        .join(' — ').slice(0, 600))
        || (text ? String(text).slice(0, 600) : '')
        || '';
      // 401 USER_NOT_FOUND — токен не распознан сервером Арсенкина. Даём
      // пользователю конкретную подсказку: проблема в значении
      // ARSENKIN_API_TOKEN, а не в самом сервисе.
      const authHint = resp.status === 401
        ? '. Проверьте токен ARSENKIN_API_TOKEN в .env: скопируйте его заново из '
          + '«Данные профиля» на arsenkin.ru (без кавычек и пробелов), убедитесь, '
          + 'что тариф поддерживает API, и перезапустите backend '
          + '(docker compose up -d --force-recreate backend)'
        : '';
      throw new Error(`Arsenkin API: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}${authHint}`);
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
// 6 сжатий покрывают до полугода расхождения между нашим расчётом окна и
// фактически опубликованным Вордстатом диапазоном.
const _DATE_RETRY_MAX = 6;

// Приводит произвольный диапазон дат к ПОЛНЫМ календарным месяцам
// (startdate → 1-е число месяца, enddate → последний день месяца) —
// требование Арсенкина для group=month.
function _snapRangeToFullMonths(range) {
  const m = (s) => String(s || '').match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  const s = m(range && range.startdate);
  const e = m(range && range.enddate);
  if (!s || !e) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(+e[1], +e[2], 0).getDate();
  const startdate = `${s[1]}-${s[2]}-01`;
  const enddate = `${e[1]}-${e[2]}-${pad(lastDay)}`;
  if (startdate >= enddate) return null;
  return { startdate, enddate };
}

async function _runOneTaskOnce({ phrases, regionLr, cfg, monthOffset, forcedRange = null }) {
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
  // ARSENKIN_WORDSTAT_EXTRA может жёстко переопределить startdate/enddate.
  // На первой попытке уважаем override пользователя, но при авто-повторе
  // WRONG_WORDSTAT_DATES (monthOffset>0) возвращаем вычисленные даты —
  // иначе все повторы шлют те же самые «плохие» даты и гарантированно падают.
  if (monthOffset > 0) {
    data.startdate = startdate;
    data.enddate = enddate;
  }
  // forcedRange — допустимый период, который сам сервер Арсенкина подсказал
  // в тексте ошибки WRONG_WORDSTAT_DATES; имеет высший приоритет.
  if (forcedRange && forcedRange.startdate && forcedRange.enddate) {
    data.startdate = forcedRange.startdate;
    data.enddate = forcedRange.enddate;
  }
  // Фактически применённое окно (с учётом extra-override) — по нему дальше
  // восстанавливается год для month-only ответов сезонности.
  const effRange = { startdate: data.startdate, enddate: data.enddate };
  const setResp = await _post(API_SET, { tools_name: cfg.toolName, data }, cfg.token);
  const sj = setResp.json || {};
  const taskId = sj.task_id ?? sj.data?.task_id ?? sj.id ?? sj.data?.id;
  if (taskId == null) {
    throw new Error(`Arsenkin API: /set не вернул task_id (ответ: ${JSON.stringify(sj).slice(0, 300)})`);
  }

  const deadline = Date.now() + cfg.timeoutMin * 60 * 1000;
  // Адаптивный поллинг: первый /check раньше (firstCheckMs, default 3с),
  // дальше геометрически растим паузу до штатного pollMs. Для быстрых задач
  // (готовы за 3–5с) это экономит 5–10с ожидания на батче.
  let curDelay = Math.min(cfg.firstCheckMs, cfg.pollMs);
  for (;;) {
    await _sleep(curDelay);
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
    curDelay = Math.min(cfg.pollMs, Math.ceil(curDelay * 1.6));
  }

  const got = await _post(API_GET, { task_id: taskId }, cfg.token);
  return { taskId, json: got.json, text: got.text, range: effRange };
}

// Обёртка с авто-повтором на WRONG_WORDSTAT_DATES: если Вордстат ещё не
// опубликовал данные за последний завершившийся период (лаг ~7–14 дней), запрос
// «до конца прошлого месяца» отвергается с HTTP 422. Та же ошибка приходит,
// если startdate старше ретеншена Вордстат (~24 мес).
// Стратегия повторов:
//   1. Если сервер в тексте ошибки подсказал допустимый период (например
//      «выберите период с 01.08.2024 по 30.04.2026») — повторяем ровно с ним
//      (для group=month даты выравниваются на полные календарные месяцы).
//   2. Иначе сжимаем окно на месяц с обеих сторон и повторяем, пока не получим
//      ответ либо не исчерпаем _DATE_RETRY_MAX повторов.
async function _runOneTask({ phrases, regionLr, cfg }) {
  let lastErr = null;
  let suggestedTried = false;
  for (let monthOffset = 0; monthOffset <= _DATE_RETRY_MAX; monthOffset++) {
    try {
      return await _runOneTaskOnce({ phrases, regionLr, cfg, monthOffset });
    } catch (err) {
      lastErr = err;
      if (!_isWrongDatesError(err) || monthOffset === _DATE_RETRY_MAX) throw err;
      // Сервер мог подсказать допустимый период прямо в тексте ошибки —
      // пробуем его ПЕРЕД слепым сжатием окна (только один раз).
      if (!suggestedTried) {
        suggestedTried = true;
        const suggested = _datesFromErrorMessage(err);
        const range = cfg.group === 'month'
          ? _snapRangeToFullMonths(suggested)
          : suggested;
        if (range) {
          try {
            return await _runOneTaskOnce({ phrases, regionLr, cfg, monthOffset, forcedRange: range });
          } catch (err2) {
            lastErr = err2;
            if (!_isWrongDatesError(err2)) throw err2;
          }
        }
      }
      // иначе — сжимаем окно на месяц с обеих сторон и повторяем
    }
  }
  throw lastErr || new Error('Arsenkin API: request failed');
}

// ── нормализация результата → rows/{phrase,total,byPeriod} ─────────
// Ключ помесячной колонки. Помимо классических YYYY-MM / MM.YYYY поддерживаем
// формы, которые Арсенкин отдавал в разных версиях API для type=3/group=month:
// полную дату YYYY-MM-DD (например, "2024-01-01" в качестве метки месяца),
// DD.MM.YYYY, YYYYMM без разделителя и русское/английское название месяца
// с годом («Январь 2024», «янв 24», «Jan-2024»). См. _periodFromAny.
const _MONTH_KEY_RE = new RegExp(
  '^(?:'
    + '(?:20\\d{2}|19\\d{2})[\\-./](?:0?[1-9]|1[0-2])(?:[\\-./]\\d{1,2})?'   // YYYY-MM[-DD]
    + '|(?:0?[1-9]|1[0-2])[\\-./](?:20\\d{2}|19\\d{2})'                       // MM.YYYY
    + '|\\d{1,2}[\\-./](?:0?[1-9]|1[0-2])[\\-./](?:20\\d{2}|19\\d{2})'         // DD.MM.YYYY
    + '|(?:20\\d{2}|19\\d{2})(?:0[1-9]|1[0-2])'                                // YYYYMM
    + '|[а-яёa-z]{3,9}[\\s\\-\'.]*(?:20|19)?\\d{2}'                            // "Янв 24"/"Январь 2024"
  + ')$',
  'i',
);

// Русские и английские сокращения месяцев (3–4 первые буквы).
const _MONTH_RU_MAP = {
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6,
  июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};
const _MONTH_EN_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function _periodFromAny(v) {
  if (v == null) return null;
  // Unix-timestamp (сек или мс) — Арсенкин иногда отдаёт метку месяца числом.
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    const yr = d.getUTCFullYear();
    if (yr >= 2000 && yr <= 2099) {
      return `${yr}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }
  const s = String(v).trim().toLowerCase();
  if (!s) return null;

  // 1) YYYY-MM или YYYY-MM-DD (а также / . как разделители).
  let m = s.match(/^(20\d{2}|19\d{2})[-./](0?[1-9]|1[0-2])(?:[-./]\d{1,2})?$/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;

  // 2) MM.YYYY / MM-YYYY / MM/YYYY.
  m = s.match(/^(0?[1-9]|1[0-2])[-./](20\d{2}|19\d{2})$/);
  if (m) return `${m[2]}-${String(+m[1]).padStart(2, '0')}`;

  // 3) DD.MM.YYYY — берём MM/YYYY.
  m = s.match(/^\d{1,2}[-./](0?[1-9]|1[0-2])[-./](20\d{2}|19\d{2})$/);
  if (m) return `${m[2]}-${String(+m[1]).padStart(2, '0')}`;

  // 4) YYYYMM без разделителя.
  m = s.match(/^(20\d{2}|19\d{2})(0[1-9]|1[0-2])$/);
  if (m) return `${m[1]}-${m[2]}`;

  // 5) Русское/английское название месяца + год: «Январь 2024», «янв.24»,
  //    «Jan-2024», «сент 25».
  m = s.match(/^([а-яёa-z]{3,9})[\s\-'.]*((?:20|19)?\d{2})$/i);
  if (m) {
    const monKey = m[1].slice(0, 4);
    let monNum = _MONTH_RU_MAP[monKey.slice(0, 3)] || _MONTH_EN_MAP[monKey.slice(0, 3)];
    if (!monNum) monNum = _MONTH_EN_MAP[monKey];
    if (monNum) {
      let yr = parseInt(m[2], 10);
      if (yr < 100) yr += 2000;
      if (yr >= 2000 && yr <= 2099) {
        return `${yr}-${String(monNum).padStart(2, '0')}`;
      }
    }
  }
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

// Извлекает скаляр-частотность из значения точки. Арсенкин в разных версиях
// API отдавал либо число ({"2024-06":123}), либо вложенный объект
// ({"2024-06-01":{"frequency":123}}) — здесь поддерживаются оба варианта плюс
// синонимы поля: count/value/freq/ws/shows/shows_count.
function _pointValue(v) {
  if (v == null) return NaN;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
    return Number(v);
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return Number(
      v.frequency ?? v.count ?? v.value ?? v.freq
      ?? v.ws ?? v.shows ?? v.shows_count,
    );
  }
  return NaN;
}

function _rowFromHistory(phrase, history, resolveMonth = null) {
  const byPeriod = {};
  if (Array.isArray(history)) {
    // [{month|date|period, count|value|freq|frequency|ws|shows}, ...]
    for (let i = 0; i < history.length; i++) {
      const pt = history[i];
      if (!pt || typeof pt !== 'object') continue;
      const rawKey = pt.month ?? pt.date ?? pt.period;
      let period = _periodFromAny(rawKey);
      if (!period && resolveMonth) {
        const mn = _monthNumFromAny(rawKey);
        if (mn) period = resolveMonth(mn, i);
      }
      const val = Number(
        pt.count ?? pt.value ?? pt.freq ?? pt.frequency
        ?? pt.ws ?? pt.shows ?? pt.shows_count,
      );
      if (period && Number.isFinite(val)) byPeriod[period] = val;
    }
  } else if (history && typeof history === 'object') {
    // {"2024-01": 123, ...} — legacy плоская карта;
    // {"2024-06-01": {"frequency":123}} — актуальный формат Арсенкина
    // (ключ YYYY-MM-DD, значение — объект с полем frequency);
    // {"01": 123, …} — month-only сезонность (type=3).
    for (const [k, v] of Object.entries(history)) {
      let period = _periodFromAny(k);
      if (!period && resolveMonth) {
        const mn = _monthNumFromAny(k);
        if (mn) period = resolveMonth(mn);
      }
      const val = _pointValue(v);
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

/**
 * Параллельно применяет worker(item, index) к items с ограничением concurrency.
 * Гарантирует, что порядок результата совпадает с порядком items (важно для
 * стабильных tasksMeta/rows в collectSeasonality). Первый reject прерывает пул
 * и пробрасывается наружу (совпадает с прежним поведением for/await/throw).
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency — ≥1; клампится в вызывающем коде под лимит API.
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function _mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(items.length, Number(concurrency) || 1));
  const results = new Array(items.length);
  let nextIdx = 0;
  let firstErr = null;
  async function pump() {
    for (;;) {
      const i = nextIdx++;
      if (i >= items.length || firstErr) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        if (!firstErr) firstErr = err;
        return;
      }
    }
  }
  const workers = [];
  for (let k = 0; k < limit; k++) workers.push(pump());
  await Promise.all(workers);
  if (firstErr) throw firstErr;
  return results;
}

async function _runCustomTool({ phrases, regionLr, cfg, toolName }) {
  const data = { queries: phrases, region: regionLr };
  const setResp = await _post(API_SET, { tools_name: toolName, data }, cfg.token);
  const sj = setResp.json || {};
  const taskId = sj.task_id ?? sj.data?.task_id ?? sj.id ?? sj.data?.id;
  if (taskId == null) throw new Error(`Arsenkin API: /set не вернул task_id (ответ: ${JSON.stringify(sj).slice(0, 300)})`);

  const deadline = Date.now() + cfg.timeoutMin * 60 * 1000;
  let curDelay = Math.min(cfg.firstCheckMs, cfg.pollMs);
  for (;;) {
    await _sleep(curDelay);
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
    curDelay = Math.min(cfg.pollMs, Math.ceil(curDelay * 1.6));
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

async function collectCommercialization({ phrases, regionLabel, regionLr = null }) {
  const cfg = _cfg();
  if (!cfg.commToolName) {
    _logSkipOnce('comm_tool', '[Forecaster] ARSENKIN_COMM_TOOL_NAME не задан — коммерциализация пропущена');
    return null;
  }
  if (!cfg.token) return null;
  const list = (Array.isArray(phrases) ? phrases : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  try {
    const res = await _runCustomTool({ phrases: list, regionLr: _pickRegionLr(regionLr, regionLabel), cfg, toolName: cfg.commToolName });
    return _normalizeCommercialization(res);
  } catch (err) {
    console.warn('[Forecaster] Сбор коммерциализации Арсенкин пропущен:', (err && err.message) || String(err));
    return null;
  }
}

async function collectSerpFeatures({ phrases, regionLabel, regionLr = null }) {
  const cfg = _cfg();
  if (!cfg.wizardToolName) {
    _logSkipOnce('wizard_tool', '[Forecaster] ARSENKIN_WIZARD_TOOL_NAME не задан — колдунщики SERP пропущены');
    return null;
  }
  if (!cfg.token) return null;
  const list = (Array.isArray(phrases) ? phrases : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  try {
    const res = await _runCustomTool({ phrases: list, regionLr: _pickRegionLr(regionLr, regionLabel), cfg, toolName: cfg.wizardToolName });
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
async function collectSeasonality({ phrases, regionLabel, regionLr: regionLrIn = null, onProgress = null }) {
  const cfg = _cfg();
  if (!cfg.token) return { verdict: 'skipped', reason: 'no_api_key' };
  const list = (Array.isArray(phrases) ? phrases : [])
    .map((p) => String(p || '').trim()).filter(Boolean);
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_phrases' };

  const regionLr = _pickRegionLr(regionLrIn, regionLabel);
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
    // Батчируем фразы и выполняем задачи параллельно с лимитом cfg.concurrency
    // (по умолчанию 3, клампится в 1..5 под официальный лимит Арсенкина —
    // 5 одновременных задач/пользователь и 30 req/min). Для однобатчевых
    // прогонов ведёт себя как последовательный (лимит=1).
    const batches = [];
    for (let i = 0; i < list.length; i += cfg.batchSize) {
      batches.push(list.slice(i, i + cfg.batchSize));
    }
    const debug = String(process.env.ARSENKIN_DEBUG_SEASONALITY || '').toLowerCase();
    const debugOn = debug === '1' || debug === 'true';
    let doneBatches = 0;
    let donePhrases = 0;
    const perBatch = await _mapWithConcurrency(batches, cfg.concurrency, async (batch) => {
      const res = await _runOneTask({ phrases: batch, regionLr, cfg });
      // Диагностическая печать сырого /get-ответа: включается флагом
      // ARSENKIN_DEBUG_SEASONALITY=1. Нужна, когда Арсенкин меняет формат
      // ключей помесячных данных — иначе причину пустых byPeriod не видно
      // в логах (см. issue «Найдено только 0 помесячных колонок»).
      if (debugOn) {
        console.log(`[Forecaster] Arsenkin /get task_id=${res.taskId} raw:`, _rawSample(res));
      }
      const resolveMonth = res.range
        ? _resolverFromRange(res.range.startdate, res.range.enddate)
        : defaultResolveMonth;
      const rows = _normalizeResult({ ...res, resolveMonth });
      // Прогресс сбора данных: по завершению каждого батча сообщаем
      // сколько фраз уже обработано (для «ползунка» в UI).
      doneBatches += 1;
      donePhrases += batch.length;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            done: donePhrases,
            total: list.length,
            batches_done: doneBatches,
            batches_total: batches.length,
          });
        } catch (_) { /* прогресс не должен ломать сбор */ }
      }
      return { res, rows };
    });
    // Собираем tasksMeta и allRows в исходном порядке батчей — важно для
    // консистентных отчётов (порядок фраз в forecaster_tasks.arsenkin_report).
    for (let k = 0; k < perBatch.length; k++) {
      const { res, rows } = perBatch[k];
      tasksMeta.push({ task_id: res.taskId, phrases_count: batches[k].length });
      lastRawSample = _rawSample(res);
      lastRawJson = res.json ?? null;
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

  // Даже если фразы «сматчились», у них могут быть пустые/полу-пустые byPeriod
  // (неопознанный формат ключей дат). Даунстрим-пайплайн потребует minimum 3
  // помесячных колонок и упадёт с «Найдено только 0 помесячных колонок» без
  // диагностики. Проверяем объединение периодов здесь и возвращаем понятную
  // ошибку с образцом сырого ответа, чтобы можно было расширить парсер дат.
  const periodsUnion = new Set();
  for (const r of allRows) {
    for (const p of Object.keys(r.byPeriod || {})) periodsUnion.add(p);
  }
  if (periodsUnion.size < 3) {
    const hint = lastRawSample ? ` Ответ /get (образец): ${lastRawSample}` : '';
    return {
      verdict: 'error',
      reason: `Арсенкин вернул ${allRows.length} строк(и), но помесячных периодов распознано только `
        + `${periodsUnion.size} (нужно минимум 3). Похоже, поменялся формат ключей дат в ответе — `
        + `проверьте _periodFromAny в arsenkinClient.js и включите ARSENKIN_DEBUG_SEASONALITY=1 для дампа сырого ответа.`
        + hint,
      rows: allRows,
      region_lr: regionLr,
      requested: list.length,
      matched: allRows.length,
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
  _datesFromErrorMessage,
  _snapRangeToFullMonths,
  _periodFromAny,
  _mapWithConcurrency,
  _sanitizeToken,
};
