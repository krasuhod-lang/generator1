'use strict';

/**
 * forecaster/arsenkinClient.js — HTTP-клиент API «ARSENKIN TOOLS».
 *
 * Назначение: по списку ключевых запросов собрать СЕЗОННОСТЬ — помесячную
 * частотность Яндекс.Вордстат за последние 12 месяцев по каждой фразе.
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
 *         device:    "",               — desktop/mobile/phone/tablet; ""=все
 *         group:     "month",          — группировка month/week/day
 *         startdate: "2024-06-01",     — начальная дата (YYYY-MM-DD)
 *         enddate:   "2025-05-31",     — конечная дата (YYYY-MM-DD)
 *       }
 *     Важно: статистика «по месяцам» доступна только для ПОЛНЫХ календарных
 *     месяцев (минимум 3); «по неделям» — полные недели (пн–вс, минимум 3);
 *     «по дням» — только последние 60 дней без текущего.
 *   • Проверка статуса:        POST https://arsenkin.ru/api/tools/check
 *       body: { task_id }   → { data: { status_id } }  (1 = в работе, 2 = готово)
 *   • Получение результата:    POST https://arsenkin.ru/api/tools/get
 *       body: { task_id }   → JSON либо CSV-строка (зависит от инструмента)
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
 *   ARSENKIN_WORDSTAT_DEVICE    — устройство: desktop/mobile/phone/tablet,
 *                                 пустая строка = все устройства (default).
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

// ── диапазон дат для сезонности ────────────────────────────────────
// Статистика «по месяцам» доступна только для ПОЛНЫХ календарных месяцев,
// поэтому окно: с 1-го числа месяца (12 месяцев назад) по последний день
// предыдущего месяца — ровно 12 полных месяцев для годового цикла.
// «По неделям» — полные недели пн–вс; «по дням» — максимум 60 дней
// без учёта текущего дня.
function seasonalityDateRange(group = 'month', now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (group === 'day') {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60);
    return { startdate: iso(start), enddate: iso(end) };
  }
  if (group === 'week') {
    // последнее полное воскресенье и понедельник 52 недели назад
    const dow = (now.getDay() + 6) % 7; // 0 = понедельник
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 1);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 52 * 7 + 1);
    return { startdate: iso(start), enddate: iso(end) };
  }
  // month (default): последние 12 полных календарных месяцев
  const end = new Date(now.getFullYear(), now.getMonth(), 0);            // последний день прошлого месяца
  const start = new Date(now.getFullYear(), now.getMonth() - 12, 1);     // 1-е число 12 месяцев назад
  return { startdate: iso(start), enddate: iso(end) };
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
async function _runOneTask({ phrases, regionLr, cfg }) {
  // Формат по официальной документации «Проверка сезонности запросов»:
  // type=3, region — ЧИСЛО lr Яндекса (не массив), device/group/даты обязательны.
  const { startdate, enddate } = seasonalityDateRange(cfg.group);
  const data = {
    type:      cfg.wordstatType,
    queries:   phrases,
    device:    cfg.device,
    region:    regionLr,
    group:     cfg.group,
    startdate,
    enddate,
    ...cfg.extra,
  };
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
  return { taskId, json: got.json, text: got.text };
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

function _rowFromHistory(phrase, history) {
  const byPeriod = {};
  if (Array.isArray(history)) {
    // [{month|date|period, count|value|freq|ws}, ...]
    for (const pt of history) {
      if (!pt || typeof pt !== 'object') continue;
      const period = _periodFromAny(pt.month ?? pt.date ?? pt.period);
      const val = Number(pt.count ?? pt.value ?? pt.freq ?? pt.ws ?? pt.shows);
      if (period && Number.isFinite(val)) byPeriod[period] = val;
    }
  } else if (history && typeof history === 'object') {
    // {"2024-01": 123, ...}
    for (const [k, v] of Object.entries(history)) {
      const period = _periodFromAny(k);
      const val = Number(v);
      if (period && Number.isFinite(val)) byPeriod[period] = val;
    }
  }
  const total = Object.values(byPeriod).reduce((a, b) => a + b, 0);
  return { phrase, total, byPeriod };
}

/**
 * Пытается вытащить rows из произвольного JSON-ответа /get.
 * Поддерживаются типовые формы:
 *   • { data: [ {phrase|query|keyword, history|months|dynamics|seasonality: …} ] }
 *   • { data: { "<фраза>": {"2024-01": n, …} | [ {month,count} ] } }
 *   • CSV-строка (фраза + помесячные колонки) — через parseForecasterInput.
 */
function _normalizeResult({ json, text }) {
  const payload = json && typeof json === 'object'
    ? (json.data ?? json.result ?? json.results ?? json)
    : null;

  const rows = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      const phrase = String(item.phrase ?? item.query ?? item.keyword ?? item.word ?? '').trim();
      if (!phrase) continue;
      const hist = item.history ?? item.months ?? item.dynamics ?? item.seasonality ?? item.data;
      if (hist != null) {
        rows.push(_rowFromHistory(phrase, hist));
      } else {
        // возможно, помесячные значения лежат прямо в полях item ("2024-01": n)
        const flat = {};
        for (const [k, v] of Object.entries(item)) {
          if (_MONTH_KEY_RE.test(String(k).trim())) flat[k] = v;
        }
        if (Object.keys(flat).length > 0) rows.push(_rowFromHistory(phrase, flat));
      }
    }
  } else if (payload && typeof payload === 'object') {
    for (const [key, val] of Object.entries(payload)) {
      const phrase = String(key).trim();
      if (!phrase || val == null) continue;
      if (typeof val === 'object') {
        const r = _rowFromHistory(phrase, val.history ?? val.months ?? val.dynamics ?? val);
        if (Object.keys(r.byPeriod).length > 0) rows.push(r);
      }
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

/**
 * Главный API: собрать сезонность (помесячная частотность за последний год)
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
  const t0 = Date.now();
  const allRows = [];
  const tasksMeta = [];

  try {
    // Батчим и выполняем ПОСЛЕДОВАТЕЛЬНО: лимит Арсенкина — 5 одновременных
    // задач на пользователя и 30 запросов/мин; параллельные батчи легко
    // выбивают 429 и место в очереди других инструментов.
    for (let i = 0; i < list.length; i += cfg.batchSize) {
      const batch = list.slice(i, i + cfg.batchSize);
      const res = await _runOneTask({ phrases: batch, regionLr, cfg });
      tasksMeta.push({ task_id: res.taskId, phrases_count: batch.length });
      const rows = _normalizeResult(res);
      allRows.push(...rows);
    }
  } catch (err) {
    return {
      verdict: 'error',
      reason: (err && err.message) || String(err),
      rows: allRows,
      region_lr: regionLr,
      requested: list.length,
      matched: allRows.length,
      tasks: tasksMeta,
      duration_ms: Date.now() - t0,
    };
  }

  if (allRows.length === 0) {
    return {
      verdict: 'error',
      reason: 'Арсенкин вернул пустой результат (проверьте ARSENKIN_TOOL_NAME/ARSENKIN_WORDSTAT_TYPE и лимиты аккаунта)',
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

module.exports = {
  collectSeasonality,
  resolveRegionLr,
  seasonalityDateRange,
  // internals для тестов
  _normalizeResult,
  _rowFromHistory,
};
