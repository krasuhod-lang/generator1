'use strict';

/**
 * projects/config.js — неизменяемая конфигурация модуля «Проекты» + GSC.
 *
 * Паттерн репозитория: вся не-секретная конфигурация живёт в коде через
 * deepFreeze (см. forecaster/config.js, qualityLayers/featureFlags.js).
 * Файл .env.example НЕ трогаем. Секреты (Google OAuth client id/secret,
 * DEEPSEEK_API_KEY, ключ шифрования) читаются из process.env по месту.
 */

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

const PROJECTS_CONFIG = deepFreeze({
  limits: {
    nameMax: 200,
    audienceMax: 4000,
  },

  // Google Search Console / OAuth 2.0.
  gsc: {
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiBase: 'https://www.googleapis.com/webmasters/v3',
    // Параметры OAuth-запроса.
    accessType: 'offline',   // нужен refresh_token
    prompt: 'consent',       // гарантируем выдачу refresh_token
    httpTimeoutMs: 20000,
    // Кэш ответов Search Analytics (соблюдаем лимиты GSC API — не бьёмся
    // в API при каждом обновлении страницы).
    cacheTtlMs: 10 * 60 * 1000, // 10 минут
    cacheMaxEntries: 500,
    rowLimit: 25000,            // верхний предел строк на запрос к GSC
  },

  // DeepSeek — «Senior SEO-аналитик». Долгий ответ (30–60 c) — задача
  // выполняется в фоне, фронт поллит статус.
  deepseek: {
    enabled: true,
    temperature: 0.4,
    maxTokens: 4000,        // развёрнутый markdown-отчёт
    timeoutMs: 180000,      // до 3 минут на генерацию
    topQueries: 50,         // топ-50 запросов в срез
    topPages: 20,           // топ-20 страниц в срез
  },

  // Анализ с акцентом на коммерческий трафик. Детерминированный слой
  // (commercialIntent.js) классифицирует запросы по интенту, считает долю
  // коммерческого трафика и находит точки роста выручки до вызова LLM.
  commercial: {
    enabled: true,
    // Дополнительный срез GSC: запрос × страница — для поиска каннибализации
    // и несоответствия интента (коммерческий запрос на инфо-странице).
    queryPageRowLimit: 2000,
    // «Striking distance» — позиции, с которых до топа недалеко: лёгкие
    // точки роста коммерческого трафика.
    strikingDistance: { minPosition: 4, maxPosition: 20, minImpressions: 30 },
    // Топ-N коммерческих запросов/страниц в срез для LLM.
    topCommercialQueries: 30,
    topOpportunities: 15,
    // CTR-аномалия: фактический CTR заметно ниже ожидаемого для позиции —
    // сигнал о слабом title/description/сниппете (прямой недобор кликов).
    ctrAnomaly: { maxPosition: 10, minImpressions: 50, dropRatio: 0.6 },
    // Эталонная CTR-кривая по позиции (доля 0..1). Консервативные средние
    // по органике; используется как бенчмарк для детектора аномалий.
    ctrBenchmark: {
      1: 0.28, 2: 0.16, 3: 0.11, 4: 0.08, 5: 0.06,
      6: 0.045, 7: 0.035, 8: 0.03, 9: 0.025, 10: 0.022,
    },
    // Словари для классификации интента (регистронезависимо, по подстроке).
    // Порядок проверки: branded → transactional → commercial → investigation
    // → informational → navigational → other.
    dictionaries: {
      transactional: [
        'купить', 'куплю', 'заказать', 'заказ', 'заказы', 'оформить заказ',
        'цена', 'цены', 'ценам', 'стоимость', 'сколько стоит', 'прайс',
        'прайс-лист', 'недорого', 'дёшево', 'дешево', 'скидка', 'скидки',
        'акция', 'акции', 'распродажа', 'промокод', 'купон', 'доставка',
        'доставкой', 'оплата', 'в рассрочку', 'рассрочка', 'кредит',
        'оптом', 'розница', 'каталог', 'купить онлайн', 'интернет-магазин',
        'buy', 'order', 'price', 'cost', 'cheap', 'discount', 'coupon',
        'shop', 'sale', 'for sale', 'deal', 'deals',
      ],
      commercial: [
        'услуга', 'услуги', 'услуг', 'заказать услугу', 'под ключ',
        'компания', 'фирма', 'агентство', 'сервис', 'аренда', 'арендовать',
        'прокат', 'ремонт', 'монтаж', 'установка', 'продажа', 'поставка',
        'тариф', 'тарифы', 'подписка', 'service', 'rent', 'hire',
      ],
      investigation: [
        'отзыв', 'отзывы', 'отзывов', 'лучший', 'лучшие', 'лучшая', 'топ',
        'рейтинг', 'рейтинги', 'сравнение', 'сравнить', 'обзор', 'обзоры',
        'какой выбрать', 'какую выбрать', 'что лучше', 'vs', 'против',
        'аналог', 'аналоги', 'альтернатива', 'плюсы и минусы',
        'review', 'reviews', 'best', 'top', 'rating', 'comparison',
        'compare', 'vs.', 'alternative',
      ],
      informational: [
        'как', 'что такое', 'почему', 'зачем', 'когда', 'где', 'сколько',
        'инструкция', 'руководство', 'гайд', 'мануал', 'своими руками',
        'пошагово', 'что значит', 'что это', 'определение', 'пример',
        'примеры', 'история', 'виды', 'типы', 'причины', 'значение',
        'how', 'what', 'why', 'guide', 'tutorial', 'meaning', 'examples',
      ],
      navigational: [
        'официальный сайт', 'офиц сайт', 'личный кабинет', 'войти',
        'вход', 'логин', 'регистрация', 'контакты', 'адрес', 'телефон',
        'режим работы', 'график работы', 'login', 'sign in', 'website',
      ],
    },
    // Признаки «информационной» страницы в URL — для детектора
    // несоответствия интента (коммерческий запрос → инфо-страница).
    infoPageMarkers: [
      '/blog', '/blogs', '/article', '/articles', '/news', '/stati',
      '/statya', '/post', '/posts', '/wiki', '/help', '/faq', '/guide',
      '/info', '/journal', '/baza-znaniy',
    ],
    // Признаки «коммерческой» страницы в URL.
    commercePageMarkers: [
      '/catalog', '/category', '/product', '/products', '/shop', '/store',
      '/tovar', '/tovary', '/uslugi', '/services', '/price', '/cart',
      '/buy', '/order', '/zakaz',
    ],
  },

  // Готовые пресеты периода для DatePicker.
  datePresets: [
    { key: '7d',  label: 'За 7 дней',   days: 7 },
    { key: '28d', label: 'За 28 дней',  days: 28 },
    { key: '3m',  label: 'За 3 месяца', days: 90 },
    { key: '6m',  label: 'За 6 месяцев', days: 180 },
  ],

  share: {
    tokenBytes: 12, // 96 бит энтропии → base64url ≈ 16 символов
  },
});

function getProjectsConfig() {
  return PROJECTS_CONFIG;
}

/**
 * Сконфигурирован ли Google OAuth (есть ли client id/secret/redirect).
 * Если нет — GSC-эндпоинты деградируют с понятной ошибкой, остальной
 * функционал проектов (CRUD, шаринг) работает.
 */
function getGoogleOAuthConfig() {
  // .trim() — на случай лишних пробелов вокруг значения в .env
  // (например GOOGLE_OAUTH_REDIRECT_URI=" https://site/...callback ").
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret && redirectUri),
  };
}

module.exports = { getProjectsConfig, getGoogleOAuthConfig, deepFreeze };
