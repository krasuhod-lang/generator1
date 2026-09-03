'use strict';

const axios = require('axios');
const { getIntegrationSecret } = require('../integrations/integrationVault');

const MANUS_BASE_URL = String(process.env.MANUS_API_BASE_URL || 'https://api.manus.ai').replace(/\/+$/, '');
const DEFAULT_AGENT_PROFILE = ['standard', 'lite', 'max'].includes(String(process.env.MANUS_AGENT_PROFILE || '').trim().toLowerCase())
  ? String(process.env.MANUS_AGENT_PROFILE).trim().toLowerCase()
  : 'max';
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MANUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 10_000 && raw <= 1_200_000 ? raw : 600_000;
})();
const DEFAULT_POLL_MS = (() => {
  const raw = Number(process.env.MANUS_POLL_MS);
  return Number.isFinite(raw) && raw >= 500 && raw <= 30_000 ? raw : 2_000;
})();
// task.create accepts approximately 5,000 estimated input tokens. Keep a
// conservative character cap so large existing GPT prompts fail over to the
// current DeepSeek route instead of creating an invalid Manus task.
const MAX_INPUT_CHARS = 20_000;

function apiHeaders(apiKey) {
  return {
    'x-manus-api-key': apiKey,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'SeoMST-manus-adapter/1.0',
  };
}

function safeProviderMessage(error) {
  const status = Number(error?.response?.status) || 0;
  if (status === 401 || status === 403) return `Manus API error ${status}: authentication or permission failed`;
  if (status === 400) return 'Manus API error 400: request rejected';
  if (status === 429) return 'Manus API error 429: rate limit exceeded';
  if (status >= 500) return `Manus API error ${status}: provider server error`;
  if (error?.code === 'ECONNABORTED') return 'Manus API error: request timeout';
  return `Manus API error: ${String(error?.message || 'network error').slice(0, 240)}`;
}

function providerError(error, fallbackMessage = null) {
  const wrapped = new Error(fallbackMessage || safeProviderMessage(error));
  wrapped.status = Number(error?.response?.status) || null;
  wrapped.code = error?.code || null;
  wrapped.requestId = error?.response?.data?.request_id || error?.response?.headers?.['x-request-id'] || null;
  wrapped.isDeterministic = wrapped.status === 400 || wrapped.status === 401 || wrapped.status === 403;
  return wrapped;
}

function payloadObjects(payload) {
  const candidates = [
    payload,
    payload?.data,
    payload?.result,
    payload?.task,
    payload?.data?.task,
  ];
  return candidates.filter((item) => item && typeof item === 'object');
}

function eventList(payload) {
  const arrays = [
    payload?.data,
    payload?.events,
    payload?.messages,
    payload?.data?.events,
    payload?.data?.messages,
    payload?.result?.events,
    payload?.result?.messages,
  ];
  return arrays.find(Array.isArray) || [];
}

function extractTaskId(payload) {
  for (const item of payloadObjects(payload)) {
    const id = item.task_id || item.taskId || item.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
}

function extractRequestId(payload) {
  for (const item of payloadObjects(payload)) {
    const id = item.request_id || item.requestId;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
}

function statusFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const status = event.agent_status || event.status || event.stop_reason
    || event?.status_update?.agent_status || event?.status_update?.status
    || event?.task_detail?.status || event?.task_detail?.stop_reason;
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function extractStatus(payload) {
  const events = eventList(payload);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const status = statusFromEvent(events[index]);
    if (status) return status;
  }
  for (const item of payloadObjects(payload)) {
    const status = statusFromEvent(item);
    if (status) return status;
  }
  return '';
}

function textFromValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => textFromValue(part?.text ?? part?.content ?? part)).filter(Boolean).join('');
  }
  if (value && typeof value === 'object') return textFromValue(value.text ?? value.content ?? value.message ?? '');
  return '';
}

function extractAssistantText(payload) {
  const events = eventList(payload);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    const type = String(event.type || event.event_type || '').toLowerCase();
    if (type === 'assistant_message' || type === 'assistant' || event.role === 'assistant') {
      const text = textFromValue(event.content ?? event.message ?? event.assistant_message ?? event.text);
      if (text.trim()) return text.trim();
    }
  }
  const candidates = [];
  for (const item of payloadObjects(payload)) {
    candidates.push(item.assistant_message, item.message, item.content, item.text);
  }
  return candidates.map(textFromValue).find((text) => text.trim())?.trim() || '';
}

function extractStructuredOutput(payload) {
  const events = eventList(payload);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    if (event.type === 'structured_output_result' && event.structured_output_result?.success) {
      return event.structured_output_result.value;
    }
  }
  return null;
}

function buildTaskContent(systemInstruction, userPrompt, responseFormat) {
  const parts = [];
  if (String(systemInstruction || '').trim()) parts.push(`SYSTEM INSTRUCTIONS:\n${String(systemInstruction).trim()}`);
  if (String(userPrompt || '').trim()) parts.push(`USER TASK:\n${String(userPrompt).trim()}`);
  if (responseFormat?.type === 'json_object') {
    parts.push('OUTPUT CONTRACT:\nReturn only one valid JSON object. Do not use Markdown fences or commentary. Preserve all recoverable values and do not invent data.');
  }
  return parts.join('\n\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveManusApiKey() {
  const key = await getIntegrationSecret('MANUS_API_KEY');
  if (!key) {
    const error = new Error('MANUS_API_KEY is not configured in admin vault or environment');
    error.isDeterministic = true;
    throw error;
  }
  return key;
}

async function createTask(apiKey, content, options) {
  const body = {
    message: { content },
    agent_profile: options.agentProfile || DEFAULT_AGENT_PROFILE,
    interactive_mode: false,
    hide_in_task_list: true,
    share_visibility: 'private',
  };
  if (options.projectId) body.project_id = String(options.projectId);
  if (options.structuredOutputSchema && typeof options.structuredOutputSchema === 'object') {
    body.structured_output_schema = options.structuredOutputSchema;
  }
  try {
    const response = await axios.post(`${MANUS_BASE_URL}/v2/task.create`, body, {
      headers: apiHeaders(apiKey),
      timeout: options.timeoutMs,
    });
    const payload = response.data || {};
    const taskId = extractTaskId(payload);
    if (!taskId) {
      throw providerError({ response: { status: response.status, data: payload, headers: response.headers } }, 'Manus API returned no task id');
    }
    return { taskId, requestId: extractRequestId(payload) };
  } catch (error) {
    if (error?.isDeterministic) throw error;
    throw providerError(error);
  }
}

async function listMessages(apiKey, taskId, timeoutMs) {
  try {
    const response = await axios.get(`${MANUS_BASE_URL}/v2/task.listMessages`, {
      headers: apiHeaders(apiKey),
      params: { task_id: taskId, order: 'asc', limit: 100 },
      timeout: Math.min(timeoutMs, 60_000),
    });
    return response.data || {};
  } catch (error) {
    throw providerError(error);
  }
}

async function callManus(systemInstruction, userPrompt, options = {}) {
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  const content = buildTaskContent(systemInstruction, userPrompt, options.responseFormat);
  if (!content.trim()) throw new Error('Manus prompt must not be empty');
  if (content.length > MAX_INPUT_CHARS) {
    const error = new Error('Manus input text too long');
    error.isDeterministic = true;
    throw error;
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) >= 10_000
    ? Math.min(Number(options.timeoutMs), 1_200_000)
    : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const apiKey = await resolveManusApiKey();
  const created = await createTask(apiKey, content, {
    timeoutMs: Math.min(timeoutMs, 60_000),
    agentProfile: options.agentProfile,
    projectId: options.projectId,
    structuredOutputSchema: options.structuredOutputSchema,
  });
  let lastPayload = {};
  let status = '';
  while (Date.now() - startedAt < timeoutMs) {
    lastPayload = await listMessages(apiKey, created.taskId, timeoutMs);
    status = extractStatus(lastPayload);
    if (status === 'error') {
      const error = new Error('Manus agent task failed');
      error.isDeterministic = true;
      error.status = 502;
      error.requestId = created.requestId || extractRequestId(lastPayload);
      throw error;
    }
    if (status === 'waiting') {
      const error = new Error('Manus agent requested interactive input; quality pipeline cannot continue an unattended task');
      error.isDeterministic = true;
      error.status = 409;
      error.requestId = created.requestId || extractRequestId(lastPayload);
      throw error;
    }
    if (status === 'stopped' || status === 'completed' || status === 'finish') break;
    await sleep(DEFAULT_POLL_MS);
  }
  if (!(status === 'stopped' || status === 'completed' || status === 'finish')) {
    const error = new Error('Manus API error: task timeout');
    error.code = 'ETIMEDOUT';
    error.status = 504;
    error.isDeterministic = false;
    error.requestId = created.requestId || extractRequestId(lastPayload);
    throw error;
  }

  const structured = extractStructuredOutput(lastPayload);
  const text = structured !== null ? JSON.stringify(structured) : extractAssistantText(lastPayload);
  if (!text.trim()) {
    const error = new Error('Manus returned an empty response');
    error.isDeterministic = true;
    error.status = 502;
    error.requestId = created.requestId || extractRequestId(lastPayload);
    throw error;
  }
  return {
    text,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    thoughtsTokens: 0,
    model: `manus-${options.agentProfile || DEFAULT_AGENT_PROFILE}`,
    finishReason: 'stop',
    manusTaskId: created.taskId,
    requestId: created.requestId || extractRequestId(lastPayload),
    usageSource: 'unavailable',
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  callManus,
  resolveManusApiKey,
  MANUS_BASE_URL,
  DEFAULT_AGENT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  _internals: {
    apiHeaders,
    safeProviderMessage,
    extractTaskId,
    extractRequestId,
    extractStatus,
    extractAssistantText,
    extractStructuredOutput,
    buildTaskContent,
  },
};
