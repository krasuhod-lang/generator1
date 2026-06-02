# Подключение Google Search Console — пошаговая инструкция

> Модуль **«Проекты»** связывает SEO-проект с вашим аккаунтом Google Search
> Console (GSC) по протоколу **OAuth 2.0** и подтягивает данные Search Analytics
> (клики, показы, CTR, позиции) для дашборда и AI-аналитики DeepSeek.
>
> Доступ запрашивается **только на чтение** (scope
> `https://www.googleapis.com/auth/webmasters.readonly`). OAuth-токены
> хранятся в БД **строго в зашифрованном виде** (AES-256-GCM).

---

## TL;DR

1. В **Google Cloud Console** создайте OAuth-клиента и включите **Search Console API**.
2. Пропишите 3 секрета окружения: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`.
3. Перезапустите backend.
4. В интерфейсе: **Проекты → создать проект → «Подключить Google Search
   Console» → выбрать домен**.

---

## Часть 1. Настройка на стороне Google Cloud

### 1.1. Создайте проект Google Cloud
1. Откройте [Google Cloud Console](https://console.cloud.google.com/).
2. Вверху выберите/создайте проект (например, `seo-generator`).

### 1.2. Включите Search Console API
1. Перейдите в **APIs & Services → Library** (Библиотека API).
2. Найдите **Google Search Console API** и нажмите **Enable** (Включить).

### 1.3. Настройте экран согласия (OAuth consent screen)
1. **APIs & Services → OAuth consent screen**.
2. Тип: **External** (если аккаунты не в Google Workspace).
3. Заполните название приложения, e-mail поддержки и контакт разработчика.
4. На шаге **Scopes** добавьте scope
   `https://www.googleapis.com/auth/webmasters.readonly`.
5. Пока приложение в статусе **Testing**, добавьте Google-аккаунты, которым
   разрешён вход, в раздел **Test users**.

### 1.4. Создайте OAuth-клиента (Client ID)
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Тип приложения: **Web application**.
3. **Authorized redirect URIs** — укажите адрес колбэка backend. Он должен
   **в точности** совпадать со значением `GOOGLE_OAUTH_REDIRECT_URI`:

   ```
   https://<ваш-домен>/api/public/projects/gsc/callback
   ```

   Для локальной разработки, например:

   ```
   http://localhost:3000/api/public/projects/gsc/callback
   ```

4. Нажмите **Create** и скопируйте **Client ID** и **Client secret**.

> ⚠️ Путь колбэка фиксирован в коде: публичный роут
> `GET /api/public/projects/gsc/callback`. Меняется только схема/домен/порт
> перед ним.

---

## Часть 2. Настройка секретов окружения

Backend читает Google-секреты из переменных окружения (файл `.env.example`
не трогаем — добавляем переменные в реальное окружение/`.env`):

| Переменная | Обязательна | Назначение |
|---|---|---|
| `GOOGLE_CLIENT_ID` | да | Client ID OAuth-клиента из Google Cloud |
| `GOOGLE_CLIENT_SECRET` | да | Client secret OAuth-клиента |
| `GOOGLE_OAUTH_REDIRECT_URI` | да | Точный адрес колбэка (см. п. 1.4) |
| `FRONTEND_BASE_URL` | опц. | База фронтенда для редиректа после OAuth. По умолчанию — относительный путь (backend и frontend за одним nginx) |
| `PROJECTS_TOKEN_KEY` | опц. | Ключ шифрования OAuth-токенов. Если не задан — используется уже существующий `JWT_SECRET` |

Если все три обязательные переменные заданы — интеграция считается
сконфигурированной. Если нет — модуль «Проекты» (CRUD, шаринг) продолжает
работать, а GSC-эндпоинты деградируют с понятной ошибкой
`gsc_not_configured` (HTTP 503).

После изменения переменных **перезапустите backend**.

---

## Часть 3. Подключение в интерфейсе

1. Войдите в приложение и откройте раздел **«Проекты»**.
2. Нажмите **создать проект**, укажите название и URL сайта (та же ссылка,
   что подтверждена в Search Console).
3. На карточке проекта нажмите **«Подключить Google Search Console»**.
4. Откроется экран согласия Google — выберите аккаунт, у которого есть доступ
   к нужному ресурсу в GSC, и подтвердите доступ на чтение.
5. После согласия вы вернётесь в приложение (`?gsc=connected`).
6. **Выберите домен** из списка подтверждённых ресурсов вашего аккаунта GSC.
7. Готово — открывайте **дашборд эффективности** и запускайте **AI-аналитику**.

> Поддерживаются оба типа ресурсов GSC: **URL-prefix** (`https://example.com/`)
> и **Domain property** (`sc-domain:example.com`) — берётся то, что доступно в
> вашем аккаунте через `sites.list`.

---

## Как это работает (кратко)

| Шаг | Эндпоинт | Что делает |
|---|---|---|
| Ссылка на согласие | `GET /api/projects/:id/gsc/auth-url` | Формирует OAuth-URL (`access_type=offline`, `prompt=consent` → выдаётся `refresh_token`) с подписанным `state` (HMAC, защита от CSRF, TTL 1 час) |
| Колбэк Google | `GET /api/public/projects/gsc/callback` | Проверяет `state`, меняет `code` на токены, получает `sites.list`, сохраняет **зашифрованные** токены |
| Список доменов | `GET /api/projects/:id/gsc/sites` | Подтверждённые ресурсы аккаунта |
| Выбор домена | `POST /api/projects/:id/gsc/select-site` | Привязывает выбранный `siteUrl` к проекту |
| Данные дашборда | `GET /api/projects/:id/performance` | `searchAnalytics.query` с in-memory кэшем (TTL 10 мин — бережём лимиты GSC API) |
| Отключение | `DELETE /api/projects/:id/gsc` | Сбрасывает подключение и стирает токены |

`access_token` короткоживущий и автоматически обновляется по `refresh_token`
(который выдаётся при первом согласии). Все токены хранятся зашифрованными
(AES-256-GCM) и наружу через API не отдаются.

---

## Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `gsc_not_configured` (503) | Не заданы `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`. Проверьте окружение и перезапустите backend |
| `redirect_uri_mismatch` на экране Google | Значение `GOOGLE_OAUTH_REDIRECT_URI` не совпадает с **Authorized redirect URI** в Google Cloud (вплоть до схемы, порта и завершающего пути) |
| `?gsc=error&reason=invalid_state` | Истёк или подделан `state` (живёт 1 час). Начните подключение заново |
| `access_denied` | Аккаунт не добавлен в **Test users** (пока приложение в статусе Testing), либо у аккаунта нет доступа к ресурсу в GSC |
| Список доменов пуст | У выбранного Google-аккаунта нет подтверждённых ресурсов в Search Console — сначала подтвердите сайт в самом GSC |
| Нет `refresh_token` после повторного входа | Он выдаётся только при первом согласии. Отзовите доступ приложению в [настройках аккаунта Google](https://myaccount.google.com/permissions) и подключитесь заново (`prompt=consent` гарантирует повторную выдачу) |
