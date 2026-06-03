<script setup>
/**
 * CategoryLeadPage — инструмент «Lead-text + Фасетный SEO-оптимизатор».
 *   • Название категории + (опц.) URL категории для парсинга фильтров.
 *   • Список фильтров (сущности) — ручной ввод «Группа: знач1, знач2».
 *   • Источник интентов: ручные вопросы и/или подключённый GSC-проект.
 *   • Семантическое ядро (опц.) для Прохода 2.
 * Запускает 2 LLM-прохода: навигационный Lead-text + фасет-оптимизатор.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useCategoryLeadStore } from '../stores/categoryLead.js';
import api from '../api.js';

const router = useRouter();
const store  = useCategoryLeadStore();

const form = ref({
  name: '',
  category: '',
  category_url: '',
  filters: '',
  questions: '',
  semantic_core: '',
  gsc_project_id: '',
});

const submitting = ref(false);
const formError  = ref(null);
const projects   = ref([]);

// ── Auto-pull контекста выбранного проекта ─────────────────────────
// При смене селектора подтягиваем последний анализ и аккуратно
// префиллим только пустые поля формы (не затираем введённое вручную).
const projectContext = ref(null);
const contextLoading = ref(false);
const contextError   = ref('');

function _isEmpty(v) {
  return v == null || String(v).trim() === '';
}

function fmtAnalysisDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('ru-RU'); } catch (_) { return ''; }
}

async function onProjectChanged() {
  projectContext.value = null;
  contextError.value   = '';
  const id = form.value.gsc_project_id;
  if (!id) return;
  contextLoading.value = true;
  try {
    const { data } = await api.get(`/projects/${encodeURIComponent(id)}/lead-context`);
    projectContext.value = data || null;
    const proj = data?.project || {};
    const ctx  = data?.context || {};

    // Префилл: только если поле пустое — не перетираем пользователя.
    if (_isEmpty(form.value.name) && proj.name) {
      form.value.name = String(proj.name).slice(0, 200);
    }
    if (_isEmpty(form.value.category_url) && proj.url) {
      form.value.category_url = String(proj.url).slice(0, 2000);
    }
    if (_isEmpty(form.value.questions) && Array.isArray(ctx.suggested_questions) && ctx.suggested_questions.length) {
      form.value.questions = ctx.suggested_questions.join('\n');
    }
    if (_isEmpty(form.value.semantic_core) && Array.isArray(ctx.suggested_core) && ctx.suggested_core.length) {
      form.value.semantic_core = ctx.suggested_core.join('\n');
    }
  } catch (err) {
    contextError.value = err.response?.data?.error || err.message || 'Не удалось подтянуть контекст проекта';
  } finally {
    contextLoading.value = false;
  }
}

function clearProjectContext() {
  // Не трогаем уже введённые данные — только убираем бейдж и информацию.
  projectContext.value = null;
}

async function loadProjects() {
  try {
    const { data } = await api.get('/projects');
    projects.value = (Array.isArray(data?.projects) ? data.projects : [])
      .filter((p) => p.gsc_connected);
  } catch (_) { projects.value = []; }
}

async function handleSubmit() {
  formError.value = null;
  if (!form.value.category.trim()) {
    formError.value = 'Укажите название категории';
    return;
  }
  if (!form.value.filters.trim() && !form.value.category_url.trim()) {
    formError.value = 'Укажите список фильтров или URL категории для их парсинга';
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      name: form.value.name.trim() || form.value.category.trim(),
      category: form.value.category.trim(),
      category_url: form.value.category_url.trim(),
      filters: form.value.filters,
      questions: form.value.questions,
      semantic_core: form.value.semantic_core,
      gsc_project_id: form.value.gsc_project_id || null,
    };
    const id = await store.createTask(payload);
    if (!id) throw new Error('Сервер не вернул id задачи');
    await store.fetchTasks();
    router.push(`/category-lead/${id}`);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

let pollHandle = null;
onMounted(async () => {
  await Promise.all([store.fetchTasks(), loadProjects()]);
  pollHandle = setInterval(() => {
    if (store.tasks.some((t) => t.status === 'queued' || t.status === 'running')) {
      store.fetchTasks();
    }
  }, 4000);
});
onUnmounted(() => { if (pollHandle) clearInterval(pollHandle); });

const hasInFlight = computed(() => store.tasks.some((t) => t.status === 'queued' || t.status === 'running'));

async function removeTask(id) {
  if (!confirm('Удалить задачу?')) return;
  try { await store.deleteTask(id); } catch (_) { /* ignore */ }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ru-RU'); } catch (_) { return iso; }
}

function statusBadge(s) {
  if (s === 'done')    return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30';
  if (s === 'running') return 'bg-sky-500/10 text-sky-300 border-sky-500/30 animate-pulse';
  if (s === 'queued')  return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
  if (s === 'error')   return 'bg-rose-500/10 text-rose-300 border-rose-500/30';
  return 'bg-gray-700/40 text-gray-300 border-gray-600';
}
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- ─── Форма ─────────────────────────────────────────────── -->
      <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <header class="mb-4">
          <h1 class="text-xl font-semibold text-gray-100">🧭 Lead-text категории</h1>
          <p class="text-sm text-gray-400 mt-1">
            Навигационный верхний текст + семантический оптимизатор фасетной навигации.
            Текст формируется через интенты выбора, а не ключи — снижает когнитивную
            нагрузку и pogo-sticking. Система:
          </p>
          <ul class="text-sm text-gray-400 mt-2 list-disc pl-5 space-y-0.5">
            <li>напишет Lead-text из 3 абзацев (классификация → решение болей → призыв к навигации),</li>
            <li>предложит анкоры на подкатегории и JSON-LD разметку фильтров,</li>
            <li>проведёт SEO-нормализацию фильтров (Rename/New/Merge/Delete + приоритет индексации),</li>
            <li>соберёт ключи High-фасетов для инструмента мета-тегов.</li>
          </ul>
        </header>

        <form @submit.prevent="handleSubmit" class="space-y-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Название категории *</label>
            <input v-model="form.category" type="text" maxlength="200"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="Например: Электросамокаты" />
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">URL категории (опционально)</label>
            <input v-model="form.category_url" type="url" maxlength="2000"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="https://shop.ru/elektrosamokaty/" />
            <p class="text-[11px] text-gray-500 mt-1">
              Если фильтры не заданы вручную — попробуем извлечь их со страницы (best-effort).
            </p>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Список фильтров (сущности)</label>
            <textarea v-model="form.filters" rows="4"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 font-mono"
              placeholder="Бренд: Xiaomi, Kugoo&#10;Мощность мотора: 350 Вт, 500 Вт&#10;Запас хода: 30 км, 45 км&#10;Диаметр колёс: 8.5&quot;, 10&quot;"></textarea>
            <p class="text-[11px] text-gray-500 mt-1">
              Формат «Группа: значение1, значение2», группы — с новой строки или через «;».
            </p>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Вопросы / боли покупателей (интенты)</label>
            <textarea v-model="form.questions" rows="3"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="какой самокат подойдёт для веса 100+ кг?&#10;что лучше для брусчатки?&#10;какой запас хода реальный?"></textarea>
            <p class="text-[11px] text-gray-500 mt-1">Один вопрос на строку.</p>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">GSC-проект (источник интентов, опц.)</label>
            <select v-model="form.gsc_project_id" @change="onProjectChanged"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100">
              <option value="">— не использовать GSC —</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <p class="text-[11px] text-gray-500 mt-1">
              Если выбран — запросы страницы (по URL выше) отсортируются по показам и
              сгруппируются в кластеры интентов.
            </p>

            <!-- Бейдж: данные подтянуты из проекта. -->
            <div v-if="contextLoading" class="mt-2 text-[11px] text-gray-500 italic">
              ↻ Подтягиваем данные проекта…
            </div>
            <div v-else-if="contextError" class="mt-2 text-[11px] text-amber-400">
              ⚠ {{ contextError }}
            </div>
            <div v-else-if="projectContext && projectContext.has_analysis"
                 class="mt-2 flex items-start justify-between gap-2 text-[11px]
                        bg-emerald-500/5 border border-emerald-500/30 rounded px-2 py-1.5">
              <div class="text-emerald-300 leading-snug">
                ✓ Подтянуто из проекта <b>{{ projectContext.project?.name }}</b>
                <span v-if="projectContext.context?.source_analysis_completed_at" class="text-emerald-400/80">
                  (анализ от {{ fmtAnalysisDate(projectContext.context.source_analysis_completed_at) }})
                </span>:
                {{ (projectContext.context?.suggested_questions?.length || 0) }} вопросов,
                {{ (projectContext.context?.suggested_core?.length || 0) }} запросов,
                {{ (projectContext.context?.brand_tokens?.length || 0) }} brand-токенов.
              </div>
              <button type="button" @click="clearProjectContext"
                      class="text-[11px] text-gray-400 hover:text-rose-400 shrink-0">очистить</button>
            </div>
            <div v-else-if="projectContext && !projectContext.has_analysis"
                 class="mt-2 text-[11px] text-gray-500 italic">
              ℹ Подтянуты данные проекта <b>{{ projectContext.project?.name }}</b>
              (история анализов пуста — запустите анализ в карточке проекта,
              чтобы получить интенты и семантическое ядро).
            </div>
          </div>

          <details class="text-sm">
            <summary class="text-xs text-gray-400 cursor-pointer">Семантическое ядро (опционально)</summary>
            <textarea v-model="form.semantic_core" rows="3"
              class="w-full mt-2 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="по одному запросу на строку (выгрузка Ahrefs/Semrush/KeyCollector)"></textarea>
          </details>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Название задачи (опц.)</label>
            <input v-model="form.name" type="text" maxlength="200"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="по умолчанию — название категории" />
          </div>

          <div v-if="formError" class="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
            ⚠ {{ formError }}
          </div>

          <button type="submit" :disabled="submitting"
            class="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:cursor-not-allowed
                   text-white font-semibold py-2.5 rounded transition">
            {{ submitting ? 'Запуск…' : 'Сгенерировать Lead-text' }}
          </button>
        </form>
      </section>

      <!-- ─── Список задач ─────────────────────────────────────── -->
      <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <header class="mb-3 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-gray-100">Мои задачи</h2>
          <button @click="store.fetchTasks()"
                  class="text-xs text-indigo-400 hover:text-indigo-300">↻ обновить</button>
        </header>

        <div v-if="store.loading && store.tasks.length === 0" class="text-sm text-gray-500">Загрузка…</div>
        <div v-else-if="store.tasks.length === 0" class="text-sm text-gray-500">
          Пока нет задач. Заполните форму слева.
        </div>

        <ul v-else class="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          <li v-for="t in store.tasks" :key="t.id"
              class="border border-gray-800 rounded-lg p-3 hover:border-indigo-600 transition cursor-pointer"
              @click="router.push(`/category-lead/${t.id}`)">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-100 truncate">{{ t.name || t.category || '(без имени)' }}</div>
                <div class="text-xs text-gray-500 mt-0.5">{{ fmtDate(t.created_at) }} · {{ t.category }}</div>
                <div v-if="t.error_message" class="text-xs text-rose-400 mt-1 truncate">⚠ {{ t.error_message }}</div>
              </div>
              <div class="flex flex-col items-end gap-1">
                <span class="text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5"
                      :class="statusBadge(t.status)">{{ t.status }}</span>
                <button v-if="t.status === 'done' || t.status === 'error'" @click.stop="removeTask(t.id)"
                        class="text-[11px] text-gray-500 hover:text-rose-400">удалить</button>
              </div>
            </div>
          </li>
        </ul>

        <p v-if="hasInFlight" class="text-[11px] text-gray-500 mt-3 italic">
          ↻ Автообновление каждые 4 секунды, пока есть активные задачи.
        </p>
      </section>
    </div>
  </AppLayout>
</template>
