<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useTasksStore } from '../stores/tasks';

const route = useRoute();
const tasksStore = useTasksStore();

const taskId = route.params.id;
const error = ref('');
const copied = ref(false);
const iframeRef = ref(null);

onMounted(async () => {
  try {
    await tasksStore.fetchTask(taskId);
  } catch (err) {
    error.value = err.response?.data?.error || 'Не удалось загрузить результат';
  }
});

const task = computed(() => tasksStore.currentTask);

const metrics = computed(() => {
  if (!task.value?.result) return [];
  const r = task.value.result;
  return [
    { label: 'LSI покрытие', value: r.lsi_coverage != null ? `${r.lsi_coverage}%` : '—', icon: '📊', color: 'blue' },
    { label: 'E-E-A-T оценка', value: r.eeat_score != null ? `${r.eeat_score}/100` : '—', icon: '⭐', color: 'green' },
    { label: 'BM25 релевантность', value: r.bm25_score != null ? r.bm25_score.toFixed(2) : '—', icon: '🔍', color: 'purple' },
    { label: 'Стоимость', value: r.total_cost != null ? `$${r.total_cost.toFixed(4)}` : '—', icon: '💰', color: 'amber' }
  ];
});

const htmlContent = computed(() => task.value?.result?.html || task.value?.result?.content || '');

function copyHtml() {
  if (!htmlContent.value) return;
  navigator.clipboard.writeText(htmlContent.value).then(() => {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  });
}

const metricColor = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200'
};
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-800">Результат</h1>
        <p class="text-sm text-gray-500 mt-1">
          {{ task?.name || `Задача #${taskId}` }}
        </p>
      </div>
      <router-link to="/dashboard" class="btn bg-gray-200 text-gray-700 hover:bg-gray-300">
        ← К задачам
      </router-link>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm"
    >
      {{ error }}
    </div>

    <!-- Loading -->
    <div v-if="tasksStore.loading" class="text-center py-20 text-gray-400">
      <div class="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      <p class="mt-2">Загрузка результатов...</p>
    </div>

    <template v-else-if="task">
      <!-- Metric cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div
          v-for="m in metrics"
          :key="m.label"
          class="rounded-xl border p-5"
          :class="metricColor[m.color]"
        >
          <div class="text-2xl mb-1">{{ m.icon }}</div>
          <div class="text-xs font-medium opacity-75 mb-1">{{ m.label }}</div>
          <div class="text-2xl font-bold">{{ m.value }}</div>
        </div>
      </div>

      <!-- HTML preview -->
      <div class="card">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold text-gray-800">Готовый HTML-контент</h2>
          <button
            class="btn-primary text-sm"
            @click="copyHtml"
          >
            {{ copied ? '✅ Скопировано!' : '📋 Копировать HTML' }}
          </button>
        </div>

        <div v-if="htmlContent" class="border rounded-lg overflow-hidden">
          <iframe
            ref="iframeRef"
            :srcdoc="htmlContent"
            class="w-full border-0"
            style="min-height: 600px"
            sandbox="allow-same-origin"
            title="Результат генерации"
          ></iframe>
        </div>
        <div v-else class="text-center py-12 text-gray-400">
          HTML-контент отсутствует
        </div>
      </div>
    </template>
  </div>
</template>
