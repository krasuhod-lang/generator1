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
  //
  // Модель: `deepseek-reasoner` (reasoning-эндпоинт DeepSeek API; в личном
  // кабинете может маркироваться как «v4-pro»/reasoner). Reasoning-режим
  // даёт заметно лучшее качество на численном анализе GSC-срезов, дельтах
  // и причинно-следственных выводах. Чуть дороже chat-серии (см.
  // priceCalculator.PRICES.deepseek_reasoner), но отчёт строится в фоне
  // раз в N часов — это допустимо.
  deepseek: {
    enabled: true,
    model: 'deepseek-reasoner',
    temperature: 0.4,
    maxTokens: 8000,        // развёрнутый markdown-отчёт + bandwidth для reasoning
    timeoutMs: 240000,      // до 4 минут — reasoner думает дольше chat-модели
    topQueries: 50,         // топ-50 запросов в срез
    topPages: 20,           // топ-20 страниц в срез
  },

  // Расширенные срезы GSC (помимо date / query / page): разрезы, которые
  // GSC уже отдаёт через searchAnalytics.query, но мы их не использовали.
  // Подаются и в snapshot, и в промпт LLM-аналитика.
  gscBreakdowns: {
    enabled: true,
    // Срез по устройствам: desktop / mobile / tablet (часто mobile проседает
    // по CTR/позиции — даёт отдельный класс гипотез: скорость, viewport).
    device: { enabled: true, rowLimit: 10 },
    // Срез по странам: для проектов с гео-таргетингом видно, где есть спрос,
    // который мы не закрываем (нет hreflang / локализованной посадочной).
    country: { enabled: true, rowLimit: 15 },
    // searchAppearance: FAQ / How-to / Sitelinks / Video / Image pack — какой
    // % показов получает rich snippet.
    searchAppearance: { enabled: true, rowLimit: 15 },
  },

  // Сравнение период-к-периоду (PoP) и декомпозиция Δclicks. Фоновый запрос
  // GSC за равный по длине предыдущий период + детерминированная математика
  // (см. periodComparison.js). Самая ценная вводная для LLM: «спрос -7%,
  // позиции -3%, CTR -2%» вместо «упало на 12%».
  periodCompare: {
    enabled: true,
    // Если период < N дней — PoP теряет смысл (шум выходных).
    minDays: 5,
    // Сколько топ-запросов и топ-страниц сравниваем по дельтам.
    topQueriesDelta: 30,
    topPagesDelta: 15,
    // Минимальные пороги для попадания в «движущие» дельты (отсев шума).
    minImpressions: 50,
    minClicksAbsDelta: 5,
  },

  // Детектор «затухающих» страниц: ранее давали трафик, теперь системно
  // падают N+ недель подряд. Кандидаты на refresh контента — самый
  // ROI-эффективный класс задач. Линейная регрессия по недельной серии.
  pageDecay: {
    enabled: true,
    // Сколько верхних по показам страниц анализируем.
    topPages: 30,
    // Минимум недель в окне для регрессии (период < этого — пропускаем).
    minWeeks: 4,
    // Порог наклона тренда (доля кликов в неделю): сильнее этого — decay.
    slopeThreshold: -0.05,
    // Минимум средних кликов/нед, чтобы страница вообще попала в анализ.
    minMeanWeeklyClicks: 5,
  },

  // Бренд vs небренд динамика: разделяем дневную серию на брендовые
  // и небрендовые клики (по brand-токенам из commercialIntent.deriveBrandTokens
  // + срез по запросам). Помогает увидеть, не маскирует ли рост бренда
  // падение small/non-brand спроса.
  brandSplit: {
    enabled: true,
    // Сколько строк query-разреза тянем для расчёта пропорции (бренд/небренд).
    queryRowLimit: 5000,
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

  // Верификация каннибализации/слияния разделов по РЕАЛЬНОЙ топ-выдаче Google
  // (через xmlstock). Детектор каннибализации в commercialIntent.js работает по
  // данным GSC и лишь сигнализирует о подозрении; прежде чем рекомендовать
  // склейку разделов, мы снимаем топ Google по запросу и проверяем, реально ли
  // несколько страниц сайта конкурируют в выдаче. Graceful: при недоступности
  // xmlstock вердикт = 'inconclusive', анализ продолжается.
  serpVerification: {
    enabled: true,
    engine: 'google',
    // Сколько верхних результатов Google анализируем (pages×10).
    pages: 2,            // → топ-20
    topResults: 20,
    // Сколько кейсов каннибализации проверяем по SERP (бережём лимиты ключа).
    maxCandidates: 10,
    // Регион/домен/устройство Google (по умолчанию без привязки).
    region: '',
    domain: '',
    device: '',
    // Кэш SERP-ответов (одна выдача переиспользуется между кейсами/обновлениями).
    cacheTtlMs: 24 * 60 * 60 * 1000, // 24 часа
    cacheMaxEntries: 500,
    // Порог: на скольких позициях Google должны стоять ≥2 страницы сайта, чтобы
    // считать каннибализацию подтверждённой (склейку оправданной).
    minPagesInTop: 2,
  },

  // Порционная (map-reduce) обработка больших объёмов данных. Если запросов и
  // строк «запрос × страница» становится несколько сотен/тысяч, единый промт
  // раздувается и теряет фокус. Тогда данные режутся на порции, по каждой
  // извлекаются ёмкие выводы и гипотезы, затем сводятся в общий пул.
  batch: {
    enabled: true,
    // Суммарный объём (topQueries + строки query×page), свыше которого
    // включается порционный режим.
    workloadThreshold: 300,
    // Размер одной порции (запросов/строк).
    chunkSize: 150,
    // Потолок числа порций — защита от тысяч LLM-вызовов на гигантских наборах.
    maxChunks: 12,
    // Параллелизм map-фазы.
    concurrency: 3,
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
