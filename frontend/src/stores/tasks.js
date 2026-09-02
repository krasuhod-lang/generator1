import { defineStore } from 'pinia';
import { ref }         from 'vue';
import api             from '../api.js';

export const useTasksStore = defineStore('tasks', () => {
  const tasks   = ref([]); // legacy SEO list for generation/editing screens
  const allTasks = ref([]); // cross-module list for Dashboard only
  const allTasksTotal = ref(0);
  const allTasksHasMore = ref(false);
  const current = ref(null);
  const loading = ref(false);
  const error   = ref(null);

  // ── Список задач ───────────────────────────────────────────────────
  async function fetchTasks() {
    loading.value = true;
    error.value   = null;
    try {
      const { data } = await api.get('/tasks');
      tasks.value = Array.isArray(data?.tasks) ? data.tasks : [];
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
    } finally {
      loading.value = false;
    }
  }

  // ── Все задачи пользователя (единый Центр задач) ─────────────────
  async function fetchAllTasks({ limit = 200, page = 1, append = false } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await api.get('/tasks/all', { params: { limit, page } });
      const incoming = Array.isArray(data?.tasks) ? data.tasks : [];
      if (append) {
        const byKey = new Map(allTasks.value.map((task) => [`${task.source}:${task.id}`, task]));
        for (const task of incoming) byKey.set(`${task.source}:${task.id}`, task);
        allTasks.value = Array.from(byKey.values()).sort((a, b) =>
          new Date(b.activity_at || b.last_started_at || b.started_at || b.updated_at || b.created_at || 0).getTime()
          - new Date(a.activity_at || a.last_started_at || a.started_at || a.updated_at || a.created_at || 0).getTime(),
        );
      } else {
        allTasks.value = incoming;
      }
      allTasksTotal.value = Number(data?.total) || allTasks.value.length;
      allTasksHasMore.value = allTasks.value.length < allTasksTotal.value;
      return allTasks.value;
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
      return allTasks.value;
    } finally {
      loading.value = false;
    }
  }

  // ── Одна задача ────────────────────────────────────────────────────
  async function fetchTask(id) {
    loading.value = true;
    error.value   = null;
    try {
      const { data } = await api.get(`/tasks/${id}`);
      current.value = data.task;
      return data.task;
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
    } finally {
      loading.value = false;
    }
  }

  // ── Создание задачи ────────────────────────────────────────────────
  async function createTask(payload) {
    const { data } = await api.post('/tasks', payload);
    tasks.value.unshift(data.task);
    current.value = data.task;
    return data.task;
  }

  // ── Обновление задачи ──────────────────────────────────────────────
  async function updateTask(id, payload) {
    const { data } = await api.patch(`/tasks/${id}`, payload);
    _replaceInList(data.task);
    current.value = data.task;
    return data.task;
  }

  // ── Запуск задачи ──────────────────────────────────────────────────
  async function startTask(id) {
    const { data } = await api.post(`/tasks/${id}/start`);
    // The backend has persisted last_started_at before returning. Reflect the
    // same activity immediately so the task cannot appear under yesterday
    // while the next polling request is still pending.
    const activityAt = new Date().toISOString();
    _patchInList(id, {
      status: 'queued',
      last_started_at: activityAt,
      activity_at: activityAt,
      updated_at: activityAt,
    });
    return data;
  }

  // ── Пауза задачи (кнопка "Стоп") ──────────────────────────────────
  async function pauseTask(id) {
    const { data } = await api.post(`/tasks/${id}/pause`);
    _patchInList(id, { status: 'pausing' });
    return data;
  }

  // ── Возобновление задачи (кнопка "Продолжить") ────────────────────
  async function resumeTask(id) {
    const { data } = await api.post(`/tasks/${id}/resume`);
    const activityAt = new Date().toISOString();
    _patchInList(id, {
      status: 'queued',
      last_started_at: activityAt,
      activity_at: activityAt,
      updated_at: activityAt,
    });
    return data;
  }

  // ── Удаление задачи ────────────────────────────────────────────────
  async function deleteTask(id) {
    await api.delete(`/tasks/${id}`);
    // Backend performs a soft archive: keep the row in the list so completed
    // text, JSON history and its actual completion date remain discoverable.
    const archivedAt = new Date().toISOString();
    _patchInList(id, { archived_at: archivedAt });
    if (current.value?.id === id) current.value = { ...current.value, archived_at: archivedAt };
  }

  // ── Результат задачи ───────────────────────────────────────────────
  async function fetchResult(id) {
    const { data } = await api.get(`/tasks/${id}/result`);
    return data;  // { task, blocks, metrics }
  }

  // ── Метрики ────────────────────────────────────────────────────────
  async function fetchMetrics(id) {
    const { data } = await api.get(`/tasks/${id}/metrics`);
    return data.metrics;
  }

  // ── История лог-событий (персистентные SSE-логи) ──────────────────
  async function fetchTaskLogs(id, { after, limit = 1000 } = {}) {
    const params = new URLSearchParams();
    if (after) params.set('after', after);
    if (limit)  params.set('limit', String(limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const { data } = await api.get(`/tasks/${id}/logs${qs}`);
    return data.logs || [];
  }

  // ── Загрузка DOCX ──────────────────────────────────────────────────
  async function uploadTZ(id, file) {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/tasks/${id}/upload-tz`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  }

  // ── Pre-Stage (-1): LLM-извлечение полей из ТЗ ───────────────────
  async function parseTZWithLLM(file) {
    const fd = new FormData();
    fd.append('file', file);
    const { data } = await api.post('/tasks/parse-tz', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0, // без ограничения по времени — анализ ТЗ может идти долго
    });
    return data;
  }

  // ── Автозаполнение формы создания задачи из готового relevance-отчёта ───
  // Бэкенд (POST не нужен — чистый read+enrich) собирает детерминированные
  // поля + DeepSeek-аналитику ЦА/ниши/фактов. Никаких записей не делает.
  async function fetchRelevancePrefill(reportId) {
    const { data } = await api.get(`/tasks/relevance-prefill/${encodeURIComponent(reportId)}`, {
      // Prefill включает один bounded DeepSeek enrichment-вызов. Не оставляем
      // общий 60s/старый 120s client cap: при больших relevance-отчётах
      // deterministic-поля уже готовы, но LLM может занять несколько минут.
      timeout: 360000,
    });
    return data;
  }

  // ── Вспомогательные ───────────────────────────────────────────────
  function _replaceInList(task) {
    const idx = tasks.value.findIndex(t => t.id === task.id);
    if (idx !== -1) tasks.value[idx] = task;
  }
  function _patchInList(id, patch) {
    const idx = tasks.value.findIndex(t => t.id === id);
    if (idx !== -1) tasks.value[idx] = { ...tasks.value[idx], ...patch };
  }

  return {
    tasks, allTasks, allTasksTotal, allTasksHasMore, current, loading, error,
    fetchTasks, fetchAllTasks, fetchTask, createTask, updateTask,
    startTask, pauseTask, resumeTask, deleteTask,
    fetchResult, fetchMetrics, fetchTaskLogs, uploadTZ, parseTZWithLLM,
    fetchRelevancePrefill,
  };
});
