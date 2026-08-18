<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-900">Парсеры контента</h1>
    </div>
    
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden p-6">
      <div class="mb-6 border-b pb-4">
        <label class="flex items-center space-x-3 cursor-pointer">
          <input type="checkbox" v-model="enabled" class="form-checkbox h-5 w-5 text-indigo-600 rounded">
          <span class="text-lg font-medium text-gray-800">Включить парсинг контента</span>
        </label>
        <p class="text-sm text-gray-500 mt-2">Функция глубокого анализа услуг с использованием DeepSeek v4 pro.</p>
      </div>

      <div v-if="enabled" class="space-y-6">
        <div>
          <h3 class="text-md font-semibold text-gray-800 mb-3">Источник данных</h3>
          <div class="flex items-center space-x-6">
            <label class="flex items-center space-x-2">
              <input type="radio" v-model="source" value="search" class="form-radio h-4 w-4 text-indigo-600">
              <span class="text-sm text-gray-700">Парсить из поисковой выдачи</span>
            </label>
            <label class="flex items-center space-x-2">
              <input type="radio" v-model="source" value="custom" class="form-radio h-4 w-4 text-indigo-600">
              <span class="text-sm text-gray-700">Свой список сайтов</span>
            </label>
          </div>
        </div>

        <div v-if="source === 'custom'">
          <label class="block text-sm font-medium text-gray-700 mb-2">Список сайтов (каждый с новой строки):</label>
          <textarea v-model="customUrls" rows="5" class="w-full border-gray-300 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 p-3" placeholder="https://example.com"></textarea>
        </div>
        <div v-else>
          <label class="block text-sm font-medium text-gray-700 mb-2">Ключевые запросы для поиска (через запятую):</label>
          <input type="text" v-model="searchQuery" class="w-full border-gray-300 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-indigo-500 p-3" placeholder="Например: стоматология москва">
        </div>

        <div>
          <h3 class="text-md font-semibold text-gray-800 mb-3">Объекты парсинга</h3>
          <div class="space-y-2">
            <label class="flex items-center space-x-3">
              <input type="checkbox" v-model="options.contacts" class="form-checkbox h-4 w-4 text-indigo-600 rounded">
              <span class="text-sm text-gray-700">Контакты (телефоны, email, адреса)</span>
            </label>
            <label class="flex items-center space-x-3">
              <input type="checkbox" v-model="options.about" class="form-checkbox h-4 w-4 text-indigo-600 rounded">
              <span class="text-sm text-gray-700">О компании (краткое описание)</span>
            </label>
            <label class="flex items-center space-x-3">
              <input type="checkbox" v-model="options.services" class="form-checkbox h-4 w-4 text-indigo-600 rounded">
              <span class="text-sm text-gray-700">Услуги (анализ через DeepSeek v4 pro)</span>
            </label>
          </div>
        </div>

        <div class="pt-4">
          <button 
            @click="startParsing" 
            :disabled="loading"
            class="bg-indigo-600 text-white px-6 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center"
          >
            <span v-if="loading" class="mr-2">
              <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg>
            </span>
            Запустить парсер
          </button>
        </div>

        <div v-if="taskId" class="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h4 class="text-sm font-semibold text-gray-800 mb-2">Статус выполнения</h4>
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm text-gray-600">
              {{ statusMessage }}
            </span>
            <span class="text-sm font-medium text-indigo-600">{{ progressPercent }}%</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div class="bg-indigo-600 h-2 rounded-full transition-all duration-300" :style="{ width: progressPercent + '%' }"></div>
          </div>
          
          <div v-if="status === 'done'" class="mt-4">
            <button @click="downloadReport" class="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-sm">
              Скачать Excel Отчет
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import api from '../api';

const enabled = ref(true);
const source = ref('custom');
const customUrls = ref('');
const searchQuery = ref('');
const options = ref({
  contacts: true,
  about: true,
  services: true
});

const loading = ref(false);
const taskId = ref(null);
const status = ref('');
const progress = ref(0);
const total = ref(0);
let pollInterval = null;

const progressPercent = computed(() => {
  if (!total.value) return 0;
  return Math.round((progress.value / total.value) * 100);
});

const statusMessage = computed(() => {
  if (status.value === 'done') return 'Готово!';
  if (status.value === 'error') return 'Произошла ошибка при парсинге.';
  if (total.value > 0) return `Обработано ${progress.value} из ${total.value} сайтов...`;
  return 'Запуск...';
});

const startParsing = async () => {
  try {
    loading.value = true;
    taskId.value = null;
    status.value = 'running';
    progress.value = 0;
    total.value = 0;

    let urls = [];
    if (source.value === 'custom') {
      urls = customUrls.value.split('\n').map(u => u.trim()).filter(u => u);
    }

    if (source.value === 'custom' && urls.length === 0) {
      alert('Пожалуйста, укажите список сайтов.');
      loading.value = false;
      return;
    }

    if (source.value === 'search' && !searchQuery.value.trim()) {
      alert('Пожалуйста, введите поисковый запрос.');
      loading.value = false;
      return;
    }

    const { data } = await api.post('/api/parsers/start', {
      urls,
      options: { ...options.value, search_query: source.value === 'search' ? searchQuery.value : null }
    });

    taskId.value = data.task_id;
    pollInterval = setInterval(checkStatus, 3000);
  } catch (err) {
    alert('Ошибка запуска: ' + err.message);
    loading.value = false;
  }
};

const checkStatus = async () => {
  if (!taskId.value) return;
  try {
    const { data } = await api.get(`/api/parsers/status/${taskId.value}`);
    status.value = data.status;
    progress.value = data.progress;
    total.value = data.total;

    if (data.status === 'done' || data.status === 'error') {
      clearInterval(pollInterval);
      loading.value = false;
    }
  } catch (err) {
    console.error(err);
  }
};

const downloadReport = () => {
  if (!taskId.value) return;
  window.open(`${api.defaults.baseURL || ''}/api/parsers/download/${taskId.value}`, '_blank');
};

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});
</script>