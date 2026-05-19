'use strict';

/**
 * forecaster/junkClassifier.js — детерминированная разметка «шлак-запросов».
 *
 * Цель: пометить фразы, которые НЕ стоит продвигать или которые искажают
 * оценку трафика. Работает строго по правилам, без LLM (быстро, безопасно
 * для любых объёмов). DeepSeek-обогащение (см. deepseekAnalyzer) добавляет
 * человекочитаемые причины поверх этой разметки.
 *
 * Каждой помеченной фразе присваивается reason из enum:
 *   • too_broad         — слишком общая (ультра-генерик/однословник с большой частоткой)
 *   • info_intent       — инфо-намерение (что такое, отзывы, скачать, …)
 *   • dead              — за последние N месяцев = 0 (умерший спрос)
 *   • too_short         — длина < minPhraseChars (опечатка/мусор)
 *   • foreign_brand     — содержит чужой брендовый домен, отличный от target
 *   • duplicate         — точный дубль другой фразы (после нормализации)
 *
 * Не модифицирует входные данные. Возвращает:
 *   {
 *     flagged: [{ phrase, total, reasons: [...], severity, sample_periods: [...] }],
 *     counts:  { total_rows, junk_count, by_reason: {...} },
 *     summary: { junk_pct, warn: bool, top_examples: [...] }
 *   }
 */

const { getForecasterConfig } = require('./config');

function _normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _hostFromUrl(u) {
  try {
    if (!u) return '';
    let s = String(u).trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    const h = new URL(s).hostname.replace(/^www\./i, '').toLowerCase();
    return h;
  } catch (_) {
    return '';
  }
}

function _registrableRoot(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return parts.join('.');
  // упрощённо: берём последние 2 уровня (kompy.com из shop.kompy.com).
  // Для известных 2LD типа co.uk/com.ru — берём 3. Не критично для эвристики.
  const twoLd = ['co.uk', 'com.ua', 'com.ru', 'org.ru', 'org.ua', 'net.ru'];
  const tail2 = parts.slice(-2).join('.');
  if (twoLd.includes(tail2)) return parts.slice(-3).join('.');
  return tail2;
}

function _wordCount(s) {
  const tokens = String(s).trim().split(/\s+/).filter(Boolean);
  return tokens.length;
}

function _last0Run(byPeriod, monthCols, n) {
  if (!byPeriod || !monthCols || !monthCols.length) return 0;
  const tail = monthCols.slice(-n);
  if (tail.length < n) return 0;
  let zeros = 0;
  for (const mc of tail) {
    const v = Number(byPeriod[mc.period] || 0);
    if (v <= 0) zeros += 1;
  }
  return zeros;
}

/**
 * @param {Object} args
 * @param {Array} args.parsedRows  parser.rows = [{phrase, total, byPeriod}]
 * @param {Array} args.monthCols   parser.monthCols
 * @param {string} [args.targetUrl]  URL продвигаемого сайта (опционально)
 */
function classifyJunkPhrases({ parsedRows, monthCols, targetUrl } = {}) {
  const rows = Array.isArray(parsedRows) ? parsedRows : [];
  const cfg = getForecasterConfig().junk;

  const targetHost = _hostFromUrl(targetUrl);
  const targetRoot = _registrableRoot(targetHost);
  const targetTokens = new Set(
    (targetRoot ? targetRoot.split('.').slice(0, -1) : []) // ['kompy'] для kompy.com
      .filter((t) => t && t.length >= 3),
  );
  const targetHostBare = targetHost ? targetHost.split('.').slice(0, -1).join('.') : '';

  const flagged = [];
  const byReason = Object.create(null);
  const seenNorm = new Map();   // norm -> firstIndex
  const samplePeriods = (monthCols || []).slice(-3).map((mc) => mc.period);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const phrase = String(row?.phrase || '').trim();
    if (!phrase) continue;
    const norm = _normalize(phrase);
    const reasons = [];

    // too_short
    if (norm.length < cfg.minPhraseChars) reasons.push('too_short');

    // duplicate
    if (seenNorm.has(norm)) {
      reasons.push('duplicate');
    } else {
      seenNorm.set(norm, i);
    }

    // info_intent: содержит инфо-стоп-слова
    for (const sw of cfg.infoStopwords) {
      if (norm.includes(sw)) { reasons.push('info_intent'); break; }
    }

    // too_broad: 1 слово + высокая частотка
    if (_wordCount(norm) <= cfg.broadMaxWords && Number(row.total || 0) >= cfg.ultraHighFreq) {
      reasons.push('too_broad');
    }

    // foreign_brand: содержит другой домен .com/.ru/.рф и т.п.
    // Простой паттерн: что-то вроде "xyz.ru" или "купить на ozon" / "wildberries"
    // Без targetUrl мы не знаем, что брендовое, поэтому пропускаем —
    // но фразы с явным доменом флагуем как foreign_brand если он отличается.
    const domainMatch = norm.match(/\b([a-z0-9-]+\.(ru|com|net|org|рф|ua|by|kz|info|shop|store))\b/);
    if (domainMatch) {
      const otherRoot = _registrableRoot(domainMatch[1]);
      if (!targetRoot || (otherRoot && otherRoot !== targetRoot)) {
        reasons.push('foreign_brand');
      }
    } else if (targetTokens.size > 0) {
      // если задан targetUrl и фраза упоминает другую брендовую сущность
      // (на латинице), длиннее 4 символов, не входящую в targetTokens — не флагуем,
      // эвристика слишком шумная без словаря. Оставляем только domainMatch выше.
    }

    // dead: последние N месяцев нули
    const deadN = cfg.deadMonthsTail;
    if ((monthCols || []).length >= deadN) {
      const zeros = _last0Run(row.byPeriod, monthCols, deadN);
      if (zeros === deadN) reasons.push('dead');
    }

    if (reasons.length === 0) continue;

    // severity: high — too_broad, foreign_brand, dead; mid — info_intent; low — duplicate/too_short
    let severity = 'low';
    if (reasons.includes('too_broad') || reasons.includes('foreign_brand') || reasons.includes('dead')) severity = 'high';
    else if (reasons.includes('info_intent')) severity = 'mid';

    flagged.push({
      phrase,
      total: Number(row.total || 0),
      reasons,
      severity,
      sample_periods_demand: samplePeriods.map((p) => ({
        period: p,
        v: Number(row.byPeriod?.[p] || 0),
      })),
    });
    for (const r of reasons) byReason[r] = (byReason[r] || 0) + 1;
  }

  // сортируем: сначала high, потом по total DESC
  const sevOrder = { high: 0, mid: 1, low: 2 };
  flagged.sort((a, b) => {
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    return (b.total || 0) - (a.total || 0);
  });

  const junkCount = flagged.length;
  const junkPct = rows.length > 0 ? junkCount / rows.length : 0;
  const topExamples = flagged.slice(0, 10).map((f) => ({
    phrase: f.phrase, reasons: f.reasons, total: f.total,
  }));

  return {
    flagged,
    counts: {
      total_rows: rows.length,
      junk_count: junkCount,
      by_reason:  byReason,
    },
    summary: {
      junk_pct:  Math.round(junkPct * 10000) / 100, // %, 2 знака
      warn:      junkPct >= cfg.warnPctThreshold,
      target_url: targetUrl || null,
      target_host: targetHost || null,
      top_examples: topExamples,
    },
  };
}

const REASON_LABELS = {
  too_broad:     'Слишком общий запрос (ультра-генерик): не даст релевантного трафика',
  info_intent:   'Информационный интент (отзывы/что такое/скачать): не конвертит',
  dead:          'Мёртвый спрос: 0 показов в последних месяцах',
  too_short:     'Слишком короткая строка: вероятно опечатка/мусор',
  foreign_brand: 'Содержит чужой бренд/домен: продвижение бессмысленно',
  duplicate:     'Дубль уже учтённой фразы',
};

module.exports = { classifyJunkPhrases, REASON_LABELS };
