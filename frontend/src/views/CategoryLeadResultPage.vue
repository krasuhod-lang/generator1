<script setup>
/**
 * CategoryLeadResultPage — результат инструмента
 * «Lead-text + Фасетный SEO-оптимизатор».
 *   • Проход 1: Lead-text (абзацы/HTML), UX-обоснование, анкоры, JSON-LD,
 *     черновик мета-тегов категории.
 *   • Проход 2: таблица фасет-оптимизатора + Топ-рекомендации + noindex.
 *   • Мост: ключи High-фасетов → кнопка «Отправить в инструмент мета-тегов».
 *   • Экспорт: CSV (таблица) и Markdown (lead-text + рекомендации).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useCategoryLeadStore } from '../stores/categoryLead.js';
import api from '../api.js';

const route  = useRoute();
const router = useRouter();
const store  = useCategoryLeadStore();

const task    = ref(null);
const loading = ref(true);
const error   = ref(null);
const sending = ref(false);
const sentMsg = ref('');

const lead  = computed(() => task.value?.lead_text || {});
const facet = computed(() => task.value?.facet_table || {});
const meta  = computed(() => task.value?.meta || {});
const diag  = computed(() => task.value?.diagnostics || {});

async function load() {
  try {
    task.value = await store.getTask(route.params.id);
    if (!task.value) error.value = 'Задача не найдена';
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}

let pollHandle = null;
onMounted(async () => {
  await load();
  pollHandle = setInterval(async () => {
    if (task.value && (task.value.status === 'queued' || task.value.status === 'running')) {
      await load();
    }
  }, 4000);
});
onUnmounted(() => { if (pollHandle) clearInterval(pollHandle); });

function safeName() {
  return (task.value?.name || 'category-lead').replace(/[^a-zA-Z0-9_\-а-яА-ЯёЁ]+/g, '_').slice(0, 80);
}

function downloadFile(kind) {
  const ext = kind === 'csv' ? 'csv' : 'md';
  const mime = kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8';
  api.get(`/category-lead/${task.value.id}/export.${ext}`, { responseType: 'blob' })
    .then((res) => {
      const blob = new Blob([res.data], { type: mime });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName()}_${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch((err) => alert(err.response?.data?.error || err.message || 'Ошибка экспорта'));
}

async function sendKeysToMeta() {
  const keys = meta.value.virtual_keys || [];
  if (!keys.length) return;
  sending.value = true;
  sentMsg.value = '';
  try {
    const id = await store.sendKeysToMetaTags({
      name: `Фасеты: ${task.value.category}`,
      category: task.value.category,
      keywords: keys,
    });
    if (id) {
      sentMsg.value = 'Задача мета-тегов создана.';
      setTimeout(() => router.push(`/meta-tags/${id}`), 800);
    }
  } catch (err) {
    sentMsg.value = err.response?.data?.error || err.message || 'Ошибка отправки';
  } finally {
    sending.value = false;
  }
}

function copyText(txt) {
  try { navigator.clipboard.writeText(txt); } catch (_) { /* ignore */ }
}

const jsonLdStr = computed(() => {
  try { return lead.value.json_ld ? JSON.stringify(lead.value.json_ld, null, 2) : ''; }
  catch (_) { return ''; }
});

function priorityClass(p) {
  if (p === 'High') return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30';
  if (p === 'Low')  return 'bg-gray-700/40 text-gray-300 border-gray-600';
  return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
}
function actionClass(a) {
  if (a === 'New')    return 'text-sky-300';
  if (a === 'Delete') return 'text-rose-300';
  if (a === 'Merge')  return 'text-violet-300';
  return 'text-gray-200';
}
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-6xl mx-auto space-y-5">
      <div class="flex items-center justify-between">
        <button @click="router.push('/category-lead')" class="text-sm text-indigo-400 hover:text-indigo-300">← к списку</button>
        <div v-if="task" class="flex gap-2">
          <button @click="downloadFile('md')" class="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700">⬇ Markdown</button>
          <button @click="downloadFile('csv')" class="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700">⬇ CSV (фасеты)</button>
        </div>
      </div>

      <div v-if="loading" class="text-sm text-gray-500">Загрузка…</div>
      <div v-else-if="error" class="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">⚠ {{ error }}</div>

      <template v-else-if="task">
        <header>
          <h1 class="text-2xl font-semibold text-gray-100">{{ task.category || task.name }}</h1>
          <p class="text-xs text-gray-500 mt-1">
            Статус: <span class="uppercase">{{ task.status }}</span>
            <span v-if="task.llm_model"> · {{ task.llm_model }}</span>
            <span v-if="task.cost_usd"> · ${{ Number(task.cost_usd).toFixed(4) }}</span>
          </p>
          <p v-if="task.error_message" class="text-sm text-rose-400 mt-2">⚠ {{ task.error_message }}</p>
        </header>

        <div v-if="task.status === 'queued' || task.status === 'running'"
             class="text-sm text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded px-3 py-2 animate-pulse">
          ⏳ Генерация запущена. Страница обновится автоматически…
        </div>

        <template v-if="task.status === 'done'">
          <!-- ─── Проход 1: Lead-text ──────────────────────────── -->
          <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-lg font-semibold text-gray-100">📝 Lead-text (над листингом)</h2>
              <button @click="copyText((lead.paragraphs || []).join('\n\n'))"
                      class="text-xs text-indigo-400 hover:text-indigo-300">копировать текст</button>
            </div>
            <div class="prose prose-invert max-w-none text-gray-200 space-y-3">
              <p v-for="(p, i) in lead.paragraphs" :key="i">{{ p }}</p>
            </div>

            <div v-if="lead.ux_rationale" class="mt-4 text-sm text-gray-300 bg-gray-950 border border-gray-800 rounded p-3">
              <div class="text-xs uppercase text-gray-500 mb-1">UX-обоснование</div>
              {{ lead.ux_rationale }}
            </div>

            <div v-if="(lead.anchor_suggestions || []).length" class="mt-4">
              <div class="text-xs uppercase text-gray-500 mb-1">Анкоры на подкатегории</div>
              <ul class="text-sm text-gray-300 space-y-1">
                <li v-for="(a, i) in lead.anchor_suggestions" :key="i">
                  <span class="text-indigo-300">«{{ a.anchor }}»</span>
                  <span v-if="a.target_hint" class="text-gray-500"> → {{ a.target_hint }}</span>
                  <span v-if="a.based_on_filter" class="text-gray-600 text-xs"> ({{ a.based_on_filter }})</span>
                </li>
              </ul>
            </div>

            <div v-if="(lead.used_filter_entities || []).length" class="mt-4">
              <div class="text-xs uppercase text-gray-500 mb-1">Использованные сущности фильтров</div>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="(e, i) in lead.used_filter_entities" :key="i"
                      class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">{{ e }}</span>
              </div>
            </div>
          </section>

          <!-- ─── JSON-LD + черновик меты ───────────────────────── -->
          <section class="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div v-if="jsonLdStr" class="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-semibold text-gray-100">🔖 JSON-LD разметка</h3>
                <button @click="copyText(jsonLdStr)" class="text-xs text-indigo-400 hover:text-indigo-300">копировать</button>
              </div>
              <pre class="text-xs text-gray-300 bg-gray-950 border border-gray-800 rounded p-3 overflow-x-auto">{{ jsonLdStr }}</pre>
            </div>

            <div v-if="meta.category_meta_draft" class="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 class="text-sm font-semibold text-gray-100 mb-2">🏷️ Черновик мета-тегов категории</h3>
              <div class="text-sm text-gray-300 space-y-2">
                <div><span class="text-gray-500 text-xs uppercase">Title</span><br>{{ meta.category_meta_draft.title }}</div>
                <div><span class="text-gray-500 text-xs uppercase">Description</span><br>{{ meta.category_meta_draft.description }}</div>
                <div><span class="text-gray-500 text-xs uppercase">H1</span><br>{{ meta.category_meta_draft.h1 }}</div>
              </div>
              <p class="text-[11px] text-gray-500 mt-2">Черновик — дошлифуйте в инструменте мета-тегов.</p>
            </div>
          </section>

          <!-- ─── Проход 2: таблица фасет-оптимизатора ──────────── -->
          <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 class="text-lg font-semibold text-gray-100 mb-3">🧩 Семантический оптимизатор фильтров</h2>
            <div class="overflow-x-auto">
              <table class="w-full text-sm text-left">
                <thead class="text-xs uppercase text-gray-500 border-b border-gray-800">
                  <tr>
                    <th class="py-2 pr-3">Текущий</th>
                    <th class="py-2 pr-3">SEO-название</th>
                    <th class="py-2 pr-3">Действие</th>
                    <th class="py-2 pr-3">Обоснование</th>
                    <th class="py-2">Индексация</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in (facet.rows || [])" :key="i" class="border-b border-gray-800/60">
                    <td class="py-2 pr-3 text-gray-300">{{ r.current }}</td>
                    <td class="py-2 pr-3 text-gray-100 font-medium">{{ r.seo_name }}</td>
                    <td class="py-2 pr-3 font-semibold" :class="actionClass(r.action)">{{ r.action }}</td>
                    <td class="py-2 pr-3 text-gray-400">{{ r.reason }}</td>
                    <td class="py-2">
                      <span class="text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5"
                            :class="priorityClass(r.index_priority)">{{ r.index_priority }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="(facet.top_recommendations || []).length" class="mt-4">
              <div class="text-xs uppercase text-gray-500 mb-1">Топ-рекомендации</div>
              <ol class="text-sm text-gray-300 list-decimal pl-5 space-y-0.5">
                <li v-for="(r, i) in facet.top_recommendations" :key="i">{{ r }}</li>
              </ol>
            </div>

            <div v-if="(facet.noindex_list || []).length" class="mt-4">
              <div class="text-xs uppercase text-gray-500 mb-1">Закрыть от индексации (noindex)</div>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="(n, i) in facet.noindex_list" :key="i"
                      class="text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">{{ n }}</span>
              </div>
            </div>
          </section>

          <!-- ─── Мост к мета-тегам ─────────────────────────────── -->
          <section v-if="(meta.virtual_keys || []).length" class="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-lg font-semibold text-gray-100">🔑 Ключи High-фасетов для мета-тегов</h2>
              <button @click="sendKeysToMeta" :disabled="sending"
                      class="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 text-white font-semibold">
                {{ sending ? 'Отправка…' : 'Сгенерировать мета-теги для приоритетных фасетов' }}
              </button>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="(k, i) in meta.virtual_keys" :key="i"
                    class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-200 border border-gray-700">{{ k }}</span>
            </div>
            <p v-if="sentMsg" class="text-xs text-emerald-300 mt-2">{{ sentMsg }}</p>
          </section>

          <!-- ─── Диагностика сбора данных ──────────────────────── -->
          <section v-if="diag.filters || diag.intents" class="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-400">
            <h3 class="text-xs uppercase text-gray-500 mb-2">Диагностика</h3>
            <ul class="space-y-1">
              <li v-if="diag.filters">Фильтры: {{ diag.filters.groups_count }} групп · источник: {{ diag.filters.source }}
                <span v-if="diag.filters.error" class="text-amber-400">({{ diag.filters.error }})</span></li>
              <li v-if="diag.intents">Интенты: {{ diag.intents.gsc_queries }} GSC-запросов · {{ diag.intents.manual_questions }} ручных вопросов · {{ (diag.intents.clusters || []).length }} кластеров</li>
            </ul>
          </section>
        </template>
      </template>
    </div>
  </AppLayout>
</template>
