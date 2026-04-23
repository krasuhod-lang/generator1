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
  console.log('   ⚠  Переменные GEMINI_PROXY_* не заданы в окружении.');
  console.log('   ℹ  Будет использован встроенный прокси (fallback).\n');
  console.log('   Чтобы задать свой прокси, добавьте в .env файл:\n');
  console.log('     # Вариант 1 — полная строка:');
  console.log('     GEMINI_PROXY_URL="http://login:password@ip:port"\n');
  console.log('     # Вариант 2 — компоненты (безопаснее):');
  console.log('     GEMINI_PROXY_HOST=ip');
  console.log('     GEMINI_PROXY_PORT=port');
  console.log('     GEMINI_PROXY_USER=your_login');
  console.log('     GEMINI_PROXY_PASS=your_password\n');
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

// ── Встроенные константы (используются если env-переменные не заданы) ──
const DEFAULT_PROXY = {
  host:  '155.212.59.188',
  port:  '64464',
  user:  '76MkBTXZ',
  pass:  '3ukb66G1',
  proto: 'http',
};
// Gemini API key загружается ИСКЛЮЧИТЕЛЬНО из process.env.GEMINI_API_KEY
// (хардкод запрещён — Google Secret Scanning отзывает публично доступные ключи).

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
  if (!suffix) {
    const sys = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (sys) return sys;
    // Встроенный fallback
    console.log('   ℹ  Env-переменные прокси не заданы — используем встроенный прокси');
    return `${DEFAULT_PROXY.proto}://${encodeURIComponent(DEFAULT_PROXY.user)}:${encodeURIComponent(DEFAULT_PROXY.pass)}@${DEFAULT_PROXY.host}:${DEFAULT_PROXY.port}`;
  }
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
    // Очищаем сообщение ошибки от возможных URL/ключей
    const safeErrMsg = (err.message || 'unknown error').replace(/key=[^&\s]+/gi, 'key=***');
    if (safeErrMsg.includes('407') || safeErrMsg.includes('Proxy Authentication')) {
      console.log(`   ❌ [${label}] → ${logUrl} — 407 Proxy Auth Required!`);
      console.log('      Прокси требует авторизацию. Проверьте логин/пароль.');
    } else {
      console.log(`   ❌ [${label}] → ${logUrl} — ${safeErrMsg}`);
    }
    return false;
  }
}

(async () => {
  console.log('3. Тест подключения через прокси:\n');

  for (const { suffix, url } of proxyUrls) {
    // Тест 1: httpbin (проверка базовой связности через HTTP)
    await testProxy(suffix, url, 'https://httpbin.org/ip');

    // Тест 2: Gemini API (список моделей) — только если задан ключ в env
    const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!geminiApiKey) {
      console.log(`   ⚠  [${suffix}] → Gemini API тест пропущен: GEMINI_API_KEY не задан в .env`);
    } else {
      const geminiBase = 'https://generativelanguage.googleapis.com/v1beta/models';
      // API key добавляется в URL только для HTTP-запроса, не для логирования
      await testProxy(suffix, url, geminiBase + '?key=' + geminiApiKey, geminiBase + '?key=***');
    }

    // Тест 3: Grok / x.ai (список моделей) через ТОТ ЖЕ прокси.
    // По умолчанию у нас один прокси на оба провайдера, поэтому проверяем оба.
    const xaiApiKey = (process.env.XAI_API_KEY || '').trim();
    if (!xaiApiKey) {
      console.log(`   ⚠  [${suffix}] → Grok (x.ai) API тест пропущен: XAI_API_KEY не задан в .env`);
    } else {
      const xaiBase = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, '') + '/models';
      try {
        const agent = new HttpsProxyAgent(url);
        const resp = await axios.get(xaiBase, {
          httpsAgent: agent,
          proxy:      false,
          timeout:    20000,
          validateStatus: null,
          headers:    { Authorization: `Bearer ${xaiApiKey}` },
        });
        if (resp.status === 200) {
          const models = (resp.data?.data || []).map(m => m.id).slice(0, 8);
          console.log(`   ✅ [${suffix}] → ${xaiBase} — HTTP 200 OK`);
          if (models.length) {
            console.log(`      Доступные модели x.ai (первые ${models.length}): ${models.join(', ')}`);
            const wanted = process.env.XAI_MODEL || 'grok-4.20-0309-reasoning';
            const all = (resp.data?.data || []).map(m => m.id);
            if (all.includes(wanted)) {
              console.log(`      ✅ XAI_MODEL=${wanted} доступна вашему ключу`);
            } else {
              console.log(`      ⚠  XAI_MODEL=${wanted} НЕ найдена в списке доступных моделей вашего ключа!`);
              console.log(`         Запросы к этой модели вернут HTTP 404. Поправьте XAI_MODEL в .env.`);
            }
          }
        } else if (resp.status === 401) {
          console.log(`   ❌ [${suffix}] → ${xaiBase} — HTTP 401: неверный XAI_API_KEY`);
        } else if (resp.status === 403) {
          console.log(`   ❌ [${suffix}] → ${xaiBase} — HTTP 403: ключ валиден, но нет прав`);
        } else {
          const detail = resp.data?.error?.message || JSON.stringify(resp.data || '').slice(0, 200);
          console.log(`   ⚠  [${suffix}] → ${xaiBase} — HTTP ${resp.status}: ${detail}`);
        }
      } catch (err) {
        const safeMsg = (err.message || 'unknown').replace(/Bearer\s+\S+/gi, 'Bearer ***');
        console.log(`   ❌ [${suffix}] → ${xaiBase} — ${safeMsg}`);
      }
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
})();
