<script setup>
/**
 * ReportsPage — список черновиков отчётов + кнопка «Создать новый».
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import AppPageHeader from '../components/AppPageHeader.vue';
import ToolHelp from '../components/ToolHelp.vue';
import { useReportsStore } from '../stores/reports.js';

const router = useRouter();
const store = useReportsStore();
const removing = ref(null);

onMounted(() => store.fetchDrafts());

async function remove(id) {
  if (!confirm('Удалить черновик отчёта?')) return;
  removing.value = id;
  try { await store.deleteDraft(id); }
  finally { removing.value = null; }
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString('ru-RU');
}

function statusLabel(s) {
  return ({ draft: 'Черновик', published: 'Опубликован', archived: 'Архив' })[s] || s;
}
</script>

<template>
  <AppLayout>
    <div class="reports-page">
      <AppPageHeader
        eyebrow="Контроль и публикация"
        title="Отчёты"
        description="Собирайте данные проекта в единый отчёт, добавляйте AI-аналитику и публикуйте готовый результат по защищённой ссылке."
      >
        <template #title-suffix>
          <ToolHelp title="Отчёты" text="Черновик можно редактировать до публикации. Опубликованные отчёты и их ссылки защищены от удаления из истории." />
        </template>
        <template #actions>
          <button class="btn btn-secondary" @click="router.push('/reports/shared')">Опубликованные ссылки</button>
          <button class="btn btn-primary" @click="router.push('/reports/new')">+ Новый отчёт</button>
        </template>
      </AppPageHeader>

      <div v-if="store.loading" class="rp-empty">Загрузка…</div>
      <div v-else-if="store.error" class="rp-empty rp-error">{{ store.error }}</div>
      <div v-else-if="!store.drafts.length" class="rp-empty">
        Пока нет ни одного отчёта. Создайте первый, чтобы собрать данные GSC, Я.Вебмастера и Keys.so в один публичный дашборд.
      </div>

      <div v-else class="rp-table-wrap">
        <table class="rp-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Проект</th>
            <th>Период</th>
            <th>Статус</th>
            <th>AI</th>
            <th>Обновлён</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in store.drafts" :key="d.id">
            <td>
              <router-link :to="`/reports/${d.id}/edit`" class="rp-link">{{ d.title }}</router-link>
            </td>
            <td>{{ d.project_name }}</td>
            <td>{{ fmtDate(d.date_from) }} — {{ fmtDate(d.date_to) }}</td>
            <td><span class="rp-pill" :data-status="d.status">{{ statusLabel(d.status) }}</span></td>
            <td>
              <span v-if="d.llm_status === 'done'" class="rp-pill ok">✓</span>
              <span v-else-if="d.llm_status === 'running' || d.llm_status === 'queued'" class="rp-pill">…</span>
              <span v-else-if="d.llm_status === 'error'" class="rp-pill err">!</span>
              <span v-else class="rp-pill muted">—</span>
            </td>
            <td>{{ fmtDate(d.updated_at) }}</td>
            <td class="rp-row-actions">
              <button class="btn-link" @click="router.push(`/reports/${d.id}/edit`)">Открыть</button>
              <button v-if="d.status !== 'published'" class="btn-link danger" :disabled="removing === d.id" @click="remove(d.id)">Удалить</button>
              <span v-else class="protected-label" title="Отчёт защищён опубликованной ссылкой">Ссылка защищена</span>
            </td>
          </tr>
        </tbody>
        </table>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.reports-page {
  background: #f5f5f7; color: #1d1d1f; color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; letter-spacing: -0.01em;
  width: 100%; max-width: var(--app-content-max); margin: 0 auto;
  padding: var(--app-page-top) var(--app-content-gutter) var(--app-page-bottom);
  border-radius: 0 0 22px 22px;
}
.rp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
.rp-head h1 { font-size: 30px; margin: 0; font-weight: 700; letter-spacing: -0.03em; color: #1d1d1f; }
.rp-sub { margin: 6px 0 0; color: #6e6e73; font-size: 14px; }
.rp-actions { display: flex; gap: 8px; }
.btn { padding: 9px 18px; border-radius: 10px; font-size: 14px; cursor: pointer; border: 1px solid transparent; font-weight: 500; transition: background 0.15s, transform 0.05s; }
.btn:active { transform: scale(0.98); }
.btn-primary { background: #0a84ff; color: #fff; }
.btn-primary:hover { background: #0071e3; }
.btn-secondary { background: #fff; border-color: rgba(60,60,67,0.15); color: #1d1d1f; }
.btn-secondary:hover { background: rgba(60,60,67,0.04); }
.rp-empty { padding: 60px 24px; text-align: center; color: #6e6e73; border: 1px dashed rgba(60,60,67,0.18); border-radius: 18px; background: #fff; }
.rp-error { color: #d70015; border-color: rgba(255,59,48,0.4); }
.rp-table-wrap { max-width: 100%; overflow-x: auto; border-radius: 18px; }
.rp-table {
  width: 100%; min-width: 860px; border-collapse: separate; border-spacing: 0;
  background: #fff; border-radius: 18px; overflow: hidden;
  border: 1px solid rgba(60,60,67,0.10);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
}
.rp-table th, .rp-table td { padding: 14px 16px; font-size: 14px; text-align: left; border-bottom: 1px solid rgba(60,60,67,0.08); }
.rp-table tbody tr:last-child td { border-bottom: 0; }
.rp-table th { background: #fafafa; font-weight: 600; color: #6e6e73; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.rp-table tbody tr:hover { background: rgba(10,132,255,0.04); }
.rp-link { color: #0a84ff; text-decoration: none; font-weight: 500; }
.rp-link:hover { color: #0071e3; text-decoration: underline; }
.rp-pill { display: inline-block; padding: 3px 11px; border-radius: 999px; font-size: 12px; font-weight: 500; background: rgba(60,60,67,0.08); color: #424245; }
.rp-pill[data-status="published"] { background: rgba(48,209,88,0.15); color: #03762d; }
.rp-pill.ok { background: rgba(48,209,88,0.15); color: #03762d; }
.rp-pill.err { background: rgba(255,59,48,0.12); color: #d70015; }
.rp-pill.muted { background: transparent; color: #86868b; }
.rp-row-actions { display: flex; gap: 12px; justify-content: flex-end; }
.btn-link { background: none; border: none; color: #0a84ff; cursor: pointer; padding: 4px 6px; font-size: 13px; font-weight: 500; }
.btn-link:hover { color: #0071e3; }
.protected-label { color: #03762d; font-size: 12px; white-space: nowrap; }
.btn-link.danger { color: #d70015; }
  .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Общий кабинет: отчёты больше не используют отдельную светлую тему. */
  .reports-page {
    background: transparent;
    color: #e5e7eb;
    color-scheme: dark;
  }
  .reports-page .rp-head h1 { color: #f8fafc; }
  .reports-page .rp-sub { color: #94a3b8; }
  .reports-page .rp-empty {
    color: #94a3b8;
    background: rgba(17, 24, 39, 0.76);
    border-color: rgba(51, 65, 85, 0.74);
  }
  .reports-page .rp-error { color: #fca5a5; border-color: rgba(127, 29, 29, 0.75); }
  .reports-page .rp-table {
    background: rgba(17, 24, 39, 0.76);
    border-color: rgba(51, 65, 85, 0.74);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.14);
  }
  .reports-page .rp-table th,
  .reports-page .rp-table td { border-bottom-color: rgba(51, 65, 85, 0.62); }
  .reports-page .rp-table th { background: rgba(15, 23, 42, 0.9); color: #94a3b8; }
  .reports-page .rp-table tbody tr:hover { background: rgba(99, 102, 241, 0.08); }
  .reports-page .rp-link { color: #a5b4fc; }
  .reports-page .rp-link:hover { color: #c7d2fe; }
  .reports-page .rp-pill { background: rgba(71, 85, 105, 0.45); color: #cbd5e1; }
  .reports-page .rp-pill[data-status="published"],
  .reports-page .rp-pill.ok { background: rgba(5, 150, 105, 0.18); color: #6ee7b7; }
  .reports-page .rp-pill.err { background: rgba(127, 29, 29, 0.32); color: #fca5a5; }
  .reports-page .rp-pill.muted { background: transparent; color: #64748b; }
  .reports-page .btn-primary { background: #4f46e5; color: #fff; }
  .reports-page .btn-primary:hover { background: #6366f1; }
  .reports-page .btn-secondary { background: #1f2937; border-color: #374151; color: #e5e7eb; }
  .reports-page .btn-secondary:hover { background: #374151; }
  .reports-page .btn-link { color: #a5b4fc; }
  .reports-page .btn-link:hover { color: #c7d2fe; }
  .reports-page .btn-link.danger { color: #fca5a5; }
  .reports-page .protected-label { color: #6ee7b7; }
  @media (max-width: 720px) {
    .reports-page .rp-actions { width: 100%; flex-wrap: wrap; }
    .reports-page .rp-actions .btn { flex: 1 1 auto; }
  }
</style>
