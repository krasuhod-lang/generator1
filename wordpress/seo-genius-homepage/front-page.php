<?php
/**
 * SEO Genius public marketing homepage.
 * Copy is intentionally self-contained so the theme can be installed on a
 * separate WordPress marketing site while the authenticated SPA stays intact.
 */
if (!defined('ABSPATH')) {
    exit;
}

$app_base = defined('SEO_GENIUS_APP_URL') ? rtrim(SEO_GENIUS_APP_URL, '/') : home_url();
$login_url = defined('SEO_GENIUS_LOGIN_URL') ? SEO_GENIUS_LOGIN_URL : $app_base . '/login';
$register_url = defined('SEO_GENIUS_REGISTER_URL') ? SEO_GENIUS_REGISTER_URL : $app_base . '/register';
$home_url = home_url('/');
$faqs = array(
    array(
        'question' => 'Что такое лимиты в SEO Genius?',
        'answer' => 'Лимиты — это понятный ресурс для работы AI-инструментов: исследований, анализа, генерации контента и подготовки отчётов. Пакет подбирается под объём задач и количество проектов.',
    ),
    array(
        'question' => 'Можно ли использовать систему для Google и Яндекса?',
        'answer' => 'Да. Пайплайн учитывает поисковый интент, семантику, коммерческие и информационные сценарии, а также сигналы Google и Яндекса, когда они доступны в проекте.',
    ),
    array(
        'question' => 'Чем платформа отличается от обычного AI-копирайтера?',
        'answer' => 'SEO Genius работает не только с текстом. Система связывает исследование ниши, факты, доказательства, E-E-A-T, LSI, структуру, контроль качества, проекты и отчётность в единый процесс.',
    ),
    array(
        'question' => 'Нужно ли менять рабочий процесс команды?',
        'answer' => 'Нет. Платформа добавляет единый контур контроля и автоматизации, а команда получает готовые результаты, статусы, историю задач и точки роста в одном рабочем пространстве.',
    ),
);
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <?php wp_head(); ?>
</head>
<body <?php body_class('sg-site'); ?>>
<?php if (function_exists('wp_body_open')) { wp_body_open(); } ?>
<main class="sg-home">
    <header class="sg-header">
        <div class="sg-container sg-nav">
            <a class="sg-brand" href="<?php echo esc_url($home_url); ?>" aria-label="SEO Genius — на главную">
                <span class="sg-mark" aria-hidden="true"><span></span><span></span><span></span></span>
                <span class="sg-wordmark">SEO <strong>GENIUS</strong></span>
            </a>
            <nav class="sg-nav-links" aria-label="Основная навигация">
                <a href="#platform">Платформа</a>
                <a href="#workflow">Как работает</a>
                <a href="#plans">Лимиты</a>
                <a href="#faq">FAQ</a>
            </nav>
            <div class="sg-nav-cta">
                <a class="sg-login" href="<?php echo esc_url($login_url); ?>">Войти</a>
                <a class="sg-button sg-button-primary sg-button-small" href="<?php echo esc_url($register_url); ?>">Начать бесплатно <span>↗</span></a>
            </div>
        </div>
    </header>

    <section class="sg-hero">
        <div class="sg-container sg-hero-grid">
            <div class="sg-copy">
                <div class="sg-eyebrow">AI SEO OS для команд, которые растут</div>
                <h1>Создавайте контент, который <em>превращает поиск в рост.</em></h1>
                <p>SEO Genius объединяет исследование спроса, экспертную генерацию и аналитику в один управляемый pipeline — от первого запроса до понятного результата.</p>
                <div class="sg-actions">
                    <a class="sg-button sg-button-primary" href="<?php echo esc_url($register_url); ?>">Попробовать бесплатно <span>↗</span></a>
                    <a class="sg-button sg-button-ghost" href="#platform">Посмотреть платформу <span>▶</span></a>
                </div>
                <div class="sg-note"><b>✓</b> Без банковской карты на старте <span> · </span> Русский язык и кириллица native</div>
            </div>

            <div class="sg-preview" aria-label="Пример рабочей панели SEO Genius">
                <div class="sg-window">
                    <div class="sg-window-bar"><span class="sg-dots"><i></i><i></i><i></i></span><span>SEO Genius / Executive view</span><span>•••</span></div>
                    <div class="sg-window-body">
                        <div class="sg-dashboard-top"><div><span class="sg-caption">ОРГАНИЧЕСКИЙ РОСТ</span><strong>+38.4%</strong><small>за последние 90 дней <b>↗</b></small></div><span class="sg-period">90 дней⌄</span></div>
                        <svg class="sg-chart" viewBox="0 0 470 170" role="img" aria-label="График роста органического трафика">
                            <defs><linearGradient id="sg-area-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b7dff" stop-opacity=".34"/><stop offset="1" stop-color="#8b7dff" stop-opacity="0"/></linearGradient></defs>
                            <g class="sg-chart-grid"><path d="M0 10H470"/><path d="M0 50H470"/><path d="M0 90H470"/><path d="M0 130H470"/><path d="M0 169H470"/></g>
                            <path class="sg-chart-area" d="M0 151 C35 145 44 130 70 133 S111 139 135 112 S170 96 190 103 S232 90 246 82 S276 96 302 72 S331 67 347 60 S376 69 393 45 S430 35 470 13 L470 170 L0 170Z"/>
                            <path class="sg-chart-line" d="M0 151 C35 145 44 130 70 133 S111 139 135 112 S170 96 190 103 S232 90 246 82 S276 96 302 72 S331 67 347 60 S376 69 393 45 S430 35 470 13"/>
                            <circle class="sg-chart-point" cx="393" cy="45" r="5"/><circle class="sg-chart-point" cx="470" cy="13" r="5"/>
                        </svg>
                        <div class="sg-chart-labels"><span>Май</span><span>Июн</span><span>Июл</span><span>Авг</span><span>Сен</span><span>Окт</span></div>
                        <div class="sg-metrics"><div class="sg-metric"><b>142</b><small>Запроса в работе</small><strong>+24%</strong></div><div class="sg-metric"><b>8.7</b><small>Средний E-E-A-T</small><strong>+1.4</strong></div><div class="sg-metric"><b>64</b><small>Точки роста</small><strong>новые</strong></div></div>
                    </div>
                </div>
                <div class="sg-pill sg-pill-top"><span class="sg-pill-icon">✦</span><div><b>AI quality gate</b><small>12 факторов проверено</small></div><span class="sg-pill-check">✓</span></div>
                <div class="sg-pill sg-pill-bottom"><span class="sg-pulse"></span><div><b>Pipeline active</b><small>Контент создаётся</small></div></div>
            </div>
        </div>
        <div class="sg-container sg-proof-strip"><span>Один контур для всей SEO-команды</span><div class="sg-proof-list"><span><b>11</b> AI-инструментов</span><i class="sg-separator"></i><span><b>Google</b> + <b>Яндекс</b></span><i class="sg-separator"></i><span><b>E-E-A-T</b> в каждом тексте</span><i class="sg-separator"></i><span>Данные под контролем</span></div></div>
    </section>

    <section id="platform" class="sg-paper-section">
        <div class="sg-container">
            <div class="sg-section-head"><div><div class="sg-eyebrow">Одна система вместо разрозненных инструментов</div><h2>Весь путь от сигнала<br><span>до результата.</span></h2></div><p>Не просто генератор текста. Платформа, которая понимает, зачем создаётся материал, для кого он нужен и как измерить его вклад в рост.</p></div>
            <div class="sg-feature-grid">
                <article class="sg-feature"><div class="sg-index">01 <span>RESEARCH</span></div><h3>Находим темы,<br><em>за которыми есть спрос</em></h3><p>Собираем поисковые сигналы, анализируем конкурентов, определяем intent и строим приоритеты, а не список случайных идей.</p><div class="sg-bars"><div class="sg-bar-row"><span>commercial intent</span><span class="sg-bar"><i style="width:86%"></i></span><b>86</b></div><div class="sg-bar-row"><span>growth potential</span><span class="sg-bar"><i style="width:72%"></i></span><b>72</b></div><div class="sg-bar-row"><span>content gap</span><span class="sg-bar"><i style="width:64%"></i></span><b>64</b></div><small>↗ demand signal</small></div></article>
                <article class="sg-feature"><div class="sg-index">02 <span>STRATEGY</span></div><h3>Думаем<br><em>как SEO-стратег</em></h3><p>Единый контекст проекта, история публикаций и правила бренда помогают не повторять уже написанное и усиливать topical authority.</p><div class="sg-orbit"><b>SEO<br>OS</b></div></article>
                <article class="sg-feature"><div class="sg-index">03 <span>GENERATE</span></div><h3>Пишем<br><em>как эксперт</em></h3><p>E-E-A-T, факты, сравнения, таблицы и понятная структура проходят через quality gates до публикации.</p><div class="sg-expert-card"><div><strong>Content brief</strong><small> · verified by AI</small></div><div class="sg-expert-line"></div><div class="sg-expert-line"></div><div class="sg-expert-line short"></div><div class="sg-tags"><span>E-E-A-T</span><span>FACTS</span><span>LSI</span></div></div></article>
                <article class="sg-feature"><div class="sg-wide-copy"><div class="sg-index">04 <span>MEASURE</span></div><h3>Видим, что делать дальше</h3><p>Отчёты превращают массив данных в конкретные точки роста: что исправить, что написать и куда направить следующий лимит.</p><a class="sg-inline" href="<?php echo esc_url($register_url); ?>">Открыть рабочее пространство <span>→</span></a></div><div class="sg-growth"><strong>+38%</strong><small>organic growth</small></div></article>
            </div>
        </div>
    </section>

    <section id="workflow" class="sg-dark-section sg-workflow">
        <div class="sg-container sg-workflow-grid"><div class="sg-workflow-copy"><div class="sg-eyebrow">Как работает система</div><h2>Сложная работа.<br><span>Простой путь.</span></h2><p>Вы задаёте направление — SEO Genius связывает исследование, генерацию, контроль и аналитику в понятную последовательность.</p><a class="sg-button sg-button-primary" href="<?php echo esc_url($register_url); ?>">Запустить первый проект <span>↗</span></a></div><div class="sg-steps"><div class="sg-step"><span class="sg-step-index">01</span><div><h3>Опишите задачу</h3><p>Техническое задание, ниша, аудитория и бизнес-цель.</p></div><span class="sg-step-arrow">↗</span></div><div class="sg-step active"><span class="sg-step-index">02</span><div><h3>Получите AI-исследование</h3><p>Спрос, intent, entities, конкуренты и точки дифференциации.</p></div><span class="sg-step-arrow">↗</span></div><div class="sg-step"><span class="sg-step-index">03</span><div><h3>Создайте контент</h3><p>SEO-текст, блог, ссылочная статья или мета-теги.</p></div><span class="sg-step-arrow">↗</span></div><div class="sg-step"><span class="sg-step-index">04</span><div><h3>Измеряйте рост</h3><p>Отчёт, рекомендации и следующий приоритет.</p></div><span class="sg-step-arrow">↗</span></div></div></div>
    </section>

    <section id="plans" class="sg-paper-section sg-plans"><div class="sg-container"><div class="sg-section-head sg-plans-head"><div><div class="sg-eyebrow">Лимиты под ваш темп</div><h2>Начните с малого.<br><span>Масштабируйте уверенно.</span></h2></div><p>Выбирайте объём под текущую задачу и подключайте больше мощности, когда растёт контентный план.</p></div><div class="sg-plan-grid"><article class="sg-plan"><small>Для самостоятельного SEO</small><h3>Starter</h3><p>Проверить гипотезы, собрать семантику и выпускать контент без лишней рутины.</p><div class="sg-plan-limit">Пакет лимитов</div><ul><li>Исследование тем и интентов</li><li>SEO-тексты по ТЗ</li><li>Базовые отчёты и история</li></ul><a href="<?php echo esc_url($register_url); ?>">Выбрать пакет <span>↗</span></a></article><article class="sg-plan featured"><small>Для системного роста</small><h3>Growth</h3><p>Единый pipeline для контент-команд, которым важны скорость, качество и измеримый результат.</p><div class="sg-plan-limit">Расширенный пакет</div><ul><li>Все AI-инструменты платформы</li><li>E-E-A-T, LSI и quality gates</li><li>Проекты, отчёты и аналитика</li></ul><a href="<?php echo esc_url($register_url); ?>">Начать с Growth <span>↗</span></a></article><article class="sg-plan"><small>Для агентств и команд</small><h3>Agency</h3><p>Гибкая ёмкость лимитов для нескольких проектов и прозрачной работы с клиентами.</p><div class="sg-plan-limit">Индивидуальный объём</div><ul><li>Несколько рабочих пространств</li><li>Премиальные отчёты для клиента</li><li>Масштабирование под нагрузку</li></ul><a href="<?php echo esc_url($register_url); ?>">Выбрать пакет <span>↗</span></a></article></div><p class="sg-plan-note">Точный объём лимитов и условия подключаются под ваш сценарий. Без скрытых этапов и непонятных ограничений.</p></div></section>

    <section id="faq" class="sg-faq"><div class="sg-container sg-faq-grid"><div><div class="sg-eyebrow">Ответы без мелкого шрифта</div><h2>Частые<br><span>вопросы.</span></h2></div><div class="sg-faq-list"><?php foreach ($faqs as $index => $faq) : ?><details<?php echo $index === 0 ? ' open' : ''; ?>><summary><span><?php echo esc_html($faq['question']); ?></span><b>+</b></summary><p><?php echo esc_html($faq['answer']); ?></p></details><?php endforeach; ?></div></div></section>

    <section class="sg-final"><div class="sg-container"><div class="sg-eyebrow">Следующий шаг — за вами</div><h2>Создайте контент,<br><em>который работает.</em></h2><p>Начните с первого проекта и соберите свой SEO-процесс в одной системе.</p><a class="sg-button sg-button-light" href="<?php echo esc_url($register_url); ?>">Начать бесплатно <span>↗</span></a></div></section>

    <footer class="sg-footer"><div class="sg-container sg-footer-inner"><a class="sg-brand" href="<?php echo esc_url($home_url); ?>"><span class="sg-mark" aria-hidden="true"><span></span><span></span><span></span></span><span class="sg-wordmark">SEO <strong>GENIUS</strong></span></a><span class="sg-footer-copy">AI-платформа для контента, который ранжируется.</span><div class="sg-footer-links"><a href="#platform">Платформа</a><a href="#plans">Лимиты</a><a href="<?php echo esc_url($login_url); ?>">Войти</a></div><span class="sg-footer-year">© <?php echo esc_html(date('Y')); ?> SEO Genius</span></div></footer>
</main>
<?php wp_footer(); ?>
</body>
</html>
