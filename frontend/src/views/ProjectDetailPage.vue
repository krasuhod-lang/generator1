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
import AnalyticsExtras from '../components/AnalyticsExtras.vue';
import LinkProfileCard from '../components/LinkProfileCard.vue';
import BlogTopicsCard from '../components/BlogTopicsCard.vue';
import MetaSuggestionsCard from '../components/MetaSuggestionsCard.vue';
import EatTemplatesCard from '../components/EatTemplatesCard.vue';
import SchemaAuditCard from '../components/SchemaAuditCard.vue';
import AiVisibilityCard from '../components/AiVisibilityCard.vue';
import RankingFactorsCard from '../components/RankingFactorsCard.vue';
import { useProjectsStore } from '../stores/projects.js';
import { copyToClipboard } from '../utils/clipboard.js';

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

// Активная вкладка источника данных: 'gsc' | 'ydx' | 'compare'
const activeTab = ref('gsc');

// Яндекс.Вебмастер (симметрично GSC)
const ydxConfigured = ref(false);
const ydxSites = ref([]);
const selectedYdxSite = ref('');
const ydxSitesLoading = ref(false);
const ydxPerf = ref(null);
const ydxPerfLoading = ref(false);
const ydxPerfError = ref('');

// Сопоставление источников (GSC ↔ Яндекс) + рекомендации
const comparison = ref(null);
const compareConnected = ref({ google: false, yandex: false });
const compareLoading = ref(false);
const compareError = ref('');

// Performance
const range = ref({ key: '28d', from: '', to: '' });
const perf = ref(null);
const perfLoading = ref(false);
const perfError = ref('');

// Analysis
const currentAnalysis = ref(null);
const analyzing = ref(false);
let analysisTimer = null;

// CSV-импорт ссылок из GSC
const csvInput = ref(null);
const csvFile = ref(null);
const csvUploading = ref(false);
function onCsvSelected(e) {
  csvFile.value = (e.target.files && e.target.files[0]) || null;
}
async function uploadLinksCsv() {
  if (!csvFile.value) return;
  csvUploading.value = true;
  try {
    const res = await store.importGscLinks(projectId, csvFile.value);
    const TYPE_RU = { sites: 'доноры', pages: 'целевые страницы', anchors: 'анкоры' };
    const typeRu = TYPE_RU[res?.type] || res?.type || '';
    flash(`Импортировано (${typeRu}): ${res?.imported ?? 0} из ${res?.parsed ?? 0} строк`);
    csvFile.value = null;
    if (csvInput.value) csvInput.value.value = '';
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось импортировать CSV');
  } finally {
    csvUploading.value = false;
  }
}

function flash(msg) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 3000);
}

const gscReady = computed(() => project.value?.gsc_connected && project.value?.gsc_site_url);
const ydxReady = computed(() => project.value?.ydx_connected && project.value?.ydx_site_url);

// Коммерческий срез из снапшота последнего/открытого анализа.
const commercialData = computed(() => currentAnalysis.value?.gsc_snapshot?.commercial || null);
// Верификация каннибализации по топ-выдаче Google.
const serpVerificationData = computed(() => currentAnalysis.value?.gsc_snapshot?.serp_verification || null);
// Расширенные срезы и аналитические слои (period-over-period, page decay,
// устройства/страны/searchAppearance, бренд vs небренд).
const periodCompareData = computed(() => currentAnalysis.value?.gsc_snapshot?.period_compare || null);
const breakdownsData = computed(() => currentAnalysis.value?.gsc_snapshot?.breakdowns || null);
const pageDecayData = computed(() => currentAnalysis.value?.gsc_snapshot?.page_decay || null);
const brandSplitData = computed(() => currentAnalysis.value?.gsc_snapshot?.brand_split || null);
// Новые слои анализа GSC (ссылочный профиль, блог-план, мета, E-E-A-T, GEO/AEO, схема).
const linkAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.link_audit || null);
const blogPlanData = computed(() => currentAnalysis.value?.gsc_snapshot?.blog_plan || null);
const pageMetaAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.page_meta_audit || null);
const eatData = computed(() => currentAnalysis.value?.gsc_snapshot?.eat || null);
const schemaAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.schema_audit || null);
const geoAeoData = computed(() => currentAnalysis.value?.gsc_snapshot?.geo_aeo || null);

// Мультиисточниковая аналитика: отдельный отчёт Яндекса, сводка закономерностей
// и аудит факторов ранжирования (что мешает росту).
const ydxReportMarkdown = computed(() => currentAnalysis.value?.ydx_report_markdown || null);
const synthesisMarkdown = computed(() => currentAnalysis.value?.synthesis_markdown || null);
const rankingFactorsData = computed(() => currentAnalysis.value?.ranking_factors || null);

async function load() {
  loading.value = true;
  try {
    const data = await store.getProject(projectId);
    project.value = data.project;
    analyses.value = data.analyses || [];
    gscConfigured.value = !!data.gsc_configured;
    ydxConfigured.value = !!data.ydx_configured;
    datePresets.value = data.date_presets || [];
    if (project.value.gsc_connected && !project.value.gsc_site_url) {
      await loadSites();
    }
    if (project.value.ydx_connected && !project.value.ydx_site_url) {
      await loadYdxSites();
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

// ── Яндекс.Вебмастер ──────────────────────────────────────────────
async function loadYdxSites() {
  ydxSitesLoading.value = true;
  try {
    const data = await store.getYdxSites(projectId);
    ydxSites.value = data.sites || [];
    selectedYdxSite.value = data.selected || (ydxSites.value[0]?.siteUrl || '');
  } catch (_) { /* no-op */ } finally {
    ydxSitesLoading.value = false;
  }
}

async function connectYdx() {
  try {
    const url = await store.getYdxAuthUrl(projectId);
    if (url) window.location.href = url;
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось начать авторизацию Яндекса');
  }
}

async function chooseYdxSite() {
  if (!selectedYdxSite.value) return;
  try {
    project.value = await store.selectYdxSite(projectId, selectedYdxSite.value);
    flash('Сайт Яндекс.Вебмастера привязан к проекту');
    await loadYdxPerformance();
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось выбрать сайт');
  }
}

async function disconnectYdx() {
  if (!confirm('Отключить Яндекс.Вебмастер от проекта?')) return;
  try {
    await store.disconnectYdx(projectId);
    ydxPerf.value = null;
    await load();
  } catch (_) { /* no-op */ }
}

async function loadYdxPerformance() {
  if (!ydxReady.value) return;
  ydxPerfLoading.value = true;
  ydxPerfError.value = '';
  try {
    ydxPerf.value = await store.getYdxPerformance(projectId, rangeParams());
  } catch (err) {
    ydxPerfError.value = err.response?.data?.error || 'Не удалось получить данные Яндекс.Вебмастера';
  } finally {
    ydxPerfLoading.value = false;
  }
}

// ── Сопоставление источников ──────────────────────────────────────
async function loadComparison() {
  compareLoading.value = true;
  compareError.value = '';
  try {
    const data = await store.compareSources(projectId, rangeParams());
    comparison.value = data?.comparison || null;
    compareConnected.value = data?.connected || { google: false, yandex: false };
  } catch (err) {
    compareError.value = err.response?.data?.error || 'Не удалось сопоставить данные';
  } finally {
    compareLoading.value = false;
  }
}

// Переключение вкладок: лениво подгружаем данные при первом открытии.
function switchTab(tab) {
  activeTab.value = tab;
  if (tab === 'ydx' && ydxReady.value && !ydxPerf.value && !ydxPerfLoading.value) {
    loadYdxPerformance();
  }
  if (tab === 'compare' && !comparison.value && !compareLoading.value) {
    loadComparison();
  }
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

function _reloadActive() {
  if (activeTab.value === 'ydx') return loadYdxPerformance();
  if (activeTab.value === 'compare') return loadComparison();
  return loadPerformance();
}

function setPreset(key) {
  range.value.key = key;
  if (key !== 'custom') _reloadActive();
}

function applyCustom() {
  if (range.value.from && range.value.to) {
    range.value.key = 'custom';
    _reloadActive();
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
  const ok = await copyToClipboard(shareUrl.value);
  flash(ok ? 'Ссылка скопирована!' : 'Не удалось скопировать');
}
async function copyReport() {
  const md = currentAnalysis.value?.report_markdown;
  if (!md) return;
  const ok = await copyToClipboard(md);
  flash(ok ? 'Отчёт скопирован (Markdown)' : 'Не удалось скопировать');
}

onMounted(() => {
  // Обработка возврата с OAuth.
  if (route.query.gsc === 'connected') flash('Google Search Console подключён ✓');
  else if (route.query.gsc === 'error') flash('Ошибка подключения GSC: ' + (route.query.reason || ''));
  if (route.query.ydx === 'connected') { flash('Яндекс.Вебмастер подключён ✓'); activeTab.value = 'ydx'; }
  else if (route.query.ydx === 'error') { flash('Ошибка подключения Яндекс.Вебмастера: ' + (route.query.reason || '')); activeTab.value = 'ydx'; }
  if (route.query.gsc || route.query.ydx) router.replace({ path: route.path });
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

        <!-- Вкладки источников данных: GSC / Яндекс.Вебмастер / Сравнение -->
        <nav class="flex flex-wrap gap-1 border-b border-gray-800">
          <button type="button"
                  class="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
                  :class="activeTab === 'gsc' ? 'border-indigo-500 text-indigo-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                  @click="switchTab('gsc')">
            Google Search Console
            <span v-if="gscReady" class="ml-1 text-emerald-400">●</span>
          </button>
          <button type="button"
                  class="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
                  :class="activeTab === 'ydx' ? 'border-red-500 text-red-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                  @click="switchTab('ydx')">
            Яндекс.Вебмастер
            <span v-if="ydxReady" class="ml-1 text-emerald-400">●</span>
          </button>
          <button type="button"
                  class="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
                  :class="activeTab === 'compare' ? 'border-fuchsia-500 text-fuchsia-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                  @click="switchTab('compare')">
            Сравнение и рекомендации
          </button>
        </nav>

        <!-- ============ Вкладка: Google Search Console ============ -->
        <div v-show="activeTab === 'gsc'" class="space-y-5">
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

        <!-- Импорт CSV «Ссылки» из GSC (внешние ссылки/доноры/анкоры) -->
        <section v-if="gscReady" class="card space-y-2">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Ссылки из GSC (CSV)</h2>
          <p class="text-xs text-gray-500">
            Search Console не отдаёт отчёт «Ссылки» через API. Выгрузите CSV вручную
            (Ссылки → Экспорт) и загрузите сюда — это включит анализ доноров и анкоров.
          </p>
          <div class="flex items-center gap-2">
            <input ref="csvInput" type="file" accept=".csv,text/csv" class="text-xs text-gray-300"
                   @change="onCsvSelected" />
            <button class="btn-secondary text-xs" :disabled="!csvFile || csvUploading" @click="uploadLinksCsv">
              {{ csvUploading ? 'Загрузка…' : 'Импортировать' }}
            </button>
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
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Отчёт AI-аналитика</h2>
            <button v-if="currentAnalysis?.status === 'done'"
                    class="btn-ghost border border-gray-700 text-xs" @click="copyReport">
              📋 Скопировать отчёт
            </button>
          </div>
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

        <!-- Расширенные срезы: что изменилось, устройства/страны, page decay, бренд -->
        <AnalyticsExtras
          v-if="periodCompareData || breakdownsData || pageDecayData || brandSplitData"
          :period-compare="periodCompareData"
          :breakdowns="breakdownsData"
          :page-decay="pageDecayData"
          :brand-split="brandSplitData"
        />

        <!-- Коммерческий срез -->
        <CommercialInsights v-if="commercialData" :commercial="commercialData" :serp-verification="serpVerificationData" />

        <!-- Ссылочная стратегия (анкоры/доноры) -->
        <LinkProfileCard v-if="linkAuditData" :link-audit="linkAuditData" />

        <!-- Постраничная оптимизация метатегов через Meta Tags -->
        <MetaSuggestionsCard v-if="pageMetaAuditData" :page-meta-audit="pageMetaAuditData" :project-id="projectId" />

        <!-- План публикаций в блог -->
        <BlogTopicsCard v-if="blogPlanData" :blog-plan="blogPlanData" />

        <!-- E-E-A-T по шаблонам страниц -->
        <EatTemplatesCard v-if="eatData" :eat="eatData" />

        <!-- Микроразметка -->
        <SchemaAuditCard v-if="schemaAuditData" :schema-audit="schemaAuditData" />

        <!-- GEO/AEO — нейровыдача -->
        <AiVisibilityCard v-if="geoAeoData" :geo-aeo="geoAeoData" :project-id="projectId" />

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
        </div>
        <!-- ============ /Вкладка GSC ============ -->

        <!-- ============ Вкладка: Яндекс.Вебмастер ============ -->
        <div v-show="activeTab === 'ydx'" class="space-y-5">
          <!-- Yandex connect block -->
          <section class="card space-y-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-red-300">Яндекс.Вебмастер</h2>

            <div v-if="!ydxConfigured" class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              Интеграция Яндекса не настроена на сервере (YANDEX_CLIENT_ID / SECRET / REDIRECT_URI).
              Подключение будет доступно после настройки.
            </div>

            <div v-if="!project.ydx_connected">
              <button class="btn-primary !bg-red-600 hover:!bg-red-500" :disabled="!ydxConfigured" @click="connectYdx">
                🔗 Подключить Яндекс.Вебмастер
              </button>
            </div>

            <div v-else-if="!project.ydx_site_url" class="space-y-2">
              <p class="text-sm text-gray-300">Аккаунт подключён. Выберите подтверждённый сайт:</p>
              <div class="flex gap-2 items-center">
                <select v-model="selectedYdxSite" class="input max-w-md" :disabled="ydxSitesLoading">
                  <option v-for="s in ydxSites" :key="s.siteUrl" :value="s.siteUrl">{{ s.siteUrl }}</option>
                </select>
                <button class="btn-primary !bg-red-600 hover:!bg-red-500" :disabled="!selectedYdxSite" @click="chooseYdxSite">Привязать</button>
              </div>
              <p v-if="!ydxSites.length && !ydxSitesLoading" class="text-xs text-gray-500">Нет подтверждённых сайтов в этом аккаунте Яндекс.Вебмастера.</p>
            </div>

            <div v-else class="flex items-center justify-between">
              <span class="text-sm text-emerald-300">✓ Привязан сайт: <b>{{ project.ydx_site_url }}</b></span>
              <button class="text-xs text-red-400 hover:text-red-300" @click="disconnectYdx">Отключить</button>
            </div>
          </section>

          <!-- Yandex dashboard -->
          <section v-if="ydxReady" class="card space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-red-300">Эффективность в Яндексе</h2>
              <div class="flex flex-wrap gap-1.5">
                <button v-for="p in datePresets" :key="p.key" type="button"
                        class="text-xs px-2.5 py-1 rounded border transition-colors"
                        :class="range.key === p.key ? 'border-red-500 text-red-200 bg-red-500/10' : 'border-gray-700 text-gray-400 hover:text-gray-200'"
                        @click="setPreset(p.key)">{{ p.label }}</button>
                <div class="flex items-center gap-1">
                  <input type="date" v-model="range.from" class="input !py-1 text-xs" />
                  <span class="text-gray-600 text-xs">—</span>
                  <input type="date" v-model="range.to" class="input !py-1 text-xs" />
                  <button class="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:text-white" @click="applyCustom">OK</button>
                </div>
              </div>
            </div>

            <div v-if="ydxPerf && !ydxPerfLoading" class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Клики</div>
                <div class="text-xl font-bold text-red-300">{{ ydxPerf.totals.clicks.toLocaleString('ru') }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Показы</div>
                <div class="text-xl font-bold text-orange-300">{{ ydxPerf.totals.impressions.toLocaleString('ru') }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">CTR</div>
                <div class="text-xl font-bold text-emerald-300">{{ ydxPerf.totals.ctr }}%</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Ср. позиция</div>
                <div class="text-xl font-bold text-amber-300">{{ ydxPerf.totals.position }}</div>
              </div>
            </div>

            <div v-if="ydxPerfLoading" class="h-80 animate-pulse bg-gray-900/60 rounded-lg"></div>
            <div v-else-if="ydxPerfError" class="text-sm text-red-400">{{ ydxPerfError }}</div>
            <GscPerformanceChart v-else-if="ydxPerf && ydxPerf.series.length" :series="ydxPerf.series" />
            <div v-else class="text-sm text-gray-500 text-center py-6">Нет данных за выбранный период.</div>
          </section>

          <!-- Отдельный AI-отчёт по Яндексу (поведенческие/коммерч./регион.) -->
          <section v-if="ydxReportMarkdown" class="card space-y-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-red-300">Отчёт AI-аналитика · Яндекс</h2>
            <MarkdownView :source="ydxReportMarkdown" />
          </section>
          <section v-else-if="ydxReady && currentAnalysis?.status === 'done'" class="card">
            <p class="text-xs text-gray-500">
              Отдельный AI-отчёт по Яндексу появится после запуска анализа на вкладке Google
              (кнопка «Анализировать показатели проекта») — Яндекс анализируется автоматически вместе с Google.
            </p>
          </section>
        </div>
        <!-- ============ /Вкладка Яндекс.Вебмастер ============ -->

        <!-- ============ Вкладка: Сравнение и рекомендации ============ -->
        <div v-show="activeTab === 'compare'" class="space-y-5">
          <!-- Аудит факторов ранжирования: чего не хватает для роста -->
          <RankingFactorsCard v-if="rankingFactorsData" :ranking-factors="rankingFactorsData" />

          <!-- AI-сводка закономерностей Google ↔ Яндекс -->
          <section v-if="synthesisMarkdown" class="card space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-fuchsia-300">AI-сводка закономерностей Google ↔ Яндекс</h2>
            </div>
            <MarkdownView :source="synthesisMarkdown" />
          </section>

          <section class="card space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-fuchsia-300">Сопоставление Google ↔ Яндекс</h2>
              <div class="flex flex-wrap gap-1.5">
                <button v-for="p in datePresets" :key="p.key" type="button"
                        class="text-xs px-2.5 py-1 rounded border transition-colors"
                        :class="range.key === p.key ? 'border-fuchsia-500 text-fuchsia-200 bg-fuchsia-500/10' : 'border-gray-700 text-gray-400 hover:text-gray-200'"
                        @click="setPreset(p.key)">{{ p.label }}</button>
                <button class="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:text-white" @click="loadComparison">↻ Обновить</button>
              </div>
            </div>

            <div v-if="!compareConnected.google || !compareConnected.yandex" class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              Для полноценного сравнения подключите обе системы.
              <template v-if="!compareConnected.google"> Google Search Console — не подключён.</template>
              <template v-if="!compareConnected.yandex"> Яндекс.Вебмастер — не подключён.</template>
            </div>

            <div v-if="compareLoading" class="h-40 animate-pulse bg-gray-900/60 rounded-lg"></div>
            <div v-else-if="compareError" class="text-sm text-red-400">{{ compareError }}</div>

            <template v-else-if="comparison">
              <p class="text-sm text-gray-300">{{ comparison.summary }}</p>

              <!-- Таблица суммарных показателей -->
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-[11px] uppercase text-gray-500 border-b border-gray-800">
                      <th class="py-2 pr-3">Показатель</th>
                      <th class="py-2 px-3 text-indigo-300">Google</th>
                      <th class="py-2 px-3 text-red-300">Яндекс</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in comparison.totals" :key="row.metric" class="border-b border-gray-800/60 last:border-0">
                      <td class="py-2 pr-3 text-gray-300">{{ row.metric }}</td>
                      <td class="py-2 px-3 font-semibold text-indigo-200">
                        {{ row.is_percent ? row.google + '%' : Number(row.google).toLocaleString('ru') }}
                        <span v-if="row.google_share != null" class="text-[11px] text-gray-500">({{ row.google_share }}%)</span>
                      </td>
                      <td class="py-2 px-3 font-semibold text-red-200">
                        {{ row.is_percent ? row.yandex + '%' : Number(row.yandex).toLocaleString('ru') }}
                        <span v-if="row.yandex_share != null" class="text-[11px] text-gray-500">({{ row.yandex_share }}%)</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="grid grid-cols-3 gap-3 text-center text-xs">
                <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
                  <div class="text-gray-500">Общих запросов</div>
                  <div class="text-lg font-bold text-fuchsia-300">{{ comparison.queries.overlap_count }}</div>
                </div>
                <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
                  <div class="text-gray-500">Только Google</div>
                  <div class="text-lg font-bold text-indigo-300">{{ comparison.queries.only_google_count }}</div>
                </div>
                <div class="bg-gray-950 border border-gray-800 rounded-lg p-2">
                  <div class="text-gray-500">Только Яндекс</div>
                  <div class="text-lg font-bold text-red-300">{{ comparison.queries.only_yandex_count }}</div>
                </div>
              </div>
            </template>
          </section>

          <!-- Рекомендации -->
          <section v-if="comparison && comparison.recommendations && comparison.recommendations.length" class="card space-y-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-fuchsia-300">Рекомендации по улучшению</h2>
            <div v-for="(rec, i) in comparison.recommendations" :key="i"
                 class="border border-gray-800 rounded-lg p-3 bg-gray-950/60">
              <div class="flex items-center gap-2">
                <span class="text-[10px] uppercase px-2 py-0.5 rounded-full border"
                      :class="{
                        'border-red-500/40 text-red-300': rec.priority==='high',
                        'border-amber-500/40 text-amber-300': rec.priority==='medium',
                        'border-sky-500/40 text-sky-300': rec.priority==='info',
                      }">{{ rec.priority }}</span>
                <span class="text-sm font-semibold text-gray-100">{{ rec.title }}</span>
              </div>
              <p class="text-sm text-gray-400 mt-1">{{ rec.detail }}</p>
              <ul v-if="rec.items && rec.items.length" class="mt-2 space-y-0.5 text-xs text-gray-400">
                <li v-for="(it, j) in rec.items" :key="j" class="flex flex-wrap gap-x-2">
                  <span class="text-gray-200">{{ it.query }}</span>
                  <span v-if="it.google_position != null" class="text-indigo-300">Google: {{ it.google_position }}</span>
                  <span v-if="it.yandex_position != null" class="text-red-300">Яндекс: {{ it.yandex_position }}</span>
                  <span v-if="it.google_impressions != null" class="text-indigo-300">Google показы: {{ it.google_impressions }}</span>
                  <span v-if="it.yandex_impressions != null" class="text-red-300">Яндекс показы: {{ it.yandex_impressions }}</span>
                </li>
              </ul>
            </div>
          </section>
        </div>
        <!-- ============ /Вкладка Сравнение ============ -->

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
