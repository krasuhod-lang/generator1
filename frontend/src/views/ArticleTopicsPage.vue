<script setup>
/**
 * Вкладка «Темы статей» — foresight-генератор тем статей.
 *
 * Один Gemini-вызов (gemini-3.1-pro-preview) на задачу. Результат —
 * markdown-отчёт со слабыми сигналами, emerging-трендами, контентными
 * кластерами и Strategic Action Plan.
 *
 * Поддерживается два типа задач:
 *  • main      — первичный анализ ниши (Промт 1).
 *  • deep_dive — углубление выбранного тренда (Промт 2). Запускается
 *                из модалки результата завершённой main-задачи.
 *
 * UX-паттерн повторяет AcfJsonPage: слева форма, справа список задач,
 * клик по завершённой задаче — модальное окно с результатом и копированием.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import { useArticleTopicsStore } from '../stores/articleTopics.js';

const store = useArticleTopicsStore();

// ── Форма ────────────────────────────────────────────────────────────
const DRAFT_KEY = 'article_topics_draft_v1';
const form = ref({
  niche:            '',
  region:           '',
  horizon:          '12 месяцев',
  audience:         'смешанная',
  market_stage:     'растущий',
  search_ecosystem: 'оба',
  top_competitors:  '',
});

const formError  = ref('');
const submitting = ref(false);

onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
  store.fetchTasks();
  startPolling();
});

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

async function handleCreate() {
  formError.value = '';
  const niche = (form.value.niche || '').trim();
  if (niche.length < 3) {
    formError.value = 'Поле «Ниша / тема» обязательно (от 3 символов).';
    return;
  }
  submitting.value = true;
  try {
    saveDraft();
    await store.createTask({ ...form.value, niche });
    await store.fetchTasks();
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Не удалось создать задачу';
  } finally {
    submitting.value = false;
  }
}

// ── Polling списка задач (когда есть незавершённые — раз в 5 секунд) ──
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const hasActive = store.tasks.some((t) => t.status === 'queued' || t.status === 'running');
    if (hasActive) await store.fetchTasks();
  }, 5000);
}
onUnmounted(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

// ── Модалка результата ──────────────────────────────────────────────
const activeTaskId = ref(null);
const activeTask   = ref(null);
const modalLoading = ref(false);
const modalError   = ref('');
const copyState    = ref('idle'); // idle | copied
const copyError    = ref('');

const trendInput   = ref('');
const deepDiveBusy = ref(false);
const deepDiveErr  = ref('');

async function openTask(id) {
  activeTaskId.value = id;
  activeTask.value   = null;
  modalLoading.value = true;
  modalError.value   = '';
  copyState.value    = 'idle';
  copyError.value    = '';
  trendInput.value   = '';
  deepDiveErr.value  = '';
  try {
    activeTask.value = await store.getTask(id);
  } catch (err) {
    modalError.value = err.response?.data?.error || err.message || 'Не удалось загрузить задачу';
  } finally {
    modalLoading.value = false;
  }
}

function closeModal() {
  activeTaskId.value = null;
  activeTask.value   = null;
  copyState.value    = 'idle';
  copyError.value    = '';
  trendInput.value   = '';
  deepDiveErr.value  = '';
}

async function copyResult() {
  const md = activeTask.value?.result_markdown;
  if (!md) return;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(md);
    copyState.value = 'copied';
    setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch (e) {
    copyError.value = 'Не удалось скопировать автоматически: ' + (e.message || e) +
                      '. Выделите текст и скопируйте вручную.';
  }
}

async function startDeepDive() {
  deepDiveErr.value = '';
  const trend = (trendInput.value || '').trim();
  if (trend.length < 3) {
    deepDiveErr.value = 'Введите название тренда (от 3 символов).';
    return;
  }
  if (!activeTask.value || activeTask.value.mode !== 'main' ||
      activeTask.value.status !== 'done') {
    deepDiveErr.value = 'Углубление доступно только для завершённой main-задачи.';
    return;
  }
  deepDiveBusy.value = true;
  try {
    const newId = await store.createDeepDive(activeTask.value.id, trend);
    await store.fetchTasks();
    closeModal();
    // Сразу открываем созданную deep-dive задачу — пользователь увидит её прогресс.
    if (newId) openTask(newId);
  } catch (err) {
    deepDiveErr.value = err.response?.data?.error || err.message || 'Не удалось создать deep-dive';
  } finally {
    deepDiveBusy.value = false;
  }
}

// ── Per-row действия ────────────────────────────────────────────────
async function removeTask(id, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm('Удалить задачу?')) return;
  try {
    await store.deleteTask(id);
  } catch (err) {
    alert('Не удалось удалить: ' + (err.response?.data?.error || err.message || ''));
  }
}

// ── Хелперы UI ──────────────────────────────────────────────────────
function statusLabel(s) {
  switch (s) {
    case 'queued':  return 'В очереди';
    case 'running': return 'Идёт обработка';
    case 'done':    return 'Готово';
    case 'error':   return 'Ошибка';
    default:        return s || '—';
  }
}
function statusClass(s) {
  switch (s) {
    case 'queued':  return 'bg-gray-800/70  text-gray-300  border-gray-700';
    case 'running': return 'bg-amber-900/40 text-amber-200 border-amber-700';
    case 'done':    return 'bg-emerald-900/40 text-emerald-200 border-emerald-700';
    case 'error':   return 'bg-red-900/40   text-red-200   border-red-700';
    default:        return 'bg-gray-800/70  text-gray-400  border-gray-700';
  }
}
function modeLabel(m) { return m === 'deep_dive' ? 'Deep-dive' : 'Анализ'; }
function fmtDate(s)   { return s ? new Date(s).toLocaleString('ru-RU') : '—'; }

const sortedTasks = computed(() =>
  [...(store.tasks || [])].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
);
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Шапка -->
      <div class="border-b border-gray-800 pb-4">
        <h1 class="text-2xl font-bold text-white flex items-center gap-2">
          🔮 Темы статей <span class="text-xs font-normal text-gray-500">· foresight forecaster</span>
        </h1>
        <p class="text-gray-400 text-sm mt-1">
          Foresight-анализ ниши: слабые сигналы, emerging-тренды, прогноз поискового спроса
          и Strategic Action Plan. Один проход через Gemini 3.1 Pro Preview ≈ 1–3 минуты на задачу.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Форма (слева) ── -->
        <form @submit.prevent="handleCreate" class="card space-y-4 lg:col-span-5">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая задача</h2>

          <div>
            <label class="label">Ниша / тема <span class="text-red-400">*</span></label>
            <input v-model="form.niche" type="text" class="input"
                   placeholder="Например: оформление ВНЖ Португалии для IT-предпринимателей" />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label">Фокусный регион</label>
              <input v-model="form.region" type="text" class="input"
                     placeholder="Россия / СНГ / Европа / DACH" />
            </div>
            <div>
              <label class="label">Горизонт планирования</label>
              <input v-model="form.horizon" type="text" class="input"
                     placeholder="12 месяцев / 3 года / 5 лет" />
            </div>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="label">Аудитория</label>
              <select v-model="form.audience" class="input">
                <option>B2B</option>
                <option>B2C</option>
                <option>смешанная</option>
              </select>
            </div>
            <div>
              <label class="label">Стадия рынка</label>
              <select v-model="form.market_stage" class="input">
                <option>зарождающийся</option>
                <option>растущий</option>
                <option>зрелый</option>
                <option>стагнирующий</option>
              </select>
            </div>
            <div>
              <label class="label">Поиск</label>
              <select v-model="form.search_ecosystem" class="input">
                <option>Google</option>
                <option>Яндекс</option>
                <option>оба</option>
              </select>
            </div>
          </div>

          <div>
            <label class="label">Топ-3 конкурента (по строке на каждого)</label>
            <textarea v-model="form.top_competitors" rows="3" class="textarea"
                      placeholder="example1.com — описание&#10;example2.com — описание&#10;example3.com — описание"></textarea>
          </div>

          <div v-if="formError"
               class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
            {{ formError }}
          </div>

          <button type="submit" class="btn-primary w-full" :disabled="submitting">
            {{ submitting ? '⏳ Создание задачи...' : '➕ Создать задачу' }}
          </button>
          <p class="text-[11px] text-gray-500">
            Задача поставится в очередь и обработается в фоне. Прогресс — в правой панели.
          </p>
        </form>

        <!-- ── Список задач (справа) ── -->
        <section class="lg:col-span-7 space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📋 Задачи</h2>
            <button class="btn-ghost text-xs border border-gray-700"
                    @click="store.fetchTasks()" :disabled="store.loading">
              {{ store.loading ? '...' : '↻ Обновить' }}
            </button>
          </div>

          <div v-if="store.error"
               class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
            {{ store.error }}
          </div>

          <div v-if="!sortedTasks.length"
               class="card text-center text-gray-500 text-sm py-10">
            Пока нет задач — заполните форму слева и нажмите «Создать задачу».
          </div>

          <ul v-else class="space-y-2">
            <li v-for="t in sortedTasks" :key="t.id"
                @click="openTask(t.id)"
                class="card cursor-pointer hover:border-indigo-700 transition-colors">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs uppercase tracking-wider text-indigo-300">
                      {{ modeLabel(t.mode) }}
                    </span>
                    <span :class="['inline-block px-2 py-0.5 text-[11px] rounded border', statusClass(t.status)]">
                      {{ statusLabel(t.status) }}
                    </span>
                  </div>
                  <div class="text-sm text-white mt-1 truncate" :title="t.niche">
                    <span v-if="t.mode === 'deep_dive' && t.trend_name" class="text-indigo-300">
                      🔍 {{ t.trend_name }} ·
                    </span>
                    {{ t.niche || '—' }}
                  </div>
                  <div class="text-[11px] text-gray-500 mt-1">
                    {{ fmtDate(t.created_at) }}
                    <span v-if="t.cost_usd && Number(t.cost_usd) > 0">
                      · ${{ Number(t.cost_usd).toFixed(4) }}
                    </span>
                  </div>
                  <div v-if="t.status === 'error' && t.error_message"
                       class="text-[11px] text-red-300 mt-1 truncate" :title="t.error_message">
                    ⚠ {{ t.error_message }}
                  </div>
                </div>
                <button class="btn-ghost text-xs border border-gray-700 flex-shrink-0"
                        :disabled="t.status === 'running' || t.status === 'queued'"
                        @click="removeTask(t.id, $event)" title="Удалить задачу">
                  ✕
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <!-- ── Модальное окно результата ── -->
    <div v-if="activeTaskId"
         class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
         @click.self="closeModal">
      <div class="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <header class="flex items-center justify-between px-5 py-3 border-b border-gray-800 flex-shrink-0">
          <div class="min-w-0">
            <div class="text-xs text-gray-400 uppercase tracking-wider">
              {{ activeTask ? modeLabel(activeTask.mode) : 'Задача' }} ·
              <span :class="activeTask ? statusClass(activeTask.status) : ''"
                    class="inline-block px-2 py-0.5 text-[11px] rounded border align-middle">
                {{ activeTask ? statusLabel(activeTask.status) : '...' }}
              </span>
            </div>
            <div class="text-white truncate mt-1">
              <span v-if="activeTask?.mode === 'deep_dive' && activeTask?.trend_name"
                    class="text-indigo-300">🔍 {{ activeTask.trend_name }} · </span>
              {{ activeTask?.niche || '...' }}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <button v-if="activeTask?.status === 'done' && activeTask?.result_markdown"
                    class="btn-primary text-xs" @click="copyResult">
              {{ copyState === 'copied' ? '✅ Скопировано' : '📋 Копировать markdown' }}
            </button>
            <button class="btn-ghost border border-gray-700 text-xs" @click="closeModal">✕</button>
          </div>
        </header>

        <div class="flex-1 overflow-auto p-5">
          <div v-if="copyError"
               class="bg-amber-950/60 border border-amber-800 text-amber-200 rounded-lg px-4 py-2 text-xs mb-3">
            ⚠️ {{ copyError }}
          </div>

          <div v-if="modalLoading" class="text-gray-400 text-sm">Загрузка...</div>
          <div v-else-if="modalError"
               class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
            {{ modalError }}
          </div>
          <template v-else-if="activeTask">
            <div v-if="activeTask.status === 'queued' || activeTask.status === 'running'"
                 class="text-amber-300 text-sm">
              ⏳ Задача обрабатывается. Окно можно закрыть — прогресс отображается в списке справа.
            </div>
            <div v-else-if="activeTask.status === 'error'"
                 class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm whitespace-pre-wrap">
              ⚠ {{ activeTask.error_message || 'Неизвестная ошибка' }}
            </div>
            <pre v-else-if="activeTask.result_markdown"
                 class="text-sm text-gray-100 whitespace-pre-wrap font-sans leading-relaxed"
            >{{ activeTask.result_markdown }}</pre>
            <div v-else class="text-gray-500 text-sm italic">Результат отсутствует.</div>
          </template>
        </div>

        <!-- Deep-dive triggers — только для main-задачи, успешно завершённой -->
        <footer v-if="activeTask?.mode === 'main' && activeTask?.status === 'done'"
                class="border-t border-gray-800 px-5 py-3 flex-shrink-0 space-y-2">
          <div class="text-xs text-gray-400 uppercase tracking-wider">
            🔍 Углубить выбранный тренд (Промт 2)
          </div>
          <div class="flex items-center gap-2">
            <input v-model="trendInput" type="text" class="input flex-1"
                   placeholder="Название тренда из отчёта выше" />
            <button class="btn-primary text-sm" :disabled="deepDiveBusy" @click="startDeepDive">
              {{ deepDiveBusy ? '⏳' : 'Углубить' }}
            </button>
          </div>
          <p v-if="deepDiveErr" class="text-xs text-red-300">{{ deepDiveErr }}</p>
        </footer>
      </div>
    </div>
  </AppLayout>
</template>
