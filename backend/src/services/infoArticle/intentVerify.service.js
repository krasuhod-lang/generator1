'use strict';

/**
 * intentVerify.service — Phase 2 / Б5. Постгенерационный верификатор
 * поискового намерения статьи.
 *
 * Идея: после writer'а определяем «программное» намерение готовой статьи
 * на основе детерминированных сигналов в HTML (наличие цен, CTA-кнопок
 * «купить/заказать», доли FAQ-блока, доли how-to-фраз и т.п.). Сверяем
 * с доминирующим интентом из competitor_signals.serp_intent (если есть);
 * при расхождении — soft-warning + рекомендация. Никогда не валит pipeline.
 *
 * Контракт без LLM:
 *   • быстро, детерминировано, без сети.
 *
 * Гейтировано env'ом INFO_ARTICLE_INTENT_VERIFY_ENABLED (default ON).
 * Без правки .env.example.
 */

const { stripHtmlTagsToText } = require('../../utils/stripHtmlTags');

// ── Лексика-маркеры по типам намерений ──────────────────────────────

// Информационные сигналы (info / how-to / educational)
const INFO_MARKERS = [
  'как ', 'почему ', 'что такое ', 'зачем ', 'для чего ', 'какие ', 'какой ',
  'руководство', 'инструкция', 'пошагов', 'разбираемся', 'объясн',
  'учим', 'учиться', 'примеры', 'основы',
];

// Коммерческие сигналы (commercial / product comparison)
const COMMERCIAL_MARKERS = [
  'цена', 'стоимость', 'сколько стоит', 'прайс',
  'отзыв', 'обзор', 'сравнение', 'рейтинг', 'топ-', 'лучшие',
  'преимущества', 'характеристики',
  'выбрать', 'выбор',
];

// Транзакционные сигналы (transactional / buy now)
const TRANSACTIONAL_MARKERS = [
  'купить', 'заказать', 'оформить', 'оплатить', 'доставка',
  'в корзину', 'добавить в корзину', 'оформить заказ',
  'скидк', 'акция', 'промокод', 'распродажа',
];

// Навигационные сигналы (бренд/сайт-специфичные)
const NAVIGATIONAL_MARKERS = [
  'официальный сайт', 'личный кабинет', 'войти', 'регистрация', 'войдите',
  'контакт', 'адрес', 'телефон', 'часы работы',
];

// Регэксп для цен в рублях / валюте — типичный коммерческий сигнал.
const PRICE_RE = /\b\d[\d\s.,]{1,12}\s*(?:руб(?:лей|\.|)|₽|\$|€|usd|eur|rub|тыс\.?\s*руб)/gi;

// FAQ-сигнал — H2/H3 с «Часто задаваемые», «вопрос-ответ», и т.п.
const FAQ_HEADING_RE = /<h[23][^>]*>\s*(?:часто задаваемые|вопросы и ответы|faq|популярные вопросы|частые вопросы)/i;

// CTA / коммерческий блок — кнопки в HTML.
const CTA_BUTTON_RE = /<(?:button|a)[^>]*\b(?:class|role)\s*=\s*["'][^"']*\b(?:btn|button|cta|buy|order|shop)\b[^"']*["']/i;

// ── Детектор интента статьи ─────────────────────────────────────────

function countMatches(text, markers) {
  let count = 0;
  for (const m of markers) {
    const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s.,;:!?(])${escaped}`, 'gi');
    const matches = text.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * detectArticleIntent — определяет интент статьи по сигналам.
 *
 * Возвращает:
 *   {
 *     intent: 'info' | 'commercial' | 'transactional' | 'navigational' | 'mixed',
 *     scores: { info, commercial, transactional, navigational },
 *     signals: {
 *       price_mentions, cta_buttons, faq_block, info_markers, commercial_markers, ...
 *     }
 *   }
 */
function detectArticleIntent(html) {
  const safeHtml = String(html || '');
  const plain = stripHtmlTagsToText(safeHtml).toLowerCase().replace(/[ёЁ]/g, 'е');
  const padded = ` ${plain} `;

  const infoCount    = countMatches(padded, INFO_MARKERS);
  const commCount    = countMatches(padded, COMMERCIAL_MARKERS);
  const transCount   = countMatches(padded, TRANSACTIONAL_MARKERS);
  const navCount     = countMatches(padded, NAVIGATIONAL_MARKERS);

  const priceMatches = (safeHtml.match(PRICE_RE) || []).length;
  const ctaButtons   = (safeHtml.match(new RegExp(CTA_BUTTON_RE.source, 'gi')) || []).length;
  const hasFaq       = FAQ_HEADING_RE.test(safeHtml);
  const wordCount    = (plain.match(/[а-яa-z0-9]+/gi) || []).length;

  // Нормируем на длину статьи (число сигналов на 1000 слов), чтобы маленькая
  // статья с 1 «купить» не перекошила результат.
  const norm = (n) => (wordCount > 0 ? (n / wordCount) * 1000 : 0);

  // Веса. Транзакционные сигналы — самые «жёсткие» (купить/заказать), они
  // получают двойной вес. Цены в HTML — сильный коммерческий сигнал (вес 2).
  const scores = {
    info:          norm(infoCount) + (hasFaq ? 4 : 0),
    commercial:    norm(commCount) + 2 * norm(priceMatches),
    transactional: 2 * norm(transCount) + 3 * norm(ctaButtons),
    navigational:  norm(navCount),
  };

  // Берём максимум; если разница между топ-1 и топ-2 < 30% — mixed.
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const top    = sorted[0];
  const second = sorted[1];
  let intent;
  if (top[1] === 0) intent = 'info'; // дефолт
  else if (second && second[1] > 0 && (top[1] - second[1]) / top[1] < 0.3) intent = 'mixed';
  else intent = top[0];

  // Для mixed запоминаем top-2 для пользователя.
  const topPair = sorted.slice(0, 2).map(([k]) => k);

  return {
    intent,
    top_pair: intent === 'mixed' ? topPair : [top[0]],
    scores: {
      info:          Math.round(scores.info * 100) / 100,
      commercial:    Math.round(scores.commercial * 100) / 100,
      transactional: Math.round(scores.transactional * 100) / 100,
      navigational:  Math.round(scores.navigational * 100) / 100,
    },
    signals: {
      price_mentions:     priceMatches,
      cta_buttons:        ctaButtons,
      faq_block:          hasFaq,
      info_markers:       infoCount,
      commercial_markers: commCount,
      transactional_markers: transCount,
      navigational_markers:  navCount,
      word_count:         wordCount,
    },
  };
}

/**
 * verifyIntent — сравнивает программный интент статьи с доминирующим
 * интентом SERP-топа (из competitor_signals.serp_intent.dominant_intent).
 *
 * Возвращает:
 *   {
 *     enabled, verdict ('pass' | 'review' | 'mismatch' | 'na'),
 *     article_intent,    // что определил детектор
 *     serp_intent,       // dominant_intent из топа (или null)
 *     mismatch,          // bool
 *     critical,          // bool — критичное расхождение (info ↔ transactional)
 *     recommendation,    // строка с рекомендацией / null
 *     details: { detection: {...}, distribution_pct: {...} }
 *   }
 */
function verifyIntent(html, competitorSignals) {
  const detection = detectArticleIntent(html);
  // Если статья слишком короткая — verdict=na.
  if (!detection.signals.word_count || detection.signals.word_count < 200) {
    return {
      enabled: true,
      verdict: 'na',
      reason:  'too_short',
      article_intent: detection.intent,
      serp_intent: null,
      mismatch: false,
      critical: false,
      recommendation: null,
      details: { detection, distribution_pct: null },
    };
  }

  const serpBlock = competitorSignals && competitorSignals.serp_intent;
  if (!serpBlock || !serpBlock.dominant_intent) {
    // Нет данных о SERP-топе — отдаём только программную классификацию.
    return {
      enabled: true,
      verdict: 'na',
      reason:  'no_serp_intent',
      article_intent: detection.intent,
      serp_intent: null,
      mismatch: false,
      critical: false,
      recommendation: null,
      details: { detection, distribution_pct: null },
    };
  }

  const serpIntent = String(serpBlock.dominant_intent || 'info').toLowerCase();
  const articleIntent = detection.intent;

  // mixed-статья — её top_pair мы используем для матча: если SERP-интент
  // содержится в top_pair, считаем «совпало».
  const articleMatchesSerp = articleIntent === serpIntent ||
    (articleIntent === 'mixed' && detection.top_pair.includes(serpIntent));

  if (articleMatchesSerp) {
    return {
      enabled: true,
      verdict: 'pass',
      reason: null,
      article_intent: articleIntent,
      serp_intent:    serpIntent,
      mismatch:       false,
      critical:       false,
      recommendation: null,
      details: { detection, distribution_pct: serpBlock.distribution_pct || null },
    };
  }

  // Расхождение. Критичные пары — info↔transactional / info↔commercial
  // (разный тип задачи). Менее критичные — commercial↔navigational.
  const isCritical = (
    (articleIntent === 'info' && (serpIntent === 'transactional' || serpIntent === 'commercial')) ||
    (serpIntent === 'info' && (articleIntent === 'transactional' || articleIntent === 'commercial')) ||
    (articleIntent === 'navigational' && serpIntent !== 'navigational')
  );

  // Рекомендация: подсказать пользователю «переключить тип задачи».
  let recommendation;
  if (isCritical) {
    if (serpIntent === 'transactional' || serpIntent === 'commercial') {
      recommendation = `SERP-топ ожидает ${serpIntent}-страницу (карточки/сравнения/цены), а статья получилась ${articleIntent}. Рассмотри переключение на тип «link-article» (страница с CTA) или добавь коммерческие блоки.`;
    } else if (serpIntent === 'info') {
      recommendation = `SERP-топ информационный (как, почему, разбор), а статья получилась ${articleIntent}. Рассмотри переключение на «info-article» без коммерческих блоков.`;
    } else {
      recommendation = `Расхождение интента: статья=${articleIntent}, SERP=${serpIntent}. Уточни тип задачи.`;
    }
  } else {
    recommendation = `SERP-интент: ${serpIntent}; статья: ${articleIntent}. Расхождение мягкое — допустимо, но проверь блоки.`;
  }

  return {
    enabled: true,
    verdict: isCritical ? 'mismatch' : 'review',
    reason:  null,
    article_intent: articleIntent,
    serp_intent:    serpIntent,
    mismatch:       true,
    critical:       isCritical,
    recommendation,
    details: { detection, distribution_pct: serpBlock.distribution_pct || null },
  };
}

module.exports = {
  detectArticleIntent,
  verifyIntent,
  _internal: {
    countMatches,
    INFO_MARKERS, COMMERCIAL_MARKERS, TRANSACTIONAL_MARKERS, NAVIGATIONAL_MARKERS,
  },
};
