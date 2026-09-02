import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function expectIncludes(text, fragment, label) {
  assert.ok(text.includes(fragment), `${label}: missing ${fragment}`);
}

const style = read('src/style.css');
const index = read('index.html');
const login = read('src/views/LoginPage.vue');
const register = read('src/views/RegisterPage.vue');
const adminLogin = read('src/views/admin/AdminLoginPage.vue');
const appLayout = read('src/components/AppLayout.vue');
const adminLayout = read('src/components/AdminLayout.vue');
const premiumLayout = read('src/components/PremiumLayout.vue');
const dashboard = read('src/views/DashboardPage.vue');
const adminKeys = read('src/views/admin/AdminApiKeysPage.vue');
const vite = read('vite.config.js');

for (const token of ['--ui-bg:', '--ui-surface:', '--ui-border:', '--ui-brand:', '--ui-brand-light:', '--ui-radius:']) {
  expectIncludes(style, token, 'SeoMST design tokens');
}
for (const selector of ['.auth-shell', '.auth-card', '.admin-page', '.admin-action-row', '@media (max-width: 640px)']) {
  expectIncludes(style, selector, 'responsive UI system');
}
for (const [source, label] of [[login, 'login'], [register, 'register'], [adminLogin, 'admin login']]) {
  expectIncludes(source, 'auth-shell', label);
  expectIncludes(source, 'auth-card', label);
}
expectIncludes(login, 'id="login-email"', 'login email association');
expectIncludes(login, 'for="login-email"', 'login email label');
expectIncludes(register, 'id="register-email"', 'register email association');
expectIncludes(register, 'id="verification-code"', 'verification input');
expectIncludes(adminLogin, 'id="admin-login-email"', 'admin email association');
expectIncludes(appLayout, 'SeoMST', 'client shell brand');
expectIncludes(adminLayout, 'SeoMST', 'admin shell brand');
expectIncludes(premiumLayout, 'SeoMST', 'premium shell brand');
expectIncludes(dashboard, 'var(--ui-surface)', 'task-center surface token');
expectIncludes(adminKeys, 'admin-action-row', 'admin key mobile actions');
expectIncludes(index, 'SeoMST —', 'document brand metadata');
assert.doesNotMatch(vite, /allowedHosts|host:\s*['"]0\.0\.0\.0['"]/, 'audit-only Vite exposure must not ship');

const brandResidue = [index, login, register, adminLogin, appLayout, adminLayout, premiumLayout, dashboard, adminKeys]
  .some((source) => /SEO Genius|SEO GENIUS|SEO <b>GENIUS/.test(source));
assert.equal(brandResidue, false, 'legacy visible SEO Genius brand must not remain in audited surfaces');

console.log('SEOMST_UI_CONTRACT_OK checks=24');
