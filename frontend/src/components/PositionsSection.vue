<script setup>
/**
 * PositionsSection.vue — секция «Съём позиций» внутри страницы проекта.
 *
 * Источник данных: прокси-эндпоинты /api/projects/:id/positions/*
 * (см. backend/controllers/positionsProxy.controller.js). Эти эндпоинты
 * гарантируют связанный position_projects через positionBridge с дефолтным
 * гео из keys_so_region проекта, поэтому здесь дополнительных проверок нет.
 *
 * Props:
 *   • projectId — обязательный, id SEO-проекта (а не position_projects!).
 *   • readonly  — true в публичной (share-link) странице; скрывает кнопки
 *                 «Запустить съём» / «Добавить запросы» / «Настройки», но
 *                 показывает все агрегаты и графики.
 *   • initialData — опциональный pre-loaded payload (для share-страницы,
 *                   где данные уже пришли в getSharedProject ответе).
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import api from '../api.js';
import PositionChart from './PositionChart.vue';

const props = defineProps({
  projectId:   { type: [String, Number], required: true },
  readonly:    { type: Boolean, default: false },
  initialData: { type: Object,  default: null },
});

const BASE = computed(() => `/projects/${props.projectId}/positions`);

const overview = ref(null);          // { position_project, summary, runs, keywords_active, config }
const series = ref([]);              // series для динамики средней позиции
const topsDist = ref(null);          // { buckets, current, previous, deltas }
const keywordsTable = ref([]);
const moversUp = ref([]);
const moversDown = ref([]);
const settings = ref(null);
const loading = ref(false);
const error = ref(null);

const period = ref('week');          // 'week' | 'month'
const granularity = ref('day');      // для динамики
const engineFilter = ref(null);      // null | 'yandex' | 'google'

const newQuery = ref('');
const adding = ref(false);
const startingRun = ref(false);
const settingsSaving = ref(false);

let pollTimer = null;

const activeRun = computed(() => {
  const runs = overview.value?.runs || [];
  return runs.find((r) => r.status === 'queued' || r.status === 'processing') || null;
});
const progressPct = computed(() => {
  const r = activeRun.value;
  if (!r || !r.keywords_total) return 0;
  return Math.min(100, Math.round((r.keywords_done / r.keywords_total) * 100));
});

const summary = computed(() => overview.value?.summary || null);
const positionProject = computed(() => overview.value?.position_project || null);
const isBoth = computed(() => positionProject.value?.engine === 'both');

// Stacked-area: ряды по топ-bucket'ам в обратном порядке (top-3 снизу).
const topsBuckets = computed(() => topsDist.value?.buckets || [3, 5, 10, 20, 50, 100]);
const topsCurrent = computed(() => topsDist.value?.current || []);
const topsPrevious = computed(() => topsDist.value?.previous || []);
const topsDeltas = computed(() => topsDist.value?.deltas || []);
// Сумма «активных» (попавших в любой топ-bucket) ключей за текущий период.
const topsActiveTotal = computed(() => {
  const cur = topsCurrent.value;
  return cur.filter((b) => b.bucket != null).reduce((s, b) => s + b.count, 0);
});

async function loadAll() {
  if (props.readonly && props.initialData) return; // share-режим, данные уже в initialData
  loading.value = true;
  error.value = null;
  try {
    const params = {};
    if (engineFilter.value) params.engine = engineFilter.value;
    const periodParams = { ...params, period: period.value };
    const seriesParams = { ...params, granularity: granularity.value };
    const [ov, ser, tops, kw, mu, md] = await Promise.all([
      api.get(`${BASE.value}/overview`,         { params: periodParams }).then((r) => r.data),
      api.get(`${BASE.value}/series`,           { params: seriesParams }).then((r) => r.data),
      api.get(`${BASE.value}/tops-distribution`,{ params: periodParams }).then((r) => r.data),
      api.get(`${BASE.value}/keywords`,         { params: periodParams }).then((r) => r.data),
      api.get(`${BASE.value}/movers`,           { params: { ...periodParams, direction: 'up' } }).then((r) => r.data),
      api.get(`${BASE.value}/movers`,           { params: { ...periodParams, direction: 'down' } }).then((r) => r.data),
    ]);
    overview.value = ov;
    series.value = ser.series || [];
    topsDist.value = tops;
    keywordsTable.value = kw.keywords || [];
    moversUp.value = mu.movers || [];
    moversDown.value = md.movers || [];
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}

async function loadSettings() {
  if (props.readonly) return;
  try {
    const { data } = await api.get(`${BASE.value}/settings`);
    settings.value = data.settings;
  } catch (_) { /* nop */ }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const { data } = await api.get(`${BASE.value}/runs`);
      overview.value = { ...(overview.value || {}), runs: data.runs || [] };
      if (!activeRun.value) {
        stopPolling();
        await loadAll();
      }
    } catch (_) { /* nop */ }
  }, 3000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function startRun() {
  if (props.readonly) return;
  startingRun.value = true;
  try {
    await api.post(`${BASE.value}/runs`, {});
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await api.get(`${BASE.value}/runs`);
    overview.value = { ...(overview.value || {}), runs: data.runs || [] };
    startPolling();
  } catch (err) {
    alert(err.response?.data?.error || err.message);
  } finally { startingRun.value = false; }
}

async function addKeyword() {
  if (props.readonly) return;
  const q = newQuery.value.trim();
  if (!q) return;
  adding.value = true;
  try {
    const queries = q.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
    await api.post(`${BASE.value}/keywords`, { queries });
    newQuery.value = '';
    await loadAll();
  } catch (err) {
    alert(err.response?.data?.error || err.message);
  } finally { adding.value = false; }
}

async function removeKeyword(kwId) {
  if (props.readonly) return;
  if (!confirm('Удалить запрос и его историю?')) return;
  try {
    await api.delete(`${BASE.value}/keywords/${kwId}`);
    keywordsTable.value = keywordsTable.value.filter((k) => k.keyword_id !== kwId);
  } catch (e) { alert(e.message); }
}

async function saveSettings() {
  if (props.readonly || !settings.value) return;
  settingsSaving.value = true;
  try {
    const { data } = await api.patch(`${BASE.value}/settings`, settings.value);
    settings.value = { ...settings.value, ...(data.settings || {}) };
    await loadAll();
  } catch (err) {
    alert(err.response?.data?.error || err.message);
  } finally { settingsSaving.value = false; }
}

function changePeriod(p)  { period.value = p; loadAll(); }
function changeEngine(e)  { engineFilter.value = e; loadAll(); }
function changeGran(g)    { granularity.value = g; loadAll(); }

function fmtPosition(p) { if (p == null) return '—'; return String(Math.round(p)); }
function fmtDelta(d) {
  if (d == null) return '';
  if (d === 0) return '0';
  const arrow = d < 0 ? '▲' : '▼';
  return `${arrow} ${Math.abs(d)}`;
}
function deltaClass(d) {
  if (d == null) return 'text-gray-400';
  if (d < 0) return 'text-emerald-500 font-medium';
  if (d > 0) return 'text-red-400 font-medium';
  return 'text-gray-400';
}
function bucketColor(label) {
  const map = {
    top_3:   'bg-emerald-500',
    top_5:   'bg-emerald-400',
    top_10:  'bg-cyan-500',
    top_20:  'bg-blue-500',
    top_50:  'bg-amber-500',
    top_100: 'bg-orange-500',
    not_top: 'bg-gray-600',
  };
  return map[label] || 'bg-gray-500';
}
function bucketLabel(b) {
  if (b.bucket == null) return 'Вне ТОП-100';
  return `ТОП-${b.bucket}`;
}

const periodLabel = computed(() => period.value === 'month' ? 'за месяц' : 'за неделю');

// Применяем initialData (share-режим) сразу при mount.
function hydrateFromInitialData() {
  const d = props.initialData;
  if (!d) return;
  overview.value = {
    position_project: { engine: d.settings?.engine, device: d.settings?.device,
                        geo_lr: d.settings?.geo_lr, geo_loc: d.settings?.geo_loc },
    summary: d.summary,
    runs: d.last_run ? [d.last_run] : [],
    keywords_active: (d.summary?.keywords_total) || (d.keywords_table?.length) || 0,
    config: { topsBuckets: d.tops_distribution?.buckets || [3,5,10,20,50,100] },
  };
  series.value = d.series || [];
  topsDist.value = d.tops_distribution || null;
  keywordsTable.value = d.keywords_table || [];
}

watch(() => props.initialData, hydrateFromInitialData);

onMounted(async () => {
  if (props.readonly) {
    hydrateFromInitialData();
    return;
  }
  await loadAll();
  await loadSettings();
  if (activeRun.value) startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <section class="space-y-5">
    <!-- Шапка + кнопка запуска -->
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-300">
          📈 Съём позиций
        </h2>
        <p class="text-xs text-gray-500 mt-1">
          <template v-if="positionProject">
            {{ positionProject.engine === 'both' ? 'Яндекс + Google'
               : positionProject.engine === 'google' ? 'Google' : 'Яндекс' }}
            <span v-if="positionProject.device === 'mobile'"> · Mobile</span>
            <span v-else> · Desktop</span>
            <span v-if="positionProject.geo_lr"> · lr={{ positionProject.geo_lr }}</span>
            <span v-if="positionProject.geo_loc"> · {{ positionProject.geo_loc }}</span>
            <span v-if="overview?.keywords_active != null"> · {{ overview.keywords_active }} запр.</span>
          </template>
          <template v-else>—</template>
        </p>
      </div>
      <div v-if="!readonly" class="text-right">
        <button class="btn-primary" :disabled="!!activeRun || startingRun" @click="startRun">
          {{ activeRun ? 'Идёт съём…' : startingRun ? 'Запускаем…' : 'Снять позиции сейчас' }}
        </button>
        <div v-if="activeRun" class="mt-2 text-xs text-gray-400">
          {{ activeRun.keywords_done }}/{{ activeRun.keywords_total }}
          <div class="h-1 bg-gray-700 rounded mt-1 overflow-hidden">
            <div class="h-full bg-emerald-500 transition-all" :style="{ width: progressPct + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
      {{ error }}
    </div>

    <!-- Фильтры периода + поисковика -->
    <div v-if="!readonly || summary" class="flex items-center gap-2 text-sm flex-wrap">
      <span class="text-gray-500">Период:</span>
      <button :class="['px-3 py-1 rounded border text-xs',
                       period === 'week' ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200'
                                         : 'border-gray-700 text-gray-400 hover:text-gray-200']"
              @click="changePeriod('week')">Неделя</button>
      <button :class="['px-3 py-1 rounded border text-xs',
                       period === 'month' ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200'
                                          : 'border-gray-700 text-gray-400 hover:text-gray-200']"
              @click="changePeriod('month')">Месяц</button>
      <template v-if="isBoth">
        <span class="text-gray-400 ml-3">|</span>
        <span class="text-gray-500">Поисковик:</span>
        <button v-for="opt in [{k:null,l:'Все'},{k:'yandex',l:'Яндекс'},{k:'google',l:'Google'}]" :key="opt.l"
                :class="['px-3 py-1 rounded border text-xs',
                         engineFilter === opt.k ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200'
                                                : 'border-gray-700 text-gray-400 hover:text-gray-200']"
                @click="changeEngine(opt.k)">{{ opt.l }}</button>
      </template>
    </div>

    <!-- Сводка KPI -->
    <div v-if="summary" class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="card !p-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">Средняя позиция</div>
        <div class="text-2xl font-semibold mt-1">{{ summary.avg_position == null ? '—' : summary.avg_position }}</div>
        <div v-if="summary.avg_position_prev != null && summary.avg_position != null"
             :class="deltaClass(+(summary.avg_position - summary.avg_position_prev).toFixed(2))"
             class="text-xs mt-1">
          {{ fmtDelta(+(summary.avg_position - summary.avg_position_prev).toFixed(2)) }} {{ periodLabel }}
        </div>
      </div>
      <div class="card !p-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">ТОП-3</div>
        <div class="text-2xl font-semibold mt-1">{{ summary.top3 }} <span class="text-xs text-gray-500">/ {{ summary.keywords_total }}</span></div>
        <div class="text-xs mt-1" :class="deltaClass(summary.top3_prev - summary.top3)">
          {{ summary.top3 - summary.top3_prev > 0 ? '+' : '' }}{{ summary.top3 - summary.top3_prev }} {{ periodLabel }}
        </div>
      </div>
      <div class="card !p-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">ТОП-10</div>
        <div class="text-2xl font-semibold mt-1">{{ summary.top10 }} <span class="text-xs text-gray-500">/ {{ summary.keywords_total }}</span></div>
        <div class="text-xs mt-1" :class="deltaClass(summary.top10_prev - summary.top10)">
          {{ summary.top10 - summary.top10_prev > 0 ? '+' : '' }}{{ summary.top10 - summary.top10_prev }} {{ periodLabel }}
        </div>
      </div>
      <div class="card !p-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">ТОП-30</div>
        <div class="text-2xl font-semibold mt-1">{{ summary.top30 }} <span class="text-xs text-gray-500">/ {{ summary.keywords_total }}</span></div>
        <div class="text-xs mt-1" :class="deltaClass(summary.top30_prev - summary.top30)">
          {{ summary.top30 - summary.top30_prev > 0 ? '+' : '' }}{{ summary.top30 - summary.top30_prev }} {{ periodLabel }}
        </div>
      </div>
      <div class="card !p-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">Динамика</div>
        <div class="text-sm font-medium mt-2 space-x-2">
          <span class="text-emerald-500">▲ {{ summary.up }}</span>
          <span class="text-red-400">▼ {{ summary.down }}</span>
          <span class="text-gray-500">= {{ summary.flat }}</span>
        </div>
        <div class="text-xs text-gray-500 mt-1">{{ periodLabel }}</div>
      </div>
    </div>

    <!-- График по топам (stacked bars: ТОП-3 / 5 / 10 / 20 / 50 / 100 / Вне) -->
    <section v-if="topsDist" class="card space-y-3">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 class="text-sm font-semibold text-emerald-300">График по топам</h3>
          <p class="text-xs text-gray-500 mt-0.5">
            Распределение {{ topsDist.total_keywords }} запросов по топам · сравнение с предыдущим равным периодом.
          </p>
        </div>
        <div class="text-xs text-gray-400">
          Активных в ТОП-100: <span class="text-emerald-300 font-semibold">{{ topsActiveTotal }}</span>
        </div>
      </div>
      <!-- Stacked horizontal bar (current vs previous) -->
      <div class="space-y-2">
        <div v-for="(bucket, idx) in topsCurrent" :key="bucket.label" class="flex items-center gap-3 text-xs">
          <div class="w-20 text-gray-300">{{ bucketLabel(bucket) }}</div>
          <div class="flex-1 h-5 bg-gray-800 rounded overflow-hidden relative">
            <div :class="['h-full', bucketColor(bucket.label)]"
                 :style="{ width: ((bucket.count / Math.max(1, topsDist.total_keywords)) * 100) + '%' }"></div>
          </div>
          <div class="w-12 text-right tabular-nums text-gray-200">{{ bucket.count }}</div>
          <div class="w-16 text-right text-xs"
               :class="deltaClass(-(topsDeltas[idx]?.delta || 0))">
            <template v-if="topsDeltas[idx]?.delta">
              {{ topsDeltas[idx].delta > 0 ? '+' : '' }}{{ topsDeltas[idx].delta }}
            </template>
            <template v-else>—</template>
          </div>
        </div>
      </div>
    </section>

    <!-- Динамика средней позиции -->
    <section v-if="series && series.length" class="card space-y-3">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <h3 class="text-sm font-semibold text-emerald-300">Динамика средней позиции</h3>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-500">Гранулярность:</span>
          <button v-for="g in ['day','week','month']" :key="g"
                  :class="['px-2 py-1 rounded border',
                           granularity === g ? 'border-emerald-500/60 text-emerald-300'
                                             : 'border-gray-700 text-gray-400 hover:text-gray-200']"
                  @click="changeGran(g)">{{ g === 'day' ? 'День' : g === 'week' ? 'Неделя' : 'Месяц' }}</button>
        </div>
      </div>
      <PositionChart :series="series" mode="position" :height="280" />
    </section>

    <!-- Движения -->
    <section v-if="moversUp.length || moversDown.length" class="grid md:grid-cols-2 gap-4">
      <div class="card">
        <h3 class="text-sm font-semibold text-emerald-300 mb-2">▲ Рост {{ periodLabel }}</h3>
        <table class="w-full text-xs">
          <tbody>
            <tr v-for="m in moversUp.slice(0, 10)" :key="m.keyword_id" class="border-t border-gray-800">
              <td class="py-1.5 pr-2 truncate max-w-[260px]" :title="m.query">{{ m.query }}</td>
              <td class="py-1.5 text-right tabular-nums text-gray-300">{{ fmtPosition(m.prev_position) }} → {{ fmtPosition(m.position) }}</td>
              <td class="py-1.5 text-right pl-2 text-emerald-400 font-medium">{{ fmtDelta(m.delta) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!moversUp.length" class="text-xs text-gray-500">Нет движений вверх за период.</p>
      </div>
      <div class="card">
        <h3 class="text-sm font-semibold text-red-300 mb-2">▼ Падение {{ periodLabel }}</h3>
        <table class="w-full text-xs">
          <tbody>
            <tr v-for="m in moversDown.slice(0, 10)" :key="m.keyword_id" class="border-t border-gray-800">
              <td class="py-1.5 pr-2 truncate max-w-[260px]" :title="m.query">{{ m.query }}</td>
              <td class="py-1.5 text-right tabular-nums text-gray-300">{{ fmtPosition(m.prev_position) }} → {{ fmtPosition(m.position) }}</td>
              <td class="py-1.5 text-right pl-2 text-red-400 font-medium">{{ fmtDelta(m.delta) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!moversDown.length" class="text-xs text-gray-500">Нет падений за период.</p>
      </div>
    </section>

    <!-- Таблица запросов -->
    <section v-if="keywordsTable.length" class="card">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold text-emerald-300">Запросы</h3>
        <span class="text-xs text-gray-500">{{ keywordsTable.length }} шт.</span>
      </div>
      <div class="max-h-[480px] overflow-y-auto -mx-3">
        <table class="w-full text-xs">
          <thead class="text-gray-400">
            <tr class="border-b border-gray-800">
              <th class="text-left py-2 px-3">Запрос</th>
              <th class="text-right py-2 px-3">Поз.</th>
              <th class="text-right py-2 px-3">Было</th>
              <th class="text-right py-2 px-3">Δ</th>
              <th v-if="!readonly" class="py-2 px-3"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="k in keywordsTable" :key="k.keyword_id || k.query" class="border-b border-gray-800/60 hover:bg-gray-800/30">
              <td class="py-1.5 px-3 max-w-[420px]">
                <div class="truncate" :title="k.query">{{ k.query }}</div>
                <a v-if="k.found_url" :href="k.found_url" target="_blank" rel="noopener noreferrer"
                   class="block truncate text-[10px] text-gray-500 hover:text-emerald-400">{{ k.found_url }}</a>
              </td>
              <td class="text-right py-1.5 px-3 tabular-nums">{{ fmtPosition(k.position) }}</td>
              <td class="text-right py-1.5 px-3 tabular-nums text-gray-500">{{ fmtPosition(k.prev_position) }}</td>
              <td class="text-right py-1.5 px-3" :class="deltaClass(k.delta)">{{ fmtDelta(k.delta) }}</td>
              <td v-if="!readonly" class="py-1.5 px-3 text-right">
                <button class="text-xs text-red-400 hover:text-red-300" @click="removeKeyword(k.keyword_id)">✕</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Добавление запросов -->
    <section v-if="!readonly" class="card space-y-2">
      <h3 class="text-sm font-semibold text-emerald-300">Добавить запросы</h3>
      <textarea v-model="newQuery" rows="3"
                placeholder="По одному в строке или через ;"
                class="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm"></textarea>
      <button class="btn-primary" :disabled="!newQuery.trim() || adding" @click="addKeyword">
        {{ adding ? 'Добавляем…' : 'Добавить' }}
      </button>
    </section>

    <!-- Настройки гео/движка/расписания -->
    <section v-if="!readonly && settings" class="card space-y-3">
      <h3 class="text-sm font-semibold text-emerald-300">Настройки съёма</h3>
      <div class="grid md:grid-cols-2 gap-3 text-xs">
        <label class="block">
          <span class="text-gray-400">Поисковик</span>
          <select v-model="settings.engine" class="mt-1 w-full bg-gray-900 border border-gray-700 rounded p-2">
            <option value="both">Яндекс + Google</option>
            <option value="yandex">Только Яндекс</option>
            <option value="google">Только Google</option>
          </select>
        </label>
        <label class="block">
          <span class="text-gray-400">Устройство</span>
          <select v-model="settings.device" class="mt-1 w-full bg-gray-900 border border-gray-700 rounded p-2">
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
        </label>
        <label class="block">
          <span class="text-gray-400">Расписание</span>
          <select v-model="settings.schedule" class="mt-1 w-full bg-gray-900 border border-gray-700 rounded p-2">
            <option value="manual">Вручную</option>
            <option value="daily">Каждый день</option>
            <option value="weekly">Каждую неделю</option>
          </select>
        </label>
        <label class="block">
          <span class="text-gray-400">Регион Яндекса (lr)</span>
          <input v-model="settings.geo_lr" type="text" inputmode="numeric" placeholder="213"
                 class="mt-1 w-full bg-gray-900 border border-gray-700 rounded p-2" />
        </label>
        <label class="block md:col-span-2">
          <span class="text-gray-400">Google Location (loc) — «City,Region,Country»</span>
          <input v-model="settings.geo_loc" type="text" placeholder="Moscow,Moscow,Russia"
                 class="mt-1 w-full bg-gray-900 border border-gray-700 rounded p-2" />
        </label>
        <label class="block md:col-span-2 flex items-center gap-2">
          <input v-model="settings.share_includes_positions" type="checkbox" class="rounded" />
          <span class="text-gray-300">Показывать секцию позиций в публичной ссылке</span>
        </label>
      </div>
      <button class="btn-primary" :disabled="settingsSaving" @click="saveSettings">
        {{ settingsSaving ? 'Сохраняем…' : 'Сохранить настройки' }}
      </button>
    </section>

    <p v-if="!summary && !loading && !error" class="text-xs text-gray-500">
      Позиции ещё не снимались — добавьте запросы и нажмите «Снять позиции сейчас».
    </p>
  </section>
</template>
