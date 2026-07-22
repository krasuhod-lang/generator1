# Техническое задание: Модуль «Outreach» (Email-рассылки)

### Репозиторий: krasuhod-lang/generator1

### Исполнитель: Claude Opus 4.8 (через GitHub Copilot / Claude API)

### Приоритет: Высокий

---

## 0. Контекст проекта (ОБЯЗАТЕЛЬНО прочитать перед реализацией)

Проект — **SEO Genius v4.0**, Node.js + Vue 3 + PostgreSQL + Redis (BullMQ) монорепо.

**Стек:**

- **Backend:** Node.js (CommonJS `'use strict'`), Express, PostgreSQL (через `src/config/db.js`), BullMQ + Redis (`src/queue/queue.js`), DeepSeek API (`src/services/llm/callLLM.js`)

- **Frontend:** Vue 3 (Composition API), Pinia (stores), Vue Router, ECharts (`vue-echarts`), Axios (`src/api.js`), Tailwind CSS

- **UI-стиль:** Apple Glassmorphism — фон `#F5F5F7`, карточки белые с тенью, кнопки `#0071E3`, радиус `12px`, шрифт SF Pro / system-ui

- **Точка входа backend:** `backend/server.js`

- **Роуты подключаются в:** `backend/server.js` строки 23-49

- **Schedulers запускаются в:** `backend/server.js` в функции `start()` (строки 191+)

- **Паттерн планировщика:** `setInterval` + `startXxxScheduler()` / `stopXxxScheduler()` (см. `src/services/aegis/seoBrainScheduler.js`)

- **Паттерн очереди:** BullMQ Queue + Worker (см. `src/queue/queue.js`)

- **Паттерн API-контроллера:** см. `src/controllers/serpB2b.controller.js`

- **Паттерн Vue-страницы:** см. `frontend/src/views/SerpB2bPage.vue`

- **Паттерн Pinia-store:** см. `frontend/src/stores/serpB2b.js`

- **Навигация:** `frontend/src/components/AppLayout.vue` — массив `navItems` строка 37

**Существующий модуль B2B-парсера (основа для расширения):**

- `backend/src/controllers/serpB2b.controller.js` — CRUD задач

- `backend/src/services/serpB2b/pipeline.js` — пайплайн сбора сайтов

- `backend/src/services/serpB2b/extractors.js` — извлечение email, телефон, ИНН, услуг

- `backend/src/services/serpB2b/growthEvaluator.js` — динамика через keys.so

- `backend/src/services/serpB2b/companyLLMExtractor.js` — LLM-определение юрлица

- `frontend/src/views/SerpB2bPage.vue` — существующий UI парсера

- `frontend/src/stores/serpB2b.js` — Pinia store

---

## 1. Цель модуля

Создать полноценный модуль **«Outreach»** (переименовать раздел «B2B-парсер» в «Outreach»), который:

1. Автоматически собирает сайты компаний по нише и гео через существующий serpB2b-пайплайн

1. Скорит лиды (0-100) по качеству и потенциалу

1. Генерирует персонализированные email через DeepSeek

1. Отправляет письма через Resend API с throttling и прогревом

1. Трекает открытия/клики/ответы через Resend Webhooks

1. Показывает красивый дашборд со статистикой кампаний и логами

---

## 2. Переименование раздела

**Задача 2.1:** В `frontend/src/components/AppLayout.vue` изменить:

```javascript
// БЫЛО:
{ key: 'serp-b2b', label: 'B2B-парсер', icon: '🛰️', path: '/serp-b2b' }

// СТАЛО:
{ key: 'outreach', label: 'Outreach', icon: '📨', path: '/outreach' }
```

**Задача 2.2:** В `frontend/src/router/index.js` добавить новый маршрут (старый `/serp-b2b` оставить для обратной совместимости, добавить redirect):

```javascript
{ path: '/serp-b2b', redirect: '/outreach' },
{ path: '/outreach', component: () => import('../views/OutreachPage.vue'), meta: { auth: true } },
{ path: '/outreach/campaigns/:id', component: () => import('../views/OutreachCampaignPage.vue'), meta: { auth: true } },
```

---

## 3. База данных (новые миграции)

Создать файл `migrations/121_outreach.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════════
-- Миграция 121: Модуль Outreach (email-рассылки)
-- ═══════════════════════════════════════════════════════════════════

-- Статусы кампании
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_campaign_status') THEN
    CREATE TYPE outreach_campaign_status AS ENUM ('draft', 'active', 'paused', 'completed', 'error');
  END IF;
END $$;

-- Статусы письма
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_email_status') THEN
    CREATE TYPE outreach_email_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed');
  END IF;
END $$;

-- ── Кампании ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  keyword         TEXT NOT NULL,               -- исходный запрос ("ремонт квартир")
  niche           TEXT,                        -- определённая ниша (DeepSeek)
  business_type   TEXT,                        -- B2B/B2C/mixed
  cities          TEXT[] NOT NULL DEFAULT '{}', -- список городов
  search_engine   TEXT NOT NULL DEFAULT 'yandex',
  depth_pages     INTEGER NOT NULL DEFAULT 3,
  daily_limit     INTEGER NOT NULL DEFAULT 30, -- писем в день (прогрев)
  warmup_week     INTEGER NOT NULL DEFAULT 1,  -- текущая неделя прогрева (1-5)
  sender_name     TEXT,                        -- имя отправителя
  sender_email    TEXT,                        -- email отправителя (из ENV)
  status          outreach_campaign_status NOT NULL DEFAULT 'draft',
  total_prospects INTEGER NOT NULL DEFAULT 0,
  total_sent      INTEGER NOT NULL DEFAULT 0,
  total_opened    INTEGER NOT NULL DEFAULT 0,
  total_clicked   INTEGER NOT NULL DEFAULT 0,
  total_replied   INTEGER NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_campaigns_user ON outreach_campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_campaigns_status ON outreach_campaigns(status, next_run_at);

-- ── Лиды ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_prospects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  company_name     TEXT,
  inn              TEXT,
  emails           TEXT[] NOT NULL DEFAULT '{}',
  phones           TEXT[] NOT NULL DEFAULT '{}',
  niche            TEXT,
  city             TEXT,
  services         TEXT[] NOT NULL DEFAULT '{}',
  dynamics_yandex  TEXT,                       -- growth/decline/stagnation/null
  dynamics_google  TEXT,
  score            INTEGER NOT NULL DEFAULT 0, -- 0-100
  score_breakdown  JSONB,                      -- детали скоринга
  top_opportunities JSONB,                     -- топ-5 упущенных запросов
  status           TEXT NOT NULL DEFAULT 'new', -- new/queued/sent/replied/converted/rejected/unsubscribed
  source_serp_task UUID REFERENCES serp_b2b_tasks(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_outreach_prospects_url_campaign ON outreach_prospects(url, campaign_id);
CREATE INDEX IF NOT EXISTS ix_outreach_prospects_campaign ON outreach_prospects(campaign_id, score DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_prospects_status ON outreach_prospects(status, campaign_id);

-- ── Отправленные письма ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_emails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id      UUID NOT NULL REFERENCES outreach_prospects(id) ON DELETE CASCADE,
  campaign_id      UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email  TEXT NOT NULL,
  recipient_domain TEXT NOT NULL,
  subject          TEXT,
  html_preview     TEXT,                       -- первые 500 символов
  resend_id        TEXT UNIQUE,               -- ID из Resend API
  status           outreach_email_status NOT NULL DEFAULT 'queued',
  error_message    TEXT,
  queued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  opened_at        TIMESTAMPTZ,
  clicked_at       TIMESTAMPTZ,
  replied_at       TIMESTAMPTZ,
  bounced_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_campaign ON outreach_emails(campaign_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_prospect ON outreach_emails(prospect_id);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_resend ON outreach_emails(resend_id);
-- Защита от повторной отправки (cooldown 30 дней на домен)
CREATE INDEX IF NOT EXISTS ix_outreach_emails_domain_sent ON outreach_emails(recipient_domain, sent_at DESC);

-- ── Отписки ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_unsubscribes (
  email      TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_unsubscribes_domain ON outreach_unsubscribes(domain);

-- ── Логи кампании (для UI) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_logs (
  id          BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info',    -- info/warn/error/success
  message     TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_logs_campaign ON outreach_logs(campaign_id, created_at DESC);

-- ── Настройки прогрева (справочник) ──────────────────────────────────
-- Лимиты по неделям прогрева: неделя → макс писем в день
CREATE TABLE IF NOT EXISTS outreach_warmup_schedule (
  week_number  INTEGER PRIMARY KEY,
  daily_limit  INTEGER NOT NULL,
  description  TEXT
);
INSERT INTO outreach_warmup_schedule (week_number, daily_limit, description) VALUES
  (1, 10,  'Прогрев: 1-я неделя — осторожный старт'),
  (2, 25,  'Прогрев: 2-я неделя — умеренный рост'),
  (3, 60,  'Прогрев: 3-я неделя — активный рост'),
  (4, 120, 'Прогрев: 4-я неделя — рабочий режим'),
  (5, 200, 'Прогрев: 5-я неделя — максимальный режим')
ON CONFLICT (week_number) DO NOTHING;
```

**Задача 3.1:** Добавить выполнение миграции в `backend/server.js` в блок `runMigrations()` (по аналогии с существующими миграциями).

---

## 4. Backend: новые сервисы

### 4.1. `backend/src/services/outreach/nicheExpander.js`

Определяет нишу и генерирует варианты запросов для мультигео-сбора.

```javascript
'use strict';
/**
 * nicheExpander — определяет нишу бизнеса по запросу и генерирует
 * список serpB2b-задач для мультигео сбора.
 *
 * Использует DeepSeek (дешёвый, быстрый) через существующий callLLM.
 */
const { callLLM } = require('../llm/callLLM');

// Маппинг городов → Яндекс lr-коды (расширить при необходимости)
const CITY_TO_LR = {
  'Москва': '213', 'Санкт-Петербург': '2', 'Краснодар': '35',
  'Екатеринбург': '54', 'Новосибирск': '65', 'Казань': '43',
  'Нижний Новгород': '47', 'Ростов-на-Дону': '39', 'Уфа': '172',
  'Самара': '51', 'Пермь': '50', 'Омск': '66', 'Челябинск': '56',
  'Воронеж': '193', 'Волгоград': '38', 'Красноярск': '62',
  'Тюмень': '55', 'Иркутск': '63', 'Хабаровск': '76', 'Владивосток': '75',
  'Барнаул': '197', 'Ярославль': '16', 'Тольятти': '51',
  'Ставрополь': '36', 'Астрахань': '37', 'Пенза': '49', 'Липецк': '48',
  'Тула': '15', 'Киров': '46', 'Чебоксары': '45', 'Рязань': '10',
  'Томск': '67', 'Кемерово': '64', 'Набережные Челны': '43',
};

const SYSTEM_PROMPT = `Ты — SEO-аналитик. Тебе дают поисковый запрос.
Определи нишу бизнеса и сгенерируй запросы для поиска конкурентов в этой нише.

Верни ТОЛЬКО JSON без markdown:
{
  "niche": "короткое название ниши (1-3 слова)",
  "business_type": "B2B" | "B2C" | "mixed",
  "queries": ["запрос 1 для поиска конкурентов", "запрос 2", "запрос 3"],
  "niche_description": "1-2 предложения описания ниши для персонализации письма"
}

Правила для queries:
- Запросы должны находить САЙТЫ КОМПАНИЙ в этой нише (не статьи, не форумы)
- Используй коммерческие запросы: "услуги", "цены", "заказать", "купить"
- 3 разных варианта запроса`;

async function analyzeNiche(keyword) {
  const result = await callLLM('deepseek', SYSTEM_PROMPT, keyword, {
    retries: 2, temperature: 0.3, maxTokens: 500,
    callLabel: 'outreach.nicheExpander',
  });
  return result;
}

/**
 * Генерирует список параметров для serpB2b-задач по городам.
 * @param {object} params
 * @param {string} params.keyword — исходный запрос
 * @param {string[]} params.cities — список городов
 * @param {string} params.searchEngine — 'yandex' | 'google'
 * @param {number} params.depthPages — глубина SERP
 * @returns {Promise<{analysis: object, serpTasks: object[]}>}
 */
async function expandNicheToGeo({ keyword, cities, searchEngine = 'yandex', depthPages = 3 }) {
  const analysis = await analyzeNiche(keyword);
  const serpTasks = [];

  for (const city of cities) {
    const lr = CITY_TO_LR[city] || '';
    // Берём первые 2 запроса из analysis.queries для каждого города
    const queries = (analysis.queries || [keyword]).slice(0, 2);
    for (const query of queries) {
      serpTasks.push({
        name: `[Outreach] ${analysis.niche} — ${city}`,
        query: `${query} ${city}`,
        search_engine: searchEngine,
        depth_pages: depthPages,
        region: lr,
        _city: city,
        _niche: analysis.niche,
      });
    }
  }

  return { analysis, serpTasks };
}

module.exports = { expandNicheToGeo, analyzeNiche, CITY_TO_LR };
```

### 4.2. `backend/src/services/outreach/prospectScorer.js`

```javascript
'use strict';
/**
 * prospectScorer — скоринг лидов (0-100).
 * Чем выше score, тем приоритетнее лид для outreach.
 */

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'mail.ru', 'yandex.ru', 'yahoo.com', 'outlook.com',
  'hotmail.com', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru',
  'icloud.com', 'protonmail.com', 'tutanota.com',
]);

function isCorporateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && !FREE_EMAIL_PROVIDERS.has(domain);
}

/**
 * @param {object} prospect — строка из serpB2b results
 * @returns {{ score: number, breakdown: object }}
 */
function scoreProspect(prospect) {
  const breakdown = {};
  let score = 0;

  // 1. Динамика (главный сигнал — есть боль)
  if (prospect.dynamics?.yandex?.trend === 'decline') {
    score += 35; breakdown.yandex_decline = 35;
  } else if (prospect.dynamics?.yandex?.trend === 'stagnation') {
    score += 10; breakdown.yandex_stagnation = 10;
  }
  if (prospect.dynamics?.google?.trend === 'decline') {
    score += 20; breakdown.google_decline = 20;
  } else if (prospect.dynamics?.google?.trend === 'stagnation') {
    score += 5; breakdown.google_stagnation = 5;
  }

  // 2. Качество контакта
  const corporateEmails = (prospect.emails || []).filter(isCorporateEmail);
  if (corporateEmails.length > 0) {
    score += 20; breakdown.has_corporate_email = 20;
  } else if ((prospect.emails || []).length > 0) {
    score += 5; breakdown.has_free_email = 5;
  }

  // 3. Верифицированное юрлицо
  if (prospect.inn) { score += 10; breakdown.has_inn = 10; }
  if (prospect.company_name) { score += 5; breakdown.has_company_name = 5; }

  // 4. Знаем нишу (есть услуги)
  if ((prospect.services || []).length > 0) {
    score += 5; breakdown.has_services = 5;
  }

  // Штрафы
  if (!prospect.emails?.length) { score -= 20; breakdown.no_email = -20; }

  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

module.exports = { scoreProspect, isCorporateEmail, FREE_EMAIL_PROVIDERS };
```

### 4.3. `backend/src/services/outreach/emailComposer.js`

```javascript
'use strict';
/**
 * emailComposer — генерирует персонализированное HTML-письмо
 * через DeepSeek на основе данных о компании-лиде.
 */
const { callLLM } = require('../llm/callLLM');

const SYSTEM_PROMPT = `Ты — опытный B2B-копирайтер для SEO-агентства.
Пишешь персонализированные холодные email.

СТРОГИЕ ПРАВИЛА:
1. Длина: 3-4 абзаца, максимум 180 слов в тексте
2. Первый абзац: конкретный факт о сайте получателя (домен, ниша, город)
3. Второй абзац: их конкретная проблема с данными (если есть динамика — используй)
4. Третий абзац: что предлагаем (конкретно, 1-2 предложения)
5. CTA: один вопрос или предложение созвониться
6. ЗАПРЕЩЕНЫ слова: уникальный, эффективный, профессиональный, качественный, комплексный
7. Тон: деловой, живой, не роботизированный
8. Обязательно упомянуть домен или название компании в первом абзаце

Верни ТОЛЬКО JSON без markdown:
{
  "subject": "тема письма (до 60 символов, без спам-слов)",
  "html": "HTML-тело письма (только содержимое body, без html/head/body тегов)"
}

HTML должен использовать только inline-стили. Шрифт: Arial, 14px, цвет #333.
Ссылки: цвет #0071E3.`;

/**
 * @param {object} params
 * @param {object} params.prospect — данные о лиде
 * @param {string} params.senderName — имя отправителя
 * @param {string} params.senderCompany — название компании отправителя
 * @param {string} params.unsubscribeUrl — URL для отписки
 * @returns {Promise<{subject: string, html: string}>}
 */
async function composeEmail({ prospect, senderName, senderCompany, unsubscribeUrl }) {
  const dynamicsText = formatDynamics(prospect);

  const context = `Данные о компании-получателе:
- Сайт: ${prospect.url}
- Название: ${prospect.company_name || 'не определено'}
- Ниша: ${prospect.niche || 'не определена'}
- Город: ${prospect.city || 'не определён'}
- Услуги: ${(prospect.services || []).slice(0, 5).join(', ') || 'не определены'}
- Динамика видимости: ${dynamicsText}

Отправитель:
- Имя: ${senderName}
- Компания: ${senderCompany}`;

  const result = await callLLM('deepseek', SYSTEM_PROMPT, context, {
    retries: 2, temperature: 0.75, maxTokens: 1200,
    callLabel: 'outreach.emailComposer',
  });

  // Добавляем обязательный footer с отпиской
  const footer = `
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:Arial,sans-serif;">
  Вы получили это письмо, так как ваш сайт был найден в поисковой выдаче по тематике вашего бизнеса.  

  <a href="${unsubscribeUrl}" style="color:#999;">Отписаться от рассылки</a>
</div>`;

  return {
    subject: result.subject,
    html: (result.html || '') + footer,
  };
}

function formatDynamics(prospect) {
  const y = prospect.dynamics_yandex;
  const g = prospect.dynamics_google;
  if (!y && !g) return 'данных нет';
  const parts = [];
  if (y) parts.push(`Яндекс: ${y === 'decline' ? 'падение' : y === 'growth' ? 'рост' : 'стагнация'}`);
  if (g) parts.push(`Google: ${g === 'decline' ? 'падение' : g === 'growth' ? 'рост' : 'стагнация'}`);
  return parts.join(', ');
}

module.exports = { composeEmail };
```

### 4.4. `backend/src/services/outreach/emailSender.js`

```javascript
'use strict';
/**
 * emailSender — отправка писем через Resend API.
 * Включает: защиту от повторной отправки, фильтр корпоративных email,
 * логирование в БД.
 */
const { Resend } = require('resend');
const db = require('../../config/db');
const { FREE_EMAIL_PROVIDERS } = require('./prospectScorer');

let _resend = null;
function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY не задан в .env');
    _resend = new Resend(key);
  }
  return _resend;
}

/**
 * Проверяет cooldown: не отправляли ли на этот домен за последние 30 дней.
 */
async function checkCooldown(domain) {
  const { rows } = await db.query(
    `SELECT id FROM outreach_emails
      WHERE recipient_domain = $1
        AND sent_at > NOW() - INTERVAL '30 days'
        AND status NOT IN ('failed', 'bounced')
      LIMIT 1`,
    [domain],
  );
  return rows.length === 0; // true = можно отправлять
}

/**
 * Проверяет, не отписался ли получатель.
 */
async function isUnsubscribed(email) {
  const { rows } = await db.query(
    `SELECT email FROM outreach_unsubscribes WHERE email = $1 LIMIT 1`,
    [email.toLowerCase()],
  );
  return rows.length > 0;
}

/**
 * Основная функция отправки.
 * @returns {Promise<{resendId: string}>}
 */
async function sendEmail({ emailId, to, subject, html, fromEmail, fromName }) {
  // 1. Проверяем корпоративный email
  const domain = to.split('@')[1]?.toLowerCase();
  if (FREE_EMAIL_PROVIDERS.has(domain)) {
    throw new Error(`Пропускаем бесплатный провайдер: ${domain}`);
  }

  // 2. Проверяем отписку
  if (await isUnsubscribed(to)) {
    throw new Error(`Получатель отписался: ${to}`);
  }

  // 3. Проверяем cooldown
  if (!(await checkCooldown(domain))) {
    throw new Error(`Cooldown активен для домена: ${domain}`);
  }

  // 4. Отправляем через Resend
  const resend = getResend();
  const fromAddress = fromName
    ? `${fromName} <${fromEmail}>`
    : fromEmail;

  const { data, error } = await resend.emails.send({
    from: fromAddress,
    to,
    subject,
    html,
    headers: { 'X-Email-Id': emailId }, // для трекинга
  });

  if (error) throw new Error(`Resend error: ${error.message}`);

  // 5. Обновляем статус в БД
  await db.query(
    `UPDATE outreach_emails
        SET status = 'sent', resend_id = $1, sent_at = NOW()
      WHERE id = $2`,
    [data.id, emailId],
  );

  return { resendId: data.id };
}

module.exports = { sendEmail, checkCooldown, isUnsubscribed };
```

### 4.5. `backend/src/services/outreach/emailQueue.js`

```javascript
'use strict';
/**
 * emailQueue — BullMQ очередь для отправки писем с throttling.
 * Использует существующее Redis-соединение из src/queue/queue.js.
 */
const { Queue, Worker } = require('bullmq');
const { connection } = require('../../queue/queue');
const db = require('../../config/db');
const { sendEmail } = require('./emailSender');

const EMAIL_QUEUE_NAME = 'outreach-emails';

// Создаём очередь
const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 }, // 1→2→4 минуты
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 500 },
  },
});

// Worker с throttling: не более 10 писем в час
let emailWorker = null;

function startEmailWorker() {
  if (emailWorker) return;

  emailWorker = new Worker(EMAIL_QUEUE_NAME, async (job) => {
    const { emailId, to, subject, html, fromEmail, fromName } = job.data;

    try {
      const { resendId } = await sendEmail({ emailId, to, subject, html, fromEmail, fromName });

      // Логируем успех
      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'success', $1, $2
           FROM outreach_emails WHERE id = $3`,
        [`Письмо отправлено на ${to}`, JSON.stringify({ resendId }), emailId],
      );
    } catch (err) {
      // Обновляем статус ошибки
      await db.query(
        `UPDATE outreach_emails SET status = 'failed', error_message = $1 WHERE id = $2`,
        [err.message, emailId],
      );

      await db.query(
        `INSERT INTO outreach_logs (campaign_id, level, message, meta)
         SELECT campaign_id, 'error', $1, $2
           FROM outreach_emails WHERE id = $3`,
        [`Ошибка отправки на ${to}: ${err.message}`, JSON.stringify({ error: err.message }), emailId],
      );

      throw err; // BullMQ сделает retry
    }
  }, {
    connection,
    concurrency: 1,
    limiter: {
      max: 10,          // 10 писем
      duration: 3600000, // за 1 час
    },
  });

  emailWorker.on('error', (err) => {
    console.error('[outreach/emailWorker] error:', err.message);
  });

  console.log('[outreach] Email worker запущен (лимит: 10 писем/час)');
}

function stopEmailWorker() {
  if (emailWorker) {
    emailWorker.close();
    emailWorker = null;
  }
}

module.exports = { emailQueue, startEmailWorker, stopEmailWorker };
```

### 4.6. `backend/src/services/outreach/outreachScheduler.js`

```javascript
'use strict';
/**
 * outreachScheduler — фоновый планировщик кампаний.
 * Каждые 60 минут проверяет активные кампании и запускает
 * сбор лидов + постановку писем в очередь.
 *
 * Паттерн: аналогичен seoBrainScheduler.js
 */
const db = require('../../config/db');
const { expandNicheToGeo } = require('./nicheExpander');
const { scoreProspect, isCorporateEmail } = require('./prospectScorer');
const { composeEmail } = require('./emailComposer');
const { emailQueue } = require('./emailQueue');
const { processSerpB2bTask } = require('../serpB2b/pipeline');

const POLL_MS = 60 * 60 * 1000; // 1 час
let _timer = null;

async function runTick() {
  // Находим кампании, которым пора запуститься
  const { rows: campaigns } = await db.query(
    `SELECT * FROM outreach_campaigns
      WHERE status = 'active'
        AND (next_run_at IS NULL OR next_run_at <= NOW())
      ORDER BY next_run_at ASC NULLS FIRST
      LIMIT 5`
  );

  for (const campaign of campaigns) {
    try {
      await runCampaignCycle(campaign);
    } catch (err) {
      console.error(`[outreach] Ошибка кампании ${campaign.id}:`, err.message);
      await db.query(
        `UPDATE outreach_campaigns SET status = 'error', error_message = $1 WHERE id = $2`,
        [err.message, campaign.id],
      );
    }
  }
}

async function runCampaignCycle(campaign) {
  const appUrl = process.env.APP_URL || 'https://localhost:3000';
  const fromEmail = process.env.OUTREACH_FROM_EMAIL || campaign.sender_email;
  const fromName = process.env.OUTREACH_FROM_NAME || campaign.sender_name || 'SEO Team';

  await log(campaign.id, 'info', `Запуск цикла кампании: ${campaign.name}` );

  // 1. Определяем дневной лимит по расписанию прогрева
  const { rows: warmup } = await db.query(
    `SELECT daily_limit FROM outreach_warmup_schedule WHERE week_number = $1`,
    [campaign.warmup_week],
  );
  const dailyLimit = Math.min(
    campaign.daily_limit,
    warmup[0]?.daily_limit || 10,
  );

  // 2. Считаем сколько уже отправили сегодня
  const { rows: todaySent } = await db.query(
    `SELECT COUNT(*) as cnt FROM outreach_emails
      WHERE campaign_id = $1
        AND sent_at > NOW() - INTERVAL '24 hours'`,
    [campaign.id],
  );
  const sentToday = parseInt(todaySent[0]?.cnt || 0);
  const canSendToday = dailyLimit - sentToday;

  if (canSendToday <= 0) {
    await log(campaign.id, 'info', `Дневной лимит исчерпан (${dailyLimit} писем). Следующий запуск завтра.`);
    await db.query(
      `UPDATE outreach_campaigns SET next_run_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
      [campaign.id],
    );
    return;
  }

  // 3. Берём лиды с высоким score, которым ещё не отправляли
  const { rows: prospects } = await db.query(
    `SELECT * FROM outreach_prospects
      WHERE campaign_id = $1
        AND status = 'new'
        AND array_length(emails, 1) > 0
        AND score >= 50
      ORDER BY score DESC
      LIMIT $2`,
    [campaign.id, canSendToday],
  );

  if (prospects.length === 0) {
    // Нет лидов — запускаем новый сбор
    await log(campaign.id, 'info', 'Нет новых лидов, запускаем сбор...');
    await collectNewProspects(campaign);
    await db.query(
      `UPDATE outreach_campaigns SET next_run_at = NOW() + INTERVAL '2 hours' WHERE id = $1`,
      [campaign.id],
    );
    return;
  }

  // 4. Генерируем письма и ставим в очередь
  let queued = 0;
  for (const prospect of prospects) {
    try {
      const email = prospect.emails.find(isCorporateEmail) || prospect.emails[0];
      if (!email) continue;

      // Генерируем письмо
      const unsubToken = require('crypto').randomBytes(16).toString('hex');
      const unsubUrl = `${appUrl}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`;

      const composed = await composeEmail({
        prospect: { ...prospect, niche: campaign.niche },
        senderName: fromName,
        senderCompany: fromName,
        unsubscribeUrl: unsubUrl,
      });

      // Создаём запись письма в БД
      const { rows: emailRows } = await db.query(
        `INSERT INTO outreach_emails
           (prospect_id, campaign_id, user_id, recipient_email, recipient_domain, subject, html_preview, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
         RETURNING id`,
        [
          prospect.id, campaign.id, campaign.user_id,
          email, email.split('@')[1],
          composed.subject, composed.html.slice(0, 500),
        ],
      );
      const emailId = emailRows[0].id;

      // Сохраняем токен отписки
      await db.query(
        `INSERT INTO outreach_unsubscribes (email, domain, token)
         VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
        [email.toLowerCase(), email.split('@')[1], unsubToken],
      );

      // Ставим в очередь с задержкой (равномерно в течение рабочего дня)
      const delayMs = calculateSendDelay(queued, prospects.length);
      await emailQueue.add('send-email', {
        emailId, to: email,
        subject: composed.subject,
        html: composed.html,
        fromEmail, fromName,
      }, { delay: delayMs });

      // Обновляем статус лида
      await db.query(
        `UPDATE outreach_prospects SET status = 'queued' WHERE id = $1`,
        [prospect.id],
      );

      queued++;
    } catch (err) {
      await log(campaign.id, 'warn', `Ошибка подготовки письма для ${prospect.url}: ${err.message}`);
    }
  }

  // 5. Обновляем статистику кампании
  await db.query(
    `UPDATE outreach_campaigns
        SET total_sent = total_sent + $1,
            last_run_at = NOW(),
            next_run_at = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
      WHERE id = $2`,
    [queued, campaign.id],
  );

  // 6. Проверяем прогрев (раз в неделю повышаем лимит)
  await checkWarmupProgression(campaign);

  await log(campaign.id, 'success', `Поставлено в очередь: ${queued} писем`);
}

async function collectNewProspects(campaign) {
  const { analysis, serpTasks } = await expandNicheToGeo({
    keyword: campaign.keyword,
    cities: campaign.cities,
    searchEngine: campaign.search_engine,
    depthPages: campaign.depth_pages,
  });

  // Обновляем нишу если ещё не определена
  if (!campaign.niche && analysis.niche) {
    await db.query(
      `UPDATE outreach_campaigns SET niche = $1, business_type = $2 WHERE id = $3`,
      [analysis.niche, analysis.business_type, campaign.id],
    );
  }

  let collected = 0;
  for (const taskParams of serpTasks) {
    try {
      // Создаём serpB2b задачу
      const { rows } = await db.query(
        `INSERT INTO serp_b2b_tasks
           (user_id, name, query, search_engine, depth_pages, region, status, inputs)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb)
         RETURNING id`,
        [
          campaign.user_id, taskParams.name, taskParams.query,
          taskParams.search_engine, taskParams.depth_pages, taskParams.region,
          JSON.stringify(taskParams),
        ],
      );
      const serpTaskId = rows[0].id;

      // Запускаем пайплайн
      await processSerpB2bTask(serpTaskId, campaign.user_id);

      // Забираем результаты и создаём лиды
      const { rows: serpRows } = await db.query(
        `SELECT results FROM serp_b2b_tasks WHERE id = $1`,
        [serpTaskId],
      );
      const results = serpRows[0]?.results || [];

      for (const site of results) {
        if (!site.emails?.length) continue;
        const { score, breakdown } = scoreProspect(site);
        if (score < 30) continue; // отсеиваем совсем плохие лиды

        await db.query(
          `INSERT INTO outreach_prospects
             (campaign_id, user_id, url, company_name, inn, emails, phones,
              niche, city, services, dynamics_yandex, dynamics_google,
              score, score_breakdown, source_serp_task)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (url, campaign_id) DO NOTHING`,
          [
            campaign.id, campaign.user_id, site.url, site.company_name,
            site.inn, site.emails || [], site.phones || [],
            taskParams._niche, taskParams._city, site.services || [],
            site.dynamics?.yandex?.trend || null,
            site.dynamics?.google?.trend || null,
            score, JSON.stringify(breakdown), serpTaskId,
          ],
        );
        collected++;
      }
    } catch (err) {
      await log(campaign.id, 'warn', `Ошибка сбора по запросу "${taskParams.query}": ${err.message}`);
    }
  }

  await db.query(
    `UPDATE outreach_campaigns SET total_prospects = total_prospects + $1 WHERE id = $2`,
    [collected, campaign.id],
  );

  await log(campaign.id, 'info', `Собрано новых лидов: ${collected}`);
}

// Равномерно распределяем отправку в рабочие часы (9:00-18:00)
function calculateSendDelay(index, total) {
  const now = new Date();
  const workStart = new Date(now);
  workStart.setHours(9, 0, 0, 0);
  const workEnd = new Date(now);
  workEnd.setHours(18, 0, 0, 0);

  if (now > workEnd) {
    workStart.setDate(workStart.getDate() + 1);
    workEnd.setDate(workEnd.getDate() + 1);
  }

  const workMs = workEnd - workStart;
  const step = workMs / Math.max(total, 1);
  const target = new Date(workStart.getTime() + step * index);
  const delay = target - now;
  return Math.max(0, delay);
}

async function checkWarmupProgression(campaign) {
  if (!campaign.last_run_at) return;
  const daysSinceStart = Math.floor((Date.now() - new Date(campaign.created_at)) / 86400000);
  const expectedWeek = Math.min(5, Math.floor(daysSinceStart / 7) + 1);
  if (expectedWeek > campaign.warmup_week) {
    await db.query(
      `UPDATE outreach_campaigns SET warmup_week = $1 WHERE id = $2`,
      [expectedWeek, campaign.id],
    );
    await log(campaign.id, 'info', `Прогрев: переход на неделю ${expectedWeek} (лимит ${[10,25,60,120,200][expectedWeek-1]} писем/день)`);
  }
}

async function log(campaignId, level, message, meta = null) {
  await db.query(
    `INSERT INTO outreach_logs (campaign_id, level, message, meta) VALUES ($1, $2, $3, $4)`,
    [campaignId, level, message, meta ? JSON.stringify(meta) : null],
  );
}

function startOutreachScheduler() {
  if (_timer) return;
  runTick().catch((e) => console.warn('[outreach/scheduler] initial tick:', e.message));
  _timer = setInterval(() => {
    runTick().catch((e) => console.warn('[outreach/scheduler] interval:', e.message));
  }, POLL_MS);
  console.log('[outreach] Scheduler запущен (интервал: 1 час)');
}

function stopOutreachScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startOutreachScheduler, stopOutreachScheduler, runTick };
```

---

## 5. Backend: контроллер и роуты

### 5.1. `backend/src/controllers/outreach.controller.js`

Реализовать следующие эндпоинты (по паттерну `serpB2b.controller.js`):

```
GET    /api/outreach/campaigns              — список кампаний пользователя
POST   /api/outreach/campaigns              — создать кампанию
GET    /api/outreach/campaigns/:id          — детали кампании (поллинг)
PATCH  /api/outreach/campaigns/:id          — обновить (pause/resume/update settings)
DELETE /api/outreach/campaigns/:id          — удалить

GET    /api/outreach/campaigns/:id/prospects     — список лидов кампании (с пагинацией)
GET    /api/outreach/campaigns/:id/emails        — список писем (с пагинацией)
GET    /api/outreach/campaigns/:id/logs          — логи кампании (последние 200)
GET    /api/outreach/campaigns/:id/stats         — статистика (для графиков)

POST   /api/outreach/webhooks/resend        — Resend Webhook (без auth, с HMAC-проверкой)
GET    /api/outreach/unsubscribe            — страница отписки (публичная)
```

**Важно для webhook-эндпоинта:**

- Проверять HMAC-подпись из заголовка `svix-signature` (Resend использует Svix)

- Обрабатывать события: `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`

- При `email.complained` — автоматически добавлять в `outreach_unsubscribes`

- Обновлять `outreach_emails` и счётчики в `outreach_campaigns`

### 5.2. `backend/src/routes/outreach.routes.js`

По паттерну `serpB2b.routes.js`. Подключить в `backend/server.js`.

### 5.3. Подключение в `backend/server.js`

Добавить:

```javascript
// В блок require роутов (строки 23-49):
const outreachRoutes = require('./src/routes/outreach.routes');

// В блок app.use (строки ~150-170):
app.use('/api/outreach', outreachRoutes);

// В функции start() после запуска других schedulers:
try {
  const { startOutreachScheduler } = require('./src/services/outreach/outreachScheduler');
  const { startEmailWorker } = require('./src/services/outreach/emailQueue');
  startOutreachScheduler();
  startEmailWorker();
} catch (e) {
  console.warn('[Server] Outreach scheduler skipped:', e.message);
}
```

---

## 6. Frontend: компоненты и страницы

### 6.1. `frontend/src/stores/outreach.js`

Pinia store по паттерну `stores/serpB2b.js`. Методы:

- `fetchCampaigns()` — GET /api/outreach/campaigns

- `createCampaign(payload)` — POST /api/outreach/campaigns

- `getCampaign(id)` — GET /api/outreach/campaigns/:id

- `updateCampaign(id, payload)` — PATCH /api/outreach/campaigns/:id

- `deleteCampaign(id)` — DELETE /api/outreach/campaigns/:id

- `getCampaignStats(id)` — GET /api/outreach/campaigns/:id/stats

- `getCampaignLogs(id)` — GET /api/outreach/campaigns/:id/logs

- `getCampaignEmails(id, page)` — GET /api/outreach/campaigns/:id/emails

- `getCampaignProspects(id, page)` — GET /api/outreach/campaigns/:id/prospects

### 6.2. `frontend/src/views/OutreachPage.vue` — Главная страница

**Дизайн:** Apple Glassmorphism (фон `#F5F5F7`, карточки белые, кнопки `#0071E3`).

**Структура страницы:**

**Верхний блок — форма создания кампании:**

```
┌─────────────────────────────────────────────────────────────────┐
│  📨 Outreach — Автоматические email-рассылки                    │
│                                                                 │
│  Ниша / запрос: [ремонт квартир              ]                  │
│  Города:        [Москва ×] [Краснодар ×] [+ добавить]          │
│  Поисковик:     ● Яндекс  ○ Google                              │
│  Глубина SERP:  [3 страницы ▼]                                  │
│  Лимит/день:    [30 писем] (прогрев: авто)                      │
│  Имя отправителя: [Иван Иванов]                                 │
│                                                                 │
│  [🚀 Создать кампанию]                                          │
└─────────────────────────────────────────────────────────────────┘
```

**Блок информации о прогреве** (раскрывающийся аккордеон):

```
ℹ️ Как работает прогрев домена?
Неделя 1: 10 писем/день → Неделя 2: 25 → Неделя 3: 60 → Неделя 4: 120 → Неделя 5: 200
```

**Список кампаний** (карточки):

```
┌─────────────────────────────────────────────────────────────────┐
│  🟢 Ремонт квартир — Москва, Краснодар, Екатеринбург            │
│  Создана: 21 июля 2026 · Неделя прогрева: 2 (лимит: 25/день)   │
│                                                                 │
│  📊 Лидов: 147  ·  Отправлено: 89  ·  Открыто: 31 (34.8%)      │
│     Кликов: 12 (13.5%)  ·  Ответов: 4                          │
│                                                                 │
│  [Открыть] [⏸ Пауза] [🗑 Удалить]                              │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3. `frontend/src/views/OutreachCampaignPage.vue` — Детальная страница кампании

**Вкладки:** Обзор | Лиды | Письма | Логи

**Вкладка "Обзор":**

- KPI-карточки: Лидов / Отправлено / Доставлено / Открыто / Кликов / Ответов

- График ECharts: динамика отправок/открытий по дням (line chart)

- Прогресс-бар прогрева с текущей неделей

- Кнопки: Запустить сейчас / Пауза / Возобновить

**Вкладка "Лиды":**

- Таблица с колонками: Сайт | Компания | Email | Ниша | Город | Динамика Яндекс | Динамика Google | Score | Статус

- Фильтры: по статусу, по score, по городу

- Цветовая индикация score: зелёный ≥70, жёлтый 40-69, красный <40

- Цветовая индикация динамики: красный = падение, жёлтый = стагнация, зелёный = рост

**Вкладка "Письма":**

- Таблица: Получатель | Тема | Статус | Отправлено | Открыто | Кликнуто

- Статусы с иконками: 📤 queued, ✅ sent, 📬 delivered, 👁 opened, 🖱 clicked, ⚠️ bounced

- Клик на строку → модальное окно с превью HTML письма

**Вкладка "Логи":**

- Лента логов в реальном времени (поллинг каждые 5 сек пока кампания активна)

- Цветовые метки: 🟢 success, 🔵 info, 🟡 warn, 🔴 error

- Автопрокрутка вниз при новых записях

### 6.4. Публичная страница отписки

`frontend/src/views/UnsubscribePage.vue` — простая страница:

```
Вы успешно отписались от рассылки.
Ваш email больше не будет получать письма от нас.
```

Маршрут: `/unsubscribe` (без auth).

---

## 7. ENV-переменные (добавить в `.env.example`)

```
# ── Outreach (Email-рассылки) ──────────────────────────────────────────────
# Resend API Key: зарегистрируйтесь на resend.com → Settings → API Keys
# Формат: re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RESEND_API_KEY=

# Email отправителя (должен быть верифицирован в Resend → Domains)
# Инструкция: resend.com/docs/dashboard/domains/introduction
OUTREACH_FROM_EMAIL=team@yourdomain.ru

# Имя отправителя (отображается в почтовом клиенте)
OUTREACH_FROM_NAME=SEO Team

# Webhook Secret для верификации событий от Resend
# Resend → Webhooks → Create Webhook → скопировать Signing Secret
RESEND_WEBHOOK_SECRET=

# URL приложения (для ссылок отписки в письмах)
APP_URL=https://yourdomain.ru
```

---

## 8. Инструкция по подключению Resend (для README )

Создать файл `OUTREACH_SETUP.md` в корне репозитория:

```markdown
# Настройка модуля Outreach

## 1. Регистрация в Resend
1. Зайдите на resend.com и создайте аккаунт
2. Перейдите в Settings → API Keys → Create API Key
3. Скопируйте ключ в .env: `RESEND_API_KEY=re_xxxxxxxx`

## 2. Верификация домена-отправителя (ОБЯЗАТЕЛЬНО)
1. В Resend: Domains → Add Domain → введите ваш домен
2. Добавьте DNS-записи (SPF, DKIM, DMARC) в панели вашего хостинга
3. Дождитесь верификации (обычно 5-30 минут)
4. Установите: `OUTREACH_FROM_EMAIL=team@yourdomain.ru`

## 3. Настройка Webhook для трекинга
1. В Resend: Webhooks → Add Endpoint
2. URL: https://yourdomain.ru/api/outreach/webhooks/resend
3. Выберите события: email.sent, email.delivered, email.opened, email.clicked, email.bounced, email.complained
4. Скопируйте Signing Secret в .env: `RESEND_WEBHOOK_SECRET=whsec_xxxxxxxx`

## 4. Расписание прогрева домена
| Неделя | Писем/день | Действие |
|--------|-----------|---------|
| 1-я    | 10        | Старт, мониторить spam rate |
| 2-я    | 25        | Проверить open rate (цель >25% ) |
| 3-я    | 60        | Если spam rate <0.1% — продолжаем |
| 4-я    | 120       | Рабочий режим |
| 5-я+   | 200       | Максимум |

## 5. Метрики для мониторинга
- Open Rate: цель ≥ 25%
- Spam Rate: должен быть < 0.1%
- Bounce Rate: должен быть < 2%
```

---

## 9. Установка зависимостей

```bash
# В backend/
npm install resend svix
```

---

## 10. Чеклист реализации

- [ ] `migrations/121_outreach.sql` — создать и подключить

- [ ] `backend/src/services/outreach/nicheExpander.js`

- [ ] `backend/src/services/outreach/prospectScorer.js`

- [ ] `backend/src/services/outreach/emailComposer.js`

- [ ] `backend/src/services/outreach/emailSender.js`

- [ ] `backend/src/services/outreach/emailQueue.js`

- [ ] `backend/src/services/outreach/outreachScheduler.js`

- [ ] `backend/src/controllers/outreach.controller.js`

- [ ] `backend/src/routes/outreach.routes.js`

- [ ] Подключить роут и schedulers в `backend/server.js`

- [ ] `frontend/src/stores/outreach.js`

- [ ] `frontend/src/views/OutreachPage.vue`

- [ ] `frontend/src/views/OutreachCampaignPage.vue`

- [ ] `frontend/src/views/UnsubscribePage.vue`

- [ ] Обновить `frontend/src/components/AppLayout.vue` (навигация)

- [ ] Обновить `frontend/src/router/index.js` (маршруты)

- [ ] `.env.example` — добавить секцию Outreach

- [ ] `OUTREACH_SETUP.md` — инструкция по подключению

