<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks';

const route = useRoute();
const router = useRouter();
const tasksStore = useTasksStore();

const taskId = route.params.id;
const logs = ref([]);
const progress = ref(0);
const currentStep = ref('');
const connected = ref(false);
const error = ref('');

const logContainer = ref(null);
let eventSource = null;

function scrollToBottom() {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  });
}

onMounted(async () => {
  try {
    await tasksStore.fetchTask(taskId);
  } catch {
    // task may still be processing
  }

  const token = localStorage.getItem('token');
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api';
  const url = `${baseURL}/tasks/${taskId}/sse?token=${encodeURIComponent(token)}`;

  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    connected.value = true;
  };

  eventSource.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      logs.value.push(data);
      if (data.progress != null) progress.value = data.progress;
      if (data.step) currentStep.value = data.step;
      scrollToBottom();
    } catch {
      logs.value.push({ message: e.data, timestamp: new Date().toISOString() });
      scrollToBottom();
    }
  });

  eventSource.addEventListener('pipeline_done', (e) => {
    try {
      const data = JSON.parse(e.data);
      progress.value = 100;
      logs.value.push({ message: '✅ Пайплайн завершён', timestamp: new Date().toISOString(), level: 'success' });
      scrollToBottom();
      setTimeout(() => {
        router.push(`/tasks/${data.task_id || taskId}/result`);
      }, 1500);
    } catch {
      router.push(`/tasks/${taskId}/result`);
    }
  });

  eventSource.addEventListener('error_event', (e) => {
    try {
      const data = JSON.parse(e.data);
      logs.value.push({ message: `❌ ${data.error || 'Ошибка'}`, timestamp: new Date().toISOString(), level: 'error' });
    } catch {
      logs.value.push({ message: '❌ Произошла ошибка', timestamp: new Date().toISOString(), level: 'error' });
    }
    scrollToBottom();
  });

  eventSource.onerror = () => {
    connected.value = false;
    error.value = 'Соединение потеряно. Обновите страницу.';
  };
});

onUnmounted(() => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
});

function logColor(level) {
  const map = {
    error: 'text-red-400',
    warn: 'text-yellow-400',
    success: 'text-green-400',
    info: 'text-blue-300'
  };
  return map[level] || 'text-gray-300';
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ru-RU');
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-800">Мониторинг задачи</h1>
        <p class="text-sm text-gray-500 mt-1">
          {{ tasksStore.currentTask?.name || `Задача #${taskId}` }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="inline-block w-2.5 h-2.5 rounded-full"
          :class="connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
        ></span>
        <span class="text-sm text-gray-500">{{ connected ? 'Подключено' : 'Отключено' }}</span>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="card mb-6">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-medium text-gray-700">{{ currentStep || 'Инициализация...' }}</span>
        <span class="text-sm font-bold text-blue-600">{{ progress }}%</span>
      </div>
      <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
        <div
          class="bg-blue-600 h-3 rounded-full transition-all duration-500 ease-out"
          :style="{ width: progress + '%' }"
        ></div>
      </div>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm"
    >
      {{ error }}
    </div>

    <!-- Log console -->
    <div class="card p-0 overflow-hidden">
      <div class="bg-gray-900 text-gray-300 text-sm font-mono">
        <div class="px-4 py-2 bg-gray-800 text-gray-400 text-xs border-b border-gray-700 flex items-center justify-between">
          <span>📋 Логи выполнения</span>
          <span>{{ logs.length }} записей</span>
        </div>
        <div ref="logContainer" class="p-4 h-96 overflow-y-auto space-y-1">
          <div v-if="logs.length === 0" class="text-gray-500 text-center py-8">
            Ожидание логов...
          </div>
          <div
            v-for="(log, i) in logs"
            :key="i"
            class="flex gap-3"
          >
            <span class="text-gray-500 flex-shrink-0 select-none">{{ formatTime(log.timestamp) }}</span>
            <span :class="logColor(log.level)">{{ log.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
