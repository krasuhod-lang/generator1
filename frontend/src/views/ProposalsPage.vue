<script setup>
/**
 * ProposalsPage — «Фронт работ»: список и история КП (раздел «Прогнозатор»).
 *   • Таблица КП: название, клиент, дата, горизонт, статус, задачи, бюджет.
 *   • Фильтры: поиск по названию/клиенту, статус, сортировка по дате.
 *   • Действия: открыть / клонировать (модалка) / скачать PDF, Excel / удалить.
 */
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const router = useRouter();

const proposals = ref([]);
const loading = ref(false);
const error = ref(null);

const filterQ = ref('');
const filterStatus = ref('');
const sortDir = ref('desc');

const STATUS_LABEL = {
  draft: 'Черновик', sent: 'Отправлено', accepted: 'Принято', rejected: 'Отклонено',
};
const STATUS_CLASS = {
  draft: 'bg-gray-700 text-gray-200',
  sent: 'bg-blue-900/60 text-blue-300',
  accepted: 'bg-emerald-900/60 text-emerald-300',
  rejected: 'bg-red-900/60 text-red-300',
};

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const { data } = await api.get('/proposals', {
      params: {
        q: filterQ.value || undefined,
        status: filterStatus.value || undefined,
        sort: sortDir.value,
      },
    });
    proposals.value = data.proposals || [];
  } catch (e) {
    error.value = e.response?.data?.error || 'Не удалось загрузить список КП';
  } finally {
    loading.value = false;
  }
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}
function fmtMoney(v) {
  return Number(v || 0).toLocaleString('ru-RU');
}

async function setStatus(p, status) {
  try {
    await api.put(`/proposals/${p.id}`, { status });
    p.status = status;
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось изменить статус');
  }
}

async function removeProposal(p) {
  if (!confirm(`Удалить КП «${p.title}»? Действие необратимо.`)) return;
  try {
    await api.delete(`/proposals/${p.id}`);
    proposals.value = proposals.value.filter((x) => x.id !== p.id);
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось удалить КП');
  }
}

async function download(p, ext) {
  try {
    const { data } = await api.get(`/proposals/${p.id}/export/${ext}`, { responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.title}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Не удалось скачать файл');
  }
}

// ── Клонирование ──
const cloneTarget = ref(null);
const cloneTitle = ref('');
const cloneCopyPricing = ref(true);
const cloning = ref(false);

function openClone(p) {
  cloneTarget.value = p;
  cloneTitle.value = `${p.title} (копия)`;
  cloneCopyPricing.value = true;
}

async function doClone() {
  if (!cloneTarget.value) return;
  cloning.value = true;
  try {
    const { data } = await api.post(`/proposals/${cloneTarget.value.id}/clone`, {
      title: cloneTitle.value,
      copy_pricing: cloneCopyPricing.value,
    });
    cloneTarget.value = null;
    // Редирект в редактирование нового КП
    router.push(`/proposals/${data.proposal.id}`);
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось клонировать КП');
  } finally {
    cloning.value = false;
  }
}

onMounted(load);
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-7xl mx-auto">
      <header class="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 class="text-xl font-semibold text-gray-100">🧱 Фронт работ — история КП</h1>
          <p class="text-sm text-gray-400 mt-1">Конструктор коммерческих предложений по SEO: задачи по месяцам, бюджеты, экспорт PDF/Excel.</p>
        </div>
        <div class="flex gap-2">
          <router-link to="/proposals/pricing"
            class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition">
            💰 Прайс-лист
          </router-link>
          <router-link to="/proposals/new"
            class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition">
            ➕ Новое КП
          </router-link>
        </div>
      </header>

      <!-- Фильтры -->
      <div class="flex flex-wrap gap-2 mb-4">
        <input v-model="filterQ" @keyup.enter="load" type="text" placeholder="Поиск: название или клиент…"
          class="flex-1 min-w-[220px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500" />
        <select v-model="filterStatus" @change="load"
          class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
          <option value="">Все статусы</option>
          <option value="draft">Черновик</option>
          <option value="sent">Отправлено</option>
          <option value="accepted">Принято</option>
          <option value="rejected">Отклонено</option>
        </select>
        <select v-model="sortDir" @change="load"
          class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
          <option value="desc">Сначала новые</option>
          <option value="asc">Сначала старые</option>
        </select>
        <button @click="load" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">🔍 Найти</button>
      </div>

      <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-800 text-red-300 text-sm">{{ error }}</div>
      <div v-if="loading" class="text-gray-400 text-sm py-8 text-center">Загрузка…</div>

      <div v-else-if="!proposals.length" class="text-center py-14 text-gray-500">
        КП пока нет. Нажмите «Новое КП», чтобы собрать первый фронт работ.
      </div>

      <div v-else class="overflow-x-auto rounded-xl border border-gray-800">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-900 text-gray-400 text-left">
            <tr>
              <th class="px-4 py-3 font-medium">Название</th>
              <th class="px-4 py-3 font-medium">Клиент</th>
              <th class="px-4 py-3 font-medium">Создано</th>
              <th class="px-4 py-3 font-medium">Горизонт</th>
              <th class="px-4 py-3 font-medium">Статус</th>
              <th class="px-4 py-3 font-medium text-right">Задач</th>
              <th class="px-4 py-3 font-medium text-right">Бюджет, ₽</th>
              <th class="px-4 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-800 bg-gray-950">
            <tr v-for="p in proposals" :key="p.id" class="hover:bg-gray-900/60">
              <td class="px-4 py-3">
                <router-link :to="`/proposals/${p.id}`" class="text-indigo-400 hover:text-indigo-300 font-medium">
                  {{ p.title }}
                </router-link>
                <span v-if="p.cloned_from_id" class="ml-1 text-xs text-gray-500" title="Клонировано из другого КП">⧉</span>
              </td>
              <td class="px-4 py-3 text-gray-300">{{ p.client || '—' }}</td>
              <td class="px-4 py-3 text-gray-400">{{ fmtDate(p.created_at) }}</td>
              <td class="px-4 py-3 text-gray-300">{{ p.horizon }} мес.</td>
              <td class="px-4 py-3">
                <select :value="p.status" @change="setStatus(p, $event.target.value)"
                  class="text-xs rounded-full px-2 py-1 border-0 cursor-pointer" :class="STATUS_CLASS[p.status]">
                  <option v-for="(label, s) in STATUS_LABEL" :key="s" :value="s">{{ label }}</option>
                </select>
              </td>
              <td class="px-4 py-3 text-right text-gray-300">{{ p.tasks_count }}</td>
              <td class="px-4 py-3 text-right text-gray-300">{{ fmtMoney(p.total_budget) }}</td>
              <td class="px-4 py-3 text-right whitespace-nowrap">
                <button @click="openClone(p)" class="text-gray-400 hover:text-white px-1" title="Клонировать">⧉</button>
                <button @click="download(p, 'pdf')" class="text-gray-400 hover:text-white px-1" title="Скачать PDF">📄</button>
                <button @click="download(p, 'xlsx')" class="text-gray-400 hover:text-white px-1" title="Скачать Excel">📊</button>
                <button @click="removeProposal(p)" class="text-gray-400 hover:text-red-400 px-1" title="Удалить">🗑️</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Модалка клонирования -->
      <div v-if="cloneTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md">
          <h3 class="text-lg font-semibold text-gray-100 mb-3">Клонировать КП</h3>
          <label class="block text-xs text-gray-400 mb-1">Название нового КП</label>
          <input v-model="cloneTitle" type="text" maxlength="255"
            class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 mb-3" />
          <label class="flex items-center gap-2 text-sm text-gray-300 mb-4">
            <input v-model="cloneCopyPricing" type="checkbox" class="rounded" />
            Скопировать стоимости
          </label>
          <div class="flex justify-end gap-2">
            <button @click="cloneTarget = null" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300">Отмена</button>
            <button @click="doClone" :disabled="cloning || !cloneTitle.trim()"
              class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
              {{ cloning ? 'Клонирую…' : 'Клонировать' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
