<script setup>
/**
 * SiteCrawlerPage — модуль «Парсер сайта» (задача 3).
 *
 * UI: форма запуска (URL + опции), список задач, и для выбранной задачи —
 * три вкладки: «Таблица» (с поиском/фильтром, кнопками «Копировать в Excel»,
 * «Скачать CSV», «Скачать XLSX»), «Дерево URL» (с раскрытием/сворачиванием),
 * «Сводка» (общие цифры).
 *
 * Бэкенд: /api/site-crawler/tasks*. Запуск задачи — async, поллим статус.
 */
import { ref, computed, onMounted, onUnmounted, watch, h, defineComponent } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';
import { YANDEX_REGIONS, findRegionByCode } from '../data/yandexRegions.js';

// Рекурсивный компонент UrlTreeNode — стилизованное «дерево сайта» (задача B).
// Узел несёт: segment, fullUrl, isVirtual, title, h1, description, status,
// children:[], а также sectionType/sectionLabel/sectionIcon/sectionColor и
// pageCount (проставляются бэкендом через sectionClassifier). Верхнеуровневые
// разделы (Блог/Услуги/Новости…) показываются крупными цветными «ветками».
const UrlTreeNode = defineComponent({
  name: 'UrlTreeNode',
  props: {
    node: Object,
    root: Boolean,
    depth: { type: Number, default: 0 },
    expandAll: { type: Number, default: 0 },      // тик: развернуть всё
    collapseAll: { type: Number, default: 0 },    // тик: свернуть всё
  },
  setup(props) {
    const open = ref(props.root || (props.node && props.node.depth <= 1));
    watch(() => props.expandAll, () => { open.value = true; });
    watch(() => props.collapseAll, () => { if (!props.root) open.value = false; });
    return { open };
  },
  render() {
    const n = this.node;
    if (!n) return null;
    const has = n.children && n.children.length;
    const isTop = this.depth === 1;               // верхнеуровневый раздел
    const color = n.sectionColor || '#64748b';

    const caret = has
      ? h('span', {
          class: 'caret',
          role: 'button',
          'aria-expanded': String(this.open),
          tabindex: 0,
          onClick: () => { this.open = !this.open; },
          onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open = !this.open; } },
        }, this.open ? '▾' : '▸')
      : h('span', { class: 'caret-empty' }, '·');

    const label = n.segment || n.fullUrl;
    const rowChildren = [caret];

    if (isTop) {
      // Крупная цветная «ветка» раздела.
      rowChildren.push(h('span', { class: 'sec-icon' }, n.sectionIcon || '📄'));
      rowChildren.push(h('a', {
        href: n.fullUrl, target: '_blank', rel: 'noopener',
        class: 'tree-url tree-url-top', style: { color },
      }, label));
      if (n.sectionLabel) {
        rowChildren.push(h('span', { class: 'sec-badge', style: { background: color } }, n.sectionLabel));
      }
    } else {
      rowChildren.push(h('a', {
        href: n.fullUrl, target: '_blank', rel: 'noopener', class: 'tree-url',
      }, label));
    }

    if (n.status) {
      const cls = Number(n.status) >= 400 ? 'badge badge-error'
        : Number(n.status) >= 300 ? 'badge badge-info' : 'badge badge-ok';
      rowChildren.push(h('span', { class: cls }, String(n.status)));
    }
    if (n.isVirtual) rowChildren.push(h('span', { class: 'badge badge-muted' }, 'раздел'));
    if (has && n.pageCount) rowChildren.push(h('span', { class: 'tree-count' }, `${n.pageCount} стр.`));
    if (n.title || n.h1) {
      rowChildren.push(h('span', { class: 'tree-title' }, ' — ' + (n.h1 || n.title)));
    }

    const head = h('div', { class: ['tree-row', isTop ? 'tree-row-top' : ''] }, rowChildren);
    if (!has || !this.open) return h('div', { class: ['tree-node', isTop ? 'tree-node-top' : ''] }, [head]);
    return h('div', { class: ['tree-node', isTop ? 'tree-node-top' : ''] }, [
      head,
      h('div', { class: 'tree-children', style: isTop ? { borderColor: color } : {} },
        n.children.map((c) => h(UrlTreeNode, {
          node: c, key: c.fullUrl, depth: this.depth + 1,
          expandAll: this.expandAll, collapseAll: this.collapseAll,
        }))),
    ]);
  },
});

// ── state ────────────────────────────────────────────────────────────
const tasks       = ref([]);
const selectedId  = ref(null);
const selected    = ref(null);
const pages       = ref([]);
const pagesTotal  = ref(0);                  // total из ответа /pages (могут быть лимиты)
const tree        = ref(null);
const tab         = ref('table');        // 'table' | 'tree' | 'summary'
const loading     = ref(false);
const error       = ref(null);
const pollHandle  = ref(null);
const searchText  = ref('');
const fieldsShow  = ref({ url: true, h1: true, title: true, description: true });

// ── дерево: управление разворотом/фильтром (задача B) ─────────────────
const treeExpandTick   = ref(0);
const treeCollapseTick = ref(0);
function expandAllTree()   { treeExpandTick.value++; }
function collapseAllTree() { treeCollapseTick.value++; }

// ── Сканер каннибализации (задача A) ──────────────────────────────────
const cann = ref({
  task: null,          // текущая задача каннибализации
  result: null,        // отчёт (кластеры/матрица)
  polling: null,
  running: false,
  error: null,
  showConfig: false,
});
const cannForm = ref({
  lr: '213',
  engine: 'yandex',
  minCommonUrls: 4,
  topN: 10,
  maxQueries: 300,
  useAI: false,
});
// Region picker (комбобокс с поиском) — переиспользуем справочник релевантности.
const regionQuery    = ref('');
const regionDropdown = ref(false);
const filteredRegions = computed(() => {
  const q = regionQuery.value.trim().toLowerCase();
  if (!q) return YANDEX_REGIONS.slice(0, 200);
  const out = [];
  for (const r of YANDEX_REGIONS) {
    if (r.name.toLowerCase().includes(q) || String(r.code).includes(q)) out.push(r);
    if (out.length >= 200) break;
  }
  return out;
});
const currentRegionLabel = computed(() => {
  const r = findRegionByCode(cannForm.value.lr);
  return r ? `${r.name} (lr=${r.code})` : `lr=${cannForm.value.lr}`;
});
function pickRegion(region) {
  cannForm.value.lr = String(region.code);
  regionQuery.value = '';
  regionDropdown.value = false;
}
function regionGroupColor(group) {
  return group === 'Округ' ? '#7c3aed' : group === 'Область' ? '#0891b2' : '#16a34a';
}

const form = ref({
  start_url:         '',
  maxPages:          5000,
  maxDepth:          10,
  includeSubdomains: false,
  respectRobots:     true,
  concurrency:       4,
});

// ── derived ──────────────────────────────────────────────────────────
const filteredPages = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  if (!q) return pages.value;
  return pages.value.filter((p) =>
    (p.url || '').toLowerCase().includes(q) ||
    (p.title || '').toLowerCase().includes(q) ||
    (p.h1 || '').toLowerCase().includes(q));
});

const summary = computed(() => {
  const p   = pages.value;
  const total = p.length;
  const byStatus = {};
  let noTitle = 0, noH1 = 0, longDesc = 0, depthSum = 0;
  const titleCounts = new Map();
  for (const r of p) {
    const st = r.http_status != null ? String(r.http_status) : 'n/a';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (!r.title)                noTitle++;
    if (!r.h1)                   noH1++;
    if ((r.description || '').length > 160) longDesc++;
    depthSum += (Number(r.depth) || 0);
    if (r.title) titleCounts.set(r.title, (titleCounts.get(r.title) || 0) + 1);
  }
  const dupTitles = [...titleCounts.values()].filter((n) => n > 1).length;
  return {
    total, noTitle, noH1, longDesc,
    avgDepth: total ? (depthSum / total).toFixed(2) : '—',
    byStatus, dupTitles,
  };
});

// ── helpers ──────────────────────────────────────────────────────────
async function fetchTasks() {
  try {
    const { data } = await api.get('/site-crawler/tasks');
    tasks.value = data.items || [];
  } catch (e) { error.value = _msg(e); }
}

async function startCrawl() {
  error.value = null;
  if (!form.value.start_url.trim()) { error.value = 'Укажите URL'; return; }
  loading.value = true;
  try {
    const payload = {
      start_url: form.value.start_url.trim(),
      options: {
        maxPages:          Number(form.value.maxPages)    || 500,
        maxDepth:          Number(form.value.maxDepth)    || 5,
        includeSubdomains: !!form.value.includeSubdomains,
        respectRobots:     !!form.value.respectRobots,
        concurrency:       Number(form.value.concurrency) || 4,
      },
    };
    const { data } = await api.post('/site-crawler/tasks', payload);
    await fetchTasks();
    selectTask(data.id);
  } catch (e) { error.value = _msg(e); }
  finally { loading.value = false; }
}

async function selectTask(id) {
  selectedId.value = id;
  resetCannibalization();
  await Promise.all([loadTask(), loadPages(), loadTree()]);
  // Задача 1: результаты каннибализации сохраняются в БД и должны выводиться
  // в каждой задаче парсера — подтягиваем последний прогон для этого краула.
  await loadExistingCannibalization();
}

// Подтягиваем последнюю задачу каннибализации, привязанную к текущему краулу,
// и восстанавливаем её результат/статус. Благодаря этому отчёт «переживает»
// перезагрузку страницы и переключение между задачами (раньше он терялся,
// т.к. resetCannibalization() очищал состояние при каждом выборе задачи).
async function loadExistingCannibalization() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get('/cannibalization/tasks');
    const items = (data.items || []).filter(
      (t) => Number(t.crawl_task_id) === Number(selectedId.value),
    );
    if (!items.length) return;
    // Бэкенд отдаёт список ORDER BY created_at DESC — берём самый свежий.
    const latest = items[0];
    if (Number(selectedId.value) !== Number(latest.crawl_task_id)) return;
    cann.value.task = latest;
    if (latest.status === 'done') {
      await loadCannResult();
    } else if (latest.status === 'running' || latest.status === 'queued') {
      cann.value.running = true;
      startCannPolling();
    } else if (latest.status === 'error') {
      cann.value.error = latest.error || 'Ошибка сканирования';
    }
  } catch (_) { /* тихо игнорируем — вкладка каннибализации просто будет пустой */ }
}

async function loadTask() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/site-crawler/tasks/${selectedId.value}`);
    selected.value = data;
  } catch (e) { selected.value = null; }
}

async function loadPages() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/site-crawler/tasks/${selectedId.value}/pages`, {
      params: { limit: 500 },
    });
    pages.value = data.items || [];
    pagesTotal.value = Number(data.total) || pages.value.length;
  } catch (_) { pages.value = []; pagesTotal.value = 0; }
}

async function loadTree() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/site-crawler/tasks/${selectedId.value}/tree`);
    tree.value = data.tree;
  } catch (_) { tree.value = null; }
}

async function cancelTask() {
  if (!selectedId.value) return;
  try {
    await api.post(`/site-crawler/tasks/${selectedId.value}/cancel`);
    await loadTask();
  } catch (e) { error.value = _msg(e); }
}

async function deleteTask(id) {
  if (!confirm('Удалить задачу?')) return;
  try {
    await api.delete(`/site-crawler/tasks/${id}`);
    if (selectedId.value === id) { selectedId.value = null; selected.value = null; pages.value = []; tree.value = null; }
    await fetchTasks();
  } catch (e) { error.value = _msg(e); }
}

function downloadCsv() {
  if (!selectedId.value) return;
  const token = localStorage.getItem('seo_token') || '';
  const url = `/api/site-crawler/tasks/${selectedId.value}/export.csv`;
  // Скачивание через временный <a> с авторизацией невозможно для GET; полагаемся на тот же origin + cookie/header.
  // Самый простой путь: fetch с Authorization → blob.
  fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => r.blob())
    .then((b) => _saveBlob(b, `site-crawl-${selectedId.value}.csv`))
    .catch((e) => { error.value = _msg(e); });
}

function downloadXlsx() {
  if (!selectedId.value) return;
  const token = localStorage.getItem('seo_token') || '';
  const url = `/api/site-crawler/tasks/${selectedId.value}/export.xlsx`;
  fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => r.blob())
    .then((b) => _saveBlob(b, `site-crawl-${selectedId.value}.xlsx`))
    .catch((e) => { error.value = _msg(e); });
}

/** Копирование в Excel/Sheets через TSV в буфере обмена. */
async function copyToExcel() {
  const cols = ['url','depth','http_status','title','h1','description'];
  const lines = [cols.join('\t')];
  for (const r of filteredPages.value) {
    lines.push(cols.map((c) => _tsv(r[c])).join('\t'));
  }
  try {
    await navigator.clipboard.writeText(lines.join('\r\n'));
    alert('Скопировано в буфер обмена. Вставьте в Excel/Sheets.');
  } catch (e) { error.value = 'Не удалось скопировать в буфер'; }
}

function _tsv(v) {
  if (v == null) return '';
  let s = String(v);
  if (/[\t\r\n"]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function _msg(e) { return e?.response?.data?.error || e?.message || 'Ошибка'; }

// ── Сканер каннибализации: запуск / поллинг / вывод ───────────────────
const hasH1 = computed(() => pages.value.some((p) => p && p.h1));

const cannProgress = computed(() => {
  const st = cann.value.task && cann.value.task.stats;
  if (!st || typeof st !== 'object') return null;
  return {
    phase: st.phase || null,
    done:  Number(st.done) || 0,
    total: Number(st.total) || 0,
    errors: Number(st.errors) || 0,
  };
});
const cannPhaseLabel = (p) => ({
  collecting: 'снимаем выдачу', analyzing: 'анализируем', ai: 'AI-разбор', done: 'готово',
}[p] || p || '');

// Матрица «запрос × запрос» для наглядной таблицы (только запросы, попавшие
// хотя бы в одну пару с пересечением).
const cannMatrixView = computed(() => {
  const r = cann.value.result;
  if (!r || !r.matrix) return { queries: [], cells: new Map() };
  const set = new Set();
  const cells = new Map();
  for (const m of r.matrix) {
    set.add(m.a); set.add(m.b);
    cells.set(m.a + '\u0000' + m.b, m.common);
    cells.set(m.b + '\u0000' + m.a, m.common);
  }
  return { queries: [...set], cells };
});

function cannCell(a, b) {
  if (a === b) return null;
  return cannMatrixView.value.cells.get(a + '\u0000' + b) || 0;
}
function cannCellClass(a, b) {
  const v = cannCell(a, b);
  if (v == null) return 'mx-self';
  const thr = (cann.value.result && cann.value.result.params.minCommonUrls) || 4;
  if (v >= thr) return 'mx-hit';
  if (v > 0)    return 'mx-warn';
  return 'mx-zero';
}

async function startCannibalization() {
  if (!selectedId.value) return;
  cann.value.error = null;
  cann.value.running = true;
  cann.value.result = null;
  try {
    const payload = {
      crawl_task_id: selectedId.value,
      engine: cannForm.value.engine,
      lr: String(cannForm.value.lr || '').trim(),
      options: {
        minCommonUrls: Number(cannForm.value.minCommonUrls) || 4,
        topN:          Number(cannForm.value.topN) || 10,
        maxQueries:    Number(cannForm.value.maxQueries) || 300,
        useAI:         !!cannForm.value.useAI,
      },
    };
    const { data } = await api.post('/cannibalization/tasks', payload);
    cann.value.task = { id: data.id, status: data.status, stats: {} };
    cann.value.showConfig = false;
    startCannPolling();
  } catch (e) {
    cann.value.error = _msg(e);
    cann.value.running = false;
  }
}

function startCannPolling() {
  stopCannPolling();
  cann.value.polling = setInterval(async () => {
    if (!cann.value.task) return;
    try {
      const { data } = await api.get(`/cannibalization/tasks/${cann.value.task.id}`);
      cann.value.task = data;
      if (['done', 'error', 'cancelled'].includes(data.status)) {
        stopCannPolling();
        cann.value.running = false;
        if (data.status === 'done') await loadCannResult();
        if (data.status === 'error') cann.value.error = data.error || 'Ошибка сканирования';
      }
    } catch (e) { /* keep polling */ }
  }, 2500);
}
function stopCannPolling() {
  if (cann.value.polling) { clearInterval(cann.value.polling); cann.value.polling = null; }
}
async function loadCannResult() {
  if (!cann.value.task) return;
  try {
    const { data } = await api.get(`/cannibalization/tasks/${cann.value.task.id}/result`);
    cann.value.result = data.result || null;
  } catch (e) { cann.value.error = _msg(e); }
}
async function cancelCannibalization() {
  if (!cann.value.task) return;
  try {
    await api.post(`/cannibalization/tasks/${cann.value.task.id}/cancel`);
    stopCannPolling();
    cann.value.running = false;
  } catch (e) { cann.value.error = _msg(e); }
}
function resetCannibalization() {
  stopCannPolling();
  cann.value = { task: null, result: null, polling: null, running: false, error: null, showConfig: false };
}

/** Копировать матрицу каннибализации (пары) в буфер как TSV для Excel. */
async function copyCannToExcel() {
  const r = cann.value.result;
  if (!r) return;
  const cols = ['Запрос A', 'URL A', 'Запрос B', 'URL B', 'Общих URL', 'Под слияние'];
  const clusterOf = new Map();
  for (const c of (r.clusters || [])) for (const m of c.members) clusterOf.set(m.query, c.id);
  const lines = [cols.join('\t')];
  const sorted = [...(r.matrix || [])].sort((x, y) => y.common - x.common);
  for (const m of sorted) {
    const merge = clusterOf.has(m.a) && clusterOf.get(m.a) === clusterOf.get(m.b);
    lines.push([m.a, m.a_url || '', m.b, m.b_url || '', m.common, merge ? 'да' : ''].map(_tsv).join('\t'));
  }
  try {
    await navigator.clipboard.writeText(lines.join('\r\n'));
    alert('Скопировано. Вставьте в Excel/Sheets.');
  } catch (_) { cann.value.error = 'Не удалось скопировать в буфер'; }
}
function downloadCannCsv() {
  if (!cann.value.task) return;
  const token = localStorage.getItem('seo_token') || '';
  fetch(`/api/cannibalization/tasks/${cann.value.task.id}/export.csv`, {
    headers: { Authorization: 'Bearer ' + token },
  }).then((r) => r.blob()).then((b) => _saveBlob(b, `cannibalization-${cann.value.task.id}.csv`))
    .catch((e) => { cann.value.error = _msg(e); });
}
function downloadCannXlsx() {
  if (!cann.value.task) return;
  const token = localStorage.getItem('seo_token') || '';
  fetch(`/api/cannibalization/tasks/${cann.value.task.id}/export.xlsx`, {
    headers: { Authorization: 'Bearer ' + token },
  }).then((r) => r.blob()).then((b) => _saveBlob(b, `cannibalization-${cann.value.task.id}.xlsx`))
    .catch((e) => { cann.value.error = _msg(e); });
}
function aiForCluster(id) {
  const r = cann.value.result;
  if (!r || !r.ai) return null;
  return r.ai.find((a) => Number(a.cluster_id) === Number(id)) || null;
}

function statusBadge(code) {
  const c = Number(code);
  if (!c) return 'badge badge-muted';
  if (c >= 500) return 'badge badge-error';
  if (c >= 400) return 'badge badge-warn';
  if (c >= 300) return 'badge badge-info';
  return 'badge badge-ok';
}

// Поллинг статуса для выбранной задачи (раз в 3 сек, пока running/queued).
function startPolling() {
  stopPolling();
  pollHandle.value = setInterval(async () => {
    if (!selectedId.value) return;
    await loadTask();
    await fetchTasks();                              // обновляем счётчик stats.pages в списке
    if (selected.value && (selected.value.status === 'running' || selected.value.status === 'queued')) {
      await loadPages();
    } else if (selected.value && (selected.value.status === 'done'
                               || selected.value.status === 'cancelled'
                               || selected.value.status === 'error')) {
      await loadPages();
      await loadTree();
      stopPolling();
    } else { stopPolling(); }
  }, 3000);
}
function stopPolling() {
  if (pollHandle.value) { clearInterval(pollHandle.value); pollHandle.value = null; }
}

const statusLabel = (s) => ({
  queued: 'в очереди', running: 'идёт обход', done: 'готово',
  cancelled: 'отменено', error: 'ошибка', timeout: 'таймаут',
}[s] || s || '—');

// Сколько страниц уже найдено — приоритет: server stats → длина items.
const foundCount = computed(() => {
  const st = selected.value && selected.value.stats;
  if (st && typeof st === 'object' && Number.isFinite(Number(st.pages))) {
    return Number(st.pages);
  }
  return pagesTotal.value || pages.value.length;
});
const queuedCount = computed(() => {
  const st = selected.value && selected.value.stats;
  return (st && Number(st.queued)) || 0;
});
watch(selectedId, () => startPolling());

onMounted(fetchTasks);
onUnmounted(() => { stopPolling(); stopCannPolling(); });
</script>

<template>
  <AppLayout>
    <div class="crawler-page">
      <div style="margin-bottom:.5rem"><router-link to="/audits" style="color:#1d4ed8;text-decoration:none">← Аудиты</router-link></div>
      <h1>Парсер структуры сайта</h1>
      <p class="hint">Введите URL — соберём структуру URL, H1, Title и Description.
        Результат можно посмотреть таблицей, в виде дерева, скопировать в Excel или
        выгрузить CSV/XLSX.</p>

      <section class="card">
        <h2>Новая задача</h2>
        <div class="form-grid">
          <label>URL сайта
            <input v-model="form.start_url" placeholder="https://example.com" />
          </label>
          <label>Макс. страниц
            <input type="number" min="1" max="10000" v-model.number="form.maxPages" />
          </label>
          <label>Макс. глубина
            <input type="number" min="0" max="20" v-model.number="form.maxDepth" />
          </label>
          <label>Concurrency
            <input type="number" min="1" max="16" v-model.number="form.concurrency" />
          </label>
          <label class="checkbox">
            <input type="checkbox" v-model="form.includeSubdomains" /> Поддомены
          </label>
          <label class="checkbox">
            <input type="checkbox" v-model="form.respectRobots" /> Уважать robots.txt
          </label>
        </div>
        <button class="primary" :disabled="loading" @click="startCrawl">Запустить</button>
        <div v-if="error" class="error">{{ error }}</div>
      </section>

      <section class="card">
        <h2>Задачи</h2>
        <table class="tbl small">
          <thead>
            <tr><th>#</th><th>URL</th><th>Статус</th><th>Найдено</th><th>Создана</th><th class="actions-col"></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id" :class="{ active: t.id === selectedId }">
              <td><a href="#" @click.prevent="selectTask(t.id)">{{ t.id }}</a></td>
              <td class="ellipsis">{{ t.start_url }}</td>
              <td><span :class="'badge badge-' + t.status">{{ statusLabel(t.status) }}</span></td>
              <td class="num">{{ (t.stats && t.stats.pages) || 0 }}</td>
              <td>{{ new Date(t.created_at).toLocaleString() }}</td>
              <td class="actions-col">
                <div class="row-actions">
                  <button class="primary small" @click="selectTask(t.id)">Открыть</button>
                  <button class="danger small" @click="deleteTask(t.id)" title="Удалить задачу">×</button>
                </div>
              </td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="6" class="muted">Задач пока нет</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="selected" class="card">
        <div class="task-header">
          <div>
            <h2>Задача #{{ selected.id }}</h2>
            <div class="muted small-meta">{{ selected.start_url }} · статус
              <span :class="'badge badge-' + selected.status">{{ statusLabel(selected.status) }}</span>
            </div>
            <div v-if="selected.error" class="error small-meta">Ошибка: {{ selected.error }}</div>
          </div>
          <div class="header-counters">
            <div class="counter">
              <div class="counter-lbl">Найдено страниц</div>
              <div class="counter-val">{{ foundCount }}</div>
            </div>
            <div v-if="queuedCount > 0 && (selected.status === 'running' || selected.status === 'queued')"
                 class="counter counter-muted">
              <div class="counter-lbl">В очереди</div>
              <div class="counter-val">{{ queuedCount }}</div>
            </div>
            <button v-if="selected.status === 'running' || selected.status === 'queued'"
                    class="warn" @click="cancelTask">Отменить</button>
          </div>
        </div>

        <div class="tabs">
          <button :class="{ active: tab === 'table'   }" @click="tab = 'table'">Таблица</button>
          <button :class="{ active: tab === 'tree'    }" @click="tab = 'tree'">Дерево сайта</button>
          <button :class="{ active: tab === 'cannibal'}" @click="tab = 'cannibal'">🔎 Каннибализация</button>
          <button :class="{ active: tab === 'summary' }" @click="tab = 'summary'">Сводка</button>
        </div>

        <!-- TABLE -->
        <div v-if="tab === 'table'">
          <div class="toolbar">
            <input v-model="searchText" placeholder="Поиск по URL/title/h1" />
            <label class="checkbox"><input type="checkbox" v-model="fieldsShow.url" /> URL</label>
            <label class="checkbox"><input type="checkbox" v-model="fieldsShow.h1" /> H1</label>
            <label class="checkbox"><input type="checkbox" v-model="fieldsShow.title" /> Title</label>
            <label class="checkbox"><input type="checkbox" v-model="fieldsShow.description" /> Description</label>
            <button @click="copyToExcel">📋 Копировать в Excel</button>
            <button @click="downloadCsv">⬇ CSV</button>
            <button @click="downloadXlsx">⬇ XLSX</button>
          </div>
          <div class="results-count">
            Показано: <b>{{ filteredPages.length }}</b>
            <span v-if="searchText.trim()"> из {{ pages.length }}</span>
            <span v-else> страниц</span>
            <span v-if="pagesTotal > pages.length" class="muted"> · всего в БД: {{ pagesTotal }}</span>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>#</th><th v-if="fieldsShow.url">URL</th><th>Статус</th>
                <th>Глубина</th>
                <th v-if="fieldsShow.h1">H1</th>
                <th v-if="fieldsShow.title">Title</th>
                <th v-if="fieldsShow.description">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in filteredPages" :key="p.url + i">
                <td>{{ i + 1 }}</td>
                <td v-if="fieldsShow.url" class="ellipsis"><a :href="p.url" target="_blank" rel="noopener">{{ p.url }}</a></td>
                <td><span :class="statusBadge(p.http_status)">{{ p.http_status || '—' }}</span></td>
                <td>{{ p.depth }}</td>
                <td v-if="fieldsShow.h1" class="ellipsis">{{ p.h1 }}</td>
                <td v-if="fieldsShow.title" class="ellipsis">{{ p.title }}</td>
                <td v-if="fieldsShow.description" class="desc-cell">{{ p.description }}</td>
              </tr>
              <tr v-if="!filteredPages.length"><td colspan="7" class="muted">Пока пусто</td></tr>
            </tbody>
          </table>
        </div>

        <!-- TREE -->
        <div v-else-if="tab === 'tree'" class="tree-wrap-outer">
          <div class="toolbar">
            <button @click="expandAllTree">⊕ Развернуть всё</button>
            <button @click="collapseAllTree">⊖ Свернуть всё</button>
            <span class="muted small">Разделы сайта выделены цветом: блог, услуги, новости, каталог…</span>
          </div>
          <div class="tree-wrap">
            <UrlTreeNode v-if="tree" :node="tree" :root="true" :depth="0"
                         :expand-all="treeExpandTick" :collapse-all="treeCollapseTick" />
            <div v-else class="muted">Дерева ещё нет</div>
          </div>
        </div>

        <!-- CANNIBALIZATION -->
        <div v-else-if="tab === 'cannibal'" class="cannibal-wrap">
          <div class="cann-intro">
            <p class="hint">
              Проверяем каннибализацию по методу пересечения выдачи: берём H1 страниц как запросы,
              снимаем топ-{{ cannForm.topN }} в выбранном гео и ищем пары запросов, которые делят
              ≥ {{ cannForm.minCommonUrls }} одинаковых URL. Такие страницы конкурируют за один интент —
              кандидаты на слияние.
            </p>
          </div>

          <!-- Конфигурация запуска -->
          <div class="cann-config">
            <div class="cfg-row" data-region-picker>
              <label class="cfg-label">Регион (lr)</label>
              <div class="region-picker">
                <button type="button" class="region-btn" @click="regionDropdown = !regionDropdown">
                  <span>{{ currentRegionLabel }}</span>
                  <span class="muted">{{ regionDropdown ? '▲' : '▼' }}</span>
                </button>
                <div v-if="regionDropdown" class="region-dropdown">
                  <input v-model="regionQuery" placeholder="Поиск региона или lr…" class="region-search" />
                  <ul>
                    <li v-for="r in filteredRegions" :key="r.code" @click="pickRegion(r)">
                      <span class="region-dot" :style="{ background: regionGroupColor(r.group) }"></span>
                      {{ r.name }} <span class="muted">lr={{ r.code }}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
            <div class="cfg-row">
              <label class="cfg-label">Поисковик</label>
              <select v-model="cannForm.engine">
                <option value="yandex">Яндекс</option>
                <option value="google">Google</option>
              </select>
            </div>
            <div class="cfg-row">
              <label class="cfg-label">Порог общих URL</label>
              <input type="number" min="1" max="10" v-model.number="cannForm.minCommonUrls" />
            </div>
            <div class="cfg-row">
              <label class="cfg-label">Топ-N</label>
              <input type="number" min="3" max="30" v-model.number="cannForm.topN" />
            </div>
            <div class="cfg-row">
              <label class="cfg-label">Макс. запросов</label>
              <input type="number" min="1" max="1000" v-model.number="cannForm.maxQueries" />
            </div>
            <div class="cfg-row">
              <label class="checkbox"><input type="checkbox" v-model="cannForm.useAI" /> AI-разбор кластеров</label>
            </div>
            <div class="cfg-actions">
              <button class="primary" :disabled="cann.running || !hasH1"
                      @click="startCannibalization">Сканер каннибализации</button>
              <button v-if="cann.running" class="warn" @click="cancelCannibalization">Отменить</button>
              <button v-if="cann.result" @click="resetCannibalization">Новый запуск</button>
              <span v-if="!hasH1" class="muted small">Нет собранных H1 — сначала дождитесь обхода.</span>
            </div>
            <div v-if="cann.error" class="error">{{ cann.error }}</div>
          </div>

          <!-- Прогресс -->
          <div v-if="cann.running && cannProgress" class="cann-progress">
            <div class="prog-lbl">{{ cannPhaseLabel(cannProgress.phase) }}:
              снято {{ cannProgress.done }} из {{ cannProgress.total }}
              <span v-if="cannProgress.errors"> · ошибок: {{ cannProgress.errors }}</span>
            </div>
            <div class="prog-bar">
              <div class="prog-fill" :style="{ width: (cannProgress.total ? (cannProgress.done / cannProgress.total * 100) : 5) + '%' }"></div>
            </div>
          </div>

          <!-- Результат -->
          <div v-if="cann.result" class="cann-result">
            <div class="cann-summary">
              <div class="kpi"><div class="lbl">Проверено запросов</div><div class="val">{{ cann.result.summary.totalQueries }}</div></div>
              <div class="kpi"><div class="lbl">Кластеров под слияние</div><div class="val" :class="{ danger: cann.result.summary.clusterCount }">{{ cann.result.summary.clusterCount }}</div></div>
              <div class="kpi"><div class="lbl">Страниц под разбор</div><div class="val" :class="{ danger: cann.result.summary.pagesToMerge }">{{ cann.result.summary.pagesToMerge }}</div></div>
              <div class="kpi"><div class="lbl">Порог</div><div class="val">≥ {{ cann.result.params.minCommonUrls }}</div></div>
            </div>

            <div class="toolbar">
              <button @click="copyCannToExcel">📋 Копировать в Excel</button>
              <button @click="downloadCannCsv">⬇ CSV</button>
              <button @click="downloadCannXlsx">⬇ XLSX</button>
            </div>

            <div v-if="!cann.result.clusters.length" class="cann-ok">
              ✅ Явной каннибализации не найдено (нет пар с ≥ {{ cann.result.params.minCommonUrls }} общими URL).
            </div>

            <!-- Кластеры под слияние -->
            <div v-for="c in cann.result.clusters" :key="c.id" class="cluster-card">
              <div class="cluster-head">
                <span class="cluster-badge">Кластер {{ c.id }}</span>
                <span class="cluster-meta">{{ c.size }} страниц · до {{ c.maxCommon }} общих URL</span>
              </div>
              <ul class="cluster-members">
                <li v-for="(m, i) in c.members" :key="i">
                  <span class="mem-q">{{ m.query }}</span>
                  <a v-if="m.source_url" :href="m.source_url" target="_blank" rel="noopener" class="mem-url">{{ m.source_url }}</a>
                </li>
              </ul>
              <details v-if="c.sharedUrls && c.sharedUrls.length" class="cluster-shared">
                <summary>Общие URL в выдаче ({{ c.sharedUrls.length }})</summary>
                <ul>
                  <li v-for="(u, i) in c.sharedUrls" :key="i"><a :href="u" target="_blank" rel="noopener">{{ u }}</a></li>
                </ul>
              </details>
              <div v-if="aiForCluster(c.id)" class="cluster-ai">
                <b>AI:</b> оставить <code>{{ aiForCluster(c.id).keep }}</code>.
                {{ aiForCluster(c.id).reason }}
              </div>
            </div>

            <!-- Свой домен несколько раз в топе -->
            <div v-if="cann.result.ownDomainDuplicates && cann.result.ownDomainDuplicates.length" class="own-dup">
              <h3>Свой домен ≥ 2 раз в топе одного запроса</h3>
              <ul>
                <li v-for="(d, i) in cann.result.ownDomainDuplicates" :key="i">
                  <b>{{ d.query }}</b>: {{ d.urls.join(', ') }}
                </li>
              </ul>
            </div>

            <!-- Матрица общих URL -->
            <details v-if="cannMatrixView.queries.length" class="matrix-details">
              <summary>Матрица общих URL (запрос × запрос)</summary>
              <div class="matrix-scroll">
                <table class="matrix">
                  <thead>
                    <tr>
                      <th></th>
                      <th v-for="(q, j) in cannMatrixView.queries" :key="j" :title="q">{{ j + 1 }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(qa, i) in cannMatrixView.queries" :key="i">
                      <th :title="qa">{{ i + 1 }}. {{ qa }}</th>
                      <td v-for="(qb, j) in cannMatrixView.queries" :key="j" :class="cannCellClass(qa, qb)">
                        {{ qa === qb ? '—' : cannCell(qa, qb) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </div>

        <!-- SUMMARY -->
        <div v-else class="summary-grid">
          <div class="kpi"><div class="lbl">Всего страниц</div><div class="val">{{ summary.total }}</div></div>
          <div class="kpi"><div class="lbl">Без Title</div><div class="val">{{ summary.noTitle }}</div></div>
          <div class="kpi"><div class="lbl">Без H1</div><div class="val">{{ summary.noH1 }}</div></div>
          <div class="kpi"><div class="lbl">Дубль Title</div><div class="val">{{ summary.dupTitles }}</div></div>
          <div class="kpi"><div class="lbl">Длинный Description</div><div class="val">{{ summary.longDesc }}</div></div>
          <div class="kpi"><div class="lbl">Средняя глубина</div><div class="val">{{ summary.avgDepth }}</div></div>
          <div class="kpi wide">
            <div class="lbl">HTTP коды</div>
            <div class="val">
              <span v-for="(n, k) in summary.byStatus" :key="k" class="badge" style="margin-right:6px">{{ k }}: {{ n }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </AppLayout>
</template>

<style scoped>
.crawler-page { padding: 1.25rem; max-width: 1400px; margin: 0 auto; color: #1f2937; }
.crawler-page h1 { color: #111827; margin-bottom: .5rem; }
.crawler-page h2 { color: #111827; font-size: 1.05rem; margin: 0 0 .6rem; }
.hint  { color: #374151; margin-bottom: 1rem; }
.card  { background: #fff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
         box-shadow: 0 1px 3px rgba(0,0,0,.06); border: 1px solid #e5e7eb; }
.form-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr; gap: .75rem; align-items: end; margin-bottom: .75rem; }
.form-grid label { display: flex; flex-direction: column; font-size: .85rem; color: #374151; }
.form-grid input[type="text"], .form-grid input[type="number"], .form-grid input:not([type]) {
  padding: .4rem; border: 1px solid #cbd5e1; border-radius: 4px; color: #111827; background: #fff;
}
.checkbox { flex-direction: row !important; align-items: center; gap: .35rem; color: #374151; }
button { padding: .4rem .8rem; border: 1px solid #cbd5e1; background: #f3f4f6; color: #111827;
         border-radius: 4px; cursor: pointer; }
button:hover:not(:disabled) { background: #e5e7eb; }
button.primary { background: #2b7cff; color: #fff; border-color: #2b7cff; }
button.primary:hover:not(:disabled) { background: #1f6ae0; border-color: #1f6ae0; }
button.danger  { background: #fff; color: #c33; border-color: #c33; }
button.warn    { background: #f9b80b; color: #fff; border-color: #f9b80b; }
button.small   { padding: .15rem .4rem; font-size: .8rem; }

/* tabs */
.tabs          { margin-bottom: .75rem; }
.tabs button   { margin-right: .25rem; }
.tabs button.active { background: #2b7cff; color: #fff; border-color: #2b7cff; }

/* tables — общая выкладка с улучшенной читаемостью */
.tbl   { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: .5rem;
         background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
.tbl th, .tbl td { padding: .55rem .7rem; font-size: .88rem; text-align: left; vertical-align: top;
                   color: #111827; border-bottom: 1px solid #eef2f7; }
.tbl th { background: #f8fafc; color: #1e293b; font-weight: 600; font-size: .8rem;
          text-transform: uppercase; letter-spacing: .02em; border-bottom: 1px solid #cbd5e1; }
.tbl tbody tr:nth-child(even) td { background: #fafbfc; }
.tbl tbody tr:hover td { background: #eef5ff; }
.tbl tr.active td { background: #e0ecff !important; }
.tbl td a { color: #1d4ed8; text-decoration: none; }
.tbl td a:hover { text-decoration: underline; }
.tbl tbody tr:last-child td { border-bottom: 0; }
.tbl.small td, .tbl.small th { font-size: .8rem; padding: .4rem .55rem; }
.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }

.ellipsis { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Задача 3: длинный Description переносится по словам и не выходит за поле. */
.desc-cell { max-width: 420px; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
/* Задача 2/4: компактная колонка действий, кнопки не «прыгают» по ширине. */
.actions-col { width: 1%; white-space: nowrap; }
.row-actions { display: flex; gap: .35rem; justify-content: flex-end; align-items: center; }
.muted    { color: #6b7280; }
.error    { color: #b91c1c; margin-top: .5rem; }
.small-meta { font-size: .85rem; margin-top: .25rem; }
.toolbar  { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
.toolbar input { flex: 1; min-width: 200px; padding: .4rem .55rem; border: 1px solid #cbd5e1;
                 border-radius: 4px; color: #111827; background: #fff; }
.results-count { font-size: .85rem; color: #374151; margin: .25rem 0 .5rem; }
.results-count b { color: #111827; }

/* badges */
.badge    { display: inline-block; padding: .1rem .5rem; border-radius: 10px; font-size: .75rem;
            line-height: 1.4; font-weight: 600; }
.badge-ok      { background: #d4edda; color: #155724; }
.badge-warn    { background: #fff3cd; color: #856404; }
.badge-error   { background: #f8d7da; color: #721c24; }
.badge-info    { background: #d1ecf1; color: #0c5460; }
.badge-muted   { background: #e5e7eb; color: #374151; }
.badge-running { background: #cfe2ff; color: #084298; }
.badge-queued  { background: #e2e3e5; color: #41464b; }
.badge-done    { background: #d4edda; color: #155724; }
.badge-cancelled { background: #e2e3e5; color: #41464b; }

/* task header + live counters */
.task-header { display: flex; justify-content: space-between; align-items: flex-start;
               margin-bottom: .75rem; gap: 1rem; flex-wrap: wrap; }
.task-header h2 { margin: 0 0 .15rem; }
.header-counters { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.counter { background: #eef5ff; border: 1px solid #c7dbff; border-radius: 6px;
           padding: .4rem .8rem; min-width: 110px; text-align: center; }
.counter-lbl { font-size: .7rem; color: #1e3a8a; text-transform: uppercase;
               letter-spacing: .03em; font-weight: 600; }
.counter-val { font-size: 1.5rem; font-weight: 700; color: #0b2a6b;
               font-variant-numeric: tabular-nums; line-height: 1.1; }
.counter-muted { background: #f3f4f6; border-color: #e5e7eb; }
.counter-muted .counter-lbl { color: #4b5563; }
.counter-muted .counter-val { color: #1f2937; }

/* tree */
.tree-wrap-outer { }
.tree-wrap   { font-family: ui-monospace, monospace; font-size: .85rem; line-height: 1.6;
               max-height: 640px; overflow: auto; padding: .6rem; background: #fafafa;
               border: 1px solid #e5e7eb; border-radius: 6px; color: #1f2937; }
.tree-row    { display: flex; align-items: center; gap: .4rem; padding: 2px 0; flex-wrap: wrap; }
.tree-row-top { padding: .35rem 0; margin-top: .25rem; }
.tree-node-top { margin-bottom: .35rem; }
.tree-children { margin-left: 1rem; border-left: 2px solid #e2e8f0; padding-left: .6rem; }
.tree-node-top > .tree-children { border-left-width: 2px; }
.caret       { cursor: pointer; width: 1em; display: inline-block; color: #2b7cff; user-select: none; }
.caret:focus { outline: 2px solid #93c5fd; border-radius: 3px; }
.caret-empty { width: 1em; display: inline-block; color: #cbd5e1; }
.tree-url    { color: #1d4ed8; text-decoration: none; }
.tree-url:hover { text-decoration: underline; }
.tree-url-top { font-weight: 700; font-size: 1rem; }
.tree-title  { color: #6b7280; font-size: .8rem; }
.sec-icon    { font-size: 1.05rem; }
.sec-badge   { color: #fff; font-size: .68rem; font-weight: 700; padding: .05rem .45rem;
               border-radius: 10px; text-transform: uppercase; letter-spacing: .02em; }
.tree-count  { background: #eef2f7; color: #475569; font-size: .7rem; font-weight: 600;
               padding: .05rem .4rem; border-radius: 8px; }

/* cannibalization */
.cannibal-wrap { }
.cann-intro .hint { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px;
                    padding: .6rem .8rem; }
.cann-config { display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: flex-end;
               background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
               padding: .9rem; margin-bottom: .9rem; }
.cfg-row { display: flex; flex-direction: column; gap: .25rem; }
.cfg-label { font-size: .75rem; color: #4b5563; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
.cann-config input[type="number"], .cann-config select {
  padding: .4rem .5rem; border: 1px solid #cbd5e1; border-radius: 4px; color: #111827; background: #fff; min-width: 90px; }
.cfg-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-left: auto; }

/* region picker */
.region-picker { position: relative; }
.region-btn { display: flex; align-items: center; gap: .5rem; justify-content: space-between;
              min-width: 240px; background: #fff; border: 1px solid #cbd5e1; }
.region-dropdown { position: absolute; z-index: 30; top: 110%; left: 0; width: 320px; max-height: 320px;
                   overflow: auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px;
                   box-shadow: 0 8px 24px rgba(0,0,0,.12); }
.region-search { width: calc(100% - 1rem); margin: .5rem; padding: .4rem .5rem; border: 1px solid #cbd5e1; border-radius: 4px; }
.region-dropdown ul { list-style: none; margin: 0; padding: 0; }
.region-dropdown li { padding: .35rem .6rem; cursor: pointer; font-size: .85rem; display: flex; align-items: center; gap: .4rem; }
.region-dropdown li:hover { background: #eef5ff; }
.region-dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; }

/* progress */
.cann-progress { margin: .5rem 0 1rem; }
.prog-lbl { font-size: .85rem; color: #374151; margin-bottom: .3rem; }
.prog-bar { height: 8px; background: #e5e7eb; border-radius: 6px; overflow: hidden; }
.prog-fill { height: 100%; background: #2b7cff; transition: width .4s ease; }

/* cann result */
.cann-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: .75rem; }
.kpi .val.danger { color: #b91c1c; }
.cann-ok { background: #d4edda; color: #155724; padding: .7rem 1rem; border-radius: 6px; font-weight: 600; }
.cluster-card { border: 1px solid #fca5a5; background: #fff5f5; border-radius: 8px; padding: .8rem; margin-bottom: .7rem; }
.cluster-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; }
.cluster-badge { background: #dc2626; color: #fff; font-weight: 700; font-size: .75rem;
                 padding: .1rem .55rem; border-radius: 10px; }
.cluster-meta { color: #7f1d1d; font-size: .8rem; font-weight: 600; }
.cluster-members { list-style: none; margin: 0; padding: 0; }
.cluster-members li { padding: .25rem 0; border-bottom: 1px dashed #fecaca; display: flex; flex-direction: column; }
.cluster-members li:last-child { border-bottom: 0; }
.mem-q { font-weight: 600; color: #111827; }
.mem-url { color: #1d4ed8; text-decoration: none; font-size: .82rem; word-break: break-all; }
.mem-url:hover { text-decoration: underline; }
.cluster-shared { margin-top: .5rem; font-size: .82rem; }
.cluster-shared summary { cursor: pointer; color: #7f1d1d; font-weight: 600; }
.cluster-shared ul { margin: .35rem 0 0; padding-left: 1.1rem; }
.cluster-shared a { color: #1d4ed8; text-decoration: none; word-break: break-all; }
.cluster-ai { margin-top: .5rem; background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 6px;
              padding: .5rem .6rem; font-size: .84rem; color: #3730a3; }
.cluster-ai code { background: #e0e7ff; padding: 0 .3rem; border-radius: 3px; }
.own-dup { margin-top: 1rem; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: .7rem .9rem; }
.own-dup h3 { margin: 0 0 .4rem; font-size: .95rem; color: #92400e; }
.own-dup ul { margin: 0; padding-left: 1.1rem; font-size: .85rem; }

/* matrix */
.matrix-details { margin-top: 1rem; }
.matrix-details summary { cursor: pointer; font-weight: 600; color: #374151; }
.matrix-scroll { overflow: auto; max-height: 500px; margin-top: .5rem; border: 1px solid #e5e7eb; border-radius: 6px; }
.matrix { border-collapse: collapse; font-size: .78rem; }
.matrix th, .matrix td { border: 1px solid #e5e7eb; padding: .25rem .45rem; text-align: center; white-space: nowrap; }
.matrix thead th { background: #f8fafc; position: sticky; top: 0; }
.matrix tbody th { text-align: left; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
                   background: #f8fafc; position: sticky; left: 0; }
.matrix td.mx-hit  { background: #fca5a5; color: #7f1d1d; font-weight: 700; }
.matrix td.mx-warn { background: #fef3c7; color: #92400e; }
.matrix td.mx-zero { color: #cbd5e1; }
.matrix td.mx-self { background: #f1f5f9; }

/* summary */
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
.kpi  { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: .75rem; }
.kpi .lbl { color: #4b5563; font-size: .75rem; text-transform: uppercase; letter-spacing: .02em; }
.kpi .val { font-size: 1.5rem; font-weight: 700; margin-top: .25rem; color: #111827;
            font-variant-numeric: tabular-nums; }
.kpi.wide { grid-column: 1 / -1; }
</style>
