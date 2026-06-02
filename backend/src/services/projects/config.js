'use strict';

/**
 * projects/config.js — неизменяемая конфигурация модуля «Проекты» + GSC.
 *
 * Паттерн репозитория: вся не-секретная конфигурация живёт в коде через
 * deepFreeze (см. forecaster/config.js, qualityLayers/featureFlags.js).
 * Файл .env.example НЕ трогаем. Секреты (Google OAuth client id/secret,
 * DEEPSEEK_API_KEY, ключ шифрования) читаются из process.env по месту.
 */

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

const PROJECTS_CONFIG = deepFreeze({
  limits: {
    nameMax: 200,
    audienceMax: 4000,
  },

  // Google Search Console / OAuth 2.0.
  gsc: {
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    apiBase: 'https://www.googleapis.com/webmasters/v3',
    // Параметры OAuth-запроса.
    accessType: 'offline',   // нужен refresh_token
    prompt: 'consent',       // гарантируем выдачу refresh_token
    httpTimeoutMs: 20000,
    // Кэш ответов Search Analytics (соблюдаем лимиты GSC API — не бьёмся
    // в API при каждом обновлении страницы).
    cacheTtlMs: 10 * 60 * 1000, // 10 минут
    cacheMaxEntries: 500,
    rowLimit: 25000,            // верхний предел строк на запрос к GSC
  },

  // DeepSeek — «Senior SEO-аналитик». Долгий ответ (30–60 c) — задача
  // выполняется в фоне, фронт поллит статус.
  deepseek: {
    enabled: true,
    temperature: 0.4,
    maxTokens: 4000,        // развёрнутый markdown-отчёт
    timeoutMs: 180000,      // до 3 минут на генерацию
    topQueries: 50,         // топ-50 запросов в срез
    topPages: 20,           // топ-20 страниц в срез
  },

  // Готовые пресеты периода для DatePicker.
  datePresets: [
    { key: '7d',  label: 'За 7 дней',   days: 7 },
    { key: '28d', label: 'За 28 дней',  days: 28 },
    { key: '3m',  label: 'За 3 месяца', days: 90 },
    { key: '6m',  label: 'За 6 месяцев', days: 180 },
  ],

  share: {
    tokenBytes: 12, // 96 бит энтропии → base64url ≈ 16 символов
  },
});

function getProjectsConfig() {
  return PROJECTS_CONFIG;
}

/**
 * Сконфигурирован ли Google OAuth (есть ли client id/secret/redirect).
 * Если нет — GSC-эндпоинты деградируют с понятной ошибкой, остальной
 * функционал проектов (CRUD, шаринг) работает.
 */
function getGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
  return {
    clientId,
    clientSecret,
    redirectUri,
    configured: Boolean(clientId && clientSecret && redirectUri),
  };
}

module.exports = { getProjectsConfig, getGoogleOAuthConfig, deepFreeze };
