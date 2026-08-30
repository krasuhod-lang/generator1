'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');
const {
  issueVerificationCode,
  verifyCode,
  RESEND_COOLDOWN_SECONDS,
} = require('../services/auth/emailVerification');
const { ensureAccessProfile, getUserEntitlements } = require('../services/access/entitlementPolicy');

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/** Создаёт JWT со сроком из JWT_EXPIRES_IN (по умолчанию 7d). */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/** Валидация e-mail простым regex. */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user, entitlements = null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    email_verified: Boolean(user.email_verified),
    ...(entitlements ? {
      role: entitlements.role,
      plan: entitlements.plan,
      plan_name: entitlements.planName,
      access_status: entitlements.status,
      access_period_start: entitlements.periodStart,
      access_period_end: entitlements.periodEnd,
      entitlements: {
        limits: entitlements.limits,
        used: entitlements.used,
        remaining: entitlements.remaining,
        unlimited: entitlements.unlimited,
      },
    } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Регистрация нового пользователя.
 * Body: { email, password, name? }
 */
async function register(req, res, next) {
  try {
    const { email, password, name } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Валидация входных данных
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов' });
    }

    // Проверяем, не занят ли email
    const existing = await db.query(
      `SELECT id, email, name, email_verified FROM users WHERE LOWER(email) = LOWER($1)`,
      [normalizedEmail],
    );
    if (existing.rows.length) {
      const existingUser = existing.rows[0];
      if (!existingUser.email_verified) {
        try {
          const issued = await issueVerificationCode({
            userId: existingUser.id,
            email: existingUser.email,
            name: existingUser.name,
          });
          return res.status(202).json({
            pending_verification: true,
            email: existingUser.email,
            retry_after: issued.retryAfter || RESEND_COOLDOWN_SECONDS,
          });
        } catch (mailError) {
          console.error('[auth] verification resend after duplicate registration failed:', mailError.message);
          return res.status(202).json({
            pending_verification: true,
            email: existingUser.email,
            retry_after: RESEND_COOLDOWN_SECONDS,
            warning: 'Аккаунт уже создан. Не удалось отправить код сейчас — повторите отправку позже.',
          });
        }
      }
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    // Хешируем пароль (bcrypt, cost=12)
    const passwordHash = await bcrypt.hash(password, 12);

    // Создаём пользователя.
    // password_plain хранит исходный пароль пользователя — нужен админ-панели
    // (см. admin.controller.js + миграция 086). Аутентификация по-прежнему
    // идёт через password_hash (bcrypt).
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, password_plain, name, email_verified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id, email, name, email_verified, created_at`,
      [normalizedEmail, passwordHash, password, name || null]
    );
    const user = rows[0];
    await ensureAccessProfile(user.id, db);
    const entitlements = await getUserEntitlements(user.id, db);

    try {
      const issued = await issueVerificationCode({
        userId: user.id,
        email: user.email,
        name: user.name,
      });
      return res.status(202).json({
        pending_verification: true,
        email: user.email,
        retry_after: issued.retryAfter || RESEND_COOLDOWN_SECONDS,
        user: publicUser({ ...user, email_verified: false }, entitlements),
      });
    } catch (mailError) {
      console.error('[auth] verification email delivery failed:', mailError.message);
      return res.status(202).json({
        pending_verification: true,
        email: user.email,
        retry_after: RESEND_COOLDOWN_SECONDS,
        user: publicUser({ ...user, email_verified: false }, entitlements),
        warning: 'Аккаунт создан, но код пока не отправлен. Нажмите «Отправить код ещё раз».',
      });
    }

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Логин пользователя.
 * Body: { email, password }
 * Returns: { token, user: { id, email, name } }
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    // Ищем пользователя
    const { rows } = await db.query(
      `SELECT id, email, name, password_hash, password_plain, email_verified FROM users WHERE LOWER(email) = LOWER($1)`,
      [normalizeEmail(email)]
    );
    if (!rows.length) {
      // Одинаковое сообщение для безопасности (не раскрываем, есть ли пользователь)
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const user = rows[0];

    // Проверяем пароль
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Бэкфилим password_plain для аккаунтов, зарегистрированных до миграции 086,
    // чтобы админ-панель могла показать действующий пароль. Делается один раз
    // при первом успешном логине — после этого колонка перестаёт перезаписываться,
    // чтобы случайно введённый «старый» пароль не затёр актуальный.
    if (user.password_plain == null) {
      try {
        await db.query(
          `UPDATE users SET password_plain = $1 WHERE id = $2 AND password_plain IS NULL`,
          [password, user.id]
        );
      } catch (_) {
        // Не блокируем логин из-за вспомогательного UPDATE
      }
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Подтвердите email кодом из письма перед входом',
        pending_verification: true,
        email: user.email,
      });
    }

    // Выпускаем JWT
    await ensureAccessProfile(user.id, db);
    const entitlements = await getUserEntitlements(user.id, db);
    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      token,
      user: publicUser(user, entitlements),
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-email
// ─────────────────────────────────────────────────────────────────────────────

async function verifyEmail(req, res, next) {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email) || !/^[0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: 'Введите корректный email и 6-значный код' });
    }

    const result = await verifyCode({ email, code });
    if (!result.verified) {
      const status = result.reason === 'too_many_attempts' ? 429 : result.reason === 'expired_or_missing' ? 410 : 400;
      const error = result.reason === 'too_many_attempts'
        ? 'Слишком много неверных попыток. Запросите новый код.'
        : result.reason === 'expired_or_missing'
          ? 'Код истёк или уже использован. Запросите новый код.'
          : 'Неверный код подтверждения';
      return res.status(status).json({ error, reason: result.reason, pending_verification: true, email });
    }

    const user = result.user;
    await ensureAccessProfile(user.id, db);
    const entitlements = await getUserEntitlements(user.id, db);
    const token = signToken({ id: user.id, email: user.email });
    return res.json({ token, user: publicUser(user, entitlements), verified: true });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/resend-verification
// ─────────────────────────────────────────────────────────────────────────────

async function resendVerification(req, res, next) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Некорректный email' });

    const { rows } = await db.query(
      `SELECT id, email, name, email_verified FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email],
    );
    const user = rows[0];
    // Не раскрываем существование email: для verified/unknown возвращаем тот же ответ.
    if (!user || user.email_verified) {
      return res.status(202).json({ message: 'Если аккаунт ожидает подтверждения, новый код будет отправлен.', retry_after: RESEND_COOLDOWN_SECONDS });
    }

    try {
      const issued = await issueVerificationCode({ userId: user.id, email: user.email, name: user.name });
      return res.status(202).json({
        pending_verification: true,
        email: user.email,
        retry_after: issued.retryAfter || RESEND_COOLDOWN_SECONDS,
        message: issued.cooldown ? 'Подождите перед повторной отправкой кода.' : 'Новый код отправлен на email.',
      });
    } catch (mailError) {
      console.error('[auth] verification resend failed:', mailError.message);
      return res.status(202).json({ pending_verification: true, email, retry_after: RESEND_COOLDOWN_SECONDS, warning: 'Не удалось отправить код сейчас. Повторите позже.' });
    }
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout  (stateless JWT — клиент просто удаляет токен)
// ─────────────────────────────────────────────────────────────────────────────

function logout(req, res) {
  // JWT stateless — реальная инвалидация требует blacklist в Redis (опционально).
  // Достаточно сообщить клиенту, что он должен удалить токен.
  return res.json({ message: 'Logged out. Delete token on client side.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me  (требует JWT)
// ─────────────────────────────────────────────────────────────────────────────

async function me(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, email, name, email_verified, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const entitlements = await getUserEntitlements(rows[0].id, db);
    return res.json({ user: publicUser(rows[0], entitlements) });

  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, verifyEmail, resendVerification, logout, me };
