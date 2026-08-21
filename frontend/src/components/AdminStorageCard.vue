<script setup>
import { computed, onMounted, ref } from 'vue';
import { useAdminStore } from '../stores/admin.js';

const admin = useAdminStore();
const loading = ref(false);
const actionLoading = ref(false);
const error = ref(null);
const message = ref(null);
const audit = ref(null);
const scope = ref('tasks');
const olderThanDays = ref(30);
const preview = ref(null);

const storagePaths = computed(() => audit.value?.filesystem?.paths || []);
const tables = computed(() => audit.value?.database?.tables || []);
const cacheBrands = computed(() => audit.value?.redis?.response_cache?.by_brand_hash || []);

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024 || unit === 'TB') return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
  }
  return `${n} B`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    audit.value = await admin.fetchStorageAudit();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось получить storage audit';
  } finally {
    loading.value = false;
  }
}

async function runPreview() {
  actionLoading.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await admin.cleanupStorage({
      scope: scope.value,
      olderThanDays: Number(olderThanDays.value),
      dryRun: true,
    });
    preview.value = result;
    message.value = 'Preview выполнен: данные не удалялись.';
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось выполнить preview';
  } finally {
    actionLoading.value = false;
  }
}

async function runCleanup() {
  if (!window.confirm(`Удалить данные scope «${scope.value}» старше ${olderThanDays.value} дней? Активные задачи не трогаются.`)) return;
  const typed = window.prompt('Для подтверждения удаления введите DELETE');
  if (typed !== 'DELETE') return;
  actionLoading.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await admin.cleanupStorage({
      scope: scope.value,
      olderThanDays: Number(olderThanDays.value),
      dryRun: false,
      confirm: 'DELETE',
    });
    preview.value = result;
    message.value = 'Очистка выполнена. Обновляю storage audit.';
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось выполнить очистку';
  } finally {
    actionLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="card mb-8">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div>
        <h2 class="text-lg font-bold text-white">Хранилище и очистка</h2>
        <p class="text-xs text-gray-500 mt-1">Диск, PostgreSQL, Redis-кэш и артефакты задач</p>
      </div>
      <button class="btn-ghost text-xs" :disabled="loading || actionLoading" @click="load">Обновить</button>
    </div>

    <div v-if="error" class="bg-red-950/60 border border-red-800 text-red-300 text-sm px-3 py-2 rounded mb-4">{{ error }}</div>
    <div v-if="message" class="bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-sm px-3 py-2 rounded mb-4">{{ message }}</div>
    <div v-if="loading" class="text-sm text-gray-400 py-4">Сканирование storage…</div>

    <template v-else-if="audit">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-cyan-300">{{ audit.filesystem?.filesystem?.used_human || '—' }}</div>
          <div class="text-xs text-gray-400">Занято на filesystem</div>
          <div class="text-[11px] text-gray-600 mt-1">Свободно: {{ audit.filesystem?.filesystem?.free_human || '—' }}</div>
        </div>
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-violet-300">{{ audit.database?.database_human || '—' }}</div>
          <div class="text-xs text-gray-400">PostgreSQL database</div>
          <div class="text-[11px] text-gray-600 mt-1">Размеры таблиц ниже</div>
        </div>
        <div class="bg-gray-800/40 rounded-lg p-3">
          <div class="text-lg font-bold text-amber-300">{{ audit.redis?.used_memory_human || '—' }}</div>
          <div class="text-xs text-gray-400">Redis memory</div>
          <div class="text-[11px] text-gray-600 mt-1">Keys: {{ audit.redis?.dbsize ?? '—' }}</div>
        </div>
      </div>

      <div class="overflow-x-auto mb-5">
        <h3 class="text-xs text-gray-400 uppercase tracking-wide mb-2">Известные директории</h3>
        <table class="w-full text-xs">
          <thead><tr class="border-b border-gray-800 text-left text-gray-400"><th class="py-2 px-2">Каталог</th><th class="py-2 px-2">Путь</th><th class="py-2 px-2">Размер</th><th class="py-2 px-2">Очистка</th></tr></thead>
          <tbody>
            <tr v-for="item in storagePaths" :key="item.key" class="border-b border-gray-800/50">
              <td class="py-2 px-2 text-gray-200">{{ item.label }}</td>
              <td class="py-2 px-2 text-gray-500 font-mono max-w-[360px] truncate" :title="item.path">{{ item.path }}</td>
              <td class="py-2 px-2 text-cyan-300">{{ item.human || fmtBytes(item.bytes) }}</td>
              <td class="py-2 px-2" :class="item.cleanup ? 'text-emerald-400' : 'text-gray-600'">{{ item.cleanup ? 'разрешена по возрасту' : 'защищён' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="overflow-x-auto mb-5">
        <h3 class="text-xs text-gray-400 uppercase tracking-wide mb-2">Крупнейшие таблицы PostgreSQL</h3>
        <table class="w-full text-xs">
          <thead><tr class="border-b border-gray-800 text-left text-gray-400"><th class="py-2 px-2">Таблица</th><th class="py-2 px-2">Размер</th></tr></thead>
          <tbody>
            <tr v-for="table in tables.slice(0, 12)" :key="`${table.schema}.${table.table_name}`" class="border-b border-gray-800/50">
              <td class="py-2 px-2 text-gray-300 font-mono">{{ table.schema }}.{{ table.table_name }}</td>
              <td class="py-2 px-2 text-violet-300">{{ table.human || fmtBytes(table.bytes) }}</td>
            </tr>
            <tr v-if="!tables.length"><td colspan="2" class="py-3 text-gray-600">Нет данных о таблицах</td></tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-end gap-2 border-t border-gray-800 pt-4">
        <label class="text-xs text-gray-400">Scope
          <select v-model="scope" class="input text-xs py-1 mt-1 block">
            <option value="tasks">Старые task rows + artifacts</option>
            <option value="uploads">Uploads</option>
            <option value="backend_tmp">Backend tmp</option>
            <option value="response_cache">Redis LLM response cache</option>
          </select>
        </label>
        <label class="text-xs text-gray-400">Старше, дней
          <input v-model.number="olderThanDays" type="number" min="1" max="3650" class="input text-xs py-1 mt-1 block w-28" />
        </label>
        <button class="btn-ghost text-xs" :disabled="actionLoading" @click="runPreview">Preview</button>
        <button class="text-xs px-3 py-2 rounded bg-red-900/60 text-red-300 hover:bg-red-800 disabled:opacity-50" :disabled="actionLoading" @click="runCleanup">Удалить после подтверждения</button>
      </div>

      <div v-if="preview" class="mt-3 text-xs text-gray-400 bg-gray-900/60 rounded p-3">
        <span class="text-gray-300">{{ preview.message || (preview.dry_run ? 'Preview' : 'Результат очистки') }}</span>
        <pre class="mt-2 whitespace-pre-wrap text-gray-500">{{ JSON.stringify(preview.result || preview, null, 2) }}</pre>
      </div>

      <p class="text-[11px] text-gray-600 mt-3">`brain_state` защищён. Images удаляются только вместе со старыми задачами. `pg_data` и `redis_data` не удаляются через UI. Preview не удаляет ни строки, ни файлы.</p>
    </template>
  </div>
</template>
