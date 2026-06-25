<script setup>
import { computed, ref } from 'vue';
import DOMPurify from 'dompurify';
import api from '../../api.js';
import ReportTrendChart from './ReportTrendChart.vue';
import PositionChart from '../PositionChart.vue';
import ReportModulesCard from './ReportModulesCard.vue';
import DataStateWrapper from '../DataStateWrapper.vue';
import ExecutiveHeadline from './ExecutiveHeadline.vue';
import EditableValue from './EditableValue.vue';

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
  // ТЗ §6: карта overrides_meta из черновика — { path: { author_id, updated_at } }.
  // Если передана, на отредактированных вручную полях рисуется бейдж ✏️.
  overridesMeta: { type: Object, default: () => ({}) },
  // ТЗ-правка: видимость графиков в клиентском борде. { gsc, ywm, keys, position }.
  // По умолчанию график виден. В режиме редактирования показываем переключатель.
  chartConfig: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['update:tasksBlocks', 'override:update', 'override:reset', 'update:chart']);

// Видимость графика по id. Отсутствие ключа = виден (обратная совместимость).
function chartVisible(id) {
  const c = props.chartConfig || {};
  return c[id] !== false;
}
function toggleChart(id) {
  emit('update:chart', id, !chartVisible(id));
}

// ТЗ §6: бейджи «изменено вручную» по карте overrides_meta из черновика.
// Родитель (ReportEditorPage) передаёт `overridesMeta` пропсом (вычисляет
// из draft.overrides_meta); если пропа нет — бейджи просто не показываются.
function isOverridden(path) {
  if (!path) return false;
  const map = props.overridesMeta || props.data?._overrides_meta || null;
  if (!map || typeof map !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(map, path);
}
function onOverrideUpdate(path, value) { emit('override:update', path, value); }
function onOverrideReset(path) { emit('override:reset', path); }

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
  if (enginePages.value.length) items.push({ id: 'pages', label: 'Страницы' });
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
    out.push({ label: 'Google клики', value: Number(g.clicks || 0).toLocaleString('ru-RU'), raw: g.clicks, path: 'gsc.totals.clicks', type: 'int' });
    out.push({ label: 'Google показы', value: Number(g.impressions || 0).toLocaleString('ru-RU'), raw: g.impressions, path: 'gsc.totals.impressions', type: 'int' });
    out.push({ label: 'Google CTR', value: g.ctr != null ? `${Number(g.ctr).toFixed(2)}%` : '—', raw: g.ctr, path: 'gsc.totals.ctr', type: 'float' });
    out.push({ label: 'Google ср. позиция', value: g.position != null ? Number(g.position).toFixed(1) : '—', raw: g.position, path: 'gsc.totals.position', type: 'float' });
  }
  const y = props.data?.ywm?.totals;
  if (y) {
    out.push({ label: 'Яндекс клики', value: Number(y.clicks || 0).toLocaleString('ru-RU'), raw: y.clicks, path: 'ywm.totals.clicks', type: 'int' });
    out.push({ label: 'Яндекс показы', value: Number(y.impressions || 0).toLocaleString('ru-RU'), raw: y.impressions, path: 'ywm.totals.impressions', type: 'int' });
    out.push({ label: 'Яндекс CTR', value: y.ctr != null ? `${Number(y.ctr).toFixed(2)}%` : '—', raw: y.ctr, path: 'ywm.totals.ctr', type: 'float' });
  }
  const k = props.data?.keys_so?.yandex?.current || props.data?.keys_so?.current;
  if (k) {
    out.push({ label: 'Видимость Яндекс (Keys.so)', value: k.visibility != null ? Number(k.visibility).toFixed(2) : '—', raw: k.visibility, path: 'keys_so.yandex.current.visibility', type: 'float' });
    out.push({ label: 'ТОП-10 Яндекс', value: Number(k.top10 || 0).toLocaleString('ru-RU'), raw: k.top10, path: 'keys_so.yandex.current.top10', type: 'int' });
    out.push({ label: 'ТОП-50 Яндекс', value: Number(k.top50 || 0).toLocaleString('ru-RU'), raw: k.top50, path: 'keys_so.yandex.current.top50', type: 'int' });
  }
  const kg = props.data?.keys_so?.google?.current;
  if (kg) {
    out.push({ label: 'Видимость Google (Keys.so)', value: kg.visibility != null ? Number(kg.visibility).toFixed(2) : '—', raw: kg.visibility, path: 'keys_so.google.current.visibility', type: 'float' });
    out.push({ label: 'ТОП-10 Google', value: Number(kg.top10 || 0).toLocaleString('ru-RU'), raw: kg.top10, path: 'keys_so.google.current.top10', type: 'int' });
    out.push({ label: 'ТОП-50 Google', value: Number(kg.top50 || 0).toLocaleString('ru-RU'), raw: kg.top50, path: 'keys_so.google.current.top50', type: 'int' });
  }
  const p = props.data?.position?.summary;
  if (p) {
    out.push({ label: 'Средняя позиция', value: p.avg_position != null ? Number(p.avg_position).toFixed(1) : '—', raw: p.avg_position, path: 'position.summary.avg_position', type: 'float' });
    out.push({ label: 'Запросов в ТОП-10', value: Number(p.top10 || 0).toLocaleString('ru-RU'), raw: p.top10, path: 'position.summary.top10', type: 'int' });
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
// Раньше здесь жили _deltaFromTotals/_computeDeltas/gscDeltas/ywmDeltas/keysDeltas
// и плашки «+/–» над графиками GSC / Я.Вебмастер / Keys.so. По запросу клиента
// эти подписи убраны: способ расчёта дельт оказался непрозрачным для конечного
// читателя отчёта. Динамика остаётся видимой на самих графиках; KPI-карточки и
// ExecutiveHeadline продолжают показывать дельты по полным месяцам отдельно.

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

// formatDelta/formatAbsDelta удалены вместе с плашками «+/–» над графиками
// GSC/Я.Вебмастер/Keys.so — способ расчёта дельт оказался непрозрачен для
// клиента. KPI-карточки и ExecutiveHeadline считают и показывают дельты
// отдельно (см. KPICard.vue / ExecutiveHeadline.vue).

// ТЗ-правка: блок «топ-запросы по интенту» убран — классификация запроса по
// интенту (коммерческий/информационный) работает плохо. Вместо этого интент
// определяется по URL страницы (см. backend urlClassifier), а основной разрез
// — топ-страницы с разворачиваемым списком запросов по каждой странице.
const queriesSection = computed(() => props.data?.queries || null);
const commercialSummary = computed(() => queriesSection.value?.summary || null);

// Движок для топ-страниц. Срез по страницам отдаёт только Google (GSC);
// Яндекс.Вебмастер не предоставляет page-разрез — вкладка информирует об этом.
const pagesEngine = ref('google');
// Фильтр по интенту страницы: все / коммерческие / информационные.
const pageFilter = ref('all');
// Раскрытые страницы (показываем список запросов под URL).
const expandedPages = ref(new Set());
function togglePage(url) {
  const next = new Set(expandedPages.value);
  if (next.has(url)) next.delete(url);
  else next.add(url);
  expandedPages.value = next;
}

// Список страниц для активного движка. Бэкенд кладёт queries.pages.{google,yandex}.
// Фолбэк на старый формат top_pages_* для обратной совместимости со снапшотами.
const enginePages = computed(() => {
  const q = queriesSection.value;
  if (!q) return [];
  const fromNew = q.pages && Array.isArray(q.pages[pagesEngine.value]) ? q.pages[pagesEngine.value] : null;
  if (fromNew) return fromNew;
  // legacy fallback: объединяем commercial + informational, помечая intent.
  const legacy = [
    ...(q.top_pages_commercial || []).map((p) => ({ url: p.key, page_intent: 'commercial', clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position, queries: [], queries_count: 0 })),
    ...(q.top_pages_informational || []).map((p) => ({ url: p.key, page_intent: 'informational', clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position, queries: [], queries_count: 0 })),
  ];
  return legacy;
});
const pagesCommercialCount = computed(() => enginePages.value.filter((p) => p.page_intent === 'commercial').length);
const pagesInfoCount = computed(() => enginePages.value.filter((p) => p.page_intent === 'informational').length);
const filteredPages = computed(() => {
  if (pageFilter.value === 'all') return enginePages.value;
  return enginePages.value.filter((p) => p.page_intent === pageFilter.value);
});
function pageIntentLabel(intent) {
  return intent === 'informational' ? '📚 Информационная' : '🛒 Коммерческая';
}

// ТЗ-правка: сворачивание блоков работ по месяцам и по разделам/задачам,
// чтобы длинный список не превращался в «полотно».
const collapsedMonths = ref(new Set());
const collapsedSections = ref(new Set());
function toggleMonth(i) {
  const next = new Set(collapsedMonths.value);
  if (next.has(i)) next.delete(i); else next.add(i);
  collapsedMonths.value = next;
}
function isMonthCollapsed(i) { return collapsedMonths.value.has(i); }
function toggleSection(i, j) {
  const key = `${i}:${j}`;
  const next = new Set(collapsedSections.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  collapsedSections.value = next;
}
function isSectionCollapsed(i, j) { return collapsedSections.value.has(`${i}:${j}`); }

function formatPct(v) {
  return v == null ? '—' : `${v}%`;
}
function formatNum(v) {
  return v == null ? '—' : Number(v).toLocaleString('ru-RU');
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
          <div class="t-value">
            <EditableValue
              :display-value="t.value"
              :raw-value="t.raw"
              :path="t.path"
              :type="t.type"
              :editable="!readonly"
              :overridden="isOverridden(t.path)"
              @update="onOverrideUpdate"
              @reset="onOverrideReset"
            />
          </div>
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
    <section v-if="!readonly || chartVisible('gsc')" id="report-gsc" class="rblk" data-report-chart="gsc" data-report-chart-title="Google Search Console">
      <div class="chart-head">
        <h2>Google Search Console</h2>
        <label v-if="!readonly" class="chart-toggle">
          <input type="checkbox" :checked="chartVisible('gsc')" @change="toggleChart('gsc')" />
          <span>Показывать клиенту</span>
        </label>
      </div>
      <p class="chart-desc">Клики, показы и CTR из органической выдачи Google за выбранный период.</p>
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
    <section v-if="!readonly || chartVisible('ywm')" id="report-ywm" class="rblk" data-report-chart="ywm" data-report-chart-title="Яндекс.Вебмастер">
      <div class="chart-head">
        <h2>Яндекс.Вебмастер</h2>
        <label v-if="!readonly" class="chart-toggle">
          <input type="checkbox" :checked="chartVisible('ywm')" @change="toggleChart('ywm')" />
          <span>Показывать клиенту</span>
        </label>
      </div>
      <p class="chart-desc">Клики, показы и CTR из Яндекс.Вебмастер за выбранный период.</p>
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
    <section v-if="!readonly || chartVisible('keys')" id="report-keys-so" class="rblk" data-report-chart="keys" data-report-chart-title="Видимость Keys.so">
      <div class="chart-head">
        <h2>Видимость в поиске (Keys.so)</h2>
        <label v-if="!readonly" class="chart-toggle">
          <input type="checkbox" :checked="chartVisible('keys')" @change="toggleChart('keys')" />
          <span>Показывать клиенту</span>
        </label>
      </div>
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

    <section v-if="(!readonly || chartVisible('position')) && data?.position?.connected && data?.position?.series?.length" class="rblk" data-report-chart="position" data-report-chart-title="Динамика позиций">
      <div class="chart-head">
        <h2>Динамика позиций</h2>
        <label v-if="!readonly" class="chart-toggle">
          <input type="checkbox" :checked="chartVisible('position')" @change="toggleChart('position')" />
          <span>Показывать клиенту</span>
        </label>
      </div>
      <p class="chart-desc">Средняя позиция и распределение по ТОП-10/ТОП-30 из трекера позиций.</p>
      <PositionChart :series="data.position.series" mode="position" />
    </section>

    <!-- ТЗ-правка: вместо ненадёжной классификации запросов — топ-страницы с
         интентом по URL и разворачиваемым списком запросов под каждой страницей. -->
    <section
      v-if="enginePages.length"
      id="report-pages"
      class="rblk"
    >
      <h2>Топ-страницы и запросы</h2>
      <p class="chart-desc">
        До {{ queriesSection?.pages_limit || 50 }} страниц по кликам. Тип страницы
        (коммерческая / информационная) определяется по структуре URL.
        Нажмите на строку, чтобы раскрыть запросы, по которым продвигается страница.
      </p>
      <div v-if="commercialSummary" class="commercial-summary">
        <span class="cs-pill">
          Коммерческий трафик: <b>{{ formatNum(commercialSummary.commercial_clicks) }}</b>
          кликов из <b>{{ formatNum(commercialSummary.total_clicks) }}</b>
          <span v-if="commercialSummary.commercial_share_pct != null">
            ({{ commercialSummary.commercial_share_pct }}%)
          </span>
        </span>
      </div>
      <!-- Движок: Google (есть page-разрез) / Яндекс (нет page-разреза) -->
      <div class="keys-engine-toggle">
        <button class="engine-btn" :class="{ active: pagesEngine === 'google' }" @click="pagesEngine = 'google'">Google</button>
        <button class="engine-btn" :class="{ active: pagesEngine === 'yandex' }" @click="pagesEngine = 'yandex'">Яндекс</button>
      </div>
      <!-- Фильтр по интенту страницы -->
      <div class="intent-tabs">
        <button class="intent-tab" :class="{ active: pageFilter === 'all' }" @click="pageFilter = 'all'">Все ({{ enginePages.length }})</button>
        <button class="intent-tab" :class="{ active: pageFilter === 'commercial' }" @click="pageFilter = 'commercial'">🛒 Коммерческие ({{ pagesCommercialCount }})</button>
        <button class="intent-tab" :class="{ active: pageFilter === 'informational' }" @click="pageFilter = 'informational'">📚 Информационные ({{ pagesInfoCount }})</button>
      </div>
      <table class="rep-table pages-table">
        <thead>
          <tr>
            <th></th>
            <th>Страница</th>
            <th>Тип</th>
            <th class="num">Клики</th>
            <th class="num">Показы</th>
            <th class="num">CTR</th>
            <th class="num">Позиция</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(row, i) in filteredPages" :key="`pg-${pagesEngine}-${i}`">
            <tr class="page-row" :class="{ expanded: expandedPages.has(row.url) }" @click="togglePage(row.url)">
              <td class="expand-cell">
                <button class="expand-btn" v-if="row.queries_count" :aria-expanded="expandedPages.has(row.url)">
                  {{ expandedPages.has(row.url) ? '−' : '+' }}
                </button>
              </td>
              <td class="page-cell">
                <a :href="row.url" target="_blank" rel="noopener" @click.stop>{{ row.url }}</a>
                <span v-if="row.queries_count" class="q-count">{{ row.queries_count }} запр.</span>
              </td>
              <td class="intent-cell">{{ pageIntentLabel(row.page_intent) }}</td>
              <td class="num">{{ formatNum(row.clicks) }}</td>
              <td class="num">{{ formatNum(row.impressions) }}</td>
              <td class="num">{{ formatPct(row.ctr) }}</td>
              <td class="num">{{ row.position != null ? row.position : '—' }}</td>
            </tr>
            <tr v-if="expandedPages.has(row.url) && row.queries?.length" class="queries-row">
              <td></td>
              <td colspan="6">
                <table class="rep-subtable">
                  <thead>
                    <tr><th>Запрос</th><th class="num">Клики</th><th class="num">Показы</th><th class="num">CTR</th><th class="num">Позиция</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(q, qi) in row.queries" :key="`q-${qi}`">
                      <td>{{ q.query }}</td>
                      <td class="num">{{ formatNum(q.clicks) }}</td>
                      <td class="num">{{ formatNum(q.impressions) }}</td>
                      <td class="num">{{ formatPct(q.ctr) }}</td>
                      <td class="num">{{ q.position != null ? q.position : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
          <tr v-if="!filteredPages.length">
            <td colspan="7" class="empty-cell">
              <template v-if="pagesEngine === 'yandex'">
                Яндекс.Вебмастер не отдаёт разрез по страницам — данные доступны только по запросам.
              </template>
              <template v-else>За период по этому фильтру страниц нет.</template>
            </td>
          </tr>
        </tbody>
      </table>
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
          <button type="button" class="collapse-btn" :aria-expanded="!isMonthCollapsed(i)" @click="toggleMonth(i)">
            {{ isMonthCollapsed(i) ? '▸' : '▾' }}
          </button>
          <input v-if="!readonly" :value="monthBlock.month" class="text-input month-input" @input="updateMonth(i, $event.target.value)" />
          <h3 v-else @click="toggleMonth(i)" style="cursor:pointer">{{ monthBlock.month }}</h3>
          <span class="collapse-count">{{ (monthBlock.sections || []).length }} разд.</span>
          <div v-if="!readonly" class="actions-inline">
            <button class="small-btn" @click="addSection(i)">+ Раздел</button>
            <button class="small-btn danger" @click="removeMonth(i)">Удалить</button>
          </div>
        </div>

        <div v-show="!isMonthCollapsed(i)" v-for="(section, j) in monthBlock.sections" :key="j" class="section-card">
          <div class="month-head">
            <button type="button" class="collapse-btn" :aria-expanded="!isSectionCollapsed(i, j)" @click="toggleSection(i, j)">
              {{ isSectionCollapsed(i, j) ? '▸' : '▾' }}
            </button>
            <input v-if="!readonly" :value="section.title" class="text-input" @input="updateSection(i, j, $event.target.value)" />
            <h4 v-else @click="toggleSection(i, j)" style="cursor:pointer">{{ section.title }}</h4>
            <span class="collapse-count">{{ (section.tasks || []).length }} задач</span>
            <div v-if="!readonly" class="actions-inline">
              <button class="small-btn" @click="addTask(i, j)">+ Задача</button>
              <button class="small-btn danger" @click="removeSection(i, j)">Удалить раздел</button>
            </div>
          </div>

          <div v-show="!isSectionCollapsed(i, j)" v-for="(task, k) in section.tasks" :key="k" class="task-card">
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
.period-warning {
  background: rgba(245, 158, 11, 0.10); color: #b45309;
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 14px;
  font-size: 13px; line-height: 1.45;
}
.period-hint {
  color: #6b7280; font-size: 12px; margin: -4px 0 12px;
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

/* ТЗ §4: вкладки и таблицы коммерческих/информационных запросов */
.commercial-summary { margin: 8px 0 12px; }
.cs-pill {
  display: inline-block; padding: 6px 12px; border-radius: 999px;
  background: var(--accent-bg, #f0f4ff); color: #234; font-size: 13px;
}
.intent-tabs { display: flex; gap: 6px; margin: 10px 0 12px; flex-wrap: wrap; }
.intent-tab {
  padding: 6px 14px; border-radius: 999px; border: 1px solid #d6dbe3;
  background: #fff; color: #455; font-size: 13px; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.intent-tab:hover { background: #f4f6fa; }
.intent-tab.active { background: var(--accent, #4a6cf7); color: #fff; border-color: var(--accent, #4a6cf7); }
.rep-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rep-table th, .rep-table td { padding: 8px 10px; border-bottom: 1px solid #eef0f4; text-align: left; }
.rep-table th { background: #fafbfd; font-weight: 600; color: #455; }
.rep-table td.num, .rep-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.rep-table tr:hover td { background: #fafbfd; }
.intent-cell { color: #678; font-size: 12px; white-space: nowrap; }
.page-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-cell a { color: var(--accent, #4a6cf7); text-decoration: none; }
.page-cell a:hover { text-decoration: underline; }
.brand-tag { margin-left: 6px; color: #d4a017; font-size: 11px; }
.empty-cell { text-align: center; color: #889; padding: 16px; font-style: italic; }

/* Заголовок графика с переключателем видимости для клиента */
.chart-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.chart-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #678; cursor: pointer; user-select: none; }
.chart-toggle input { accent-color: var(--accent, #4a6cf7); }

/* Топ-страницы с разворачиваемыми запросами */
.pages-table .expand-cell { width: 28px; text-align: center; }
.page-row { cursor: pointer; }
.page-row.expanded > td { background: #f5f8ff; }
.expand-btn { width: 20px; height: 20px; border-radius: 6px; border: 1px solid #dce0ea; background: #fff; color: #4a6cf7; font-weight: 700; line-height: 1; cursor: pointer; }
.q-count { margin-left: 8px; font-size: 11px; color: #99a; }
.queries-row > td { background: #f9fbff; padding: 0 10px 10px 10px; }
.rep-subtable { width: 100%; border-collapse: collapse; font-size: 12px; }
.rep-subtable th, .rep-subtable td { padding: 5px 8px; border-bottom: 1px solid #eef0f4; text-align: left; }
.rep-subtable th { color: #889; font-weight: 600; }
.rep-subtable td.num, .rep-subtable th.num { text-align: right; font-variant-numeric: tabular-nums; }

/* Сворачивание блоков работ */
.collapse-btn { width: 22px; height: 22px; border: none; background: none; color: #6e6e73; font-size: 13px; cursor: pointer; padding: 0; flex-shrink: 0; }
.collapse-count { font-size: 11px; color: #99a; margin-left: auto; white-space: nowrap; }
</style>
