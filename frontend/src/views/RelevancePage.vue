<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ProjectPicker from '../components/ProjectPicker.vue';
import { useRelevanceStore } from '../stores/relevance.js';
import { YANDEX_REGIONS, findRegionByCode } from '../data/yandexRegions.js';

const router = useRouter();
const store  = useRelevanceStore();

const form = ref({
  query: '',
  lr:    '213',
  our_url: '',
  exclude_aggregators: false,
});

// ── Region picker (комбобокс с поиском) ──────────────────────────────────
const regionQuery   = ref('');         // строка поиска в поле
const regionDropdown = ref(false);     // открыт ли список
const regionInputRef = ref(null);

const filteredRegions = computed(() => {
  const q = regionQuery.value.trim().toLowerCase();
  if (!q) return YANDEX_REGIONS.slice(0, 200); // show first 200
  const out = [];
  for (const r of YANDEX_REGIONS) {
    if (r.name.toLowerCase().includes(q) || String(r.code).includes(q)) {
      out.push(r);
      if (out.length >= 200) break;
    }
  }
  return out;
});

const currentRegionLabel = computed(() => {
  const r = findRegionByCode(form.value.lr);
  return r ? `${r.name} (lr=${r.code})` : `lr=${form.value.lr}`;
});

function pickRegion(region) {
  form.value.lr = String(region.code);
  regionQuery.value = '';
  regionDropdown.value = false;
}

function regionGroupColor(group) {
  switch (group) {
    case 'Округ':     return 'text-amber-300';
    case 'Область':   return 'text-sky-300';
    case 'Республика':return 'text-emerald-300';
    case 'Край':      return 'text-fuchsia-300';
    case 'Город':     return 'text-gray-300';
    default:          return 'text-gray-400';
  }
}

const submitting = ref(false);
const formError  = ref(null);

// ── ProjectPicker (ТЗ §5/§8) ─────────────────────────────────────────
const PROJECT_ID_LS_KEY = 'relevance_project_id_v1';
const selectedProjectId = ref(null);
const selectedProject   = ref(null);
function handleProjectSelected(project) {
  selectedProject.value = project || null;
  try {
    if (selectedProjectId.value) localStorage.setItem(PROJECT_ID_LS_KEY, String(selectedProjectId.value));
    else localStorage.removeItem(PROJECT_ID_LS_KEY);
  } catch (_) { /* ignore */ }
}
function handleProjectFull(ctx) {
  if (!ctx) return;
  if (!(form.value.our_url || '').trim() && ctx.project?.site_url) {
    form.value.our_url = ctx.project.site_url;
  }
}

const STORAGE_KEY = 'relevance_draft_v1';
onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
  try {
    const pid = localStorage.getItem(PROJECT_ID_LS_KEY);
    if (pid) {
      const n = Number(pid);
      selectedProjectId.value = Number.isInteger(n) && n > 0 ? n : pid;
    }
  } catch (_) { /* ignore */ }
});
function saveDraft() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

// Закрываем дропдаун по клику снаружи
function handleDocClick(e) {
  if (!regionInputRef.value) return;
  const root = regionInputRef.value.closest('[data-region-picker]');
  if (root && !root.contains(e.target)) {
    regionDropdown.value = false;
  }
}
onMounted(() => { document.addEventListener('click', handleDocClick); });
onUnmounted(() => { document.removeEventListener('click', handleDocClick); });

async function handleCreate() {
  formError.value = null;
  if (!form.value.query.trim()) {
    formError.value = 'Введите ключевой запрос.';
    return;
  }
  submitting.value = true;
  try {
    saveDraft();
    const id = await store.createReport({
      query: form.value.query.trim(),
      lr:    form.value.lr.trim() || '213',
      our_url: (form.value.our_url || '').trim() || null,
      exclude_aggregators: !!form.value.exclude_aggregators,
      project_id: selectedProjectId.value || null,
    });
    await store.fetchReports();
    if (id) router.push(`/relevance/${id}`);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания отчёта';
  } finally {
    submitting.value = false;
  }
}

let pollTimer = null;
onMounted(async () => {
  await store.fetchReports();
  pollTimer = setInterval(() => {
    if (store.reports.some((r) => ['pending', 'fetching', 'analyzing'].includes(r.status))) {
      store.fetchReports();
    }
  }, 3000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

async function handleDelete(report) {
  if (!confirm(`Удалить отчёт «${report.query}»?`)) return;
  try { await store.deleteReport(report.id); }
  catch (err) { alert(err.response?.data?.error || 'Ошибка удаления'); }
}

function statusBadgeClass(status) {
  switch (status) {
    case 'done':      return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'analyzing': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'fetching':  return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'pending':   return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':     return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:          return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(status) {
  return ({
    done:      'Готово',
    analyzing: 'Анализ',
    fetching:  'Сбор данных',
    pending:   'Ожидает',
    error:     'Ошибка',
  })[status] || status;
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? `${s.toFixed(1)}с` : `${Math.round(s / 60)}м ${Math.round(s % 60)}с`;
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-8">
      <!-- Шапка -->
      <div class="flex items-end justify-between border-b border-gray-800 pb-4">
        <div>
          <h1 class="text-2xl font-bold text-white flex items-center gap-2">
            📊 Анализ релевантности
            <span class="text-xs font-medium text-indigo-400 bg-indigo-950/40 border border-indigo-900 px-2 py-0.5 rounded">MVP · BM25 + n-граммы</span>
          </h1>
          <p class="text-gray-400 text-sm mt-1">
            Сбор ТОП-20 Яндекса (XMLStock), парсинг страниц, расчёт BM25-словаря и n-грамм.
            <span class="text-gray-500">Готовый ТЗ для копирайтера в виде таблиц + графиков.</span>
          </p>
        </div>
      </div>

      <!-- ── Форма ── -->
      <form @submit.prevent="handleCreate" class="card space-y-5">
        <div class="flex items-center gap-2 mb-1">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новый отчёт</h2>
        </div>

        <!-- ── ProjectPicker (ТЗ §5/§8) ── -->
        <div>
          <ProjectPicker
            v-model="selectedProjectId"
            @context="handleProjectSelected"
            @fullContext="handleProjectFull"
            label="Проект (необязательно)"
            placeholder="— Без проекта —"
          />
          <p v-if="selectedProject" class="mt-1 text-[11px] text-emerald-300">
            📂 Контекст проекта «{{ selectedProject.name }}» подтянется в отчёт.
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="md:col-span-2">
            <label class="label">Ключевой запрос</label>
            <input v-model="form.query" type="text" class="input"
                   placeholder="Например: купить керамическую плитку" />
          </div>
          <div data-region-picker class="relative">
            <label class="label">Регион Яндекса (lr)</label>
            <button type="button"
                    @click="regionDropdown = !regionDropdown"
                    class="input text-left flex items-center justify-between gap-2 w-full">
              <span class="truncate">{{ currentRegionLabel }}</span>
              <span class="text-xs text-gray-500">{{ regionDropdown ? '▲' : '▼' }}</span>
            </button>
            <div v-if="regionDropdown"
                 class="absolute z-20 mt-1 w-full bg-gray-900 border border-gray-700 rounded shadow-xl">
              <input ref="regionInputRef"
                     v-model="regionQuery"
                     type="text"
                     class="w-full bg-gray-950 border-b border-gray-800 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-700"
                     placeholder="🔎 Поиск региона по названию или коду…"
                     @click.stop />
              <ul class="max-h-72 overflow-y-auto text-xs">
                <li v-if="filteredRegions.length === 0"
                    class="px-3 py-2 text-gray-500">Ничего не найдено</li>
                <li v-for="r in filteredRegions" :key="r.code"
                    @click="pickRegion(r)"
                    :class="['px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2 hover:bg-indigo-900/30',
                             String(form.lr) === String(r.code) ? 'bg-indigo-900/40' : '']">
                  <span class="truncate">
                    <span :class="regionGroupColor(r.group)" class="text-[10px] uppercase tracking-wider mr-1.5">{{ r.group }}</span>
                    <span class="text-gray-100">{{ r.name }}</span>
                  </span>
                  <span class="text-gray-500 tabular-nums flex-shrink-0">lr={{ r.code }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- PR3: «наш сайт vs ТОП» — необязательное сравнение -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
          <div class="md:col-span-2">
            <label class="label flex items-center gap-2">
              <span>URL вашей страницы для сравнения</span>
              <span class="text-[10px] text-gray-500 font-normal normal-case">(необязательно)</span>
            </label>
            <input v-model="form.our_url" type="url" class="input"
                   placeholder="https://example.ru/page-to-compare" />
            <p class="text-[11px] text-gray-500 mt-1">
              Если задан — мы скачаем эту страницу тем же парсером и посчитаем
              сравнение с ТОПом: % покрытия LSI-ключей, BM25, TF-IDF cosine,
              математические директивы для копирайтера.
            </p>
          </div>
          <div class="flex items-start pt-7">
            <label class="inline-flex items-start gap-2 cursor-pointer text-sm text-gray-300 select-none">
              <input v-model="form.exclude_aggregators" type="checkbox"
                     class="mt-0.5 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-700" />
              <span>
                Исключить агрегаторы и крупные площадки
                <span class="block text-[11px] text-gray-500">
                  Avito / hh / Ozon / WB / Dzen / vc / habr / pikabu / 2gis…
                </span>
              </span>
            </label>
          </div>
        </div>

        <div v-if="formError"
             class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
          {{ formError }}
        </div>

        <div class="flex items-center gap-3 pt-2">
          <button type="submit" class="btn-primary" :disabled="submitting">
            {{ submitting ? '⏳ Запуск...' : '🚀 Сгенерировать отчёт' }}
          </button>
          <span class="text-xs text-gray-500">
            Длительность: 30–90 секунд (зависит от скорости ответа сайтов из ТОП-20).
          </span>
        </div>
      </form>

      <!-- ── Список отчётов ── -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-bold text-gray-200 uppercase tracking-wider">📚 Мои отчёты</h2>
          <button @click="store.fetchReports()" class="btn-ghost text-xs">↻ Обновить</button>
        </div>

        <div v-if="store.loading && store.reports.length === 0" class="text-gray-500 text-sm py-6 text-center">
          Загрузка...
        </div>
        <div v-else-if="store.reports.length === 0" class="card text-center py-10 text-gray-500 text-sm">
          У вас пока нет отчётов. Создайте первый — форма выше.
        </div>

        <div v-else class="space-y-2">
          <div v-for="r in store.reports" :key="r.id"
               class="card flex items-center gap-4 py-3 px-4 hover:border-indigo-700 transition-colors">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span :class="['badge', statusBadgeClass(r.status)]">{{ statusLabel(r.status) }}</span>
                <button @click="router.push(`/relevance/${r.id}`)"
                        class="text-white font-semibold text-sm truncate hover:text-indigo-300 text-left">
                  {{ r.query }}
                </button>
                <span class="text-[10px] text-gray-500">lr={{ r.lr }}</span>
              </div>
              <div class="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <span>📅 {{ formatDate(r.created_at) }}</span>
                <span v-if="r.serp_count != null">🔗 {{ r.fetched_count }}/{{ r.serp_count }} страниц</span>
                <span v-if="r.failed_count > 0" class="text-amber-400">⚠ битых: {{ r.failed_count }}</span>
                <span v-if="r.duration_ms">⏱ {{ formatDuration(r.duration_ms) }}</span>
                <span v-if="r.current_stage && r.status !== 'done' && r.status !== 'error'"
                      class="text-sky-300">⚙ {{ r.current_stage }}</span>
                <span v-if="r.error_message" class="text-red-400 truncate" :title="r.error_message">
                  ⚠ {{ r.error_message }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <button @click="router.push(`/relevance/${r.id}`)" class="btn-secondary text-xs">
                Открыть
              </button>
              <button @click="handleDelete(r)"
                      class="btn-ghost text-xs text-red-400 hover:text-red-300"
                      :disabled="['pending','fetching','analyzing'].includes(r.status)"
                      :title="['pending','fetching','analyzing'].includes(r.status) ? 'Дождитесь завершения' : 'Удалить'">
                🗑
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
