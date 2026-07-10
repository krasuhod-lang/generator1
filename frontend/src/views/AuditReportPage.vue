<script setup>
/**
 * AuditReportPage — дашборд отчёта аудита /audits/:taskId.
 *
 * Верх: круговой Health Score (зелёный >80 / жёлтый 50–79 / красный <50) +
 * счётчики Critical/High/Medium/Low. Табы: Обзор (все ошибки с фильтрами),
 * Страницы (таблица URL), Дубликаты (группы по хешу), Сироты, Экспорт CSV.
 * Клик по строке страницы — боковая панель (Drawer) с деталями.
 * Пока аудит running — прогресс-бар с поллингом статуса.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const route = useRoute();
const taskId = route.params.taskId;

const status = ref(null);       // { status, progress, summary, error }
const report = ref(null);       // финальный отчёт
const error = ref(null);
const pollHandle = ref(null);

const activeTab = ref('overview');
const issueFilterSeverity = ref('');
const issueFilterCode = ref('');
const pageSearch = ref('');
const pageSort = ref({ key: 'crawl_depth', dir: 1 });
const drawerPage = ref(null);

const _msg = (e) => e?.response?.data?.error || e?.message || 'Ошибка';

const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function scoreColor(score) {
  if (score == null) return '#6b7280';
  if (score >= 80) return '#16a34a';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}

const summary = computed(() => (report.value && report.value.summary) || (status.value && status.value.summary) || {});
const issueDefs = computed(() => (report.value && report.value.issue_defs) || {});

const scoreDash = computed(() => {
  const s = Number(summary.value.health_score) || 0;
  const c = 2 * Math.PI * 52;
  return `${(s / 100) * c} ${c}`;
});

const progressPct = computed(() => {
  const p = (status.value && status.value.progress) || {};
  const total = Number(p.total_found) || 0;
  if (!total) return 5;
  return Math.min(100, Math.round(((Number(p.crawled) || 0) / total) * 100));
});

const issueCodes = computed(() => {
  const set = new Set((report.value?.issues || []).map((i) => i.code));
  return [...set].sort();
});

const filteredIssues = computed(() => {
  let list = report.value?.issues || [];
  if (issueFilterSeverity.value) list = list.filter((i) => i.severity === issueFilterSeverity.value);
  if (issueFilterCode.value) list = list.filter((i) => i.code === issueFilterCode.value);
  return [...list].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
});

// Группировка ошибок по коду для сводки «Обзор»
const issueGroups = computed(() => {
  const map = new Map();
  for (const i of filteredIssues.value) {
    if (!map.has(i.code)) map.set(i.code, { code: i.code, severity: i.severity, items: [] });
    map.get(i.code).items.push(i);
  }
  return [...map.values()].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.items.length - a.items.length);
});
const expandedGroups = ref(new Set());
function toggleGroup(code) {
  const s = new Set(expandedGroups.value);
  if (s.has(code)) s.delete(code); else s.add(code);
  expandedGroups.value = s;
}

const filteredPages = computed(() => {
  let list = report.value?.pages || [];
  const q = pageSearch.value.trim().toLowerCase();
  if (q) {
    list = list.filter((p) =>
      (p.url || '').toLowerCase().includes(q)
      || ((p.title || {}).text || '').toLowerCase().includes(q));
  }
  const { key, dir } = pageSort.value;
  return [...list].sort((a, b) => {
    let va, vb;
    if (key === 'title') { va = (a.title || {}).text || ''; vb = (b.title || {}).text || ''; }
    else if (key === 'issues') { va = (a.issues || []).length; vb = (b.issues || []).length; }
    else { va = a[key]; vb = b[key]; }
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
});

function sortBy(key) {
  if (pageSort.value.key === key) pageSort.value = { key, dir: -pageSort.value.dir };
  else pageSort.value = { key, dir: 1 };
}

const duplicateGroups = computed(() => {
  const d = report.value?.duplicates || {};
  return Object.entries(d).map(([hash, urls]) => ({ hash, urls }));
});

function issueTitle(code) {
  return (issueDefs.value[code] && issueDefs.value[code].title) || code;
}
function issueHint(code) {
  return (issueDefs.value[code] && issueDefs.value[code].hint) || '';
}

function statusBadgeClass(code) {
  const c = Number(code);
  if (!c) return 'badge badge-muted';
  if (c >= 500) return 'badge badge-error';
  if (c >= 400) return 'badge badge-error';
  if (c >= 300) return 'badge badge-info';
  return 'badge badge-ok';
}

async function fetchStatus() {
  try {
    const { data } = await api.get(`/audit/status/${taskId}`);
    status.value = data;
    if (data.status === 'done') {
      stopPolling();
      await fetchReport();
    } else if (['failed', 'cancelled'].includes(data.status)) {
      stopPolling();
      error.value = data.error || 'Аудит завершился с ошибкой';
    }
  } catch (e) {
    stopPolling();
    error.value = _msg(e);
  }
}

async function fetchReport() {
  try {
    const { data } = await api.get(`/audit/report/${taskId}`, { timeout: 120000 });
    report.value = data;
  } catch (e) { error.value = _msg(e); }
}

function startPolling() {
  stopPolling();
  pollHandle.value = setInterval(fetchStatus, 3000);
}
function stopPolling() {
  if (pollHandle.value) { clearInterval(pollHandle.value); pollHandle.value = null; }
}

function downloadCsv() {
  const token = localStorage.getItem('seo_token') || '';
  fetch(`/api/audit/export/${taskId}?format=csv`, {
    headers: { Authorization: 'Bearer ' + token },
  }).then((r) => r.blob()).then((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `audit-${taskId}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }).catch((e) => { error.value = _msg(e); });
}

onMounted(async () => {
  await fetchStatus();
  if (status.value && ['pending', 'running'].includes(status.value.status)) startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <AppLayout>
    <div class="audit-report">
      <div class="crumbs">
        <router-link to="/audits">← Аудиты</router-link>
      </div>

      <div v-if="error" class="error card">{{ error }}</div>

      <!-- Прогресс краулинга -->
      <section v-if="status && ['pending','running'].includes(status.status)" class="card center">
        <h2>Идёт аудит…</h2>
        <div class="pbar big"><div class="pbar-fill" :style="{ width: progressPct + '%' }"></div></div>
        <p class="muted">Просканировано {{ (status.progress && status.progress.crawled) || 0 }}
          из ~{{ (status.progress && status.progress.total_found) || '?' }} страниц</p>
      </section>

      <!-- Health Score plate -->
      <section v-if="report" class="card score-plate">
        <div class="score-circle-wrap">
          <svg viewBox="0 0 120 120" class="score-svg">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#e5e7eb" stroke-width="10" />
            <circle cx="60" cy="60" r="52" fill="none"
                    :stroke="scoreColor(summary.health_score)" stroke-width="10"
                    stroke-linecap="round" :stroke-dasharray="scoreDash"
                    transform="rotate(-90 60 60)" />
            <text x="60" y="66" text-anchor="middle" class="score-text"
                  :fill="scoreColor(summary.health_score)">{{ summary.health_score }}</text>
          </svg>
          <div class="score-label">Health Score</div>
        </div>
        <div class="score-meta">
          <div class="score-url">{{ report.start_url }}</div>
          <div class="sev-counters">
            <div class="sev-counter sev-critical"><b>{{ summary.issues_critical }}</b><span>Critical</span></div>
            <div class="sev-counter sev-high"><b>{{ summary.issues_high }}</b><span>High</span></div>
            <div class="sev-counter sev-medium"><b>{{ summary.issues_medium }}</b><span>Medium</span></div>
            <div class="sev-counter sev-low"><b>{{ summary.issues_low }}</b><span>Low</span></div>
          </div>
          <div class="muted stats-line">
            {{ summary.total_pages }} страниц · средняя глубина {{ (report.graph_stats || {}).avg_depth }}
            · сирот: {{ (report.graph_stats || {}).orphan_count }}
            · sitemap: {{ report.sitemap_url_count }} URL
          </div>
        </div>
      </section>

      <!-- Tabs -->
      <section v-if="report" class="card">
        <div class="tabs">
          <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">Обзор</button>
          <button :class="{ active: activeTab === 'pages' }" @click="activeTab = 'pages'">Страницы</button>
          <button :class="{ active: activeTab === 'duplicates' }" @click="activeTab = 'duplicates'">
            Дубликаты <span class="tab-count">{{ duplicateGroups.length }}</span></button>
          <button :class="{ active: activeTab === 'orphans' }" @click="activeTab = 'orphans'">
            Сироты <span class="tab-count">{{ (report.orphan_pages || []).length }}</span></button>
          <button class="export-btn" @click="downloadCsv">⬇ CSV</button>
        </div>

        <!-- Обзор: сводка ошибок -->
        <div v-if="activeTab === 'overview'">
          <div class="toolbar">
            <select v-model="issueFilterSeverity">
              <option value="">Все критичности</option>
              <option v-for="(l, s) in SEVERITY_LABELS" :key="s" :value="s">{{ l }}</option>
            </select>
            <select v-model="issueFilterCode">
              <option value="">Все типы ошибок</option>
              <option v-for="c in issueCodes" :key="c" :value="c">{{ issueTitle(c) }}</option>
            </select>
            <span class="muted">Всего: {{ filteredIssues.length }}</span>
          </div>
          <div v-for="g in issueGroups" :key="g.code" class="issue-group">
            <div class="issue-group-head" @click="toggleGroup(g.code)">
              <span class="caret">{{ expandedGroups.has(g.code) ? '▾' : '▸' }}</span>
              <span :class="'sev-badge sev-' + g.severity">{{ SEVERITY_LABELS[g.severity] }}</span>
              <b>{{ issueTitle(g.code) }}</b>
              <span class="issue-count">{{ g.items.length }}</span>
              <span class="tooltip-icon" :title="issueHint(g.code)">ⓘ</span>
            </div>
            <table v-if="expandedGroups.has(g.code)" class="tbl small">
              <tbody>
                <tr v-for="(it, i) in g.items.slice(0, 200)" :key="i">
                  <td class="ellipsis"><a :href="it.page_url" target="_blank" rel="noopener">{{ it.page_url }}</a></td>
                  <td class="ctx-cell muted">{{ JSON.stringify(it.context) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="!issueGroups.length" class="muted">Ошибок не найдено 🎉</p>
        </div>

        <!-- Страницы -->
        <div v-if="activeTab === 'pages'">
          <div class="toolbar">
            <input v-model="pageSearch" placeholder="Поиск по URL / Title…" />
            <span class="muted">{{ filteredPages.length }} стр.</span>
          </div>
          <table class="tbl small">
            <thead>
              <tr>
                <th class="sortable" @click="sortBy('url')">URL</th>
                <th class="sortable" @click="sortBy('status_code')">Статус</th>
                <th class="sortable" @click="sortBy('title')">Title</th>
                <th>H1</th>
                <th class="sortable" @click="sortBy('crawl_depth')">Глубина</th>
                <th class="sortable" @click="sortBy('response_time_ms')">мс</th>
                <th class="sortable" @click="sortBy('issues')">Issues</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in filteredPages" :key="p.url" class="clickable" @click="drawerPage = p">
                <td class="ellipsis">{{ p.url }}</td>
                <td><span :class="statusBadgeClass(p.status_code)">{{ p.status_code || '—' }}</span></td>
                <td class="ellipsis">{{ (p.title || {}).text }}</td>
                <td class="ellipsis">{{ ((p.h1 || [])[0] || {}).text }}</td>
                <td class="num">{{ p.crawl_depth }}</td>
                <td class="num">{{ p.response_time_ms }}</td>
                <td>
                  <span v-for="c in (p.issues || []).slice(0, 4)" :key="c"
                        :class="'sev-badge tiny sev-' + ((issueDefs[c] || {}).severity || 'low')"
                        :title="issueTitle(c) + '. ' + issueHint(c)">{{ issueTitle(c) }}</span>
                  <span v-if="(p.issues || []).length > 4" class="muted">+{{ p.issues.length - 4 }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Дубликаты -->
        <div v-if="activeTab === 'duplicates'">
          <p class="muted" v-if="!duplicateGroups.length">Дубликатов контента не найдено.</p>
          <div v-for="d in duplicateGroups" :key="d.hash" class="dup-group">
            <div class="dup-hash">hash: <code>{{ d.hash }}</code> · {{ d.urls.length }} URL</div>
            <ul>
              <li v-for="u in d.urls" :key="u"><a :href="u" target="_blank" rel="noopener">{{ u }}</a></li>
            </ul>
          </div>
        </div>

        <!-- Сироты -->
        <div v-if="activeTab === 'orphans'">
          <p class="muted" v-if="!(report.orphan_pages || []).length">
            Страниц-сирот нет: все URL из sitemap достижимы по внутренним ссылкам.</p>
          <table v-else class="tbl small">
            <thead><tr><th>URL (есть в sitemap, нет в обходе)</th></tr></thead>
            <tbody>
              <tr v-for="u in report.orphan_pages" :key="u">
                <td><a :href="u" target="_blank" rel="noopener">{{ u }}</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Drawer: детали страницы -->
      <div v-if="drawerPage" class="drawer-backdrop" @click.self="drawerPage = null">
        <aside class="drawer">
          <button class="drawer-close" @click="drawerPage = null">×</button>
          <h3 class="drawer-url"><a :href="drawerPage.url" target="_blank" rel="noopener">{{ drawerPage.url }}</a></h3>
          <dl class="drawer-dl">
            <dt>Статус</dt><dd><span :class="statusBadgeClass(drawerPage.status_code)">{{ drawerPage.status_code }}</span></dd>
            <dt>Время ответа</dt><dd>{{ drawerPage.response_time_ms }} мс</dd>
            <dt>Размер</dt><dd>{{ drawerPage.content_size_bytes }} байт</dd>
            <dt>Глубина</dt><dd>{{ drawerPage.crawl_depth }}</dd>
            <dt>Title</dt><dd>{{ (drawerPage.title || {}).text }} <span class="muted">({{ (drawerPage.title || {}).length_chars }} симв. / ~{{ (drawerPage.title || {}).length_px }}px)</span></dd>
            <dt>Description</dt><dd>{{ (drawerPage.meta_description || {}).text }} <span class="muted">({{ (drawerPage.meta_description || {}).length_chars }} симв.)</span></dd>
            <dt>H1</dt><dd><div v-for="(h, i) in drawerPage.h1 || []" :key="i">{{ h.text }}</div></dd>
            <dt>Слов</dt><dd>{{ drawerPage.word_count }}</dd>
            <dt>Text/HTML</dt><dd>{{ drawerPage.text_html_ratio }}</dd>
            <dt>Canonical</dt><dd>{{ (drawerPage.indexability || {}).canonical || '—' }}</dd>
            <dt>Meta robots</dt><dd>{{ (drawerPage.indexability || {}).meta_robots || '—' }}</dd>
            <dt>robots.txt</dt><dd>{{ (drawerPage.indexability || {}).robots_txt_blocked ? 'заблокирован' : 'разрешён' }}</dd>
            <dt>Редиректы</dt><dd>{{ (drawerPage.redirect_chain || []).join(' → ') || 'нет' }}</dd>
            <dt>Входящие ссылки</dt><dd>{{ drawerPage.inlinks_count }}</dd>
            <dt>Исходящие (внутр./внеш.)</dt><dd>{{ drawerPage.outlinks_internal_count }} / {{ drawerPage.outlinks_external_count }}</dd>
            <dt>Изображений</dt><dd>{{ drawerPage.images_count }}</dd>
            <dt>Ошибки</dt>
            <dd>
              <div v-for="c in drawerPage.issues || []" :key="c" class="drawer-issue">
                <span :class="'sev-badge tiny sev-' + ((issueDefs[c] || {}).severity || 'low')">{{ issueTitle(c) }}</span>
                <span class="muted small-meta">{{ issueHint(c) }}</span>
              </div>
              <span v-if="!(drawerPage.issues || []).length" class="muted">нет</span>
            </dd>
          </dl>
        </aside>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.audit-report { padding: 1.25rem; max-width: 1400px; margin: 0 auto; color: #1f2937; }
.crumbs { margin-bottom: .75rem; }
.crumbs a { color: #1d4ed8; text-decoration: none; }
.card { background: #fff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
        box-shadow: 0 1px 3px rgba(0,0,0,.06); border: 1px solid #e5e7eb; }
.center { text-align: center; }
.error { color: #b91c1c; }
.muted { color: #6b7280; }
.small-meta { font-size: .8rem; }

.pbar { width: 100%; max-width: 480px; height: 10px; background: #e5e7eb; border-radius: 5px;
        overflow: hidden; margin: .75rem auto; }
.pbar-fill { height: 100%; background: #2b7cff; transition: width .4s ease; }

/* Health Score plate */
.score-plate { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
.score-circle-wrap { text-align: center; }
.score-svg { width: 130px; height: 130px; }
.score-text { font-size: 2rem; font-weight: 800; }
.score-label { font-size: .8rem; color: #4b5563; font-weight: 600; text-transform: uppercase; }
.score-meta { flex: 1; min-width: 260px; }
.score-url { font-weight: 700; font-size: 1.05rem; margin-bottom: .6rem; word-break: break-all; }
.sev-counters { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: .5rem; }
.sev-counter { border-radius: 8px; padding: .5rem .9rem; min-width: 90px; text-align: center; }
.sev-counter b { display: block; font-size: 1.4rem; }
.sev-counter span { font-size: .72rem; text-transform: uppercase; font-weight: 600; }
.sev-counter.sev-critical { background: #fee2e2; color: #7f1d1d; }
.sev-counter.sev-high     { background: #ffedd5; color: #7c2d12; }
.sev-counter.sev-medium   { background: #fef9c3; color: #713f12; }
.sev-counter.sev-low      { background: #f3f4f6; color: #374151; }
.stats-line { font-size: .85rem; }

/* tabs */
.tabs { display: flex; gap: .3rem; margin-bottom: .75rem; flex-wrap: wrap; align-items: center; }
.tabs button { padding: .4rem .8rem; border: 1px solid #cbd5e1; background: #f3f4f6;
               border-radius: 6px; cursor: pointer; color: #111827; }
.tabs button.active { background: #2b7cff; color: #fff; border-color: #2b7cff; }
.tabs .export-btn { margin-left: auto; background: #fff; }
.tab-count { background: rgba(0,0,0,.12); border-radius: 8px; padding: 0 .35rem; font-size: .75rem; }

.toolbar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
.toolbar input, .toolbar select { padding: .4rem .55rem; border: 1px solid #cbd5e1; border-radius: 4px;
                                  color: #111827; background: #fff; }
.toolbar input { flex: 1; min-width: 200px; }

/* issue groups */
.issue-group { border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: .5rem; }
.issue-group-head { display: flex; align-items: center; gap: .5rem; padding: .55rem .7rem; cursor: pointer; }
.issue-group-head:hover { background: #f8fafc; }
.caret { color: #2b7cff; width: 1em; }
.issue-count { background: #eef2f7; color: #475569; border-radius: 8px; padding: 0 .45rem;
               font-size: .78rem; font-weight: 700; }
.tooltip-icon { color: #94a3b8; cursor: help; margin-left: auto; }
.ctx-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .75rem; }

/* severity badges */
.sev-badge { display: inline-block; padding: .08rem .45rem; border-radius: 9px; font-size: .72rem;
             font-weight: 700; margin-right: .25rem; }
.sev-badge.tiny { font-size: .68rem; padding: .04rem .35rem; }
.sev-critical { background: #fecaca; color: #7f1d1d; }
.sev-high     { background: #fed7aa; color: #7c2d12; }
.sev-medium   { background: #fef08a; color: #713f12; }
.sev-low      { background: #e5e7eb; color: #374151; }

/* tables */
.tbl { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: .25rem;
       background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
.tbl th, .tbl td { padding: .5rem .6rem; font-size: .85rem; text-align: left;
                   color: #111827; border-bottom: 1px solid #eef2f7; vertical-align: middle; }
.tbl th { background: #f8fafc; font-weight: 600; font-size: .76rem; text-transform: uppercase; }
.tbl th.sortable { cursor: pointer; user-select: none; }
.tbl th.sortable:hover { background: #eef2f7; }
.tbl tbody tr:hover td { background: #eef5ff; }
.tbl tr.clickable { cursor: pointer; }
.tbl.small td, .tbl.small th { font-size: .8rem; padding: .35rem .5rem; }
.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
.tbl td a { color: #1d4ed8; text-decoration: none; }
.ellipsis { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.badge { display: inline-block; padding: .08rem .45rem; border-radius: 9px; font-size: .74rem; font-weight: 700; }
.badge-ok    { background: #d4edda; color: #155724; }
.badge-info  { background: #d1ecf1; color: #0c5460; }
.badge-error { background: #f8d7da; color: #721c24; }
.badge-muted { background: #e5e7eb; color: #374151; }

/* duplicates */
.dup-group { border: 1px solid #e5e7eb; border-radius: 6px; padding: .6rem .8rem; margin-bottom: .5rem; }
.dup-hash { font-size: .82rem; color: #475569; margin-bottom: .3rem; }
.dup-group ul { margin: 0; padding-left: 1.2rem; }
.dup-group a { color: #1d4ed8; text-decoration: none; }

/* drawer */
.drawer-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.35); z-index: 50; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 92vw); background: #fff;
          box-shadow: -4px 0 24px rgba(0,0,0,.15); padding: 1.25rem; overflow-y: auto; z-index: 51; }
.drawer-close { position: absolute; top: .6rem; right: .8rem; border: 0; background: none;
                font-size: 1.5rem; cursor: pointer; color: #6b7280; }
.drawer-url { margin: 0 1.5rem .8rem 0; font-size: .95rem; word-break: break-all; }
.drawer-url a { color: #1d4ed8; text-decoration: none; }
.drawer-dl { display: grid; grid-template-columns: 160px 1fr; gap: .35rem .75rem; font-size: .85rem; }
.drawer-dl dt { color: #6b7280; font-weight: 600; }
.drawer-dl dd { margin: 0; word-break: break-word; }
.drawer-issue { margin-bottom: .3rem; }
</style>
