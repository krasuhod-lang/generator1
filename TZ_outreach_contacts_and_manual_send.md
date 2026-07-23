# ТЗ: Контакты лида (телефон + Telegram) и ручная отправка письма

## Контекст проекта
Стек: Node.js + Express (backend), Vue 3 + Pinia (frontend), PostgreSQL.
Паттерны: смотри `backend/src/controllers/outreach.controller.js`, `frontend/src/views/OutreachCampaignPage.vue`, `frontend/src/stores/outreach.js`.

---

## Задача 1 — Парсинг Telegram-ссылок и вывод контактов в таблице лидов

### 1.1 Backend: добавить парсинг t.me в extractors.js

**Файл:** `backend/src/services/serpB2b/extractors.js`

В функцию `extractContactsFromHtml(html)` (около строки 670) добавить парсинг ссылок на Telegram:

```js
// После блока парсинга phones — добавить:
// Парсинг Telegram-ссылок: t.me/username, https://t.me/username, @username в тексте
const telegramLinks = [];
// 1. href="https://t.me/..." или href="tg://..."
const tgHrefRe = /href=["'](?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})["']/gi;
let m;
while ((m = tgHrefRe.exec(html)) !== null) {
  if (!m[1].startsWith('+')) telegramLinks.push(`https://t.me/${m[1]}`);
}
// 2. Упоминания @username в тексте (только если рядом слово telegram/тг/tg)
const tgMentionRe = /(?:telegram|тг|tg)[^\w@]*@([A-Za-z0-9_]{5,32})/gi;
while ((m = tgMentionRe.exec(html)) !== null) {
  telegramLinks.push(`https://t.me/${m[1]}`);
}
const telegram = [...new Set(telegramLinks)].slice(0, 3);
```

В `return` функции добавить поле `telegram`:
```js
return { ..., phones, phones_mobile, phones_landline, telegram };
```

### 1.2 Backend: сохранять telegram в outreach_prospects

**Файл:** `migrations/123_outreach_contacts.sql` (создать новый файл):

```sql
-- Миграция 123: поле telegram для лидов Outreach
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='outreach_prospects' AND column_name='telegram'
  ) THEN
    ALTER TABLE outreach_prospects ADD COLUMN telegram TEXT[] NOT NULL DEFAULT '{}';
  END IF;
END $$;
```

**Файл:** `backend/server.js` — в функции `ensureSchema()` добавить применение миграции 123 по аналогии с миграциями 121 и 122 (блок try/catch с `fs.readFileSync` и `db.query`).

**Файл:** `backend/src/services/outreach/outreachScheduler.js` — в функции `collectNewProspects`, в блоке INSERT в `outreach_prospects`, добавить поле `telegram`:

```js
// В INSERT добавить колонку telegram и параметр:
// ... dynamics_detail, telegram, score ...
// ... $13, $14, $15, $16 ...
// В массив параметров добавить: site.telegram || []
```

### 1.3 Frontend: вывод телефона и Telegram в таблице лидов

**Файл:** `frontend/src/views/OutreachCampaignPage.vue`

В таблице лидов (секция `v-show="tab === 'prospects'"`) добавить два новых столбца после колонки "Email":

**В `<thead>`:**
```html
<th>Телефон</th><th>Telegram</th>
```

**В `<tbody>` (строка `<tr v-for="p in filteredProspects"`):**
```html
<!-- Телефон: показываем первый мобильный, кликабельный tel: -->
<td>
  <a v-if="(p.phones || []).length"
     :href="`tel:${(p.phones)[0]}`"
     class="contact-link phone-link"
     :title="(p.phones).join(', ')">
    📞 {{ (p.phones)[0] }}
  </a>
  <span v-else class="muted">—</span>
</td>
<!-- Telegram: ссылка открывается в новой вкладке -->
<td>
  <a v-if="(p.telegram || []).length"
     :href="(p.telegram)[0]"
     target="_blank" rel="noopener"
     class="contact-link tg-link"
     :title="(p.telegram).join(', ')">
    ✈️ Telegram
  </a>
  <span v-else class="muted">—</span>
</td>
```

**Стили (добавить в `<style scoped>`):**
```css
.contact-link { font-size: 12px; text-decoration: none; white-space: nowrap; }
.phone-link { color: #2E7D32; }
.tg-link { color: #0088cc; }
.contact-link:hover { text-decoration: underline; }
```

---

## Задача 2 — Кнопка «Отправить письмо» для лида в статусе queued/new

Позволяет вручную инициировать отправку письма конкретному лиду, минуя ожидание планировщика.

### 2.1 Backend: новый эндпоинт ручной отправки

**Файл:** `backend/src/controllers/outreach.controller.js`

Добавить новую функцию `sendProspectNow` после функции `listProspects`:

```js
/**
 * POST /api/outreach/campaigns/:id/prospects/:prospectId/send-now
 * Ручная немедленная отправка письма конкретному лиду.
 * Работает только если лид в статусе 'new' или 'queued' и у него есть email.
 */
async function sendProspectNow(req, res, next) {
  try {
    const { id: campaignId, prospectId } = req.params;
    const userId = req.user.id;

    // Проверяем что кампания принадлежит пользователю
    const { rows: camps } = await db.query(
      `SELECT * FROM outreach_campaigns WHERE id = $1 AND user_id = $2`,
      [campaignId, userId]
    );
    if (!camps.length) return res.status(404).json({ error: 'Кампания не найдена' });
    const campaign = camps[0];

    // Проверяем лида
    const { rows: prospects } = await db.query(
      `SELECT * FROM outreach_prospects WHERE id = $1 AND campaign_id = $2`,
      [prospectId, campaignId]
    );
    if (!prospects.length) return res.status(404).json({ error: 'Лид не найден' });
    const prospect = prospects[0];

    if (!['new', 'queued'].includes(prospect.status)) {
      return res.status(400).json({ error: `Лид уже в статусе "${prospect.status}", отправка невозможна` });
    }
    if (!prospect.emails?.length) {
      return res.status(400).json({ error: 'У лида нет email-адреса' });
    }

    const { composeEmail } = require('../services/outreach/emailComposer');
    const { emailQueue } = require('../services/outreach/emailQueue');
    const { isCorporateEmail } = require('../services/outreach/prospectScorer');
    const crypto = require('crypto');

    const appUrl = process.env.APP_URL || 'https://localhost:3000';
    const fromEmail = process.env.OUTREACH_FROM_EMAIL || campaign.sender_email;
    const fromName = process.env.OUTREACH_FROM_NAME || campaign.sender_name || 'SEO Team';

    const email = prospect.emails.find(isCorporateEmail) || prospect.emails[0];
    const unsubToken = crypto.randomBytes(16).toString('hex');
    const unsubUrl = `${appUrl}/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`;

    // Генерируем письмо
    const composed = await composeEmail({
      prospect: { ...prospect, niche: campaign.niche, dynamics_detail: prospect.dynamics_detail },
      senderName: fromName,
      senderCompany: fromName,
      unsubscribeUrl: unsubUrl,
    });

    // Сохраняем запись письма
    const { rows: emailRows } = await db.query(
      `INSERT INTO outreach_emails
         (prospect_id, campaign_id, user_id, recipient_email, recipient_domain, subject, html_preview, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING id`,
      [prospect.id, campaignId, userId, email, email.split('@')[1],
       composed.subject, composed.html.slice(0, 500)]
    );
    const emailId = emailRows[0].id;

    // Немедленно ставим в очередь (delay: 0)
    await emailQueue.add('send-email', {
      emailId, to: email,
      subject: composed.subject,
      html: composed.html,
      fromEmail, fromName,
    }, { delay: 0 });

    // Обновляем статус лида
    await db.query(
      `UPDATE outreach_prospects SET status = 'queued' WHERE id = $1`,
      [prospect.id]
    );

    // Пишем лог
    await db.query(
      `INSERT INTO outreach_logs (campaign_id, level, message)
       VALUES ($1, 'info', $2)`,
      [campaignId, `Ручная отправка письма для ${prospect.url} (${email})`]
    );

    return res.json({ ok: true, emailId, message: `Письмо поставлено в очередь для ${email}` });
  } catch (err) {
    return next(err);
  }
}
```

В `module.exports` добавить `sendProspectNow`.

### 2.2 Backend: подключить роут

**Файл:** `backend/src/routes/outreach.routes.js`

Добавить импорт `sendProspectNow` и роут:
```js
const { ..., sendProspectNow } = require('../controllers/outreach.controller');
// ...
router.post('/campaigns/:id/prospects/:prospectId/send-now', auth, createLimiter, sendProspectNow);
```

### 2.3 Frontend: кнопка в таблице лидов

**Файл:** `frontend/src/stores/outreach.js`

Добавить метод `sendProspectNow`:
```js
async sendProspectNow(campaignId, prospectId) {
  const res = await api.post(`/outreach/campaigns/${campaignId}/prospects/${prospectId}/send-now`);
  return res.data;
},
```

**Файл:** `frontend/src/views/OutreachCampaignPage.vue`

В таблице лидов добавить последний столбец «Действие»:

**В `<thead>`:**
```html
<th>Действие</th>
```

**В `<tbody>`:**
```html
<td>
  <button
    v-if="['new','queued'].includes(p.status)"
    class="btn btn-xs btn-primary send-now-btn"
    :disabled="sendingProspect === p.id"
    @click.stop="sendNow(p)"
    title="Отправить письмо сейчас"
  >
    {{ sendingProspect === p.id ? '⏳' : '📨 Отправить' }}
  </button>
  <span v-else class="muted">—</span>
</td>
```

**В `<script setup>` добавить:**
```js
const sendingProspect = ref(null);

async function sendNow(prospect) {
  if (sendingProspect.value) return;
  sendingProspect.value = prospect.id;
  try {
    const result = await store.sendProspectNow(campaignId, prospect.id);
    // Обновляем статус лида в локальном списке
    const idx = prospects.value.findIndex(p => p.id === prospect.id);
    if (idx !== -1) prospects.value[idx].status = 'queued';
    alert(`✅ ${result.message}`);
  } catch (err) {
    alert(`❌ Ошибка: ${err?.response?.data?.error || err.message}`);
  } finally {
    sendingProspect.value = null;
  }
}
```

**Стили (добавить в `<style scoped>`):**
```css
.btn-xs { padding: 3px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; }
.btn-primary { background: #0071E3; color: #fff; border: none; }
.btn-primary:hover:not(:disabled) { background: #0058b0; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.send-now-btn { white-space: nowrap; }
```

---

## Чеклист реализации (18 пунктов)

- [ ] 1. `backend/src/services/serpB2b/extractors.js` — добавить парсинг t.me ссылок, вернуть `telegram[]`
- [ ] 2. `migrations/123_outreach_contacts.sql` — CREATE (новый файл), ADD COLUMN telegram TEXT[]
- [ ] 3. `backend/server.js` — применить миграцию 123 в ensureSchema()
- [ ] 4. `backend/src/services/outreach/outreachScheduler.js` — сохранять `site.telegram || []` в INSERT outreach_prospects
- [ ] 5. `frontend/src/views/OutreachCampaignPage.vue` — добавить столбцы Телефон и Telegram в таблицу лидов
- [ ] 6. Стили для `.phone-link` и `.tg-link`
- [ ] 7. `backend/src/controllers/outreach.controller.js` — добавить функцию `sendProspectNow`
- [ ] 8. `module.exports` контроллера — добавить `sendProspectNow`
- [ ] 9. `backend/src/routes/outreach.routes.js` — импорт и роут POST `/:id/prospects/:prospectId/send-now`
- [ ] 10. `frontend/src/stores/outreach.js` — метод `sendProspectNow(campaignId, prospectId)`
- [ ] 11. `frontend/src/views/OutreachCampaignPage.vue` — столбец Действие в таблице лидов
- [ ] 12. `frontend/src/views/OutreachCampaignPage.vue` — `sendingProspect = ref(null)`
- [ ] 13. `frontend/src/views/OutreachCampaignPage.vue` — функция `sendNow(prospect)`
- [ ] 14. Стили `.btn-xs`, `.btn-primary`, `.send-now-btn`
- [ ] 15. Проверить что `node --check` проходит для всех изменённых backend-файлов
- [ ] 16. Проверить что `npm run build` фронтенда успешен
- [ ] 17. Убедиться что миграция 123 идемпотентна (IF NOT EXISTS)
- [ ] 18. Убедиться что `sendProspectNow` не позволяет отправить повторно лиду в статусе sent/delivered/replied

---

## Промпт для GitHub Copilot Agent

```
Прочитай файл TZ_outreach_contacts_and_manual_send.md в корне репозитория.
Реализуй обе задачи строго по чеклисту из этого файла.
Следуй паттернам существующего кода:
- Backend: outreach.controller.js, outreach.routes.js, outreachScheduler.js
- Frontend: OutreachCampaignPage.vue (Vue 3 Composition API, <script setup>)
- Store: outreach.js (Pinia)
Создавай файлы по одному в порядке чеклиста.
```
