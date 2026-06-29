<script setup>
/**
 * AdminProjectsPage — раздача доступов к проектам через панель админа
 * (задача 1, миграция 092). Список всех проектов с владельцем и кол-вом
 * активных грантов; модалка управления доступами.
 *
 * API: /api/admin/projects, /api/admin/projects/:id/grants
 */
import { ref, onMounted, computed } from 'vue';
import axios from 'axios';
import AdminLayout from '../../components/AdminLayout.vue';

const api = axios.create({ baseURL: '/api', timeout: 60_000 });
api.interceptors.request.use((c) => {
  const t = localStorage.getItem('seo_admin_token');
  if (t) c.headers.Authorization = 'Bearer ' + t;
  return c;
});

const projects = ref([]);
const total = ref(0);
const page = ref(1);
const limit = 20;
const search = ref('');
const loading = ref(false);
const error = ref('');

const modalOpen = ref(false);
const activeProject = ref(null);
const grants = ref([]);
const grantableUsers = ref([]);
const userSearch = ref('');
const newGrant = ref({ user_id: '', role: 'viewer', scopes: ['project','analyses','reports'], expires_at: '' });
const savingGrant = ref(false);

const ROLES  = ['viewer','analyst','manager'];
const SCOPES = ['project','analyses','reports'];

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit)));

async function loadProjects() {
  loading.value = true; error.value = '';
  try {
    const { data } = await api.get('/admin/projects', { params: { page: page.value, limit, search: search.value } });
    projects.value = data.projects || [];
    total.value = data.pagination?.total || 0;
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally { loading.value = false; }
}

async function openGrants(p) {
  activeProject.value = p;
  modalOpen.value = true;
  grants.value = [];
  grantableUsers.value = [];
  await Promise.all([loadGrants(), loadGrantableUsers('')]);
}

async function loadGrants() {
  const { data } = await api.get(`/admin/projects/${activeProject.value.id}/grants`);
  grants.value = data.grants || [];
}

async function loadGrantableUsers(q) {
  const { data } = await api.get(`/admin/projects/${activeProject.value.id}/grantable-users`, { params: { search: q } });
  grantableUsers.value = data.users || [];
}

function closeModal() {
  modalOpen.value = false;
  activeProject.value = null;
  newGrant.value = { user_id: '', role: 'viewer', scopes: ['project','analyses','reports'], expires_at: '' };
}

function toggleScope(s) {
  const idx = newGrant.value.scopes.indexOf(s);
  if (idx >= 0) newGrant.value.scopes.splice(idx, 1);
  else newGrant.value.scopes.push(s);
}

async function submitGrant() {
  if (!newGrant.value.user_id) { alert('Выберите пользователя'); return; }
  if (!newGrant.value.scopes.length) { alert('Выберите хотя бы один scope'); return; }
  savingGrant.value = true;
  try {
    const payload = {
      user_id: newGrant.value.user_id,
      role: newGrant.value.role,
      scopes: newGrant.value.scopes,
      expires_at: newGrant.value.expires_at ? new Date(newGrant.value.expires_at).toISOString() : null,
    };
    await api.post(`/admin/projects/${activeProject.value.id}/grants`, payload);
    await loadGrants();
    await loadProjects();
    newGrant.value = { user_id: '', role: 'viewer', scopes: ['project','analyses','reports'], expires_at: '' };
  } catch (e) {
    alert(e.response?.data?.error || e.message);
  } finally { savingGrant.value = false; }
}

async function revokeGrant(g) {
  if (!confirm(`Отозвать доступ у ${g.user_email}?`)) return;
  await api.delete(`/admin/projects/${activeProject.value.id}/grants/${g.id}`);
  await loadGrants();
  await loadProjects();
}

async function changeRole(g, role) {
  await api.patch(`/admin/projects/${activeProject.value.id}/grants/${g.id}`, {
    role, scopes: g.scopes, expires_at: g.expires_at, note: g.note,
  });
  await loadGrants();
}

function isActive(g) { return !g.revoked_at && (!g.expires_at || new Date(g.expires_at) > new Date()); }

onMounted(loadProjects);
</script>

<template>
  <AdminLayout>
    <div class="p-6 max-w-7xl mx-auto">
      <h1 class="text-xl font-bold text-white mb-4">Доступы к проектам</h1>
      <p class="text-sm text-gray-400 mb-4">
        Раздавайте просмотр/редактирование проектов, анализов и отчётов другим
        зарегистрированным пользователям. Владельцем по-прежнему остаётся
        создатель проекта.
      </p>

      <div class="flex gap-2 mb-4">
        <input v-model="search" @keyup.enter="(page=1, loadProjects())"
               placeholder="Поиск по имени проекта или email владельца"
               class="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white"/>
        <button @click="(page=1, loadProjects())" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white">Поиск</button>
      </div>

      <div v-if="error" class="bg-red-900/40 border border-red-700 text-red-200 text-sm px-3 py-2 rounded mb-3">{{ error }}</div>

      <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-800 text-gray-400">
            <tr>
              <th class="text-left px-3 py-2">Проект</th>
              <th class="text-left px-3 py-2">Владелец</th>
              <th class="text-left px-3 py-2">Активных грантов</th>
              <th class="text-left px-3 py-2">Создан</th>
              <th class="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading"><td colspan="5" class="text-center text-gray-500 py-6">Загрузка…</td></tr>
            <tr v-else-if="!projects.length"><td colspan="5" class="text-center text-gray-500 py-6">Нет проектов</td></tr>
            <tr v-for="p in projects" :key="p.id" class="border-t border-gray-800 hover:bg-gray-800/50">
              <td class="px-3 py-2">
                <div class="text-white">{{ p.name }}</div>
                <div class="text-xs text-gray-500 truncate max-w-[28rem]">{{ p.url }}</div>
              </td>
              <td class="px-3 py-2 text-gray-300">
                <div>{{ p.owner_name || '—' }}</div>
                <div class="text-xs text-gray-500">{{ p.owner_email }}</div>
              </td>
              <td class="px-3 py-2">
                <span class="px-2 py-0.5 rounded text-xs font-mono"
                      :class="p.active_grants ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-500'">
                  {{ p.active_grants }}
                </span>
              </td>
              <td class="px-3 py-2 text-gray-500 text-xs">{{ new Date(p.created_at).toLocaleDateString() }}</td>
              <td class="px-3 py-2 text-right">
                <button @click="openGrants(p)" class="text-emerald-400 hover:text-emerald-300 text-xs">Управлять доступом</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex justify-between items-center mt-3 text-sm text-gray-400">
        <span>Всего: {{ total }}</span>
        <div class="flex gap-2">
          <button :disabled="page<=1" @click="(page--, loadProjects())" class="px-3 py-1 bg-gray-800 rounded disabled:opacity-30">←</button>
          <span>{{ page }} / {{ pageCount }}</span>
          <button :disabled="page>=pageCount" @click="(page++, loadProjects())" class="px-3 py-1 bg-gray-800 rounded disabled:opacity-30">→</button>
        </div>
      </div>
    </div>

    <!-- Модалка управления грантами -->
    <div v-if="modalOpen" class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" @click.self="closeModal">
      <div class="bg-gray-900 border border-gray-800 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div class="p-4 border-b border-gray-800 flex justify-between items-start">
          <div>
            <h2 class="text-lg font-bold text-white">{{ activeProject?.name }}</h2>
            <div class="text-xs text-gray-500">Владелец: {{ activeProject?.owner_email }}</div>
          </div>
          <button @click="closeModal" class="text-gray-400 hover:text-white">✕</button>
        </div>

        <div class="p-4">
          <h3 class="text-sm font-semibold text-gray-300 mb-2">Текущие доступы</h3>
          <div v-if="!grants.length" class="text-xs text-gray-500 mb-4">Нет выданных доступов.</div>
          <table v-else class="w-full text-sm mb-4">
            <thead class="text-xs text-gray-500">
              <tr>
                <th class="text-left py-1">Пользователь</th>
                <th class="text-left py-1">Роль</th>
                <th class="text-left py-1">Scope</th>
                <th class="text-left py-1">Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in grants" :key="g.id" class="border-t border-gray-800">
                <td class="py-1.5">
                  <div class="text-gray-200">{{ g.user_name || g.user_email }}</div>
                  <div class="text-xs text-gray-500">{{ g.user_email }}</div>
                </td>
                <td class="py-1.5">
                  <select v-if="isActive(g)" :value="g.role" @change="changeRole(g, $event.target.value)"
                          class="bg-gray-800 border border-gray-700 rounded text-xs px-2 py-0.5 text-white">
                    <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
                  </select>
                  <span v-else class="text-xs text-gray-500">{{ g.role }}</span>
                </td>
                <td class="py-1.5 text-xs text-gray-400">{{ (g.scopes||[]).join(', ') }}</td>
                <td class="py-1.5 text-xs">
                  <span v-if="g.revoked_at" class="text-red-400">отозван</span>
                  <span v-else-if="g.expires_at && new Date(g.expires_at) < new Date()" class="text-yellow-400">истёк</span>
                  <span v-else class="text-emerald-400">активен</span>
                </td>
                <td class="text-right">
                  <button v-if="isActive(g)" @click="revokeGrant(g)" class="text-red-400 hover:text-red-300 text-xs">Отозвать</button>
                </td>
              </tr>
            </tbody>
          </table>

          <h3 class="text-sm font-semibold text-gray-300 mb-2 mt-4">Выдать новый доступ</h3>
          <div class="space-y-3 bg-gray-950 border border-gray-800 rounded p-3">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Пользователь (email/имя)</label>
              <input v-model="userSearch" @input="loadGrantableUsers(userSearch)"
                     placeholder="Поиск..."
                     class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white mb-1"/>
              <select v-model="newGrant.user_id" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white">
                <option value="">— выбрать —</option>
                <option v-for="u in grantableUsers" :key="u.id" :value="u.id">{{ u.email }} ({{ u.name || '—' }})</option>
              </select>
            </div>
            <div class="flex gap-3">
              <div class="flex-1">
                <label class="text-xs text-gray-500 block mb-1">Роль</label>
                <select v-model="newGrant.role" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white">
                  <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
                </select>
              </div>
              <div class="flex-1">
                <label class="text-xs text-gray-500 block mb-1">Истекает</label>
                <input v-model="newGrant.expires_at" type="date" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"/>
              </div>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Scope (доступ к разделам)</label>
              <div class="flex gap-3 flex-wrap">
                <label v-for="s in SCOPES" :key="s" class="text-sm text-gray-300 flex items-center gap-1">
                  <input type="checkbox" :checked="newGrant.scopes.includes(s)" @change="toggleScope(s)"/>
                  {{ s }}
                </label>
              </div>
            </div>
            <div class="text-right">
              <button @click="submitGrant" :disabled="savingGrant"
                      class="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white disabled:opacity-50">
                {{ savingGrant ? 'Сохранение…' : 'Выдать доступ' }}
              </button>
            </div>
          </div>

          <p class="mt-3 text-xs text-gray-500">
            <b>viewer</b> — только чтение (всегда client-вид);
            <b>analyst</b> — чтение + редактирование отчётов;
            <b>manager</b> — analyst + запуск анализов. Удаление и шеринг — только владелец.
          </p>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>
