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
  blocked: {
    client_segments: 'Не определено — автоматический доступ к сайту заблокирован',
    works_with: 'Не определено — сайт запретил автоматический анализ',
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
    task_id: item.task_id || item.task?.id || '',
    item_id: item.id || '',
    use_result_cache: Boolean(options.use_result_cache),
    extract_contacts: boolOption(options, ['extract_contacts', 'contacts']),
    extract_about: boolOption(options, ['extract_about', 'about']),
    extract_services: boolOption(options, ['extract_services', 'services']),
    extract_clients: boolOption(options, ['extract_clients', 'clients']),
    api_key: process.env.DEEPSEEK_API_KEY || options.deepseek_api_key || '',
  };
}

function buildWorkerErrorResult(item, status, message, errorCode = '', previousResult = {}) {
  const options = item.task?.options || {};
  const fallback = CLIENT_FALLBACKS[status] || CLIENT_FALLBACKS.llm_error;
  const previous = previousResult && typeof previousResult === 'object' ? previousResult : {};
  const previousStats = previous.stats && typeof previous.stats === 'object' ? previous.stats : {};
  const hasSiteData = Boolean(
    previous.title || previous.about || previous.contacts || previous.services?.length
      || previous.focus || Number(previousStats.pages_scanned || 0) > 0,
  );
  const effectiveStatus = status === 'llm_error' && hasSiteData ? 'partial' : status;
  const fieldStatus = { ...(previous.field_status || {}) };
  if (boolOption(options, ['extract_contacts', 'contacts']) && !fieldStatus.contacts) fieldStatus.contacts = status;
  if (boolOption(options, ['extract_about', 'about']) && !fieldStatus.about) fieldStatus.about = status;
  if (boolOption(options, ['extract_services', 'services'])) {
    fieldStatus.services = fieldStatus.services || status;
    fieldStatus.focus = fieldStatus.focus || status;
  }
  if (boolOption(options, ['extract_clients', 'clients'])) {
    fieldStatus.client_segments = fieldStatus.client_segments || status;
    fieldStatus.works_with = fieldStatus.works_with || status;
  }
  const warnings = Array.isArray(previous.warnings) ? [...previous.warnings] : [];
  const warning = String(message || '').slice(0, 500);
  if (warning && !warnings.includes(warning)) warnings.push(warning);
  return {
    ...previous,
    url: previous.url || item.normalized_url || item.input_url,
    title: previous.title || '',
    execution: {
      ...(previous.execution || {}),
      run_id: item.task_id || item.task?.id || previous.execution?.run_id || '',
      item_id: item.id || previous.execution?.item_id || '',
      result_source: previous.execution?.result_source || 'fresh',
    },
    contacts: previous.contacts || (boolOption(options, ['extract_contacts', 'contacts']) ? fallback.contacts : ''),
    about: previous.about || (boolOption(options, ['extract_about', 'about']) ? fallback.about : ''),
    services: Array.isArray(previous.services) && previous.services.length ? previous.services : (boolOption(options, ['extract_services', 'services']) ? fallback.services : []),
    focus: previous.focus || (boolOption(options, ['extract_services', 'services']) ? fallback.focus : ''),
    client_segments: Array.isArray(previous.client_segments) && previous.client_segments.length
      ? previous.client_segments : (fieldStatus.client_segments ? [fallback.client_segments] : []),
    works_with: previous.works_with || (fieldStatus.works_with ? fallback.works_with : ''),
    status: effectiveStatus,
    crawl_status: previous.crawl_status || (hasSiteData ? 'partial' : status),
    ai_status: previous.ai_status || (status === 'llm_error' ? 'failed' : 'not_started'),
    data_status: previous.data_status || (hasSiteData ? 'partial' : 'empty'),
    field_status: fieldStatus,
    evidence: Array.isArray(previous.evidence) ? previous.evidence : [],
    warnings,
    subpage_errors: Array.isArray(previous.subpage_errors) ? previous.subpage_errors : [],
    stats: { ...previousStats, llm_terminal_error: true },
    error_code: errorCode || previous.error_code || '',
    error: String(message || previous.error || '').slice(0, 1000),
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

  // Старый audit endpoint мог вернуть {status: "Ошибка: ..."}. Такой объект
  // нельзя передавать дальше: itemStatusFromResult иначе посчитает его done.
  const status = String(result.status || '').toLowerCase();
  if (status.startsWith('ошибка') || status === 'error' || result.error_code === 'audit_parser_exception') {
          return {
        ...buildWorkerErrorResult(item, 'llm_error', result.error || result.status || 'Ошибка audit/DSPy', result.error_code || 'audit_parser_error', result),
        audit_error_code: result.error_code || 'audit_parser_error',
      };

  }

  const hasStructuredPayload = [
    result.contacts,
    result.about,
    result.services,
    result.focus,
    result.client_segments,
    result.works_with,
  ].some((value) => Array.isArray(value) ? value.length > 0 : String(value || '').trim());
  if (!hasStructuredPayload && result.status === undefined) {
    return buildWorkerErrorResult(item, 'llm_error', 'Audit-сервис не вернул структурированные поля', 'empty_structured_result');
  }
  const resultErrorCode = String(result.error_code || '').toLowerCase();
  const aiFailureNeedsRetry = result.ai_status === 'failed'
    && ['dspy_extraction_failed', 'dspy_parse_failed', 'empty_structured_result'].includes(resultErrorCode);
  if ((String(result.status || '').toLowerCase() === 'llm_error' || aiFailureNeedsRetry)
      && ['dspy_extraction_failed', 'dspy_parse_failed', 'empty_structured_result'].includes(resultErrorCode)) {
    const retryable = new Error(result.error || 'Временная ошибка структурированного ответа DSPy');
    retryable.code = 'AUDIT_LLM_RETRYABLE';
    retryable.errorCode = resultErrorCode;
    retryable.auditResult = result;
    throw retryable;
  }
  result.execution = {
    ...(result.execution || {}),
    run_id: item.task_id || item.task?.id || result.execution?.run_id || '',
    item_id: item.id || result.execution?.item_id || '',
    result_source: result.execution?.result_source || 'fresh',
  };
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
    const isBlockedLike = code === 'ERR_BAD_REQUEST' && /403|429|captcha|blocked|forbidden/i.test(err.message || '');
    const isFetchLike = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT';
    const options = item.task?.options || {};
    const retryLimit = queue.retryLimit(options);
    if (item.attempts <= retryLimit) {
      await queue.failItem(item, err, { options });
    } else {
      await queue.completeItem(
        item.id,
        buildWorkerErrorResult(
          item,
          isBlockedLike ? 'blocked' : (isFetchLike ? 'fetch_error' : 'llm_error'),
          err.message || String(err),
          err.errorCode || (isBlockedLike ? 'blocked_response' : (isFetchLike ? 'fetch_error' : 'worker_error')),
          err.auditResult || {},
        ),
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
