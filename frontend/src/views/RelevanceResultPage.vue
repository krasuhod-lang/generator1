<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../api.js';
import AppLayout from '../components/AppLayout.vue';
import { useRelevanceStore } from '../stores/relevance.js';

const route   = useRoute();
const router  = useRouter();
const store   = useRelevanceStore();

const report      = ref(null);
const loadError   = ref(null);
const initialLoad = ref(true);
let pollTimer    = null;

// ── Filters / paging для таблиц ──────────────────────────────────────────
const vocabFilter = ref('all'); // 'all' | 'important' | 'additional'
const ngramFilter = ref('all'); // 'all' | 'bigram' | 'trigram'

async function reload() {
  try {
    report.value = await store.getReport(route.params.id);
    loadError.value = null;
  } catch (err) {
    loadError.value = err.response?.data?.error || err.message || 'Не удалось загрузить отчёт';
  } finally {
    initialLoad.value = false;
  }
}

onMounted(() => {
  reload();
  pollTimer = setInterval(() => {
    if (report.value && ['pending', 'fetching', 'analyzing'].includes(report.value.status)) {
      reload();
    }
  }, 2500);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });

// ── Derived ──────────────────────────────────────────────────────────────
const vocabulary = computed(() => {
  const list = report.value?.report?.vocabulary;
  return Array.isArray(list) ? list : [];
});
const ngrams = computed(() => {
  const list = report.value?.report?.ngrams;
  return Array.isArray(list) ? list : [];
});
const stats = computed(() => report.value?.report?.stats || {});

const vocabFiltered = computed(() => {
  if (vocabFilter.value === 'all') return vocabulary.value;
  return vocabulary.value.filter((v) => v.status === vocabFilter.value);
});
const ngramsFiltered = computed(() => {
  if (ngramFilter.value === 'all') return ngrams.value;
  return ngrams.value.filter((n) => n.type === ngramFilter.value);
});

// Bar chart: топ-20 по медиане вхождений (как «суммарная частота» по корпусу).
const topByFrequency = computed(() => {
  // Используем bm25_score как «вес» — это и есть рейтинг важности термина.
  // Сортируем по убыванию и берём 20.
  return [...vocabulary.value]
    .filter((v) => v.bm25_score > 0 || v.df >= 5)
    .sort((a, b) => (b.median_count * b.df) - (a.median_count * a.df))
    .slice(0, 20);
});

const barMax = computed(() => {
  const arr = topByFrequency.value;
  return arr.length ? Math.max(...arr.map((v) => v.median_count * v.df)) : 1;
});

// Word cloud: первые 60 «важных» лемм, размер шрифта по bm25_score.
const cloud = computed(() => {
  const items = [...vocabulary.value]
    .filter((v) => v.bm25_score > 0)
    .sort((a, b) => b.bm25_score - a.bm25_score)
    .slice(0, 60);
  if (!items.length) return [];
  const max = items[0].bm25_score;
  const min = items[items.length - 1].bm25_score;
  const span = Math.max(1e-6, max - min);
  return items.map((v) => {
    // Линейная интерполяция в диапазон 13–34 px
    const t = (v.bm25_score - min) / span;
    const size = 13 + t * 21;
    // hue: 220 (синий) для «доп» → 280 (фиол) → 350 (розово-красный) для топов
    const hue  = 220 + t * 130;
    return {
      lemma: v.lemma,
      size:  size.toFixed(1),
      color: `hsl(${hue.toFixed(0)}, 70%, 65%)`,
      title: `BM25: ${v.bm25_score} · DF: ${v.df} · Median: ${v.median_count}`,
    };
  });
});

// ── Status helpers ───────────────────────────────────────────────────────
function statusBadgeClass(status) {
  switch (status) {
    case 'done':      return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'analyzing': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'fetching':  return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'pending':   return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':     return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:          return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(status) {
  return ({
    done: 'Готово', analyzing: 'Анализ', fetching: 'Сбор данных',
    pending: 'Ожидает', error: 'Ошибка',
  })[status] || status;
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? `${s.toFixed(1)}с` : `${Math.round(s / 60)}м ${Math.round(s % 60)}с`;
}

// ── Export — берём напрямую с бэка через apiBaseURL+токен ────────────────
async function exportFile(kind) {
  try {
    const ext = kind === 'json' ? 'json' : 'csv';
    const res = await api.get(`/relevance/${route.params.id}/export.${ext}`, {
      responseType: 'blob',
    });
    const blob = new Blob([res.data], {
      type: kind === 'json' ? 'application/json' : 'text/csv',
    });
    const safeName = String(report.value?.query || 'report').replace(/[^a-zа-яё0-9_-]+/gi, '_').slice(0, 60);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relevance_${safeName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.response?.data?.error || err.message || 'Ошибка экспорта');
  }
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Шапка -->
      <div class="flex items-start justify-between gap-4 border-b border-gray-800 pb-4">
        <div class="min-w-0">
          <button @click="router.push('/relevance')" class="btn-ghost text-xs mb-2">← К списку</button>
          <h1 class="text-2xl font-bold text-white truncate" :title="report?.query">
            📊 {{ report?.query || 'Загрузка отчёта...' }}
          </h1>
          <div class="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span v-if="report">lr={{ report.lr }}</span>
            <span v-if="report">📅 {{ formatDate(report.created_at) }}</span>
            <span v-if="report?.duration_ms">⏱ {{ formatDuration(report.duration_ms) }}</span>
            <span v-if="report">🔗 {{ report.fetched_count }}/{{ (report.serp || []).length }} страниц</span>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span v-if="report" :class="['badge', statusBadgeClass(report.status)]">
            {{ statusLabel(report.status) }}
            <span v-if="report.current_stage && report.status !== 'done' && report.status !== 'error'"
                  class="ml-1 text-[10px] opacity-80">· {{ report.current_stage }}</span>
          </span>
          <button v-if="report?.status === 'done'" @click="exportFile('json')"
                  class="btn-secondary text-xs">⬇ JSON</button>
          <button v-if="report?.status === 'done'" @click="exportFile('csv')"
                  class="btn-secondary text-xs">⬇ CSV</button>
        </div>
      </div>

      <!-- Loading / Error -->
      <div v-if="initialLoad" class="card text-center py-10 text-gray-500 text-sm">Загрузка...</div>
      <div v-else-if="loadError"
           class="card border-red-800 bg-red-900/20 text-red-300 text-sm">
        ⚠ {{ loadError }}
      </div>

      <!-- В процессе -->
      <div v-else-if="report && report.status !== 'done' && report.status !== 'error'"
           class="card text-center py-10">
        <div class="text-4xl mb-2 animate-pulse">⏳</div>
        <div class="text-gray-300 font-semibold">{{ statusLabel(report.status) }}</div>
        <div class="text-xs text-gray-500 mt-1">{{ report.current_stage || '...' }}</div>
        <div class="text-xs text-gray-600 mt-3">Страница обновляется автоматически.</div>
      </div>

      <!-- Ошибка -->
      <div v-else-if="report?.status === 'error'"
           class="card border-red-800 bg-red-900/20">
        <div class="text-red-300 font-semibold mb-1">⚠ Ошибка обработки</div>
        <div class="text-red-200 text-sm whitespace-pre-wrap">{{ report.error_message || 'Неизвестная ошибка' }}</div>
      </div>

      <!-- ── Готовый отчёт ── -->
      <template v-else-if="report?.status === 'done'">

        <!-- Stats summary -->
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-white">{{ stats.parsed_doc_count || 0 }}<span class="text-gray-500 text-base">/{{ stats.doc_count || 0 }}</span></div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Документов</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-indigo-300">{{ (stats.total_tokens || 0).toLocaleString('ru-RU') }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Токенов</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-sky-300">{{ Math.round(stats.avg_doc_length || 0) }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Сред. длина</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-emerald-300">{{ vocabulary.length }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Лемм в словаре</div>
          </div>
          <div class="card py-3 text-center">
            <div class="text-2xl font-bold text-fuchsia-300">{{ ngrams.length }}</div>
            <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">N-грамм</div>
          </div>
        </div>

        <!-- ── Bar chart: ТОП-20 по частоте ── -->
        <div class="card">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider mb-3">
            📈 ТОП-20 слов по суммарной частоте (DF × медиана)
          </h2>
          <div v-if="topByFrequency.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет данных для построения графика.
          </div>
          <div v-else class="space-y-1.5">
            <div v-for="(item, i) in topByFrequency" :key="item.lemma"
                 class="flex items-center gap-2 text-xs">
              <div class="w-6 text-right text-gray-500">{{ i + 1 }}</div>
              <div class="w-32 truncate text-gray-200" :title="item.lemma">{{ item.lemma }}</div>
              <div class="flex-1 bg-gray-800 rounded h-5 relative overflow-hidden">
                <div class="h-full transition-all"
                     :class="item.status === 'important' ? 'bg-indigo-500' : 'bg-sky-700'"
                     :style="{ width: `${(item.median_count * item.df / barMax * 100).toFixed(1)}%` }"></div>
              </div>
              <div class="w-20 text-right text-gray-400 tabular-nums">
                {{ item.df }} × {{ item.median_count }}
              </div>
              <div class="w-20 text-right text-gray-500 tabular-nums">
                BM25 {{ item.bm25_score.toFixed(2) }}
              </div>
            </div>
          </div>
        </div>

        <!-- ── Word cloud (по BM25) ── -->
        <div class="card">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider mb-3">
            ☁ Облако слов (размер ∝ BM25-весу)
          </h2>
          <div v-if="cloud.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет слов с положительным BM25-весом.
          </div>
          <div v-else
               class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 py-4 px-2 bg-gray-950 rounded">
            <span v-for="w in cloud" :key="w.lemma"
                  :title="w.title"
                  :style="{ fontSize: w.size + 'px', color: w.color, lineHeight: 1.1 }"
                  class="font-semibold cursor-default hover:opacity-100 opacity-90 transition-opacity">
              {{ w.lemma }}
            </span>
          </div>
        </div>

        <!-- ── Таблица 1: LSI словарь (BM25) ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              📑 Словарь LSI (BM25) — {{ vocabFiltered.length }} лемм
            </h2>
            <div class="flex items-center gap-1 text-xs">
              <button class="btn-ghost"
                      :class="vocabFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'important' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'important'">Важное</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'additional' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'additional'">Доп</button>
            </div>
          </div>
          <div v-if="vocabFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет лемм по выбранному фильтру.
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <tr>
                  <th class="text-left py-2 px-2 w-8">#</th>
                  <th class="text-left py-2 px-2">Лемма</th>
                  <th class="text-right py-2 px-2">DF (сайтов)</th>
                  <th class="text-right py-2 px-2">Медиана вх.</th>
                  <th class="text-right py-2 px-2">BM25 score</th>
                  <th class="text-center py-2 px-2">Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(v, i) in vocabFiltered" :key="v.lemma"
                    class="border-b border-gray-900 hover:bg-gray-900/50">
                  <td class="py-1.5 px-2 text-gray-500">{{ i + 1 }}</td>
                  <td class="py-1.5 px-2 text-gray-100 font-medium">{{ v.lemma }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.df }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.median_count }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.bm25_score.toFixed(4) }}</td>
                  <td class="py-1.5 px-2 text-center">
                    <span v-if="v.status === 'important'"
                          class="inline-block px-2 py-0.5 rounded text-[10px] bg-indigo-900/50 text-indigo-300 border border-indigo-800">
                      Важное
                    </span>
                    <span v-else class="inline-block px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 border border-gray-700">
                      Доп
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── Таблица 2: N-граммы ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              🔗 N-граммы — {{ ngramsFiltered.length }} фраз
            </h2>
            <div class="flex items-center gap-1 text-xs">
              <button class="btn-ghost"
                      :class="ngramFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'bigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'bigram'">Биграммы</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'trigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'trigram'">Триграммы</button>
            </div>
          </div>
          <div v-if="ngramsFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет n-грамм по выбранному фильтру (минимум 3 сайта).
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <tr>
                  <th class="text-left py-2 px-2 w-8">#</th>
                  <th class="text-left py-2 px-2">Фраза</th>
                  <th class="text-right py-2 px-2">DF (сайтов)</th>
                  <th class="text-right py-2 px-2">Медиана вх.</th>
                  <th class="text-center py-2 px-2">Тип</th>
                  <th class="text-center py-2 px-2">POS</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(n, i) in ngramsFiltered" :key="n.phrase + ':' + n.type"
                    class="border-b border-gray-900 hover:bg-gray-900/50">
                  <td class="py-1.5 px-2 text-gray-500">{{ i + 1 }}</td>
                  <td class="py-1.5 px-2 text-gray-100 font-medium">{{ n.phrase }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.df }}</td>
                  <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.median_count }}</td>
                  <td class="py-1.5 px-2 text-center">
                    <span :class="n.type === 'bigram' ? 'text-sky-300' : 'text-fuchsia-300'"
                          class="text-[10px] uppercase">
                      {{ n.type === 'bigram' ? 'Би' : 'Три' }}
                    </span>
                  </td>
                  <td class="py-1.5 px-2 text-center text-gray-500 text-[10px]">{{ n.pos_pattern }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ── SERP список ── -->
        <details class="card">
          <summary class="cursor-pointer text-sm font-bold text-gray-300 uppercase tracking-wider">
            🔗 ТОП-20 Яндекса ({{ (report.serp || []).length }} URL)
            <span v-if="(report.failed_urls || []).length > 0"
                  class="ml-2 text-amber-400 text-xs normal-case">
              · не открылось: {{ report.failed_urls.length }}
            </span>
          </summary>
          <ol class="mt-3 space-y-1.5 text-xs">
            <li v-for="(s, i) in (report.serp || [])" :key="s.url" class="flex gap-2">
              <span class="w-6 text-gray-500 text-right flex-shrink-0">{{ i + 1 }}.</span>
              <div class="min-w-0">
                <a :href="s.url" target="_blank" rel="noopener noreferrer"
                   class="text-sky-300 hover:underline break-all">{{ s.url }}</a>
                <div v-if="s.title" class="text-gray-400 truncate">{{ s.title }}</div>
              </div>
            </li>
          </ol>
          <div v-if="(report.failed_urls || []).length > 0" class="mt-4 pt-3 border-t border-gray-800">
            <div class="text-amber-400 text-xs uppercase tracking-wider mb-2">⚠ Не удалось загрузить:</div>
            <ul class="text-xs space-y-1">
              <li v-for="f in report.failed_urls" :key="f.url" class="text-gray-400">
                <span class="text-gray-500">{{ f.url }}</span> — <span class="text-amber-400">{{ f.error }}</span>
              </li>
            </ul>
          </div>
        </details>
      </template>
    </div>
  </AppLayout>
</template>
