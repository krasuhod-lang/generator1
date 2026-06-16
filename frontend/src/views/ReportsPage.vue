<script setup>
/**
 * ReportsPage — список черновиков отчётов + кнопка «Создать новый».
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
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
      <header class="rp-head">
        <div>
          <h1>Отчёты</h1>
          <p class="rp-sub">Конструктор публичных отчётов для клиентов и инвесторов.</p>
        </div>
        <div class="rp-actions">
          <button class="btn btn-secondary" @click="router.push('/reports/shared')">Опубликованные ссылки</button>
          <button class="btn btn-primary" @click="router.push('/reports/new')">+ Новый отчёт</button>
        </div>
      </header>

      <div v-if="store.loading" class="rp-empty">Загрузка…</div>
      <div v-else-if="store.error" class="rp-empty rp-error">{{ store.error }}</div>
      <div v-else-if="!store.drafts.length" class="rp-empty">
        Пока нет ни одного отчёта. Создайте первый, чтобы собрать данные GSC, Я.Вебмастера и Keys.so в один публичный дашборд.
      </div>

      <table v-else class="rp-table">
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
              <button class="btn-link danger" :disabled="removing === d.id" @click="remove(d.id)">Удалить</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </AppLayout>
</template>

<style scoped>
.reports-page { padding: 24px; max-width: 1200px; margin: 0 auto; }
.rp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.rp-head h1 { font-size: 26px; margin: 0; }
.rp-sub { margin: 4px 0 0; color: rgba(0,0,0,0.6); font-size: 14px; }
.rp-actions { display: flex; gap: 8px; }
.btn { padding: 8px 16px; border-radius: 8px; font-size: 14px; cursor: pointer; border: 1px solid transparent; }
.btn-primary { background: #0071e3; color: #fff; }
.btn-primary:hover { background: #005bb5; }
.btn-secondary { background: #fff; border-color: rgba(0,0,0,0.15); }
.rp-empty { padding: 48px 24px; text-align: center; color: rgba(0,0,0,0.55); border: 1px dashed rgba(0,0,0,0.15); border-radius: 12px; }
.rp-error { color: #b00020; }
.rp-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.rp-table th, .rp-table td { padding: 12px 14px; font-size: 14px; text-align: left; border-bottom: 1px solid rgba(0,0,0,0.06); }
.rp-table th { background: #fafafa; font-weight: 600; color: rgba(0,0,0,0.65); }
.rp-link { color: #0071e3; text-decoration: none; font-weight: 500; }
.rp-link:hover { text-decoration: underline; }
.rp-pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; background: rgba(0,0,0,0.06); }
.rp-pill[data-status="published"] { background: rgba(0,150,80,0.12); color: #047b3a; }
.rp-pill.ok { background: rgba(0,150,80,0.12); color: #047b3a; }
.rp-pill.err { background: rgba(220,40,40,0.12); color: #b00020; }
.rp-pill.muted { background: transparent; color: rgba(0,0,0,0.4); }
.rp-row-actions { display: flex; gap: 12px; justify-content: flex-end; }
.btn-link { background: none; border: none; color: #0071e3; cursor: pointer; padding: 4px 6px; font-size: 13px; }
.btn-link.danger { color: #b00020; }
.btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
