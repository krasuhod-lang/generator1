'use strict';

const crypto = require('crypto');
const { Resend } = require('resend');
const db = require('../../config/db');

const CODE_LENGTH = 6;
const CODE_TTL_SECONDS = Math.max(300, Number.parseInt(process.env.EMAIL_VERIFICATION_TTL_SECONDS, 10) || 600);
const RESEND_COOLDOWN_SECONDS = Math.max(30, Number.parseInt(process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS, 10) || 60);
const MAX_ATTEMPTS = Math.max(3, Number.parseInt(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS, 10) || 5);

let resendClient = null;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makeCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
}

function hashCode(email, code) {
  const secret = process.env.JWT_SECRET || 'seo-genius-email-verification';
  return crypto.createHmac('sha256', secret).update(`${normalizeEmail(email)}:${code}`).digest('hex');
}

function safeEqualHex(left, right) {
  if (!left || !right || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getResend() {
  if (!resendClient) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY не задан в .env');
    resendClient = new Resend(key);
  }
  return resendClient;
}

function getFromAddress() {
  const fromEmail = process.env.AUTH_FROM_EMAIL || process.env.OUTREACH_FROM_EMAIL;
  if (!fromEmail) throw new Error('AUTH_FROM_EMAIL или OUTREACH_FROM_EMAIL не задан в .env');
  const fromName = process.env.AUTH_FROM_NAME || 'SEO Genius';
  return `${fromName} <${fromEmail}>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function buildEmail({ email, name, code }) {
  const greeting = name ? `Здравствуйте, ${escapeHtml(String(name).slice(0, 120))}!` : 'Здравствуйте!';
  const safeCode = String(code).replace(/[<>&"']/g, '');
  const subject = 'Код подтверждения регистрации в SEO Genius';
  const text = `${greeting}\n\nВаш код подтверждения: ${safeCode}\n\nКод действует ${Math.round(CODE_TTL_SECONDS / 60)} минут. Если вы не регистрировались в SEO Genius, просто проигнорируйте это письмо.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#172033;line-height:1.5"><p>${greeting}</p><p>Введите этот код на странице регистрации:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#4f46e5">${safeCode}</p><p>Код действует ${Math.round(CODE_TTL_SECONDS / 60)} минут. Если вы не регистрировались в SEO Genius, просто проигнорируйте это письмо.</p></body></html>`;
  return { subject, text, html };
}

async function sendVerificationEmail({ email, name, code }) {
  const { subject, text, html } = buildEmail({ email, name, code });
  const { data, error } = await getResend().emails.send({
    from: getFromAddress(),
    to: [normalizeEmail(email)],
    subject,
    text,
    html,
    headers: { 'X-Email-Type': 'account-verification' },
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return { resendId: data?.id || null };
}

async function issueVerificationCode({ userId, email, name }) {
  const normalized = normalizeEmail(email);
  const client = await db.getClient();
  let code = null;
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query(
      `SELECT id, email, name, email_verified FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const user = users[0];
    if (!user || user.email_verified) {
      await client.query('ROLLBACK');
      return { sent: false, alreadyVerified: Boolean(user?.email_verified) };
    }

    const { rows: existing } = await client.query(
      `SELECT last_sent_at FROM email_verification_codes WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const lastSentAt = existing[0]?.last_sent_at ? new Date(existing[0].last_sent_at).getTime() : 0;
    const elapsedSeconds = (Date.now() - lastSentAt) / 1000;
    if (lastSentAt && elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
      await client.query('ROLLBACK');
      return { sent: false, cooldown: true, retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds) };
    }

    code = makeCode();
    await client.query(
      `INSERT INTO email_verification_codes
         (user_id, code_hash, expires_at, attempts, last_sent_at, consumed_at, created_at, updated_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'), 0, NOW(), NULL, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         last_sent_at = NOW(),
         consumed_at = NULL,
         updated_at = NOW()`,
      [userId, hashCode(normalized, code), CODE_TTL_SECONDS],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }

  try {
    const delivery = await sendVerificationEmail({ email: normalized, name, code });
    return { sent: true, retryAfter: RESEND_COOLDOWN_SECONDS, resendId: delivery.resendId };
  } catch (error) {
    // Code remains stored and can be delivered through a later resend request.
    error.codeStored = true;
    throw error;
  }
}

async function verifyCode({ email, code }) {
  const normalized = normalizeEmail(email);
  const normalizedCode = String(code || '').trim();
  if (!/^[0-9]{6}$/.test(normalizedCode)) return { verified: false, reason: 'invalid_code' };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query(
      `SELECT id, email, name, email_verified FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE`,
      [normalized],
    );
    const user = users[0];
    if (!user) {
      await client.query('ROLLBACK');
      return { verified: false, reason: 'invalid_code' };
    }
    if (user.email_verified) {
      await client.query('COMMIT');
      return { verified: true, alreadyVerified: true, user };
    }

    const { rows: codes } = await client.query(
      `SELECT code_hash, expires_at, attempts, consumed_at
         FROM email_verification_codes
        WHERE user_id = $1
        FOR UPDATE`,
      [user.id],
    );
    const verification = codes[0];
    if (!verification || verification.consumed_at || new Date(verification.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { verified: false, reason: 'expired_or_missing' };
    }
    if (Number(verification.attempts) >= MAX_ATTEMPTS) {
      await client.query('ROLLBACK');
      return { verified: false, reason: 'too_many_attempts' };
    }

    const valid = safeEqualHex(verification.code_hash, hashCode(normalized, normalizedCode));
    if (!valid) {
      await client.query(
        `UPDATE email_verification_codes SET attempts = attempts + 1, updated_at = NOW() WHERE user_id = $1`,
        [user.id],
      );
      await client.query('COMMIT');
      return {
        verified: false,
        reason: Number(verification.attempts) + 1 >= MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid_code',
      };
    }

    await client.query(
      `UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1 AND email_verified = FALSE`,
      [user.id],
    );
    await client.query(
      `UPDATE email_verification_codes SET consumed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [user.id],
    );
    await client.query('COMMIT');
    return { verified: true, alreadyVerified: false, user: { ...user, email_verified: true } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeEmail,
  issueVerificationCode,
  verifyCode,
  sendVerificationEmail,
  CODE_TTL_SECONDS,
  RESEND_COOLDOWN_SECONDS,
  MAX_ATTEMPTS,
  buildEmail,
};
