#!/usr/bin/env node
/**
 * SEO Genius — Утилита проверки прокси
 *
 * Запуск из контейнера:
 *   docker exec seo_worker  node scripts/check-proxy.js
 *   docker exec seo_backend node scripts/check-proxy.js
 *
 * Что делает:
 *   1. Показывает все переменные GEMINI_PROXY_* (с маскировкой паролей)
 *   2. Собирает proxy URL (аналогично gemini.adapter.js)
 *   3. Тестирует HTTP-подключение через прокси к httpbin.org
 *   4. Тестирует HTTPS-подключение к Gemini API (список моделей)
 */
'use strict';

const axios             = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ═══════════════════════════════════════════════════════════════════════════
// 1. Диагностика переменных окружения
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' SEO Genius — Proxy Check Utility');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('1. Переменные окружения:\n');

const suffixes = ['', '_2', '_3', '_4', '_5'];
const envKeys = ['GEMINI_PROXY_URL', 'GEMINI_PROXY_HOST', 'GEMINI_PROXY_PORT',
                 'GEMINI_PROXY_USER', 'GEMINI_PROXY_PASS', 'GEMINI_PROXY_PROTO'];

let anyProxyFound = false;

for (const sfx of suffixes) {
  const vals = {};
  let hasAny = false;
  for (const key of envKeys) {
    const fullKey = `${key}${sfx}`;
    const val = process.env[fullKey] || '';
    if (val) {
      hasAny = true;
      anyProxyFound = true;
      // Маскируем пароль
      if (key.includes('PASS') || key === 'GEMINI_PROXY_URL') {
        vals[fullKey] = val.replace(/:([^:@]{1,})@/, ':***@');
        // Дополнительная маскировка для полного URL — показываем только начало и конец
        if (vals[fullKey].length > 10) {
          const masked = vals[fullKey];
          vals[fullKey] = masked.substring(0, 8) + '***' + masked.substring(masked.length - 6);
        }
      } else {
        vals[fullKey] = val;
      }
    }
  }
  if (hasAny) {
    for (const [k, v] of Object.entries(vals)) {
      console.log(`   ${k} = ${v}`);
    }
    console.log('');
  }
}

if (!anyProxyFound) {
  console.log('   ❌ Ни одна переменная GEMINI_PROXY_* не задана!\n');
  console.log('   Решение: добавьте в .env файл (в корне проекта):\n');
  console.log('     # Вариант 1 — полная строка:');
  console.log('     GEMINI_PROXY_URL="http://login:password@ip:port"\n');
  console.log('     # Вариант 2 — компоненты (безопаснее):');
  console.log('     GEMINI_PROXY_HOST=155.212.59.188');
  console.log('     GEMINI_PROXY_PORT=64464');
  console.log('     GEMINI_PROXY_USER=your_login');
  console.log('     GEMINI_PROXY_PASS=your_password\n');
  console.log('   Затем пересоздайте контейнеры:');
  console.log('     docker compose down && docker compose up -d --build\n');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Сборка proxy URL (аналог gemini.adapter.js)
// ═══════════════════════════════════════════════════════════════════════════

function normalizeProxyUrl(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const withProto = raw.match(/^(https?:\/\/)([^:]+):([^:]+):([^:]+):(\d+)$/);
  if (withProto) {
    const [, proto, user, pass, host, port] = withProto;
    return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  const noParts = raw.match(/^([^:]+):([^:]+):([^:]+):([^:]+)$/);
  if (noParts) {
    const [, p1, p2, p3, p4] = noParts;
    const isIP = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every(o => +o >= 0 && +o <= 255);
    const isHostname = (s) => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s) && s.includes('.') && /[a-zA-Z]/.test(s);
    const isHost = (s) => isIP(s) || isHostname(s);
    const isPort = (s) => /^\d+$/.test(s);
    let user, pass, host, port;
    if (isHost(p3) && isPort(p4)) {
      [user, pass, host, port] = [p1, p2, p3, p4];
    } else if (isHost(p1) && isPort(p2)) {
      [host, port, user, pass] = [p1, p2, p3, p4];
    } else {
      return raw;
    }
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return raw;
}

function resolveProxyUrl(suffix = '') {
  const full = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
  if (full) return normalizeProxyUrl(full);
  const host = process.env[`GEMINI_PROXY_HOST${suffix}`] || '';
  const port = process.env[`GEMINI_PROXY_PORT${suffix}`] || '';
  if (host && port) {
    const user  = process.env[`GEMINI_PROXY_USER${suffix}`] || '';
    const pass  = process.env[`GEMINI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`GEMINI_PROXY_PROTO${suffix}`] || 'http';
    if (user && pass) {
      return `${proto}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return `${proto}://${host}:${port}`;
  }
  if (!suffix) return process.env.HTTPS_PROXY || process.env.https_proxy || '';
  return '';
}

const proxyUrls = [];
for (const sfx of suffixes) {
  const url = resolveProxyUrl(sfx);
  if (url) proxyUrls.push({ suffix: sfx || 'primary', url });
}

console.log('2. Собранные proxy URL:\n');

function safeLog(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':***@');
  }
}

if (proxyUrls.length === 0) {
  console.log('   ❌ Не удалось собрать ни одного proxy URL');
  console.log('   Проверьте формат переменных в .env\n');
  process.exit(1);
}

for (const { suffix, url } of proxyUrls) {
  console.log(`   [${suffix}] ${safeLog(url)}`);
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// 3. Тест подключения
// ═══════════════════════════════════════════════════════════════════════════

async function testProxy(label, proxyUrl, targetUrl, displayUrl) {
  // displayUrl — URL для логирования (без API ключей)
  const logUrl = displayUrl || targetUrl;
  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    const resp = await axios.get(targetUrl, {
      httpsAgent: agent,
      proxy:      false,
      timeout:    20000,
      validateStatus: null,
    });

    if (resp.status === 200) {
      console.log(`   ✅ [${label}] → ${logUrl} — HTTP 200 OK`);
      if (resp.data && typeof resp.data === 'object') {
        const preview = JSON.stringify(resp.data).substring(0, 100);
        console.log(`      Ответ: ${preview}...`);
      }
      return true;
    } else if (resp.status === 407) {
      console.log(`   ❌ [${label}] → ${logUrl} — HTTP 407: прокси требует авторизацию!`);
      console.log('      Проверьте логин/пароль прокси в .env');
      return false;
    } else {
      console.log(`   ⚠  [${label}] → ${logUrl} — HTTP ${resp.status}`);
      return false;
    }
  } catch (err) {
    if (err.message && (err.message.includes('407') || err.message.includes('Proxy Authentication'))) {
      console.log(`   ❌ [${label}] → ${logUrl} — 407 Proxy Auth Required!`);
      console.log('      Прокси требует авторизацию. Проверьте логин/пароль.');
    } else {
      console.log(`   ❌ [${label}] → ${logUrl} — ${err.message}`);
    }
    return false;
  }
}

(async () => {
  console.log('3. Тест подключения через прокси:\n');

  for (const { suffix, url } of proxyUrls) {
    // Тест 1: httpbin (проверка базовой связности через HTTP)
    await testProxy(suffix, url, 'https://httpbin.org/ip');

    // Тест 2: Gemini API (список моделей — если есть API key)
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
      await testProxy(suffix, url, geminiUrl, 'https://generativelanguage.googleapis.com/v1beta/models?key=***');
    } else {
      console.log(`   ⚠  [${suffix}] → Gemini API — пропускаем (GEMINI_API_KEY не задан)`);
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
})();
