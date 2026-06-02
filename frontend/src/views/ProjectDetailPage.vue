<script setup>
/**
 * ProjectDetailPage — дашборд проекта:
 *   • подключение Google Search Console (OAuth) + выбор домена;
 *   • график эффективности GSC (4 метрики) + фильтр периода;
 *   • AI-аналитика DeepSeek («Анализировать показатели проекта») с поллингом;
 *   • публичная ссылка «Поделиться доступом».
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import GscPerformanceChart from '../components/GscPerformanceChart.vue';
import MarkdownView from '../components/MarkdownView.vue';
import CommercialInsights from '../components/CommercialInsights.vue';
import { useProjectsStore } from '../stores/projects.js';

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();

const projectId = route.params.id;
const project = ref(null);
const analyses = ref([]);
const gscConfigured = ref(false);
const datePresets = ref([]);
const loading = ref(true);
const toast = ref('');
let toastTimer = null;

// GSC site select
const sites = ref([]);
const selectedSite = ref('');
const sitesLoading = ref(false);

// Performance
const range = ref({ key: '28d', from: '', to: '' });
const perf = ref(null);
const perfLoading = ref(false);
const perfError = ref('');

// Analysis
const currentAnalysis = ref(null);
const analyzing = ref(false);
let analysisTimer = null;

function flash(msg) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 3000);
}

const gscReady = computed(() => project.value?.gsc_connected && project.value?.gsc_site_url);

// Коммерческий срез из снапшота последнего/открытого анализа.
const commercialData = computed(() => currentAnalysis.value?.gsc_snapshot?.commercial || null);

async function load() {
  loading.value = true;
  try {
    const data = await store.getProject(projectId);
    project.value = data.project;
    analyses.value = data.analyses || [];
    gscConfigured.value = !!data.gsc_configured;
    datePresets.value = data.date_presets || [];
    if (project.value.gsc_connected && !project.value.gsc_site_url) {
      await loadSites();
    }
    if (gscReady.value) {
      await loadPerformance();
      await loadLatestAnalysis();
    }
  } catch (err) {
    flash(err.response?.data?.error || 'Ошибка загрузки проекта');
  } finally {
    loading.value = false;
  }
}

async function loadSites() {
  sitesLoading.value = true;
  try {
    const data = await store.getGscSites(projectId);
    sites.value = data.sites || [];
    selectedSite.value = data.selected || (sites.value[0]?.siteUrl || '');
  } catch (_) { /* no-op */ } finally {
    sitesLoading.value = false;
  }
}

async function connectGsc() {
  try {
    const url = await store.getGscAuthUrl(projectId);
    if (url) window.location.href = url;
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось начать авторизацию Google');
  }
}

async function chooseSite() {
  if (!selectedSite.value) return;
  try {
    project.value = await store.selectGscSite(projectId, selectedSite.value);
    flash('Домен привязан к проекту');
    await loadPerformance();
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось выбрать домен');
  }
}

async function disconnect() {
  if (!confirm('Отключить Google Search Console от проекта?')) return;
  try {
    await store.disconnectGsc(projectId);
    await load();
  } catch (_) { /* no-op */ }
}

function rangeParams() {
  if (range.value.key === 'custom' && range.value.from && range.value.to) {
    return { from: range.value.from, to: range.value.to };
  }
  return { range: range.value.key };
}

async function loadPerformance() {
  perfLoading.value = true;
  perfError.value = '';
  try {
    perf.value = await store.getPerformance(projectId, rangeParams());
  } catch (err) {
    perfError.value = err.response?.data?.error || 'Не удалось получить данные GSC';
  } finally {
    perfLoading.value = false;
  }
}

function setPreset(key) {
  range.value.key = key;
  if (key !== 'custom') loadPerformance();
}

function applyCustom() {
  if (range.value.from && range.value.to) {
    range.value.key = 'custom';
    loadPerformance();
  }
}

// ── AI-аналитика ──────────────────────────────────────────────────
async function runAnalysis() {
  analyzing.value = true;
  currentAnalysis.value = null;
  try {
    const body = range.value.key === 'custom' && range.value.from && range.value.to
      ? { from: range.value.from, to: range.value.to }
      : { range: range.value.key };
    const a = await store.startAnalysis(projectId, body);
    currentAnalysis.value = a;
    pollAnalysis(a.id);
  } catch (err) {
    analyzing.value = false;
    flash(err.response?.data?.error || 'Не удалось запустить анализ');
  }
}

function pollAnalysis(aid) {
  if (analysisTimer) clearTimeout(analysisTimer);
  const tick = async () => {
    try {
      const a = await store.getAnalysis(projectId, aid);
      currentAnalysis.value = a;
      if (a.status === 'done' || a.status === 'error') {
        analyzing.value = false;
        await refreshAnalysesList();
        return;
      }
    } catch (_) { /* keep polling */ }
    analysisTimer = setTimeout(tick, 3000);
  };
  analysisTimer = setTimeout(tick, 3000);
}

async function refreshAnalysesList() {
  try { analyses.value = await store.listAnalyses(projectId); } catch (_) { /* no-op */ }
}

async function loadLatestAnalysis() {
  await refreshAnalysesList();
  const done = analyses.value.find((a) => a.status === 'done');
  if (done) {
    try { currentAnalysis.value = await store.getAnalysis(projectId, done.id); } catch (_) { /* no-op */ }
  }
}

async function openAnalysis(a) {
  try {
    currentAnalysis.value = await store.getAnalysis(projectId, a.id);
    if (a.status === 'running' || a.status === 'queued') { analyzing.value = true; pollAnalysis(a.id); }
  } catch (_) { /* no-op */ }
}

// ── Шаринг ────────────────────────────────────────────────────────
const shareUrl = computed(() => project.value?.share_token
  ? `${window.location.origin}/share/project/${project.value.share_token}` : '');

async function createShare() {
  try {
    const token = await store.createShare(projectId);
    if (token) { project.value.share_token = token; flash('Публичная ссылка создана'); }
  } catch (_) { flash('Не удалось создать ссылку'); }
}
async function revokeShare() {
  try { await store.revokeShare(projectId); project.value.share_token = null; flash('Ссылка отозвана'); }
  catch (_) { /* no-op */ }
}
async function copyShare() {
  if (!shareUrl.value) return;
  try { await navigator.clipboard.writeText(shareUrl.value); flash('Ссылка скопирована!'); }
  catch (_) { flash('Не удалось скопировать'); }
}

onMounted(() => {
  // Обработка возврата с OAuth.
  if (route.query.gsc === 'connected') flash('Google Search Console подключён ✓');
  else if (route.query.gsc === 'error') flash('Ошибка подключения GSC: ' + (route.query.reason || ''));
  if (route.query.gsc) router.replace({ path: route.path });
  load();
});
onUnmounted(() => {
  if (analysisTimer) clearTimeout(analysisTimer);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <AppLayout>
    <div class="max-w-6xl mx-auto space-y-5">
      <button class="text-xs text-gray-500 hover:text-gray-300" @click="router.push('/projects')">← К проектам</button>

      <!-- Skeleton всей страницы -->
      <div v-if="loading" class="space-y-4">
        <div class="card h-20 animate-pulse bg-gray-900/60"></div>
        <div class="card h-80 animate-pulse bg-gray-900/60"></div>
      </div>

      <template v-else-if="project">
        <header class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-2xl font-bold text-gray-100 truncate">{{ project.name }}</h1>
            <a :href="project.url" target="_blank" rel="noopener" class="text-sm text-indigo-400 hover:underline">{{ project.url }}</a>
          </div>
        </header>

        <!-- GSC connect block -->
        <section class="card space-y-3">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Google Search Console</h2>

          <div v-if="!gscConfigured" class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
            Интеграция Google не настроена на сервере (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI).
            Подключение будет доступно после настройки.
          </div>

          <div v-if="!project.gsc_connected">
            <button class="btn-primary" :disabled="!gscConfigured" @click="connectGsc">
              🔗 Подключить Google Search Console
            </button>
          </div>

          <div v-else-if="!project.gsc_site_url" class="space-y-2">
            <p class="text-sm text-gray-300">Аккаунт подключён. Выберите подтверждённый домен:</p>
            <div class="flex gap-2 items-center">
              <select v-model="selectedSite" class="input max-w-md" :disabled="sitesLoading">
                <option v-for="s in sites" :key="s.siteUrl" :value="s.siteUrl">{{ s.siteUrl }}</option>
              </select>
              <button class="btn-primary" :disabled="!selectedSite" @click="chooseSite">Привязать</button>
            </div>
            <p v-if="!sites.length && !sitesLoading" class="text-xs text-gray-500">Нет подтверждённых сайтов в этом аккаунте GSC.</p>
          </div>

          <div v-else class="flex items-center justify-between">
            <span class="text-sm text-emerald-300">✓ Привязан домен: <b>{{ project.gsc_site_url }}</b></span>
            <button class="text-xs text-red-400 hover:text-red-300" @click="disconnect">Отключить</button>
          </div>
        </section>

        <!-- Дашборд -->
        <section v-if="gscReady" class="card space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">График эффективности</h2>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="p in datePresets" :key="p.key" type="button"
                      class="text-xs px-2.5 py-1 rounded border transition-colors"
                      :class="range.key === p.key ? 'border-indigo-500 text-indigo-200 bg-indigo-500/10' : 'border-gray-700 text-gray-400 hover:text-gray-200'"
                      @click="setPreset(p.key)">{{ p.label }}</button>
              <div class="flex items-center gap-1">
                <input type="date" v-model="range.from" class="input !py-1 text-xs" />
                <span class="text-gray-600 text-xs">—</span>
                <input type="date" v-model="range.to" class="input !py-1 text-xs" />
                <button class="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:text-white" @click="applyCustom">OK</button>
              </div>
            </div>
          </div>

          <!-- Totals -->
          <div v-if="perf && !perfLoading" class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] uppercase text-gray-500">Клики</div>
              <div class="text-xl font-bold text-indigo-300">{{ perf.totals.clicks.toLocaleString('ru') }}</div>
            </div>
            <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] uppercase text-gray-500">Показы</div>
              <div class="text-xl font-bold text-violet-300">{{ perf.totals.impressions.toLocaleString('ru') }}</div>
            </div>
            <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] uppercase text-gray-500">CTR</div>
              <div class="text-xl font-bold text-emerald-300">{{ perf.totals.ctr }}%</div>
            </div>
            <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] uppercase text-gray-500">Ср. позиция</div>
              <div class="text-xl font-bold text-amber-300">{{ perf.totals.position }}</div>
            </div>
          </div>

          <!-- Chart / skeleton -->
          <div v-if="perfLoading" class="h-80 animate-pulse bg-gray-900/60 rounded-lg"></div>
          <div v-else-if="perfError" class="text-sm text-red-400">{{ perfError }}</div>
          <GscPerformanceChart v-else-if="perf && perf.series.length" :series="perf.series" />
          <div v-else class="text-sm text-gray-500 text-center py-6">Нет данных за выбранный период.</div>

          <!-- AI analyze -->
          <div class="pt-2 border-t border-gray-800 flex flex-wrap items-center gap-3">
            <button class="btn-primary !bg-gradient-to-r from-indigo-600 to-fuchsia-600"
                    :disabled="analyzing" @click="runAnalysis">
              🧠 Анализировать показатели проекта
            </button>
            <span v-if="analyzing" class="text-sm text-indigo-300 animate-pulse">ИИ анализирует ваши данные…</span>
          </div>
        </section>

        <!-- AI report -->
        <section v-if="analyzing || currentAnalysis" class="card space-y-3">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Отчёт AI-аналитика</h2>
          <div v-if="analyzing && (!currentAnalysis || currentAnalysis.status !== 'done')" class="space-y-2">
            <div class="h-4 w-2/3 animate-pulse bg-gray-800 rounded"></div>
            <div class="h-4 w-full animate-pulse bg-gray-800 rounded"></div>
            <div class="h-4 w-5/6 animate-pulse bg-gray-800 rounded"></div>
            <p class="text-xs text-gray-500">Генерация может занять 30–60 секунд…</p>
          </div>
          <div v-else-if="currentAnalysis?.status === 'error'" class="text-sm text-red-400">
            Ошибка анализа: {{ currentAnalysis.error_message }}
          </div>
          <MarkdownView v-else-if="currentAnalysis?.status === 'done'" :source="currentAnalysis.report_markdown" />
        </section>

        <!-- Коммерческий срез -->
        <CommercialInsights v-if="commercialData" :commercial="commercialData" />

        <!-- История анализов -->
        <section v-if="analyses.length" class="card space-y-2">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">История анализов</h2>
          <div v-for="a in analyses" :key="a.id"
               class="flex items-center justify-between text-sm py-1.5 border-b border-gray-800/60 last:border-0 cursor-pointer hover:text-indigo-300"
               @click="openAnalysis(a)">
            <span>{{ new Date(a.created_at).toLocaleString('ru') }}</span>
            <span class="text-xs px-2 py-0.5 rounded-full border"
                  :class="{
                    'border-emerald-500/40 text-emerald-300': a.status==='done',
                    'border-sky-500/40 text-sky-300 animate-pulse': a.status==='running'||a.status==='queued',
                    'border-red-500/40 text-red-300': a.status==='error',
                  }">{{ a.status }}</span>
          </div>
        </section>

        <!-- Share -->
        <section class="card space-y-2">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Поделиться статистикой</h2>
          <p class="text-xs text-gray-500">Публичная read-only ссылка: клиент видит графики и AI-отчёт, без настроек и кнопок управления.</p>
          <div v-if="project.share_token" class="flex flex-wrap gap-2 items-center">
            <input :value="shareUrl" readonly class="input flex-1 min-w-0 text-xs" />
            <button class="btn-ghost border border-gray-700" @click="copyShare">📋 Скопировать</button>
            <button class="text-xs text-red-400 hover:text-red-300" @click="revokeShare">Сбросить ссылку</button>
          </div>
          <button v-else class="btn-primary" @click="createShare">🌐 Поделиться доступом</button>
        </section>
      </template>

      <!-- Toast -->
      <transition name="fade">
        <div v-if="toast" class="fixed bottom-6 right-6 bg-gray-900 border border-indigo-700 text-indigo-200 px-4 py-2 rounded-lg shadow-lg text-sm z-50">
          {{ toast }}
        </div>
      </transition>
    </div>
  </AppLayout>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
