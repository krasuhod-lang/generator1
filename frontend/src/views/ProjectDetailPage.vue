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
import api from '../api.js';
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
import StrategyDiagram from '../components/StrategyDiagram.vue';
import TopPageInsightsCard from '../components/TopPageInsightsCard.vue';
import ActionPlanCard from '../components/ActionPlanCard.vue';
import { useProjectsStore } from '../stores/projects.js';
import { useReportsStore } from '../stores/reports.js';
import { useViewModeStore } from '../stores/viewMode.js';
import { copyToClipboard } from '../utils/clipboard.js';

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();
const reportsStore = useReportsStore();
const viewMode = useViewModeStore();

const projectId = route.params.id;
const project = ref(null);
const positionProject = ref(null);
const analyses = ref([]);
const gscConfigured = ref(false);
const datePresets = ref([]);
const loading = ref(true);
const toast = ref('');
let toastTimer = null;

// План публикаций → генерация статьи в блог через info-article (ТЗ п.7).
const generatedArticles = ref({});
const generatingArticleIndex = ref(-1);
const blogArticleError = ref('');
async function onGenerateBlogArticle({ topic, index }) {
  blogArticleError.value = '';
  generatingArticleIndex.value = index;
  try {
    const res = await store.generateBlogArticle(projectId, { topic });
    if (res && res.task && res.task.id) {
      generatedArticles.value = { ...generatedArticles.value, [index]: { id: res.task.id } };
    }
  } catch (err) {
    blogArticleError.value = err.response?.data?.error || err.message || 'Не удалось запустить генерацию статьи';
  } finally {
    generatingArticleIndex.value = -1;
  }
}

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

// ── Бренд и источники отчётов ────────────────────────────────────────
// Карточка над дашбордом источников: позволяет пользователю задать
// логотип / акцентный цвет / домен и регион для модуля Smart Reports
// (без этого Keys.so в отчёте всегда показывает «Не подключён»).
const KEYS_SO_REGIONS = [
  { v: 'msk', l: 'Москва (msk)' }, { v: 'spb', l: 'СПб (spb)' },
  { v: 'ekb', l: 'Екатеринбург (ekb)' }, { v: 'nsk', l: 'Новосибирск (nsk)' },
  { v: 'kzn', l: 'Казань (kzn)' }, { v: 'nnv', l: 'Нижний Новгород (nnv)' },
  { v: 'rnd', l: 'Ростов-на-Дону (rnd)' }, { v: 'sam', l: 'Самара (sam)' },
  { v: 'krr', l: 'Краснодар (krr)' }, { v: 'vrn', l: 'Воронеж (vrn)' },
  { v: 'ufa', l: 'Уфа (ufa)' }, { v: 'prm', l: 'Пермь (prm)' },
  { v: 'che', l: 'Челябинск (che)' }, { v: 'tmn', l: 'Тюмень (tmn)' },
  { v: 'oms', l: 'Омск (oms)' }, { v: 'vlg', l: 'Волгоград (vlg)' },
  { v: 'kry', l: 'Красноярск (kry)' }, { v: 'sar', l: 'Саратов (sar)' },
  { v: 'tom', l: 'Томск (tom)' }, { v: 'gru', l: 'Грозный (gru)' },
  { v: 'mns', l: 'Минск (mns)' }, { v: 'gmns', l: 'Минск Google (gmns)' },
  { v: 'gkv', l: 'Киев Google (gkv)' }, { v: 'zen', l: 'Дзен (zen)' },
  { v: 'gny', l: 'New York Google (gny)' },
];
const brandingForm = ref({
  logo_url: '',
  color_accent: '#0a84ff',
  keys_so_domain: '',
  keys_so_region: 'msk',
});
const brandingSaving = ref(false);
function _projectDomainHint(p) {
  if (!p) return '';
  try {
    return new URL(p.url).hostname.replace(/^www\./, '');
  } catch (_) { return ''; }
}
function _syncBrandingFromProject() {
  if (!project.value) return;
  brandingForm.value = {
    logo_url: project.value.logo_url || '',
    color_accent: project.value.color_accent || '#0a84ff',
    keys_so_domain: project.value.keys_so_domain || _projectDomainHint(project.value),
    keys_so_region: project.value.keys_so_region || 'msk',
  };
}
async function saveBranding() {
  if (!project.value) return;
  brandingSaving.value = true;
  try {
    const updated = await store.updateProject(projectId, {
      logo_url: brandingForm.value.logo_url || null,
      color_accent: brandingForm.value.color_accent || null,
      keys_so_domain: brandingForm.value.keys_so_domain || null,
      keys_so_region: brandingForm.value.keys_so_region || 'msk',
    });
    if (updated) {
      project.value = { ...project.value, ...updated };
      _syncBrandingFromProject();
      flash('Сохранено');
    }
  } catch (err) {
    flash(err.response?.data?.error || 'Не удалось сохранить');
  } finally {
    brandingSaving.value = false;
  }
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
const seasonalityData = computed(() => currentAnalysis.value?.gsc_snapshot?.seasonality || null);
const strategyMapData = computed(() => currentAnalysis.value?.gsc_snapshot?.strategy_map || null);
// Новые слои анализа GSC (ссылочный профиль, блог-план, мета, E-E-A-T, GEO/AEO, схема).
const linkAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.link_audit || null);
const blogPlanData = computed(() => currentAnalysis.value?.gsc_snapshot?.blog_plan || null);
const pageMetaAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.page_meta_audit || null);
const eatData = computed(() => currentAnalysis.value?.gsc_snapshot?.eat || null);
const schemaAuditData = computed(() => currentAnalysis.value?.gsc_snapshot?.schema_audit || null);
const geoAeoData = computed(() => currentAnalysis.value?.gsc_snapshot?.geo_aeo || null);
// Реверс-инжиниринг топ-страниц: закономерности, КФ6/переспам, топ-10 дифференциал.
const topPageInsightsData = computed(() => currentAnalysis.value?.gsc_snapshot?.top_page_insights || null);
const actionPlanData = computed(() => currentAnalysis.value?.gsc_snapshot?.action_plan || null);

// Под-вкладки аналитики GSC: вместо длинной простыни секций показываем их как
// табы под графиком — кликнул, появилась нужная информация.
const gscSubTab = ref('report');
const gscSubTabs = computed(() => [
  { key: 'report', label: 'Отчёт ИИ', show: !!(analyzing.value || currentAnalysis.value) },
  { key: 'strategy', label: 'Стратегия', show: !!(strategyMapData.value && strategyMapData.value.available) },
  { key: 'actionplan', label: 'План действий', show: !!(actionPlanData.value && actionPlanData.value.available) },
  { key: 'dynamics', label: 'Динамика', show: !!(periodCompareData.value || breakdownsData.value || pageDecayData.value || brandSplitData.value || seasonalityData.value) },
  { key: 'commercial', label: 'Коммерция', show: !!commercialData.value },
  { key: 'toppages', label: 'Топ-страницы', show: !!topPageInsightsData.value },
  { key: 'links', label: 'Ссылки', show: !!linkAuditData.value },
  { key: 'meta', label: 'Мета', show: !!pageMetaAuditData.value },
  { key: 'blog', label: 'Блог', show: !!blogPlanData.value },
  { key: 'eat', label: 'E-E-A-T', show: !!eatData.value },
  { key: 'schema', label: 'Микроразметка', show: !!schemaAuditData.value },
  { key: 'geo', label: 'GEO/AEO', show: !!geoAeoData.value },
  { key: 'history', label: 'История', show: !!analyses.value.length },
].filter((t) => t.show));
// Активная под-вкладка: выбранная пользователем, либо первая доступная.
const activeGscSubTab = computed(() => {
  const tabs = gscSubTabs.value;
  if (!tabs.length) return '';
  return tabs.some((t) => t.key === gscSubTab.value) ? gscSubTab.value : tabs[0].key;
});

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
    positionProject.value = data.position_project || data.project?.position_project || null;
    _syncBrandingFromProject();
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
    _syncRangeFromResponse(ydxPerf.value);
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
    if (data?.range) _syncRangeFromResponse(data);
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
  if (tab === 'tasks' && !projectTasks.value.length && !tasksLoading.value) {
    loadProjectTasks();
  }
}

function rangeParams() {
  if (range.value.key === 'custom' && range.value.from && range.value.to) {
    return { from: range.value.from, to: range.value.to };
  }
  return { range: range.value.key };
}

/**
 * П.5: подхватить реально применённый бэкендом период
 * (`range.startDate` / `range.endDate` из ответа fetchPerformanceSeries)
 * и залить в инпуты UI. GSC сдвигает endDate на -2..-3 дня от «сегодня»,
 * поэтому без этого пользователь не понимает, какой именно диапазон
 * показывают графики.
 */
function _syncRangeFromResponse(resp) {
  const r = resp && resp.range;
  if (!r || !r.startDate || !r.endDate) return;
  range.value.from = r.startDate;
  range.value.to = r.endDate;
  range.value.key = 'custom';
}

async function loadPerformance() {
  perfLoading.value = true;
  perfError.value = '';
  try {
    perf.value = await store.getPerformance(projectId, rangeParams());
    _syncRangeFromResponse(perf.value);
  } catch (err) {
    perfError.value = err.response?.data?.error || 'Не удалось получить данные GSC';
  } finally {
    perfLoading.value = false;
  }
}

function _reloadActive() {
  if (activeTab.value === 'ydx') return loadYdxPerformance();
  if (activeTab.value === 'compare') return loadComparison();
  if (activeTab.value === 'tasks') return loadProjectTasks();
  return loadPerformance();
}

// ТЗ §5: список всех задач, привязанных к этому проекту через project_id.
const projectTasks = ref([]);
const tasksLoading = ref(false);
const tasksError = ref(null);
const TASK_TYPE_LABELS = {
  info_article:  'Статья',
  link_article:  'Ссылка',
  meta_tags:     'Мета-теги',
  article_topic: 'Темы',
  relevance:     'Релевантность',
  forecaster:    'Прогноз',
  serp_b2b:      'SERP B2B',
};
const TASK_TYPE_ROUTES = {
  info_article:  '/info-article/',
  link_article:  '/link-article/',
  meta_tags:     '/meta-tags/',
  article_topic: '/article-topics/',
  relevance:     '/relevance/',
  forecaster:    '/forecaster/',
  serp_b2b:      '/serp-b2b/',
};
function taskTypeLabel(t) { return TASK_TYPE_LABELS[t] || t; }
function taskHref(t) { return (TASK_TYPE_ROUTES[t.type] || '/') + t.id; }
function taskStatusClass(s) {
  const st = String(s || '').toLowerCase();
  if (st === 'completed' || st === 'done' || st === 'finished') return 'bg-emerald-500/20 text-emerald-300';
  if (st === 'failed' || st === 'error') return 'bg-red-500/20 text-red-300';
  if (st === 'queued' || st === 'pending') return 'bg-gray-500/20 text-gray-300';
  return 'bg-amber-500/20 text-amber-300';
}
function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); }
  catch (_) { return iso; }
}
async function loadProjectTasks() {
  if (!projectId) return;
  tasksLoading.value = true; tasksError.value = null;
  try {
    const { data } = await api.get(`/projects/${projectId}/tasks`);
    projectTasks.value = data?.items || [];
  } catch (err) {
    tasksError.value = err.response?.data?.error || 'Не удалось загрузить задачи проекта';
  } finally {
    tasksLoading.value = false;
  }
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

function applyPageMetaAuditUpdate(pageMetaAudit) {
  if (!currentAnalysis.value || !pageMetaAudit) return;
  const snapshot = currentAnalysis.value.gsc_snapshot || {};
  currentAnalysis.value = {
    ...currentAnalysis.value,
    gsc_snapshot: {
      ...snapshot,
      page_meta_audit: pageMetaAudit,
    },
  };
}

// ── Шаринг ────────────────────────────────────────────────────────
const shareUrl = computed(() => project.value?.share_token
  ? `${window.location.origin}/share/project/${project.value.share_token}` : '');
const shareForm = ref({ mode: 'client', ttlDays: 90 });
const shareTtlOptions = [
  { value: 7,   label: '7 дней' },
  { value: 30,  label: '30 дней' },
  { value: 90,  label: '90 дней' },
  { value: 365, label: '1 год' },
  { value: 0,   label: 'Бессрочно' },
];
const shareExpiresLabel = computed(() => {
  const t = project.value?.share_expires_at;
  if (!t) return 'бессрочная';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return `истекает ${d.toLocaleDateString('ru-RU')}`;
});

async function createShare(opts = {}) {
  try {
    const result = await store.createShare(projectId, opts);
    const token = result && typeof result === 'object' ? result.token : result;
    if (token) {
      project.value.share_token = token;
      if (result && typeof result === 'object') {
        project.value.share_mode       = result.mode || project.value.share_mode;
        project.value.share_expires_at = result.expires_at || null;
      }
      flash('Публичная ссылка создана');
    } else {
      flash('Не удалось создать ссылку (пустой ответ)');
    }
  } catch (err) {
    const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
    flash(`Не удалось создать ссылку: ${msg}`);
  }
}
async function updateShare(opts) {
  // Если ссылка уже выпущена — backend обновляет mode/expires_at, токен сохраняется.
  return createShare(opts);
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

/**
 * П.7: «📊 Отчёт проекта» — открыть последний draft этого проекта в
 * редакторе отчётов, либо автоматически создать новый с дефолтным окном
 * «последние 28 дней» и редиректнуть туда. Один проект — один активный
 * draft (последний по дате создания); ReportsPage остаётся глобальным
 * реестром для аналитика.
 */
const openingReport = ref(false);
async function openProjectReport() {
  if (!project.value?.id) return;
  openingReport.value = true;
  try {
    const drafts = await reportsStore.fetchDrafts();
    const list = drafts || reportsStore.drafts || [];
    const own = list.filter((d) => d.project_id === project.value.id);
    if (own.length) {
      // Самый свежий — наверху (бэкенд сортирует by created_at DESC).
      // ВАЖНО: маршрут редактора — `/reports/:id/edit`. Без `/edit`
      // путь не матчится ни одним route и срабатывает фолбэк
      // `/:pathMatch(.*)*` → `/dashboard` (страница SEO-задач), из-за
      // чего «📊 Отчёт проекта» открывал не отчёт, а форму SEO-текста.
      router.push(`/reports/${own[0].id}/edit`);
      return;
    }
    const to = new Date();
    const from = new Date(to.getTime() - 27 * 86400_000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const draft = await reportsStore.createDraft({
      project_id: project.value.id,
      title: `Отчёт: ${project.value.name}`,
      date_from: fmt(from),
      date_to: fmt(to),
    });
    if (draft?.id) router.push(`/reports/${draft.id}/edit`);
    else flash('Не удалось создать отчёт');
  } catch (err) {
    flash(err?.response?.data?.error || 'Не удалось открыть отчёт проекта');
  } finally {
    openingReport.value = false;
  }
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
          <div class="min-w-0 flex items-center gap-3">
            <img v-if="project.logo_url" :src="project.logo_url" alt=""
                 class="h-10 w-10 rounded-xl object-contain bg-white/5 border border-white/10 p-1" />
            <div class="min-w-0">
              <h1 class="text-2xl font-bold text-gray-100 truncate"
                  :style="project.color_accent ? `color:${project.color_accent}` : ''">{{ project.name }}</h1>
              <a :href="project.url" target="_blank" rel="noopener" class="text-sm text-indigo-400 hover:underline">{{ project.url }}</a>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <button v-if="positionProject?.id" class="btn-secondary" @click="router.push(`/position-tracker/${positionProject.id}`)">📈 Позиции</button>
            <!-- П.7: единая точка входа в отчёты проекта. Открывает последний
                 черновик или создаёт новый (28 дней) и редиректит туда.
                 «🧾 Новый отчёт» / ReportsPage остаются как глобальный реестр
                 для аналитика (см. меню «Отчёты»). -->
            <button class="btn-secondary" :disabled="openingReport" @click="openProjectReport">
              {{ openingReport ? 'Открываем…' : '📊 Отчёт проекта' }}
            </button>
          </div>
        </header>

        <!-- Бренд и источники отчётов (Smart Reports / Keys.so) -->
        <section class="card space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Бренд и источники отчётов</h2>
            <span class="text-[11px] text-gray-500">используется в модулях «Отчёты» и «Съём позиций»</span>
          </div>
          <div class="grid md:grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs text-gray-400">Логотип (URL .png/.svg)</span>
              <input v-model="brandingForm.logo_url" class="input mt-1" type="url"
                     placeholder="https://example.com/logo.svg" maxlength="500" />
            </label>
            <label class="block">
              <span class="text-xs text-gray-400">Акцентный цвет</span>
              <div class="mt-1 flex items-center gap-2">
                <input v-model="brandingForm.color_accent" type="color" class="h-10 w-14 rounded-md border border-white/10 bg-transparent cursor-pointer" />
                <input v-model="brandingForm.color_accent" class="input flex-1" placeholder="#0a84ff" maxlength="7" />
              </div>
            </label>
            <label class="block">
              <span class="text-xs text-gray-400">Домен Keys.so</span>
              <input v-model="brandingForm.keys_so_domain" class="input mt-1"
                     placeholder="example.ru" maxlength="200" />
              <span class="text-[11px] text-gray-500">Без http:// и www. По умолчанию — домен из URL проекта.</span>
            </label>
            <label class="block">
              <span class="text-xs text-gray-400">Регион Keys.so</span>
              <select v-model="brandingForm.keys_so_region" class="input mt-1">
                <option v-for="r in KEYS_SO_REGIONS" :key="r.v" :value="r.v">{{ r.l }}</option>
              </select>
            </label>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span v-if="project.keys_so_domain" class="text-xs text-emerald-300">
              ✓ Подключён домен <b>{{ project.keys_so_domain }}</b>
              ({{ project.keys_so_region || 'msk' }})
            </span>
            <span v-else class="text-xs text-amber-300">
              Не подключено — отчёт не получит данные Keys.so
            </span>
            <button class="btn-primary" :disabled="brandingSaving" @click="saveBranding">
              {{ brandingSaving ? 'Сохранение…' : 'Сохранить' }}
            </button>
          </div>
        </section>

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
          <button type="button"
                  class="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
                  :class="activeTab === 'tasks' ? 'border-amber-500 text-amber-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                  @click="switchTab('tasks')">
            Задачи
            <span v-if="projectTasks.length" class="ml-1 text-xs text-gray-400">({{ projectTasks.length }})</span>
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

        <!-- Под-вкладки аналитики: под графиком, вместо длинной простыни -->
        <nav v-if="gscSubTabs.length" class="flex flex-wrap gap-1 border-b border-gray-800">
          <button v-for="t in gscSubTabs" :key="t.key" type="button"
                  class="px-3 py-1.5 text-xs font-medium -mb-px border-b-2 transition-colors"
                  :class="activeGscSubTab === t.key ? 'border-indigo-500 text-indigo-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                  @click="gscSubTab = t.key">{{ t.label }}</button>
        </nav>

        <!-- Панель: Отчёт ИИ -->
        <div v-show="activeGscSubTab === 'report'">
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
        </div>

        <!-- Панель: План действий (конкретные рекомендации с расчётами) -->
        <div v-show="activeGscSubTab === 'strategy'">
        <StrategyDiagram v-if="strategyMapData" :strategy-map="strategyMapData" />
        </div>

        <!-- Панель: План действий (конкретные рекомендации с расчётами) -->
        <div v-show="activeGscSubTab === 'actionplan'">
        <ActionPlanCard v-if="actionPlanData" :plan="actionPlanData" />
        </div>

        <!-- Панель: Динамика (что изменилось, устройства/страны, page decay, бренд) -->
        <div v-show="activeGscSubTab === 'dynamics'">
        <AnalyticsExtras
          v-if="periodCompareData || breakdownsData || pageDecayData || brandSplitData || seasonalityData"
          :period-compare="periodCompareData"
          :breakdowns="breakdownsData"
          :page-decay="pageDecayData"
          :brand-split="brandSplitData"
          :seasonality="seasonalityData"
        />
        </div>

        <!-- Панель: Коммерческий срез -->
        <div v-show="activeGscSubTab === 'commercial'">
        <CommercialInsights v-if="commercialData" :commercial="commercialData" :serp-verification="serpVerificationData" />
        </div>

        <!-- Панель: Реверс-инжиниринг топ-страниц (КФ6/переспам, топ-10 дифференциал) -->
        <div v-show="activeGscSubTab === 'toppages'">
        <TopPageInsightsCard v-if="topPageInsightsData" :insights="topPageInsightsData" />
        </div>

        <!-- Панель: Ссылочная стратегия (анкоры/доноры) -->
        <div v-show="activeGscSubTab === 'links'">
        <LinkProfileCard v-if="linkAuditData" :link-audit="linkAuditData" />
        </div>

        <!-- Панель: Постраничная оптимизация метатегов через Meta Tags -->
        <div v-show="activeGscSubTab === 'meta'">
        <MetaSuggestionsCard
          v-if="pageMetaAuditData"
          :page-meta-audit="pageMetaAuditData"
          :project-id="projectId"
          :analysis-id="currentAnalysis && currentAnalysis.id"
          @updated="applyPageMetaAuditUpdate"
        />
        </div>

        <!-- Панель: План публикаций в блог -->
        <div v-show="activeGscSubTab === 'blog'">
        <BlogTopicsCard v-if="blogPlanData" :blog-plan="blogPlanData"
                        :generated-articles="generatedArticles"
                        :generating-index="generatingArticleIndex"
                        @generate="onGenerateBlogArticle" />
        <p v-if="blogArticleError" class="text-xs text-red-400 mt-2">{{ blogArticleError }}</p>
        </div>

        <!-- Панель: E-E-A-T по шаблонам страниц -->
        <div v-show="activeGscSubTab === 'eat'">
        <EatTemplatesCard v-if="eatData" :eat="eatData" />
        </div>

        <!-- Панель: Микроразметка -->
        <div v-show="activeGscSubTab === 'schema'">
        <SchemaAuditCard v-if="schemaAuditData" :schema-audit="schemaAuditData" />
        </div>

        <!-- Панель: GEO/AEO — нейровыдача -->
        <div v-show="activeGscSubTab === 'geo'">
        <AiVisibilityCard v-if="geoAeoData" :geo-aeo="geoAeoData" :project-id="projectId" />
        </div>

        <!-- Панель: История анализов -->
        <div v-show="activeGscSubTab === 'history'">
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

        <!-- ============ Вкладка Задачи (ТЗ §5) ============ -->
        <div v-show="activeTab === 'tasks'" class="space-y-5">
          <section class="card space-y-4">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-amber-300">Задачи проекта</h2>
              <button class="text-xs text-gray-300 hover:text-white" @click="loadProjectTasks">↻ Обновить</button>
            </div>
            <p class="text-xs text-gray-500">
              Все задачи, у которых в форме создания был выбран этот проект — статьи, мета-теги, темы,
              анализ релевантности, прогнозы и SERP-B2B. Старые задачи без явной привязки сюда не попадают.
            </p>
            <div v-if="tasksLoading" class="text-xs text-gray-400">Загрузка…</div>
            <div v-else-if="tasksError" class="text-xs text-red-400">{{ tasksError }}</div>
            <div v-else-if="!projectTasks.length" class="text-xs text-gray-400">
              Пока нет задач, привязанных к проекту. Создайте новую задачу в разделе модуля
              (Статьи / Мета-теги / Релевантность / Прогноз / SERP-B2B) и выберите этот проект.
            </div>
            <table v-else class="w-full text-xs">
              <thead class="text-gray-400 uppercase tracking-wider text-[10px]">
                <tr>
                  <th class="text-left py-2">Тип</th>
                  <th class="text-left py-2">Название</th>
                  <th class="text-left py-2">Статус</th>
                  <th class="text-left py-2">Создано</th>
                  <th class="text-right py-2"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in projectTasks" :key="`${t.type}-${t.id}`" class="border-t border-gray-800">
                  <td class="py-2 text-gray-400">{{ taskTypeLabel(t.type) }}</td>
                  <td class="py-2 text-gray-200">{{ t.title }}</td>
                  <td class="py-2"><span class="px-2 py-0.5 rounded text-[10px]" :class="taskStatusClass(t.status)">{{ t.status }}</span></td>
                  <td class="py-2 text-gray-400">{{ formatDate(t.created_at) }}</td>
                  <td class="py-2 text-right">
                    <router-link :to="taskHref(t)" class="text-indigo-300 hover:text-indigo-100">открыть →</router-link>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        <!-- ============ /Вкладка Задачи ============ -->

        <!-- Share (deprecated → П.6). Клиентская публичная поверхность
             переехала в «Отчёты» (PublicReportPage, /r/:uuid). Здесь блок
             оставлен только аналитику, чтобы можно было отозвать руками уже
             выпущенные ссылки. Бэкенд /share/project/:token и token до сих
             пор работают, чтобы не ломать ранее отправленные клиентам URL. -->
        <section v-if="viewMode.isAnalyst" class="card space-y-3">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Поделиться статистикой <span class="text-[10px] text-gray-500 normal-case">(deprecated)</span></h2>
            <span class="text-[10px] text-amber-300/80">Новые ссылки — через «📊 Отчёт проекта» → «Опубликовать»</span>
          </div>
          <p class="text-xs text-gray-500">Старая публичная ссылка на дашборд проекта. Сохранена для управления ранее выпущенными ссылками; для новых клиентских отчётов используйте модуль «Отчёты».</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <label class="flex flex-col gap-1">
              <span class="text-gray-400 uppercase tracking-wider text-[10px]">Режим payload</span>
              <select v-model="shareForm.mode" class="input">
                <option value="client">Клиент — урезанный (без debug/raw_prompt)</option>
                <option value="analyst">Аналитик — полный payload</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-gray-400 uppercase tracking-wider text-[10px]">Срок действия</span>
              <select v-model.number="shareForm.ttlDays" class="input">
                <option v-for="o in shareTtlOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
          </div>

          <div v-if="project.share_token" class="space-y-2">
            <div class="flex flex-wrap gap-2 items-center">
              <input :value="shareUrl" readonly class="input flex-1 min-w-0 text-xs" />
              <button class="btn-ghost border border-gray-700" @click="copyShare">📋 Скопировать</button>
            </div>
            <div class="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
              <span>Режим: <b class="text-gray-300">{{ project.share_mode || 'client' }}</b></span>
              <span>· {{ shareExpiresLabel }}</span>
              <button class="text-indigo-400 hover:text-indigo-300"
                      @click="updateShare(shareForm)">↻ Обновить параметры</button>
              <button class="text-red-400 hover:text-red-300" @click="revokeShare">Сбросить ссылку</button>
            </div>
          </div>
          <button v-else class="btn-primary" @click="createShare(shareForm)">🌐 Создать публичную ссылку</button>
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
