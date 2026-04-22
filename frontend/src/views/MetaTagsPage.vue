<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useMetaTagsStore } from '../stores/metaTags.js';

const router = useRouter();
const store  = useMetaTagsStore();

// ── Форма создания задачи ──────────────────────────────────────────
const form = ref({
  name:     '',
  niche:    '',
  lr:       '213',
  toponym:  '',
  brand:    '',
  phone:    '',
  summary:  '',
  keywords: '',
});

const submitting = ref(false);
const formError  = ref(null);

const keywordsList = computed(() =>
  form.value.keywords.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
);

// Авто-сохранение черновика формы между перезагрузками
const STORAGE_KEY = 'meta_tags_draft_v1';
onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
});
function saveDraft() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

async function handleCreate() {
  formError.value = null;
  if (keywordsList.value.length === 0) {
    formError.value = 'Добавьте хотя бы один поисковый запрос (по одному на строку).';
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      name:     form.value.name?.trim() || `Метатеги · ${new Date().toLocaleString('ru-RU')}`,
      niche:    form.value.niche.trim(),
      lr:       form.value.lr.trim(),
      toponym:  form.value.toponym.trim(),
      brand:    form.value.brand.trim(),
      phone:    form.value.phone.trim(),
      summary:  form.value.summary.trim(),
      keywords: keywordsList.value,
    };
    saveDraft();
    const id = await store.createTask(payload);
    await store.fetchTasks();
    if (id) router.push(`/meta-tags/${id}`);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

// ── Список задач + автообновление ──────────────────────────────────
let pollTimer = null;
onMounted(async () => {
  await store.fetchTasks();
  pollTimer = setInterval(() => {
    // Polling нужен только пока есть задачи в работе.
    if (store.tasks.some((t) => t.status === 'pending' || t.status === 'in_progress')) {
      store.fetchTasks();
    }
  }, 3000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

async function handleDelete(task) {
  if (!confirm(`Удалить задачу «${task.name}»? Все результаты будут потеряны.`)) return;
  try { await store.deleteTask(task.id); }
  catch (err) { alert(err.response?.data?.error || 'Ошибка удаления'); }
}

function statusBadgeClass(status) {
  switch (status) {
    case 'done':        return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'in_progress': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'pending':     return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':       return 'bg-red-900/40 text-red-300 border border-red-800/60';
    case 'cancelled':   return 'bg-gray-800 text-gray-400 border border-gray-700';
    default:            return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}

function statusLabel(status) {
  return ({
    done: 'Готово',
    in_progress: 'В работе',
    pending: 'Ожидает',
    error: 'Ошибка',
    cancelled: 'Отменено',
  })[status] || status;
}

function progressPct(t) {
  if (!t.progress_total) return 0;
  return Math.round((t.progress_current / t.progress_total) * 100);
}

function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-8">
      <!-- Шапка -->
      <div class="flex items-end justify-between border-b border-gray-800 pb-4">
        <div>
          <h1 class="text-2xl font-bold text-white flex items-center gap-2">
            🏷️ Генератор Мета-тегов
            <span class="text-xs font-medium text-indigo-400 bg-indigo-950/40 border border-indigo-900 px-2 py-0.5 rounded">DrMax v25</span>
          </h1>
          <p class="text-gray-400 text-sm mt-1">
            Bulk-генерация Title + Description по выдаче Яндекса (XMLStock) с математическим анализом LSI.
            <span class="text-gray-500">H1 не формируется по требованию методологии.</span>
          </p>
        </div>
      </div>

      <!-- ── Форма создания задачи ── -->
      <form @submit.prevent="handleCreate" class="card space-y-5">
        <div class="flex items-center gap-2 mb-1">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая задача</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="md:col-span-2">
            <label class="label">Название задачи</label>
            <input v-model="form.name" type="text" class="input"
                   placeholder="Например: Тормозные системы Acura · ноябрь" />
          </div>
          <div class="md:col-span-2">
            <label class="label">Ниша / тематика магазина <span class="text-sky-400">(важно для ИИ)</span></label>
            <input v-model="form.niche" type="text" class="input"
                   placeholder="Тормозные системы, амортизаторы, ГРМ, автозапчасти..." />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class="label">Регион Яндекса (lr)</label>
            <input v-model="form.lr" type="text" class="input" placeholder="213 (Москва)" />
          </div>
          <div>
            <label class="label">Топоним</label>
            <input v-model="form.toponym" type="text" class="input" placeholder="Москва" />
          </div>
          <div>
            <label class="label">Телефон</label>
            <input v-model="form.phone" type="text" class="input" placeholder="+7 (495) 123-45-67" />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="label">Бренд (попадёт в Description)</label>
            <input v-model="form.brand" type="text" class="input" placeholder="Seniko" />
          </div>
          <div>
            <label class="label">Общее УТП (опционально)</label>
            <input v-model="form.summary" type="text" class="input" placeholder="Гарантия 24 мес., доставка сегодня..." />
          </div>
        </div>

        <div>
          <label class="label flex justify-between items-end">
            <span>Список запросов (по одному на строку)</span>
            <span class="text-gray-500 normal-case font-normal">
              Строк: <span class="text-indigo-300 font-semibold">{{ keywordsList.length }}</span>
              <span class="text-gray-600"> · максимум 500 (можно ставить параллельно несколько задач)</span>
            </span>
          </label>
          <textarea v-model="form.keywords" rows="6" class="textarea font-mono text-sm"
                    placeholder="Тормозные диски Acura MDX&#10;Колодки Brembo купить Москва&#10;..."></textarea>
        </div>

        <div v-if="formError"
             class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
          {{ formError }}
        </div>

        <div class="flex items-center gap-3 pt-2">
          <button type="submit" class="btn-primary"
                  :disabled="submitting || keywordsList.length === 0">
            {{ submitting ? '⏳ Создание задачи...' : `🚀 Запустить генерацию (${keywordsList.length})` }}
          </button>
          <button type="button" class="btn-ghost text-xs"
                  @click="form.keywords = ''; formError = null">
            Очистить ключи
          </button>
        </div>
      </form>

      <!-- ── Список задач ── -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-bold text-gray-200 uppercase tracking-wider">📚 Мои задачи</h2>
          <button @click="store.fetchTasks()" class="btn-ghost text-xs">↻ Обновить</button>
        </div>

        <div v-if="store.loading && store.tasks.length === 0" class="text-gray-500 text-sm py-6 text-center">
          Загрузка...
        </div>
        <div v-else-if="store.tasks.length === 0" class="card text-center py-10 text-gray-500 text-sm">
          У вас пока нет задач. Создайте первую — форма выше.
        </div>

        <div v-else class="space-y-2">
          <div v-for="t in store.tasks" :key="t.id"
               class="card flex items-center gap-4 py-3 px-4 hover:border-indigo-700 transition-colors">

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span :class="['badge', statusBadgeClass(t.status)]">{{ statusLabel(t.status) }}</span>
                <button @click="router.push(`/meta-tags/${t.id}`)"
                        class="text-white font-semibold text-sm truncate hover:text-indigo-300 text-left">
                  {{ t.name }}
                </button>
              </div>
              <div class="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <span>📅 {{ formatDate(t.created_at) }}</span>
                <span>🔑 {{ t.keywords_count }} запросов</span>
                <span v-if="t.niche" class="truncate">📂 {{ t.niche }}</span>
                <span v-if="Number(t.total_tokens_in) + Number(t.total_tokens_out) > 0">
                  🧮 {{ (Number(t.total_tokens_in) + Number(t.total_tokens_out)).toLocaleString('ru-RU') }} ток.
                  · <span class="text-emerald-400">${{ Number(t.total_cost_usd).toFixed(4) }}</span>
                </span>
                <span v-if="t.error_message" class="text-red-400 truncate" :title="t.error_message">
                  ⚠ {{ t.error_message }}
                </span>
              </div>

              <div v-if="t.status === 'in_progress'" class="mt-2">
                <div class="flex justify-between text-[10px] text-gray-400 mb-1">
                  <span class="truncate">{{ t.active_keyword || '...' }}</span>
                  <span>{{ t.progress_current }} / {{ t.progress_total }} ({{ progressPct(t) }}%)</span>
                </div>
                <div class="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
                  <div class="bg-indigo-500 h-full transition-all" :style="{ width: progressPct(t) + '%' }"></div>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <button @click="router.push(`/meta-tags/${t.id}`)" class="btn-secondary text-xs">
                Открыть
              </button>
              <button @click="handleDelete(t)"
                      class="btn-ghost text-xs text-red-400 hover:text-red-300"
                      :disabled="t.status === 'in_progress'"
                      :title="t.status === 'in_progress' ? 'Дождитесь завершения' : 'Удалить'">
                🗑
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
