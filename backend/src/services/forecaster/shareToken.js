'use strict';

/**
 * forecaster/shareToken.js — генератор коротких public share-токенов.
 *
 * 12 байт crypto-random → base64url ≈ 16 символов. URL-safe, без =, без +/.
 * Достаточная энтропия (96 бит) — невозможно угадать перебором.
 */

const crypto = require('crypto');
const { getForecasterConfig } = require('./config');

function generateShareToken() {
  const bytes = getForecasterConfig().share.tokenBytes;
  return crypto.randomBytes(bytes).toString('base64url');
}

// Простейшая валидация по длине / алфавиту — защита от заведомо мусорных
// строк до похода в БД.
function isValidShareToken(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 8 || s.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

module.exports = { generateShareToken, isValidShareToken };
