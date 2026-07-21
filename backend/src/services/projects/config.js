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
    rowLimit: 25000,            // верхний предел строк на ОДИН запрос к GSC (жёсткий потолок API)
    // Полная выгрузка без лимитов в рамках проекта (ТЗ п.2 — «сними все
    // ограничения получения данных по API»). GSC отдаёт максимум 25000 строк
    // за запрос, поэтому тянем постранично через startRow, пока приходят
    // полные страницы.
    //   pageSize — строк за один запрос (≤ rowLimit, ограничение API);
    //   maxRows  — общий потолок выгрузки (0 = без лимита, тянем всё);
    //   maxPages — страховка от бесконечной пагинации при сбоях API.
    pageSize: 25000,
    maxRows: 0,
    maxPages: 40,
    // Потолок строк для ЖИВЫХ (синхронных) эндпоинтов дашборда/сравнения,
    // которые фронт ждёт под axios-таймаутом 60 c. Фоновая AI-аналитика тянет
    // всё без лимита; здесь же ограничиваем top-срезы одной страницей, чтобы
    // ответ приходил быстро и не упирался в timeout (источник «timeout of
    // 60000ms exceeded»). 0 = без лимита.
    liveRowLimit: 5000,
  },

  // Яндекс.Вебмастер / Yandex OAuth 2.0 — вторая аналитическая интеграция
  // проекта (по аналогии с GSC). Поведение симметрично gsc-блоку, чтобы
  // переиспользовать паттерн (см. projects/ydxClient.js, projects/ydxService.js).
  ydx: {
    // OAuth-эндпоинты Яндекс ID.
    authUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    // Webmaster API v4.
    apiBase: 'https://api.webmaster.yandex.net/v4',
    // Право доступа к данным Яндекс.Вебмастера (read-only достаточно для
    // дашборда и аналитики поисковых запросов).
    scope: 'webmaster:hostinfo webmaster:verify',
    httpTimeoutMs: 20000,
    // Кэш ответов Webmaster API (соблюдаем лимиты — не бьёмся в API при
    // каждом обновлении страницы).
    cacheTtlMs: 10 * 60 * 1000, // 10 минут
    cacheMaxEntries: 500,
    // Webmaster отдаёт статистику с задержкой ~1-2 дня — не запрашиваем «сегодня».
    lagDays: 2,
    // Тянем ВСЕ популярные запросы периода постранично (без лимита).
    //   pageSize  — строк за один запрос (ограничение Webmaster API ≤ 500);
    //   maxRows   — общий потолок (0 = без лимита, тянем все страницы);
    //   maxPages  — страховка от бесконечного цикла при сбоях пагинации.
    pageSize: 500,
    maxRows: 0,
    maxPages: 500,
    // Потолок строк для ЖИВЫХ (синхронных) эндпоинтов дашборда/сравнения и
    // для фолбэка средней позиции в fetchPerformanceSeries. Фоновая аналитика
    // тянет все запросы без лимита; здесь ограничиваем выборку, чтобы ответ
    // приходил быстро в рамках 60-секундного таймаута фронта. 0 = без лимита.
    liveRowLimit: 500,
    // Индикаторы статистики запросов Webmaster API.
    indicators: {
      shows: 'TOTAL_SHOWS',
      clicks: 'TOTAL_CLICKS',
      position: 'AVG_SHOW_POSITION',
    },
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
    maxTokens: 16000,       // развёрнутый markdown-отчёт + bandwidth для reasoning
    timeoutMs: 240000,      // до 4 минут — reasoner думает дольше chat-модели
    topQueries: 50,         // топ-50 запросов в срез
    topPages: 20,           // топ-20 страниц в срез
  },

  // Провайдер LLM для проектной аналитики. По умолчанию — Gemini 3.1 Pro:
  // даёт более точечный анализ срезов, прогнозы и определение слабых зон.
  // DeepSeek-reasoner остаётся фолбэком, если Gemini не сконфигурирован
  // (нет GEMINI_API_KEY) — пайплайн не падает. Раздельный анализ Google и
  // Яндекса + сводка закономерностей по обоим источникам.
  analyzer: {
    // 'gemini' | 'deepseek'. llmAnalyst мягко откатывается на доступный
    // провайдер, если выбранный не сконфигурирован.
    provider: 'gemini',
    gemini: {
      model: 'gemini-3.1-pro-preview',
      temperature: 0.4,
      maxTokens: 16384,   // reasoning-модель: большой развёрнутый markdown
      timeoutMs: 300000,  // до 5 минут на тяжёлый срез
    },
    // Отдельный AI-анализ Яндекс.Вебмастера (помимо Google Search Console).
    yandex: { enabled: true },
    // Финальный проход: сводка закономерностей Google+Яндекс + ranking-gaps.
    synthesis: { enabled: true },
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
  // Закономерности спада на диапазоне в несколько месяцев (ТЗ п.4):
  // тренд по дням, профиль по дням недели и помесячная динамика.
  seasonality: {
    enabled: true,
    // Минимум дней в ряду — иначе сезонность не считаем (нужен хотя бы месяц).
    minDays: 28,
    // День недели считается системно слабым, если средние клики ниже общего
    // среднего на эту долю (например, -0.25 = на 25% ниже).
    weekdayWeakThreshold: -0.25,
    // Порог наклона дневного тренда (доля среднего/день) для вердикта down/up.
    trendDownThreshold: -0.003,
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
    // Порядок проверки больше НЕ важен — classifyQuery считает взвешенный
    // score по всем словарям (см. ниже intentScoring) и берёт максимум.
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
    // Веса для нового алгоритма classifyQuery (ТЗ §4). Считаем взвешенный
    // score по совпадениям словарей и берём максимум. Сильные
    // информационные триггеры («что такое», «как», «почему», «гайд» …) и
    // сильные транзакционные («купить», «цена», «доставка» …) перекрывают
    // слабые маркеры из других категорий — это решает проблему
    // «обзор лучших CRM» → попадал в commercial из-за «обзор», теперь
    // классифицируется как informational.
    intentScoring: {
      weights: {
        transactionalStrong: 3,
        transactionalBase:   2,
        commercialBase:      2,
        commercialDampened:  1,
        investigationBase:   2,
        investigationDampened: 1,
        informationalStrong: 3,
        informationalWeak:   1,
        navigationalBase:    2,
      },
      strongInformational: [
        'что такое', 'что это', 'как', 'почему', 'зачем', 'когда', 'где',
        'сколько', 'инструкция', 'руководство', 'гайд', 'мануал',
        'пошагово', 'своими руками', 'пример', 'примеры', 'виды', 'типы',
        'причины', 'определение', 'значение', 'история',
        'how', 'what', 'why', 'guide', 'tutorial', 'meaning', 'examples',
      ],
      strongTransactional: [
        'купить', 'куплю', 'заказать', 'заказ', 'оформить заказ', 'цена',
        'цены', 'стоимость', 'сколько стоит', 'прайс', 'прайс-лист',
        'скидка', 'скидки', 'акция', 'акции', 'распродажа', 'промокод',
        'доставка', 'доставкой', 'оплата', 'в рассрочку', 'рассрочка',
        'купить онлайн', 'интернет-магазин',
        'buy', 'order', 'price', 'cost', 'shop', 'for sale',
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

  // ─────────────────────────────────────────────────────────────────
  // Расширение «Анализ GSC v2»: 8 новых детерминированных слоёв.
  // Каждый блок gated собственным `enabled` (как commercial/serpVerification)
  // и graceful в analysisRunner: при сбое/выключении раздел просто пропускается.
  // ─────────────────────────────────────────────────────────────────

  // п.6 — Универсальный кэш детерминированных срезов (commercial, breakdowns,
  // page_decay, link_audit, eat, schema...). Ключ = hash(project, range, sources):
  // если данные не изменились — переиспользуем срез, не дёргая GSC/парсер/LLM.
  signalCache: {
    enabled: true,
    defaultTtlSec: 6 * 60 * 60,   // 6 часов на детерминированные срезы
    maxPayloadBytes: 2_000_000,   // защита от раздувания JSONB
  },

  // п.6 — DSPy-усиление промптов. Node вызывает aegis_py /dspy/prompt/:signature
  // для получения few-shot-усиленных инструкций; при недоступности aegis_py —
  // graceful fallback на статический промпт (всё работает без DSPy).
  dspy: {
    enabled: true,
    timeoutMs: 8000,
    // Имена сигнатур (должны совпадать с aegis_py/app/projects_dspy.py).
    signatures: ['LinkRecommend', 'BlogTopicSuggest', 'EatRecommend',
      'GeoAeoBoost', 'MetaUplift', 'SchemaSuggest',
      // Раздельный анализ источников + сводка закономерностей + ranking-gaps.
      'YandexQueryAnalysis', 'ProjectGrowthSynthesis', 'RankingFactorGaps'],
  },

  // Каталог важных факторов ранжирования — детерминированный аудит «чего не
  // хватает для роста». Каждый фактор оценивается по данным снапшота (GSC +
  // Яндекс) в статус ok | gap | critical | unknown и подаётся в LLM-сводку,
  // а также отображается отдельной карточкой. weight — относительная важность.
  rankingFactors: {
    enabled: true,
    factors: [
      { key: 'relevance',    label: 'Релевантность и покрытие интента',   weight: 5, group: 'content' },
      { key: 'content_depth', label: 'Глубина и полнота контента',        weight: 5, group: 'content' },
      { key: 'ctr',          label: 'Кликабельность сниппета (CTR)',       weight: 4, group: 'serp' },
      { key: 'striking',     label: 'Запросы у входа в топ (3–20)',        weight: 5, group: 'serp' },
      { key: 'cannibalization', label: 'Каннибализация запросов',          weight: 4, group: 'structure' },
      { key: 'page_decay',   label: 'Деградация страниц (трафик падает)',  weight: 4, group: 'content' },
      { key: 'eat',          label: 'E-E-A-T (экспертность и доверие)',    weight: 5, group: 'trust' },
      { key: 'schema',       label: 'Микроразметка Schema.org',            weight: 3, group: 'tech' },
      { key: 'links',        label: 'Ссылочный профиль и анкоры',          weight: 4, group: 'authority' },
      { key: 'mobile',       label: 'Мобильный трафик и UX',               weight: 3, group: 'tech' },
      { key: 'geo_aeo',      label: 'Видимость в нейровыдаче (AI/SGE)',    weight: 3, group: 'aeo' },
      { key: 'content_gaps', label: 'Контентные дыры (непокрытый спрос)',  weight: 4, group: 'content' },
    ],
  },

  // п.5 — Визуальная схема стратегии. Строится детерминированно из факторов
  // ранжирования (rankingFactors) и раскладывает работы по 5 этапам воронки.
  strategyMap: {
    enabled: true,
  },

  // п.1, п.2 — Ссылочная стратегия. GSC Search Analytics API НЕ отдаёт отчёт
  // «Ссылки», поэтому данные импортируются вручную CSV-выгрузкой из GSC UI
  // (Top linking sites / Top linked pages / Top linking text). Если ссылочных
  // данных нет — рекомендации генерим из контентного среза (data_source:'inferred').
  linkStrategy: {
    enabled: true,
    // Минимальное число рекомендаций на покупку ссылок (ТЗ: «От 5 всегда»).
    minRecommendations: 5,
    // Сколько топ-страниц-целей рассматриваем для линкбилдинга.
    topTargetPages: 20,
    // Сколько доноров оцениваем/выводим.
    topDonors: 30,
    // Импорт CSV: лимиты на размер файла и число строк (анти-DoS).
    importMaxBytes: 5_000_000,
    importMaxRows: 20000,
    // Брендовые/коммерческие маркеры анкоров наследуем из commercial.dictionaries.
    // Порог «перекоса» по донору: доля одного анкора > этого = спам-сигнал.
    anchorSkewThreshold: 0.6,
    // Доля «голых»/URL-анкоров, выше которой профиль считается рискованным.
    nakedAnchorWarnPct: 0.5,
    // Готовые темы статей-доноров под анкор (через внутренний инструмент
    // «Темы статей»): обогащаем каждую рекомендацию проработанной темой статьи,
    // а не сырым анкором. LLM-слой опционален и graceful — без него/при сбое
    // отдаём детерминированную тему. Итоговая строка donor_topic — сама тема
    // статьи напрямую (без служебной обёртки), как требует заказчик.
    donorTopics: {
      enabled: true,
      // Использовать LLM-слой («Темы статей»). Если false или llmFn не передан —
      // остаётся детерминированная обёртка вокруг анкора.
      useLlm: true,
      // Максимум анкоров, под которые генерируем темы за один батч-вызов
      // (анти-DoS / контроль стоимости).
      maxAnchors: 20,
      temperature: 0.6,
      maxTokens: 4000,
      timeoutMs: 120000,
    },
  },

  // п.3 — План публикаций в блог. Детерминированный gapDetector находит «дыры»
  // (striking-distance инфо-запросы, инфо-запросы без покрытия), затем LLM-слой
  // выдаёт ≥ minTopics тем с готовыми title/description (через metaGenerator).
  blogTopics: {
    enabled: true,
    minTopics: 5,
    // Сколько кандидатов-«дыр» подаём в LLM (берём топ по показам).
    maxGapCandidates: 40,
    // Striking distance для информационных запросов.
    strikingDistance: { minPosition: 5, maxPosition: 30, minImpressions: 20 },
    // Минимум показов по стране, чтобы считать её гео-спросом без локализации.
    geoMinImpressions: 100,
  },

  // п.4 — Аудит и усиление мета-тегов топ-страниц. Парсим текущие title/desc
  // через parser/scraper, прогоняем через metaTags/metaGenerator (Gemini),
  // отдаём таблицу «было → стало».
  pageMetaAudit: {
    enabled: true,
    // Сколько страниц аудитим (приоритет: ctrAnomaly + pageDecay + топ показов).
    maxPages: 8,
    // Таймаут парсинга одной страницы.
    scrapeTimeoutMs: 25000,
    // TTL кэша распарсенных страниц (project_page_snapshots).
    pageCacheTtlSec: 24 * 60 * 60,
    // Запускать ли LLM-регенерацию (Gemini) сразу в фоне анализа. По умолчанию
    // false: тяжёлый анализ GSC остаётся быстрым и детерминированным (только
    // парсинг + диагностика «было»), а staged-генерация мета-тегов уходит в
    // отдельный шаг (кнопка / эндпоинт regenerate) через общий хелпер
    // metaTags/metaStages (SERP → семантика → Gemini → LSI-проверка).
    autoRegenerate: false,
    // Разовый анализ ЦА и ниши перед staged-регенерацией набора страниц (как в
    // инструменте мета-тегов). Запускается один раз на пачку URL.
    audienceNiche: { enabled: true },
    // Анализ поисковой выдачи перед регенерацией: тянем ТОП Яндекса по главному
    // запросу страницы (xmlstock), извлекаем TF-IDF семантику конкурентов и
    // прокидываем как serpData в metaGenerator. Так мета-тег строится на основе
    // анализа выдачи, а не только GSC-запросов (п.2 ТЗ).
    serpAnalysis: {
      enabled: true,
      // Сколько страниц выдачи xmlstock забирать (1 страница = ТОП-10).
      serpPages: 1,
      // Регион Яндекса (lr). Пусто — без привязки к региону.
      lr: '',
    },
  },

  // п.3 — Реверс-инжиниринг топовых страниц. Парсим страницы с высокими
  // показами И высокой позицией, профилируем контент, выявляем закономерности
  // «почему в топе» и формируем рекомендации для будущих статей.
  topPageInsights: {
    enabled: true,
    // Минимум показов, чтобы страница считалась «успешной по показам».
    minImpressions: 100,
    // Максимальная (худшая) позиция, при которой страница считается «в топе».
    maxPosition: 10,
    // Сколько страниц-лидеров парсим и анализируем.
    maxPages: 6,
    // Сколько GSC-запросов привязываем к каждой странице.
    queriesPerPage: 12,
    // Таймаут парсинга одной страницы.
    scrapeTimeoutMs: 25000,
    // Минимум рекомендаций для будущих статей (всегда добиваем до этого числа).
    minRecommendations: 5,
    // КФ6 / переспам — оценка переоптимизации ПО РАСПАРСЕННОМУ контенту.
    // Выводы о переспаме делаются только после парсинга страницы.
    overspam: {
      // Плотность одного ключа (%), выше которой — явный переспам.
      maxTermDensityPct: 3.5,
      // Плотность, выше которой — «под наблюдением».
      watchTermDensityPct: 2.5,
      // Сколько раз точная фраза-запрос может встречаться без штрафа.
      maxPhraseRepeat: 4,
      // Минимум слов на странице, чтобы вообще считать плотность.
      minWordsForDensity: 80,
      // Порог overspam_score (0..100) для уровней risk/watch.
      riskScore: 60,
      watchScore: 35,
    },
    // Топ-10 дифференциал: парсим набор сравнения (страницы с показами, но
    // позицией хуже топа) и сравниваем, чего им не хватает против лидеров.
    comparison: {
      enabled: true,
      // Диапазон позиций «отстающих» страниц для набора сравнения.
      minPosition: 11,
      maxPosition: 50,
      // Минимум показов, чтобы «отстающая» страница попала в сравнение.
      minImpressions: 50,
      // Сколько отстающих страниц парсим для сравнения.
      maxPages: 4,
    },
  },

  // п.5 — Сканирование шаблонов страниц и оценка E-E-A-T. Кластеризуем топ-
  // страницы по URL-паттерну, парсим представителей, детектируем блоки и
  // считаем детерминированный E-E-A-T score 0..100.
  eat: {
    enabled: true,
    // Сколько верхних страниц рассматриваем для кластеризации по шаблонам.
    topPages: 30,
    // Сколько представителей парсим на каждый кластер шаблона.
    samplesPerTemplate: 1,
    // Максимум кластеров шаблонов (защита от парсинга десятков URL).
    maxTemplates: 6,
    scrapeTimeoutMs: 25000,
    pageCacheTtlSec: 24 * 60 * 60,
    // URL-паттерны → имя шаблона (по подстроке пути).
    templatePatterns: {
      catalog: ['/catalog', '/category', '/categories', '/shop', '/store'],
      product: ['/product', '/products', '/tovar', '/tovary', '/item', '/p/'],
      service: ['/uslugi', '/services', '/service', '/usluga'],
      blog: ['/blog', '/article', '/articles', '/news', '/stati', '/statya', '/post'],
      about: ['/o-kompanii', '/about', '/o-nas', '/company', '/o_nas'],
      contacts: ['/contacts', '/kontakty', '/contact'],
    },
  },

  // п.7 — GEO/AEO (попадание в нейровыдачу ИИ-моделей). Косвенные сигналы из
  // топ-выдачи (featured snippet / PAA), проверка наличия нужных JSON-LD типов,
  // рекомендации по AEO-формату ответов.
  geoAeo: {
    enabled: true,
    // Сколько приоритетных запросов проверяем на SERP-фичи (бережём лимиты ключа).
    maxProbeQueries: 10,
    // Минимум показов запроса, чтобы попасть в probe.
    minImpressions: 30,
    // JSON-LD типы, критичные для AI Overviews / нейровыдачи.
    aiCriticalSchemaTypes: ['Article', 'BlogPosting', 'FAQPage', 'HowTo',
      'Speakable', 'AboutPage', 'Organization', 'Person', 'BreadcrumbList'],
    // Длина TL;DR-ответа (слов) для AEO-формата.
    tldrWords: { min: 40, max: 80 },
  },

  // п.8 — Аудит микроразметки. Использует structured_data (jsonld+microdata) из
  // parser/hiddenLayers, собранный в eat-слое. Проверяет наличие/валидность
  // ключевых типов и полей, предлагает готовые JSON-LD сниппеты (geoSchema).
  schemaAudit: {
    enabled: true,
    // Обязательные поля по типам (для валидации «битости» разметки).
    requiredFields: {
      Product: ['name', 'image', 'offers'],
      Offer: ['price', 'priceCurrency', 'availability'],
      Article: ['headline', 'author', 'datePublished'],
      BlogPosting: ['headline', 'author', 'datePublished'],
      FAQPage: ['mainEntity'],
      Organization: ['name', 'url'],
      BreadcrumbList: ['itemListElement'],
    },
    // Какие типы микроразметки ждём на каком шаблоне (gap-детектор).
    expectedByTemplate: {
      catalog: ['BreadcrumbList', 'ItemList', 'Organization'],
      product: ['Product', 'Offer', 'BreadcrumbList', 'AggregateRating'],
      service: ['Service', 'BreadcrumbList', 'Organization', 'FAQPage'],
      blog: ['Article', 'BlogPosting', 'BreadcrumbList', 'FAQPage'],
      about: ['Organization', 'AboutPage'],
      contacts: ['Organization', 'LocalBusiness'],
    },
  },

  // ТЗ п.3 — «План действий» с железными аргументами. Детерминированный слой
  // СВЯЗЫВАЕТ уже собранные срезы (CTR-аномалии, striking distance, page decay,
  // каннибализация, контент-гэпы, мета-аудит) в конкретные, посчитанные
  // рекомендации: что именно поменять, на что и какой ожидаемый эффект в
  // кликах (по эталонной CTR-кривой commercial.ctrBenchmark). Для конкретных
  // значений мета-тегов (было→стало) переиспользует мета-генератор + анализ
  // выдачи xmlstock + парсинг страниц (pageMetaAudit.regenerateMetaForPages).
  actionPlan: {
    enabled: true,
    // Сколько приоритетных страниц получают КОНКРЕТНЫЕ мета-теги (LLM + SERP).
    // Тяжёлый шаг (Gemini + xmlstock) — держим в разумных рамках по времени.
    maxMetaTargets: 6,
    // Запускать ли LLM-генерацию конкретных мета-тегов в фоне анализа. Если
    // ключи LLM не заданы — graceful: остаётся детерминированная диагностика
    // «было» + расчёт недобора кликов без значения «стало».
    autoMeta: true,
    // Сколько точек быстрого роста (striking distance) выводим с расчётом
    // ожидаемых дополнительных кликов.
    maxStrikingDistance: 15,
    // Целевая позиция, до которой считаем потенциал по striking distance.
    targetPosition: 3,
    // Сколько затухающих страниц предлагаем к content refresh.
    maxContentRefresh: 10,
    // Сколько конкретных тем статей выносим в план (из контент-гэпов).
    maxArticleTopics: 10,
    // Минимальные показы запроса, чтобы попасть в расчёт потенциала кликов.
    minImpressions: 30,
    // Запас CTR (доля 0..1) для позиций хуже эталонной таблицы (>10).
    tailCtr: 0.01,
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

  // Полные периоды и оценка свежести данных (ТЗ §5.1, §5.2 — KPI и AI-выводы
  // должны строиться только по завершённым месяцам; текущий месяц помечаем
  // как partial и в headline не используем).
  //
  //   timezone — таймзона, в которой определяется граница месяца. Используем
  //              UTC по умолчанию, чтобы матчиться с ISO-датами snapshot'ов.
  //   completeMonthLagDays — количество дней после конца месяца, которое
  //              нужно подождать, прежде чем считать его «полным» (источники
  //              отдают данные с задержкой — GSC ~2-3д, Yandex ~1-2д).
  //   freshness.staleAfterHours — sync старее этого считается stale.
  //   freshness.errorAfterHours — sync старее этого считается error.
  //   freshness.gapDays — допустимый зазор между expected_max_date и
  //              source_max_date, при превышении которого статус становится
  //              'gap' (данные в источнике застряли).
  periods: {
    timezone: 'UTC',
    completeMonthLagDays: 3,
    freshness: {
      staleAfterHours: 36,
      errorAfterHours: 96,
      gapDays: 2,
    },
  },

  // Блок «Съём позиций внутри проекта» (см. positionBridge / positions-секция
  // в ProjectDetailPage). Раздаётся вместе с GET /projects/:id для UI.
  //   topsBuckets — границы топов для агрегата tops-distribution и
  //   stacked-area-графика «График по топам».
  //   defaultEngine/defaultDevice — дефолты для связанного position_projects.
  //   sharedKeywordsLimit — сколько строк таблицы запросов отдаём в
  //   публичную (шаринг) секцию (полные тысячи строк туда не отдаём, чтобы
  //   не перегружать клиентский режим и не плодить PII в публичной ссылке).
  positions: {
    topsBuckets: [3, 5, 10, 20, 50, 100],
    defaultEngine: 'both',
    defaultDevice: 'desktop',
    sharedKeywordsLimit: 50,
    seriesGranularity: 'day',
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

/**
 * Сконфигурирован ли Yandex OAuth (Яндекс.Вебмастер). Симметрично
 * getGoogleOAuthConfig: если не задан — Webmaster-эндпоинты деградируют с
 * понятной ошибкой, остальной функционал проектов работает.
 * Секреты читаются из process.env (без правки .env.example):
 *   YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET, YANDEX_OAUTH_REDIRECT_URI.
 */
function getYandexOAuthConfig() {
  const clientId = (process.env.YANDEX_CLIENT_ID || '').trim();
  const clientSecret = (process.env.YANDEX_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.YANDEX_OAUTH_REDIRECT_URI || '').trim();
  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret && redirectUri),
  };
}

module.exports = { getProjectsConfig, getGoogleOAuthConfig, getYandexOAuthConfig, deepFreeze };
