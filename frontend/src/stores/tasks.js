import { defineStore } from 'pinia';
import { ref }         from 'vue';
import api             from '../api.js';

export const useTasksStore = defineStore('tasks', () => {
  const tasks   = ref([]);
  const current = ref(null);
  const loading = ref(false);
  const error   = ref(null);

  // ── Список задач ───────────────────────────────────────────────────
  async function fetchTasks() {
    loading.value = true;
    error.value   = null;
    try {
      const { data } = await api.get('/tasks');
      tasks.value = data.tasks;
    } catch (e) {
      error.value = e.response?.data?.error || e.message;
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
    // Обновляем статус в списке
    _patchInList(id, { status: 'queued' });
    return data;
  }

  // ── Удаление задачи ────────────────────────────────────────────────
  async function deleteTask(id) {
    await api.delete(`/tasks/${id}`);
    tasks.value = tasks.value.filter(t => t.id !== id);
    if (current.value?.id === id) current.value = null;
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
      timeout: 90000,
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
    tasks, current, loading, error,
    fetchTasks, fetchTask, createTask, updateTask,
    startTask, deleteTask, fetchResult, fetchMetrics, uploadTZ, parseTZWithLLM,
  };
});
