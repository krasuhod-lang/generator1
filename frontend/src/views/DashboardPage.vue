<script setup>
import { onMounted, ref } from 'vue';
import { useTasksStore } from '../stores/tasks';

const tasksStore = useTasksStore();
const error = ref('');

onMounted(async () => {
  try {
    await tasksStore.fetchTasks();
  } catch (err) {
    error.value = err.response?.data?.error || 'Не удалось загрузить задачи';
  }
});

async function handleDelete(id) {
  if (!confirm('Удалить задачу?')) return;
  try {
    await tasksStore.deleteTask(id);
  } catch (err) {
    error.value = err.response?.data?.error || 'Ошибка удаления';
  }
}

function statusBadge(status) {
  const map = {
    pending: 'bg-gray-100 text-gray-700',
    processing: 'bg-blue-100 text-blue-700 animate-pulse',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
}

function statusLabel(status) {
  const map = {
    pending: 'Ожидает',
    processing: 'Обработка',
    completed: 'Завершена',
    failed: 'Ошибка'
  };
  return map[status] || status;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-800">Мои задачи</h1>
      <router-link to="/tasks/create" class="btn-primary">
        + Создать задачу
      </router-link>
    </div>

    <div
      v-if="error"
      class="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm"
    >
      {{ error }}
    </div>

    <div v-if="tasksStore.loading" class="text-center py-20 text-gray-400">
      <div class="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      <p class="mt-2">Загрузка...</p>
    </div>

    <div v-else-if="tasksStore.tasks.length === 0" class="card text-center py-16">
      <p class="text-gray-400 text-lg mb-4">Задач пока нет</p>
      <router-link to="/tasks/create" class="btn-primary">Создать первую задачу</router-link>
    </div>

    <div v-else class="card overflow-hidden p-0">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b text-left text-gray-500 uppercase text-xs">
          <tr>
            <th class="px-4 py-3">Название</th>
            <th class="px-4 py-3">Ключевой запрос</th>
            <th class="px-4 py-3">Статус</th>
            <th class="px-4 py-3">Создана</th>
            <th class="px-4 py-3 text-right">Действия</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="task in tasksStore.tasks" :key="task.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 font-medium text-gray-800">{{ task.name }}</td>
            <td class="px-4 py-3 text-gray-600">{{ task.input_keyword }}</td>
            <td class="px-4 py-3">
              <span
                class="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium"
                :class="statusBadge(task.status)"
              >
                {{ statusLabel(task.status) }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-500">{{ formatDate(task.created_at) }}</td>
            <td class="px-4 py-3 text-right space-x-2">
              <router-link
                v-if="task.status === 'completed'"
                :to="`/tasks/${task.id}/result`"
                class="text-blue-600 hover:underline text-xs font-medium"
              >
                Результат
              </router-link>
              <router-link
                v-else-if="task.status === 'processing'"
                :to="`/tasks/${task.id}/monitor`"
                class="text-blue-600 hover:underline text-xs font-medium"
              >
                Мониторинг
              </router-link>
              <button
                class="text-red-600 hover:underline text-xs font-medium"
                @click="handleDelete(task.id)"
              >
                Удалить
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
