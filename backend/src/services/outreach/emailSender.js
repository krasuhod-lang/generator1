'use strict';
/**
 * emailSender — отправка писем через Resend API.
 * Включает: защиту от повторной отправки, фильтр корпоративных email,
 * логирование в БД.
 */
const { Resend } = require('resend');
const db = require('../../config/db');
const { FREE_EMAIL_PROVIDERS } = require('./prospectScorer');

// По умолчанию в рассылке может участвовать ЛЮБАЯ почта, включая бесплатные
// провайдеры (gmail.com / yandex.ru / mail.ru / …). Чтобы вернуть прежнее
// поведение и отсекать бесплатные ящики, выставите
// OUTREACH_BLOCK_FREE_PROVIDERS=true.
const BLOCK_FREE_PROVIDERS =
  String(process.env.OUTREACH_BLOCK_FREE_PROVIDERS || '').trim().toLowerCase() === 'true';

function isFreeProviderBlocked(domain) {
  return BLOCK_FREE_PROVIDERS && FREE_EMAIL_PROVIDERS.has(domain);
}

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
  // 0. Идемпотентность: если письмо уже отправлено (рестарт воркера / повтор
  // job'а BullMQ с тем же jobId), не отправляем повторно — иначе получатель
  // получит дубль. Источник истины — статус строки в outreach_emails.
  if (emailId) {
    const { rows } = await db.query(
      `SELECT status, resend_id FROM outreach_emails WHERE id = $1 LIMIT 1`,
      [emailId],
    );
    const row = rows[0];
    if (row && (row.resend_id ||
        ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'].includes(row.status))) {
      return { resendId: row.resend_id || null, skipped: true };
    }
  }

  // 1. Проверяем корпоративный email (по умолчанию отключено — участвует любая
  // почта; включается через OUTREACH_BLOCK_FREE_PROVIDERS=true)
  const domain = to.split('@')[1]?.toLowerCase();
  if (isFreeProviderBlocked(domain)) {
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

/**
 * Предпроверка получателя ДО постановки письма в очередь (Блок 4.2 ТЗ):
 * реальная отписка / cooldown 30 дней на домен. По умолчанию в рассылке
 * участвует любая почта; фильтр бесплатных провайдеров включается через
 * OUTREACH_BLOCK_FREE_PROVIDERS=true.
 * Позволяет не создавать письмо и не засорять очередь заведомо
 * непроходными job'ами (иначе они падают в failed и уходят в ретраи BullMQ).
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function precheckRecipient(email) {
  const addr = String(email || '').trim().toLowerCase();
  const domain = addr.split('@')[1];
  if (!domain) return { ok: false, reason: 'invalid_email' };
  if (isFreeProviderBlocked(domain)) return { ok: false, reason: 'free_provider' };
  if (await isUnsubscribed(addr)) return { ok: false, reason: 'unsubscribed' };
  if (!(await checkCooldown(domain))) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

module.exports = { sendEmail, checkCooldown, isUnsubscribed, precheckRecipient };
