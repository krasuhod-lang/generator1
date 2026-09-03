'use strict';

const { HttpsProxyAgent } = require('https-proxy-agent');

function normalizeProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.includes('@')) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  }
  const withProtocol = value.match(/^(https?:\/\/)([^:]+):([^:]+):([^:]+):(\d+)$/i);
  if (withProtocol) {
    const [, protocol, user, pass, host, port] = withProtocol;
    return `${protocol}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  const parts = value.split(':');
  if (parts.length !== 4) return value;
  const [first, second, third, fourth] = parts;
  const isPort = (part) => /^\d+$/.test(part);
  const isHost = (part) => /^(\d{1,3}\.){3}\d{1,3}$/.test(part) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(part);
  if (isHost(third) && isPort(fourth)) {
    return `http://${encodeURIComponent(first)}:${encodeURIComponent(second)}@${third}:${fourth}`;
  }
  if (isHost(first) && isPort(second)) {
    return `http://${encodeURIComponent(third)}:${encodeURIComponent(fourth)}@${first}:${second}`;
  }
  return value;
}

function resolveProxyUrl(env, prefix, suffix = '') {
  const full = env[`${prefix}_PROXY_URL${suffix}`] || '';
  if (full) return normalizeProxyUrl(full);

  const host = env[`${prefix}_PROXY_HOST${suffix}`] || '';
  const port = env[`${prefix}_PROXY_PORT${suffix}`] || '';
  if (host && port) {
    const user = env[`${prefix}_PROXY_USER${suffix}`] || '';
    const pass = env[`${prefix}_PROXY_PASS${suffix}`] || '';
    const protocol = env[`${prefix}_PROXY_PROTO${suffix}`] || 'http';
    if (user && pass) {
      return `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return `${protocol}://${host}:${port}`;
  }
  return '';
}

/**
 * Resolve proxy candidates without exposing the URL or credentials in logs.
 * Manus-specific configuration wins; Gemini proxy configuration is reused
 * because both providers need the same outbound HTTP CONNECT capability.
 */
function resolveManusProxyUrls(env = process.env) {
  const urls = [];
  for (const prefix of ['MANUS', 'GEMINI']) {
    for (const suffix of ['', '_2', '_3', '_4', '_5']) {
      const candidate = resolveProxyUrl(env, prefix, suffix);
      if (candidate) urls.push(candidate);
    }
    if (prefix === 'MANUS' && urls.length) break;
  }
  if (!urls.length) {
    const systemProxy = env.HTTPS_PROXY || env.https_proxy || '';
    if (systemProxy) urls.push(normalizeProxyUrl(systemProxy));
  }
  return [...new Set(urls.filter(Boolean))];
}

function proxyTransport(proxyUrl) {
  if (!proxyUrl) return {};
  const agent = new HttpsProxyAgent(proxyUrl);
  return { httpsAgent: agent, httpAgent: agent, proxy: false };
}

function manusTransportAttempts(env = process.env) {
  const urls = resolveManusProxyUrls(env);
  if (!urls.length) return [{ proxyUrl: '', config: {} }];
  return urls.map((proxyUrl) => ({ proxyUrl, config: proxyTransport(proxyUrl) }));
}

function proxyRequired(env = process.env) {
  const raw = String(env.MANUS_PROXY_REQUIRED || '').trim().toLowerCase();
  // Manus must not silently bypass the configured outbound route. Explicitly
  // setting MANUS_PROXY_REQUIRED=false is the only opt-out for local recovery.
  return raw !== 'false';
}

module.exports = {
  normalizeProxyUrl,
  resolveManusProxyUrls,
  manusTransportAttempts,
  proxyRequired,
};
