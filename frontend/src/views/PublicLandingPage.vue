<script setup>
import { onBeforeUnmount, onMounted } from 'vue';

const meta = [
  { name: 'description', content: 'SeoMST — AI-платформа для исследования спроса, генерации экспертного SEO-контента и роста органического трафика в Google и Яндексе.' },
  { name: 'robots', content: 'index,follow,max-image-preview:large' },
];

const plans = [
  {
    name: 'Минимальный',
    kicker: 'Для самостоятельного SEO',
    price: '4 990 ₽',
    priceValue: 4990,
    description: 'Чтобы системно выпускать контент и держать до трёх проектов под контролем.',
    details: ['5 коммерческих статей', '10 статей для блога', '10 ссылочных статей', 'До 3 проектов', 'Яндекс Вебмастер + Google Search Console', 'Онлайн-отчёты для 3 проектов', 'Мета-теги до 70 категорий'],
    featured: false,
  },
  {
    name: 'Средний',
    kicker: 'Для системного роста',
    price: '9 990 ₽',
    priceValue: 9990,
    description: 'Для команды, которой нужны аналитика, AI-отчёты и стабильный контентный план.',
    details: ['10 коммерческих статей', '15 статей для блога', '20 ссылочных статей', 'До 5 проектов', 'Яндекс Вебмастер + Google Search Console', 'Онлайн-отчёты с AI-аналитикой для 5 проектов', 'Мета-теги до 140 категорий'],
    featured: true,
  },
  {
    name: 'Про',
    kicker: 'Для агентств и больших команд',
    price: '14 990 ₽',
    priceValue: 14990,
    description: 'Максимальная ёмкость для десятка проектов, глубокой аналитики и регулярного выпуска.',
    details: ['15 коммерческих статей', '20 статей для блога', '30 ссылочных статей', 'До 10 проектов', 'Яндекс Вебмастер + Google Search Console', 'Онлайн-отчёты с AI-аналитикой для 10 проектов', 'Мета-теги до 210 категорий'],
    featured: false,
  },
];

const commonFeatures = [
  'Инструмент релевантности — 100 съёмов на аккаунт в месяц',
  'Сборка коммерческого предложения — безлимитно',
  'Темы статей — до 10 задач в месяц',
  'JSON — безлимитный доступ',
];

const faqs = [
  {
    question: 'Сколько генераций доступно бесплатно?',
    answer: 'После регистрации доступны 5 бесплатных генераций без банковской карты. После использования бесплатного доступа можно выбрать месячную подписку под объём контента и количество проектов.',
  },
  {
    question: 'Что такое лимиты в SeoMST?',
    answer: 'Лимиты — это понятный ресурс для работы AI-инструментов: исследований, анализа, генерации контента и подготовки отчётов. Пакет подбирается под объём задач и количество проектов.',
  },
  {
    question: 'Можно ли использовать систему для Google и Яндекса?',
    answer: 'Да. Пайплайн учитывает поисковый интент, семантику, коммерческие и информационные сценарии, а также отдельные сигналы Google и Яндекса, когда они доступны в проекте.',
  },
  {
    question: 'Чем платформа отличается от обычного AI-копирайтера?',
    answer: 'SeoMST работает не только с текстом. Система связывает исследование ниши, факты, доказательства, E-E-A-T, LSI, структуру, контроль качества, проекты и отчётность в единый процесс.',
  },
  {
    question: 'Нужно ли менять рабочий процесс команды?',
    answer: 'Нет. Платформа добавляет единый контур контроля и автоматизации, а команда получает готовые результаты, статусы, историю задач и точки роста в одном рабочем пространстве.',
  },
];

const previousTitle = document.title;
const previousMeta = new Map();
let schemaScript;

function setMeta(name, content) {
  const selector = `meta[name="${name}"]`;
  const existing = document.head.querySelector(selector);
  previousMeta.set(name, existing ? existing.cloneNode(true) : null);
  const tag = existing || document.createElement('meta');
  tag.setAttribute('name', name);
  tag.setAttribute('content', content);
  if (!existing) document.head.appendChild(tag);
}

onMounted(() => {
  document.title = 'SeoMST — AI-платформа для SEO-контента и роста трафика';
  meta.forEach(({ name, content }) => setMeta(name, content));

  schemaScript = document.createElement('script');
  schemaScript.type = 'application/ld+json';
  schemaScript.id = 'seo-genius-landing-schema';
  schemaScript.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SeoMST',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: 'AI-платформа для исследования спроса, генерации экспертного SEO-контента и роста органического трафика.',
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: 4990,
      highPrice: 14990,
      priceCurrency: 'RUB',
      offerCount: plans.length,
      category: 'AI SEO platform subscription',
      availability: 'https://schema.org/OnlineOnly',
    },
    featureList: ['5 free generations', 'SEO content generation', 'Search intent research', 'E-E-A-T quality control', 'SEO reports'],
  });
  document.head.appendChild(schemaScript);
});

onBeforeUnmount(() => {
  document.title = previousTitle;
  previousMeta.forEach((node, name) => {
    const current = document.head.querySelector(`meta[name="${name}"]`);
    if (!current) return;
    if (node) current.replaceWith(node);
    else current.remove();
  });
  schemaScript?.remove();
});
</script>

<template>
  <main class="marketing-landing">
    <div class="ambient ambient-one" aria-hidden="true"></div>
    <div class="ambient ambient-two" aria-hidden="true"></div>

    <header class="landing-header">
      <div class="landing-container nav-inner">
        <RouterLink to="/" class="brand-lockup" aria-label="SeoMST — на главную">
          <span class="brand-mark" aria-hidden="true">
            <span></span><span></span><span></span>
          </span>
          <span class="brand-wordmark">SeoMST</span>
        </RouterLink>

        <nav class="desktop-nav" aria-label="Основная навигация">
          <a href="#platform">Платформа</a>
          <a href="#workflow">Как работает</a>
          <a href="#plans">Тарифы</a>
          <a href="#faq">FAQ</a>
        </nav>

        <div class="nav-actions">
          <RouterLink to="/login" class="nav-login">Войти</RouterLink>
          <RouterLink to="/register" class="button button-small button-primary">Начать бесплатно <span>↗</span></RouterLink>
        </div>
      </div>
    </header>

    <section class="hero-section">
      <div class="landing-container hero-grid">
        <div class="hero-copy">
          <div class="eyebrow"><span class="eyebrow-dot"></span> AI SEO OS для команд, которые растут</div>
          <h1>Создавайте контент, который <em>превращает поиск в рост.</em></h1>
          <p class="hero-lead">SeoMST объединяет исследование спроса, экспертную генерацию и аналитику в один управляемый pipeline — от первого запроса до понятного результата.</p>
          <div class="hero-actions">
            <RouterLink to="/register" class="button button-primary">Получить 5 генераций бесплатно <span>↗</span></RouterLink>
            <a href="#platform" class="button button-ghost">Посмотреть платформу <span class="play-icon">▶</span></a>
          </div>
          <div class="hero-note"><span class="note-check">✓</span> <strong>5 бесплатных генераций</strong> на старте <span class="note-separator">·</span> Без банковской карты <span class="note-separator">·</span> Далее — подписка</div>
        </div>

        <div class="hero-visual" aria-label="Пример рабочей панели SeoMST">
          <div class="visual-orbit orbit-a"></div>
          <div class="visual-orbit orbit-b"></div>
          <div class="dashboard-window">
            <div class="window-bar"><span class="window-dots"><i></i><i></i><i></i></span><span class="window-title">SeoMST / Executive view</span><span class="window-menu">•••</span></div>
            <div class="window-body">
              <div class="dash-topline"><div><span class="dash-caption">ОРГАНИЧЕСКИЙ РОСТ</span><strong>+38.4%</strong><small>за последние 90 дней <b>↗</b></small></div><span class="dash-period">90 дней⌄</span></div>
              <div class="chart-area">
                <div class="chart-y"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
                <svg viewBox="0 0 470 170" role="img" aria-label="График роста органического трафика">
                  <defs><linearGradient id="areaGradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b7dff" stop-opacity=".34"/><stop offset="1" stop-color="#8b7dff" stop-opacity="0"/></linearGradient></defs>
                  <g class="chart-grid"><path d="M0 10H470M0 50H470M0 90H470M0 130H470M0 169H470"/></g>
                  <path class="chart-area-fill" d="M0 151 C35 145 44 130 70 133 S111 139 135 112 S170 96 190 103 S232 90 246 82 S276 96 302 72 S331 67 347 60 S376 69 393 45 S430 35 470 13 L470 170 L0 170Z"/>
                  <path class="chart-line" d="M0 151 C35 145 44 130 70 133 S111 139 135 112 S170 96 190 103 S232 90 246 82 S276 96 302 72 S331 67 347 60 S376 69 393 45 S430 35 470 13"/>
                  <circle class="chart-point" cx="393" cy="45" r="5"/><circle class="chart-point" cx="470" cy="13" r="5"/>
                </svg>
                <div class="chart-x"><span>Май</span><span>Июн</span><span>Июл</span><span>Авг</span><span>Сен</span><span>Окт</span></div>
              </div>
              <div class="dash-cards"><div class="mini-stat"><span class="mini-icon violet">⌁</span><div><b>142</b><small>Запроса в работе</small></div><strong>+24%</strong></div><div class="mini-stat"><span class="mini-icon mint">✦</span><div><b>8.7</b><small>Средний E-E-A-T</small></div><strong>+1.4</strong></div><div class="mini-stat"><span class="mini-icon amber">↗</span><div><b>64</b><small>Точки роста</small></div><strong>новые</strong></div></div>
            </div>
          </div>
          <div class="floating-pill pill-top"><span class="pill-icon">✦</span><div><b>AI quality gate</b><small>12 факторов проверено</small></div><span class="pill-ok">✓</span></div>
          <div class="floating-pill pill-bottom"><span class="pulse-dot"></span><div><b>Pipeline active</b><small>Контент создаётся</small></div><span class="pill-time">2:14</span></div>
        </div>
      </div>
      <div class="landing-container proof-strip"><span>Один контур для всей SEO-команды</span><div><span><b>11</b> AI-инструментов</span><span class="proof-divider"></span><span><b>Google</b> + <b>Яндекс</b></span><span class="proof-divider"></span><span><b>E-E-A-T</b> в каждом тексте</span><span class="proof-divider"></span><span>Данные остаются под контролем</span></div></div>
    </section>

    <section id="platform" class="platform-section section-pad">
      <div class="landing-container">
        <div class="section-heading"><div><div class="eyebrow muted-eyebrow">Одна система вместо разрозненных инструментов</div><h2>Весь путь от сигнала<br /><span>до результата.</span></h2></div><p>Не просто генератор текста. Платформа, которая понимает, зачем создаётся материал, для кого он нужен и как измерить его вклад в рост.</p></div>
        <div class="feature-grid">
          <article class="feature-card feature-large"><div class="card-number">01 <span>RESEARCH</span></div><h3>Находим темы,<br /><em>за которыми есть спрос</em></h3><p>Собираем поисковые сигналы, анализируем конкурентов, определяем intent и строим приоритеты, а не список случайных идей.</p><div class="signal-visual"><div class="signal-row"><span class="signal-label">commercial intent</span><span class="signal-bar"><i style="width: 86%"></i></span><b>86</b></div><div class="signal-row"><span class="signal-label">growth potential</span><span class="signal-bar"><i style="width: 72%"></i></span><b>72</b></div><div class="signal-row"><span class="signal-label">content gap</span><span class="signal-bar"><i style="width: 64%"></i></span><b>64</b></div><span class="signal-badge">↗ demand signal</span></div></article>
          <article class="feature-card feature-dark"><div class="card-number">02 <span>STRATEGY</span></div><h3>Думаем<br /><em>как SEO-стратег</em></h3><p>Единый контекст проекта, история публикаций и правила бренда помогают не повторять уже написанное и усиливать topical authority.</p><div class="strategy-orbit"><span class="orbit-core">SEO<br />OS</span><i>intent</i><i>entities</i><i>evidence</i><i>LSI</i></div></article>
          <article class="feature-card feature-tall"><div class="card-number">03 <span>GENERATE</span></div><h3>Пишем<br /><em>как эксперт</em></h3><p>E-E-A-T, факты, сравнения, таблицы и понятная структура проходят через quality gates до публикации.</p><div class="expert-visual"><div class="expert-head"><span class="avatar-shape"></span><div><b>Content brief</b><small>verified by AI</small></div><span class="verified">✓</span></div><div class="expert-lines"><i></i><i></i><i class="short"></i><i></i></div><div class="expert-tags"><span>E-E-A-T</span><span>FACTS</span><span>LSI</span></div></div></article>
          <article class="feature-card feature-wide"><div class="card-number">04 <span>MEASURE</span></div><div class="wide-copy"><h3>Видим, что делать дальше</h3><p>Отчёты превращают массив данных в конкретные точки роста: что исправить, что написать и куда направить следующий лимит.</p><RouterLink to="/register" class="inline-link">Открыть рабочее пространство <span>→</span></RouterLink></div><div class="growth-visual"><span class="growth-ring ring-one"></span><span class="growth-ring ring-two"></span><span class="growth-ring ring-three"></span><b>+38%</b><small>organic growth</small></div></article>
        </div>
      </div>
    </section>

    <section id="workflow" class="workflow-section section-pad">
      <div class="landing-container workflow-inner"><div class="workflow-copy"><div class="eyebrow muted-eyebrow">Как работает система</div><h2>Сложная работа.<br /><span>Простой путь.</span></h2><p>Вы задаёте направление — SeoMST связывает исследование, генерацию, контроль и аналитику в понятную последовательность.</p><RouterLink to="/register" class="button button-primary">Запустить первый проект <span>↗</span></RouterLink></div><div class="steps-list"><div class="step-item"><span class="step-index">01</span><div><h3>Опишите задачу</h3><p>Техническое задание, ниша, аудитория и бизнес-цель.</p></div><span class="step-arrow">↗</span></div><div class="step-item active-step"><span class="step-index">02</span><div><h3>Получите AI-исследование</h3><p>Спрос, intent, entities, конкуренты и точки дифференциации.</p></div><span class="step-arrow">↗</span></div><div class="step-item"><span class="step-index">03</span><div><h3>Создайте контент</h3><p>SEO-текст, блог, ссылочная статья или мета-теги.</p></div><span class="step-arrow">↗</span></div><div class="step-item"><span class="step-index">04</span><div><h3>Измеряйте рост</h3><p>Отчёт, рекомендации и следующий приоритет.</p></div><span class="step-arrow">↗</span></div></div></div>
    </section>

    <section id="plans" class="plans-section section-pad">
      <div class="landing-container">
        <div class="trial-banner">
          <div class="trial-badge">FREE START</div>
          <div><strong>5 бесплатных генераций</strong><p>Познакомьтесь с платформой без банковской карты. После бесплатного доступа подключается выбранная подписка.</p></div>
          <RouterLink to="/register" class="trial-link">Начать бесплатно <span>↗</span></RouterLink>
        </div>
        <div class="section-heading plans-heading"><div><div class="eyebrow muted-eyebrow">Понятные месячные тарифы</div><h2>Начните с малого.<br /><span>Масштабируйте уверенно.</span></h2></div><p>Пять генераций доступны бесплатно. Затем выберите объём под контентный план, количество проектов и глубину аналитики.</p></div>
        <div class="plans-grid"><article v-for="plan in plans" :key="plan.name" class="plan-card" :class="{ 'plan-featured': plan.featured }"><div class="plan-top"><span class="plan-kicker">{{ plan.kicker }}</span><span v-if="plan.featured" class="popular-badge">Популярный</span></div><h3>{{ plan.name }}</h3><div class="plan-price">{{ plan.price }}<small>/ месяц</small></div><p>{{ plan.description }}</p><ul><li v-for="detail in plan.details" :key="detail"><span>✓</span>{{ detail }}</li></ul><RouterLink to="/register" class="plan-link" :class="{ 'plan-link-primary': plan.featured }">Выбрать тариф <span>↗</span></RouterLink></article></div>
        <div class="common-features"><div><span class="common-kicker">Во всех тарифах</span><h3>Всё необходимое<br /><em>для ежедневной работы.</em></h3></div><ul><li v-for="feature in commonFeatures" :key="feature"><span>✓</span>{{ feature }}</li></ul></div>
        <p class="plans-footnote">Все цены указаны за месяц. Бесплатный старт — 5 генераций, далее работа продолжается по выбранной подписке.</p>
      </div>
    </section>

    <section class="proof-section section-pad"><div class="landing-container proof-panel"><div class="proof-panel-copy"><div class="eyebrow">Данные → решения → рост</div><h2>Ваш SEO-процесс<br />может быть <em>собранным.</em></h2><p>Вместо десятков вкладок — одна система, где каждая задача связана с проектом, контекстом и измеримым результатом.</p><div class="proof-quote"><span class="quote-mark">“</span><p>Наконец-то контент создаётся не «по ощущениям», а по понятному плану.</p><small>— команда SeoMST</small></div></div><div class="proof-metrics"><div><strong>01</strong><span>Соберите<br />первый проект</span></div><div><strong>02</strong><span>Сформируйте<br />семантическое ядро</span></div><div><strong>03</strong><span>Публикуйте<br />с уверенностью</span></div><div class="metric-accent"><strong>∞</strong><span>Повторяйте<br />цикл роста</span></div></div></div></section>

    <section id="faq" class="faq-section section-pad"><div class="landing-container faq-inner"><div class="faq-heading"><div class="eyebrow muted-eyebrow">Ответы без мелкого шрифта</div><h2>Частые<br /><span>вопросы.</span></h2></div><div class="faq-list"><details v-for="(faq, index) in faqs" :key="faq.question" :open="index === 0"><summary><span>{{ faq.question }}</span><b>+</b></summary><p>{{ faq.answer }}</p></details></div></div></section>

    <section class="final-cta-section"><div class="landing-container final-cta"><div class="final-glow"></div><div class="eyebrow">Следующий шаг — за вами</div><h2>Создайте контент,<br /><em>который работает.</em></h2><p>Начните с первого проекта и соберите свой SEO-процесс в одной системе.</p><RouterLink to="/register" class="button button-light">Начать бесплатно <span>↗</span></RouterLink></div></section>

    <footer class="landing-footer"><div class="landing-container footer-inner"><RouterLink to="/" class="brand-lockup"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span><span class="brand-wordmark">SeoMST</span></RouterLink><span class="footer-copy">AI-платформа для контента, который ранжируется.</span><div class="footer-links"><a href="#platform">Платформа</a><a href="#plans">Лимиты</a><RouterLink to="/login">Войти</RouterLink></div><span class="footer-year">© 2026 SeoMST</span></div></footer>
  </main>
</template>

<style scoped>
:global(html) { scroll-behavior: smooth; }
:global(body) { background: #090b12; }
:global(::selection) { background: rgba(137, 120, 255, .35); color: #fff; }

.marketing-landing { --ink: #0a0c14; --ink-soft: #111522; --paper: #f3f1ed; --paper-muted: #d9d7d2; --violet: #8374ff; --violet-light: #b4acff; --mint: #a8f0d6; --line-dark: rgba(255,255,255,.12); --line-light: rgba(10,12,20,.14); position: relative; overflow: hidden; color: var(--paper); background: var(--ink); font-family: Inter, system-ui, sans-serif; }
.landing-container { width: min(1240px, calc(100% - 64px)); margin: 0 auto; position: relative; z-index: 1; }
.landing-header { position: absolute; inset: 0 0 auto; z-index: 10; border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(9,11,18,.62); backdrop-filter: blur(16px); }
.nav-inner { height: 82px; display: flex; align-items: center; justify-content: space-between; gap: 28px; }
.brand-lockup { display: inline-flex; align-items: center; gap: 11px; color: var(--paper); text-decoration: none; white-space: nowrap; }
.brand-mark { width: 23px; height: 25px; display: inline-flex; align-items: end; gap: 3px; transform: skew(-10deg); }
.brand-mark span { display: block; width: 5px; border-radius: 2px 2px 0 0; background: var(--violet); box-shadow: 0 0 16px rgba(131,116,255,.35); }
.brand-mark span:nth-child(1) { height: 11px; opacity: .65; }.brand-mark span:nth-child(2) { height: 18px; }.brand-mark span:nth-child(3) { height: 25px; background: var(--mint); }
.brand-wordmark { font-size: 13px; letter-spacing: .16em; font-weight: 400; }.brand-wordmark b { font-weight: 800; }
.desktop-nav { display: flex; align-items: center; gap: 31px; margin-left: auto; margin-right: 28px; }.desktop-nav a,.nav-login { color: #a9adbd; font-size: 12px; letter-spacing: .02em; text-decoration: none; transition: color .18s ease; }.desktop-nav a:hover,.nav-login:hover { color: #fff; }
.nav-actions { display: flex; align-items: center; gap: 21px; }.button { display: inline-flex; align-items: center; justify-content: center; gap: 13px; min-height: 53px; padding: 0 22px; border-radius: 5px; border: 1px solid transparent; font-size: 12px; font-weight: 700; letter-spacing: .01em; text-decoration: none; transition: transform .18s ease, background .18s ease, border-color .18s ease; }.button:hover { transform: translateY(-2px); }.button:active { transform: scale(.98); }.button span { font-size: 16px; line-height: 1; }.button-small { min-height: 39px; padding: 0 16px; font-size: 11px; }.button-primary { background: var(--violet); color: #fff; box-shadow: 0 9px 28px rgba(131,116,255,.25); }.button-primary:hover { background: #9589ff; }.button-ghost { color: #e6e4ec; border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.04); }.button-ghost:hover { background: rgba(255,255,255,.1); }.button-light { background: var(--paper); color: var(--ink); }.button-light:hover { background: #fff; }
.ambient { position: absolute; pointer-events: none; border-radius: 50%; filter: blur(1px); }.ambient-one { width: 600px; height: 600px; top: -250px; right: -120px; background: radial-gradient(circle, rgba(106,89,255,.23), transparent 68%); }.ambient-two { width: 760px; height: 760px; top: 840px; left: -500px; background: radial-gradient(circle, rgba(66,180,159,.1), transparent 68%); }
.hero-section { min-height: 820px; padding: 178px 0 0; position: relative; background: radial-gradient(circle at 77% 38%, rgba(84,72,193,.18), transparent 28%), linear-gradient(180deg, #0b0d17 0%, #0b0d15 72%, #11141e 100%); }.hero-grid { display: grid; grid-template-columns: minmax(0, .88fr) minmax(520px, 1.12fr); gap: 65px; align-items: center; }.hero-copy { padding: 34px 0 85px; max-width: 560px; }.eyebrow { display: flex; align-items: center; gap: 10px; color: var(--violet-light); font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }.eyebrow-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 15px var(--mint); }.hero-copy h1 { max-width: 570px; margin: 24px 0 23px; color: #f4f3f1; font-size: clamp(44px, 5vw, 72px); line-height: .99; letter-spacing: -.055em; font-weight: 700; }.hero-copy h1 em,.feature-card h3 em,.workflow-copy h2 span,.plans-heading h2 span,.faq-heading h2 span,.final-cta h2 em { color: var(--violet-light); font-style: normal; }.hero-lead { max-width: 500px; margin: 0; color: #a2a6b7; font-size: 15px; line-height: 1.72; }.hero-actions { display: flex; gap: 12px; margin-top: 32px; }.hero-note { display: flex; align-items: center; gap: 8px; margin-top: 23px; color: #6f7488; font-size: 10px; }.hero-note strong { color: var(--mint); font-weight: 800; }.note-check { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; border-radius: 50%; color: var(--mint); border: 1px solid rgba(168,240,214,.3); }.note-separator { color: #414556; margin: 0 3px; }
.hero-visual { position: relative; min-height: 515px; display: flex; align-items: center; justify-content: center; }.dashboard-window { width: min(100%, 612px); position: relative; z-index: 2; overflow: hidden; border: 1px solid rgba(255,255,255,.22); border-radius: 8px; background: #171a29; box-shadow: 0 32px 100px rgba(0,0,0,.48), 0 0 0 10px rgba(255,255,255,.02); transform: perspective(1400px) rotateY(-7deg) rotateX(2deg); }.window-bar { height: 41px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,.1); background: #1e2232; color: #737a92; font-size: 9px; }.window-dots { display: flex; gap: 5px; }.window-dots i { width: 6px; height: 6px; border-radius: 50%; background: #555c73; }.window-dots i:first-child { background: #ee8b93; }.window-dots i:nth-child(2) { background: #edc377; }.window-dots i:nth-child(3) { background: #8ad7b7; }.window-title { letter-spacing: .04em; }.window-menu { letter-spacing: 2px; }.window-body { padding: 25px 26px 24px; }.dash-topline { display: flex; justify-content: space-between; align-items: start; }.dash-caption,.mini-stat small { display: block; color: #7b8299; font-size: 8px; letter-spacing: .13em; text-transform: uppercase; }.dash-topline strong { display: block; margin-top: 8px; color: #fff; font-size: 30px; letter-spacing: -.04em; }.dash-topline small { color: #7e8499; font-size: 9px; }.dash-topline small b { color: #82d2b1; font-size: 13px; }.dash-period { padding: 7px 9px; border: 1px solid #353b50; border-radius: 3px; color: #9da3b5; font-size: 9px; }.chart-area { display: grid; grid-template-columns: 22px 1fr; grid-template-rows: 155px 16px; gap: 0 10px; margin-top: 22px; }.chart-y { display: flex; flex-direction: column; justify-content: space-between; padding-bottom: 8px; color: #5f657b; font-size: 8px; }.chart-area svg { width: 100%; height: 155px; overflow: visible; }.chart-grid path { stroke: rgba(255,255,255,.08); stroke-width: 1; stroke-dasharray: 3 5; }.chart-area-fill { fill: url(#areaGradient); }.chart-line { fill: none; stroke: #a396ff; stroke-width: 3; stroke-linecap: round; }.chart-point { fill: #b9afff; stroke: #292648; stroke-width: 4; }.chart-x { grid-column: 2; display: flex; justify-content: space-between; color: #5f657b; font-size: 8px; }.dash-cards { display: grid; grid-template-columns: repeat(3,1fr); gap: 9px; margin-top: 27px; }.mini-stat { display: grid; grid-template-columns: 22px 1fr; gap: 7px; min-height: 59px; padding: 10px 8px; border: 1px solid #2b3043; border-radius: 4px; position: relative; }.mini-icon { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 5px; font-size: 14px; }.mini-icon.violet { background: rgba(131,116,255,.18); color: #ada4ff; }.mini-icon.mint { background: rgba(137,224,191,.14); color: #9fe9ca; }.mini-icon.amber { background: rgba(239,194,112,.15); color: #edc176; }.mini-stat b { display: block; color: #f1f0f0; font-size: 18px; line-height: 1.1; }.mini-stat small { margin-top: 3px; font-size: 7px; letter-spacing: 0; text-transform: none; white-space: nowrap; }.mini-stat strong { position: absolute; top: 9px; right: 7px; color: #82d2b1; font-size: 8px; font-weight: 500; }.visual-orbit { position: absolute; border: 1px solid rgba(131,116,255,.24); border-radius: 50%; transform: rotate(-17deg); }.orbit-a { width: 570px; height: 216px; right: -28px; top: 116px; }.orbit-b { width: 500px; height: 185px; right: 10px; top: 142px; border-color: rgba(168,240,214,.11); }.floating-pill { position: absolute; z-index: 3; display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid rgba(255,255,255,.15); border-radius: 7px; background: rgba(27,31,48,.84); box-shadow: 0 18px 40px rgba(0,0,0,.25); backdrop-filter: blur(14px); }.floating-pill b,.floating-pill small { display: block; }.floating-pill b { color: #ecedf3; font-size: 10px; }.floating-pill small { margin-top: 4px; color: #7e8496; font-size: 8px; }.pill-top { top: 33px; right: -10px; }.pill-bottom { bottom: 42px; left: -21px; }.pill-icon { display: flex; align-items: center; justify-content: center; width: 25px; height: 25px; border-radius: 6px; background: rgba(131,116,255,.2); color: #b1a8ff; }.pill-ok { color: var(--mint); margin-left: 14px; font-size: 15px; }.pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: #6de2b4; box-shadow: 0 0 0 4px rgba(109,226,180,.12), 0 0 16px #6de2b4; }.pill-time { margin-left: 15px; color: #a29aff; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
.proof-strip { display: flex; align-items: center; justify-content: space-between; min-height: 78px; border-top: 1px solid rgba(255,255,255,.12); color: #70768a; font-size: 10px; }.proof-strip > div { display: flex; align-items: center; gap: 19px; }.proof-strip b { color: #c5c8d4; font-weight: 600; }.proof-divider { width: 3px; height: 3px; border-radius: 50%; background: #565b6d; }
.section-pad { padding: 132px 0; }.platform-section { color: var(--ink); background: var(--paper); }.section-heading { display: flex; justify-content: space-between; gap: 50px; align-items: end; margin-bottom: 55px; }.section-heading h2,.workflow-copy h2,.plans-heading h2,.faq-heading h2 { margin: 16px 0 0; color: var(--ink); font-size: clamp(38px, 4.4vw, 59px); letter-spacing: -.055em; line-height: .98; }.section-heading > p { width: min(340px, 100%); margin: 0 0 5px; color: #70717a; font-size: 13px; line-height: 1.7; }.muted-eyebrow { color: #6e64cf; }
.feature-grid { display: grid; grid-template-columns: 1.08fr .93fr .93fr; grid-template-rows: 353px 275px; gap: 14px; }.feature-card { position: relative; overflow: hidden; padding: 27px 29px; border: 1px solid var(--line-light); border-radius: 7px; background: #e7e5e1; }.feature-card h3 { margin: 27px 0 12px; color: var(--ink); font-size: 28px; line-height: 1.03; letter-spacing: -.045em; }.feature-card p { max-width: 340px; margin: 0; color: #77777e; font-size: 12px; line-height: 1.65; }.card-number { display: flex; align-items: center; gap: 14px; color: #6c6b71; font-family: 'JetBrains Mono', monospace; font-size: 10px; }.card-number span { color: #98979a; font-family: Inter, sans-serif; font-size: 8px; letter-spacing: .18em; }.feature-large { grid-row: span 2; background: #deddda; }.feature-large h3 { font-size: 39px; }.feature-dark { background: #191b2a; border-color: #191b2a; }.feature-dark h3,.feature-dark .card-number { color: #f1f0f0; }.feature-dark .card-number span { color: #848aa1; }.feature-dark p { color: #979cad; }.feature-tall { background: #e9e7e2; }.feature-wide { grid-column: span 2; display: flex; gap: 32px; align-items: start; background: #d7d4ff; }.feature-wide .wide-copy { position: relative; z-index: 1; }.feature-wide h3 { margin-top: 35px; }.inline-link { display: inline-flex; align-items: center; gap: 8px; margin-top: 19px; color: #4c43ad; font-size: 11px; font-weight: 700; text-decoration: none; }.inline-link span { font-size: 18px; }.signal-visual { position: absolute; right: 29px; bottom: 29px; left: 29px; padding: 18px 18px 16px; border: 1px solid rgba(10,12,20,.1); border-radius: 5px; background: rgba(255,255,255,.36); }.signal-row { display: grid; grid-template-columns: 122px 1fr 25px; gap: 10px; align-items: center; margin-bottom: 15px; color: #77747c; font-size: 9px; }.signal-row b { color: #5b5764; font-family: 'JetBrains Mono', monospace; font-size: 10px; }.signal-bar { height: 4px; overflow: hidden; border-radius: 5px; background: rgba(10,12,20,.1); }.signal-bar i { display: block; height: 100%; border-radius: inherit; background: #8074ed; }.signal-row:nth-child(2) .signal-bar i { background: #75bfa7; }.signal-row:nth-child(3) .signal-bar i { background: #d2a866; }.signal-badge { display: inline-block; margin-top: 2px; color: #7163d9; font-size: 9px; }.strategy-orbit { position: absolute; right: 20px; bottom: -12px; width: 240px; height: 190px; border: 1px solid rgba(184,177,255,.2); border-radius: 50%; transform: rotate(-24deg); }.strategy-orbit::before,.strategy-orbit::after { content: ''; position: absolute; inset: 24px 35px; border: 1px solid rgba(184,177,255,.14); border-radius: 50%; }.strategy-orbit::after { inset: 49px 54px; }.orbit-core { position: absolute; inset: 71px 90px; z-index: 1; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: #7569df; color: #fff; text-align: center; font-size: 10px; line-height: 1.1; transform: rotate(24deg); box-shadow: 0 0 30px rgba(117,105,223,.45); }.strategy-orbit i { position: absolute; color: #aaa5df; font-size: 8px; font-style: normal; transform: rotate(24deg); }.strategy-orbit i:nth-of-type(1) { top: 16px; left: 105px; }.strategy-orbit i:nth-of-type(2) { top: 96px; right: 3px; }.strategy-orbit i:nth-of-type(3) { bottom: 2px; left: 76px; }.strategy-orbit i:nth-of-type(4) { top: 95px; left: 2px; }.expert-visual { position: absolute; right: 26px; bottom: 26px; left: 26px; padding: 15px; border: 1px solid rgba(10,12,20,.1); border-radius: 5px; background: rgba(255,255,255,.62); }.expert-head { display: flex; align-items: center; gap: 9px; }.avatar-shape { width: 23px; height: 23px; border-radius: 7px; background: linear-gradient(135deg,#9a8cff,#6959db); }.expert-head b,.expert-head small { display: block; }.expert-head b { color: #42404a; font-size: 9px; }.expert-head small { margin-top: 3px; color: #8b8991; font-size: 8px; }.verified { margin-left: auto; color: #5dc49a; font-size: 16px; }.expert-lines { display: grid; gap: 7px; margin: 16px 2px 12px; }.expert-lines i { display: block; width: 100%; height: 4px; border-radius: 3px; background: #c3c0d3; }.expert-lines i:nth-child(2) { width: 83%; background: #d0cedb; }.expert-lines i.short { width: 57%; background: #d0cedb; }.expert-tags { display: flex; gap: 5px; }.expert-tags span { padding: 4px 6px; border-radius: 3px; background: #e5e2f1; color: #736bb0; font-size: 7px; letter-spacing: .1em; }.growth-visual { position: absolute; right: 65px; bottom: -46px; width: 260px; height: 260px; border-radius: 50%; }.growth-ring { position: absolute; border: 1px solid rgba(85,72,198,.28); border-radius: 50%; }.ring-one { inset: 0; }.ring-two { inset: 32px; border-color: rgba(85,72,198,.2); }.ring-three { inset: 65px; border-color: rgba(85,72,198,.32); }.growth-visual b,.growth-visual small { position: absolute; left: 0; right: 0; text-align: center; }.growth-visual b { top: 91px; color: #5148bd; font-size: 35px; letter-spacing: -.07em; }.growth-visual small { top: 135px; color: #716bb1; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; }
.workflow-section { color: var(--paper); background: #121522; }.workflow-inner { display: grid; grid-template-columns: .82fr 1.18fr; gap: 115px; align-items: start; }.workflow-copy p { max-width: 355px; margin: 27px 0 29px; color: #858b9d; font-size: 13px; line-height: 1.7; }.workflow-copy h2 { color: #f0efec; }.workflow-copy h2 span { color: var(--mint); }.steps-list { border-top: 1px solid var(--line-dark); }.step-item { display: grid; grid-template-columns: 50px 1fr 30px; gap: 17px; align-items: start; min-height: 99px; padding: 26px 0 24px; border-bottom: 1px solid var(--line-dark); opacity: .62; transition: opacity .18s ease, padding .18s ease; }.step-item:hover,.active-step { opacity: 1; padding-left: 12px; }.step-index { color: #6f7589; font-family: 'JetBrains Mono', monospace; font-size: 10px; }.step-item h3 { margin: -3px 0 7px; color: #f0efec; font-size: 17px; font-weight: 600; letter-spacing: -.02em; }.step-item p { margin: 0; color: #858b9d; font-size: 11px; line-height: 1.55; }.step-arrow { color: #8e83ff; font-size: 18px; }
.plans-section { background: var(--paper); color: var(--ink); }.trial-banner { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 22px; margin-bottom: 63px; padding: 20px 24px; border: 1px solid rgba(85,72,198,.2); border-radius: 7px; background: linear-gradient(110deg, #e4e1ff 0%, #f0efeb 72%); }.trial-badge { padding: 7px 9px; border-radius: 4px; background: #564bc0; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 800; letter-spacing: .12em; }.trial-banner strong { color: #3c3783; font-size: 16px; letter-spacing: -.02em; }.trial-banner p { margin: 5px 0 0; color: #68667d; font-size: 11px; line-height: 1.5; }.trial-link { display: inline-flex; align-items: center; gap: 8px; color: #5046b6; font-size: 11px; font-weight: 800; text-decoration: none; white-space: nowrap; }.trial-link span { font-size: 17px; }.plans-heading { margin-bottom: 48px; }.plans-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; align-items: stretch; }.plan-card { position: relative; display: flex; flex-direction: column; min-height: 385px; padding: 29px 28px 25px; border: 1px solid var(--line-light); border-radius: 7px; background: #ebe9e5; }.plan-card.plan-featured { color: #f4f2f2; border-color: #28243e; background: #211e36; box-shadow: 0 20px 45px rgba(24,20,52,.17); transform: translateY(-11px); }.plan-top { display: flex; justify-content: space-between; align-items: center; min-height: 18px; }.plan-kicker { color: #7d7b81; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; }.plan-featured .plan-kicker { color: #aaa1ef; }.popular-badge { padding: 5px 7px; border-radius: 3px; background: rgba(168,240,214,.11); color: var(--mint); font-size: 8px; font-weight: 700; }.plan-card h3 { margin: 30px 0 9px; font-size: 34px; letter-spacing: -.05em; }.plan-price { display: flex; align-items: baseline; gap: 7px; color: #554bbd; font-size: 26px; font-weight: 800; letter-spacing: -.05em; }.plan-price small { color: #85838d; font-size: 10px; font-weight: 500; letter-spacing: 0; }.plan-featured .plan-price { color: var(--mint); }.plan-featured .plan-price small { color: #aaa5b5; }.plan-card p { max-width: 275px; min-height: 58px; margin: 0; color: #77767c; font-size: 12px; line-height: 1.6; }.plan-featured p { color: #9995aa; }.plan-limit { margin: 24px 0 16px; color: #554bbd; font-size: 12px; font-weight: 800; }.plan-featured .plan-limit { color: var(--mint); }.plan-card ul { display: grid; gap: 10px; margin: 0; padding: 17px 0 21px; border-top: 1px solid var(--line-light); list-style: none; }.plan-featured ul { border-color: rgba(255,255,255,.13); }.plan-card li { display: flex; gap: 8px; color: #6d6b73; font-size: 11px; }.plan-featured li { color: #c0bdca; }.plan-card li span { color: #6a60ce; }.plan-featured li span { color: var(--mint); }.plan-link { display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 17px; border-top: 1px solid var(--line-light); color: #5a50bc; font-size: 11px; font-weight: 800; text-decoration: none; }.plan-featured .plan-link { border-color: rgba(255,255,255,.13); color: var(--mint); }.plan-link span { font-size: 17px; }.common-features { display: grid; grid-template-columns: .8fr 1.2fr; gap: 50px; margin-top: 14px; padding: 28px 29px; border-radius: 7px; background: #deddda; }.common-kicker { color: #6e64cf; font-size: 9px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }.common-features h3 { margin: 13px 0 0; color: var(--ink); font-size: 27px; line-height: 1.02; letter-spacing: -.045em; }.common-features h3 em { color: #655bd0; font-style: normal; }.common-features ul { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 28px; align-content: center; margin: 0; padding: 0; list-style: none; }.common-features li { display: flex; gap: 8px; color: #5e5c66; font-size: 11px; line-height: 1.45; }.common-features li span { color: #5f55c9; font-weight: 800; }.plans-footnote { margin: 25px 0 0; color: #85848a; font-size: 10px; text-align: center; }
.proof-section { background: #edeae5; }.proof-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 100px; padding: 72px 77px; border-radius: 8px; background: #d7d4ff; overflow: hidden; }.proof-panel h2 { margin: 19px 0 20px; color: var(--ink); font-size: clamp(38px, 4.3vw, 58px); line-height: .96; letter-spacing: -.06em; }.proof-panel h2 em { color: #5f56c2; font-style: normal; }.proof-panel-copy > p { max-width: 370px; color: #66647f; font-size: 13px; line-height: 1.7; }.proof-quote { position: relative; max-width: 345px; margin-top: 37px; padding: 20px 0 0 26px; border-top: 1px solid rgba(20,18,67,.15); }.quote-mark { position: absolute; top: 17px; left: 0; color: #8178e1; font-family: Georgia, serif; font-size: 41px; line-height: .7; }.proof-quote p { margin: 0; color: #444261; font-size: 13px; line-height: 1.5; }.proof-quote small { display: block; margin-top: 11px; color: #726ea0; font-size: 9px; }.proof-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-self: center; }.proof-metrics > div { min-height: 143px; display: flex; flex-direction: column; justify-content: space-between; padding: 20px; border: 1px solid rgba(20,18,67,.15); border-radius: 5px; }.proof-metrics strong { color: #5b51bf; font-family: 'JetBrains Mono', monospace; font-size: 17px; }.proof-metrics span { color: #595675; font-size: 12px; line-height: 1.35; }.proof-metrics .metric-accent { background: #24203b; border-color: #24203b; }.proof-metrics .metric-accent strong,.proof-metrics .metric-accent span { color: var(--mint); }
.faq-section { background: var(--paper); color: var(--ink); }.faq-inner { display: grid; grid-template-columns: .7fr 1.3fr; gap: 100px; }.faq-heading h2 { font-size: clamp(48px, 5vw, 67px); }.faq-list { border-top: 1px solid var(--line-light); }.faq-list details { border-bottom: 1px solid var(--line-light); }.faq-list summary { display: flex; justify-content: space-between; align-items: center; min-height: 76px; cursor: pointer; list-style: none; color: #262631; font-size: 14px; font-weight: 700; }.faq-list summary::-webkit-details-marker { display: none; }.faq-list summary b { color: #6f63d4; font-size: 21px; font-weight: 300; transition: transform .18s ease; }.faq-list details[open] summary b { transform: rotate(45deg); }.faq-list details p { max-width: 610px; margin: -7px 39px 23px 0; color: #74737c; font-size: 12px; line-height: 1.7; }
.final-cta-section { position: relative; padding: 128px 0 124px; background: #0c0e17; text-align: center; overflow: hidden; }.final-cta { z-index: 1; }.final-glow { position: absolute; left: 50%; top: 10px; width: 530px; height: 300px; transform: translateX(-50%); border-radius: 50%; background: radial-gradient(ellipse, rgba(106,87,255,.35), transparent 68%); filter: blur(15px); pointer-events: none; }.final-cta .eyebrow { justify-content: center; }.final-cta h2 { margin: 21px 0 18px; color: #f4f2f0; font-size: clamp(43px, 5vw, 67px); line-height: .97; letter-spacing: -.06em; }.final-cta p { margin: 0 0 31px; color: #888e9e; font-size: 13px; }.landing-footer { border-top: 1px solid rgba(255,255,255,.1); background: #0c0e17; }.footer-inner { display: flex; align-items: center; min-height: 97px; gap: 30px; }.footer-copy { color: #6e7486; font-size: 10px; }.footer-links { display: flex; gap: 21px; margin-left: auto; }.footer-links a,.footer-year { color: #707688; font-size: 10px; text-decoration: none; }.footer-links a:hover { color: #fff; }.footer-year { margin-left: 23px; }
@media (max-width: 1050px) { .landing-container { width: min(100% - 40px, 900px); }.desktop-nav { gap: 18px; margin-right: 5px; }.hero-grid { grid-template-columns: 1fr; gap: 15px; }.hero-copy { max-width: 700px; padding-bottom: 0; }.hero-visual { min-height: 500px; max-width: 700px; margin: 0 auto; width: 100%; }.proof-strip { flex-wrap: wrap; padding: 15px 0; gap: 11px; }.feature-grid { grid-template-columns: 1fr 1fr; grid-template-rows: auto; }.feature-large { grid-row: span 1; min-height: 450px; }.feature-wide { grid-column: span 2; }.workflow-inner { gap: 55px; }.proof-panel { gap: 45px; padding: 55px 45px; } }
@media (max-width: 720px) { .landing-container { width: calc(100% - 32px); }.landing-header { position: relative; }.nav-inner { height: 71px; }.desktop-nav,.nav-login { display: none; }.nav-actions { margin-left: auto; }.hero-section { padding-top: 74px; min-height: auto; }.hero-copy { padding: 45px 0 20px; }.hero-copy h1 { font-size: clamp(43px, 12vw, 62px); }.hero-lead { font-size: 14px; }.hero-actions { flex-wrap: wrap; }.hero-note { align-items: flex-start; line-height: 1.5; }.hero-visual { min-height: 370px; margin-top: 19px; }.dashboard-window { transform: none; }.window-body { padding: 17px 14px; }.window-bar { height: 34px; }.dash-topline strong { font-size: 24px; }.chart-area { grid-template-rows: 117px 15px; margin-top: 17px; }.chart-area svg { height: 117px; }.dash-cards { gap: 4px; margin-top: 17px; }.mini-stat { padding: 7px 5px; min-height: 48px; grid-template-columns: 1fr; }.mini-icon { display: none; }.mini-stat b { font-size: 14px; }.mini-stat small { font-size: 6px; }.mini-stat strong { display: none; }.floating-pill { transform: scale(.78); transform-origin: center; }.pill-top { top: 3px; right: -36px; }.pill-bottom { bottom: 5px; left: -42px; }.orbit-a,.orbit-b { display: none; }.proof-strip { display: block; padding: 17px 0; line-height: 1.8; }.proof-strip > div { flex-wrap: wrap; gap: 6px 12px; margin-top: 5px; }.proof-divider { display: none; }.section-pad { padding: 82px 0; }.section-heading { display: block; margin-bottom: 35px; }.section-heading > p { margin-top: 23px; }.section-heading h2,.workflow-copy h2,.plans-heading h2,.faq-heading h2 { font-size: 43px; }.trial-banner { grid-template-columns: 1fr; gap: 11px; margin-bottom: 42px; padding: 20px; }.trial-link { justify-self: start; }.trial-banner strong { font-size: 15px; }.plans-grid { gap: 14px; }.common-features { display: block; margin-top: 14px; padding: 24px 20px; }.common-features ul { grid-template-columns: 1fr; gap: 11px; margin-top: 25px; }.feature-grid { display: flex; flex-direction: column; }.feature-card,.feature-large { min-height: 330px; }.feature-large { min-height: 420px; }.feature-wide { min-height: 350px; }.feature-card h3,.feature-large h3 { font-size: 31px; }.growth-visual { right: 22px; }.workflow-inner,.faq-inner,.proof-panel { display: block; }.steps-list { margin-top: 52px; }.plans-grid { display: flex; flex-direction: column; gap: 14px; }.plan-card { min-height: 345px; }.plan-featured { transform: none; }.plans-footnote { line-height: 1.6; }.proof-panel { padding: 39px 25px; }.proof-metrics { margin-top: 43px; }.faq-heading { margin-bottom: 42px; }.faq-list summary { min-height: 70px; font-size: 13px; }.faq-list details p { margin-right: 0; }.final-cta-section { padding: 88px 0; }.final-cta h2 { font-size: 48px; }.footer-inner { flex-wrap: wrap; gap: 14px 22px; padding: 22px 0; }.footer-copy { order: 3; width: 100%; }.footer-links { margin-left: auto; }.footer-year { width: 100%; margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { :global(html) { scroll-behavior: auto; } *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
