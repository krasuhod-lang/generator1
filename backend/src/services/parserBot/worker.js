'use strict';

const os = require('os');
const axios = require('axios');
const queue = require('./queue');

const AUDIT_URL = process.env.AUDIT_INTERNAL_URL || 'http://audit:8002';
const WORKER_ID = `${os.hostname()}-${process.pid}-parser-bot`;

const CLIENT_FALLBACKS = {
  fetch_error: {
    client_segments: 'Не определено — сайт недоступен или не удалось получить его содержимое',
    works_with: 'Не определено — анализ невозможен из-за ошибки доступа к сайту',
  },
  llm_error: {
    client_segments: 'Не удалось определить — ошибка анализа ИИ',
    works_with: 'Не удалось определить — ошибка анализа ИИ',
  },
};

let started = false;
let timer = null;
let active = 0;

function boolOption(options, names, fallback = false) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(options || {}, name)) return Boolean(options[name]);
  }
  return fallback;
}

function buildAuditPayload(item) {
  const options = item.task?.options || {};
  return {
    urls: [item.normalized_url || item.input_url],
    extract_contacts: boolOption(options, ['extract_contacts', 'contacts']),
    extract_about: boolOption(options, ['extract_about', 'about']),
    extract_services: boolOption(options, ['extract_services', 'services']),
    extract_clients: boolOption(options, ['extract_clients', 'clients']),
    api_key: process.env.DEEPSEEK_API_KEY || options.deepseek_api_key || '',
  };
}

function buildWorkerErrorResult(item, status, message) {
  const options = item.task?.options || {};
  const fallback = CLIENT_FALLBACKS[status] || CLIENT_FALLBACKS.llm_error;
  const fieldStatus = {};
  if (boolOption(options, ['extract_contacts', 'contacts'])) fieldStatus.contacts = status;
  if (boolOption(options, ['extract_about', 'about'])) fieldStatus.about = status;
  if (boolOption(options, ['extract_services', 'services'])) {
    fieldStatus.services = status;
    fieldStatus.focus = status;
  }
  if (boolOption(options, ['extract_clients', 'clients'])) {
    fieldStatus.client_segments = status;
    fieldStatus.works_with = status;
  }
  return {
    url: item.normalized_url || item.input_url,
    title: '',
    contacts: '',
    about: '',
    services: [],
    focus: '',
    client_segments: fieldStatus.client_segments ? [fallback.client_segments] : [],
    works_with: fieldStatus.works_with ? fallback.works_with : '',
    status,
    field_status: fieldStatus,
    evidence: [],
    warnings: [String(message || '').slice(0, 500)].filter(Boolean),
    stats: { pages_scanned: 0 },
    error: String(message || '').slice(0, 1000),
  };
}

async function callAudit(item) {
  const payload = buildAuditPayload(item);
  const response = await axios.post(`${AUDIT_URL}/audit/parsers/extract`, payload, {
    headers: { 'X-Internal-Token': process.env.RELEVANCE_INTERNAL_TOKEN || '' },
    timeout: Math.max(1000, Math.min(600000, Number(item.task?.options?.request_timeout_ms) || 300000)),
  });
  const result = response.data?.results?.[0];
  if (!result || typeof result !== 'object') {
    return buildWorkerErrorResult(item, 'llm_error', 'Пустой ответ audit-сервиса');
  }
  return result;
}

async function processNext() {
  const item = await queue.claimItem({
    workerId: WORKER_ID,
    staleMs: Math.max(30000, Number(process.env.PARSER_BOT_STALE_MS) || 120000),
  });
  if (!item) return false;

  const heartbeatMs = Math.max(5000, Number(process.env.PARSER_BOT_HEARTBEAT_MS) || 30000);
  const heartbeatTimer = setInterval(() => {
    queue.heartbeat(item.id, WORKER_ID).catch((err) => {
      console.warn('[parserBot] heartbeat failed:', err.message);
    });
  }, heartbeatMs);

  try {
    const result = await callAudit(item);
    await queue.completeItem(item.id, result);
  } catch (err) {
    const code = err.code || '';
    const isFetchLike = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT';
    const options = item.task?.options || {};
    const retryLimit = queue.retryLimit(options);
    if (item.attempts <= retryLimit) {
      await queue.failItem(item, err, { options });
    } else {
      await queue.completeItem(
        item.id,
        buildWorkerErrorResult(item, isFetchLike ? 'fetch_error' : 'llm_error', err.message || String(err)),
      );
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
  return true;
}

async function tick(concurrency) {
  while (active < concurrency) {
    active += 1;
    processNext()
      .catch((err) => console.warn('[parserBot] processNext failed:', err.message))
      .finally(() => { active -= 1; });
    if (active >= concurrency) break;
  }
}

function startParserBotWorker() {
  if (started || process.env.PARSER_BOT_WORKER_DISABLED === '1') return;
  started = true;
  const concurrency = Math.max(1, Math.min(16, Number(process.env.PARSER_BOT_CONCURRENCY) || 2));
  const intervalMs = Math.max(500, Number(process.env.PARSER_BOT_POLL_MS) || 2000);
  timer = setInterval(() => tick(concurrency), intervalMs);
  timer.unref?.();
  tick(concurrency).catch((err) => console.warn('[parserBot] initial tick failed:', err.message));
  console.log(`[parserBot] worker started concurrency=${concurrency}`);
}

function stopParserBotWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  WORKER_ID,
  boolOption,
  buildAuditPayload,
  buildWorkerErrorResult,
  processNext,
  startParserBotWorker,
  stopParserBotWorker,
};
