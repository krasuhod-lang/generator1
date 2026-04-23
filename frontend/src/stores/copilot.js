/**
 * AI-Copilot store — состояние редактора готовой статьи.
 * Все обращения к бэку идут через api.js (axios) кроме SSE-стрима, для которого
 * используется нативный EventSource (с токеном в URL — наш authSSE его принимает).
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '../api.js';

export const useCopilotStore = defineStore('copilot', () => {
  // ── Контекст текущего экрана ────────────────────────────────────────────
  const taskId            = ref(null);

  // ── Состояние выбора в WYSIWYG ─────────────────────────────────────────
  const selectedText      = ref('');     // plain-text из выделения
  const selectedHtml      = ref('');     // HTML из выделения
  // Action по умолчанию — 'custom' (свободный запрос). Это самый «безопасный» пресет:
  // ему достаточно одного user_prompt, не требуется selected_text. Прежний дефолт
  // 'factcheck' приводил к мгновенной ошибке валидации, если пользователь жал
  // «Сгенерировать» без выделения текста и без промпта.
  const action            = ref('custom');
  const userPrompt        = ref('');
  const extraParams       = ref({});     // напр. { keyword: 'Анапа' }
  // LLM-провайдер для AI-Copilot редактора. По умолчанию 'gemini' (back-compat).
  // Передаётся в createOperation → используется в editor_copilot_sessions.llm_provider
  // (если ещё нет) и наследуется всеми операциями этой сессии.
  const llmProvider       = ref('gemini');

  // ── Текущая операция ───────────────────────────────────────────────────
  const currentOperationId = ref(null);
  const currentStatus      = ref('idle'); // idle / pending / streaming / done / error / cancelled
  const streamingText      = ref('');
  const previewVisible     = ref(false);

  // ── Логи ───────────────────────────────────────────────────────────────
  const logs              = ref([]);     // [{ ts, level, message }]
  const logsDialogOpen    = ref(false);
  // Последнее сообщение об ошибке (для отображения в UI вне модалки логов).
  const lastError         = ref('');

  // ── Учёт токенов ───────────────────────────────────────────────────────
  const usage             = ref({ tokens_in: 0, tokens_out: 0, cost_usd: 0 });
  const sessionTotals     = ref({ tokens_in: 0, tokens_out: 0, cost_usd: 0 });

  // ── История + пресеты ──────────────────────────────────────────────────
  const history           = ref([]);
  const presets           = ref([]);
  const model             = ref('');

  // ── Внутреннее состояние ───────────────────────────────────────────────
  let _eventSource = null;

  // ── Геттеры ────────────────────────────────────────────────────────────
  const isBusy = computed(() => currentStatus.value === 'streaming' || currentStatus.value === 'pending');
  const lastOperation = computed(() => history.value[0] || null);

  // ── Действия ───────────────────────────────────────────────────────────

  function reset() {
    closeStream();
    currentOperationId.value = null;
    currentStatus.value      = 'idle';
    streamingText.value      = '';
    logs.value               = [];
    lastError.value          = '';
    usage.value              = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    previewVisible.value     = false;
  }

  async function loadPresets() {
    if (presets.value.length) return;
    const { data } = await api.get('/editor-copilot/presets');
    presets.value = data.presets || [];
    model.value   = data.model || '';
  }

  async function loadSession(id) {
    taskId.value = id;
    const { data } = await api.get(`/editor-copilot/${id}/session`);
    sessionTotals.value = {
      tokens_in:  Number(data.session?.total_tokens_in)  || 0,
      tokens_out: Number(data.session?.total_tokens_out) || 0,
      cost_usd:   Number(data.session?.total_cost_usd)   || 0,
    };
    history.value = data.operations || [];
    if (data.model) model.value = data.model;

    // Восстановление: если есть незавершённая операция — переподключаемся.
    const live = (data.operations || []).find(
      op => op.status === 'pending' || op.status === 'streaming'
    );
    if (live) {
      attachToOperation(live.id);
      return;
    }
    // Если последняя операция done && !applied — открываем preview, чтобы пользователь решил.
    const done = (data.operations || []).find(op => op.status === 'done' && !op.applied);
    if (done) {
      currentOperationId.value = done.id;
      currentStatus.value      = 'done';
      streamingText.value      = done.result_text || '';
      usage.value              = {
        tokens_in:  Number(done.tokens_in)  || 0,
        tokens_out: Number(done.tokens_out) || 0,
        cost_usd:   Number(done.cost_usd)   || 0,
      };
      previewVisible.value     = true;
    }
  }

  async function startOperation() {
    if (!taskId.value) throw new Error('taskId not set');
    closeStream();
    streamingText.value      = '';
    logs.value               = [];
    lastError.value          = '';
    usage.value              = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    currentStatus.value      = 'pending';
    previewVisible.value     = false;

    const body = {
      action:        action.value,
      selected_text: selectedHtml.value || selectedText.value || null,
      user_prompt:   userPrompt.value || null,
      extra_params:  Object.keys(extraParams.value).length ? extraParams.value : null,
      llm_provider:  llmProvider.value === 'grok' ? 'grok' : 'gemini',
    };

    const { data } = await api.post(`/editor-copilot/${taskId.value}/operations`, body);
    currentOperationId.value = data.operationId;
    attachToOperation(data.operationId);
  }

  function attachToOperation(opId) {
    closeStream();
    currentOperationId.value = opId;
    currentStatus.value      = 'streaming';

    const token = localStorage.getItem('seo_token') || '';
    const url   = `/api/editor-copilot/${taskId.value}/operations/${opId}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    _eventSource = es;

    es.addEventListener('init',     (e) => { _safeJson(e.data, (d) => { if (d.status) currentStatus.value = d.status; }); });
    es.addEventListener('snapshot', (e) => { _safeJson(e.data, (d) => { if (typeof d.text === 'string') streamingText.value = d.text; }); });
    es.addEventListener('token',    (e) => { _safeJson(e.data, (d) => { if (typeof d.delta === 'string') streamingText.value += d.delta; }); });
    es.addEventListener('log',      (e) => { _safeJson(e.data, (d) => { logs.value.push(d); }); });
    es.addEventListener('usage',    (e) => { _safeJson(e.data, (d) => {
      usage.value = {
        tokens_in:  Number(d.tokens_in)  || 0,
        tokens_out: Number(d.tokens_out) || 0,
        cost_usd:   Number(d.cost_usd)   || 0,
      };
    }); });
    es.addEventListener('done', (e) => {
      _safeJson(e.data, (d) => {
        currentStatus.value = d.status || 'done';
        if (typeof d.result === 'string') streamingText.value = d.result;
        if (currentStatus.value === 'done') previewVisible.value = true;
      });
      closeStream();
      // Обновляем агрегаты сессии и историю.
      refreshSession();
    });
    es.addEventListener('error', (e) => {
      _safeJson(e.data, (d) => {
        currentStatus.value = 'error';
        const msg = d.message || 'stream error';
        lastError.value = msg;
        logs.value.push({ ts: new Date().toISOString(), level: 'error', message: msg });
      });
      // EventSource часто эмитит 'error' и при сетевом сбросе без data — не закрываем сразу,
      // браузер сам попытается переподключиться. Закроем по таймауту, если не оживёт.
    });
  }

  function closeStream() {
    if (_eventSource) {
      try { _eventSource.close(); } catch (_) {}
      _eventSource = null;
    }
  }

  async function cancelOperation() {
    if (!currentOperationId.value) return;
    try {
      await api.post(`/editor-copilot/${taskId.value}/operations/${currentOperationId.value}/cancel`);
    } catch (_) {}
    currentStatus.value = 'cancelled';
    closeStream();
  }

  /**
   * applyOperation — фиксирует применение результата к статье.
   * Передаём в бэк собранный фронтом новый full_html (после правки TipTap).
   */
  async function applyOperation(mode, newFullHtml) {
    if (!currentOperationId.value) return;
    await api.post(
      `/editor-copilot/${taskId.value}/operations/${currentOperationId.value}/apply`,
      { mode, new_full_html: newFullHtml }
    );
    previewVisible.value = false;
    await refreshSession();
  }

  async function saveEditedHtml(html) {
    if (!taskId.value) return;
    await api.post(`/editor-copilot/${taskId.value}/html-edited`, { html });
  }

  async function refreshSession() {
    if (!taskId.value) return;
    try {
      const { data } = await api.get(`/editor-copilot/${taskId.value}/session`);
      sessionTotals.value = {
        tokens_in:  Number(data.session?.total_tokens_in)  || 0,
        tokens_out: Number(data.session?.total_tokens_out) || 0,
        cost_usd:   Number(data.session?.total_cost_usd)   || 0,
      };
      history.value = data.operations || [];
    } catch (_) {}
  }

  function _safeJson(raw, fn) {
    try { fn(JSON.parse(raw)); } catch (_) { /* ignore malformed event */ }
  }

  return {
    // state
    taskId, selectedText, selectedHtml, action, userPrompt, extraParams, llmProvider,
    currentOperationId, currentStatus, streamingText, previewVisible,
    logs, logsDialogOpen, lastError, usage, sessionTotals, history, presets, model,
    // getters
    isBusy, lastOperation,
    // actions
    reset, loadPresets, loadSession, startOperation, attachToOperation,
    cancelOperation, applyOperation, saveEditedHtml, refreshSession, closeStream,
  };
});
