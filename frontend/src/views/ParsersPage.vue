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
const taskId = ref(null);
const status = ref('');            // '' | 'running' | 'done' | 'error'
const progress = ref(0);
const total = ref(0);
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
  if (status.value === 'error') return backendError.value || 'Произошла ошибка при парсинге.';
  if (total.value > 0) return `Обработано ${progress.value} из ${total.value} сайтов…`;
  return 'Запуск задачи…';
});

const statusBadge = computed(() => {
  if (status.value === 'done')
    return { text: '✓ Готово', cls: 'bg-emerald-900/40 text-emerald-300 border border-emerald-800' };
  if (status.value === 'error')
    return { text: '⚠ Ошибка', cls: 'bg-red-900/40 text-red-300 border border-red-800' };
  return { text: '⏳ В работе', cls: 'bg-indigo-900/40 text-indigo-300 border border-indigo-800' };
});

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
    const payload = {
      urls,
      options: {
        ...options.value,
        search_query: source.value === 'search' ? searchQuery.value : null,
      },
    };

    const { data } = await api.post('/parsers/start', payload);
    taskId.value = data.task_id;
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(checkStatus, 3000);
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

const downloadReport = () => {
  if (!taskId.value) return;
  // baseURL инстанса axios = '/api', поэтому явный префикс не нужен.
  window.open(`/api/parsers/download/${taskId.value}`, '_blank');
};

const resetTask = () => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  taskId.value = null;
  status.value = '';
  progress.value = 0;
  total.value = 0;
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
            Обработка идёт в 5 потоков, тайм-аут на сайт — до 5 минут.
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

        <div v-if="status === 'done'" class="flex items-center gap-3 pt-1">
          <button
            @click="downloadReport"
            class="btn-primary bg-emerald-600 hover:bg-emerald-500"
          >
            📥 Скачать Excel-отчёт
          </button>
          <span class="text-[11px] text-gray-500">
            Файл: <span class="font-mono text-gray-400">parsers_report.xlsx</span>
          </span>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
