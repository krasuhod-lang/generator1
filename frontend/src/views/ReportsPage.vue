<script setup>
/**
 * ReportsPage — рабочий board черновиков и опубликованных отчётов.
 * Все действия остаются прежними: загрузка, открытие, удаление только
 * неопубликованных черновиков и переход к постоянным ссылкам.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import AppPageHeader from '../components/AppPageHeader.vue';
import ToolHelp from '../components/ToolHelp.vue';
import { useReportsStore } from '../stores/reports.js';

const router = useRouter();
const store = useReportsStore();
const removing = ref(null);
const search = ref('');
const statusFilter = ref('all');
const copiedId = ref(null);

onMounted(() => store.fetchDrafts());

async function remove(id) {
  if (!confirm('Удалить черновик отчёта?')) return;
  removing.value = id;
  try { await store.deleteDraft(id); }
  finally { removing.value = null; }
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}

function fmtUpdated(s) {
  if (!s) return 'Нет изменений';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'Нет изменений' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusLabel(s) {
  return ({ draft: 'Черновик', published: 'Опубликован', archived: 'Архив' })[s] || s || 'Без статуса';
}

function statusHint(s) {
  return ({
    draft: 'Можно редактировать и дополнить данными',
    published: 'Сохранён в истории и доступен по ссылке',
    archived: 'Отчёт сохранён в архиве',
  })[s] || 'Отчёт сохранён в рабочем кабинете';
}

function aiLabel(s) {
  return ({ done: 'AI готова', running: 'AI работает', queued: 'AI в очереди', error: 'Нужна проверка', idle: 'AI не запускалась' })[s] || 'AI не запускалась';
}

function publicUrl(uuid) {
  return uuid ? `${window.location.origin}/r/${uuid}` : '';
}

async function copyLink(draft) {
  const url = publicUrl(draft.shared_uuid);
  if (!url) return;
  try {
    await navigator.clipboard?.writeText(url);
    copiedId.value = draft.id;
    window.setTimeout(() => { if (copiedId.value === draft.id) copiedId.value = null; }, 1800);
  } catch (_) {
    copiedId.value = null;
  }
}

const filteredDrafts = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return store.drafts.filter((draft) => {
    const matchesStatus = statusFilter.value === 'all' || draft.status === statusFilter.value;
    if (!matchesStatus) return false;
    if (!needle) return true;
    return [draft.title, draft.project_name, draft.project_url]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
});

const stats = computed(() => {
  const drafts = store.drafts || [];
  return {
    total: drafts.length,
    active: drafts.filter((draft) => draft.status === 'draft').length,
    published: drafts.filter((draft) => draft.status === 'published').length,
    aiReady: drafts.filter((draft) => draft.llm_status === 'done').length,
  };
});
</script>

<template>
  <AppLayout>
    <div class="reports-page">
      <AppPageHeader
        eyebrow="Рабочий центр проекта"
        title="Отчёты"
        description="Одна рабочая область для аналитики проекта, выполненных работ, AI-выводов и подготовки следующего шага."
      >
        <template #title-suffix>
          <ToolHelp title="Отчёты" text="Черновик можно редактировать до публикации. Опубликованные отчёты, проекты и постоянные ссылки сохраняются в истории и не удаляются автоматически." />
        </template>
        <template #actions>
          <button type="button" class="btn btn-secondary" @click="router.push('/reports/shared')">Опубликованные ссылки</button>
          <button type="button" class="btn btn-primary" @click="router.push('/reports/new')">+ Новый отчёт</button>
        </template>
      </AppPageHeader>

      <section class="reports-intro" aria-label="Навигация по рабочему центру">
        <div>
          <span class="intro-kicker">SEO PERFORMANCE BOARD</span>
          <h2>Сначала результат, затем действие</h2>
          <p>Открывайте отчёт, просматривайте подтверждённые изменения и ведите список работ по проекту в одном месте.</p>
        </div>
        <div class="intro-rule">
          <span class="intro-rule-dot" aria-hidden="true"></span>
          <span>История и привязка к проекту сохраняются</span>
        </div>
      </section>

      <section class="report-stats-grid" aria-label="Сводка по отчётам">
        <article class="report-stat report-stat--accent">
          <span class="report-stat-label">Всего отчётов</span>
          <strong>{{ stats.total }}</strong>
          <span>в вашей рабочей области</span>
        </article>
        <article class="report-stat">
          <span class="report-stat-label">В работе</span>
          <strong>{{ stats.active }}</strong>
          <span>черновиков можно дополнить</span>
        </article>
        <article class="report-stat">
          <span class="report-stat-label">Опубликовано</span>
          <strong>{{ stats.published }}</strong>
          <span>сохранённых версий</span>
        </article>
        <article class="report-stat">
          <span class="report-stat-label">AI-аналитика</span>
          <strong>{{ stats.aiReady }}</strong>
          <span>отчётов с готовыми выводами</span>
        </article>
      </section>

      <div v-if="!store.loading && !store.error && store.drafts.length" class="reports-toolbar">
        <label class="report-search">
          <span class="sr-only">Поиск отчёта</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <input v-model="search" type="search" placeholder="Найти отчёт или проект" autocomplete="off" />
        </label>
        <label class="report-filter">
          <span class="filter-caption">Показывать</span>
          <select v-model="statusFilter">
            <option value="all">Все отчёты</option>
            <option value="draft">В работе</option>
            <option value="published">Опубликованные</option>
            <option value="archived">Архив</option>
          </select>
        </label>
        <span class="report-count">{{ filteredDrafts.length }} из {{ store.drafts.length }}</span>
      </div>

      <div v-if="store.loading" class="rp-empty rp-empty--loading" role="status">Загрузка отчётов…</div>
      <div v-else-if="store.error" class="rp-empty rp-error" role="alert">{{ store.error }}</div>
      <div v-else-if="!store.drafts.length" class="rp-empty">
        <div class="empty-icon" aria-hidden="true">✦</div>
        <h2>Начните с первого отчёта</h2>
        <p>Соберите данные GSC, Яндекс.Вебмастера и Keys.so в одном понятном рабочем пространстве.</p>
        <button type="button" class="btn btn-primary" @click="router.push('/reports/new')">Создать отчёт</button>
      </div>
      <div v-else-if="!filteredDrafts.length" class="rp-empty">
        <div class="empty-icon" aria-hidden="true">⌕</div>
        <h2>Ничего не найдено</h2>
        <p>Измените запрос или фильтр — сохранённые отчёты останутся на месте.</p>
        <button type="button" class="btn btn-secondary" @click="search = ''; statusFilter = 'all'">Сбросить фильтры</button>
      </div>

      <section v-else class="reports-board" aria-label="Список отчётов">
        <article v-for="draft in filteredDrafts" :key="draft.id" class="report-card">
          <div class="report-card-top">
            <div class="report-project">
              <span class="project-mark" aria-hidden="true">{{ (draft.project_name || 'P').slice(0, 1).toUpperCase() }}</span>
              <div>
                <span class="report-project-name">{{ draft.project_name || 'Проект' }}</span>
                <span v-if="draft.project_url" class="report-project-url">{{ draft.project_url }}</span>
              </div>
            </div>
            <span class="rp-pill" :data-status="draft.status">{{ statusLabel(draft.status) }}</span>
          </div>

          <div class="report-card-body">
            <router-link :to="`/reports/${draft.id}/edit`" class="report-card-title">{{ draft.title || 'Отчёт без названия' }}</router-link>
            <p class="report-card-period">Период: {{ fmtDate(draft.date_from) }} — {{ fmtDate(draft.date_to) }}</p>
            <p class="report-card-status">{{ statusHint(draft.status) }}</p>
          </div>

          <div class="report-card-metrics">
            <div>
              <span class="metric-label">Обновлён</span>
              <strong>{{ fmtUpdated(draft.updated_at) }}</strong>
            </div>
            <div>
              <span class="metric-label">AI-аналитика</span>
              <strong :class="{ 'metric-good': draft.llm_status === 'done', 'metric-warn': draft.llm_status === 'error' }">{{ aiLabel(draft.llm_status) }}</strong>
            </div>
          </div>

          <div v-if="draft.shared_uuid" class="report-share-row">
            <div class="share-state">
              <span class="share-dot" :data-active="draft.shared_is_active !== false" aria-hidden="true"></span>
              <div>
                <span class="metric-label">Постоянная ссылка</span>
                <a :href="publicUrl(draft.shared_uuid)" target="_blank" rel="noopener" class="share-url">/r/{{ draft.shared_uuid.slice(0, 10) }}…</a>
              </div>
            </div>
            <button type="button" class="copy-btn" :aria-label="copiedId === draft.id ? 'Ссылка скопирована' : 'Скопировать постоянную ссылку'" @click="copyLink(draft)">
              {{ copiedId === draft.id ? 'Скопировано' : 'Копировать' }}
            </button>
          </div>

          <div class="report-card-actions">
            <router-link :to="`/reports/${draft.id}/edit`" class="card-open-btn">Открыть отчёт <span aria-hidden="true">→</span></router-link>
            <button v-if="draft.status !== 'published'" type="button" class="card-delete-btn" :disabled="removing === draft.id" @click="remove(draft.id)">
              {{ removing === draft.id ? 'Удаление…' : 'Удалить черновик' }}
            </button>
            <span v-else class="protected-label">История сохранена</span>
          </div>
        </article>
      </section>
    </div>
  </AppLayout>
</template>

<style scoped>
.reports-page {
  width: 100%; max-width: var(--app-content-max); margin: 0 auto;
  padding: var(--app-page-top) var(--app-content-gutter) var(--app-page-bottom);
  color: #e8ecf5; color-scheme: dark; letter-spacing: -0.01em;
}
.btn { min-height: 44px; padding: 10px 18px; border-radius: 12px; font-size: 14px; cursor: pointer; border: 1px solid transparent; font-weight: 650; transition: transform .15s ease, background .15s ease, border-color .15s ease; }
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn-primary { background: linear-gradient(135deg, #756cf7, #6258e9); color: #fff; box-shadow: 0 10px 22px rgba(99, 91, 232, .24); }
.btn-primary:hover { background: linear-gradient(135deg, #837bff, #7066f5); }
.btn-secondary { background: rgba(255,255,255,.045); border-color: rgba(148,163,184,.24); color: #e8ecf5; }
.btn-secondary:hover { background: rgba(255,255,255,.09); border-color: rgba(165,180,252,.42); }
.reports-intro { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; margin: 8px 0 22px; padding: 24px 26px; border: 1px solid rgba(129,140,248,.20); border-radius: 20px; background: radial-gradient(circle at 92% 0%, rgba(99,102,241,.22), transparent 34%), linear-gradient(135deg, rgba(30,41,59,.78), rgba(17,24,39,.72)); box-shadow: 0 18px 42px rgba(2,6,23,.16); }
.intro-kicker { color:#a5b4fc; font-size:11px; font-weight:800; letter-spacing:.15em; }
.reports-intro h2 { margin:7px 0 6px; color:#f8fafc; font-size:23px; line-height:1.15; letter-spacing:-.035em; }
.reports-intro p { max-width:620px; margin:0; color:#aab5c8; font-size:14px; line-height:1.55; }
.intro-rule { display:flex; align-items:center; gap:9px; flex:none; color:#c7d2fe; font-size:12px; white-space:nowrap; }
.intro-rule-dot { width:8px; height:8px; border-radius:50%; background:#8b85ff; box-shadow:0 0 0 5px rgba(139,133,255,.12); }
.report-stats-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; margin-bottom:20px; }
.report-stat { min-width:0; padding:17px 18px; border:1px solid rgba(71,85,105,.62); border-radius:16px; background:rgba(15,23,42,.66); box-shadow:0 10px 30px rgba(2,6,23,.10); }
.report-stat--accent { border-color:rgba(129,140,248,.5); background:linear-gradient(145deg, rgba(79,70,229,.23), rgba(15,23,42,.74)); }
.report-stat-label, .metric-label { display:block; color:#94a3b8; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
.report-stat strong { display:block; margin:7px 0 3px; color:#f8fafc; font-size:27px; line-height:1; letter-spacing:-.04em; }
.report-stat span:last-child { color:#aab5c8; font-size:12px; }
.reports-toolbar { display:flex; align-items:center; gap:12px; margin:0 0 14px; padding:10px; border:1px solid rgba(71,85,105,.55); border-radius:15px; background:rgba(15,23,42,.62); }
.report-search { display:flex; align-items:center; gap:9px; flex:1 1 310px; min-height:42px; padding:0 12px; border:1px solid rgba(100,116,139,.44); border-radius:11px; background:rgba(2,6,23,.27); }
.report-search:focus-within { border-color:#818cf8; box-shadow:0 0 0 3px rgba(129,140,248,.14); }
.report-search svg { width:17px; height:17px; fill:none; stroke:#94a3b8; stroke-width:1.8; }
.report-search input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:#f8fafc; font:inherit; font-size:14px; }
.report-search input::placeholder { color:#718096; }
.report-filter { display:flex; align-items:center; gap:8px; flex:none; }
.filter-caption { color:#94a3b8; font-size:12px; }
.report-filter select { min-height:42px; padding:0 32px 0 12px; border:1px solid rgba(100,116,139,.44); border-radius:11px; background:#111827; color:#e5e7eb; font:inherit; font-size:13px; }
.report-count { flex:none; margin:0 8px 0 auto; color:#7f8ca3; font-size:12px; white-space:nowrap; }
.rp-empty { padding:72px 24px; text-align:center; color:#aab5c8; border:1px dashed rgba(100,116,139,.5); border-radius:20px; background:rgba(15,23,42,.62); }
.rp-empty--loading { min-height:130px; padding:52px 24px; }
.rp-empty h2 { margin:12px 0 7px; color:#f8fafc; font-size:20px; }
.rp-empty p { max-width:480px; margin:0 auto 20px; color:#94a3b8; line-height:1.55; }
.empty-icon { display:grid; place-items:center; width:48px; height:48px; margin:auto; border-radius:15px; color:#c7d2fe; background:rgba(99,102,241,.17); font-size:25px; }
.rp-error { color:#fecaca; border-color:rgba(248,113,113,.38); }
.reports-board { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
.report-card { min-width:0; display:flex; flex-direction:column; padding:18px; border:1px solid rgba(71,85,105,.63); border-radius:18px; background:linear-gradient(150deg, rgba(17,24,39,.84), rgba(15,23,42,.69)); box-shadow:0 15px 34px rgba(2,6,23,.12); transition:transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
.report-card:hover { transform:translateY(-2px); border-color:rgba(129,140,248,.52); box-shadow:0 20px 42px rgba(2,6,23,.2); }
.report-card-top, .report-card-actions, .report-share-row, .report-project { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.report-project { justify-content:flex-start; min-width:0; }
.project-mark { display:grid; place-items:center; width:34px; height:34px; flex:none; border-radius:11px; color:#ddd6fe; background:linear-gradient(135deg, rgba(129,140,248,.45), rgba(99,102,241,.18)); font-size:13px; font-weight:800; }
.report-project > div { display:flex; flex-direction:column; min-width:0; }
.report-project-name { overflow:hidden; color:#cbd5e1; font-size:13px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
.report-project-url { overflow:hidden; margin-top:2px; color:#64748b; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.rp-pill { display:inline-flex; align-items:center; flex:none; min-height:26px; padding:4px 10px; border-radius:999px; color:#cbd5e1; background:rgba(71,85,105,.42); font-size:11px; font-weight:750; }
.rp-pill[data-status="published"] { color:#86efac; background:rgba(5,150,105,.18); }
.rp-pill[data-status="archived"] { color:#c4b5fd; background:rgba(109,40,217,.2); }
.report-card-body { padding:20px 0 16px; }
.report-card-title { display:block; color:#f8fafc; font-size:19px; font-weight:750; line-height:1.25; letter-spacing:-.025em; text-decoration:none; }
.report-card-title:hover { color:#c7d2fe; }
.report-card-period { margin:9px 0 0; color:#cbd5e1; font-size:13px; }
.report-card-status { margin:5px 0 0; color:#7f8ca3; font-size:12px; }
.report-card-metrics { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px; padding:13px 0; border-top:1px solid rgba(71,85,105,.42); border-bottom:1px solid rgba(71,85,105,.42); }
.report-card-metrics > div { min-width:0; }
.report-card-metrics strong { display:block; overflow:hidden; margin-top:5px; color:#e5e7eb; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.metric-good { color:#86efac !important; }
.metric-warn { color:#fca5a5 !important; }
.report-share-row { align-items:center; margin-top:12px; padding:10px 11px; border:1px solid rgba(99,102,241,.2); border-radius:12px; background:rgba(49,46,129,.14); }
.share-state { display:flex; align-items:center; gap:9px; min-width:0; }
.share-dot { width:7px; height:7px; flex:none; border-radius:50%; background:#64748b; }
.share-dot[data-active="true"] { background:#4ade80; box-shadow:0 0 0 4px rgba(74,222,128,.12); }
.share-url { display:block; overflow:hidden; max-width:200px; margin-top:3px; color:#a5b4fc; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; text-overflow:ellipsis; white-space:nowrap; text-decoration:none; }
.share-url:hover { color:#e0e7ff; }
.copy-btn { min-height:32px; padding:6px 9px; border:1px solid rgba(129,140,248,.34); border-radius:8px; color:#c7d2fe; background:rgba(99,102,241,.13); cursor:pointer; font-size:11px; font-weight:700; }
.copy-btn:hover { background:rgba(99,102,241,.25); }
.report-card-actions { align-items:center; margin-top:auto; padding-top:15px; }
.card-open-btn { display:inline-flex; align-items:center; gap:8px; min-height:40px; padding:9px 13px; border-radius:10px; color:#fff; background:#4f46e5; font-size:13px; font-weight:750; text-decoration:none; }
.card-open-btn:hover { background:#6366f1; }
.card-delete-btn, .protected-label { border:0; color:#fca5a5; background:transparent; cursor:pointer; font-size:11px; }
.card-delete-btn:hover { color:#fecaca; }
.card-delete-btn:disabled { opacity:.55; cursor:wait; }
.protected-label { color:#86efac; cursor:default; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width: 960px) { .report-stats-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); } .reports-board { grid-template-columns:1fr; } }
@media (max-width: 640px) {
  .reports-page { padding-top:20px; }
  .reports-intro { flex-direction:column; align-items:flex-start; padding:19px; }
  .reports-intro h2 { font-size:20px; }
  .intro-rule { white-space:normal; }
  .report-stats-grid { gap:9px; }
  .report-stat { padding:14px; }
  .report-stat strong { font-size:24px; }
  .reports-toolbar { align-items:stretch; flex-direction:column; padding:9px; }
  .report-search, .report-filter, .report-filter select { width:100%; }
  .report-filter { justify-content:space-between; }
  .report-count { margin:0; text-align:right; }
  .report-card { padding:15px; }
  .report-card-top { align-items:flex-start; }
  .report-card-actions { align-items:stretch; flex-direction:column; }
  .card-open-btn { justify-content:center; width:100%; }
  .card-delete-btn, .protected-label { min-height:32px; }
}
</style>
