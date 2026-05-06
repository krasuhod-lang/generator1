'use strict';

/**
 * pythonClient — тонкий HTTP-клиент к Python-микросервису релевантности.
 *
 * Базовый URL и токен авторизации — из env:
 *   RELEVANCE_INTERNAL_URL    (default: http://relevance:8000)
 *   RELEVANCE_INTERNAL_TOKEN  (если пусто — auth-проверка на стороне
 *                              FastAPI отключена; в проде docker-compose
 *                              обязан прокинуть тот же токен с обеих сторон).
 *
 * Контракт ответа /analyze см. relevance/app/main.py.
 */

const axios = require('axios');

const BASE_URL = (process.env.RELEVANCE_INTERNAL_URL || 'http://relevance:8000')
  .trim().replace(/\/$/, '');

const TOKEN = (process.env.RELEVANCE_INTERNAL_TOKEN || '').trim();

const ANALYZE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.RELEVANCE_ANALYZE_TIMEOUT_MS, 10);
  // Анализ 20 крупных HTML занимает 10–60 секунд; 4 минуты — потолок.
  return Number.isFinite(v) && v >= 10000 && v <= 600000 ? v : 240000;
})();

const HEALTH_TIMEOUT_MS = 8000;

function _authHeaders() {
  return TOKEN ? { 'X-Internal-Token': TOKEN } : {};
}

/**
 * @param {{ query:string, documents: Array<{url:string, html:string}>, options?:object }} payload
 * @returns {Promise<object>} — { stats, vocabulary, ngrams }
 */
async function analyze(payload) {
  if (!payload || !Array.isArray(payload.documents)) {
    throw new Error('analyze(): payload.documents must be an array');
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/analyze`,
      payload,
      {
        timeout: ANALYZE_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', ..._authHeaders() },
        // Документы могут весить десятки мегабайт — поднимаем лимиты.
        maxBodyLength:    256 * 1024 * 1024,
        maxContentLength: 256 * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );
    return res.data;
  } catch (err) {
    const code = err?.response?.status || err?.code || 'ERR';
    const detail =
      err?.response?.data?.detail
      || err?.response?.data?.error
      || err?.message
      || 'unknown';
    const safeDetail = String(detail).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`relevance-service ${code}: ${safeDetail}`);
  }
}

async function health() {
  try {
    const res = await axios.get(`${BASE_URL}/health`, {
      timeout: HEALTH_TIMEOUT_MS,
      headers: _authHeaders(),
      validateStatus: () => true,
    });
    return {
      ok:        res.status === 200 && !!res.data?.ok,
      status:    res.status,
      version:   res.data?.version || null,
      base_url:  BASE_URL,
      auth_required: !!res.data?.auth_required,
    };
  } catch (err) {
    return {
      ok: false,
      status: err?.code || 'ERR',
      error: String(err?.message || 'unreachable').slice(0, 200),
      base_url: BASE_URL,
    };
  }
}

module.exports = {
  analyze,
  health,
  RELEVANCE_BASE_URL: BASE_URL,
  ANALYZE_TIMEOUT_MS,
};
