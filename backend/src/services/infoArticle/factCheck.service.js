'use strict';

/**
 * factCheck.service — Phase 1 / P0-1 deterministic fact-check verifier.
 *
 * Назначение: после того как writer сгенерировал финальную articleHtml,
 * прогоняем её через детерминированный экстрактор «фактологических
 * утверждений» и сверяем каждое с собранными ранее SERP-evidence-сниппетами.
 * Цель — поймать «галлюцинированные» цифры/проценты/годы/цены, которых нет
 * ни в одном источнике из топа выдачи.
 *
 * Контракт без LLM:
 *   • быстро (<200ms на статью среднего объёма),
 *   • воспроизводимо (тот же html → тот же отчёт),
 *   • без скрытых вызовов сети.
 *
 * Подход:
 *   1. extractClaims(html) — strip-tags → split on sentences → keep
 *      ТОЛЬКО предложения с «claim-сигналами»:
 *        — числа (целые/десятичные, в т.ч. с разделителем 1 200, 1.2K, 3,5),
 *        — проценты (50%, 50 %, 50 процентов),
 *        — годы (1990..2100),
 *        — цены/валюта (₽, руб, $, €),
 *        — единицы измерения (кг, г, мг, м, см, мм, км, л, мл, кВт, Вт, °C,
 *          градусов, шт, упаковок и т.п.).
 *      Дедуп по нормализованной форме предложения.
 *
 *   2. verifyClaims(claims, evidenceResult) — для каждого утверждения
 *      достаём «фактологический отпечаток»: набор числовых токенов
 *      (числа+единицы+проценты+годы). Утверждение считается:
 *        • supported — все числовые токены из claim'а встречаются
 *          в одном и том же evidence-сниппете;
 *        • partial   — найдены отдельные токены в разных сниппетах
 *          (не один источник подтверждает целиком);
 *        • unsupported — ни один токен claim'а не найден ни в одном
 *          сниппете.
 *      В отчёте — supportedBy: [{url, snippetIndex, matchedTokens}].
 *
 *   3. summarizeFactCheck(results) — агрегаты + verdict.
 *
 * Не делает:
 *   • не модифицирует articleHtml (только отчёт);
 *   • не вызывает LLM;
 *   • не делает сетевых запросов (evidence уже в памяти).
 */

// ── Параметры (env-overridable) ────────────────────────────────────

const MIN_CLAIM_CHARS = 30;       // короче — обычно подпись/lead, не факт
const MAX_CLAIM_CHARS = 600;      // длиннее — режем (или скипаем) — это абзац
const MAX_CLAIMS = 200;           // защита: статья не должна выдавать тысячи
const MAX_CLAIMS_PER_SECTION = 50;

// «Сильные» сигналы — наличие хотя бы одного делает предложение претендентом
// в claim'ы. Не путать с «токенами для верификации» — те уже извлекаются ниже.

// Числовой токен: целые/десятичные с возможным неразрывным/обычным
// пробелом-разделителем тысяч. Примеры: 12, 12.5, 12,5, 1 200, 1\u00a0200,
// 3.14, 0.5. НЕ матчит одиночное «1» в составе слова (граница \b).
const NUMBER_RE = /(?<![\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?(?![\d.,])|(?<![\d.,\w])\d+(?:[.,]\d+)?(?![\d.,\w])/g;

// Год: 1900..2099 как самостоятельное число.
const YEAR_RE = /(?<![\d])(19[0-9]{2}|20[0-9]{2})(?![\d])/g;

// Процент: число + %, или «N процентов/процент». Захватываем число.
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*(?:%|процент(?:ов|а|)?)/gi;

// Валюта (только числовая часть). Поддерживаем ₽/руб/RUB/$/USD/€/EUR/¥.
// Две формы: "число + знак" (русский: 1500 руб) и "знак + число" (англ: $99).
// `\b` не используем — он ASCII-only и не работает после кириллических букв
// («руб» бы не отделилось от «рубероид»). Вместо этого — отрицательный
// look-ahead на следующую букву.
const CURRENCY_AFTER_RE  = /(\d+(?:[.,\s\u00a0]\d{3})*(?:[.,]\d+)?)\s*(₽|руб(?:\.|лей|ля|ль)?|rub|\$|usd|€|eur|¥|cny)(?![\wа-яёА-ЯЁ])/gi;
const CURRENCY_BEFORE_RE = /(?<![\wа-яёА-ЯЁ])(₽|\$|€|¥|usd|eur|cny|rub)\s*(\d+(?:[.,\s\u00a0]\d{3})*(?:[.,]\d+)?)/gi;

// Единицы измерения (рус + lat). Захватываем число + единицу.
const UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(?:кг|г\b|мг|т\b|м\b|см|мм|км|га|л\b|мл|шт|штук|упаковок|кв\.?\s?м|куб\.?\s?м|м[2³2]|м³|м²|кВт|МВт|Вт\b|кВ|В\b|А\b|°C|°F|градус(?:ов|а)?|сек|мин|час(?:ов|а)?|дн(?:ей|я)|лет\b|год(?:а|ов)?)/gi;

// Сильные claim-сигналы — для отбора предложений-кандидатов.
const CLAIM_SIGNAL_RE = new RegExp(
  [
    '\\d+(?:[.,]\\d+)?\\s*(?:%|процент)',                    // процент
    '(?<![\\d])(?:19[0-9]{2}|20[0-9]{2})(?![\\d])',          // год
    '\\d+(?:[.,]\\d+)?\\s*(?:₽|руб|rub|\\$|usd|€|eur)',      // валюта (число + знак)
    '(?:₽|\\$|€|usd|eur|rub)\\s*\\d+',                       // валюта (знак + число)
    '\\d+(?:[.,]\\d+)?\\s*(?:кг|г\\b|мг|т\\b|м\\b|см|мм|км|га|л\\b|мл|шт|кВт|Вт|°C|градус|сек|мин|час|дн|лет|год)',  // единицы
  ].join('|'),
  'i',
);

// ── HTML → plain ───────────────────────────────────────────────────

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  // Удаляем code/pre/script/style целиком (числа в коде — не факты).
  // Допускаем пробелы внутри закрывающего тега (</script  > и т.п.) —
  // иначе CodeQL js/bad-tag-filter справедливо ругается на пропуск
  // edge-case'а, через который контент может «утечь» в plain text.
  let s = html.replace(/<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // Заголовки и блоки — заменяем на разделитель, чтобы не склеивать
  // соседние предложения в одно гигантское.
  s = s.replace(/<\/(?:h[1-6]|p|li|div|section|article|header|footer|td|th|tr|table|ul|ol|blockquote|figcaption|caption)\s*>/gi, '. ');
  s = s.replace(/<br\s*\/?>/gi, '. ');
  // Тег → пробел (не пустая строка), чтобы не склеить «word</a>word».
  s = s.replace(/<[^>]+>/g, ' ');
  // Раскрываем основные HTML-сущности; полное декодирование оставляем за
  // потребителем — нам важно только, чтобы &amp;/&nbsp;/&laquo;/&raquo;
  // не ломали разбиение на предложения.
  // ВАЖНО: &amp; декодируем В ПОСЛЕДНЮЮ ОЧЕРЕДЬ — иначе входная строка
  // вида "&amp;lt;" сначала превратится в "&lt;", а потом в "<" (двойное
  // декодирование, см. CodeQL js/double-escaping).
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&');
  // Свёртка пробелов.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ── Предложения ────────────────────────────────────────────────────
//
// Жадный split по концу предложения. Уважаем сокращения (см. рус. и англ.)
// чтобы «г.», «руб.», «т. н.», «т. е.» не дробили предложение.

const ABBREV = new Set([
  'г', 'гг', 'т', 'тыс', 'млн', 'млрд', 'руб', 'долл', 'евро', 'кг', 'м',
  'см', 'мм', 'км', 'кв', 'куб', 'ст', 'стр', 'др', 'пр', 'им', 'напр',
  'см', 'mr', 'mrs', 'dr', 'st', 'inc', 'ltd', 'co',
]);

function splitSentences(text) {
  if (!text) return [];
  const parts = text.split(/([.!?…]+)\s+/);
  const out = [];
  let buf = '';
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (i % 2 === 0) {
      buf += seg;
    } else {
      // seg = punctuation. Проверяем, не сокращение ли последнее слово в buf.
      const lastWord = (buf.match(/(\S+)$/) || ['', ''])[1].toLowerCase().replace(/[^a-zа-яё]/gi, '');
      if (ABBREV.has(lastWord) && seg === '.') {
        buf += seg + ' ';        // склеиваем дальше
      } else {
        buf += seg;
        const candidate = buf.trim();
        if (candidate) out.push(candidate);
        buf = '';
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ── Claim extraction ───────────────────────────────────────────────

function _normalizeForDedup(s) {
  return s.toLowerCase().replace(/[^a-zа-яё0-9%]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * extractClaims(html) → [{ id, text, kinds, tokens }]
 *   kinds   — массив сигналов: 'percent'|'year'|'currency'|'unit'|'number'
 *   tokens  — нормализованные числовые токены для последующей верификации
 */
function extractClaims(html) {
  const plain = stripHtml(html);
  const sentences = splitSentences(plain);
  const seen = new Set();
  const claims = [];
  for (const raw of sentences) {
    if (claims.length >= MAX_CLAIMS) break;
    const sentence = raw.trim();
    if (sentence.length < MIN_CLAIM_CHARS) continue;
    if (sentence.length > MAX_CLAIM_CHARS) continue;
    if (!CLAIM_SIGNAL_RE.test(sentence)) continue;
    const norm = _normalizeForDedup(sentence);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const tokens = extractFactTokens(sentence);
    if (!tokens.length) continue;   // сигнал был, но токенов 0 — артефакт
    const kinds = [];
    if (tokens.some((t) => t.kind === 'percent'))  kinds.push('percent');
    if (tokens.some((t) => t.kind === 'year'))     kinds.push('year');
    if (tokens.some((t) => t.kind === 'currency')) kinds.push('currency');
    if (tokens.some((t) => t.kind === 'unit'))     kinds.push('unit');
    if (tokens.some((t) => t.kind === 'number'))   kinds.push('number');
    claims.push({
      id: claims.length + 1,
      text: sentence,
      kinds,
      tokens,
    });
  }
  // Цикл уже сам выходит при достижении MAX_CLAIMS — отдельный slice
  // не нужен. Оставляем массив как есть.
  return claims;
}

// ── Token extraction & normalization ───────────────────────────────

function _normNum(raw) {
  if (raw == null) return null;
  // Удаляем разделители тысяч (пробел / NBSP), нормализуем десятичный
  // разделитель к точке.
  const s = String(raw).replace(/[\s\u00a0]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * extractFactTokens(sentence) → [{ kind, value, raw }]
 * Порядок добавления: percent → year → currency → unit → number (бескатегорный).
 * Дедуп по (kind|value), чтобы «50%» в предложении дважды не считалось как 2 токена.
 */
function extractFactTokens(sentence) {
  if (!sentence) return [];
  const out = [];
  const seen = new Set();
  function push(kind, value, raw) {
    if (value == null) return;
    const key = kind + '|' + value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value, raw });
  }

  // percent (приоритет над «обычным числом»)
  for (const m of sentence.matchAll(PERCENT_RE)) push('percent', _normNum(m[1]), m[0]);
  // year
  for (const m of sentence.matchAll(YEAR_RE))    push('year',    _normNum(m[1]), m[0]);
  // currency
  for (const m of sentence.matchAll(CURRENCY_AFTER_RE))  push('currency', _normNum(m[1]), m[0]);
  for (const m of sentence.matchAll(CURRENCY_BEFORE_RE)) push('currency', _normNum(m[2]), m[0]);
  // unit
  for (const m of sentence.matchAll(UNIT_RE))    push('unit', _normNum(m[1]), m[0]);

  // Голые числа — добавляем ТОЛЬКО если они не «потреблены» предыдущими
  // более специфичными категориями. Простой эвристический фильтр:
  // не считаем как «number» те же значения, что уже взяты в percent/year/etc.
  for (const m of sentence.matchAll(NUMBER_RE)) {
    const v = _normNum(m[0]);
    if (v == null) continue;
    // Игнорируем мелкие числа (1..2) — почти никогда не «факты», часто
    // просто перечисление пунктов.
    if (v < 3) continue;
    // Если уже есть тот же value в percent/year/currency/unit — пропускаем.
    const dup =
      seen.has('percent|' + v)
      || seen.has('year|' + v)
      || seen.has('currency|' + v)
      || seen.has('unit|' + v);
    if (dup) continue;
    push('number', v, m[0]);
  }

  return out;
}

// ── Verification ───────────────────────────────────────────────────

function _tokensInText(text) {
  // Извлекаем те же категории из текста сниппета и возвращаем Set значений
  // вида "kind|value". Это и есть «индекс» сниппета.
  const idx = new Set();
  if (!text) return idx;
  const t = String(text);
  for (const m of t.matchAll(PERCENT_RE))  { const v = _normNum(m[1]); if (v != null) idx.add('percent|' + v); }
  for (const m of t.matchAll(YEAR_RE))     { const v = _normNum(m[1]); if (v != null) idx.add('year|' + v); }
  for (const m of t.matchAll(CURRENCY_AFTER_RE))  { const v = _normNum(m[1]); if (v != null) idx.add('currency|' + v); }
  for (const m of t.matchAll(CURRENCY_BEFORE_RE)) { const v = _normNum(m[2]); if (v != null) idx.add('currency|' + v); }
  for (const m of t.matchAll(UNIT_RE))     { const v = _normNum(m[1]); if (v != null) idx.add('unit|' + v); }
  for (const m of t.matchAll(NUMBER_RE)) {
    const v = _normNum(m[0]);
    if (v == null) continue;
    if (v < 3) continue;
    idx.add('number|' + v);
  }
  return idx;
}

/**
 * Кросс-категорийный матч: токен claim'а считается покрытым сниппетом,
 * если value совпадает в любой категории. Пример: claim говорит «10%»,
 * сниппет — «10 процентов» → percent|10 ↔ percent|10 (точное совпадение).
 * Но если сниппет говорит «10 кг», а claim — «10%», совпадения нет —
 * категории разные. Это намеренно строго: цель fact-check — не «угадывать»,
 * а отсеивать выдуманные числа.
 *
 * Исключение: 'number' (без категории) подтверждается ЛЮБОЙ категорией с
 * тем же value — это типичный случай когда автор не указал единицу:
 * «достигает 50 единиц» vs evidence «50 кг».
 */
function _matchToken(token, snippetIdx) {
  if (!token || token.value == null) return false;
  const exact = token.kind + '|' + token.value;
  if (snippetIdx.has(exact)) return true;
  if (token.kind === 'number') {
    // Любая категория с тем же value подтверждает голое число.
    for (const k of ['percent', 'year', 'currency', 'unit']) {
      if (snippetIdx.has(k + '|' + token.value)) return true;
    }
  }
  return false;
}

/**
 * verifyClaims(claims, evidenceResult, opts?) → [{
 *   id, text, kinds, tokens,
 *   status: 'supported'|'partial'|'unsupported',
 *   supportedBy: [{ url, h1, snippetIndex, matchedTokens: [{kind,value}] }],
 *   matchedTokenCount, totalTokenCount
 * }]
 *
 * Один сниппет покрывает claim полностью, если поддерживает ВСЕ его
 * фактологические токены. Если ни один сниппет не покрывает целиком, но
 * хотя бы один токен найден где-то — partial. Иначе unsupported.
 */
function verifyClaims(claims, evidenceResult, opts = {}) {
  const out = [];
  const evItems = (evidenceResult && Array.isArray(evidenceResult.evidence))
    ? evidenceResult.evidence : [];

  // Заранее индексируем все сниппеты — O(N_snip) per pipeline, не per claim.
  const snippetIndex = [];   // [{url, h1, sIdx, idx}]
  for (const it of evItems) {
    const url = it.url || '';
    const h1  = it.h1  || '';
    const snippets = Array.isArray(it.snippets) ? it.snippets : [];
    for (let i = 0; i < snippets.length; i += 1) {
      snippetIndex.push({
        url, h1, sIdx: i,
        idx: _tokensInText(snippets[i].text || ''),
      });
    }
  }

  const maxSourcesPerClaim = Math.max(1, opts.maxSourcesPerClaim || 3);

  for (const claim of (claims || [])) {
    const tokens = Array.isArray(claim.tokens) ? claim.tokens : [];
    const totalTok = tokens.length;
    const supportedBy = [];
    let bestMatch = 0;

    for (const snip of snippetIndex) {
      const matched = [];
      for (const t of tokens) {
        if (_matchToken(t, snip.idx)) matched.push({ kind: t.kind, value: t.value });
      }
      if (matched.length === 0) continue;
      if (matched.length > bestMatch) bestMatch = matched.length;
      // Сниппет считается «источником-подтверждением», только если покрывает
      // ≥1 токен. supported-статус зависит от bestMatch.
      supportedBy.push({
        url: snip.url, h1: snip.h1, snippetIndex: snip.sIdx,
        matchedTokens: matched,
      });
      if (supportedBy.length >= maxSourcesPerClaim * 4) break;  // защита по объёму
    }

    // Сортируем источники по числу совпавших токенов (сильнее → раньше),
    // обрезаем до maxSourcesPerClaim.
    supportedBy.sort((a, b) => b.matchedTokens.length - a.matchedTokens.length);
    const top = supportedBy.slice(0, maxSourcesPerClaim);

    let status = 'unsupported';
    if (totalTok > 0 && bestMatch >= totalTok) status = 'supported';
    else if (bestMatch > 0) status = 'partial';

    out.push({
      id: claim.id,
      text: claim.text,
      kinds: claim.kinds,
      tokens: claim.tokens,
      status,
      supportedBy: top,
      matchedTokenCount: bestMatch,
      totalTokenCount: totalTok,
    });
  }
  return out;
}

// ── Summary / verdict ─────────────────────────────────────────────

/**
 * summarizeFactCheck(results) → { total, supported, partial, unsupported,
 *                                  supportedPct, verdict, byKind }
 *
 * verdict:
 *   'pass'    — supportedPct ≥ PASS_THRESHOLD И unsupported ≤ MAX_UNSUPPORTED
 *   'review'  — supportedPct ≥ REVIEW_THRESHOLD
 *   'fail'    — иначе
 */
const PASS_THRESHOLD   = 0.70;
const REVIEW_THRESHOLD = 0.40;
const MAX_UNSUPPORTED_FOR_PASS = 5;

function summarizeFactCheck(results) {
  const total = results.length;
  let supported = 0, partial = 0, unsupported = 0;
  const byKind = { percent: 0, year: 0, currency: 0, unit: 0, number: 0 };
  for (const r of results) {
    if (r.status === 'supported') supported += 1;
    else if (r.status === 'partial') partial += 1;
    else unsupported += 1;
    for (const k of (r.kinds || [])) {
      if (byKind[k] != null) byKind[k] += 1;
    }
  }
  const supportedPct = total === 0 ? 0 : Math.round((supported / total) * 1000) / 10;

  let verdict = 'fail';
  if (total === 0) {
    verdict = 'na';   // нет фактологических утверждений = нечего проверять
  } else if (supported / total >= PASS_THRESHOLD && unsupported <= MAX_UNSUPPORTED_FOR_PASS) {
    verdict = 'pass';
  } else if (supported / total >= REVIEW_THRESHOLD) {
    verdict = 'review';
  }

  return {
    total,
    supported,
    partial,
    unsupported,
    supportedPct,
    verdict,
    byKind,
    thresholds: {
      pass:   PASS_THRESHOLD,
      review: REVIEW_THRESHOLD,
      max_unsupported_for_pass: MAX_UNSUPPORTED_FOR_PASS,
    },
  };
}

/**
 * runFactCheck(html, evidenceResult, opts?) → высокоуровневый фасад,
 * объединяющий extract + verify + summary в один объект-отчёт. Этот объект
 * хранится в task.fact_check_report (JSONB-колонка).
 */
function runFactCheck(html, evidenceResult, opts = {}) {
  const claims = extractClaims(html);
  const results = verifyClaims(claims, evidenceResult, opts);
  const summary = summarizeFactCheck(results);
  return {
    generated_at: new Date().toISOString(),
    summary,
    // Топ-N подозрительных утверждений выносим отдельно — UI/логи будут
    // показывать прежде всего их, а не сотни «supported».
    top_unsupported: results
      .filter((r) => r.status === 'unsupported')
      .slice(0, 20)
      .map((r) => ({ id: r.id, text: r.text, kinds: r.kinds, tokens: r.tokens })),
    top_partial: results
      .filter((r) => r.status === 'partial')
      .slice(0, 20)
      .map((r) => ({
        id: r.id, text: r.text, kinds: r.kinds,
        matchedTokenCount: r.matchedTokenCount, totalTokenCount: r.totalTokenCount,
        supportedBy: r.supportedBy,
      })),
    results,   // полный список — для будущей UI и audit-trail
  };
}

module.exports = {
  // Public API
  runFactCheck,
  extractClaims,
  verifyClaims,
  summarizeFactCheck,
  // Helpers / internals (exported for tests)
  stripHtml,
  splitSentences,
  extractFactTokens,
  _matchToken,
  _tokensInText,
  // Constants
  MIN_CLAIM_CHARS,
  MAX_CLAIM_CHARS,
  MAX_CLAIMS,
  PASS_THRESHOLD,
  REVIEW_THRESHOLD,
  MAX_UNSUPPORTED_FOR_PASS,
};
