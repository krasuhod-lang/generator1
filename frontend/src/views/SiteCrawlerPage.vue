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

// Рекурсивный компонент UrlTreeNode — определён здесь, чтобы не плодить
// отдельный файл. Принимает node {segment, fullUrl, isVirtual, title, h1,
// description, status, children:[]}. Сворачиваемый по клику на каретку.
const UrlTreeNode = defineComponent({
  name: 'UrlTreeNode',
  props: { node: Object, root: Boolean },
  setup(props) {
    const open = ref(props.root || (props.node && props.node.depth <= 1));
    return { open };
  },
  render() {
    const n = this.node;
    if (!n) return null;
    const has = n.children && n.children.length;
    const head = h('div', { class: 'tree-row' }, [
      has ? h('span', { class: 'caret', onClick: () => { this.open = !this.open; } },
              this.open ? '▾' : '▸')
          : h('span', { class: 'caret-empty' }, '·'),
      h('a', { href: n.fullUrl, target: '_blank', rel: 'noopener', class: 'tree-url' },
        n.segment || n.fullUrl),
      n.status ? h('span', { class: 'badge badge-ok' }, String(n.status)) : null,
      n.isVirtual ? h('span', { class: 'badge badge-muted' }, 'virtual') : null,
      n.title ? h('span', { class: 'tree-title' }, ' — ' + n.title) : null,
    ]);
    if (!has || !this.open) return head;
    return h('div', { class: 'tree-node' }, [
      head,
      h('div', { class: 'tree-children' },
        n.children.map((c) => h(UrlTreeNode, { node: c, key: c.fullUrl }))),
    ]);
  },
});

// ── state ────────────────────────────────────────────────────────────
const tasks       = ref([]);
const selectedId  = ref(null);
const selected    = ref(null);
const pages       = ref([]);
const tree        = ref(null);
const tab         = ref('table');        // 'table' | 'tree' | 'summary'
const loading     = ref(false);
const error       = ref(null);
const pollHandle  = ref(null);
const searchText  = ref('');
const fieldsShow  = ref({ url: true, h1: true, title: true, description: true });

const form = ref({
  start_url:         '',
  maxPages:          500,
  maxDepth:          5,
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
    const { data } = await api.get('/api/site-crawler/tasks');
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
    const { data } = await api.post('/api/site-crawler/tasks', payload);
    await fetchTasks();
    selectTask(data.id);
  } catch (e) { error.value = _msg(e); }
  finally { loading.value = false; }
}

async function selectTask(id) {
  selectedId.value = id;
  await Promise.all([loadTask(), loadPages(), loadTree()]);
}

async function loadTask() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/api/site-crawler/tasks/${selectedId.value}`);
    selected.value = data;
  } catch (e) { selected.value = null; }
}

async function loadPages() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/api/site-crawler/tasks/${selectedId.value}/pages`, {
      params: { limit: 500 },
    });
    pages.value = data.items || [];
  } catch (_) { pages.value = []; }
}

async function loadTree() {
  if (!selectedId.value) return;
  try {
    const { data } = await api.get(`/api/site-crawler/tasks/${selectedId.value}/tree`);
    tree.value = data.tree;
  } catch (_) { tree.value = null; }
}

async function cancelTask() {
  if (!selectedId.value) return;
  try {
    await api.post(`/api/site-crawler/tasks/${selectedId.value}/cancel`);
    await loadTask();
  } catch (e) { error.value = _msg(e); }
}

async function deleteTask(id) {
  if (!confirm('Удалить задачу?')) return;
  try {
    await api.delete(`/api/site-crawler/tasks/${id}`);
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
    if (selected.value && (selected.value.status === 'running' || selected.value.status === 'queued')) {
      await loadPages();
    } else if (selected.value && selected.value.status === 'done') {
      await loadPages();
      await loadTree();
      stopPolling();
    } else { stopPolling(); }
  }, 3000);
}
function stopPolling() {
  if (pollHandle.value) { clearInterval(pollHandle.value); pollHandle.value = null; }
}
watch(selectedId, () => startPolling());

onMounted(fetchTasks);
onUnmounted(stopPolling);
</script>

<template>
  <AppLayout>
    <div class="crawler-page">
      <h1>Парсер сайта</h1>
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
            <tr><th>#</th><th>URL</th><th>Статус</th><th>Страниц</th><th>Создана</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id" :class="{ active: t.id === selectedId }">
              <td><a href="#" @click.prevent="selectTask(t.id)">{{ t.id }}</a></td>
              <td class="ellipsis">{{ t.start_url }}</td>
              <td><span :class="'badge badge-' + t.status">{{ t.status }}</span></td>
              <td>{{ (t.stats && t.stats.pages) || 0 }}</td>
              <td>{{ new Date(t.created_at).toLocaleString() }}</td>
              <td><button class="danger small" @click="deleteTask(t.id)">×</button></td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="6" class="muted">Задач пока нет</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="selected" class="card">
        <div class="task-header">
          <div>
            <h2>Задача #{{ selected.id }}</h2>
            <div class="muted">{{ selected.start_url }} · статус
              <span :class="'badge badge-' + selected.status">{{ selected.status }}</span>
            </div>
          </div>
          <div>
            <button v-if="selected.status === 'running' || selected.status === 'queued'"
                    class="warn" @click="cancelTask">Отменить</button>
          </div>
        </div>

        <div class="tabs">
          <button :class="{ active: tab === 'table'   }" @click="tab = 'table'">Таблица</button>
          <button :class="{ active: tab === 'tree'    }" @click="tab = 'tree'">Дерево URL</button>
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
                <td v-if="fieldsShow.description" class="ellipsis">{{ p.description }}</td>
              </tr>
              <tr v-if="!filteredPages.length"><td colspan="7" class="muted">Пока пусто</td></tr>
            </tbody>
          </table>
        </div>

        <!-- TREE -->
        <div v-else-if="tab === 'tree'" class="tree-wrap">
          <UrlTreeNode v-if="tree" :node="tree" :root="true" />
          <div v-else class="muted">Дерева ещё нет</div>
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
.crawler-page { padding: 1.25rem; max-width: 1400px; margin: 0 auto; }
.hint  { color: #555; margin-bottom: 1rem; }
.card  { background: #fff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
         box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.form-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr; gap: .75rem; align-items: end; margin-bottom: .75rem; }
.form-grid label { display: flex; flex-direction: column; font-size: .85rem; color: #444; }
.form-grid input[type="text"], .form-grid input[type="number"], .form-grid input:not([type]) {
  padding: .4rem; border: 1px solid #ccc; border-radius: 4px;
}
.checkbox { flex-direction: row !important; align-items: center; gap: .35rem; }
button { padding: .4rem .8rem; border: 1px solid #ccc; background: #f7f7f7; border-radius: 4px; cursor: pointer; }
button.primary { background: #2b7cff; color: #fff; border-color: #2b7cff; }
button.danger  { background: #fff; color: #c33; border-color: #c33; }
button.warn    { background: #f9b80b; color: #fff; border-color: #f9b80b; }
button.small   { padding: .15rem .4rem; font-size: .8rem; }
.tabs button   { margin-right: .25rem; }
.tabs button.active { background: #2b7cff; color: #fff; border-color: #2b7cff; }
.tbl   { width: 100%; border-collapse: collapse; margin-top: .5rem; }
.tbl th, .tbl td { border-bottom: 1px solid #eee; padding: .35rem .5rem; font-size: .85rem; text-align: left; vertical-align: top; }
.tbl tr.active td { background: #eef5ff; }
.tbl.small td, .tbl.small th { font-size: .8rem; }
.ellipsis { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted    { color: #888; }
.error    { color: #c33; margin-top: .5rem; }
.toolbar  { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
.toolbar input { flex: 1; min-width: 200px; padding: .35rem; border: 1px solid #ccc; border-radius: 4px; }
.badge    { display: inline-block; padding: 0 .4rem; border-radius: 10px; font-size: .75rem; line-height: 1.4; }
.badge-ok      { background: #d4edda; color: #155724; }
.badge-warn    { background: #fff3cd; color: #856404; }
.badge-error   { background: #f8d7da; color: #721c24; }
.badge-info    { background: #d1ecf1; color: #0c5460; }
.badge-muted   { background: #eee;    color: #555; }
.badge-running { background: #cfe2ff; color: #084298; }
.badge-queued  { background: #e2e3e5; color: #41464b; }
.badge-done    { background: #d4edda; color: #155724; }
.badge-cancelled { background: #e2e3e5; color: #41464b; }
.task-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: .75rem; }
.tabs        { margin-bottom: .75rem; }
.tree-wrap   { font-family: ui-monospace, monospace; font-size: .85rem; line-height: 1.45; max-height: 600px; overflow: auto; padding: .5rem; background: #fafafa; border-radius: 4px; }
.tree-row    { display: flex; align-items: center; gap: .4rem; padding: 1px 0; }
.tree-children { margin-left: 1rem; border-left: 1px dotted #ddd; padding-left: .5rem; }
.caret       { cursor: pointer; width: 1em; display: inline-block; color: #2b7cff; }
.caret-empty { width: 1em; display: inline-block; color: #ccc; }
.tree-url    { color: #1a4789; text-decoration: none; }
.tree-url:hover { text-decoration: underline; }
.tree-title  { color: #666; font-size: .8rem; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
.kpi  { background: #f7f8fa; border-radius: 6px; padding: .75rem; }
.kpi .lbl { color: #666; font-size: .75rem; text-transform: uppercase; }
.kpi .val { font-size: 1.5rem; font-weight: 600; margin-top: .25rem; }
.kpi.wide { grid-column: 1 / -1; }
</style>
