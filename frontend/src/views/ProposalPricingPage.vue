<script setup>
/**
 * ProposalPricingPage — прайс-лист (справочник типовых цен) модуля «Фронт работ».
 * Позиции автоподставляются в раздел «Стоимость» конструктора КП.
 */
import { ref, onMounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const templates = ref([]);
const loading = ref(false);
const error = ref(null);
const form = ref({ item_name: '', base_budget: 0, note: '' });
const editing = ref(null);

function fmtMoney(v) { return Number(v || 0).toLocaleString('ru-RU'); }

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const { data } = await api.get('/proposals/pricing-templates');
    templates.value = data.templates || [];
  } catch (e) {
    error.value = e.response?.data?.error || 'Не удалось загрузить прайс-лист';
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (!form.value.item_name.trim()) return;
  try {
    await api.post('/proposals/pricing-templates', form.value);
    form.value = { item_name: '', base_budget: 0, note: '' };
    await load();
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось добавить позицию');
  }
}

async function saveEdit() {
  try {
    await api.put(`/proposals/pricing-templates/${editing.value.id}`, editing.value);
    editing.value = null;
    await load();
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось сохранить позицию');
  }
}

async function remove(t) {
  if (!confirm(`Удалить позицию «${t.item_name}»?`)) return;
  try {
    await api.delete(`/proposals/pricing-templates/${t.id}`);
    await load();
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось удалить позицию');
  }
}

onMounted(load);
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-4xl mx-auto">
      <header class="flex items-center justify-between mb-5">
        <div>
          <h1 class="text-xl font-semibold text-gray-100">💰 Прайс-лист</h1>
          <p class="text-sm text-gray-400 mt-1">Справочник типовых цен — для автоподстановки в раздел «Стоимость» КП.</p>
        </div>
        <router-link to="/proposals" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">← История КП</router-link>
      </header>

      <div v-if="error" class="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-800 text-red-300 text-sm">{{ error }}</div>

      <!-- Добавление -->
      <div class="flex flex-wrap gap-2 mb-5">
        <input v-model="form.item_name" type="text" maxlength="255" placeholder="Название позиции…"
          class="flex-1 min-w-[200px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
        <input v-model.number="form.base_budget" type="number" min="0" placeholder="Цена, ₽"
          class="w-32 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
        <input v-model="form.note" type="text" maxlength="500" placeholder="Примечание"
          class="flex-1 min-w-[160px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
        <button @click="add" :disabled="!form.item_name.trim()"
          class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition">➕ Добавить</button>
      </div>

      <div v-if="loading" class="text-gray-400 text-sm py-6 text-center">Загрузка…</div>
      <div v-else-if="!templates.length" class="text-center py-10 text-gray-500">Прайс-лист пуст — добавьте первую позицию.</div>

      <div v-else class="overflow-x-auto rounded-xl border border-gray-800">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-900 text-gray-400 text-left">
            <tr>
              <th class="px-4 py-3 font-medium">Позиция</th>
              <th class="px-4 py-3 font-medium text-right">Цена, ₽</th>
              <th class="px-4 py-3 font-medium">Примечание</th>
              <th class="px-4 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-800 bg-gray-950">
            <tr v-for="t in templates" :key="t.id">
              <template v-if="editing && editing.id === t.id">
                <td class="px-2 py-2"><input v-model="editing.item_name" class="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-2"><input v-model.number="editing.base_budget" type="number" min="0" class="w-28 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-2"><input v-model="editing.note" class="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-2 text-right whitespace-nowrap">
                  <button @click="saveEdit" class="text-emerald-400 px-1">✓</button>
                  <button @click="editing = null" class="text-gray-400 px-1">✕</button>
                </td>
              </template>
              <template v-else>
                <td class="px-4 py-3 text-gray-100">{{ t.item_name }}</td>
                <td class="px-4 py-3 text-right text-gray-300">{{ fmtMoney(t.base_budget) }}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">{{ t.note || '—' }}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">
                  <button @click="editing = { ...t }" class="text-gray-400 hover:text-white px-1" title="Изменить">✏️</button>
                  <button @click="remove(t)" class="text-gray-400 hover:text-red-400 px-1" title="Удалить">🗑️</button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AppLayout>
</template>
