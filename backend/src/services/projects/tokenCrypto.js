'use strict';

/**
 * projects/tokenCrypto.js — симметричное шифрование OAuth-токенов Google.
 *
 * Требование безопасности из ТЗ: «токены Google OAuth хранить строго в
 * зашифрованном виде». Используем AES-256-GCM (аутентифицированное
 * шифрование). Ключ деривируется через SHA-256 из секрета окружения:
 *   PROJECTS_TOKEN_KEY  (если задан) → иначе JWT_SECRET.
 * Никаких новых обязательных .env-переменных: JWT_SECRET уже есть.
 *
 * Формат хранения (одна строка): base64(iv).base64(tag).base64(ciphertext)
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // рекомендованный размер nonce для GCM

function _key() {
  const secret = process.env.PROJECTS_TOKEN_KEY || process.env.JWT_SECRET || '';
  if (!secret) {
    throw new Error('Token encryption secret missing (set PROJECTS_TOKEN_KEY or JWT_SECRET)');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest(); // 32 байта
}

/** Шифрует строку. Возвращает компактную строку iv.tag.ciphertext (base64). */
function encryptToken(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/** Расшифровывает строку, созданную encryptToken. Бросает при подделке. */
function decryptToken(payload) {
  if (payload == null || payload === '') return null;
  const parts = String(payload).split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted token');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const data = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, _key(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
