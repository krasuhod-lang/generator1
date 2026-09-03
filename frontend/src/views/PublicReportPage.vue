<script setup>
/**
 * PublicReportPage — публичная read-only страница отчёта на /r/:uuid.
 * Не требует авторизации. Использует raw axios (без bearer).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import ReportRenderer from '../components/reports/ReportRenderer.vue';
import PinGate from '../components/reports/PinGate.vue';
import GranularityToggle from '../components/reports/GranularityToggle.vue';
import { collectReportChartImages, downloadBlob } from '../utils/reportExport.js';

const route = useRoute();
const router = useRouter();
const loading = ref(true);
let requestSeq = 0;
// ТЗ #1: при applyRange меняем только данные, не «мигаем» всем отчётом.
// refreshing — отдельный флаг, который рисует локальный оверлей над уже
// отображённым ReportRenderer, чтобы клиент видел старые графики до
// прихода свежих и не смотрел на пустой экран.
const refreshing = ref(false);
const error = ref(null);
const expired = ref(false); // 410 → показать «запросить новую ссылку»
const needPin = ref(false);
const pinError = ref(null);
const pinLoading = ref(false);
const pinRef = ref(null);
const result = ref(null); // { uuid, mode, title, period, project, payload }
const pinLength = ref(4); // адаптируется по длине ввода (4..8)
const viewRange = ref({ from: '', to: '', granularity: 'month' });
const exporting = ref(false);
const previewRef = ref(null);

// Вкладки — presentation-layer публичного board. Они не меняют URL,
// payload, режим live/snapshot или постоянную ссылку отчёта.
const TAB_DEFINITIONS = [
  { id: 'overview', label: 'Обзор', description: 'Итоги и точки роста', icon: '⌂' },
  { id: 'search', label: 'Поиск', description: 'GSC · Яндекс · Keys.so', icon: '↗' },
  { id: 'pages', label: 'Страницы', description: 'URL и запросы', icon: '▦' },
  { id: 'metrika', label: 'Метрика', description: 'Визиты · конверсии', icon: '◒' },
  { id: 'tasks', label: 'Работы', description: 'Задачи и результаты', icon: '✓' },
  { id: 'work-summary', label: 'Сводка работ', description: 'Что сделано по неделям', icon: '✦' },
  { id: 'insights', label: 'AI-анализ', description: 'Причины и следующие шаги', icon: '◎' },
];
const activeTab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'overview');

function hasPageBreakdown(data) {
  const q = data?.queries;
  if (!q) return false;
  const pages = q.pages || {};
  return Object.values(pages).some((rows) => Array.isArray(rows) && rows.length > 0)
    || (Array.isArray(q.top_pages_commercial) && q.top_pages_commercial.length > 0)
    || (Array.isArray(q.top_pages_informational) && q.top_pages_informational.length > 0);
}

const availableTabs = computed(() => {
  const data = result.value?.payload?.data || {};
  const summary = result.value?.payload?.summary || {};
  return TAB_DEFINITIONS.filter((tab) => {
    if (tab.id === 'overview' || tab.id === 'tasks') return true;
    if (tab.id === 'search') return Boolean(data.gsc || data.ywm || data.keys_so || data.position);
    if (tab.id === 'pages') return hasPageBreakdown(data);
    if (tab.id === 'metrika') return Boolean(data.metrika && (data.metrika.status === 'ready' || data.metrika.counter_id));
    if (tab.id === 'work-summary') {
      const work = summary.work_summary;
      return Boolean(work && (work.overview
        || (Array.isArray(work.weeks) && work.weeks.length)
        || (Array.isArray(work.period_points) && work.period_points.length)));
    }
    if (tab.id === 'insights') {
      return Boolean(summary.executive_summary
        || (Array.isArray(summary.growth_attribution) && summary.growth_attribution.length)
        || (Array.isArray(summary.quick_wins) && summary.quick_wins.length));
    }
    return false;
  });
});
const activeTabLabel = computed(() => availableTabs.value.find((tab) => tab.id === activeTab.value)?.label || 'Обзор');
function selectTab(id) {
  if (!availableTabs.value.some((tab) => tab.id === id)) return;
  activeTab.value = id;
  router.replace({ query: { ...route.query, tab: id } }).catch(() => {});
  // Не скроллим при каждом клике: вкладочный board должен оставаться на
  // текущем экране, особенно на мобильном устройстве.
}

function focusTab(id) {
  requestAnimationFrame(() => {
    document.querySelector(`[data-report-tab="${id}"]`)?.focus();
  });
}

function onTabsKeydown(event) {
  const ids = availableTabs.value.map((tab) => tab.id);
  const current = ids.indexOf(activeTab.value);
  if (current < 0 || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  let next = current;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % ids.length;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + ids.length) % ids.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = ids.length - 1;
  selectTab(ids[next]);
  focusTab(ids[next]);
}

watch(availableTabs, (tabs) => {
  if (!tabs.some((tab) => tab.id === activeTab.value)) activeTab.value = tabs[0]?.id || 'overview';
}, { immediate: true });

const api = axios.create({ withCredentials: true, timeout: 30000 });

async function load() {
  const seq = ++requestSeq;
  loading.value = true; error.value = null; needPin.value = false; expired.value = false;
  try {
    const { data } = await api.get(`/api/public/report/${route.params.uuid}`, {
      params: {
        from: typeof route.query.from === 'string' ? route.query.from : undefined,
        to: typeof route.query.to === 'string' ? route.query.to : undefined,
        granularity: typeof route.query.granularity === 'string' ? route.query.granularity : undefined,
      },
    });
    if (seq !== requestSeq) return;
    result.value = data;
    if (data?.payload?.data?.period) {
      viewRange.value = {
        from: data.payload.data.period.from || '',
        to: data.payload.data.period.to || '',
        granularity: data.payload.data.period.granularity || 'month',
      };
    }
  } catch (err) {
    if (seq !== requestSeq) return;
    if (err.response?.status === 403 && err.response?.data?.error === 'password_required') {
      needPin.value = true;
    } else if (err.response?.status === 410) {
      expired.value = true;
      error.value = err.response.data?.error === 'expired'
        ? 'Срок действия ссылки истёк.'
        : 'Ссылка отозвана.';
    } else if (err.response?.status === 404) {
      error.value = 'Отчёт не найден.';
    } else {
      error.value = err.response?.data?.error || err.message || 'Ошибка';
    }
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

onMounted(load);

async function applyRange() {
  // Snapshot/live client may narrow the published window; only the latest
  // request is allowed to replace the report, so A→B→C cannot finish out of order.
  const seq = ++requestSeq;
  refreshing.value = true;
  const applied = { ...viewRange.value };
  router.replace({ query: { ...route.query, ...applied, tab: activeTab.value } }).catch(() => {});
  try {
    const { data } = await api.get(`/api/public/report/${route.params.uuid}`, { params: applied });
    if (seq === requestSeq) result.value = data;
  } catch (err) {
    if (seq === requestSeq) error.value = err.response?.data?.error || err.message || 'Не удалось обновить период';
  } finally {
    if (seq === requestSeq) refreshing.value = false;
  }
}

async function submitPin(pin) {
  pinLoading.value = true; pinError.value = null;
  try {
    await api.post(`/api/public/report/${route.params.uuid}/unlock`, { pin });
    needPin.value = false;
    await load();
  } catch (err) {
    if (err.response?.status === 401) pinError.value = 'Неверный PIN. Попробуйте ещё раз.';
    else pinError.value = err.response?.data?.error || err.message || 'Ошибка';
    pinRef.value?.reset();
  } finally {
    pinLoading.value = false;
  }
}

function trySetPinLength(n) {
  // Если сервер сообщает требуемую длину PIN — можно адаптировать.
  // Сейчас фиксированно 4. Оставляем хук на будущее.
  pinLength.value = Math.max(4, Math.min(8, n));
}

async function exportDocx() {
  if (!previewRef.value) return;
  exporting.value = true;
  try {
    const chartImages = await collectReportChartImages(previewRef.value);
    const { data } = await api.post(`/api/public/report/${route.params.uuid}/export.docx`, {
      ...viewRange.value,
      chart_images: chartImages,
    }, { responseType: 'blob' });
    downloadBlob(data, `${(result.value?.title || 'report').replace(/[^\wа-яё-]+/gi, '_')}.docx`);
  } finally {
    exporting.value = false;
  }
}
async function exportPdf() {
  if (!previewRef.value) return;
  exporting.value = true;
  try {
    const chartImages = await collectReportChartImages(previewRef.value);
    const { data } = await api.post(`/api/public/report/${route.params.uuid}/export.pdf`, {
      ...viewRange.value,
      chart_images: chartImages,
    }, { responseType: 'blob' });
    downloadBlob(data, `${(result.value?.title || 'report').replace(/[^\wа-яё-]+/gi, '_')}.pdf`);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="public-page">
    <div v-if="loading" class="status">Загрузка отчёта…</div>
    <div v-else-if="error" class="status err">
      <div>{{ error }}</div>
      <!-- Доп. правка: при 410 показать действенную подсказку
           «запросить новую ссылку» — без этого клиенты теряются. -->
      <div v-if="expired" class="status-hint">
        Обратитесь к вашему SEO-аналитику с просьбой выпустить новую ссылку
        на отчёт.
      </div>
    </div>
    <PinGate v-else-if="needPin" ref="pinRef" :length="pinLength" :loading="pinLoading" :error="pinError" @submit="submitPin" />
    <div v-else-if="result" class="public-shell"
         :style="{ '--accent': result.project?.color_accent || '#0071e3' }">
      <div class="public-inner">
        <section class="public-project-header" aria-label="Информация о проекте">
          <div class="public-project-brand">
            <div v-if="result.project?.logo_url" class="public-project-logo-wrap">
              <img :src="result.project.logo_url" :alt="result.project.name || 'Логотип проекта'" class="public-project-logo" />
            </div>
            <div v-else class="public-project-logo-fallback" aria-hidden="true">{{ (result.project?.name || 'П').slice(0, 1).toUpperCase() }}</div>
            <div class="public-project-copy">
              <span class="public-project-kicker">SEO-ОТЧЁТ</span>
              <h1>{{ result.project?.name || result.title || 'Отчёт проекта' }}</h1>
              <a v-if="result.project?.url" :href="result.project.url" target="_blank" rel="noopener noreferrer">{{ result.project.url }}</a>
            </div>
          </div>
          <div class="public-project-meta">
            <span class="public-project-period">{{ result.period || 'Период не указан' }}</span>
            <span class="public-project-status" :class="{ snapshot: result.mode !== 'live' }">{{ result.mode === 'live' ? 'Live' : 'Снимок' }}</span>
          </div>
        </section>
        <div class="public-toolbar">
          <div class="range-grid">
            <input v-model="viewRange.from" type="date" />
            <input v-model="viewRange.to" type="date" />
            <GranularityToggle v-model="viewRange.granularity" size="sm" />
          </div>
          <div class="toolbar-actions">
            <button class="tool-btn" :disabled="refreshing" @click="applyRange">{{ refreshing ? 'Обновление…' : 'Применить' }}</button>
            <button class="tool-btn" :disabled="exporting" @click="exportDocx">{{ exporting ? 'Экспорт…' : 'Скачать .docx' }}</button>
            <button class="tool-btn" :disabled="exporting" @click="exportPdf">{{ exporting ? 'Экспорт…' : 'Скачать .pdf' }}</button>
          </div>
        </div>
        <nav v-if="availableTabs.length > 1" class="public-tabs-shell" aria-label="Разделы отчёта">
          <div class="public-tabs-heading">
            <div>
              <span class="public-tabs-kicker">ПУБЛИЧНЫЙ ОТЧЁТ</span>
              <strong>Раздел отчёта</strong>
            </div>
            <span class="public-tabs-current">{{ activeTabLabel }}</span>
          </div>
          <div class="public-tabs" role="tablist" aria-label="Навигация по разделам" @keydown="onTabsKeydown">
            <button
              v-for="tab in availableTabs"
              :key="tab.id"
              type="button"
              role="tab"
              class="public-tab"
              :class="{ active: activeTab === tab.id }"
              :aria-selected="activeTab === tab.id"
              :aria-controls="'report-panel'"
              :tabindex="activeTab === tab.id ? 0 : -1"
              :data-report-tab="tab.id"
              @click="selectTab(tab.id)"
            >
              <span class="public-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
              <span class="public-tab-copy">
                <span>{{ tab.label }}</span>
                <small>{{ tab.description }}</small>
              </span>
            </button>
          </div>
        </nav>
        <div id="report-panel" ref="previewRef" class="public-preview" role="tabpanel" :aria-label="activeTabLabel">
          <ReportRenderer
            :data="result.payload?.data"
            :summary="result.payload?.summary || {}"
            :work-summary="result.payload?.summary?.work_summary || null"
            :tasks-blocks="result.payload?.tasks_blocks || []"
            :title="result.title"
            :period="result.period"
            :project="result.project"
            :mode="result.mode"
            view-mode="client"
            :captured-at="result.payload?.captured_at"
            :chart-config="result.payload?.config?.charts || {}"
            :active-tab="activeTab"
            :show-header="false"
            :show-anchor-nav="false"
            :readonly="true" />
          <!-- ТЗ #1: локальный оверлей при applyRange — отчёт остаётся
               видимым (старые графики «затухают»), сверху индикатор. -->
          <div v-if="refreshing" class="public-refresh-overlay" aria-live="polite">
            <span class="public-refresh-spinner" />
            <span>Обновление данных за выбранный период…</span>
          </div>
        </div>
        <div class="public-footer">
          <span>Отчёт сформирован автоматически · Smart Report Builder</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.public-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #f5f5f7 0%, #ececef 100%);
  color: #1d1d1f;
  color-scheme: light;
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.01em;
}
.status { padding: 80px 24px; text-align: center; color: #6e6e73; font-size: 16px; }
.status.err { color: #d70015; }
.status-hint { color: #6e6e73; font-size: 13px; margin-top: 12px; max-width: 420px; margin-left: auto; margin-right: auto; }
.public-shell { max-width: 1080px; margin: 0 auto; }
.public-inner { display: flex; flex-direction: column; gap: 16px; }
.public-footer { text-align: center; padding: 16px 0 36px; color: #86868b; font-size: 12px; letter-spacing: 0.02em; }
.public-project-header {
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  padding: 20px 22px; background: #fff; border: 1px solid rgba(60,60,67,0.12);
  border-radius: 18px; box-shadow: 0 8px 24px rgba(15,23,42,0.06);
}
.public-project-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.public-project-logo-wrap, .public-project-logo-fallback { width: 56px; height: 56px; flex: 0 0 56px; border-radius: 16px; overflow: hidden; }
.public-project-logo { width: 100%; height: 100%; display: block; object-fit: contain; background: #f7f7f8; }
.public-project-logo-fallback { display: grid; place-items: center; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 86%, #fff), var(--accent)); color: #fff; font-size: 26px; font-weight: 800; }
.public-project-copy { min-width: 0; }
.public-project-kicker { display: block; margin-bottom: 4px; color: #86868b; font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.public-project-copy h1 { margin: 0; color: #1d1d1f; font-size: clamp(22px, 3vw, 32px); line-height: 1.05; font-weight: 760; letter-spacing: -.035em; }
.public-project-copy a { display: inline-block; max-width: min(62vw, 620px); margin-top: 6px; overflow: hidden; color: #6e6e73; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
.public-project-copy a:hover { color: var(--accent); text-decoration: underline; }
.public-project-meta { display: flex; align-items: flex-end; flex-direction: column; gap: 9px; flex: 0 0 auto; }
.public-project-period { color: #6e6e73; font-size: 13px; white-space: nowrap; }
.public-project-status { padding: 6px 10px; border-radius: 999px; background: rgba(10,132,255,.10); color: #0a63c7; font-size: 12px; font-weight: 750; }
.public-project-status.snapshot { background: rgba(107,114,128,.12); color: #4b5563; }
.public-toolbar {
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  background: #fff; border: 1px solid rgba(60,60,67,0.12); border-radius: 16px; padding: 12px;
}
.range-grid { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; flex: 1; }
.range-grid input, .range-grid select {
  border: 1px solid rgba(60,60,67,0.18); border-radius: 10px; padding: 9px 12px; font: inherit; background: #fff;
}
.toolbar-actions { display: flex; gap: 8px; }
.tool-btn {
  border: 0; background: #0a84ff; color: #fff; border-radius: 10px; padding: 10px 14px; cursor: pointer;
}
.tool-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ТЗ #1: локальный лоадер только в зоне отчёта (без миганий всей страницы). */
.public-tabs-shell {
  position: sticky;
  top: 12px;
  z-index: 7;
  padding: 11px;
  border: 1px solid rgba(60,60,67,0.12);
  border-radius: 18px;
  background: rgba(255,255,255,0.88);
  box-shadow: 0 8px 26px rgba(15,23,42,0.08);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.public-tabs-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 5px 9px;
  color: #1d1d1f;
  font-size: 13px;
}
.public-tabs-heading > div { display: flex; flex-direction: column; gap: 2px; }
.public-tabs-kicker { color: #86868b; font-size: 9px; font-weight: 800; letter-spacing: .14em; }
.public-tabs-current { color: #0a84ff; font-size: 12px; font-weight: 700; }
.public-tabs { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.public-tab {
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid rgba(60,60,67,0.11);
  border-radius: 14px;
  background: rgba(248,248,250,0.88);
  color: #424245;
  text-align: left;
  cursor: pointer;
  transition: background .18s ease, border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}
.public-tab:hover { background: #fff; border-color: rgba(10,132,255,0.25); }
.public-tab:focus-visible { outline: 3px solid rgba(10,132,255,0.25); outline-offset: 2px; }
.public-tab:active { transform: scale(.985); }
.public-tab.active {
  border-color: rgba(10,132,255,0.30);
  background: linear-gradient(135deg, rgba(10,132,255,0.12), rgba(255,255,255,0.98));
  box-shadow: 0 5px 16px rgba(10,132,255,0.12);
  color: #0a63c7;
}
.public-tab-icon {
  display: inline-grid;
  place-items: center;
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: rgba(60,60,67,0.08);
  color: #6e6e73;
  font-size: 16px;
  font-weight: 700;
}
.public-tab.active .public-tab-icon { background: #0a84ff; color: #fff; }
.public-tab-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.public-tab-copy > span { font-size: 13px; font-weight: 750; white-space: nowrap; }
.public-tab-copy small { color: #86868b; font-size: 10px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.public-tab.active .public-tab-copy small { color: #4b77a8; }
.public-preview { position: relative; }
.public-refresh-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  padding-top: 80px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  color: #1d1d1f;
  font-size: 13px;
  z-index: 5;
  border-radius: 12px;
  pointer-events: none;
}
.public-refresh-spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(10, 132, 255, 0.25);
  border-top-color: #0a84ff;
  border-radius: 50%;
  animation: pubrep-spin 0.8s linear infinite;
}
@keyframes pubrep-spin { to { transform: rotate(360deg); } }

@media (min-width: 375px) { .public-page { padding: 20px 14px; } }
@media (min-width: 768px) { .public-page { padding: 40px 20px; } }
@media (max-width: 960px) {
  .public-tabs { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
  .public-tab { flex: 0 0 174px; }
}
@media (max-width: 720px) {
  .public-project-header { align-items: flex-start; flex-direction: column; padding: 16px; gap: 12px; }
  .public-project-logo-wrap, .public-project-logo-fallback { width: 48px; height: 48px; flex-basis: 48px; border-radius: 14px; }
  .public-project-copy h1 { font-size: 23px; }
  .public-project-copy a { max-width: calc(100vw - 120px); }
  .public-project-meta { width: 100%; align-items: flex-start; flex-direction: row; justify-content: space-between; }
  .range-grid { grid-template-columns: 1fr; }
  .public-toolbar { flex-direction: column; gap: 8px; }
  .toolbar-actions { justify-content: stretch; }
  .tool-btn { flex: 1; text-align: center; }
  .public-tabs-shell { top: 8px; padding: 9px; border-radius: 15px; }
  .public-tab { flex-basis: 164px; min-height: 58px; padding: 9px 10px; }
}
@media (max-width: 480px) {
  .public-tabs-heading { padding-bottom: 7px; }
  .public-tab { flex-basis: 148px; }
  .public-tab-copy > span { font-size: 12px; }
  .public-tab-copy small { font-size: 9px; }
}
@media (max-width: 480px) {
  .public-page { padding: 10px 8px; }
  .public-toolbar { padding: 8px; border-radius: 12px; }
  .tool-btn { padding: 10px 10px; font-size: 13px; }
}
</style>
