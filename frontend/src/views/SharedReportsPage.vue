<script setup>
/**
 * SharedReportsPage — список опубликованных публичных ссылок.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useReportsStore } from '../stores/reports.js';

const router = useRouter();
const store = useReportsStore();

const editing = ref(null); // {uuid, expires_in_days, password}
const editError = ref(null);

onMounted(() => store.fetchShared());

function fmtDate(s) { return s ? new Date(s).toLocaleString('ru-RU') : '—'; }

function copyUrl(url) {
  if (!url) return;
  navigator.clipboard?.writeText(url);
}

const baseUrl = computed(() => `${window.location.protocol}//${window.location.host}`);
function publicUrl(uuid) { return `${baseUrl.value}/r/${uuid}`; }

async function revoke(uuid) {
  if (!confirm('Отозвать ссылку? Действие необратимо.')) return;
  await store.revokeShared(uuid);
  await store.fetchShared();
}

function startEdit(item) {
  editing.value = {
    uuid: item.uuid,
    expires_in_days: '',
    password: '',
    clear_password: false,
    is_active: item.is_active,
  };
  editError.value = null;
}

async function saveEdit() {
  editError.value = null;
  try {
    const payload = {};
    if (editing.value.expires_in_days) payload.expires_in_days = Number(editing.value.expires_in_days);
    if (editing.value.password) payload.password = editing.value.password;
    else if (editing.value.clear_password) payload.password = null;
    await store.updateSharedSettings(editing.value.uuid, payload);
    editing.value = null;
    await store.fetchShared();
  } catch (e) {
    editError.value = e.response?.data?.error || e.message;
  }
}
</script>

<template>
  <AppLayout>
    <div class="sr-page">
      <header class="sr-head">
        <div>
          <button class="back-btn" @click="router.push('/reports')">← К отчётам</button>
          <h1>Опубликованные ссылки</h1>
        </div>
      </header>

      <table v-if="store.shared.length" class="sr-table">
        <thead>
          <tr>
            <th>Отчёт</th>
            <th>Ссылка</th>
            <th>Режим</th>
            <th>Просмотров</th>
            <th>Истекает</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in store.shared" :key="s.uuid">
            <td>{{ s.draft_title }}</td>
            <td>
              <a :href="publicUrl(s.uuid)" target="_blank" class="sr-link">/r/{{ s.uuid.slice(0, 8) }}…</a>
              <button class="btn-link" @click="copyUrl(publicUrl(s.uuid))">Копировать</button>
            </td>
            <td>{{ s.mode === 'snapshot' ? '📸 Snapshot' : '🔴 Live' }}</td>
            <td>{{ s.view_count || 0 }}</td>
            <td>{{ s.expires_at ? fmtDate(s.expires_at) : 'Бессрочно' }}</td>
            <td>
              <span class="rp-pill" :data-active="s.is_active">{{ s.is_active ? 'Активна' : 'Отозвана' }}</span>
              <span v-if="s.has_password" class="lock" title="Защищено PIN-кодом">🔒</span>
            </td>
            <td class="actions">
              <button class="btn-link" @click="startEdit(s)">Настройки</button>
              <button class="btn-link danger" @click="revoke(s.uuid)" :disabled="!s.is_active">Отозвать</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">Ещё ничего не опубликовано.</div>

      <div v-if="editing" class="modal-back" @click.self="editing = null">
        <div class="modal">
          <h2>Настройки ссылки</h2>
          <label>
            <span class="lbl">Продлить срок (дней с сегодня)</span>
            <input type="number" min="1" max="365" v-model="editing.expires_in_days" />
          </label>
          <label>
            <span class="lbl">Новый PIN (4–8 цифр)</span>
            <input v-model="editing.password" maxlength="8" inputmode="numeric" />
          </label>
          <label class="checkbox">
            <input type="checkbox" v-model="editing.clear_password" />
            <span>Снять защиту PIN-кодом</span>
          </label>
          <div v-if="editError" class="err">{{ editError }}</div>
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="editing = null">Отмена</button>
            <button class="btn btn-primary" @click="saveEdit">Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.sr-page {
  max-width: 1200px; margin: -8px auto 0; padding: 28px;
  background: #f5f5f7; color: #1d1d1f; color-scheme: light;
  border-radius: 22px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; letter-spacing: -0.01em;
}
.sr-head h1 { font-size: 28px; margin: 10px 0 20px; font-weight: 700; letter-spacing: -0.03em; color: #1d1d1f; }
.back-btn { background: none; border: none; color: #0a84ff; cursor: pointer; font-size: 14px; padding: 0; font-weight: 500; }
.back-btn:hover { color: #0071e3; }
.sr-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  background: #fff; border-radius: 18px; overflow: hidden;
  border: 1px solid rgba(60,60,67,0.10);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
}
.sr-table th, .sr-table td { padding: 12px 14px; font-size: 13px; text-align: left; border-bottom: 1px solid rgba(60,60,67,0.08); color: #1d1d1f; }
.sr-table tbody tr:last-child td { border-bottom: 0; }
.sr-table th { background: #fafafa; font-weight: 600; color: #6e6e73; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.sr-table tbody tr:hover { background: rgba(10,132,255,0.04); }
.sr-link { color: #0a84ff; text-decoration: none; margin-right: 8px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
.sr-link:hover { color: #0071e3; text-decoration: underline; }
.btn-link { background: none; border: none; color: #0a84ff; cursor: pointer; font-size: 12px; padding: 3px 8px; font-weight: 500; }
.btn-link:hover { color: #0071e3; }
.btn-link.danger { color: #d70015; }
.btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 6px; }
.rp-pill { padding: 3px 10px; border-radius: 999px; background: rgba(255,59,48,0.12); color: #d70015; font-size: 11px; font-weight: 500; }
.rp-pill[data-active="true"] { background: rgba(48,209,88,0.15); color: #03762d; }
.lock { margin-left: 6px; }
.empty { padding: 60px; text-align: center; color: #6e6e73; border: 1px dashed rgba(60,60,67,0.18); border-radius: 18px; background: #fff; }
.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(8px); }
.modal {
  background: #fff; padding: 28px; border-radius: 18px;
  min-width: 380px; display: flex; flex-direction: column; gap: 14px;
  color: #1d1d1f; box-shadow: 0 8px 30px rgba(0,0,0,0.18);
}
.modal h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
.modal label { display: flex; flex-direction: column; gap: 6px; color: #424245; }
.modal label.checkbox { flex-direction: row; align-items: center; gap: 8px; }
.lbl { font-size: 12px; color: #6e6e73; font-weight: 500; }
.modal input {
  padding: 10px 12px; border: 1px solid rgba(60,60,67,0.18); border-radius: 10px;
  background: #fff; color: #1d1d1f; font-size: 14px;
}
.modal input:focus { outline: none; border-color: #0a84ff; box-shadow: 0 0 0 3px rgba(10,132,255,0.15); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { padding: 9px 16px; border-radius: 10px; font-size: 13px; cursor: pointer; border: 1px solid transparent; font-weight: 500; }
.btn-primary { background: #0a84ff; color: #fff; }
.btn-primary:hover { background: #0071e3; }
.btn-secondary { background: rgba(60,60,67,0.06); color: #1d1d1f; }
.btn-secondary:hover { background: rgba(60,60,67,0.10); }
.err { color: #d70015; font-size: 12px; }
</style>
