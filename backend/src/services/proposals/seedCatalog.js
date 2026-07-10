'use strict';

/**
 * proposals/seedCatalog.js — справочник модулей и задач конструктора КП
 * («Фронт работ», данные SEO_Front_2026.xlsx) + отдельный модуль №11
 * «Чеклист Google 2026».
 *
 * Seed идемпотентный: наполняет proposal_modules / proposal_module_tasks
 * только если справочник пуст (пользовательские правки не перетираются —
 * каталог редактируется через API и должен сохранять изменения).
 *
 * priority: high | medium | low.
 */

const db = require('../../config/db');

const MODULES = [
  {
    id: 1, name: 'Базовый анализ', estimated_days: '1–3 дня',
    description: 'Стартовая диагностика проекта: текущие позиции, трафик, индексация, базовые метрики.',
    tasks: [
      { id: '1.1', title: 'Анализ текущих позиций сайта', description: 'Съём позиций по ядру в Яндекс и Google, фиксация стартовой точки.', tool: 'Topvisor / Key Collector', priority: 'high' },
      { id: '1.2', title: 'Анализ трафика и источников', description: 'Разбор органического трафика, поведенческих метрик, точек входа.', tool: 'Яндекс.Метрика / GA4', priority: 'high' },
      { id: '1.3', title: 'Проверка индексации сайта', description: 'Сравнение проиндексированных страниц с фактическими, поиск мусора в индексе.', tool: 'GSC / Яндекс.Вебмастер', priority: 'high' },
      { id: '1.4', title: 'Аудит коммерческих факторов', description: 'Контакты, цены, доставка, отзывы, гарантии — сравнение с ТОПом.', tool: 'Чек-лист', priority: 'medium' },
      { id: '1.5', title: 'Анализ санкций и фильтров', description: 'Проверка на фильтры Яндекса и Google, история доменного имени.', tool: 'Вебмастер / Xtool', priority: 'medium' },
      { id: '1.6', title: 'Формирование стартового отчёта', description: 'Сводный документ по итогам базового анализа с приоритетами работ.', tool: 'Google Docs', priority: 'low' },
    ],
  },
  {
    id: 2, name: 'Анализ конкурентов', estimated_days: '2–5 дней',
    description: 'Изучение лидеров ниши: структура, семантика, контент, ссылочный профиль.',
    tasks: [
      { id: '2.1', title: 'Определение конкурентов в выдаче', description: 'Список прямых конкурентов по видимости в Яндекс и Google.', tool: 'Keys.so / Ahrefs', priority: 'high' },
      { id: '2.2', title: 'Анализ структуры сайтов конкурентов', description: 'Разбор разделов, категорий, посадочных страниц лидеров ниши.', tool: 'Screaming Frog', priority: 'high' },
      { id: '2.3', title: 'Сравнение семантики с конкурентами', description: 'Поиск упущенных кластеров запросов, по которым конкуренты получают трафик.', tool: 'Keys.so', priority: 'high' },
      { id: '2.4', title: 'Анализ контента конкурентов', description: 'Объём, форматы, структура текстов на страницах ТОПа.', tool: 'Miratext / вручную', priority: 'medium' },
      { id: '2.5', title: 'Анализ ссылочного профиля конкурентов', description: 'Доноры, анкор-листы, динамика ссылочной массы лидеров.', tool: 'Ahrefs / CheckTrust', priority: 'medium' },
      { id: '2.6', title: 'Сводная таблица конкурентного анализа', description: 'Итоговая матрица «мы vs конкуренты» с выводами и точками роста.', tool: 'Google Sheets', priority: 'low' },
    ],
  },
  {
    id: 3, name: 'Технический аудит', estimated_days: '3–7 дней',
    description: 'Полная техническая диагностика: краулинг, скорость, дубли, микроразметка.',
    tasks: [
      { id: '3.1', title: 'Краулинг сайта и поиск ошибок', description: 'Полный обход сайта: битые ссылки, редиректы, коды ответов.', tool: 'Screaming Frog', priority: 'high' },
      { id: '3.2', title: 'Проверка robots.txt и sitemap.xml', description: 'Корректность директив, полнота карты сайта, конфликты правил.', tool: 'Вебмастер / GSC', priority: 'high' },
      { id: '3.3', title: 'Поиск дублей страниц и мета-тегов', description: 'Дубликаты title/description/h1, канонизация, GET-параметры.', tool: 'Screaming Frog', priority: 'high' },
      { id: '3.4', title: 'Аудит скорости загрузки', description: 'Core Web Vitals: LCP, INP, CLS для мобильных и десктопа.', tool: 'PageSpeed Insights', priority: 'high' },
      { id: '3.5', title: 'Проверка мобильной версии', description: 'Адаптивность, mobile-first индексация, юзабилити на смартфонах.', tool: 'Mobile-Friendly Test', priority: 'high' },
      { id: '3.6', title: 'Аудит микроразметки', description: 'Schema.org: Organization, Product, BreadcrumbList, FAQ и валидность.', tool: 'Rich Results Test', priority: 'medium' },
      { id: '3.7', title: 'Проверка ЧПУ и структуры URL', description: 'Читаемость адресов, вложенность, транслитерация, единообразие.', tool: 'Screaming Frog', priority: 'medium' },
      { id: '3.8', title: 'Аудит внутренних редиректов', description: 'Цепочки 301/302, редиректы внутри перелинковки, потери веса.', tool: 'Screaming Frog', priority: 'medium' },
      { id: '3.9', title: 'Проверка HTTPS и зеркал', description: 'Сертификат, склейка www/без-www, смешанный контент.', tool: 'SSL Labs', priority: 'medium' },
      { id: '3.10', title: 'Аудит пагинации и фильтров', description: 'Индексация страниц пагинации, фасетная навигация, canonical.', tool: 'Вручную', priority: 'medium' },
      { id: '3.11', title: 'Анализ логов сервера', description: 'Как боты обходят сайт, краулинговый бюджет, ошибки 5xx.', tool: 'Screaming Frog Log Analyzer', priority: 'low' },
      { id: '3.12', title: 'Итоговое ТЗ на техправки', description: 'Приоритизированный список технических задач для разработчиков.', tool: 'Google Docs', priority: 'high' },
    ],
  },
  {
    id: 4, name: 'Внедрение правок', estimated_days: '7–21 день',
    description: 'Устранение проблем по итогам аудита: техника, мета-теги, скорость, разметка.',
    tasks: [
      { id: '4.1', title: 'Исправление критических ошибок', description: 'Устранение блокирующих проблем: 5xx, недоступность, ошибки индексации.', tool: 'Разработка', priority: 'high' },
      { id: '4.2', title: 'Настройка редиректов', description: 'Внедрение карты 301-редиректов, устранение цепочек.', tool: '.htaccess / nginx', priority: 'high' },
      { id: '4.3', title: 'Устранение дублей', description: 'Canonical, noindex, склейка дублей страниц и мета-тегов.', tool: 'CMS / разработка', priority: 'high' },
      { id: '4.4', title: 'Оптимизация мета-тегов', description: 'Массовое обновление title/description по шаблонам и вручную.', tool: 'CMS', priority: 'high' },
      { id: '4.5', title: 'Оптимизация скорости загрузки', description: 'Сжатие изображений, кеширование, lazy-load, минификация.', tool: 'Разработка', priority: 'medium' },
      { id: '4.6', title: 'Внедрение микроразметки', description: 'Schema.org на ключевые шаблоны страниц.', tool: 'Разработка', priority: 'medium' },
      { id: '4.7', title: 'Правка robots.txt и sitemap', description: 'Обновление директив и автогенерация актуальной карты сайта.', tool: 'CMS / разработка', priority: 'medium' },
      { id: '4.8', title: 'Настройка перелинковки', description: 'Блоки «похожие товары/статьи», хлебные крошки, контекстные ссылки.', tool: 'CMS', priority: 'medium' },
      { id: '4.9', title: 'Доработка мобильной версии', description: 'Исправление ошибок адаптива по итогам аудита.', tool: 'Разработка', priority: 'medium' },
      { id: '4.10', title: 'Контроль внедрения', description: 'Проверка каждой внедрённой правки, повторный краулинг.', tool: 'Screaming Frog', priority: 'high' },
    ],
  },
  {
    id: 5, name: 'Сбор семантики', estimated_days: '7 дней',
    description: 'Полное семантическое ядро: сбор, чистка, кластеризация, распределение по страницам.',
    tasks: [
      { id: '5.1', title: 'Сбор маркерных запросов', description: 'Базовые маркеры по всем направлениям бизнеса.', tool: 'Wordstat / Key Collector', priority: 'high' },
      { id: '5.2', title: 'Расширение семантического ядра', description: 'Парсинг подсказок, похожих запросов, семантики конкурентов.', tool: 'Key Collector / Keys.so', priority: 'high' },
      { id: '5.3', title: 'Чистка от мусорных запросов', description: 'Удаление нецелевых, информационных-нерелевантных и стоп-слов.', tool: 'Key Collector', priority: 'high' },
      { id: '5.4', title: 'Кластеризация запросов', description: 'Группировка по ТОПу выдачи (hard/soft) на посадочные страницы.', tool: 'KeyAssort / Arsenkin', priority: 'high' },
      { id: '5.5', title: 'Съём частотности и коммерциализации', description: 'Точная частотность, сезонность, коммерческий интент по кластерам.', tool: 'Wordstat / Arsenkin', priority: 'medium' },
      { id: '5.6', title: 'Карта релевантности', description: 'Распределение кластеров по существующим и новым страницам.', tool: 'Google Sheets', priority: 'high' },
    ],
  },
  {
    id: 6, name: 'Создание страниц', estimated_days: '3–4 мес.',
    description: 'Создание и оптимизация посадочных страниц под собранные кластеры.',
    tasks: [
      { id: '6.1', title: 'ТЗ на новые посадочные страницы', description: 'Структура, семантика, LSI, объём текста для каждой страницы.', tool: 'Miratext / вручную', priority: 'high' },
      { id: '6.2', title: 'Проектирование структуры каталога', description: 'Новые категории, подкатегории, теговые страницы под кластеры.', tool: 'Mind-map', priority: 'high' },
      { id: '6.3', title: 'Написание текстов для категорий', description: 'Оптимизированные тексты под коммерческие кластеры.', tool: 'Копирайтинг', priority: 'high' },
      { id: '6.4', title: 'Создание теговых страниц', description: 'SEO-фильтры и теговые посадочные под средне- и низкочастотку.', tool: 'CMS', priority: 'medium' },
      { id: '6.5', title: 'Оптимизация карточек товаров/услуг', description: 'Шаблоны мета-тегов, уникальные описания, характеристики.', tool: 'CMS', priority: 'medium' },
      { id: '6.6', title: 'Оптимизация существующих страниц', description: 'Дооптимизация текущих посадочных по карте релевантности.', tool: 'CMS', priority: 'high' },
      { id: '6.7', title: 'Публикация и вёрстка страниц', description: 'Размещение контента, вёрстка, внутренние ссылки.', tool: 'CMS', priority: 'medium' },
      { id: '6.8', title: 'Добавление в индекс', description: 'Отправка новых страниц на переобход, обновление sitemap.', tool: 'Вебмастер / GSC', priority: 'medium' },
      { id: '6.9', title: 'Контроль индексации новых страниц', description: 'Мониторинг попадания в индекс и первичных позиций.', tool: 'Вебмастер / GSC', priority: 'medium' },
      { id: '6.10', title: 'A/B-доработка посадочных', description: 'Итерации по структуре и контенту слабых страниц.', tool: 'Метрика', priority: 'low' },
    ],
  },
  {
    id: 7, name: 'Позиционирование', estimated_days: 'Всегда',
    description: 'Постоянная работа с позициями: мониторинг, точечная дооптимизация, поведенческие.',
    tasks: [
      { id: '7.1', title: 'Ежемесячный съём позиций', description: 'Регулярный мониторинг ядра в Яндекс и Google.', tool: 'Topvisor', priority: 'high' },
      { id: '7.2', title: 'Анализ страниц в зоне роста', description: 'Страницы на 4–20 позициях — кандидаты на точечную дооптимизацию.', tool: 'Topvisor / GSC', priority: 'high' },
      { id: '7.3', title: 'Дооптимизация текстов', description: 'Правка текстов по текстовым анализаторам относительно ТОПа.', tool: 'Miratext / JustMagic', priority: 'high' },
      { id: '7.4', title: 'Работа с релевантностью title', description: 'Итеративное улучшение заголовков по запросам зоны роста.', tool: 'CMS', priority: 'medium' },
      { id: '7.5', title: 'Улучшение поведенческих факторов', description: 'Снижение отказов, рост глубины и времени на сайте.', tool: 'Метрика / Вебвизор', priority: 'medium' },
      { id: '7.6', title: 'Работа со сниппетами', description: 'CTR-оптимизация: быстрые ссылки, эмодзи, разметка, favicon.', tool: 'Вебмастер', priority: 'medium' },
      { id: '7.7', title: 'Анализ каннибализации', description: 'Поиск и устранение конкуренции страниц за один запрос.', tool: 'GSC / Topvisor', priority: 'medium' },
      { id: '7.8', title: 'Мониторинг апдейтов алгоритмов', description: 'Отслеживание апдейтов Яндекс/Google и реакция на просадки.', tool: 'Пиксель Тулс', priority: 'medium' },
      { id: '7.9', title: 'Актуализация контента', description: 'Обновление устаревших страниц: цены, даты, факты.', tool: 'CMS', priority: 'low' },
      { id: '7.10', title: 'Отчёт по динамике позиций', description: 'Ежемесячный отчёт: рост/падение, причины, план.', tool: 'Google Sheets', priority: 'medium' },
    ],
  },
  {
    id: 8, name: 'Ссылки и бустеры', estimated_days: 'Всегда',
    description: 'Наращивание ссылочной массы и внешних сигналов: крауд, аутрич, каталоги, PR.',
    tasks: [
      { id: '8.1', title: 'Стратегия ссылочного продвижения', description: 'План наращивания ссылок: типы, темпы, анкор-лист.', tool: 'Ahrefs / CheckTrust', priority: 'high' },
      { id: '8.2', title: 'Регистрация в каталогах и справочниках', description: 'Яндекс.Бизнес, 2GIS, отраслевые каталоги, агрегаторы.', tool: 'Вручную', priority: 'high' },
      { id: '8.3', title: 'Крауд-маркетинг', description: 'Ссылки и упоминания на форумах, в Q&A, отзовиках.', tool: 'Крауд-биржи', priority: 'medium' },
      { id: '8.4', title: 'Аутрич-размещения', description: 'Гостевые статьи на тематических площадках с вечными ссылками.', tool: 'Miralinks / PRNews', priority: 'high' },
      { id: '8.5', title: 'Закупка ссылок на биржах', description: 'Отбор доноров по трасту, тематике, трафику.', tool: 'Gogetlinks / Sape', priority: 'medium' },
      { id: '8.6', title: 'Работа с упоминаниями бренда', description: 'Превращение безссылочных упоминаний в ссылки, рост брендового спроса.', tool: 'Google Alerts', priority: 'low' },
      { id: '8.7', title: 'Анализ и чистка токсичных ссылок', description: 'Мониторинг профиля, отклонение спамных доноров.', tool: 'Ahrefs / Disavow', priority: 'medium' },
      { id: '8.8', title: 'Соцсигналы и микроразметка шаринга', description: 'OG-разметка, кнопки шаринга, активность в соцсетях.', tool: 'CMS / SMM', priority: 'low' },
      { id: '8.9', title: 'PR-публикации', description: 'Размещения в СМИ и на крупных порталах для E-E-A-T.', tool: 'Pressfeed', priority: 'medium' },
      { id: '8.10', title: 'Отчёт по ссылочной динамике', description: 'Ежемесячный контроль прироста и качества ссылочной массы.', tool: 'Ahrefs', priority: 'medium' },
    ],
  },
  {
    id: 9, name: 'GEO / AEO', estimated_days: 'Всегда',
    description: 'Оптимизация под генеративные ответы (AI Overviews, Алиса, ChatGPT) и answer-движки.',
    tasks: [
      { id: '9.1', title: 'Аудит видимости в AI-ответах', description: 'Проверка, цитируется ли сайт в AI Overviews, Алисе, Perplexity.', tool: 'Вручную / сервисы GEO', priority: 'high' },
      { id: '9.2', title: 'Оптимизация под featured snippets', description: 'Структурирование ответов: списки, таблицы, прямые определения.', tool: 'CMS', priority: 'high' },
      { id: '9.3', title: 'FAQ-блоки и разметка FAQPage', description: 'Вопрос-ответные блоки на ключевых страницах с разметкой.', tool: 'Schema.org', priority: 'high' },
      { id: '9.4', title: 'Создание answer-контента', description: 'Страницы с прямыми ответами на вопросы аудитории.', tool: 'Копирайтинг', priority: 'medium' },
      { id: '9.5', title: 'Оптимизация E-E-A-T сигналов', description: 'Авторство, экспертиза, страницы «О компании», сертификаты.', tool: 'CMS', priority: 'high' },
      { id: '9.6', title: 'Разметка HowTo и Article', description: 'Структурированные данные для инструкций и статей.', tool: 'Schema.org', priority: 'medium' },
      { id: '9.7', title: 'Оптимизация под голосовой поиск', description: 'Разговорные запросы, локальные интенты, краткие ответы.', tool: 'Вручную', priority: 'low' },
      { id: '9.8', title: 'llms.txt и доступность для AI-краулеров', description: 'Настройка доступа GPTBot, PerplexityBot, YandexGPT к контенту.', tool: 'robots.txt / llms.txt', priority: 'medium' },
      { id: '9.9', title: 'Упоминания в источниках AI', description: 'Присутствие на площадках, которые цитируют LLM: Wiki-форматы, отзовики.', tool: 'Аутрич', priority: 'medium' },
      { id: '9.10', title: 'Локальное SEO (Яндекс.Бизнес / GBP)', description: 'Карточки организации, отзывы, локальная выдача и карты.', tool: 'Яндекс.Бизнес / GBP', priority: 'medium' },
      { id: '9.11', title: 'Мониторинг GEO-метрик', description: 'Динамика цитируемости в генеративных ответах по месяцам.', tool: 'Сервисы GEO', priority: 'low' },
    ],
  },
  {
    id: 10, name: 'Масштабирование', estimated_days: 'Всегда',
    description: 'Рост охвата: новые направления, контент-хабы, программатик-страницы, регионы.',
    tasks: [
      { id: '10.1', title: 'Поиск новых точек роста', description: 'Анализ упущенного спроса и смежных ниш для расширения.', tool: 'Keys.so / Wordstat', priority: 'high' },
      { id: '10.2', title: 'Контент-план блога', description: 'Информационный трафик: план статей под кластеры вопросов.', tool: 'Google Sheets', priority: 'high' },
      { id: '10.3', title: 'Производство статей', description: 'Регулярный выпуск экспертных статей по контент-плану.', tool: 'Копирайтинг', priority: 'medium' },
      { id: '10.4', title: 'Региональное продвижение', description: 'Поддомены/подпапки под регионы, региональная семантика.', tool: 'CMS', priority: 'medium' },
      { id: '10.5', title: 'Программатик-страницы', description: 'Массовая генерация посадочных по шаблону (город × услуга).', tool: 'Разработка', priority: 'medium' },
      { id: '10.6', title: 'Контент-хабы и кластеры', description: 'Тематические хабы со связанной перелинковкой pillar/cluster.', tool: 'CMS', priority: 'medium' },
      { id: '10.7', title: 'Развитие конверсионных элементов', description: 'Калькуляторы, квизы, подборщики — трафик и поведенческие.', tool: 'Разработка', priority: 'low' },
      { id: '10.8', title: 'Видео и мультимедиа-контент', description: 'Видеообзоры, YouTube-SEO, попадание в видео-колдунщики.', tool: 'YouTube', priority: 'low' },
      { id: '10.9', title: 'Квартальная стратегическая сессия', description: 'Пересмотр стратегии по итогам квартала, новые гипотезы.', tool: 'Встреча', priority: 'medium' },
    ],
  },
  {
    id: 11, name: 'Чеклист Google 2026', estimated_days: 'Всегда',
    description: 'Актуальные требования Google 2026: AI Overviews, E-E-A-T, Core Web Vitals, полезный контент.',
    tasks: [
      { id: '11.1', title: 'Соответствие Helpful Content', description: 'Аудит контента на полезность: people-first, отсутствие переоптимизации.', tool: 'Чек-лист Google', priority: 'high' },
      { id: '11.2', title: 'Оптимизация под AI Overviews', description: 'Структура ответов и цитируемость в AI-блоке выдачи Google.', tool: 'GSC / вручную', priority: 'high' },
      { id: '11.3', title: 'Core Web Vitals 2026', description: 'LCP < 2.5s, INP < 200ms, CLS < 0.1 на реальных пользователях.', tool: 'CrUX / PageSpeed', priority: 'high' },
      { id: '11.4', title: 'E-E-A-T: опыт и экспертиза', description: 'Автор с опытом, подтверждённая экспертиза, first-hand контент.', tool: 'Чек-лист', priority: 'high' },
      { id: '11.5', title: 'Разметка author и Organization', description: 'Связка авторов, организации и профилей через structured data.', tool: 'Schema.org', priority: 'medium' },
      { id: '11.6', title: 'Борьба с scaled content abuse', description: 'Проверка на массовый неуникальный/AI-контент без ценности.', tool: 'Аудит контента', priority: 'high' },
      { id: '11.7', title: 'Site reputation abuse', description: 'Проверка сторонних разделов сайта на паразитный контент.', tool: 'Аудит', priority: 'medium' },
      { id: '11.8', title: 'Мобильная выдача и mobile-first', description: 'Полный паритет мобильной версии с десктопной.', tool: 'GSC', priority: 'medium' },
      { id: '11.9', title: 'Обновление устаревшего контента', description: 'Freshness-сигналы: регулярное обновление ключевых страниц.', tool: 'CMS', priority: 'medium' },
      { id: '11.10', title: 'Мониторинг Google Search Status', description: 'Отслеживание core-апдейтов и реакция в течение 48 часов.', tool: 'Search Status Dashboard', priority: 'low' },
    ],
  },
];

/**
 * Идемпотентный seed: выполняется на старте backend. Наполняет справочник
 * только если он пуст — пользовательские правки каталога сохраняются.
 */
async function seedProposalCatalog() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM proposal_modules');
  if (rows[0].n > 0) return false;

  for (const m of MODULES) {
    await db.query(
      `INSERT INTO proposal_modules (id, name, description, estimated_days, sort_order)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [m.id, m.name, m.description, m.estimated_days, m.id],
    );
    let i = 0;
    for (const t of m.tasks) {
      i += 1;
      await db.query(
        `INSERT INTO proposal_module_tasks (id, module_id, title, description, tool, priority, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [t.id, m.id, t.title, t.description, t.tool, t.priority, i],
      );
    }
  }
  // SERIAL-последовательность должна знать про вручную вставленные id.
  await db.query(`SELECT setval(pg_get_serial_sequence('proposal_modules','id'), (SELECT MAX(id) FROM proposal_modules))`);
  return true;
}

module.exports = { seedProposalCatalog, MODULES };
