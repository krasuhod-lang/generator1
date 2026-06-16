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
.sr-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
.sr-head h1 { font-size: 24px; margin: 8px 0 16px; }
.back-btn { background: none; border: none; color: #0071e3; cursor: pointer; font-size: 14px; padding: 0; }
.sr-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.sr-table th, .sr-table td { padding: 10px 12px; font-size: 13px; text-align: left; border-bottom: 1px solid rgba(0,0,0,0.06); }
.sr-table th { background: #fafafa; font-weight: 600; }
.sr-link { color: #0071e3; text-decoration: none; margin-right: 8px; font-family: ui-monospace, SFMono-Regular, monospace; }
.btn-link { background: none; border: none; color: #0071e3; cursor: pointer; font-size: 12px; padding: 2px 6px; }
.btn-link.danger { color: #b00020; }
.btn-link:disabled { opacity: 0.5; }
.actions { display: flex; gap: 6px; }
.rp-pill { padding: 2px 8px; border-radius: 12px; background: rgba(220,40,40,0.1); color: #b00020; font-size: 11px; }
.rp-pill[data-active="true"] { background: rgba(0,150,80,0.12); color: #047b3a; }
.lock { margin-left: 6px; }
.empty { padding: 48px; text-align: center; color: rgba(0,0,0,0.5); border: 1px dashed rgba(0,0,0,0.15); border-radius: 12px; }
.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: #fff; padding: 24px; border-radius: 12px; min-width: 380px; display: flex; flex-direction: column; gap: 12px; }
.modal h2 { margin: 0; font-size: 18px; }
.modal label { display: flex; flex-direction: column; gap: 4px; }
.modal label.checkbox { flex-direction: row; align-items: center; gap: 8px; }
.lbl { font-size: 12px; color: rgba(0,0,0,0.55); }
.modal input { padding: 8px 10px; border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn-primary { background: #0071e3; color: #fff; }
.btn-secondary { background: #f5f5f7; }
.err { color: #b00020; font-size: 12px; }
</style>
