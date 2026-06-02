'use strict';

/**
 * projects/shareToken.js — короткие public share-токены для дашборда проекта.
 * Зеркало forecaster/shareToken.js: 12 байт crypto-random → base64url.
 */

const crypto = require('crypto');
const { getProjectsConfig } = require('./config');

function generateShareToken() {
  const bytes = getProjectsConfig().share.tokenBytes;
  return crypto.randomBytes(bytes).toString('base64url');
}

function isValidShareToken(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 8 || s.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

module.exports = { generateShareToken, isValidShareToken };
