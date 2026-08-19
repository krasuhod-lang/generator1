<script setup>
/**
 * Парсеры контента.
 *
 * Fixes:
 *   • URL-и запросов больше не дублируют префикс `/api/`: axios-инстанс уже
 *     сконфигурирован с baseURL '/api' (см. src/api.js), поэтому пути
 *     передаются относительными (`/parsers/start` вместо `/api/parsers/start`).
 *     До этого получалось `/api/api/parsers/…` → 404 «Ошибка запуска».
 *   • Страница обёрнута в <AppLayout>, чтобы верхняя шапка/меню оставались
 *     видимыми (раньше в /parsers шапка «исчезала», так как контент
 *     рендерился без общего лейаута).
 *   • Визуал приведён к общей тёмной дизайн-системе (`.card`, `.btn-*`,
 *     `.input`, `.textarea`, `.label`, `.badge`), плюс UX-улучшения:
 *       – сегментированный переключатель источника;
 *       – inline-ошибки вместо блокирующих alert();
 *       – счётчик URL, статус-бейдж, аккуратные loading/disabled-состояния;
 *       – валидация формы «на лету» с disable кнопки запуска.
 */
import { ref, computed, onUnmounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import api from '../api';

const enabled = ref(true);
const source = ref('custom');
const customUrls = ref('');
const searchQuery = ref('');
const options = ref({
  contacts: true,
  about: true,
  services: true,
  clients: true,
});

const loading = ref(false);
const downloadBusy = ref(false);
const taskId = ref(null);
const scanMode = ref('legacy');     // legacy | bot
const status = ref('');            // '' | queued | running | done | partial | error | cancelled
const progress = ref(0);
const total = ref(0);
const results = ref([]);
const errorMessage = ref('');      // inline-ошибка формы/запуска
const backendError = ref('');      // ошибка, пришедшая из /status
let pollInterval = null;

// ── Вычисляемые значения ──────────────────────────────────────────────────
const parsedUrls = computed(() =>
  customUrls.value
    .split('\n')
    .map((u) => u.trim())
    .filter((u) => u)
);

const parsedKeywords = computed(() =>
  searchQuery.value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k)
);

const anyObjectSelected = computed(
  () => options.value.contacts || options.value.about || options.value.services || options.value.clients
);

const canStart = computed(() => {
  if (!enabled.value || loading.value) return false;
  if (!anyObjectSelected.value) return false;
  if (source.value === 'custom') return parsedUrls.value.length > 0;
  return parsedKeywords.value.length > 0;
});

const progressPercent = computed(() => {
  if (!total.value) return 0;
  return Math.min(100, Math.round((progress.value / total.value) * 100));
});

const statusMessage = computed(() => {
  if (status.value === 'done') return 'Готово — отчёт можно скачать.';
  if (status.value === 'partial') return 'Готово частично — часть сайтов завершилась с ошибками.';
  if (status.value === 'cancelled') return 'Задача отменена.';
  if (status.value === 'error') return backendError.value || 'Произошла ошибка при парсинге.';
  if (total.value > 0) return `Обработано ${progress.value} из ${total.value} сайтов…`;
  return 'Запуск задачи…';
});

const statusBadge = computed(() => {
  if (status.value === 'done')
    return { text: '✓ Готово', cls: 'bg-emerald-900/40 text-emerald-300 border border-emerald-800' };
  if (status.value === 'partial')
    return { text: '◐ Частично', cls: 'bg-amber-900/40 text-amber-300 border border-amber-800' };
  if (status.value === 'cancelled')
    return { text: '⏹ Отменено', cls: 'bg-gray-800 text-gray-300 border border-gray-700' };
  if (status.value === 'error')
    return { text: '⚠ Ошибка', cls: 'bg-red-900/40 text-red-300 border border-red-800' };
  return { text: '⏳ В работе', cls: 'bg-indigo-900/40 text-indigo-300 border border-indigo-800' };
});

const fieldStatusMeta = (value) => {
  const map = {
    found: { text: 'Найдено', cls: 'bg-emerald-900/40 text-emerald-300 border border-emerald-800' },
    not_found: { text: 'Не найдено на сайте', cls: 'bg-amber-900/30 text-amber-300 border border-amber-900' },
    partial: { text: 'Частично', cls: 'bg-amber-900/40 text-amber-300 border border-amber-800' },
    llm_error: { text: 'Ошибка ИИ — повторите', cls: 'bg-red-900/40 text-red-300 border border-red-800' },
    fetch_error: { text: 'Ошибка доступа к сайту', cls: 'bg-red-900/40 text-red-300 border border-red-800' },
    blocked: { text: 'Доступ заблокирован', cls: 'bg-orange-900/40 text-orange-300 border border-orange-800' },
  };
  return map[value] || { text: value || '—', cls: 'bg-gray-800 text-gray-400 border border-gray-700' };
};

const siteStatusMeta = (value) => {
  const map = {
    ok: { text: 'Готово', cls: 'bg-emerald-900/40 text-emerald-300 border border-emerald-800' },
    done: { text: 'Готово', cls: 'bg-emerald-900/40 text-emerald-300 border border-emerald-800' },
    not_found: { text: 'Нет данных на сайте', cls: 'bg-amber-900/30 text-amber-300 border border-amber-900' },
    partial: { text: 'Частично', cls: 'bg-amber-900/40 text-amber-300 border border-amber-800' },
    llm_error: { text: 'Ошибка анализа ИИ', cls: 'bg-red-900/40 text-red-300 border border-red-800' },
    fetch_error: { text: 'Сайт недоступен', cls: 'bg-red-900/40 text-red-300 border border-red-800' },
    blocked: { text: 'Автоматический доступ заблокирован', cls: 'bg-orange-900/40 text-orange-300 border border-orange-800' },
    error: { text: 'Ошибка', cls: 'bg-red-900/40 text-red-300 border border-red-800' },
  };
  return map[value] || { text: value || 'queued', cls: 'bg-gray-800 text-gray-400 border border-gray-700' };
};

const itemResult = (item) => item?.result || {};
const itemStatus = (item) => itemResult(item).status || item?.status || '';
const itemClientSegments = (item) => {
  const value = itemResult(item).client_segments;
  return Array.isArray(value) ? value.join('\n') : (value || '');
};
const itemEvidence = (item) => itemResult(item).evidence || item?.evidence || [];
const itemError = (item) => itemResult(item).error || item?.error_message || item?.error || '';
const itemExecution = (item) => itemResult(item).execution || {};
const itemFieldStatus = (item) => itemResult(item).field_status || item?.field_status || {};
const terminalStatuses = new Set(['done', 'partial', 'error', 'cancelled']);

// ── Действия ──────────────────────────────────────────────────────────────
const startParsing = async () => {
  errorMessage.value = '';
  backendError.value = '';

  if (!anyObjectSelected.value) {
    errorMessage.value = 'Выберите хотя бы один объект парсинга (контакты, о компании или услуги).';
    return;
  }
  if (source.value === 'custom' && parsedUrls.value.length === 0) {
    errorMessage.value = 'Укажите список сайтов — по одному URL на строку.';
    return;
  }
  if (source.value === 'search' && parsedKeywords.value.length === 0) {
    errorMessage.value = 'Введите хотя бы один поисковый запрос.';
    return;
  }

  try {
    loading.value = true;
    taskId.value = null;
    status.value = 'running';
    progress.value = 0;
    total.value = 0;

    const urls = source.value === 'custom' ? parsedUrls.value : [];
    results.value = [];

    if (source.value === 'custom') {
      try {
        const { data } = await api.post('/parser-bot/scans', {
          urls,
          options: {
            extract_contacts: options.value.contacts,
            extract_about: options.value.about,
            extract_services: options.value.services,
            extract_clients: options.value.clients,
            max_pages_per_site: 100,
            max_depth: 5,
            retry_limit: 2,
          },
        });
        scanMode.value = 'bot';
        taskId.value = data.id;
        total.value = data.total || urls.length;
      } catch (botErr) {
        const code = botErr?.response?.status;
        if (code !== 401 && code !== 404) throw botErr;
        const { data } = await api.post('/parsers/start', {
          urls,
          options: { ...options.value, search_query: null },
        });
        scanMode.value = 'legacy';
        taskId.value = data.task_id;
      }
    } else {
      const { data } = await api.post('/parsers/start', {
        urls,
        options: {
          ...options.value,
          search_query: searchQuery.value,
        },
      });
      scanMode.value = 'legacy';
      taskId.value = data.task_id;
    }
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(checkStatus, 3000);
    await checkStatus();
  } catch (err) {
    status.value = 'error';
    const apiMsg = err?.response?.data?.error;
    errorMessage.value = 'Не удалось запустить парсер: ' + (apiMsg || err.message);
    loading.value = false;
  }
};

const checkStatus = async () => {
  if (!taskId.value) return;
  try {
    if (scanMode.value === 'bot') {
      const { data } = await api.get(`/parser-bot/scans/${taskId.value}`);
      status.value = data.status;
      progress.value = data.processed || 0;
      total.value = data.total || 0;
      if (data.error) backendError.value = data.error;
      const itemResp = await api.get(`/parser-bot/scans/${taskId.value}/items`, {
        params: { limit: 200 },
      });
      results.value = itemResp.data?.items || [];
      if (terminalStatuses.has(data.status)) {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        loading.value = false;
      }
      return;
    }

    const { data } = await api.get(`/parsers/status/${taskId.value}`);
    status.value = data.status;
    progress.value = data.progress || 0;
    total.value = data.total || 0;
    if (data.error) backendError.value = data.error;

    if (data.status === 'done' || data.status === 'error') {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      loading.value = false;
    }
  } catch (err) {
    // Не спамим пользователя алертами: сетевые «моргания» — норма при
    // длительном опросе. Ошибку кладём в консоль, состояние формы не рушим.
    console.error('[parsers] status poll failed:', err);
  }
};

const downloadAuthenticatedFile = async (url, fallbackName) => {
  const token = localStorage.getItem('seo_token') || '';
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    let message = `Сервер вернул HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.error || payload.detail || message;
    } catch (_) { /* response is not JSON */ }
    throw new Error(message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i);
  const fileName = match?.[1] ? decodeURIComponent(match[1].trim()) : fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

const downloadReport = async () => {
  if (!taskId.value || downloadBusy.value) return;
  downloadBusy.value = true;
  errorMessage.value = '';
  try {
    const url = scanMode.value === 'bot'
      ? `/api/parser-bot/scans/${taskId.value}/export.xlsx`
      : `/api/parsers/download/${taskId.value}`;
    await downloadAuthenticatedFile(url, `parsers_report-${taskId.value}.xlsx`);
  } catch (err) {
    errorMessage.value = `Не удалось скачать Excel-отчёт: ${err?.message || 'неизвестная ошибка'}`;
  } finally {
    downloadBusy.value = false;
  }
};

const cancelScan = async () => {
  if (!taskId.value || scanMode.value !== 'bot') return;
  await api.post(`/parser-bot/scans/${taskId.value}/cancel`);
  await checkStatus();
};

const retryFailed = async () => {
  if (!taskId.value || scanMode.value !== 'bot') return;
  await api.post(`/parser-bot/scans/${taskId.value}/retry`);
  loading.value = true;
  status.value = 'running';
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkStatus, 3000);
  await checkStatus();
};

const resetTask = () => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  taskId.value = null;
  scanMode.value = 'legacy';
  status.value = '';
  progress.value = 0;
  total.value = 0;
  results.value = [];
  backendError.value = '';
  errorMessage.value = '';
  loading.value = false;
};

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});
</script>

<template>
  <AppLayout>
    <div class="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <!-- Заголовок раздела -->
      <div class="flex items-end justify-between border-b border-gray-800 pb-4 gap-4 flex-wrap">
        <div>
          <h1 class="text-2xl font-bold text-white flex items-center gap-2">
            ⛏️ Парсеры контента
            <span
              class="text-[11px] font-medium text-indigo-300 bg-indigo-950/40 border border-indigo-900 px-2 py-0.5 rounded"
            >
              DeepSeek v4 pro
            </span>
          </h1>
          <p class="text-gray-400 text-sm mt-1">
            Извлечение контактов, описания компании и услуг с чужих сайтов —
            по своему списку URL или из поисковой выдачи Яндекса.
          </p>
        </div>
      </div>

      <!-- Переключатель «Включить» -->
      <div class="card">
        <label class="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            v-model="enabled"
            class="mt-1 h-5 w-5 rounded border-gray-700 bg-gray-950 text-indigo-600 focus:ring-indigo-700"
          />
          <span class="min-w-0">
            <span class="block text-base font-semibold text-white">Включить парсинг контента</span>
            <span class="block text-xs text-gray-500 mt-0.5">
              Глубокий разбор сайтов через LLM. Отключите, если хотите только настроить параметры без запуска.
            </span>
          </span>
        </label>
      </div>

      <!-- Основная форма -->
      <div v-if="enabled" class="card space-y-6">
        <!-- Источник данных: сегментированный переключатель -->
        <div>
          <div class="label">Источник данных</div>
          <div
            role="radiogroup"
            aria-label="Источник данных"
            class="inline-flex rounded-lg border border-gray-700 bg-gray-950 p-0.5 text-sm"
          >
            <button
              type="button"
              role="radio"
              :aria-checked="source === 'search'"
              @click="source = 'search'"
              :class="[
                'px-3.5 py-1.5 rounded-md font-medium transition-colors',
                source === 'search'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-100',
              ]"
            >
              🔍 Из поиска
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="source === 'custom'"
              @click="source = 'custom'"
              :class="[
                'px-3.5 py-1.5 rounded-md font-medium transition-colors',
                source === 'custom'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-100',
              ]"
            >
              📋 Свой список
            </button>
          </div>
        </div>

        <!-- Свой список URL -->
        <div v-if="source === 'custom'">
          <div class="flex items-center justify-between mb-1.5">
            <label class="label !mb-0">Список сайтов (по одному в строке)</label>
            <span class="text-[11px] text-gray-500 tabular-nums">
              URL: <span class="text-gray-300">{{ parsedUrls.length }}</span>
            </span>
          </div>
          <textarea
            v-model="customUrls"
            rows="6"
            class="textarea font-mono text-xs leading-relaxed"
            placeholder="https://example.com&#10;https://another-site.ru&#10;example-without-protocol.com"
          />
          <p class="text-[11px] text-gray-500 mt-1">
            Схема (http/https) добавится автоматически, если её нет.
          </p>
        </div>

        <!-- Ключевые запросы для поиска -->
        <div v-else>
          <label class="label">Ключевые запросы (через запятую)</label>
          <input
            type="text"
            v-model="searchQuery"
            class="input"
            placeholder="стоматология москва, детская стоматология москва"
          />
          <p class="text-[11px] text-gray-500 mt-1">
            Возьмём топ-10 Яндекса по каждому запросу и обработаем найденные сайты.
          </p>
        </div>

        <!-- Объекты парсинга -->
        <div>
          <div class="label">Что извлекать</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <label
              class="flex items-start gap-2.5 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5 cursor-pointer hover:border-gray-700 transition-colors"
            >
              <input
                type="checkbox"
                v-model="options.contacts"
                class="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-700"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-100">📞 Контакты</span>
                <span class="block text-[11px] text-gray-500">Телефоны, e-mail, адреса</span>
              </span>
            </label>
            <label
              class="flex items-start gap-2.5 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5 cursor-pointer hover:border-gray-700 transition-colors"
            >
              <input
                type="checkbox"
                v-model="options.about"
                class="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-700"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-100">🏢 О компании</span>
                <span class="block text-[11px] text-gray-500">Краткое описание</span>
              </span>
            </label>
            <label
              class="flex items-start gap-2.5 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5 cursor-pointer hover:border-gray-700 transition-colors"
            >
              <input
                type="checkbox"
                v-model="options.services"
                class="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-700"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-100">🧾 Услуги</span>
                <span class="block text-[11px] text-gray-500">Разбор через DeepSeek v4 pro</span>
              </span>
            </label>
            <label
              class="flex items-start gap-2.5 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2.5 cursor-pointer hover:border-gray-700 transition-colors"
            >
              <input
                type="checkbox"
                v-model="options.clients"
                class="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-700"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-100">🎯 Клиенты и сегменты ЦА</span>
                <span class="block text-[11px] text-gray-500">Категории клиентов и с кем работают</span>
              </span>
            </label>
          </div>
          <p
            v-if="!anyObjectSelected"
            class="text-[11px] text-amber-400 mt-1.5"
          >
            Отметьте хотя бы один объект — иначе парсить нечего.
          </p>
        </div>

        <!-- Ошибка формы / запуска -->
        <div
          v-if="errorMessage"
          class="p-3 rounded-lg bg-red-900/25 border border-red-800 text-red-300 text-sm flex items-start gap-2"
        >
          <span aria-hidden="true">⚠</span>
          <span>{{ errorMessage }}</span>
        </div>

        <!-- Кнопки действий -->
        <div class="flex items-center gap-3 pt-2 border-t border-gray-800">
          <button
            type="button"
            @click="startParsing"
            :disabled="!canStart"
            class="btn-primary"
          >
            <svg
              v-if="loading"
              class="animate-spin h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span>{{ loading ? 'Запуск…' : '🚀 Запустить парсер' }}</span>
          </button>
          <button
            v-if="taskId && !loading"
            type="button"
            @click="resetTask"
            class="btn-ghost text-xs"
          >
            Сбросить
          </button>
          <span class="text-[11px] text-gray-500 ml-auto">
            Свой список обрабатывается durable worker-ом с retry/heartbeat; поиск — legacy endpoint.
          </span>
        </div>
      </div>

      <!-- Статус выполнения -->
      <div v-if="taskId" class="card space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 min-w-0">
            <span :class="['badge', statusBadge.cls]">{{ statusBadge.text }}</span>
            <span class="text-sm text-gray-300 truncate">{{ statusMessage }}</span>
          </div>
          <span class="text-sm font-semibold text-indigo-300 tabular-nums flex-shrink-0">
            {{ progressPercent }}%
          </span>
        </div>

        <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
          <div
            class="h-2 rounded-full transition-all duration-300"
            :class="status === 'error' ? 'bg-red-500' : 'bg-indigo-500'"
            :style="{ width: progressPercent + '%' }"
          />
        </div>

        <div
          v-if="status === 'error' && backendError"
          class="text-xs text-red-300 bg-red-900/20 border border-red-900/60 rounded-md px-3 py-2"
        >
          {{ backendError }}
        </div>

        <div
          v-if="scanMode === 'bot' && !terminalStatuses.has(status)"
          class="flex items-center gap-3 pt-1"
        >
          <button
            type="button"
            @click="cancelScan"
            class="btn-ghost text-xs text-red-300 hover:text-red-200"
          >
            ⏹ Отменить
          </button>
          <span class="text-[11px] text-gray-500">
            Worker сохраняет частичный прогресс и продолжит queued/running items после рестарта backend.
          </span>
        </div>

        <div v-if="status === 'done' || status === 'partial'" class="flex items-center gap-3 pt-1 flex-wrap">
          <button
            type="button"
            @click="downloadReport"
            :disabled="downloadBusy"
            class="btn-primary bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60"
          >
            <span v-if="downloadBusy">⏳ Формирование…</span>
            <span v-else>📥 Скачать Excel-отчёт</span>
          </button>
          <span class="text-[11px] text-gray-500">
            Файл: <span class="font-mono text-gray-400">parsers_report.xlsx</span>
          </span>
          <button
            v-if="scanMode === 'bot' && status === 'partial'"
            type="button"
            @click="retryFailed"
            class="btn-ghost text-xs"
          >
            ↻ Повторить ошибки
          </button>
        </div>
      </div>

      <!-- Результаты parser-bot по сайтам -->
      <div v-if="scanMode === 'bot' && results.length" class="card space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-white">Результаты по сайтам</h2>
            <p class="text-xs text-gray-500">
              Статусы полей отделены от пользовательских fallback-сообщений; evidence показывает URL и цитаты.
            </p>
          </div>
          <span class="text-xs text-gray-400">{{ results.length }} URL</span>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="text-xs uppercase text-gray-500 border-b border-gray-800">
              <tr>
                <th class="text-left py-2 pr-4">URL</th>
                <th class="text-left py-2 pr-4">Статус</th>
                <th class="text-left py-2 pr-4">Источник / доступ</th>
                <th class="text-left py-2 pr-4">Категории клиентов</th>
                <th class="text-left py-2 pr-4">С кем работает</th>
                <th class="text-left py-2 pr-4">Страниц</th>
                <th class="text-left py-2">Доказательства</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800">
              <tr v-for="item in results" :key="item.id" class="align-top">
                <td class="py-3 pr-4 min-w-[220px]">
                  <a
                    :href="itemResult(item).url || item.normalized_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-indigo-300 hover:text-indigo-200 break-all"
                  >
                    {{ itemResult(item).url || item.normalized_url }}
                  </a>
                  <div v-if="itemError(item)" class="text-[11px] text-red-300 mt-1">
                    {{ itemError(item) }}
                  </div>
                </td>
                <td class="py-3 pr-4">
                  <span :class="['badge', siteStatusMeta(itemStatus(item)).cls]">
                    {{ siteStatusMeta(itemStatus(item)).text }}
                  </span>
                  <div class="text-[11px] text-gray-500 mt-1">
                    попыток: {{ item.attempts || 0 }}
                  </div>
                </td>
                <td class="py-3 pr-4 min-w-[190px] text-xs text-gray-400">
                  <div>Источник: {{ itemExecution(item).result_source || 'fresh' }}</div>
                  <div v-if="itemResult(item).access?.status || itemResult(item).error_code" class="mt-1 text-orange-300">
                    {{ itemResult(item).access?.status || itemResult(item).error_code }}
                  </div>
                  <div v-if="itemResult(item).access?.status_code" class="mt-1">HTTP {{ itemResult(item).access.status_code }}</div>
                </td>
                <td class="py-3 pr-4 min-w-[260px] whitespace-pre-line text-gray-200">
                  {{ itemClientSegments(item) || '—' }}
                  <div class="mt-2">
                    <span :class="['badge', fieldStatusMeta(itemFieldStatus(item).client_segments).cls]">
                      {{ fieldStatusMeta(itemFieldStatus(item).client_segments).text }}
                    </span>
                  </div>
                </td>
                <td class="py-3 pr-4 min-w-[220px] text-gray-200">
                  {{ itemResult(item).works_with || '—' }}
                  <div class="mt-2">
                    <span :class="['badge', fieldStatusMeta(itemFieldStatus(item).works_with).cls]">
                      {{ fieldStatusMeta(itemFieldStatus(item).works_with).text }}
                    </span>
                  </div>
                </td>
                <td class="py-3 pr-4 text-gray-300 tabular-nums">
                  {{ itemResult(item).stats?.pages_scanned ?? item.stats?.pages_scanned ?? '—' }}
                </td>
                <td class="py-3 min-w-[280px]">
                  <div v-if="itemEvidence(item).length" class="space-y-2">
                    <div
                      v-for="(ev, idx) in itemEvidence(item).slice(0, 3)"
                      :key="idx"
                      class="text-xs rounded-md border border-gray-800 bg-gray-950/60 p-2"
                    >
                      <a
                        :href="ev.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-indigo-300 hover:text-indigo-200 break-all"
                      >
                        {{ ev.url }}
                      </a>
                      <div class="text-gray-300 mt-1">«{{ ev.quote }}»</div>
                      <div class="text-gray-500 mt-1">{{ ev.field }} · {{ ev.signal_type }}</div>
                    </div>
                  </div>
                  <span v-else class="text-xs text-gray-500">Нет доказательств</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
