<script setup>
import { computed, ref } from 'vue';
import DOMPurify from 'dompurify';
import api from '../../api.js';
import ReportTrendChart from './ReportTrendChart.vue';
import PositionChart from '../PositionChart.vue';
import ReportModulesCard from './ReportModulesCard.vue';
import DataStateWrapper from '../DataStateWrapper.vue';
import ExecutiveHeadline from './ExecutiveHeadline.vue';

const props = defineProps({
  data:        { type: Object, default: () => ({}) },
  summary:     { type: Object, default: () => ({}) },
  tasksBlocks: { type: Array,  default: () => [] },
  title:       { type: String, default: '' },
  period:      { type: String, default: '' },
  project:     { type: Object, default: () => ({}) },
  mode:        { type: String, default: 'live' },
  // analyst|client — режим отображения (берётся из useViewModeStore родителем).
  // Не путать с `mode` (snapshot|live).
  viewMode:    { type: String, default: 'analyst' },
  capturedAt:  { type: String, default: null },
  readonly:    { type: Boolean, default: true },
  loading:     { type: Boolean, default: false },
});
const emit = defineEmits(['update:tasksBlocks']);

const isClient = computed(() => props.viewMode === 'client');

const accent = computed(() => props.project?.color_accent || '#0a84ff');
const accentBg = computed(() => `${accent.value}15`);

// Keys.so search engine toggle (Яндекс / Google)
const keysEngine = ref('yandex');
const hasGoogleKeys = computed(() => {
  const g = props.data?.keys_so?.google;
  return g && g.series && g.series.length > 0;
});

const hasModules = computed(() => {
  const m = props.data?.modules;
  return !!(m && !m.disabled && !m.error && (
    m.striking_distance || m.ctr_gap || m.content_health || m.off_page || m.tech_audit
  ));
});

// --- Section state helpers ---
function sectionState(section) {
  if (!section) return 'empty';
  if (section.error) return 'error';
  if (section.connected === false) return 'disconnected';
  if (!section.series?.length) return 'empty';
  return 'ok';
}

function sectionError(section) {
  return section?.error || '';
}

// --- Navigation items ---
const navItems = computed(() => {
  const items = [{ id: 'summary', label: 'Сводка' }];
  if (props.data?.gsc) items.push({ id: 'gsc', label: 'GSC' });
  if (props.data?.ywm) items.push({ id: 'ywm', label: 'Яндекс' });
  if (props.data?.keys_so) items.push({ id: 'keys-so', label: 'Keys.so' });
  if (hasModules.value) items.push({ id: 'modules', label: 'Точки роста' });
  items.push({ id: 'tasks', label: 'Работы' });
  if (props.summary?.executive_summary || props.summary?.highlights?.length) {
    items.push({ id: 'ai-analysis', label: 'AI-выводы' });
  }
  return items;
});

function scrollTo(id) {
  const el = document.getElementById(`report-${id}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Глобальная completeness-предупреждалка (бэкенд складывает data.completeness/integrations).
const completenessBanner = computed(() => {
  const c = props.data?.completeness;
  if (!c) return null;
  const partial = Array.isArray(c.partial_sources) ? c.partial_sources : [];
  const failed  = Array.isArray(c.failed_sources)  ? c.failed_sources  : [];
  if (!partial.length && !failed.length) return null;
  return { partial, failed, level: failed.length ? 'error' : 'partial' };
});

// Метка-аннотация «неполный месяц» для последней точки графика, если
// `series_meta.last_period_partial=true`. Бакет = дата самой последней
// точки в series (она же первая дата неполного месяца для granularity=month
// или сама дата для day). Источник истины — backend (см. _seriesMeta).
function _partialAnnotation(section) {
  if (!section?.series_meta?.last_period_partial) return null;
  const series = section.series || [];
  if (!series.length) return null;
  const lastDate = series[series.length - 1]?.date;
  if (!lastDate) return null;
  return {
    date: lastDate,
    bucket: lastDate,
    label: '⏳ неполный месяц',
    type: 'partial-period',
  };
}

const gscChart = computed(() => {
  const series = props.data?.gsc?.series || [];
  if (!series.length) return null;
  const taskAnnotations = props.data?.tasks?.annotations || [];
  const partial = _partialAnnotation(props.data?.gsc);
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: 'Клики', color: accent.value, data: series.map((r) => Number(r.clicks) || 0) },
      { label: 'Показы', color: '#8b95a7', data: series.map((r) => Number(r.impressions) || 0) },
      { label: 'CTR', color: '#10b981', data: series.map((r) => Number(r.ctr) || 0), yAxisID: 'y2' },
    ],
    annotations: partial ? [...taskAnnotations, partial] : taskAnnotations,
    showSecondAxis: true,
  };
});

const ywmChart = computed(() => {
  const series = props.data?.ywm?.series || [];
  if (!series.length) return null;
  const taskAnnotations = props.data?.tasks?.annotations || [];
  const partial = _partialAnnotation(props.data?.ywm);
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: 'Клики (Яндекс)', color: '#ff5a3c', data: series.map((r) => Number(r.clicks) || 0) },
      { label: 'Показы (Яндекс)', color: '#ffb38a', data: series.map((r) => Number(r.impressions) || 0) },
      { label: 'CTR', color: '#ef4444', data: series.map((r) => Number(r.ctr) || 0), yAxisID: 'y2' },
    ],
    annotations: partial ? [...taskAnnotations, partial] : taskAnnotations,
    showSecondAxis: true,
  };
});

const keysChart = computed(() => {
  const engine = keysEngine.value;
  const engineData = engine === 'google' ? props.data?.keys_so?.google : props.data?.keys_so?.yandex;
  const series = engineData?.series || (engine === 'yandex' ? (props.data?.keys_so?.series || []) : []);
  if (!series.length) return null;
  const colorVis = engine === 'google' ? '#ea4335' : '#6e5dc6';
  const label = engine === 'google' ? 'Google' : 'Яндекс';
  return {
    labels: series.map((r) => r.date),
    datasets: [
      { label: `Видимость (${label})`, color: colorVis, data: series.map((r) => Number(r.visibility) || 0), yAxisID: 'y2' },
      { label: 'ТОП-10', color: '#2563eb', data: series.map((r) => Number(r.keywords_top10) || 0) },
      { label: 'ТОП-50', color: '#f59e0b', data: series.map((r) => Number(r.keywords_top50) || 0) },
    ],
    annotations: props.data?.tasks?.annotations || [],
    showSecondAxis: true,
  };
});

const totals = computed(() => {
  const out = [];
  const g = props.data?.gsc?.totals;
  if (g) {
    out.push({ label: 'Google клики', value: Number(g.clicks || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Google показы', value: Number(g.impressions || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Google CTR', value: g.ctr != null ? `${Number(g.ctr).toFixed(2)}%` : '—' });
    out.push({ label: 'Google ср. позиция', value: g.position != null ? Number(g.position).toFixed(1) : '—' });
  }
  const y = props.data?.ywm?.totals;
  if (y) {
    out.push({ label: 'Яндекс клики', value: Number(y.clicks || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Яндекс показы', value: Number(y.impressions || 0).toLocaleString('ru-RU') });
    out.push({ label: 'Яндекс CTR', value: y.ctr != null ? `${Number(y.ctr).toFixed(2)}%` : '—' });
  }
  const k = props.data?.keys_so?.yandex?.current || props.data?.keys_so?.current;
  if (k) {
    out.push({ label: 'Видимость Яндекс (Keys.so)', value: k.visibility != null ? Number(k.visibility).toFixed(2) : '—' });
    out.push({ label: 'ТОП-10 Яндекс', value: Number(k.top10 || 0).toLocaleString('ru-RU') });
    out.push({ label: 'ТОП-50 Яндекс', value: Number(k.top50 || 0).toLocaleString('ru-RU') });
  }
  const kg = props.data?.keys_so?.google?.current;
  if (kg) {
    out.push({ label: 'Видимость Google (Keys.so)', value: kg.visibility != null ? Number(kg.visibility).toFixed(2) : '—' });
    out.push({ label: 'ТОП-10 Google', value: Number(kg.top10 || 0).toLocaleString('ru-RU') });
    out.push({ label: 'ТОП-50 Google', value: Number(kg.top50 || 0).toLocaleString('ru-RU') });
  }
  const p = props.data?.position?.summary;
  if (p) {
    out.push({ label: 'Средняя позиция', value: p.avg_position != null ? Number(p.avg_position).toFixed(1) : '—' });
    out.push({ label: 'Запросов в ТОП-10', value: Number(p.top10 || 0).toLocaleString('ru-RU') });
  }
  return out;
});

const growthItems = computed(() => {
  const raw = props.summary?.growth_attribution;
  if (!raw) return [];
  if (typeof raw === 'string') return [{ metric: 'Общая динамика', trend_direction: '', delta_value: '', delta_pct: '', attribution: raw, conclusion: '', forecast: '', weak_zones: '' }];
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => ({
    metric: String(g?.metric || '').trim(),
    trend_direction: String(g?.trend_direction || '').trim(),
    delta_value: String(g?.delta_value || '').trim(),
    delta_pct: String(g?.delta_pct || '').trim(),
    attribution: String(g?.attribution || '').trim(),
    conclusion: String(g?.conclusion || '').trim(),
    forecast: String(g?.forecast || '').trim(),
    weak_zones: String(g?.weak_zones || '').trim(),
  })).filter((g) => g.metric || g.attribution || g.conclusion || g.forecast || g.weak_zones);
});

const quickWinsItems = computed(() => (
  Array.isArray(props.summary?.quick_wins) && props.summary.quick_wins.length
    ? props.summary.quick_wins
    : (props.data?.position?.quick_wins || [])
));

const normalizedTasks = computed(() => normalizeBlocks(props.tasksBlocks));

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return [];
  if (blocks[0]?.month && Array.isArray(blocks[0]?.sections)) return blocks;
  return [{
    month: 'Выполненные работы',
    sections: blocks.map((block) => ({
      title: block.section || 'Раздел',
      tasks: (block.items || []).map((item) => ({ title: String(item || ''), description_html: '' })),
    })),
  }];
}

function updateBlocks(next) {
  emit('update:tasksBlocks', next);
}
function cloneBlocks() {
  return JSON.parse(JSON.stringify(normalizedTasks.value));
}
function addMonth() {
  const next = cloneBlocks();
  next.push({ month: new Date().toISOString().slice(0, 7), sections: [] });
  updateBlocks(next);
}
function removeMonth(i) {
  const next = cloneBlocks();
  next.splice(i, 1);
  updateBlocks(next);
}
function addSection(i) {
  const next = cloneBlocks();
  next[i].sections.push({ title: 'Новый раздел', tasks: [] });
  updateBlocks(next);
}
function addTask(i, j) {
  const next = cloneBlocks();
  next[i].sections[j].tasks.push({ title: 'Новая задача', description_html: '' });
  updateBlocks(next);
}
function updateMonth(i, value) {
  const next = cloneBlocks();
  next[i].month = value;
  updateBlocks(next);
}
function updateSection(i, j, value) {
  const next = cloneBlocks();
  next[i].sections[j].title = value;
  updateBlocks(next);
}
function updateTask(i, j, k, key, value) {
  const next = cloneBlocks();
  next[i].sections[j].tasks[k][key] = value;
  updateBlocks(next);
}
function removeSection(i, j) {
  const next = cloneBlocks();
  next[i].sections.splice(j, 1);
  updateBlocks(next);
}
function removeTask(i, j, k) {
  const next = cloneBlocks();
  next[i].sections[j].tasks.splice(k, 1);
  updateBlocks(next);
}

function autoLinkify(html) {
  // Skip text that's already inside <a ...>...</a> tags.
  // Split by existing anchor tags, only linkify the non-anchor parts.
  const parts = (html || '').split(/(<a\s[^>]*>.*?<\/a>)/gi);
  return parts.map((part) => {
    // If it's an existing anchor tag, keep as-is
    if (/^<a\s/i.test(part)) return part;
    // Convert plain URLs not already inside an attribute value
    return part.replace(
      /(?<![="'])(\bhttps?:\/\/[^\s<>"')\]]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
    );
  }).join('');
}

function safeHtml(value) {
  const linked = autoLinkify(value || '');
  return DOMPurify.sanitize(linked, {
    ALLOWED_TAGS: ['a', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'img'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'width', 'style'],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|\/uploads\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i,
  });
}

// ── Image upload helpers ───────────────────────────────────────────────────
const uploadingImage = ref(false);

async function uploadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  const form = new FormData();
  form.append('image', file);
  uploadingImage.value = true;
  try {
    const { data } = await api.post('/reports/upload-image', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data?.url || null;
  } catch {
    return null;
  } finally {
    uploadingImage.value = false;
  }
}

async function onDescriptionPaste(ev, i, j, k) {
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const url = await uploadImageFile(file);
      if (!url) return;
      const next = cloneBlocks();
      const task = next[i].sections[j].tasks[k];
      task.description_html = (task.description_html || '') + `\n<img src="${url}" alt="screenshot" style="max-width:100%" />`;
      updateBlocks(next);
      return;
    }
  }
}

async function onFileSelect(ev, i, j, k) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  const url = await uploadImageFile(file);
  if (!url) return;
  const next = cloneBlocks();
  const task = next[i].sections[j].tasks[k];
  task.description_html = (task.description_html || '') + `\n<img src="${url}" alt="${file.name}" style="max-width:100%" />`;
  updateBlocks(next);
  ev.target.value = '';
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU');
}

// --- Chart growth dynamics helpers ---
// Дельты считаются ТОЛЬКО по полным месяцам (ТЗ §3). Если backend отдал
// `totals_complete` и `prev_totals_complete` — используем их напрямую. Иначе
// (старые черновики без series_meta) fallback к попарному сравнению последних
// двух точек series, но и тут защищаемся от ситуации «последняя точка ещё
// неполная» (series_meta.last_period_partial) и берём предпоследнюю.
function _deltaFromTotals(section, key) {
  if (!section) return null;
  const cur = section.totals_complete;
  const prev = section.prev_totals_complete;
  if (cur && Number.isFinite(Number(cur[key]))) {
    const last = Number(cur[key]) || 0;
    const prevVal = prev && Number.isFinite(Number(prev[key])) ? (Number(prev[key]) || 0) : null;
    if (prevVal == null) return { last, prev: 0, diff: 0, pct: null, source: 'complete-no-prev' };
    const diff = last - prevVal;
    const pct = prevVal > 0 ? Math.round((diff / prevVal) * 1000) / 10 : null;
    return { last, prev: prevVal, diff, pct, source: 'complete' };
  }
  return null;
}
function _computeDeltas(series, key, opts = {}) {
  if (!Array.isArray(series) || series.length < 2) return null;
  // Если последняя точка — частичный месяц, не сравниваем с ней (ТЗ §3),
  // сдвигаемся на одну позицию назад.
  const partial = opts && opts.lastPartial;
  const end = partial ? series.length - 2 : series.length - 1;
  if (end < 1) return null;
  const last = Number(series[end]?.[key]) || 0;
  const prev = Number(series[end - 1]?.[key]) || 0;
  if (!prev && !last) return null;
  const diff = last - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 1000) / 10 : null;
  return { last, prev, diff, pct, source: partial ? 'series-skip-partial' : 'series' };
}

const gscDeltas = computed(() => {
  const sec = props.data?.gsc || {};
  const series = sec.series || [];
  const partial = !!sec.series_meta?.last_period_partial;
  return {
    clicks:      _deltaFromTotals(sec, 'clicks')      || _computeDeltas(series, 'clicks',      { lastPartial: partial }),
    impressions: _deltaFromTotals(sec, 'impressions') || _computeDeltas(series, 'impressions', { lastPartial: partial }),
  };
});

const ywmDeltas = computed(() => {
  const sec = props.data?.ywm || {};
  const series = sec.series || [];
  const partial = !!sec.series_meta?.last_period_partial;
  return {
    clicks:      _deltaFromTotals(sec, 'clicks')      || _computeDeltas(series, 'clicks',      { lastPartial: partial }),
    impressions: _deltaFromTotals(sec, 'impressions') || _computeDeltas(series, 'impressions', { lastPartial: partial }),
  };
});

const keysDeltas = computed(() => {
  const engine = keysEngine.value;
  const engineData = engine === 'google' ? props.data?.keys_so?.google : props.data?.keys_so?.yandex;
  const series = engineData?.series || (engine === 'yandex' ? (props.data?.keys_so?.series || []) : []);
  // Keys.so пока не даёт series_meta — сравнение «последняя vs предыдущая»
  // точка остаётся как fallback. Для месячного среза это не критично.
  return {
    top10: _computeDeltas(series, 'keywords_top10'),
    top50: _computeDeltas(series, 'keywords_top50'),
  };
});

// Период «за полные месяцы N — M» для подписи под KPI / дельтами.
const completePeriodLabel = computed(() => {
  const meta = props.data?.gsc?.series_meta || props.data?.ywm?.series_meta;
  if (!meta || !Array.isArray(meta.monthly_periods)) return '';
  const completes = meta.monthly_periods.filter((m) => m.is_complete);
  if (!completes.length) return '';
  const first = completes[0].key;
  const last  = completes[completes.length - 1].key;
  return first === last ? first : `${first} — ${last}`;
});

// Глобальный флаг «в окне нет ни одного полного месяца» → KPI/дельты
// показываем абсолютные, проценты роста скрываем, баннер предупреждаем.
const noCompleteMonths = computed(() => {
  const gscMeta = props.data?.gsc?.series_meta;
  const ywmMeta = props.data?.ywm?.series_meta;
  const g = gscMeta?.complete_months || 0;
  const y = ywmMeta?.complete_months || 0;
  return g === 0 && y === 0 && ((props.data?.gsc?.series?.length || 0) + (props.data?.ywm?.series?.length || 0)) > 0;
});

// Есть ли в окне неполный последний месяц — для маркера на графике.
const hasPartialTail = computed(() => {
  return !!(props.data?.gsc?.series_meta?.last_period_partial
         || props.data?.ywm?.series_meta?.last_period_partial);
});

function formatDelta(d) {
  if (!d) return '';
  const sign = d.pct >= 0 ? '+' : '';
  return d.pct != null ? `${sign}${d.pct}%` : '';
}

function formatAbsDelta(d) {
  if (!d) return '';
  const sign = d.diff >= 0 ? '+' : '';
  return `${sign}${Math.round(d.diff).toLocaleString('ru-RU')}`;
}
</script>

<template>
  <div class="report-renderer" :style="{ '--accent': accent, '--accent-bg': accentBg }">
    <section class="rblk header">
      <div class="header-main">
        <img v-if="project?.logo_url" :src="project.logo_url" :alt="project.name" class="logo" />
        <div>
          <div class="brand">{{ project?.name }}<span v-if="project?.url" class="brand-url"> · {{ project.url }}</span></div>
          <h1 class="rep-title">{{ title }}</h1>
          <div class="rep-period">{{ period }}</div>
        </div>
      </div>
      <div class="header-meta">
        <span v-if="mode === 'live'" class="live-badge">Live</span>
        <span v-else-if="capturedAt" class="snap-badge">Снимок · {{ formatDateTime(capturedAt) }}</span>
      </div>
    </section>

    <!-- Anchor navigation -->
    <nav class="report-nav" v-if="navItems.length > 1">
      <button v-for="item in navItems" :key="item.id"
              class="nav-link" @click="scrollTo(item.id)">{{ item.label }}</button>
    </nav>

    <!-- Глобальная completeness-плашка: видно сразу, что отчёт неполный -->
    <div v-if="completenessBanner"
         class="completeness-banner"
         :class="`completeness-banner--${completenessBanner.level}`"
         role="status">
      <span aria-hidden="true">{{ completenessBanner.level === 'error' ? '⚠' : 'ⓘ' }}</span>
      <span>
        <strong v-if="completenessBanner.level === 'error'">Часть источников недоступна.</strong>
        <strong v-else>Отчёт собран по неполным данным.</strong>
        <template v-if="completenessBanner.failed.length">
          Не удалось получить: {{ completenessBanner.failed.join(', ') }}.
        </template>
        <template v-if="completenessBanner.partial.length">
          Неполные данные: {{ completenessBanner.partial.join(', ') }}.
        </template>
      </span>
    </div>

    <!-- Sprint 2: Executive Headline (client-first). Источник — data.headline,
         собирается в backend/src/services/reports/headlineBuilder.js. -->
    <ExecutiveHeadline :headline="data?.headline"
                       :view-mode="viewMode"
                       :accent="accent" />

    <section v-if="summary?.executive_summary" id="report-ai-analysis" class="rblk">
      <h2>Executive Summary</h2>
      <p class="summary-text">{{ summary.executive_summary }}</p>
    </section>

    <section v-if="summary?.traffic_value || data?.traffic_value?.label" class="rblk savings-card">
      <h2>SEO Traffic Value</h2>
      <p>{{ summary?.traffic_value || data?.traffic_value?.label }}</p>
    </section>

    <section v-if="totals.length" id="report-summary" class="rblk">
      <h2>Ключевые показатели</h2>
      <div v-if="noCompleteMonths" class="period-warning">
        ⚠️ Недостаточно полных месяцев в выбранном периоде — KPI и % роста рассчитываются по неполным данным.
        Расширьте период так, чтобы он включал хотя бы один завершённый месяц.
      </div>
      <p v-else-if="completePeriodLabel" class="period-hint">
        Дельты и % роста — за полные месяцы: <b>{{ completePeriodLabel }}</b><span v-if="hasPartialTail">. Текущий неполный месяц участвует только в графиках.</span>
      </p>
      <div v-if="loading" class="skeleton-grid">
        <div v-for="n in 6" :key="n" class="skeleton-card" />
      </div>
      <div v-else class="totals-grid">
        <div v-for="(t, i) in totals" :key="i" class="total-card">
          <div class="t-label">{{ t.label }}</div>
          <div class="t-value">{{ t.value }}</div>
        </div>
      </div>
    </section>

    <section v-if="summary?.highlights?.length" class="rblk">
      <h2>Главные достижения</h2>
      <ul class="list">
        <li v-for="(item, idx) in summary.highlights" :key="idx">{{ typeof item === 'string' ? item : `${item.title || ''} ${item.detail || ''}`.trim() }}</li>
      </ul>
    </section>

    <!-- Google Search Console -->
    <section id="report-gsc" class="rblk" data-report-chart="gsc" data-report-chart-title="Google Search Console">
      <h2>Google Search Console</h2>
      <p class="chart-desc">Клики, показы и CTR из органической выдачи Google за выбранный период.</p>
      <div v-if="gscDeltas.clicks || gscDeltas.impressions" class="chart-deltas">
        <span v-if="gscDeltas.clicks" class="delta-badge" :class="{ up: gscDeltas.clicks.diff >= 0, down: gscDeltas.clicks.diff < 0 }">
          Клики: {{ formatAbsDelta(gscDeltas.clicks) }} ({{ formatDelta(gscDeltas.clicks) }})
        </span>
        <span v-if="gscDeltas.impressions" class="delta-badge" :class="{ up: gscDeltas.impressions.diff >= 0, down: gscDeltas.impressions.diff < 0 }">
          Показы: {{ formatAbsDelta(gscDeltas.impressions) }} ({{ formatDelta(gscDeltas.impressions) }})
        </span>
      </div>
      <div v-if="loading" class="skeleton-chart" />
      <div v-else-if="sectionState(data?.gsc) === 'error'" class="section-error">
        <span class="error-icon">⚠️</span> Ошибка загрузки данных GSC: {{ sectionError(data?.gsc) }}
      </div>
      <div v-else-if="sectionState(data?.gsc) === 'disconnected'" class="section-empty">
        Google Search Console не подключён к проекту.
      </div>
      <div v-else-if="!gscChart" class="section-empty">
        За выбранный период данных нет.
      </div>
      <ReportTrendChart v-else :labels="gscChart.labels" :datasets="gscChart.datasets" :annotations="gscChart.annotations" :show-second-axis="gscChart.showSecondAxis" />
    </section>

    <!-- Яндекс.Вебмастер -->
    <section id="report-ywm" class="rblk" data-report-chart="ywm" data-report-chart-title="Яндекс.Вебмастер">
      <h2>Яндекс.Вебмастер</h2>
      <p class="chart-desc">Клики, показы и CTR из Яндекс.Вебмастер за выбранный период.</p>
      <div v-if="ywmDeltas.clicks || ywmDeltas.impressions" class="chart-deltas">
        <span v-if="ywmDeltas.clicks" class="delta-badge" :class="{ up: ywmDeltas.clicks.diff >= 0, down: ywmDeltas.clicks.diff < 0 }">
          Клики: {{ formatAbsDelta(ywmDeltas.clicks) }} ({{ formatDelta(ywmDeltas.clicks) }})
        </span>
        <span v-if="ywmDeltas.impressions" class="delta-badge" :class="{ up: ywmDeltas.impressions.diff >= 0, down: ywmDeltas.impressions.diff < 0 }">
          Показы: {{ formatAbsDelta(ywmDeltas.impressions) }} ({{ formatDelta(ywmDeltas.impressions) }})
        </span>
      </div>
      <div v-if="loading" class="skeleton-chart" />
      <div v-else-if="sectionState(data?.ywm) === 'error'" class="section-error">
        <span class="error-icon">⚠️</span> Ошибка загрузки данных Яндекс: {{ sectionError(data?.ywm) }}
      </div>
      <div v-else-if="sectionState(data?.ywm) === 'disconnected'" class="section-empty">
        Яндекс.Вебмастер не подключён к проекту.
      </div>
      <div v-else-if="!ywmChart" class="section-empty">
        За выбранный период данных нет.
      </div>
      <ReportTrendChart v-else :labels="ywmChart.labels" :datasets="ywmChart.datasets" :annotations="ywmChart.annotations" :show-second-axis="ywmChart.showSecondAxis" />
    </section>

    <!-- Keys.so -->
    <section id="report-keys-so" class="rblk" data-report-chart="keys" data-report-chart-title="Видимость Keys.so">
      <h2>Видимость в поиске (Keys.so)</h2>
      <p class="chart-desc">Индекс видимости, количество запросов в ТОП-10 и ТОП-50 по данным Keys.so.</p>
      <div v-if="hasGoogleKeys || true" class="keys-engine-toggle">
        <button
          class="engine-btn"
          :class="{ active: keysEngine === 'yandex' }"
          @click="keysEngine = 'yandex'"
        >Яндекс</button>
        <button
          class="engine-btn"
          :class="{ active: keysEngine === 'google', disabled: !hasGoogleKeys }"
          :disabled="!hasGoogleKeys"
          @click="keysEngine = 'google'"
        >Google</button>
      </div>
      <div v-if="keysDeltas.top10 || keysDeltas.top50" class="chart-deltas">
        <span v-if="keysDeltas.top10" class="delta-badge" :class="{ up: keysDeltas.top10.diff >= 0, down: keysDeltas.top10.diff < 0 }">
          ТОП-10: {{ formatAbsDelta(keysDeltas.top10) }} ({{ formatDelta(keysDeltas.top10) }})
        </span>
        <span v-if="keysDeltas.top50" class="delta-badge" :class="{ up: keysDeltas.top50.diff >= 0, down: keysDeltas.top50.diff < 0 }">
          ТОП-50: {{ formatAbsDelta(keysDeltas.top50) }} ({{ formatDelta(keysDeltas.top50) }})
        </span>
      </div>
      <div v-if="loading" class="skeleton-chart" />
      <div v-else-if="sectionState(data?.keys_so) === 'error'" class="section-error">
        <span class="error-icon">⚠️</span> Ошибка загрузки данных Keys.so: {{ sectionError(data?.keys_so) }}
      </div>
      <div v-else-if="sectionState(data?.keys_so) === 'disconnected'" class="section-empty">
        Keys.so не подключён к проекту.
      </div>
      <div v-else-if="!keysChart" class="section-empty">
        За выбранный период данных нет.
      </div>
      <ReportTrendChart v-else :labels="keysChart.labels" :datasets="keysChart.datasets" :annotations="keysChart.annotations" :show-second-axis="keysChart.showSecondAxis" />
    </section>

    <section v-if="data?.position?.connected && data?.position?.series?.length" class="rblk" data-report-chart="position" data-report-chart-title="Динамика позиций">
      <h2>Динамика позиций</h2>
      <p class="chart-desc">Средняя позиция и распределение по ТОП-10/ТОП-30 из трекера позиций.</p>
      <PositionChart :series="data.position.series" mode="position" />
    </section>

    <section v-if="growthItems.length" class="rblk">
      <h2>Анализ показателей</h2>
      <div class="growth-grid">
        <article v-for="(item, idx) in growthItems" :key="idx" class="growth-card">
          <div class="growth-header">
            <h3>{{ item.metric || 'Метрика' }}</h3>
            <div v-if="item.delta_pct || item.delta_value" class="growth-trend">
              <span v-if="item.delta_pct" class="trend-badge" :class="{ up: item.trend_direction === 'up', down: item.trend_direction === 'down', stable: item.trend_direction === 'stable' }">
                <span class="trend-arrow">{{ item.trend_direction === 'up' ? '↑' : (item.trend_direction === 'down' ? '↓' : '→') }}</span>
                {{ item.delta_pct }}
              </span>
              <span v-if="item.delta_value" class="trend-abs">{{ item.delta_value }}</span>
            </div>
          </div>
          <p v-if="item.attribution">{{ item.attribution }}</p>
          <p v-if="item.conclusion"><strong>Вывод:</strong> {{ item.conclusion }}</p>
          <p v-if="item.forecast"><strong>Прогноз:</strong> {{ item.forecast }}</p>
          <p v-if="item.weak_zones"><strong>Точки роста:</strong> {{ item.weak_zones }}</p>
        </article>
      </div>
    </section>

    <section v-if="quickWinsItems.length" class="rblk">
      <h2>Quick Wins</h2>
      <ul class="list">
        <li v-for="(item, idx) in quickWinsItems" :key="idx">
          <strong>{{ item.query }}</strong>
          <span v-if="item.position != null"> · позиция {{ item.position }}</span>
          <span v-if="item.plan"> — {{ item.plan }}</span>
        </li>
      </ul>
    </section>

    <section v-if="summary?.vulnerabilities?.length" class="rblk">
      <h2>Уязвимые места</h2>
      <ul class="list">
        <li v-for="(item, idx) in summary.vulnerabilities" :key="idx">{{ item }}</li>
      </ul>
    </section>

    <section v-if="summary?.roadmap?.length" class="rblk">
      <h2>Roadmap</h2>
      <ol class="list ordered">
        <li v-for="(item, idx) in summary.roadmap" :key="idx">{{ item }}</li>
      </ol>
    </section>

    <ReportModulesCard :modules="data?.modules || {}" :view-mode="viewMode" />

    <section id="report-tasks" class="rblk">
      <div class="tasks-head">
        <h2>Выполненные работы</h2>
        <button v-if="!readonly" class="small-btn" @click="addMonth">+ Месяц</button>
      </div>
      <div v-if="!normalizedTasks.length" class="empty">Пока нет блоков работ.</div>
      <div v-for="(monthBlock, i) in normalizedTasks" :key="i" class="month-card">
        <div class="month-head">
          <input v-if="!readonly" :value="monthBlock.month" class="text-input month-input" @input="updateMonth(i, $event.target.value)" />
          <h3 v-else>{{ monthBlock.month }}</h3>
          <div v-if="!readonly" class="actions-inline">
            <button class="small-btn" @click="addSection(i)">+ Раздел</button>
            <button class="small-btn danger" @click="removeMonth(i)">Удалить</button>
          </div>
        </div>

        <div v-for="(section, j) in monthBlock.sections" :key="j" class="section-card">
          <div class="month-head">
            <input v-if="!readonly" :value="section.title" class="text-input" @input="updateSection(i, j, $event.target.value)" />
            <h4 v-else>{{ section.title }}</h4>
            <div v-if="!readonly" class="actions-inline">
              <button class="small-btn" @click="addTask(i, j)">+ Задача</button>
              <button class="small-btn danger" @click="removeSection(i, j)">Удалить раздел</button>
            </div>
          </div>

          <div v-for="(task, k) in section.tasks" :key="k" class="task-card">
            <div v-if="readonly">
              <div class="task-title">{{ task.title }}</div>
              <div v-if="task.description_html" class="task-html" v-html="safeHtml(task.description_html)"></div>
            </div>
            <div v-else class="editor-grid">
              <input :value="task.title" class="text-input" placeholder="Название задачи" @input="updateTask(i, j, k, 'title', $event.target.value)" />
              <textarea :value="task.description_html" class="text-area" rows="4"
                placeholder="Описание задачи. Вставляйте ссылки и скриншоты из буфера обмена (Ctrl+V)."
                @input="updateTask(i, j, k, 'description_html', $event.target.value)"
                @paste="onDescriptionPaste($event, i, j, k)"></textarea>
              <div class="task-attach-row">
                <label class="attach-btn">
                  <input type="file" accept="image/*" hidden @change="onFileSelect($event, i, j, k)" />
                  📎 Добавить изображение
                </label>
                <span v-if="uploadingImage" class="attach-status">Загрузка…</span>
              </div>
              <div class="task-preview" v-if="task.description_html" v-html="safeHtml(task.description_html)"></div>
              <div class="actions-inline">
                <button class="small-btn danger" @click="removeTask(i, j, k)">Удалить задачу</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.completeness-banner {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.65rem 0.9rem;
  border-radius: 10px;
  font-size: 0.9rem;
  line-height: 1.4;
}
.completeness-banner--partial {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fbbf24;
}
.completeness-banner--error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}
.report-renderer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: #1d1d1f;
}
.rblk {
  background: #fff;
  border: 1px solid rgba(60,60,67,0.12);
  border-radius: 20px;
  padding: 20px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
}
.header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.header-main { display: flex; gap: 16px; align-items: center; }
.logo { width: 52px; height: 52px; border-radius: 14px; object-fit: cover; }
.brand { color: #6e6e73; font-size: 13px; }
.brand-url { color: #86868b; }
.rep-title { margin: 4px 0 8px; font-size: 30px; line-height: 1.1; }
.rep-period { color: #424245; }
.live-badge, .snap-badge {
  display: inline-flex; padding: 6px 12px; border-radius: 999px; background: var(--accent-bg); color: var(--accent);
  font-size: 12px; font-weight: 600;
}
.summary-text { white-space: pre-wrap; line-height: 1.7; }
.keys-engine-toggle {
  display: inline-flex; gap: 0; border-radius: 10px; overflow: hidden;
  border: 1px solid rgba(60,60,67,0.15); margin-bottom: 12px;
}
.engine-btn {
  padding: 6px 18px; font-size: 13px; font-weight: 600; border: none;
  background: #f5f5f7; color: #6e6e73; cursor: pointer; transition: all 0.2s;
}
.engine-btn:first-child { border-right: 1px solid rgba(60,60,67,0.1); }
.engine-btn.active { background: var(--accent); color: #fff; }
.engine-btn.disabled { opacity: 0.4; cursor: not-allowed; }
.engine-btn:not(.active):not(.disabled):hover { background: rgba(10,132,255,0.08); color: #0a84ff; }
.totals-grid, .growth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.total-card, .growth-card, .month-card, .section-card, .task-card {
  border: 1px solid rgba(60,60,67,0.1);
  border-radius: 16px;
  background: #fbfbfd;
}
.total-card { padding: 14px; }
.t-label { color: #6e6e73; font-size: 12px; margin-bottom: 6px; }
.t-value { font-size: 20px; font-weight: 700; }
.growth-card { padding: 16px; }
.list { margin: 0; padding-left: 18px; line-height: 1.7; }
.ordered { padding-left: 22px; }
.savings-card { background: linear-gradient(135deg, #fff8e8 0%, #ffffff 100%); }
.tasks-head, .month-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.month-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.section-card { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.task-card { padding: 12px; background: #fff; }
.task-title { font-weight: 600; margin-bottom: 6px; }
.task-html, .task-preview { white-space: pre-wrap; word-break: break-word; line-height: 1.7; }
.task-html :deep(a), .task-preview :deep(a) { color: var(--accent); text-decoration: underline; word-break: break-all; }
.task-html :deep(img), .task-preview :deep(img) { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; display: block; }
.task-attach-row { display: flex; align-items: center; gap: 10px; }
.attach-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 12px; border-radius: 10px;
  background: rgba(10,132,255,0.08); color: var(--accent);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background 0.15s;
}
.attach-btn:hover { background: rgba(10,132,255,0.14); }
.attach-status { font-size: 12px; color: #6e6e73; }
.editor-grid { display: flex; flex-direction: column; gap: 10px; }
.text-input, .text-area {
  width: 100%;
  border: 1px solid rgba(60,60,67,0.18);
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
  background: #fff;
}
.month-input { max-width: 220px; }
.text-area { resize: vertical; min-height: 110px; }
.small-btn {
  border: 0;
  border-radius: 10px;
  padding: 8px 10px;
  background: rgba(10,132,255,0.08);
  color: var(--accent);
  cursor: pointer;
}
.small-btn.danger { background: rgba(255,59,48,0.08); color: #d70015; }
.actions-inline { display: flex; gap: 8px; flex-wrap: wrap; }
.empty { color: #6e6e73; }
.chart-desc { color: #6e6e73; font-size: 13px; margin: -2px 0 10px; line-height: 1.4; }
.chart-deltas {
  display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
}
.period-warning {
  background: rgba(245, 158, 11, 0.10); color: #b45309;
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 14px;
  font-size: 13px; line-height: 1.45;
}
.period-hint {
  color: #6b7280; font-size: 12px; margin: -4px 0 12px;
}
.delta-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 10px;
  font-size: 13px; font-weight: 600;
}
.delta-badge.up {
  background: rgba(16, 185, 129, 0.1); color: #059669;
}
.delta-badge.down {
  background: rgba(239, 68, 68, 0.08); color: #b91c1c;
}
.growth-header {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px;
}
.growth-trend {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.trend-badge {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 3px 10px; border-radius: 8px;
  font-size: 13px; font-weight: 700;
}
.trend-badge.up { background: rgba(16, 185, 129, 0.12); color: #059669; }
.trend-badge.down { background: rgba(239, 68, 68, 0.08); color: #b91c1c; }
.trend-badge.stable { background: rgba(107, 114, 128, 0.1); color: #6b7280; }
.trend-arrow { font-size: 14px; }
.trend-abs { font-size: 12px; color: #6e6e73; font-weight: 500; }
.section-empty {
  padding: 32px 16px; text-align: center; color: #86868b; font-size: 14px;
  background: rgba(60,60,67,0.03); border-radius: 12px;
}
.section-error {
  padding: 24px 16px; text-align: center; color: #d70015; font-size: 13px;
  background: rgba(255,59,48,0.06); border-radius: 12px;
}
.error-icon { font-size: 16px; }
.skeleton-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;
}
.skeleton-card {
  height: 70px; border-radius: 16px; background: linear-gradient(90deg, #f0f0f2 25%, #e8e8ea 50%, #f0f0f2 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite;
}
.skeleton-chart {
  height: 200px; border-radius: 12px; background: linear-gradient(90deg, #f0f0f2 25%, #e8e8ea 50%, #f0f0f2 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.report-nav {
  display: flex; flex-wrap: wrap; gap: 6px;
  background: #fff; border: 1px solid rgba(60,60,67,0.12); border-radius: 14px;
  padding: 8px 12px; position: sticky; top: 0; z-index: 5;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04);
}
.nav-link {
  background: rgba(60,60,67,0.06); border: none; border-radius: 10px;
  padding: 7px 14px; font-size: 12px; font-weight: 500; color: #424245;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.nav-link:hover { background: rgba(10,132,255,0.08); color: #0a84ff; }
@media (max-width: 720px) {
  .header, .header-main, .month-head, .tasks-head { flex-direction: column; align-items: flex-start; }
  .rep-title { font-size: 24px; }
  .totals-grid, .growth-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
  .total-card { padding: 10px; }
  .t-value { font-size: 16px; }
  .rblk { padding: 14px; border-radius: 14px; }
  .month-card, .section-card { padding: 10px; }
  .task-card { padding: 10px; }
  .text-area { min-height: 80px; }
  .actions-inline { flex-wrap: wrap; }
  .task-attach-row { flex-wrap: wrap; }
}
@media (max-width: 480px) {
  .totals-grid, .growth-grid { grid-template-columns: 1fr; }
  .report-nav { padding: 6px 8px; gap: 4px; }
  .nav-link { padding: 6px 10px; font-size: 11px; }
}
</style>
