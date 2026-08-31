<script setup>
/**
 * AuditReportPage — дашборд отчёта аудита /audits/:taskId.
 *
 * Верх: круговой Health Score (зелёный >80 / жёлтый 50–79 / красный <50) +
 * счётчики Critical/High/Medium/Low. Табы: Обзор (все ошибки с фильтрами),
 * Страницы (таблица URL), Дубликаты (группы по хешу), Сироты, Граф
 * (force-graph структуры), Сравнение (с предыдущим аудитом домена),
 * Экспорт CSV/XLSX.
 * Клик по строке страницы — боковая панель (Drawer) с деталями.
 * Пока аудит running — прогресс-бар с поллингом статуса.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import AppPageHeader from '../components/AppPageHeader.vue';
import ToolHelp from '../components/ToolHelp.vue';
import AuditGraphChart from '../components/AuditGraphChart.vue';
import IssueAccordion from '../components/IssueAccordion.vue';
import { copyToClipboard, toTsv } from '../utils/clipboard.js';
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
const compareData = ref(null);   // { current, previous } из /audit/compare/:id
const compareError = ref(null);
const orphansCopied = ref(false);
const copyFeedback = ref('');

const _msg = (e) => e?.response?.data?.error || e?.message || 'Ошибка';

const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

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

// Группировка ошибок по каноническому backend-контракту. Legacy-отчёты
// собираются на клиенте по старому raw-массиву без потери совместимости.
const accordionGroups = computed(() => {
  const canonical = summary.value.issue_groups;
  if (Array.isArray(canonical) && canonical.length) {
    return canonical
      .filter((g) => (!issueFilterSeverity.value || g.severity === issueFilterSeverity.value)
        && (!issueFilterCode.value || g.code === issueFilterCode.value))
      .map((g) => ({
        ...g,
        count: Number(g.affected_pages) || (g.urls || []).length,
        affected_pages: Number(g.affected_pages) || (g.urls || []).length,
        occurrences: Number(g.occurrences) || Number(g.affected_pages) || 0,
        urls: Array.isArray(g.urls) ? g.urls : [],
        context: g.sample_context || {},
        evidence: issueEvidence({ context: g.sample_context || {} }),
      }));
  }

  const map = new Map();
  for (const i of filteredIssues.value) {
    if (!map.has(i.code)) map.set(i.code, {
      code: i.code, severity: i.severity, count: 0, affected_pages: 0,
      occurrences: 0, urls: [], evidence: '', context: {},
    });
    const g = map.get(i.code);
    g.count += 1;
    g.occurrences += 1;
    if (!g.evidence && i.context) {
      g.context = i.context;
      g.evidence = issueEvidence(i);
    }
    if (i.page_url && !g.urls.includes(i.page_url)) g.urls.push(i.page_url);
  }
  return [...map.values()].map((g) => ({ ...g, affected_pages: g.urls.length }));
});

const filteredIssueStats = computed(() => {
  const urls = new Set();
  for (const group of accordionGroups.value) {
    for (const url of group.urls || []) urls.add(url);
  }
  return {
    groups: accordionGroups.value.length,
    pages: urls.size,
    occurrences: accordionGroups.value.reduce((sum, g) => sum + (Number(g.occurrences) || Number(g.count) || 0), 0),
  };
});

// issues страницы: legacy ["code"] или новый формат [{code,count}]
function pageIssueList(p) {
  return (p.issues || []).map((i) =>
    (i && typeof i === 'object') ? i : { code: i, count: 1 });
}
function pageIssueCount(p) {
  return pageIssueList(p).reduce((sum, issue) => sum + (Number(issue.count) || 1), 0);
}
function confidenceLabel(context = {}) {
  const score = Number(context.confidence);
  if (!Number.isFinite(score)) return 'Проверено правилом';
  if (score >= 0.99) return 'Подтверждено';
  if (score >= 0.8) return 'Высокая уверенность';
  if (score >= 0.6) return 'Средняя уверенность';
  return 'Требует проверки';
}
function issueEvidence(issue) {
  const c = issue?.context || {};
  const parts = [];
  if (c.status_code != null) parts.push(`HTTP ${c.status_code}`);
  if (c.response_time_ms != null) parts.push(`ответ ${c.response_time_ms} мс`);
  if (c.content_size_bytes != null) parts.push(`HTML ${Math.round(Number(c.content_size_bytes) / 1024)} КБ`);
  if (c.content_type) parts.push(String(c.content_type));
  if (c.parse_status) parts.push(`parse: ${c.parse_status}`);
  if (c.canonical) parts.push(`canonical: ${c.canonical}`);
  if (c.robots) parts.push(`robots: ${c.robots}`);
  if (c.src) parts.push(`ресурс: ${c.src}`);
  return parts.join(' · ') || 'См. URL и описание правила';
}

// Хопы цепочки редиректов: legacy строки или {url,status} (БАГФИКС #4)
function redirectChainText(chain) {
  return (chain || []).map((c) =>
    (c && typeof c === 'object') ? `${c.url}${c.status ? ` (${c.status})` : ''}` : c)
    .join(' → ') || 'нет';
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
    else if (key === 'issues') { va = Number(a.issue_occurrences) || pageIssueCount(a); vb = Number(b.issue_occurrences) || pageIssueCount(b); }
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

function downloadCsv() { downloadExport('csv'); }

function downloadExport(format, section = 'all') {
  const token = localStorage.getItem('seo_token') || '';
  fetch(`/api/audit/export/${taskId}?format=${format}&section=${section}`, {
    headers: { Authorization: 'Bearer ' + token },
  }).then(async (r) => {
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).error || ''; } catch (_) {}
      throw new Error(detail || `Экспорт недоступен (${r.status})`);
    }
    return r.blob();
  }).then((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `audit-${taskId}${section === 'all' ? '' : '-' + section}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }).catch((e) => { error.value = _msg(e); });
}

async function copyIssues() {
  const rows = [['Код правила', 'Ошибка', 'Критичность', 'Затронутых страниц', 'Фактов', 'Уверенность', 'Пример доказательства']];
  if (accordionGroups.value.length && summary.value.issue_groups) {
    for (const group of accordionGroups.value) {
      rows.push([
        group.code || '', issueTitle(group.code), group.severity || '',
        group.affected_pages ?? group.count ?? 0, group.occurrences ?? group.count ?? 0,
        group.confidence == null ? '—' : `${Math.round(Number(group.confidence) * 100)}%`,
        group.evidence || issueEvidence({ context: group.context || {} }),
      ]);
    }
  } else {
    for (const issue of filteredIssues.value) {
      rows.push([issue.code || '', issueTitle(issue.code), issue.severity || '', issue.page_url || '',
        1, confidenceLabel(issue.context), issueEvidence(issue)]);
    }
  }
  const ok = await copyToClipboard(toTsv(rows));
  copyFeedback.value = ok ? 'Ошибки скопированы' : 'Не удалось скопировать';
  setTimeout(() => { copyFeedback.value = ''; }, 2400);
}

async function copyPages() {
  const rows = [['URL', 'Итоговый URL', 'HTTP', 'Title', 'H1', 'Глубина', 'Время ответа, мс', 'Типов правил', 'Фактов', 'Максимальная критичность']];
  for (const page of filteredPages.value) {
    rows.push([page.url || '', page.final_url || '', page.status_code ?? '', (page.title || {}).text || '',
      ((page.h1 || [])[0] || {}).text || '', page.crawl_depth ?? '', page.response_time_ms ?? '',
      page.issue_types ?? pageIssueList(page).length, page.issue_occurrences ?? pageIssueCount(page),
      page.max_issue_severity || '—']);
  }
  const ok = await copyToClipboard(toTsv(rows));
  copyFeedback.value = ok ? 'Страницы скопированы' : 'Не удалось скопировать';
  setTimeout(() => { copyFeedback.value = ''; }, 2400);
}

// ── Публичная ссылка для клиента (ТЗ 9) ──
const shareCopied = ref(false);
const shareBusy = ref(false);
async function shareReport() {
  if (shareBusy.value) return;
  shareBusy.value = true;
  try {
    const { data } = await api.post(`/audit/${taskId}/share`, {});
    const url = window.location.origin + data.url;
    await navigator.clipboard.writeText(url);
    shareCopied.value = true;
    setTimeout(() => { shareCopied.value = false; }, 2500);
  } catch (e) { error.value = _msg(e); }
  finally { shareBusy.value = false; }
}

// ── Сравнение с предыдущим аудитом домена ──
async function fetchCompare() {
  if (compareData.value) return;
  try {
    const { data } = await api.get(`/audit/compare/${taskId}`);
    compareData.value = data;
    compareError.value = null;
  } catch (e) { compareError.value = _msg(e); }
}

function openTab(tab) {
  activeTab.value = tab;
  if (tab === 'compare') fetchCompare();
}

function delta(cur, prev) {
  const d = (Number(cur) || 0) - (Number(prev) || 0);
  return d > 0 ? `+${d}` : String(d);
}

const COMPARE_ROWS = [
  { key: 'health_score',    label: 'Health Score',  goodUp: true },
  { key: 'total_pages',     label: 'Страниц',       goodUp: null },
  { key: 'issues_critical', label: 'Critical',      goodUp: false },
  { key: 'issues_high',     label: 'High',          goodUp: false },
  { key: 'issues_medium',   label: 'Medium',        goodUp: false },
  { key: 'issues_low',      label: 'Low',           goodUp: false },
];

function deltaClass(row, cur, prev) {
  const d = (Number(cur) || 0) - (Number(prev) || 0);
  if (!d || row.goodUp === null) return 'muted';
  return (d > 0) === row.goodUp ? 'delta-good' : 'delta-bad';
}

// ── Сироты: «Добавить в sitemap ТЗ» — копирует список URL для вставки в ТЗ ──
async function copyOrphansForSitemap() {
  const urls = report.value?.orphan_pages || [];
  if (!urls.length) return;
  const text = 'Добавить в sitemap / перелинковку (страницы-сироты):\n'
    + urls.map((u) => `- ${u}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    orphansCopied.value = true;
    setTimeout(() => { orphansCopied.value = false; }, 2000);
  } catch (e) { error.value = 'Не удалось скопировать в буфер обмена'; }
}

function openPageByUrl(url) {
  const p = (report.value?.pages || []).find((x) => x.url === url);
  if (p) drawerPage.value = p;
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
      <AppPageHeader
        eyebrow="Технический контроль"
        :title="report ? 'Отчёт аудита' : 'Аудит сайта'"
        :description="report ? 'Подтверждённые технические сигналы, затронутые страницы и приоритеты исправления.' : 'Краулинг сайта с проверкой доступности, индексации, метаданных, ссылок и структуры.'"
      >
        <template #title-suffix>
          <ToolHelp title="Как читать аудит" text="Сначала проверьте Critical и High, затем откройте страницу или доказательство правила. Информационные сигналы не являются ошибками без дополнительной проверки." />
        </template>
        <template #actions>
          <router-link class="link-secondary" to="/audits">← Все аудиты</router-link>
        </template>
      </AppPageHeader>

      <div v-if="error" class="error card">{{ error }}</div>

      <!-- Прогресс краулинга -->
      <section v-if="status && ['pending','running'].includes(status.status)" class="card center">
        <h2>Идёт аудит…</h2>
        <div class="pbar big"><div class="pbar-fill" :style="{ width: progressPct + '%' }"></div></div>
        <p class="muted">Просканировано {{ (status.progress && status.progress.crawled) || 0 }}
          из ~{{ (status.progress && status.progress.total_found) || '?' }} страниц</p>
      </section>

      <!-- Impact-based dashboard -->
      <section v-if="report" class="card audit-overview">
        <div class="audit-overview-top">
          <div class="score-circle-wrap">
            <svg viewBox="0 0 120 120" class="score-svg">
              <circle cx="60" cy="60" r="52" fill="none" stroke="#1e293b" stroke-width="10" />
              <circle cx="60" cy="60" r="52" fill="none"
                      :stroke="scoreColor(summary.health_score)" stroke-width="10"
                      stroke-linecap="round" :stroke-dasharray="scoreDash"
                      transform="rotate(-90 60 60)" />
              <text x="60" y="66" text-anchor="middle" class="score-text"
                    :fill="scoreColor(summary.health_score)">{{ summary.health_score ?? '—' }}</text>
            </svg>
            <div class="score-label">Health Score</div>
          </div>
          <div class="score-meta">
            <div class="score-url">{{ report.start_url }}</div>
            <p class="overview-explainer">Оценка основана на доле уникальных страниц с подтверждёнными правилами. Повторные изображения и элементы показываются отдельно и не обнуляют оценку сами по себе.</p>
            <div class="overview-facts">
              <span><b>{{ summary.total_pages ?? 0 }}</b> страниц в обходе</span>
              <span><b>{{ summary.total_affected_pages ?? 0 }}</b> затронуто</span>
              <span><b>{{ summary.unique_issue_types ?? 0 }}</b> типов правил</span>
              <span><b>{{ summary.total_issue_occurrences ?? 0 }}</b> фактов</span>
            </div>
          </div>
        </div>

        <div class="impact-grid">
          <div class="impact-card impact-critical"><span>Critical · страницы</span><b>{{ summary.issues_critical ?? 0 }}</b><small>{{ summary.issue_occurrences_critical ?? 0 }} фактов</small></div>
          <div class="impact-card impact-high"><span>High · страницы</span><b>{{ summary.issues_high ?? 0 }}</b><small>{{ summary.issue_occurrences_high ?? 0 }} фактов</small></div>
          <div class="impact-card impact-medium"><span>Medium · страницы</span><b>{{ summary.issues_medium ?? 0 }}</b><small>{{ summary.issue_occurrences_medium ?? 0 }} фактов</small></div>
          <div class="impact-card impact-low"><span>Low · страницы</span><b>{{ summary.issues_low ?? 0 }}</b><small>{{ summary.issue_occurrences_low ?? 0 }} фактов</small></div>
        </div>

        <div v-if="report.crawl_stats" class="crawl-quality">
          <span>Разобрано <b>{{ report.crawl_stats.parsed_pages ?? 0 }}/{{ report.crawl_stats.crawled_pages ?? summary.total_pages ?? 0 }}</b></span>
          <span>Fetch errors <b>{{ report.crawl_stats.fetch_errors ?? 0 }}</b></span>
          <span>Parse failures <b>{{ report.crawl_stats.parse_failures ?? 0 }}</b></span>
          <span>4xx <b>{{ report.crawl_stats.status_4xx ?? 0 }}</b></span>
          <span>5xx <b>{{ report.crawl_stats.status_5xx ?? 0 }}</b></span>
          <span>Не-HTML <b>{{ report.crawl_stats.non_html_pages ?? 0 }}</b></span>
          <span>Заблокировано <b>{{ report.crawl_stats.blocked_pages ?? 0 }}</b></span>
          <span>Редиректы <b>{{ report.crawl_stats.redirected_pages ?? 0 }}</b></span>
          <span v-if="report.crawl_stats.orphan_check_complete === false" class="crawl-warning">Сироты: нужна полная глубина обхода</span>
        </div>
        <div class="overview-footer muted">
          Средняя глубина: {{ (report.graph_stats || {}).avg_depth ?? 0 }} · сироты: {{ (report.graph_stats || {}).orphan_count ?? 0 }} · sitemap: {{ report.sitemap_url_count ?? 0 }} URL
        </div>
      </section>

      <!-- Tabs -->
      <section v-if="report" class="card">
        <div class="tabs">
          <button :class="{ active: activeTab === 'overview' }" @click="openTab('overview')">Обзор</button>
          <button :class="{ active: activeTab === 'pages' }" @click="openTab('pages')">Страницы</button>
          <button :class="{ active: activeTab === 'duplicates' }" @click="openTab('duplicates')">
            Дубликаты <span class="tab-count">{{ duplicateGroups.length }}</span></button>
          <button :class="{ active: activeTab === 'orphans' }" @click="openTab('orphans')">
            Сироты <span class="tab-count">{{ (report.orphan_pages || []).length }}</span></button>
          <button :class="{ active: activeTab === 'graph' }" @click="openTab('graph')">Граф</button>
          <button :class="{ active: activeTab === 'compare' }" @click="openTab('compare')">Сравнение</button>
          <button class="export-btn ml-auto" @click="shareReport" :disabled="shareBusy">
            {{ shareCopied ? 'Ссылка скопирована' : 'Поделиться' }}</button>
          <button class="export-btn" @click="downloadCsv">CSV</button>
          <button class="export-btn export-primary" @click="downloadExport('xlsx')">Excel — полный отчёт</button>
        </div>

        <!-- Обзор: аккордеон ошибок (ТЗ 7) -->
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
            <span class="overview-filter-summary"><b>{{ filteredIssueStats.groups }}</b> правил · <b>{{ filteredIssueStats.pages }}</b> страниц · <b>{{ filteredIssueStats.occurrences }}</b> фактов</span>
            <button class="export-btn" @click="copyIssues">{{ copyFeedback === 'Ошибки скопированы' ? 'Скопировано' : 'Скопировать ошибки' }}</button>
            <button class="export-btn" @click="downloadExport('csv', 'issues')">CSV ошибок</button>
            <button class="export-btn export-primary" @click="downloadExport('xlsx', 'issues')">Excel ошибок</button>
          </div>
          <IssueAccordion :groups="accordionGroups" :defs="issueDefs"
                          :duplicates="report.duplicates || {}" @open-url="openPageByUrl" />
        </div>

        <!-- Страницы -->
        <div v-if="activeTab === 'pages'">
          <div class="toolbar">
            <input v-model="pageSearch" placeholder="Поиск по URL / Title…" />
            <span class="muted">{{ filteredPages.length }} стр.</span>
            <button class="export-btn" @click="copyPages">{{ copyFeedback === 'Страницы скопированы' ? 'Скопировано' : 'Скопировать таблицу' }}</button>
            <button class="export-btn" @click="downloadExport('csv', 'pages')">CSV страниц</button>
            <button class="export-btn export-primary" @click="downloadExport('xlsx', 'pages')">Excel страниц</button>
          </div>
          <div class="table-scroll">
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
                  <span v-for="i in pageIssueList(p).slice(0, 4)" :key="i.code"
                        :class="'sev-badge tiny sev-' + ((issueDefs[i.code] || {}).severity || 'low')"
                        :title="issueTitle(i.code) + '. ' + issueHint(i.code)">{{ issueTitle(i.code) }}<template v-if="i.count > 1"> ×{{ i.count }}</template></span>
                  <span v-if="pageIssueList(p).length > 4" class="muted">+{{ pageIssueList(p).length - 4 }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <!-- Дубликаты -->
        <div v-if="activeTab === 'duplicates'">
          <p class="muted" v-if="!duplicateGroups.length">Дубликатов контента не найдено.</p>
          <template v-else>
            <div class="toolbar">
              <button class="export-btn" @click="downloadExport('csv', 'duplicates')">CSV дублей</button>
              <button class="export-btn export-primary" @click="downloadExport('xlsx', 'duplicates')">Excel дублей</button>
            </div>
            <div v-for="d in duplicateGroups" :key="d.hash" class="dup-group">
              <div class="dup-hash">hash: <code>{{ d.hash }}</code> · {{ d.urls.length }} URL</div>
              <ul>
                <li v-for="u in d.urls" :key="u"><a :href="u" target="_blank" rel="noopener">{{ u }}</a></li>
              </ul>
            </div>
          </template>
        </div>

        <!-- Сироты -->
        <div v-if="activeTab === 'orphans'">
          <p class="muted" v-if="!(report.orphan_pages || []).length">
            Страниц-сирот нет: все URL из sitemap достижимы по внутренним ссылкам.</p>
          <template v-else>
            <div class="toolbar">
              <button class="action-btn" @click="copyOrphansForSitemap">
                {{ orphansCopied ? '✓ Скопировано' : '📋 Добавить в sitemap ТЗ' }}</button>
              <span class="muted">Скопирует список URL для вставки в ТЗ на перелинковку/sitemap</span>
              <button class="export-btn" @click="downloadExport('csv', 'orphans')">CSV сирот</button>
              <button class="export-btn export-primary" @click="downloadExport('xlsx', 'orphans')">Excel сирот</button>
            </div>
            <div class="table-scroll"><table class="tbl small">
              <thead><tr><th>URL (есть в sitemap, нет в обходе)</th></tr></thead>
              <tbody>
                <tr v-for="u in report.orphan_pages" :key="u">
                  <td><a :href="u" target="_blank" rel="noopener">{{ u }}</a></td>
                </tr>
              </tbody>
            </table></div>
          </template>
        </div>

        <!-- Граф структуры сайта -->
        <div v-if="activeTab === 'graph'">
          <p class="muted" v-if="!(report.graph && (report.graph.nodes || []).length)">
            Данные графа недоступны для этого отчёта (аудит был выполнен старой версией сервиса).</p>
          <template v-else>
            <p class="muted small-meta">
              Узел = страница, цвет = глубина, красный = есть ошибки, размер = входящие ссылки.
              Клик по узлу — детали страницы. Колесо мыши — масштаб.
              <span v-if="report.graph.truncated">Показаны первые {{ report.graph.nodes.length }} узлов.</span>
            </p>
            <AuditGraphChart :graph="report.graph" @select="openPageByUrl" />
          </template>
        </div>

        <!-- Сравнение с предыдущим аудитом -->
        <div v-if="activeTab === 'compare'">
          <p v-if="compareError" class="error">{{ compareError }}</p>
          <p class="muted" v-else-if="!compareData">Загрузка…</p>
          <p class="muted" v-else-if="!compareData.previous">
            Предыдущих завершённых аудитов этого домена не найдено. Сравнение станет
            доступно после повторного аудита.</p>
          <table v-else class="tbl small compare-tbl">
            <thead>
              <tr>
                <th>Метрика</th>
                <th>Предыдущий<br><span class="muted small-meta">{{ new Date(compareData.previous.finished_at).toLocaleString('ru-RU') }}</span></th>
                <th>Текущий<br><span class="muted small-meta">{{ compareData.current.finished_at ? new Date(compareData.current.finished_at).toLocaleString('ru-RU') : '' }}</span></th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in COMPARE_ROWS" :key="row.key">
                <td>{{ row.label }}</td>
                <td class="num">{{ compareData.previous.summary[row.key] ?? '—' }}</td>
                <td class="num">{{ compareData.current.summary[row.key] ?? '—' }}</td>
                <td class="num" :class="deltaClass(row, compareData.current.summary[row.key], compareData.previous.summary[row.key])">
                  {{ delta(compareData.current.summary[row.key], compareData.previous.summary[row.key]) }}</td>
              </tr>
              <tr>
                <td>Сирот</td>
                <td class="num">{{ (compareData.previous.graph_stats || {}).orphan_count ?? '—' }}</td>
                <td class="num">{{ (compareData.current.graph_stats || {}).orphan_count ?? '—' }}</td>
                <td class="num muted">{{ delta((compareData.current.graph_stats || {}).orphan_count, (compareData.previous.graph_stats || {}).orphan_count) }}</td>
              </tr>
              <tr>
                <td>Средняя глубина</td>
                <td class="num">{{ (compareData.previous.graph_stats || {}).avg_depth ?? '—' }}</td>
                <td class="num">{{ (compareData.current.graph_stats || {}).avg_depth ?? '—' }}</td>
                <td></td>
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
            <dt>Статус</dt><dd><span :class="statusBadgeClass(drawerPage.status_code)">{{ drawerPage.status_code || '—' }}</span></dd>
            <dt>Итоговый URL</dt><dd>{{ drawerPage.final_url || drawerPage.url }}</dd>
            <dt>Fetch / parse</dt><dd>{{ drawerPage.fetch_status || '—' }} / {{ drawerPage.parse_status || '—' }}</dd>
            <dt>Content-Type</dt><dd>{{ drawerPage.content_type || '—' }}</dd>
            <dt>Попытки</dt><dd>{{ drawerPage.fetch_attempts ?? '—' }}</dd>
            <dt>Время ответа</dt><dd>{{ drawerPage.response_time_ms ?? '—' }} мс</dd>
            <dt>Размер</dt><dd>{{ drawerPage.content_size_bytes ?? '—' }} байт</dd>
            <dt>Глубина</dt><dd>{{ drawerPage.crawl_depth }}</dd>
            <dt>Title</dt><dd>{{ (drawerPage.title || {}).text }} <span class="muted">({{ (drawerPage.title || {}).length_chars }} симв. / ~{{ (drawerPage.title || {}).length_px }}px)</span></dd>
            <dt>Description</dt><dd>{{ (drawerPage.meta_description || {}).text }} <span class="muted">({{ (drawerPage.meta_description || {}).length_chars }} симв.)</span></dd>
            <dt>H1</dt><dd><div v-for="(h, i) in drawerPage.h1 || []" :key="i">{{ h.text }}</div></dd>
            <dt>Слов</dt><dd>{{ drawerPage.word_count }}</dd>
            <dt>Text/HTML</dt><dd>{{ drawerPage.text_html_ratio }}</dd>
            <dt>Canonical</dt><dd>{{ (drawerPage.indexability || {}).canonical || '—' }}</dd>
            <dt>Meta robots</dt><dd>{{ (drawerPage.indexability || {}).meta_robots || '—' }}</dd>
            <dt>X-Robots-Tag</dt><dd>{{ drawerPage.x_robots_tag || (drawerPage.indexability || {}).x_robots_tag || '—' }}</dd>
            <dt>robots.txt</dt><dd>{{ (drawerPage.indexability || {}).robots_txt_blocked ? 'заблокирован' : 'разрешён' }}</dd>
            <dt>Редиректы</dt><dd>{{ redirectChainText(drawerPage.redirect_chain) }}</dd>
            <dt>Входящие ссылки</dt><dd>{{ drawerPage.inlinks_count }}</dd>
            <dt>Исходящие (внутр./внеш.)</dt><dd>{{ drawerPage.outlinks_internal_count }} / {{ drawerPage.outlinks_external_count }}</dd>
            <dt>Изображений</dt><dd>{{ drawerPage.images_count }}</dd>
            <dt>Ошибки</dt>
            <dd>
              <div v-for="i in pageIssueList(drawerPage)" :key="i.code" class="drawer-issue">
                <span :class="'sev-badge tiny sev-' + ((issueDefs[i.code] || {}).severity || 'low')">{{ issueTitle(i.code) }}<template v-if="i.count > 1"> ×{{ i.count }}</template></span>
                <span class="muted small-meta">{{ issueHint(i.code) }}</span>
              </div>
              <span v-if="!pageIssueList(drawerPage).length" class="muted">нет</span>
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
.sev-counter.sev-info     { background: #dbeafe; color: #1e3a8a; }
.stats-line { font-size: .85rem; }

/* tabs */
.tabs { display: flex; gap: .3rem; margin-bottom: .75rem; flex-wrap: wrap; align-items: center; }
.tabs button { padding: .4rem .8rem; border: 1px solid #cbd5e1; background: #f3f4f6;
               border-radius: 6px; cursor: pointer; color: #111827; }
.tabs button.active { background: #2b7cff; color: #fff; border-color: #2b7cff; }
.tabs .export-btn { background: #fff; }
.tabs .ml-auto { margin-left: auto; }
.tab-count { background: rgba(0,0,0,.12); border-radius: 8px; padding: 0 .35rem; font-size: .75rem; }

.action-btn { padding: .4rem .8rem; border: 1px solid #2b7cff; background: #eff6ff; color: #1d4ed8;
              border-radius: 6px; cursor: pointer; font-weight: 600; }
.action-btn:hover { background: #dbeafe; }
.compare-tbl td:first-child { font-weight: 600; }
.delta-good { color: #16a34a; font-weight: 700; }
.delta-bad  { color: #dc2626; font-weight: 700; }

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
.sev-info     { background: #dbeafe; color: #1e3a8a; }

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

/* Единый кабинетный UI и мобильная устойчивость. */
.audit-report { color: #e5e7eb; }
.audit-report .crumbs { display: none; }
.audit-report .card { background: rgba(17, 24, 39, .78); border-color: rgba(51, 65, 85, .72); box-shadow: 0 18px 45px rgba(0, 0, 0, .14); }
.audit-report .muted { color: #94a3b8; }
.audit-report .error { color: #fecaca; }
.audit-report h2, .audit-report h3 { color: #f8fafc; }
.audit-report .pbar { background: #1f2937; }
.audit-report .pbar-fill { background: linear-gradient(90deg, #6366f1, #38bdf8); }
.audit-report .score-label { color: #94a3b8; }
.audit-report .score-url { color: #f8fafc; }
.audit-report .stats-line { color: #94a3b8; }
.crawl-quality { display: flex; gap: .45rem; flex-wrap: wrap; margin-top: .7rem; }
.crawl-quality span { padding: .28rem .55rem; border: 1px solid rgba(71, 85, 105, .8); border-radius: 999px; color: #cbd5e1; font-size: .78rem; }
.crawl-quality b { color: #f8fafc; }
.crawl-warning { border-color: rgba(251, 191, 36, .65) !important; color: #fcd34d !important; }
.audit-report .tabs { border-bottom: 1px solid rgba(51, 65, 85, .65); padding-bottom: .7rem; }
.audit-report .tabs button { background: #1f2937; color: #cbd5e1; border-color: #374151; }
.audit-report .tabs button:hover { background: #334155; }
.audit-report .tabs button.active { background: #4f46e5; color: #fff; border-color: #6366f1; }
.audit-report .tabs .export-btn, .audit-report .toolbar .export-btn { background: #111827; color: #cbd5e1; border: 1px solid #475569; }
.audit-report .tabs .export-btn:hover, .audit-report .toolbar .export-btn:hover { background: #1e293b; }
.audit-report .export-primary { border-color: #6366f1 !important; color: #c7d2fe !important; }
.audit-report .toolbar input, .audit-report .toolbar select { background: #0f172a; color: #e5e7eb; border-color: #334155; }
.audit-report .toolbar input::placeholder { color: #64748b; }
.audit-report .tbl { background: rgba(15, 23, 42, .72); border-color: rgba(51, 65, 85, .74); }
.audit-report .tbl th, .audit-report .tbl td { color: #cbd5e1; border-bottom-color: rgba(51, 65, 85, .58); }
.audit-report .tbl th { background: rgba(15, 23, 42, .94); color: #94a3b8; }
.audit-report .tbl th.sortable:hover, .audit-report .tbl tbody tr:hover td { background: rgba(99, 102, 241, .1); }
.audit-report .tbl td a, .audit-report .drawer-url a, .audit-report .dup-group a { color: #a5b4fc; }
.audit-report .sev-counter.sev-low { background: #263244; color: #cbd5e1; }
.audit-report .sev-counter.sev-info { background: #172554; color: #bfdbfe; }
.audit-report .drawer { background: #0f172a; color: #e5e7eb; }
.audit-report .drawer-dl dt { color: #94a3b8; }
.audit-report .drawer-close { color: #cbd5e1; }
.table-scroll { width: 100%; overflow-x: auto; }
.table-scroll .tbl { min-width: 760px; }
@media (max-width: 760px) {
  .audit-report { padding: .8rem; }
  .score-plate { gap: .8rem; }
  .score-circle-wrap { margin: 0 auto; }
  .score-meta { min-width: 0; width: 100%; }
  .sev-counters { gap: .4rem; }
  .sev-counter { min-width: 72px; padding: .35rem .55rem; }
  .sev-counter b { font-size: 1.15rem; }
  .tabs .ml-auto { margin-left: 0; }
  .tabs { gap: .25rem; }
  .tabs button, .toolbar .export-btn { font-size: .78rem; }
  .toolbar input { min-width: 100%; }
}

/* Professional audit dashboard */
.audit-overview { padding: 1.2rem; }
.audit-overview-top { display: flex; align-items: center; gap: 1.4rem; }
.overview-explainer { max-width: 760px; margin: .35rem 0 .8rem; color: #94a3b8; line-height: 1.55; font-size: .88rem; }
.overview-facts { display: flex; gap: .45rem; flex-wrap: wrap; }
.overview-facts span { padding: .32rem .55rem; border: 1px solid rgba(71, 85, 105, .72); border-radius: 999px; color: #94a3b8; font-size: .78rem; }
.overview-facts b, .overview-filter-summary b { color: #f8fafc; }
.impact-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .65rem; margin-top: 1.1rem; }
.impact-card { min-height: 86px; padding: .7rem .8rem; border: 1px solid rgba(71, 85, 105, .65); border-radius: 12px; background: rgba(15, 23, 42, .66); display: flex; flex-direction: column; gap: .15rem; }
.impact-card span { color: #94a3b8; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.impact-card b { color: #f8fafc; font-size: 1.65rem; line-height: 1.1; }
.impact-card small { color: #64748b; font-size: .73rem; }
.impact-critical { border-color: rgba(248, 113, 113, .55); }
.impact-high { border-color: rgba(251, 146, 60, .55); }
.impact-medium { border-color: rgba(250, 204, 21, .45); }
.impact-low { border-color: rgba(148, 163, 184, .45); }
.overview-footer { margin-top: .75rem; font-size: .8rem; }
.overview-filter-summary { color: #94a3b8; font-size: .82rem; margin-right: auto; }
.audit-report .tabs { row-gap: .45rem; }
.audit-report .score-label { letter-spacing: .08em; }
@media (max-width: 760px) {
  .audit-overview-top { align-items: flex-start; flex-direction: column; }
  .score-circle-wrap { margin: 0 auto; }
  .impact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-filter-summary { width: 100%; order: 3; }
}
</style>
