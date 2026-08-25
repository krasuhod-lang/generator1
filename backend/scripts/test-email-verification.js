#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildEmail, CODE_TTL_SECONDS, MAX_ATTEMPTS, RESEND_COOLDOWN_SECONDS } = require('../src/services/auth/emailVerification');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function testEmailBuilder() {
  const email = buildEmail({ email: 'user@example.com', name: '<Admin>', code: '123456' });
  assert.equal(email.subject, 'Код подтверждения регистрации в SEO Genius');
  assert.match(email.text, /123456/);
  assert.match(email.html, /&lt;Admin&gt;/);
  assert.doesNotMatch(email.html, /<Admin>/);
  assert.doesNotMatch(email.html, /<img/i);
  assert.ok(CODE_TTL_SECONDS >= 300);
  assert.ok(MAX_ATTEMPTS >= 3);
  assert.ok(RESEND_COOLDOWN_SECONDS >= 30);
}

function testContracts() {
  const auth = read('backend/src/controllers/auth.controller.js');
  const routes = read('backend/src/routes/auth.routes.js');
  const service = read('backend/src/services/auth/emailVerification.js');
  const server = read('backend/server.js');
  const migration = read('migrations/137_email_verification.sql');
  const store = read('frontend/src/stores/auth.js');
  const register = read('frontend/src/views/RegisterPage.vue');
  const login = read('frontend/src/views/LoginPage.vue');

  assert.match(auth, /email_verified\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4, FALSE\)/);
  assert.match(auth, /pending_verification: true/);
  assert.match(auth, /Подтвердите email кодом из письма/);
  assert.match(auth, /signToken\(\{ id: user\.id, email: user\.email \}\)/);
  assert.match(routes, /router\.post\('\/verify-email'/);
  assert.match(routes, /router\.post\('\/resend-verification'/);
  assert.match(service, /code_hash/);
  assert.match(service, /timingSafeEqual/);
  assert.match(service, /attempts = attempts \+ 1/);
  assert.match(server, /ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS email_verification_codes/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.match(store, /pendingVerification/);
  assert.match(store, /verifyEmail/);
  assert.match(store, /resendVerification/);
  assert.match(register, /Подтвердите email/);
  assert.match(register, /Отправить код ещё раз/);
  assert.match(login, /pending_verification/);
}

testEmailBuilder();
testContracts();
console.log('email-verification: 22/22 passed');
