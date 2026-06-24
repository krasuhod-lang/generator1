<script setup>
/**
 * ProjectsPage — список SEO-проектов + форма создания.
 * Карточки проектов с переходом на дашборд и индикатором подключения GSC.
 */
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useProjectsStore } from '../stores/projects.js';
import { copyToClipboard } from '../utils/clipboard.js';

const router = useRouter();
const store = useProjectsStore();

const form = ref({ name: '', url: '', audience_description: '' });
const submitting = ref(false);
const formError = ref(null);
const toast = ref(null);
function flash(msg) { toast.value = msg; setTimeout(() => { toast.value = null; }, 2500); }

onMounted(() => { store.fetchProjects(); });

async function submit() {
  formError.value = null;
  if (!form.value.name.trim()) { formError.value = 'Укажите название проекта'; return; }
  if (!form.value.url.trim()) { formError.value = 'Укажите ссылку на проект'; return; }
  submitting.value = true;
  try {
    const project = await store.createProject({
      name: form.value.name.trim(),
      url: form.value.url.trim(),
      audience_description: form.value.audience_description.trim() || null,
    });
    form.value = { name: '', url: '', audience_description: '' };
    await store.fetchProjects();
    if (project?.id) router.push(`/projects/${project.id}`);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания';
  } finally {
    submitting.value = false;
  }
}

async function remove(p) {
  if (!confirm(`Удалить проект «${p.name}»?`)) return;
  try { await store.deleteProject(p.id); } catch (_) { /* no-op */ }
}

// ── Шаринг прямо из карточки проекта (без перехода на детальную страницу) ──
function shareUrlFor(p) {
  return p?.share_token ? `${window.location.origin}/share/project/${p.share_token}` : '';
}
async function quickShare(p) {
  try {
    const result = await store.createShare(p.id, { mode: 'client', ttlDays: 90 });
    const token = result && typeof result === 'object' ? result.token : result;
    if (!token) { flash('Не удалось создать ссылку (пустой ответ сервера)'); return; }
    p.share_token       = token;
    p.share_mode        = (result && typeof result === 'object' && result.mode) || 'client';
    p.share_expires_at  = (result && typeof result === 'object' && result.expires_at) || null;
    const ok = await copyToClipboard(shareUrlFor(p));
    flash(ok ? 'Ссылка создана и скопирована' : 'Ссылка создана');
  } catch (err) {
    const msg = err?.response?.data?.error || err?.message || 'неизвестная ошибка';
    flash(`Не удалось создать ссылку: ${msg}`);
  }
}
async function quickCopy(p) {
  const ok = await copyToClipboard(shareUrlFor(p));
  flash(ok ? 'Ссылка скопирована' : 'Не удалось скопировать');
}
async function quickRevoke(p) {
  if (!confirm('Отозвать публичную ссылку?')) return;
  try {
    await store.revokeShare(p.id);
    p.share_token = null;
    flash('Ссылка отозвана');
  } catch (err) {
    flash(`Ошибка: ${err?.response?.data?.error || err?.message || ''}`);
  }
}
</script>

<template>
  <AppLayout>
    <div class="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 class="text-2xl font-bold text-gray-100">🗂 Проекты</h1>
        <p class="text-sm text-gray-400 mt-1">
          Управление SEO-проектами, интеграция с Google Search Console и Яндекс.Вебмастером, AI-аналитика DeepSeek.
        </p>
      </header>

      <!-- Форма создания -->
      <section class="card space-y-3">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">Новый проект</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="label">Название проекта *</label>
            <input v-model="form.name" class="input" placeholder="Интернет-магазин обуви" />
          </div>
          <div>
            <label class="label">Ссылка на проект *</label>
            <input v-model="form.url" class="input" placeholder="https://example.com" />
          </div>
        </div>
        <div>
          <label class="label">Описание целевой аудитории</label>
          <textarea v-model="form.audience_description" rows="3" class="input"
                    placeholder="Кто целевой клиент, его боли, гео, сегменты…"></textarea>
        </div>
        <div v-if="formError" class="text-sm text-red-400">{{ formError }}</div>
        <p class="text-xs text-gray-500">
          После создания проект сразу получит связанное пространство для отчётов и съёма позиций. На странице проекта вы сможете подключить обе системы веб-аналитики —
          <span class="text-indigo-300">Google Search Console</span> и
          <span class="text-red-300">Яндекс.Вебмастер</span> — и сопоставить данные между ними.
        </p>
        <div class="flex justify-end">
          <button class="btn-primary" :disabled="submitting" @click="submit">
            {{ submitting ? 'Создание…' : '➕ Создать проект' }}
          </button>
        </div>
      </section>

      <!-- Список -->
      <section class="space-y-3">
        <div v-if="store.loading" class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div v-for="n in 4" :key="n" class="card h-24 animate-pulse bg-gray-900/60"></div>
        </div>
        <div v-else-if="!store.projects.length" class="text-sm text-gray-500 text-center py-8">
          Пока нет проектов. Создайте первый выше.
        </div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div v-for="p in store.projects" :key="p.id"
               class="card hover:border-indigo-700/60 transition-colors cursor-pointer"
               @click="router.push(`/projects/${p.id}`)">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-semibold text-gray-100 truncate">{{ p.name }}</div>
                <a :href="p.url" target="_blank" rel="noopener" class="text-xs text-indigo-400 hover:underline truncate block"
                   @click.stop>{{ p.url }}</a>
              </div>
              <span class="shrink-0 flex flex-wrap gap-1 justify-end">
                <span class="text-[11px] px-2 py-0.5 rounded-full border"
                      :class="p.gsc_connected
                        ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                        : 'border-gray-700 text-gray-400'">
                  {{ p.gsc_connected ? '🔗 GSC' : 'GSC —' }}
                </span>
                <span class="text-[11px] px-2 py-0.5 rounded-full border"
                      :class="p.ydx_connected
                        ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                        : 'border-gray-700 text-gray-400'">
                  {{ p.ydx_connected ? '🔗 Яндекс' : 'Яндекс —' }}
                </span>
                <span class="text-[11px] px-2 py-0.5 rounded-full border"
                      :class="p.linked_position_project_id
                        ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                        : 'border-gray-700 text-gray-400'">
                  {{ p.linked_position_project_id ? '📈 Позиции' : 'Позиции —' }}
                </span>
              </span>
            </div>
            <p v-if="p.audience_description" class="text-xs text-gray-500 mt-2 line-clamp-2">
              {{ p.audience_description }}
            </p>
            <div class="flex items-center justify-between mt-3 gap-2 flex-wrap">
              <div class="flex items-center gap-2 flex-wrap">
                <template v-if="p.share_token">
                  <span class="text-[11px] text-emerald-300">🌐 Ссылка активна</span>
                  <button class="text-[11px] text-indigo-300 hover:text-indigo-200" @click.stop="quickCopy(p)">📋 Скопировать</button>
                  <button class="text-[11px] text-gray-400 hover:text-gray-200" @click.stop="quickRevoke(p)">Отозвать</button>
                </template>
                <button v-else class="text-[11px] text-indigo-300 hover:text-indigo-200" @click.stop="quickShare(p)">
                  🌐 Поделиться доступом
                </button>
              </div>
              <button class="text-xs text-red-400 hover:text-red-300" @click.stop="remove(p)">Удалить</button>
            </div>
          </div>
        </div>
      </section>

      <transition name="fade">
        <div v-if="toast" class="fixed bottom-6 right-6 bg-gray-900 border border-indigo-700 text-indigo-200 px-4 py-2 rounded-lg shadow-lg text-sm z-50">
          {{ toast }}
        </div>
      </transition>
    </div>
  </AppLayout>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
