<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useMetaTagsStore } from '../stores/metaTags.js';

const route   = useRoute();
const router  = useRouter();
const store   = useMetaTagsStore();

const task        = ref(null);
const loadError   = ref(null);
const initialLoad = ref(true);

let pollTimer = null;

const TITLE_RANGE = { min: 50, max: 60 };
const DESC_RANGE  = { min: 140, max: 160 };

async function reload() {
  try {
    task.value = await store.getTask(route.params.id);
    loadError.value = null;
  } catch (err) {
    loadError.value = err.response?.data?.error || err.message || 'Не удалось загрузить задачу';
  } finally {
    initialLoad.value = false;
  }
}

onMounted(async () => {
  await reload();
  pollTimer = setInterval(() => {
    if (task.value && (task.value.status === 'pending' || task.value.status === 'in_progress')) {
      reload();
    }
  }, 2500);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

// ── Производные данные ─────────────────────────────────────────────
const results = computed(() => Array.isArray(task.value?.results) ? task.value.results : []);
const logs    = computed(() => Array.isArray(task.value?.logs)    ? task.value.logs    : []);
const isRunning = computed(() => task.value?.status === 'in_progress' || task.value?.status === 'pending');

const progressPct = computed(() => {
  if (!task.value?.progress_total) return 0;
  return Math.round((task.value.progress_current / task.value.progress_total) * 100);
});

const stats = computed(() => {
  const ok    = results.value.filter((r) => r.status === 'success').length;
  const bad   = results.value.filter((r) => r.status === 'error').length;
  return { ok, bad, total: results.value.length };
});

// ── Длиновые предупреждения ────────────────────────────────────────
function lenColor(len, range) {
  if (!len) return 'text-gray-500';
  if (len >= range.min && len <= range.max) return 'text-emerald-400';
  return 'text-amber-400';
}
function lenBarPct(len, range) {
  // визуализируем длину относительно диапазона
  const max = range.max + 20;
  return Math.min(100, Math.round((len / max) * 100));
}

// ── Копирование/экспорт ────────────────────────────────────────────
const copyFlash = ref('');
function flash(msg) {
  copyFlash.value = msg;
  setTimeout(() => { if (copyFlash.value === msg) copyFlash.value = ''; }, 2000);
}

async function copyText(text, label = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    flash(label);
  } catch (_) {
    // Fallback для старых браузеров: textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flash(label); } catch (e) { flash('Не удалось скопировать'); }
    document.body.removeChild(ta);
  }
}

/**
 * Готовит TSV (tab-separated) — формат, который Excel вставляет «как таблицу»
 * прямо из буфера обмена (Ctrl+V).
 */
function buildTsvAll() {
  const headers = [
    'Keyword','Status','Intent','Title','Title length','Description','Description length',
    'Niche analysis','Detected year','Title LSI (≥35%)','Description LSI (15–35%)',
    'Used important words','Missed LSI','Error',
  ];
  const cell = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  const rows = [headers.join('\t')];
  results.value.forEach((it) => {
    if (it.status === 'success') {
      const m = it.metas || {};
      const s = it.semantics || {};
      const lsi = m.lsi_check || {};
      const missed = Array.isArray(lsi.missed_lsi) ? lsi.missed_lsi : [];
      rows.push([
        cell(it.keyword), 'success', cell(m.intent),
        cell(m.title), cell(m.title_length),
        cell(m.description), cell(m.description_length),
        cell(m.niche_analysis), cell(m.detected_year),
        cell((s.title_mandatory_words       || []).join(', ')),
        cell((s.description_mandatory_words || []).join(', ')),
        cell((m.used_important_words        || []).join(', ')),
        cell(missed.join(', ')),
        '',
      ].join('\t'));
    } else {
      rows.push([
        cell(it.keyword), 'error', '', '', '', '', '', '', '', '', '', '', '',
        cell(it.error),
      ].join('\t'));
    }
  });
  return rows.join('\n');
}

function copyAllAsTsv() {
  if (results.value.length === 0) return;
  copyText(buildTsvAll(), 'Готово! Вставьте в Excel: Ctrl+V');
}

function copyOneAsTsv(it) {
  // Минимальная строка для одного результата: KW \t Title \t Description \t Intent
  const m = it.metas || {};
  const tsv = [it.keyword, m.title || '', m.description || '', m.intent || ''].join('\t');
  copyText(tsv, 'Скопировано (TSV)');
}

function downloadCsv() {
  // Прямой скачивание через бэкенд (с токеном через интерсептор axios сюда не
  // подойдёт — нужен <a download>). Бэкенд принимает токен только из заголовка,
  // поэтому скачиваем через api.get с responseType=blob.
  import('../api.js').then(({ default: api }) => {
    api.get(`/meta-tags/${task.value.id}/export.csv`, { responseType: 'blob' })
      .then((res) => {
        const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safe = (task.value.name || 'meta-tags').replace(/[^a-zA-Z0-9_\-а-яА-ЯёЁ]+/g, '_').slice(0, 80);
        a.download = `${safe}_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch((err) => alert(err.response?.data?.error || err.message || 'Ошибка экспорта'));
  });
}

function statusBadgeClass(status) {
  switch (status) {
    case 'done':        return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'in_progress': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'pending':     return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':       return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:            return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(status) {
  return ({
    done:'Готово', in_progress:'В работе', pending:'Ожидает',
    error:'Ошибка', cancelled:'Отменено',
  })[status] || status;
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}

// ── UI: разворачиваемый ТОП-20 у каждого результата ────────────────
const expandedSerp = ref(new Set());
function toggleSerp(idx) {
  if (expandedSerp.value.has(idx)) expandedSerp.value.delete(idx);
  else expandedSerp.value.add(idx);
  // reactive trigger
  expandedSerp.value = new Set(expandedSerp.value);
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-6 space-y-6">

      <!-- ── Шапка задачи ── -->
      <div class="flex items-center gap-3 text-sm">
        <button @click="router.push('/meta-tags')" class="btn-ghost text-xs">← К списку</button>
        <span v-if="copyFlash"
              class="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 rounded px-2 py-1">
          ✓ {{ copyFlash }}
        </span>
      </div>

      <div v-if="initialLoad" class="card text-center py-10 text-gray-500">Загрузка…</div>
      <div v-else-if="loadError" class="card text-red-400">{{ loadError }}</div>

      <template v-else-if="task">
        <!-- ── Сводка задачи ── -->
        <div class="card space-y-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center gap-2 mb-2">
                <span :class="['badge', statusBadgeClass(task.status)]">{{ statusLabel(task.status) }}</span>
                <h1 class="text-xl font-bold text-white truncate">{{ task.name }}</h1>
              </div>
              <div class="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
                <span>📅 Создана: {{ formatDate(task.created_at) }}</span>
                <span v-if="task.completed_at">🏁 Завершена: {{ formatDate(task.completed_at) }}</span>
                <span v-if="task.niche">📂 Ниша: <span class="text-gray-300">{{ task.niche }}</span></span>
                <span v-if="task.brand">🏷️ Бренд: <span class="text-gray-300">{{ task.brand }}</span></span>
                <span v-if="task.lr">🌍 lr: <span class="text-gray-300">{{ task.lr }}</span></span>
                <span v-if="task.toponym">📍 {{ task.toponym }}</span>
                <span v-if="task.phone">📞 {{ task.phone }}</span>
              </div>
            </div>
            <div class="flex flex-col items-end gap-2 flex-shrink-0">
              <div class="flex gap-2">
                <button @click="copyAllAsTsv" class="btn-secondary text-xs"
                        :disabled="results.length === 0"
                        title="Скопировать все строки в формате TSV — вставляется в Excel как таблица (Ctrl+V)">
                  📋 Копировать всё (для Excel)
                </button>
                <button @click="downloadCsv" class="btn-primary text-xs"
                        :disabled="results.length === 0">
                  📥 CSV
                </button>
              </div>
              <div v-if="task.status === 'done'" class="text-xs text-gray-500">
                Успешно: <span class="text-emerald-300 font-bold">{{ stats.ok }}</span>
                · Ошибки: <span class="text-red-300 font-bold">{{ stats.bad }}</span>
              </div>
            </div>
          </div>

          <!-- Прогресс -->
          <div v-if="isRunning">
            <div class="flex justify-between text-xs text-gray-400 mb-1">
              <span class="truncate">Сейчас: <span class="text-sky-300">{{ task.active_keyword || '…' }}</span></span>
              <span>{{ task.progress_current }} / {{ task.progress_total }} ({{ progressPct }}%)</span>
            </div>
            <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
              <div class="bg-indigo-500 h-full transition-all duration-500" :style="{ width: progressPct + '%' }"></div>
            </div>
          </div>

          <div v-if="task.error_message"
               class="text-sm text-red-300 bg-red-900/20 border border-red-900/50 p-3 rounded">
            ⚠ {{ task.error_message }}
          </div>
        </div>

        <!-- ── Результаты (карточки) ── -->
        <div v-if="results.length > 0" class="space-y-4">
          <div v-for="(it, idx) in results" :key="idx"
               class="card relative">
            <div class="absolute -top-3 -left-3 bg-gray-800 border border-gray-600 text-white font-bold w-8 h-8 flex items-center justify-center rounded-full shadow">
              {{ idx + 1 }}
            </div>

            <div class="flex items-start justify-between gap-3 ml-4 mb-3">
              <h3 class="text-base font-bold text-indigo-300 truncate">{{ it.keyword }}</h3>
              <button v-if="it.status === 'success'"
                      @click="copyOneAsTsv(it)"
                      class="btn-ghost text-[11px]">
                📋 TSV-строка
              </button>
            </div>

            <!-- ── Результат ── -->
            <template v-if="it.status === 'success'">
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

                <!-- Title + Description блок -->
                <div class="bg-gray-950 p-4 rounded-lg border border-gray-800 space-y-4">
                  <!-- Title -->
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <label class="text-[10px] text-gray-500 uppercase font-bold">Title</label>
                      <div class="flex items-center gap-2">
                        <span :class="['text-[11px] font-mono font-bold', lenColor(it.metas.title_length, TITLE_RANGE)]">
                          {{ it.metas.title_length }} / {{ TITLE_RANGE.min }}–{{ TITLE_RANGE.max }}
                        </span>
                        <button @click="copyText(it.metas.title, 'Title скопирован')" class="btn-ghost text-[10px] py-0.5 px-1.5">⎘</button>
                      </div>
                    </div>
                    <div class="text-base font-bold text-sky-300 leading-snug">{{ it.metas.title }}</div>
                    <div class="w-full bg-gray-800 rounded-full h-1 mt-2 overflow-hidden">
                      <div class="h-full transition-all"
                           :class="lenColor(it.metas.title_length, TITLE_RANGE) === 'text-emerald-400' ? 'bg-emerald-500' : 'bg-amber-500'"
                           :style="{ width: lenBarPct(it.metas.title_length, TITLE_RANGE) + '%' }"></div>
                    </div>
                  </div>

                  <!-- Description -->
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <label class="text-[10px] text-gray-500 uppercase font-bold">Description</label>
                      <div class="flex items-center gap-2">
                        <span :class="['text-[11px] font-mono font-bold', lenColor(it.metas.description_length, DESC_RANGE)]">
                          {{ it.metas.description_length }} / {{ DESC_RANGE.min }}–{{ DESC_RANGE.max }}
                        </span>
                        <button @click="copyText(it.metas.description, 'Description скопирован')" class="btn-ghost text-[10px] py-0.5 px-1.5">⎘</button>
                      </div>
                    </div>
                    <div class="text-sm text-gray-200 leading-relaxed">{{ it.metas.description }}</div>
                    <div class="w-full bg-gray-800 rounded-full h-1 mt-2 overflow-hidden">
                      <div class="h-full transition-all"
                           :class="lenColor(it.metas.description_length, DESC_RANGE) === 'text-emerald-400' ? 'bg-emerald-500' : 'bg-amber-500'"
                           :style="{ width: lenBarPct(it.metas.description_length, DESC_RANGE) + '%' }"></div>
                    </div>
                  </div>
                </div>

                <!-- Анализ + LSI -->
                <div class="space-y-3">
                  <div class="bg-gray-900/60 p-3 rounded border border-gray-800 text-xs space-y-1.5">
                    <div>
                      <strong class="text-indigo-300">Интент:</strong>
                      <span class="text-gray-200">{{ it.metas.intent }}</span>
                      <span v-if="it.metas.intent_reason" class="text-gray-500"> — {{ it.metas.intent_reason }}</span>
                    </div>
                    <div v-if="it.metas.detected_year">
                      <strong class="text-indigo-300">Год из ТОПа:</strong>
                      <span class="text-gray-200 font-mono">{{ it.metas.detected_year }}</span>
                    </div>
                    <div v-if="it.metas.niche_analysis" class="text-gray-300 text-[11px] leading-relaxed pt-1 border-t border-gray-800">
                      <strong class="text-indigo-300 block mb-0.5">Анализ ниши:</strong>
                      {{ it.metas.niche_analysis }}
                    </div>
                  </div>

                  <div class="bg-gray-900/60 p-3 rounded border border-gray-800 text-xs space-y-2">
                    <!-- LSI для Title -->
                    <div>
                      <span class="text-[10px] text-emerald-400 uppercase font-bold block mb-1">
                        LSI для Title (≥35% выдачи)
                      </span>
                      <div class="flex flex-wrap gap-1">
                        <span v-for="w in (it.semantics?.title_mandatory_words || [])" :key="`t-${w}`"
                              :class="[
                                'text-[10px] px-1.5 py-0.5 rounded border',
                                (it.metas.lsi_check?.title?.used_lsi || []).includes(w)
                                  ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800/50'
                                  : 'bg-gray-800 text-gray-500 border-gray-700 line-through'
                              ]">{{ w }}</span>
                        <span v-if="(it.semantics?.title_mandatory_words || []).length === 0" class="text-gray-600">—</span>
                      </div>
                    </div>
                    <!-- LSI для Description -->
                    <div>
                      <span class="text-[10px] text-sky-400 uppercase font-bold block mb-1">
                        LSI для Description (15–35% выдачи)
                      </span>
                      <div class="flex flex-wrap gap-1">
                        <span v-for="w in (it.semantics?.description_mandatory_words || [])" :key="`d-${w}`"
                              :class="[
                                'text-[10px] px-1.5 py-0.5 rounded border',
                                (it.metas.lsi_check?.description?.used_lsi || []).includes(w)
                                  ? 'bg-sky-900/30 text-sky-300 border-sky-800/50'
                                  : 'bg-gray-800 text-gray-500 border-gray-700 line-through'
                              ]">{{ w }}</span>
                        <span v-if="(it.semantics?.description_mandatory_words || []).length === 0" class="text-gray-600">—</span>
                      </div>
                    </div>

                    <div v-if="it.metas.post_validation_notes?.length" class="pt-1 border-t border-gray-800 text-[11px] text-amber-300">
                      <span class="text-[10px] uppercase font-bold block mb-0.5">Пост-обработка:</span>
                      <ul class="list-disc list-inside space-y-0.5">
                        <li v-for="(n, ni) in it.metas.post_validation_notes" :key="ni">{{ n }}</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ТОП-20 SERP (раскрываемый) -->
              <div class="mt-4">
                <button @click="toggleSerp(idx)"
                        class="text-xs font-bold text-sky-400 hover:text-sky-300">
                  {{ expandedSerp.has(idx) ? '▾' : '▸' }} ТОП-{{ it.serp?.length || 0 }} конкурентов (XMLStock)
                </button>
                <div v-if="expandedSerp.has(idx)" class="mt-2 space-y-2 max-h-96 overflow-y-auto p-2 bg-gray-950 rounded border border-gray-800">
                  <div v-for="(c, ci) in (it.serp || [])" :key="ci"
                       class="bg-gray-900 p-2 rounded border border-gray-800">
                    <div class="flex items-center gap-2 mb-1 overflow-hidden">
                      <span class="bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded text-[9px] font-bold flex-shrink-0">{{ ci + 1 }}</span>
                      <a :href="c.url" target="_blank" rel="noopener noreferrer"
                         class="text-[10px] text-sky-400 hover:text-sky-300 truncate">{{ c.url }}</a>
                    </div>
                    <div class="text-[12px] font-bold text-gray-200 mb-0.5 leading-snug">{{ c.title }}</div>
                    <div class="text-[11px] text-gray-500 leading-relaxed">{{ c.snippet }}</div>
                  </div>
                </div>
              </div>
            </template>

            <!-- Ошибка -->
            <div v-else class="text-sm text-red-300 bg-red-900/20 p-3 rounded border border-red-900/50 ml-4">
              ❌ Ошибка генерации: {{ it.error }}
            </div>
          </div>
        </div>

        <div v-else-if="!isRunning" class="card text-center py-8 text-gray-500 text-sm">
          В этой задаче нет результатов.
        </div>

        <!-- ── Журнал ── -->
        <details class="card" v-if="logs.length">
          <summary class="cursor-pointer text-xs font-bold text-gray-400 uppercase tracking-wider">
            📡 Журнал выполнения ({{ logs.length }})
          </summary>
          <div class="mt-3 font-mono text-[11px] bg-black/60 p-3 rounded max-h-64 overflow-y-auto border border-gray-800">
            <div v-for="(l, li) in logs" :key="li"
                 :class="l.type === 'err' ? 'text-red-400'
                       : l.type === 'ok'  ? 'text-emerald-400'
                       : l.type === 'warn'? 'text-amber-400'
                       : 'text-gray-400'">
              <span class="text-gray-600">[{{ formatDate(l.time) }}]</span> {{ l.msg }}
            </div>
          </div>
        </details>
      </template>
    </div>
  </AppLayout>
</template>
