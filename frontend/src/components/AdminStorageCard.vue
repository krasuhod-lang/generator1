<script setup>
import { computed, onMounted, ref } from 'vue';
import { useAdminStore } from '../stores/admin.js';

const admin = useAdminStore();
const loading = ref(false);
const actionLoading = ref(false);
const inventoryLoading = ref(false);
const error = ref(null);
const message = ref(null);
const audit = ref(null);
const inventory = ref(null);
const scope = ref('tasks');
const olderThanDays = ref(30);
const preview = ref(null);
const inventoryRoot = ref('app_root');
const inventorySearch = ref('');
const inventorySort = ref('size');
const inventoryOrder = ref('desc');
const inventoryPage = ref(1);

const storagePaths = computed(() => audit.value?.filesystem?.paths || []);
const tables = computed(() => audit.value?.database?.tables || []);
const cacheBrands = computed(() => audit.value?.redis?.response_cache?.by_brand_hash || []);
const inventoryRoots = computed(() => audit.value?.inventory_roots || []);
const inventoryFiles = computed(() => inventory.value?.files || []);
const inventoryLargestFiles = computed(() => inventory.value?.largest_files || []);
const inventoryFolders = computed(() => inventory.value?.folders || []);
const inventoryPagination = computed(() => inventory.value?.pagination || {});

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

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

function fmtPercent(bytes, total) {
  const value = Number(bytes) || 0;
  const whole = Number(total) || 0;
  if (!whole || !value) return '0%';
  const pct = (value / whole) * 100;
  return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    audit.value = await admin.fetchStorageAudit();
    if (!inventoryRoots.value.some((root) => root.key === inventoryRoot.value)) {
      inventoryRoot.value = inventoryRoots.value[0]?.key || 'app_root';
    }
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось получить storage audit';
  } finally {
    loading.value = false;
  }
}

async function loadInventory(resetPage = false) {
  if (resetPage) inventoryPage.value = 1;
  inventoryLoading.value = true;
  error.value = null;
  try {
    inventory.value = await admin.fetchStorageInventory({
      root: inventoryRoot.value,
      page: inventoryPage.value,
      limit: 100,
      search: inventorySearch.value,
      sort: inventorySort.value,
      order: inventoryOrder.value,
    });
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось получить список файлов';
  } finally {
    inventoryLoading.value = false;
  }
}

async function runPreview() {
  actionLoading.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await admin.cleanupStorage({ scope: scope.value, olderThanDays: Number(olderThanDays.value), dryRun: true });
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
    const result = await admin.cleanupStorage({ scope: scope.value, olderThanDays: Number(olderThanDays.value), dryRun: false, confirm: 'DELETE' });
    preview.value = result;
    message.value = 'Очистка выполнена. Обновляю storage audit.';
    await load();
    await loadInventory();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось выполнить очистку';
  } finally {
    actionLoading.value = false;
  }
}

async function deleteFile(file) {
  if (!file?.deletable || actionLoading.value) return;
  if (!window.confirm(`Удалить файл «${file.relative_path}» (${file.human || fmtBytes(file.bytes)})?`)) return;
  const typed = window.prompt('Для подтверждения удаления файла введите DELETE');
  if (typed !== 'DELETE') return;
  actionLoading.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await admin.deleteStorageFile({ root: inventoryRoot.value, relative_path: file.relative_path, dryRun: false, confirm: 'DELETE' });
    preview.value = result;
    message.value = `Файл удалён: ${file.relative_path}`;
    await load();
    await loadInventory();
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Не удалось удалить файл';
  } finally {
    actionLoading.value = false;
  }
}

function changePage(delta) {
  const next = inventoryPage.value + delta;
  if (next < 1 || (delta > 0 && !inventoryPagination.value.has_more)) return;
  inventoryPage.value = next;
  loadInventory();
}

onMounted(async () => {
  await load();
  await loadInventory();
});
</script>

<template>
  <div class="card mb-8">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div>
        <h2 class="text-lg font-bold text-white">Хранилище и очистка</h2>
        <p class="text-xs text-gray-500 mt-1">Диск, PostgreSQL, Redis-кэш и артефакты задач</p>
        <p v-if="audit?.storage_visibility?.note" class="text-[11px] text-gray-600 mt-1 max-w-3xl">{{ audit.storage_visibility.note }}</p>
      </div>
      <button class="btn-ghost text-xs" :disabled="loading || actionLoading" @click="load">Обновить</button>
    </div>

    <div v-if="error" class="bg-red-950/60 border border-red-800 text-red-300 text-sm px-3 py-2 rounded mb-4">{{ error }}</div>
    <div v-if="message" class="bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-sm px-3 py-2 rounded mb-4">{{ message }}</div>
    <div v-if="loading" class="text-sm text-gray-400 py-4">Сканирование storage…</div>

    <template v-else-if="audit">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <div class="bg-gray-800/40 rounded-lg p-3"><div class="text-lg font-bold text-cyan-300">{{ audit.filesystem?.filesystem?.used_human || '—' }}</div><div class="text-xs text-gray-400">Занято на filesystem</div><div class="text-[11px] text-gray-600 mt-1">Свободно: {{ audit.filesystem?.filesystem?.free_human || '—' }}</div></div>
        <div class="bg-gray-800/40 rounded-lg p-3"><div class="text-lg font-bold text-violet-300">{{ audit.database?.database_human || '—' }}</div><div class="text-xs text-gray-400">PostgreSQL database</div><div class="text-[11px] text-gray-600 mt-1">Размеры таблиц ниже</div></div>
        <div class="bg-gray-800/40 rounded-lg p-3"><div class="text-lg font-bold text-amber-300">{{ audit.redis?.used_memory_human || '—' }}</div><div class="text-xs text-gray-400">Redis memory</div><div class="text-[11px] text-gray-600 mt-1">Keys: {{ audit.redis?.dbsize ?? '—' }}</div></div>
      </div>

      <div class="overflow-x-auto mb-5">
        <h3 class="text-xs text-gray-400 uppercase tracking-wide mb-2">Известные директории</h3>
        <table class="w-full text-xs">
          <thead><tr class="border-b border-gray-800 text-left text-gray-400"><th class="py-2 px-2">Каталог</th><th class="py-2 px-2">Путь</th><th class="py-2 px-2">Размер</th><th class="py-2 px-2">Очистка</th></tr></thead>
          <tbody>
            <tr v-for="item in storagePaths" :key="item.key" class="border-b border-gray-800/50"><td class="py-2 px-2 text-gray-200">{{ item.label }}</td><td class="py-2 px-2 text-gray-500 font-mono max-w-[360px] truncate" :title="item.path">{{ item.path }}</td><td class="py-2 px-2 text-cyan-300">{{ item.human || fmtBytes(item.bytes) }}</td><td class="py-2 px-2" :class="item.cleanup ? 'text-emerald-400' : 'text-gray-600'">{{ item.cleanup ? 'разрешена по возрасту' : 'защищён' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="border border-gray-800 rounded-lg p-3 mb-5">
        <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
          <div><h3 class="text-xs text-gray-400 uppercase tracking-wide">Файлы и папки</h3><p class="text-[11px] text-gray-600 mt-1">Адресная очистка доступна только для разрешённых storage roots. Активные и недавно изменённые файлы защищены.</p></div>
          <div class="flex flex-wrap items-end gap-2">
            <label class="text-xs text-gray-400">Каталог<select v-model="inventoryRoot" class="input text-xs py-1 mt-1 block" @change="loadInventory(true)"><option v-for="root in inventoryRoots" :key="root.key" :value="root.key">{{ root.label }}{{ root.file_cleanup ? '' : ' — защищён' }}</option></select></label>
            <label class="text-xs text-gray-400">Поиск<input v-model="inventorySearch" class="input text-xs py-1 mt-1 block w-44" placeholder="имя или путь" @keyup.enter="loadInventory(true)" /></label>
            <label class="text-xs text-gray-400">Сортировка<select v-model="inventorySort" class="input text-xs py-1 mt-1 block" @change="loadInventory(true)"><option value="size">Размер</option><option value="modified_at">Дата изменения</option><option value="name">Имя</option></select></label>
            <button class="btn-ghost text-xs" :disabled="inventoryLoading" @click="loadInventory(true)">Сканировать</button>
          </div>
        </div>

        <div v-if="inventoryLoading" class="text-sm text-gray-500 py-4">Сканирую файлы…</div>
        <template v-else-if="inventory">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-xs">
            <div class="bg-gray-900/70 rounded p-2"><div class="text-cyan-300 font-semibold">{{ inventory.summary?.human || '0 B' }}</div><div class="text-gray-600">Размер root</div></div>
            <div class="bg-gray-900/70 rounded p-2"><div class="text-gray-200 font-semibold">{{ inventory.summary?.file_count ?? 0 }}</div><div class="text-gray-600">Файлов</div></div>
            <div class="bg-gray-900/70 rounded p-2"><div class="text-gray-200 font-semibold">{{ inventory.summary?.directory_count ?? 0 }}</div><div class="text-gray-600">Папок</div></div>
            <div class="bg-gray-900/70 rounded p-2"><div class="text-gray-200 font-semibold">{{ inventoryPagination.total_files ?? 0 }}</div><div class="text-gray-600">Совпадений</div></div>
          </div>
          <div v-if="inventory.summary?.truncated" class="bg-amber-950/40 border border-amber-900/60 text-amber-300 text-xs px-3 py-2 rounded mb-3">Инвентаризация ограничена лимитом {{ inventory.summary.scan_limit }} файлов. Сузьте поиск по имени/пути для точной выборки.</div>

          <div class="overflow-x-auto mb-4">
            <h4 class="text-[11px] text-gray-500 uppercase tracking-wide mb-2">Папки по занимаемому месту</h4>
            <table class="w-full text-xs"><thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 px-2">Относительный путь</th><th class="py-2 px-2">Размер</th><th class="py-2 px-2">Доля root</th><th class="py-2 px-2">Файлов</th></tr></thead><tbody><tr v-for="folder in inventoryFolders.slice(0, 25)" :key="folder.relative_path" class="border-b border-gray-800/40"><td class="py-2 px-2 text-gray-300 font-mono">{{ folder.relative_path }}</td><td class="py-2 px-2 text-cyan-300">{{ folder.human }}</td><td class="py-2 px-2 text-gray-500">{{ fmtPercent(folder.bytes, inventory.summary?.bytes) }}</td><td class="py-2 px-2 text-gray-500">{{ folder.file_count }}</td></tr><tr v-if="!inventoryFolders.length"><td colspan="4" class="py-3 text-gray-600">Папки не найдены</td></tr></tbody></table>
          </div>

          <div class="overflow-x-auto mb-4">
            <h4 class="text-[11px] text-gray-500 uppercase tracking-wide mb-2">Самые тяжёлые файлы</h4>
            <table class="w-full text-xs"><thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 px-2">#</th><th class="py-2 px-2">Файл</th><th class="py-2 px-2">Размер</th><th class="py-2 px-2">Доля root</th><th class="py-2 px-2">Изменён</th></tr></thead><tbody><tr v-for="(file, index) in inventoryLargestFiles.slice(0, 25)" :key="`largest-${file.relative_path}`" class="border-b border-gray-800/40"><td class="py-2 px-2 text-gray-600">{{ index + 1 }}</td><td class="py-2 px-2 text-gray-300 font-mono max-w-[420px] truncate" :title="file.relative_path">{{ file.relative_path }}</td><td class="py-2 px-2 text-cyan-300 whitespace-nowrap">{{ file.human }}</td><td class="py-2 px-2 text-gray-500">{{ fmtPercent(file.bytes, inventory.summary?.bytes) }}</td><td class="py-2 px-2 text-gray-500 whitespace-nowrap">{{ fmtDate(file.modified_at) }}</td></tr><tr v-if="!inventoryLargestFiles.length"><td colspan="5" class="py-3 text-gray-600">Файлы не найдены</td></tr></tbody></table>
          </div>

          <div class="overflow-x-auto">
            <h4 class="text-[11px] text-gray-500 uppercase tracking-wide mb-2">Файлы с пагинацией</h4>
            <table class="w-full text-xs"><thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="py-2 px-2">Файл</th><th class="py-2 px-2">Размер</th><th class="py-2 px-2">Изменён</th><th class="py-2 px-2">Действие</th></tr></thead><tbody><tr v-for="file in inventoryFiles" :key="file.relative_path" class="border-b border-gray-800/40"><td class="py-2 px-2 text-gray-300 font-mono max-w-[420px] truncate" :title="file.relative_path">{{ file.relative_path }}</td><td class="py-2 px-2 text-cyan-300 whitespace-nowrap">{{ file.human }}</td><td class="py-2 px-2 text-gray-500 whitespace-nowrap">{{ fmtDate(file.modified_at) }}</td><td class="py-2 px-2 whitespace-nowrap"><button v-if="file.deletable" class="text-red-400 hover:text-red-300 disabled:text-gray-700" :disabled="actionLoading" @click="deleteFile(file)">Удалить</button><span v-else class="text-gray-600" :title="file.protected_reason">Защищён</span></td></tr><tr v-if="!inventoryFiles.length"><td colspan="4" class="py-3 text-gray-600">Файлы не найдены</td></tr></tbody></table>
          </div>
          <div class="flex items-center justify-between mt-3 text-xs text-gray-500"><span>Страница {{ inventoryPagination.page || 1 }}</span><div class="flex gap-2"><button class="btn-ghost text-xs" :disabled="inventoryLoading || inventoryPage <= 1" @click="changePage(-1)">Назад</button><button class="btn-ghost text-xs" :disabled="inventoryLoading || !inventoryPagination.has_more" @click="changePage(1)">Далее</button></div></div>
        </template>
      </div>

      <div class="overflow-x-auto mb-5"><h3 class="text-xs text-gray-400 uppercase tracking-wide mb-2">Крупнейшие таблицы PostgreSQL</h3><table class="w-full text-xs"><thead><tr class="border-b border-gray-800 text-left text-gray-400"><th class="py-2 px-2">Таблица</th><th class="py-2 px-2">Размер</th></tr></thead><tbody><tr v-for="table in tables.slice(0, 12)" :key="`${table.schema}.${table.table_name}`" class="border-b border-gray-800/50"><td class="py-2 px-2 text-gray-300 font-mono">{{ table.schema }}.{{ table.table_name }}</td><td class="py-2 px-2 text-violet-300">{{ table.human || fmtBytes(table.bytes) }}</td></tr><tr v-if="!tables.length"><td colspan="2" class="py-3 text-gray-600">Нет данных о таблицах</td></tr></tbody></table></div>

      <div class="flex flex-wrap items-end gap-2 border-t border-gray-800 pt-4"><label class="text-xs text-gray-400">Scope<select v-model="scope" class="input text-xs py-1 mt-1 block"><option value="tasks">Старые task rows + artifacts</option><option value="uploads">Uploads</option><option value="backend_tmp">Backend tmp</option><option value="response_cache">Redis LLM response cache</option></select></label><label class="text-xs text-gray-400">Старше, дней<input v-model.number="olderThanDays" type="number" min="1" max="3650" class="input text-xs py-1 mt-1 block w-28" /></label><button class="btn-ghost text-xs" :disabled="actionLoading" @click="runPreview">Preview</button><button class="text-xs px-3 py-2 rounded bg-red-900/60 text-red-300 hover:bg-red-800 disabled:opacity-50" :disabled="actionLoading" @click="runCleanup">Удалить после подтверждения</button></div>

      <div v-if="preview" class="mt-3 text-xs text-gray-400 bg-gray-900/60 rounded p-3"><span class="text-gray-300">{{ preview.message || (preview.dry_run ? 'Preview' : 'Результат очистки') }}</span><pre class="mt-2 whitespace-pre-wrap text-gray-500">{{ JSON.stringify(preview.result || preview, null, 2) }}</pre></div>
      <p class="text-[11px] text-gray-600 mt-3">`brain_state` и служебные каталоги защищены. Перед удалением проверяются активные задачи, traversal-пути и недавние изменения. Preview не удаляет ни строки, ни файлы.</p>
    </template>
  </div>
</template>
