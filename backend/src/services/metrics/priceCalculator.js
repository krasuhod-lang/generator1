'use strict';

/**
 * Тарифы LLM-провайдеров (апрель 2026).
 * Источник: раздел 10 ТЗ.
 *
 * Gemini-тарифы ЗАХАРДКОЖЕНЫ по продуктовому требованию: «По такому прайсу
 * всегда считаем». Соответствующие env-переменные GEMINI_*_PRICE_USD_PER_1M*
 * больше не читаются — даже если оператор по ошибке выставит их в .env,
 * фактический расчёт стоимости останется детерминированным:
 *   до 200 000 токенов:   $2 / 1M input,  $12 / 1M output
 *   от 200 000 до 1 000 000 токенов: $4 / 1M input, $18 / 1M output
 * (output-rate включает thoughts/reasoning-токены — Gemini 2.5+ тарифицирует
 * их именно как output, см. поле thoughtsTokens в calcCost ниже).
 *
 * DashScope/Qwen — тарифы для международного endpoint
 * (https://dashscope-intl.aliyuncs.com/compatible-mode/v1) на май 2026.
 * Допустимо переопределить через env DASHSCOPE_<MODEL>_INPUT_PRICE_USD_PER_1M /
 * DASHSCOPE_<MODEL>_OUTPUT_PRICE_USD_PER_1M (см. _envDashscopePricePer1M),
 * где <MODEL> — нормализованное имя модели заглавными буквами с подчёркиваниями
 * (qwen3.6-plus → QWEN3_6_PLUS, qwen-max → QWEN_MAX). Это нужно операторам,
 * чтобы корректировать прайс без релиза, когда Alibaba меняет тарифы.
 */

const PRICES = {
  deepseek: {
    input_cache_miss: 0.000000270,  // $0.27 / 1M tokens
    input_cache_hit:  0.000000070,  // $0.07 / 1M tokens
    output:           0.000001100,  // $1.10 / 1M tokens
  },
  gemini: {
    // Контекст до 200 000 токенов — захардкожено, env не учитывается.
    input_short:        0.000002000,  // $2.00 / 1M input
    output_short:       0.000012000,  // $12.00 / 1M output (incl. thoughts)
    cached_input_short: 0.000000500,  // $0.50 / 1M cached input
    // Контекст от 200 000 до 1 000 000 токенов — захардкожено, env не учитывается.
    input_long:         0.000004000,  // $4.00 / 1M input
    output_long:        0.000018000,  // $18.00 / 1M output (incl. thoughts)
    cached_input_long:  0.000001000,  // $1.00 / 1M cached input
  },
  // x.ai Grok pricing (продуктовое требование апрель 2026):
  //   $2.00 / 1M input tokens, $6.00 / 1M output tokens.
  // Подтверждается env XAI_INPUT_PRICE_USD_PER_1M / XAI_OUTPUT_PRICE_USD_PER_1M
  // — переопределить при изменении тарифа без правки кода.
  grok: {
    input:  0.000002000,
    output: 0.000006000,
  },
  // DashScope (Alibaba Model Studio, intl region).
  // Используется вкладкой «Сформировать JSON» (см. dashscope.adapter.js).
  // По модели вычисляется тариф через _resolveDashscopeRate(model).
  // Дефолт (`default`) применяется, если модель неизвестна — этого достаточно,
  // чтобы стоимость никогда не считалась как 0, даже если оператор задал
  // экзотическую модель в DASHSCOPE_MODEL.
  dashscope: {
    // qwen3.6-plus / qwen-plus — основная рабочая модель (default JSON tab).
    'qwen-plus':       { input: 0.000000400, output: 0.000001200 }, // $0.40 / $1.20 / 1M
    'qwen3.6-plus':    { input: 0.000000400, output: 0.000001200 },
    // qwen-max — премиум-модель.
    'qwen-max':        { input: 0.000001600, output: 0.000006400 }, // $1.60 / $6.40 / 1M
    // qwen-turbo — дешёвая.
    'qwen-turbo':      { input: 0.000000050, output: 0.000000200 }, // $0.05 / $0.20 / 1M
    // qwen-long — для очень длинного контекста.
    'qwen-long':       { input: 0.000000500, output: 0.000002000 }, // $0.50 / $2.00 / 1M
    // Универсальный fallback — равен qwen-plus, чтобы не занижать.
    'default':         { input: 0.000000400, output: 0.000001200 },
  },
};

/** Множество уже залогированных «model unknown» — чтобы не спамить лог. */
const _dashscopeUnknownModelLogged = new Set();

/**
 * Нормализует имя модели DashScope в имя env-переменной:
 *   qwen3.6-plus → QWEN3_6_PLUS
 *   qwen-max     → QWEN_MAX
 *
 * Реализация — императивный проход по символам без regex-цепочек, чтобы
 * исключить полиномиальный ReDoS (CodeQL js/polynomial-redos): даже
 * патологическая строка из тысяч символов «-» / «.» обрабатывается за
 * O(n) без backtracking. Длина результата дополнительно ограничена,
 * чтобы env-ключ оставался разумного размера.
 */
function _dashscopeEnvKey(model) {
  const src = String(model || '').trim().toUpperCase();
  if (!src) return '';
  let out = '';
  let prevUnderscore = true; // подавляем ведущие «_»
  for (let i = 0; i < src.length && out.length < 64; i++) {
    const ch = src.charCodeAt(i);
    const isAlnum = (ch >= 65 && ch <= 90) || (ch >= 48 && ch <= 57); // A-Z, 0-9
    if (isAlnum) {
      out += src[i];
      prevUnderscore = false;
    } else if (!prevUnderscore) {
      out += '_';
      prevUnderscore = true;
    }
  }
  // Убрать висячий подчёркивание справа, не вызывая regex.
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 95 /* '_' */) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Возвращает rate (USD/токен) с учётом env-override.
 * env-формат — DASHSCOPE_<KEY>_INPUT_PRICE_USD_PER_1M / _OUTPUT_..., в долларах за 1M токенов.
 */
function _envDashscopePricePer1M(model, kind /* 'INPUT'|'OUTPUT' */) {
  const k = _dashscopeEnvKey(model);
  if (!k) return null;
  const raw = process.env[`DASHSCOPE_${k}_${kind}_PRICE_USD_PER_1M`];
  const n = parseFloat(raw);
  if (Number.isFinite(n) && n > 0) return n / 1_000_000;
  return null;
}

/**
 * Резолвит { input, output } per-token rate для DashScope-модели.
 * Алгоритм: env-override (DASHSCOPE_<KEY>_*_PRICE_USD_PER_1M) → таблица PRICES.dashscope[model] → 'default'.
 * Если модель неизвестна — пишет один warn в stdout и возвращает default-тариф.
 */
function _resolveDashscopeRate(model) {
  const norm = String(model || '').trim().toLowerCase();
  const table = PRICES.dashscope[norm] || null;
  if (!table) {
    if (norm && !_dashscopeUnknownModelLogged.has(norm)) {
      _dashscopeUnknownModelLogged.add(norm);
      // Один warn на процесс на модель — оператор увидит и сможет задать env-override.
      console.warn(
        `[priceCalculator] DashScope: неизвестная модель "${norm}", применяю default-тариф ` +
        `($${PRICES.dashscope.default.input * 1e6}/$${PRICES.dashscope.default.output * 1e6} / 1M). ` +
        `Чтобы задать точный тариф — DASHSCOPE_${_dashscopeEnvKey(norm)}_INPUT_PRICE_USD_PER_1M / ` +
        `DASHSCOPE_${_dashscopeEnvKey(norm)}_OUTPUT_PRICE_USD_PER_1M в .env.`
      );
    }
  }
  const fallback = PRICES.dashscope.default;
  const base = table || fallback;
  const envIn  = _envDashscopePricePer1M(norm, 'INPUT');
  const envOut = _envDashscopePricePer1M(norm, 'OUTPUT');
  return {
    input:  Number.isFinite(envIn)  && envIn  > 0 ? envIn  : base.input,
    output: Number.isFinite(envOut) && envOut > 0 ? envOut : base.output,
  };
}

/** Порог контекста Gemini: до 200 000 токенов — короткий тариф */
const GEMINI_SHORT_CONTEXT_LIMIT = 200_000;

/**
 * Оценивает количество токенов в тексте на основе правил токенизации:
 *   1 токен ≈ 4 символа (латиница, кириллица, пробелы, спецсимволы).
 *   Цифры: 1–3 цифры на токен (год 2026 ≈ 1 токен).
 *   Пробелы, табуляция, знаки препинания — считаются.
 *
 * @param {string} text — входной текст (промпт, ответ)
 * @returns {number} — приблизительное количество токенов
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Рассчитывает стоимость вызова LLM в USD.
 *
 * @param {'deepseek'|'gemini'|'grok'|'dashscope'} model
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {boolean|object} [cacheHitOrUsage=false]
 *   - boolean (legacy): для DeepSeek признак cache_hit (подразумевает, что ВСЕ
 *     input-токены были в кеше — грубая оценка, оставлено для BC).
 *   - object  (новый формат): {
 *       cacheHit?:       boolean,  // legacy DeepSeek (если cachedTokens не задан)
 *       thoughtsTokens?: number,   // Gemini reasoning, тарифицируется как output
 *       cachedTokens?:   number,   // часть tokensIn, дисконтированная по cached-input rate.
 *                                  // Gemini: usage.cachedContentTokenCount.
 *                                  // DeepSeek: usage.prompt_cache_hit_tokens.
 *       contextTokens?:  number,   // полный размер контекста (multi-turn cache).
 *                                  // Gemini long/short tier: max(tokensIn, contextTokens) > 200k → long.
 *       model?:          string,   // обязательно для DashScope (qwen3.6-plus, qwen-max и т.п.)
 *     }
 * @returns {number} — стоимость в USD
 */
function calcCost(model, tokensIn, tokensOut, cacheHitOrUsage = false) {
  // Backward-compat: вызов calcCost(model, in, out, true|false) трактуем как cacheHit.
  const usage = (cacheHitOrUsage && typeof cacheHitOrUsage === 'object')
    ? cacheHitOrUsage
    : { cacheHit: !!cacheHitOrUsage };

  const cacheHit       = !!usage.cacheHit;
  const thoughtsTokens = Math.max(0, Number(usage.thoughtsTokens) || 0);
  const cachedTokens   = Math.max(0, Number(usage.cachedTokens)   || 0);
  const contextTokens  = Math.max(0, Number(usage.contextTokens)  || 0);

  if (model === 'deepseek') {
    // Mixed-cache: если usage.cachedTokens передан, считаем раздельно
    // (точная формула, соответствует биллингу DeepSeek).
    // Иначе — legacy boolean cacheHit (всё-или-ничего).
    if (cachedTokens > 0) {
      const cached = Math.min(cachedTokens, tokensIn);
      const miss   = tokensIn - cached;
      return cached * PRICES.deepseek.input_cache_hit
           + miss   * PRICES.deepseek.input_cache_miss
           + tokensOut * PRICES.deepseek.output;
    }
    const inputRate = cacheHit
      ? PRICES.deepseek.input_cache_hit
      : PRICES.deepseek.input_cache_miss;
    return tokensIn * inputRate + tokensOut * PRICES.deepseek.output;
  }

  if (model === 'gemini') {
    // Long/short tier выбираем по полному размеру контекста (включая cached-prefix
    // при multi-turn кеша); если contextTokens не передан — по tokensIn (BC).
    const tierTokens   = Math.max(tokensIn, contextTokens);
    const isLong       = tierTokens > GEMINI_SHORT_CONTEXT_LIMIT;
    const inputRate       = isLong ? PRICES.gemini.input_long         : PRICES.gemini.input_short;
    const outputRate      = isLong ? PRICES.gemini.output_long        : PRICES.gemini.output_short;
    const cachedInputRate = isLong ? PRICES.gemini.cached_input_long  : PRICES.gemini.cached_input_short;

    // cachedTokens — это ЧАСТЬ promptTokenCount (Google API), считаем дисконт
    // только на cachedTokens, остальное (tokensIn − cachedTokens) — по обычному input rate.
    const cached    = Math.min(cachedTokens, tokensIn);
    const inputCost = (tokensIn - cached) * inputRate + cached * cachedInputRate;

    // thoughtsTokens (thinking-models) — отдельное поле, НЕ входит в candidatesTokenCount.
    // Тарифицируется как output. Если нули — формула совпадает со старой.
    const outputCost = (tokensOut + thoughtsTokens) * outputRate;
    return inputCost + outputCost;
  }

  if (model === 'grok') {
    // Env-override: позволяет менять тариф без правки кода (x.ai периодически
    // меняет цены, особенно для новых моделей вроде grok-code-fast-1).
    const inputRate  = parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M)  > 0
      ? parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M)  / 1_000_000
      : PRICES.grok.input;
    const outputRate = parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M) > 0
      ? parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M) / 1_000_000
      : PRICES.grok.output;
    return tokensIn * inputRate + tokensOut * outputRate;
  }

  if (model === 'dashscope') {
    // Имя конкретной модели передаётся через usage.model.
    // Если оператор не передал — берём 'default' (qwen-plus тариф), чтобы
    // стоимость никогда не считалась как 0.
    const dsModel = (typeof usage.model === 'string' && usage.model.trim())
      ? usage.model.trim()
      : 'default';
    const rate = _resolveDashscopeRate(dsModel);
    return tokensIn * rate.input + tokensOut * rate.output;
  }

  return 0;
}

/**
 * Форматирует стоимость для отображения (напр. "$0.0142").
 */
function formatCost(usd) {
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

module.exports = {
  calcCost, formatCost, estimateTokens,
  PRICES, GEMINI_SHORT_CONTEXT_LIMIT,
  // Экспортируем для тестов и потребителей, желающих заранее узнать тариф
  // (например, dashscope.adapter, чтобы вернуть cost_usd в ответе API).
  _resolveDashscopeRate,
};
