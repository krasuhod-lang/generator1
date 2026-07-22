# Настройка модуля Outreach

Модуль **Outreach** автоматически собирает лиды по нише и гео, скорит их,
генерирует персонализированные письма через DeepSeek и отправляет их через
[Resend](https://resend.com) с прогревом домена и трекингом
открытий/кликов/отписок.

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
| 2-я    | 25        | Проверить open rate (цель >25%) |
| 3-я    | 60        | Если spam rate <0.1% — продолжаем |
| 4-я    | 120       | Рабочий режим |
| 5-я+   | 200       | Максимум |

## 5. Метрики для мониторинга
- Open Rate: цель ≥ 25%
- Spam Rate: должен быть < 0.1%
- Bounce Rate: должен быть < 2%

## 6. Установка зависимостей

```bash
# В backend/
npm install resend svix
```

## 7. ENV-переменные

```
RESEND_API_KEY=re_xxxxxxxx
OUTREACH_FROM_EMAIL=team@yourdomain.ru
OUTREACH_FROM_NAME=SEO Team
RESEND_WEBHOOK_SECRET=whsec_xxxxxxxx
APP_URL=https://yourdomain.ru
```

## 8. Как это работает
1. Создайте кампанию на странице **📨 Outreach**: укажите нишу/запрос, города,
   поисковик, глубину SERP, дневной лимит и имя отправителя.
2. Фоновый планировщик (`outreachScheduler`) раз в час:
   - определяет нишу через DeepSeek и запускает мультигео-сбор сайтов
     через существующий serpB2b-пайплайн;
   - скорит лиды (0-100) по динамике видимости, качеству контакта и юрлицу;
   - генерирует персонализированные письма и ставит их в очередь BullMQ.
3. Worker очереди (`emailQueue`, лимит 10 писем/час) отправляет письма через
   Resend с учётом cooldown (30 дней на домен), отписок и фильтра бесплатных
   почтовых провайдеров.
4. Resend Webhook обновляет статусы писем и счётчики кампании; жалобы на спам
   автоматически добавляют получателя в список отписок.
5. Дашборд показывает статистику, графики, лиды, письма и логи в реальном
   времени.
