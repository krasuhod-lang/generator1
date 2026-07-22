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
 *
 * Важно: таблица outreach_unsubscribes хранит И токены отписки
 * (создаются при постановке в очередь, unsubscribed_at IS NULL)
 * И реальные отписки (unsubscribed_at IS NOT NULL, по клику в письме).
 * Блокируем отправку ТОЛЬКО при реальной отписке (фикс бага
 * «система сама себя отписывала», см. миграцию 122).
 */
async function isUnsubscribed(email) {
  const { rows } = await db.query(
    `SELECT email FROM outreach_unsubscribes
      WHERE email = $1 AND unsubscribed_at IS NOT NULL LIMIT 1`,
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
