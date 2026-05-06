<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import api from '../api.js';
import AppLayout from '../components/AppLayout.vue';
import { useRelevanceStore } from '../stores/relevance.js';
import { findRegionByCode } from '../data/yandexRegions.js';

const route   = useRoute();
const router  = useRouter();
const store   = useRelevanceStore();

const report      = ref(null);
const loadError   = ref(null);
const initialLoad = ref(true);
let pollTimer    = null;

// ── Filters / paging для таблиц ──────────────────────────────────────────
const vocabFilter = ref('all'); // 'all' | 'important' | 'additional'
const ngramFilter = ref('all'); // 'all' | 'bigram' | 'trigram' | '4gram'

// Пагинация для больших таблиц — заказчик: «не должно быть полотном,
// каждый раздел сделать по страницам». Размер страницы общий, дефолт 50.
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const vocabPage     = ref(1);
const vocabPageSize = ref(50);
const ngramPage     = ref(1);
const ngramPageSize = ref(50);
const gapPage       = ref(1);
const gapPageSize   = ref(50);

// Сортировка таблицы LSI (важно: TF-IDF теперь тоже доступен).
const vocabSort = ref('bm25_score'); // 'bm25_score' | 'tf_idf_score' | 'df' | 'median_count' | 'lemma'

// ── Cocoons (PR 2) ────────────────────────────────────────────────────────
const cocoonsBuilding = ref(false);
const cocoonsError    = ref(null);
const cocoonsOpts     = ref({ n_topics: 8, top_terms: 12, top_documents: 5 });

async function buildCocoons() {
  if (!report.value || cocoonsBuilding.value) return;
  cocoonsBuilding.value = true;
  cocoonsError.value = null;
  try {
    await store.buildCocoons(report.value.id, cocoonsOpts.value);
    await reload();
  } catch (err) {
    cocoonsError.value = err.response?.data?.error || err.message || 'Не удалось построить коконы';
  } finally {
    cocoonsBuilding.value = false;
  }
}

async function deleteRawCache() {
  if (!report.value) return;
  if (!confirm('Удалить кэш сырых документов? После этого пересчитать коконы можно будет только создав новый отчёт.')) return;
  try {
    await store.deleteRaw(report.value.id);
    await reload();
  } catch (err) {
    alert(err.response?.data?.error || err.message || 'Не удалось удалить кэш');
  }
}

const cocoons = computed(() => report.value?.cocoons || null);
const cocoonsTopics = computed(() => {
  const list = cocoons.value?.topics;
  return Array.isArray(list) ? list : [];
});

// Размер «чипа» леммы пропорционален |weight| относительно максимума в теме.
function chipStyle(term, topic) {
  const maxW = Math.max(...topic.terms.map((t) => Math.abs(t.weight)), 1e-6);
  const t = Math.abs(term.weight) / maxW;
  const size = 11 + t * 7; // 11–18 px
  if (term.weight < 0) {
    // Антитема — серым outline, чтобы копирайтер видел «что НЕ употреблять».
    return {
      fontSize: size + 'px',
      color:    '#9ca3af',
      borderColor: '#374151',
      background:  'transparent',
    };
  }
  // hue: 220 → 280 (синий → фиол) пропорционально весу.
  const hue = 220 + t * 60;
  return {
    fontSize: size + 'px',
    color:    `hsl(${hue.toFixed(0)}, 80%, 75%)`,
    borderColor: `hsl(${hue.toFixed(0)}, 60%, 35%)`,
    background:  `hsl(${hue.toFixed(0)}, 50%, 18%)`,
  };
}

function formatRawTtl(report) {
  if (!report?.raw_expires_at) return null;
  const ms = new Date(report.raw_expires_at).getTime() - Date.now();
  if (ms <= 0) return { expired: true, label: 'кэш истёк' };
  const days  = Math.floor(ms / (24 * 3600 * 1000));
  const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  const label = days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
  return { expired: false, label };
}

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

// PR3: comparison «наш сайт vs ТОП». Все computed безопасны — возвращают
// null/[] на старых отчётах (поле comparison NULL).
const comparison      = computed(() => report.value?.comparison || null);
const ourReport       = computed(() => report.value?.our_report || null);
const docDiagnostics  = computed(() => {
  const list = report.value?.report?.document_diagnostics;
  return Array.isArray(list) ? list : [];
});
const failBreakdown   = computed(() => report.value?.report?.fail_breakdown || {});
const filterInfo      = computed(() => report.value?.report?.filter || null);

// Сводка причин fail'а — для бейджиков «5×http_403, 3×timeout, 2×SPA».
const failBreakdownEntries = computed(() => {
  const obj = failBreakdown.value || {};
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
});

// Цветовое кодирование per-term статуса.
function statusColor(s) {
  switch (s) {
    case 'missing': return 'bg-red-900/40 text-red-300 border border-red-800/60';
    case 'under':   return 'bg-orange-900/40 text-orange-300 border border-orange-800/60';
    case 'ok':      return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'over':    return 'bg-sky-900/40 text-sky-300 border border-sky-800/60';
    default:        return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}

// Сводная табличка ТОП + наш сайт. Сортировка по выбранной колонке.
// Заказчик: «наш сайт тоже должен участвовать в рейтинге по конкурентам» —
// поэтому не закрепляем нашу строку сверху, она сортируется наравне
// со всеми (визуально подсвечивается ★ + цветной фон + столбец «#» с рангом).
const compTableSort = ref({ key: 'lsi_coverage_pct', dir: 'desc' });
function setCompSort(key) {
  if (compTableSort.value.key === key) {
    compTableSort.value.dir = compTableSort.value.dir === 'desc' ? 'asc' : 'desc';
  } else {
    compTableSort.value = { key, dir: 'desc' };
  }
}
const compTable = computed(() => {
  const rows = comparison.value?.competitor_table || [];
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const { key, dir } = compTableSort.value;
  // Стабильная сортировка с понятным поведением для null serp_position
  // (страницы вне ТОПа уезжают в конец при сортировке по позиции).
  const sorted = [...rows].sort((a, b) => {
    if (key === 'url') {
      const av = String(a.url || '');
      const bv = String(b.url || '');
      return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
    }
    if (key === 'serp_position') {
      const av = a.serp_position == null ? Infinity : Number(a.serp_position);
      const bv = b.serp_position == null ? Infinity : Number(b.serp_position);
      return dir === 'desc' ? bv - av : av - bv;
    }
    const av = Number(a[key] || 0);
    const bv = Number(b[key] || 0);
    return dir === 'desc' ? bv - av : av - bv;
  });
  return sorted;
});

// Фильтр для секции gap (по умолчанию показываем только важные missing/under/over).
const gapFilter = ref('actionable');  // all / actionable / missing / under / over / ok
const gapVisible = computed(() => {
  const arr = comparison.value?.per_term || [];
  if (!Array.isArray(arr)) return [];
  let out = arr;
  if (gapFilter.value === 'actionable') {
    out = arr.filter((t) => t.status !== 'ok');
  } else if (gapFilter.value !== 'all') {
    out = arr.filter((t) => t.status === gapFilter.value);
  }
  // Сортировка: важные → сначала, потом по убыванию BM25.
  return [...out].sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    return (Number(b.bm25_score) || 0) - (Number(a.bm25_score) || 0);
  }).slice(0, 500);  // защита от гигантских таблиц
});

const vocabFiltered = computed(() => {
  let arr = vocabFilter.value === 'all'
    ? vocabulary.value
    : vocabulary.value.filter((v) => v.status === vocabFilter.value);
  const key = vocabSort.value;
  arr = [...arr].sort((a, b) => {
    if (key === 'lemma') return String(a.lemma).localeCompare(String(b.lemma), 'ru');
    return (Number(b[key]) || 0) - (Number(a[key]) || 0);
  });
  return arr;
});
const ngramsFiltered = computed(() => {
  if (ngramFilter.value === 'all') return ngrams.value;
  return ngrams.value.filter((n) => n.type === ngramFilter.value);
});

// ── Пагинация ─────────────────────────────────────────────────────────────
// При смене фильтра/сортировки сбрасываем страницу на 1 — иначе можно
// попасть на «пустую» страницу.
watch([vocabFilter, vocabSort, vocabPageSize], () => { vocabPage.value = 1; });
watch([ngramFilter, ngramPageSize],            () => { ngramPage.value = 1; });
watch([gapFilter,   gapPageSize],              () => { gapPage.value   = 1; });

function pageCount(total, size) {
  return Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, Number(size) || 1)));
}
function clampPage(page, total, size) {
  const max = pageCount(total, size);
  const p = Math.min(Math.max(1, Number(page) || 1), max);
  return p;
}
function paginate(arr, page, size) {
  const list = Array.isArray(arr) ? arr : [];
  const sz   = Math.max(1, Number(size) || 1);
  const p    = clampPage(page, list.length, sz);
  const start = (p - 1) * sz;
  return list.slice(start, start + sz);
}

const vocabPaged       = computed(() => paginate(vocabFiltered.value, vocabPage.value, vocabPageSize.value));
const vocabPageCount   = computed(() => pageCount(vocabFiltered.value.length, vocabPageSize.value));
const vocabPageStart   = computed(() => vocabFiltered.value.length === 0 ? 0 : (clampPage(vocabPage.value, vocabFiltered.value.length, vocabPageSize.value) - 1) * vocabPageSize.value);

const ngramsPaged      = computed(() => paginate(ngramsFiltered.value, ngramPage.value, ngramPageSize.value));
const ngramsPageCount  = computed(() => pageCount(ngramsFiltered.value.length, ngramPageSize.value));
const ngramsPageStart  = computed(() => ngramsFiltered.value.length === 0 ? 0 : (clampPage(ngramPage.value, ngramsFiltered.value.length, ngramPageSize.value) - 1) * ngramPageSize.value);

const gapPaged         = computed(() => paginate(gapVisible.value, gapPage.value, gapPageSize.value));
const gapPageCount     = computed(() => pageCount(gapVisible.value.length, gapPageSize.value));
const gapPageStart     = computed(() => gapVisible.value.length === 0 ? 0 : (clampPage(gapPage.value, gapVisible.value.length, gapPageSize.value) - 1) * gapPageSize.value);

function gotoPage(target, total, size, setter) {
  setter(clampPage(target, total, size));
}

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

// Подпись региона: вместо «lr=213» показываем «Москва (lr=213)».
function regionLabel(lr) {
  const r = findRegionByCode(lr);
  return r ? `${r.name} (lr=${r.code})` : `lr=${lr}`;
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

// ── Copy helpers ─────────────────────────────────────────────────────────
const copyHint = ref('');     // временный feedback, что скопировано
let copyHintTimer = null;

async function copyToClipboard(text, label) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback для старых браузеров / небезопасных origin'ов
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copyHint.value = `✓ Скопировано: ${label}`;
  } catch (err) {
    copyHint.value = `⚠ Не удалось скопировать: ${err.message || ''}`;
  }
  if (copyHintTimer) clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => { copyHint.value = ''; }, 2500);
}

function copyImportantLsi() {
  const items = vocabulary.value.filter((v) => v.status === 'important').map((v) => v.lemma);
  copyToClipboard(items.join(', '), `важные LSI (${items.length})`);
}
function copyAllLsi() {
  const items = vocabulary.value.map((v) => v.lemma);
  copyToClipboard(items.join(', '), `все LSI (${items.length})`);
}
function copyImportantNgrams() {
  // «Важные» n-граммы — те, что встречаются у максимума сайтов (топ по df).
  // Если в выдаче есть фразы с df ≥ 3, считаем их важными; иначе берём top-30.
  const ng = ngrams.value;
  const important = ng.filter((n) => n.df >= 3);
  const list = important.length >= 5
    ? important
    : [...ng].sort((a, b) => b.df - a.df).slice(0, 30);
  const text = list.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `важные n-граммы (${list.length})`);
}
function copyAllNgrams() {
  const text = ngrams.value.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `все n-граммы (${ngrams.value.length})`);
}
function copyFilteredVocab() {
  const text = vocabFiltered.value.map((v) => v.lemma).join(', ');
  copyToClipboard(text, `видимые LSI (${vocabFiltered.value.length})`);
}
function copyFilteredNgrams() {
  const text = ngramsFiltered.value.map((n) => n.phrase).join('\n');
  copyToClipboard(text, `видимые n-граммы (${ngramsFiltered.value.length})`);
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Toast: feedback от кнопок «Скопировать» -->
      <Transition name="fade">
        <div v-if="copyHint"
             class="fixed bottom-6 right-6 z-50 px-4 py-2 rounded-lg shadow-lg
                    bg-emerald-900/90 text-emerald-100 border border-emerald-700 text-sm">
          {{ copyHint }}
        </div>
      </Transition>

      <!-- Шапка -->
      <div class="flex items-start justify-between gap-4 border-b border-gray-800 pb-4">
        <div class="min-w-0">
          <button @click="router.push('/relevance')" class="btn-ghost text-xs mb-2">← К списку</button>
          <h1 class="text-2xl font-bold text-white truncate" :title="report?.query">
            📊 {{ report?.query || 'Загрузка отчёта...' }}
          </h1>
          <div class="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span v-if="report">📍 {{ regionLabel(report.lr) }}</span>
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

        <!-- ── PR3: Сравнение «наш сайт vs ТОП» ── -->
        <div v-if="comparison && !comparison.error" class="card border-indigo-700/50">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-2">
              ⚖ Сравнение: ваш сайт vs ТОП конкурентов
            </h2>
            <a v-if="ourReport?.url" :href="ourReport.url" target="_blank" rel="noopener"
               class="text-xs text-indigo-300 hover:text-indigo-200 underline truncate max-w-[400px]">
              {{ ourReport.url }}
            </a>
          </div>

          <!-- Сводка: 4 числа + подсказки -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-emerald-300">
                {{ (comparison.summary?.lsi_coverage_pct ?? 0).toFixed(1) }}%
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">LSI-покрытие</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                {{ comparison.summary?.important_lemmas_hit || 0 }} из
                {{ comparison.summary?.important_lemmas_total || 0 }} важных
              </div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-sky-300">
                {{ (comparison.summary?.bm25_score ?? 0).toFixed(2) }}
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">BM25 vs ТОП</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                норм. {{ ((comparison.summary?.bm25_score_norm ?? 0) * 100).toFixed(0) }}%
              </div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-fuchsia-300">
                {{ (comparison.summary?.tf_idf_cosine ?? 0).toFixed(3) }}
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">TF-IDF cosine</div>
              <div class="text-[10px] text-gray-600 mt-0.5">с медианой ТОПа</div>
            </div>
            <div class="rounded bg-gray-950 border border-gray-800 p-3 text-center">
              <div class="text-2xl font-bold text-amber-300">
                {{ ((comparison.summary?.our_text_html_ratio ?? 0) * 100).toFixed(1) }}%
              </div>
              <div class="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Text/HTML ratio</div>
              <div class="text-[10px] text-gray-600 mt-0.5">
                ТОП медиана:
                {{ ((comparison.summary?.median_text_html_ratio_top ?? 0) * 100).toFixed(1) }}%
              </div>
            </div>
          </div>

          <!-- Сводная таблица «ТОП-N + наш сайт» с сортировкой -->
          <div v-if="compTable.length > 0" class="mb-5">
            <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
              📊 Сравнительная таблица
              <span class="text-[10px] text-gray-500 font-normal normal-case ml-1">
                (наш сайт — ★, участвует в рейтинге наравне с конкурентами)
              </span>
            </h3>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                  <tr>
                    <th class="text-right py-2 px-2 w-8">#</th>
                    <th class="text-left py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('url')">URL</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('serp_position')" title="Позиция в выдаче Яндекса">Поз.</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('lsi_coverage_pct')">LSI %</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('bm25_score')">BM25</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('tf_idf_cosine')">TF-IDF cos</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('text_chars')" title="Длина основного текста (символы)">Симв.</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('word_count')" title="Сырое число словоформ (без учёта лемматизации)">Слов</th>
                    <th class="text-right py-2 px-2 cursor-pointer hover:text-indigo-300"
                        @click="setCompSort('tokens')" title="Лемм после нормализации (BM25-токены)">Лемм</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in compTable" :key="row.url + ':' + i"
                      :class="row.is_ours
                        ? 'bg-indigo-900/30 border-b border-indigo-800/50'
                        : 'border-b border-gray-800/60 hover:bg-gray-900/40'">
                    <td class="text-right py-1.5 px-2 text-gray-500 tabular-nums font-bold">{{ i + 1 }}</td>
                    <td class="py-1.5 px-2">
                      <span v-if="row.is_ours" class="text-indigo-300 font-bold mr-1">★ ВЫ:</span>
                      <a :href="row.url" target="_blank" rel="noopener"
                         class="text-gray-200 hover:text-indigo-300 truncate inline-block max-w-[360px] align-middle"
                         :title="row.url">{{ row.url }}</a>
                    </td>
                    <td class="text-right py-1.5 px-2 tabular-nums"
                        :class="row.serp_position == null ? 'text-gray-600' : 'text-amber-300'">
                      <span v-if="row.serp_position != null">#{{ row.serp_position }}</span>
                      <span v-else title="URL не найден в ТОП-выдаче Яндекса">—</span>
                    </td>
                    <td class="text-right py-1.5 px-2 text-emerald-300 tabular-nums">
                      {{ (row.lsi_coverage_pct ?? 0).toFixed(1) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-sky-300 tabular-nums">
                      {{ (row.bm25_score ?? 0).toFixed(2) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-fuchsia-300 tabular-nums">
                      {{ (row.tf_idf_cosine ?? 0).toFixed(3) }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-300 tabular-nums">
                      {{ (row.text_chars || 0).toLocaleString('ru-RU') }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-300 tabular-nums">
                      {{ (row.word_count || 0).toLocaleString('ru-RU') }}
                    </td>
                    <td class="text-right py-1.5 px-2 text-gray-400 tabular-nums">
                      {{ row.tokens || 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="text-[10px] text-gray-600 mt-2 leading-relaxed">
              «Симв.» — длина основного текста, «Слов» — сырое число словоформ
              (с латиницей и цифрами), «Лемм» — нормализованные токены, идущие
              в BM25 (короткие слова, стоп-слова и не-кириллица отфильтрованы).
            </div>
          </div>

          <!-- Математические директивы для копирайтера -->
          <div v-if="(comparison.directives || []).length > 0" class="mb-5">
            <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
              ✍ Что делать (математические директивы)
            </h3>
            <ol class="space-y-1 text-xs">
              <li v-for="(d, i) in comparison.directives.slice(0, 50)" :key="d.lemma + ':' + i"
                  class="flex items-start gap-2 py-1 px-2 rounded hover:bg-gray-900/40">
                <span class="text-gray-500 tabular-nums w-6 flex-shrink-0 text-right">{{ i + 1 }}.</span>
                <span :class="['badge text-[10px] px-1.5 py-0', statusColor(d.status)]">{{ d.status }}</span>
                <span v-if="d.important" class="text-[10px] text-indigo-300" title="Important LSI-key">★</span>
                <span class="text-gray-200">{{ d.text }}</span>
              </li>
            </ol>
            <div v-if="comparison.directives.length > 50" class="text-[11px] text-gray-500 mt-2">
              … и ещё {{ comparison.directives.length - 50 }} директив (см. подсветку слов ниже).
            </div>
          </div>

          <!-- Подсветка слов: per-term gap-таблица -->
          <div v-if="(comparison.per_term || []).length > 0">
            <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider">
                🎨 Подсветка слов (per-term gap) — {{ gapVisible.length }}
              </h3>
              <div class="flex items-center gap-1 text-[11px] flex-wrap">
                <button v-for="opt in ['actionable','all','missing','under','ok','over']" :key="opt"
                        class="btn-ghost"
                        :class="gapFilter === opt ? 'text-indigo-300' : 'text-gray-500'"
                        @click="gapFilter = opt">{{ opt }}</button>
              </div>
            </div>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2">Лемма</th>
                    <th class="text-center py-2 px-2">Статус</th>
                    <th class="text-right py-2 px-2">У вас</th>
                    <th class="text-right py-2 px-2">Медиана ТОПа</th>
                    <th class="text-right py-2 px-2">DF</th>
                    <th class="text-right py-2 px-2">BM25</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in gapPaged" :key="t.lemma"
                      class="border-b border-gray-800/40 hover:bg-gray-900/30">
                    <td class="py-1 px-2 text-gray-200">
                      <span v-if="t.important" class="text-indigo-300 mr-0.5" title="Important LSI">★</span>
                      {{ t.lemma }}
                    </td>
                    <td class="text-center py-1 px-2">
                      <span :class="['badge text-[10px] px-1.5 py-0', statusColor(t.status)]">{{ t.status }}</span>
                    </td>
                    <td class="text-right py-1 px-2 text-gray-300 tabular-nums">{{ t.our_count }}</td>
                    <td class="text-right py-1 px-2 text-gray-400 tabular-nums">{{ t.median_top }}</td>
                    <td class="text-right py-1 px-2 text-gray-500 tabular-nums">{{ t.df }}</td>
                    <td class="text-right py-1 px-2 text-sky-300 tabular-nums">{{ (t.bm25_score || 0).toFixed(2) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="gapVisible.length === 0" class="text-gray-500 text-sm py-4 text-center">
                Нет лемм по выбранному фильтру.
              </div>
            </div>
            <!-- Pager -->
            <div v-if="gapVisible.length > 0" class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ gapPageStart + 1 }}–{{ Math.min(gapPageStart + gapPageSize, gapVisible.length) }}
                из <span class="text-gray-300">{{ gapVisible.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="gapPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="gapPage <= 1"
                        @click="gotoPage(gapPage - 1, gapVisible.length, gapPageSize, (v) => gapPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="gapPageCount"
                         :value="Math.min(gapPage, gapPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), gapVisible.length, gapPageSize, (v) => gapPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ gapPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="gapPage >= gapPageCount"
                        @click="gotoPage(gapPage + 1, gapVisible.length, gapPageSize, (v) => gapPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Если comparison был запрошен, но упал — показываем мягкую ошибку -->
        <div v-else-if="comparison && comparison.error" class="card border-amber-800/60 bg-amber-900/10">
          <h2 class="text-base font-bold text-amber-300 uppercase tracking-wider mb-2">
            ⚠ Сравнение «ваш сайт vs ТОП» не выполнилось
          </h2>
          <div class="text-amber-200 text-sm">{{ comparison.error }}</div>
          <div class="text-[11px] text-amber-300/70 mt-2">
            Отчёт ТОПа сохранён полностью — это «мягкая» ошибка только нашего URL.
            Попробуйте проверить, открывается ли страница в браузере без авторизации
            и не блокирует ли её WAF (Cloudflare/Qrator) для серверных запросов.
          </div>
        </div>

        <!-- Сводка причин fail'а — оператор сразу видит, где WAF/SPA/DNS -->
        <div v-if="failBreakdownEntries.length > 0" class="card">
          <h3 class="text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
            📉 Причины недоступности страниц ТОПа
          </h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="[code, count] in failBreakdownEntries" :key="code"
                  class="text-xs px-2 py-1 rounded bg-gray-950 border border-gray-800">
              <span class="text-gray-400 font-mono">{{ code }}</span>
              <span class="text-amber-300 font-bold ml-1">×{{ count }}</span>
            </span>
          </div>
          <div v-if="filterInfo?.removed_aggregators?.length"
               class="text-[11px] text-gray-500 mt-3">
            Также отфильтровано как агрегаторы:
            <span class="text-gray-400">{{ filterInfo.removed_aggregators.length }}</span>
            (<span class="font-mono">{{ filterInfo.removed_aggregators.slice(0,5).map(r => r.host).join(', ') }}{{ filterInfo.removed_aggregators.length > 5 ? '…' : '' }}</span>)
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

        <!-- ── Таблица 1: LSI словарь (BM25 + TF-IDF) ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              📑 Словарь LSI (BM25 + TF-IDF) — {{ vocabFiltered.length }} лемм
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost"
                      :class="vocabFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'important' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'important'">Важное</button>
              <button class="btn-ghost"
                      :class="vocabFilter === 'additional' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="vocabFilter = 'additional'">Доп</button>
              <span class="mx-1 text-gray-700">·</span>
              <span class="text-gray-500">сорт:</span>
              <select v-model="vocabSort"
                      class="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200">
                <option value="bm25_score">BM25</option>
                <option value="tf_idf_score">TF-IDF</option>
                <option value="df">DF</option>
                <option value="median_count">Медиана</option>
                <option value="lemma">Алфавит</option>
              </select>
              <span class="mx-1 text-gray-700">·</span>
              <button class="btn-ghost text-emerald-300"
                      @click="copyImportantLsi" title="Скопировать только важные леммы">
                📋 Важные
              </button>
              <button class="btn-ghost text-sky-300"
                      @click="copyFilteredVocab" title="Скопировать видимые в таблице">
                📋 Видимые
              </button>
              <button class="btn-ghost text-gray-400"
                      @click="copyAllLsi" title="Скопировать все леммы">
                📋 Все
              </button>
            </div>
          </div>
          <div v-if="vocabFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет лемм по выбранному фильтру.
          </div>
          <div v-else>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2 w-10">#</th>
                    <th class="text-left py-2 px-2">Лемма</th>
                    <th class="text-right py-2 px-2">DF (сайтов)</th>
                    <th class="text-right py-2 px-2">Медиана вх.</th>
                    <th class="text-right py-2 px-2">BM25 score</th>
                    <th class="text-right py-2 px-2">TF-IDF</th>
                    <th class="text-center py-2 px-2">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(v, i) in vocabPaged" :key="v.lemma"
                      class="border-b border-gray-900 hover:bg-gray-900/50">
                    <td class="py-1.5 px-2 text-gray-500 tabular-nums">{{ vocabPageStart + i + 1 }}</td>
                    <td class="py-1.5 px-2 text-gray-100 font-medium">{{ v.lemma }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.df }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ v.median_count }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(v.bm25_score || 0).toFixed(4) }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ Number(v.tf_idf_score || 0).toFixed(4) }}</td>
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
            <!-- Pager: LSI -->
            <div class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ vocabPageStart + 1 }}–{{ Math.min(vocabPageStart + vocabPageSize, vocabFiltered.length) }}
                из <span class="text-gray-300">{{ vocabFiltered.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="vocabPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="vocabPage <= 1"
                        @click="gotoPage(vocabPage - 1, vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="vocabPageCount"
                         :value="Math.min(vocabPage, vocabPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ vocabPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="vocabPage >= vocabPageCount"
                        @click="gotoPage(vocabPage + 1, vocabFiltered.length, vocabPageSize, (v) => vocabPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Таблица 2: N-граммы ── -->
        <div class="card">
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">
              🔗 N-граммы — {{ ngramsFiltered.length }} фраз
            </h2>
            <div class="flex items-center gap-1 text-xs flex-wrap">
              <button class="btn-ghost"
                      :class="ngramFilter === 'all' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'all'">Все</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'bigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'bigram'">Биграммы</button>
              <button class="btn-ghost"
                      :class="ngramFilter === 'trigram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = 'trigram'">Триграммы</button>
              <button class="btn-ghost"
                      :class="ngramFilter === '4gram' ? 'text-indigo-300' : 'text-gray-500'"
                      @click="ngramFilter = '4gram'">4-граммы</button>
              <span class="mx-1 text-gray-700">·</span>
              <button class="btn-ghost text-emerald-300"
                      @click="copyImportantNgrams" title="Скопировать наиболее частые n-граммы">
                📋 Важные
              </button>
              <button class="btn-ghost text-sky-300"
                      @click="copyFilteredNgrams" title="Скопировать видимые в таблице">
                📋 Видимые
              </button>
              <button class="btn-ghost text-gray-400"
                      @click="copyAllNgrams" title="Скопировать все n-граммы">
                📋 Все
              </button>
            </div>
          </div>
          <div v-if="ngramsFiltered.length === 0" class="text-gray-500 text-sm py-4 text-center">
            Нет n-грамм по выбранному фильтру.
          </div>
          <div v-else>
            <div class="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
                  <tr>
                    <th class="text-left py-2 px-2 w-10">#</th>
                    <th class="text-left py-2 px-2">Фраза</th>
                    <th class="text-right py-2 px-2">DF (сайтов)</th>
                    <th class="text-right py-2 px-2">Медиана вх.</th>
                    <th class="text-center py-2 px-2">Тип</th>
                    <th class="text-center py-2 px-2">POS</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(n, i) in ngramsPaged" :key="n.phrase + ':' + n.type"
                      class="border-b border-gray-900 hover:bg-gray-900/50">
                    <td class="py-1.5 px-2 text-gray-500 tabular-nums">{{ ngramsPageStart + i + 1 }}</td>
                    <td class="py-1.5 px-2 text-gray-100 font-medium">{{ n.phrase }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.df }}</td>
                    <td class="py-1.5 px-2 text-right text-gray-300 tabular-nums">{{ n.median_count }}</td>
                    <td class="py-1.5 px-2 text-center">
                      <span :class="{
                              'text-sky-300':    n.type === 'bigram',
                              'text-fuchsia-300':n.type === 'trigram',
                              'text-amber-300':  n.type === '4gram',
                            }"
                            class="text-[10px] uppercase">
                        {{ n.type === 'bigram' ? 'Би' : (n.type === 'trigram' ? 'Три' : '4-гр') }}
                      </span>
                    </td>
                    <td class="py-1.5 px-2 text-center text-gray-500 text-[10px]">{{ n.pos_pattern }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- Pager: N-grams -->
            <div class="flex items-center justify-between mt-2 text-[11px] text-gray-400 flex-wrap gap-2">
              <div>
                {{ ngramsPageStart + 1 }}–{{ Math.min(ngramsPageStart + ngramPageSize, ngramsFiltered.length) }}
                из <span class="text-gray-300">{{ ngramsFiltered.length }}</span>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-gray-500">На странице:
                  <select v-model.number="ngramPageSize"
                          class="ml-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                    <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
                  </select>
                </label>
                <button class="btn-ghost px-2" :disabled="ngramPage <= 1"
                        @click="gotoPage(ngramPage - 1, ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)">←</button>
                <span class="tabular-nums">
                  стр.
                  <input type="number" min="1" :max="ngramsPageCount"
                         :value="Math.min(ngramPage, ngramsPageCount)"
                         @change="(e) => gotoPage(Number(e.target.value), ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)"
                         class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-200 text-center" />
                  / {{ ngramsPageCount }}
                </span>
                <button class="btn-ghost px-2" :disabled="ngramPage >= ngramsPageCount"
                        @click="gotoPage(ngramPage + 1, ngramsFiltered.length, ngramPageSize, (v) => ngramPage = v)">→</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Семантические коконы (PR 2) ── -->
        <div class="card">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 class="text-lg font-bold text-purple-300">🧬 Семантические коконы</h2>
              <p class="text-xs text-gray-400 mt-1">
                Группировка лемм по латентным темам ниши (Truncated SVD / LSI).
                Положительные веса — «о теме», отрицательные (серым) — антитема,
                которую копирайтеру стоит избегать в этом разделе.
              </p>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <span v-if="report.has_raw" class="badge bg-emerald-900/40 text-emerald-300 border border-emerald-800">
                📦 raw-кэш активен
                <span v-if="formatRawTtl(report)" class="ml-1 text-emerald-400/70">
                  · ещё {{ formatRawTtl(report).label }}
                </span>
              </span>
              <span v-else class="badge bg-gray-800 text-gray-400 border border-gray-700">
                🧊 raw-кэш истёк
              </span>
              <button v-if="report.has_raw" @click="deleteRawCache"
                      class="text-xs text-rose-400 hover:text-rose-300 underline">
                удалить кэш
              </button>
            </div>
          </div>

          <div v-if="report.has_raw" class="mt-3 flex items-center gap-2 flex-wrap">
            <label class="text-xs text-gray-400">Тем:
              <input type="number" v-model.number="cocoonsOpts.n_topics" min="2" max="32"
                     class="ml-1 w-16 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs" />
            </label>
            <label class="text-xs text-gray-400">Лемм/тему:
              <input type="number" v-model.number="cocoonsOpts.top_terms" min="3" max="50"
                     class="ml-1 w-16 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs" />
            </label>
            <button @click="buildCocoons"
                    :disabled="cocoonsBuilding"
                    class="btn-primary text-xs disabled:opacity-50">
              {{ cocoonsBuilding ? 'Строим…' : (cocoons ? 'Пересчитать коконы' : 'Построить коконы') }}
            </button>
          </div>

          <div v-if="cocoonsError" class="mt-2 text-rose-400 text-xs">{{ cocoonsError }}</div>

          <div v-if="cocoonsTopics.length > 0" class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div v-for="t in cocoonsTopics" :key="t.id"
                 class="bg-gray-900/60 border border-gray-800 rounded-lg p-3">
              <div class="flex items-baseline justify-between gap-2 mb-2">
                <div class="text-purple-300 font-semibold truncate" :title="t.label">
                  #{{ t.id + 1 }} · {{ t.label }}
                </div>
                <div class="text-[10px] text-gray-500 flex-shrink-0">
                  {{ (t.explained_variance * 100).toFixed(1) }}%
                </div>
              </div>
              <div class="flex flex-wrap gap-1.5 mb-2">
                <span v-for="term in t.terms" :key="term.lemma"
                      class="px-1.5 py-0.5 rounded border leading-tight"
                      :style="chipStyle(term, t)"
                      :title="`weight: ${term.weight}`">
                  {{ term.lemma }}
                </span>
              </div>
              <details v-if="t.top_documents?.length" class="text-[11px] text-gray-400 mt-1">
                <summary class="cursor-pointer hover:text-gray-200">
                  топ-документы ({{ t.top_documents.length }})
                </summary>
                <ul class="mt-1.5 space-y-0.5">
                  <li v-for="d in t.top_documents" :key="d.url" class="truncate">
                    <a :href="d.url" target="_blank" rel="noopener noreferrer"
                       class="text-sky-400 hover:underline break-all">{{ d.url }}</a>
                    <span class="text-gray-600 ml-1">{{ d.score.toFixed(3) }}</span>
                  </li>
                </ul>
              </details>
            </div>
          </div>
          <div v-else-if="cocoons" class="mt-3 text-xs text-amber-400">
            ⚠ SVD не нашёл тем (вероятно, слишком мало уникальных лемм или
            однообразный корпус — попробуйте увеличить диапазон ТОП SERP).
          </div>
          <div v-else-if="!report.has_raw" class="mt-3 text-xs text-gray-500">
            Для расчёта коконов нужны processed-документы из Redis-кэша.
            После истечения TTL (7 дней по умолчанию) пересчёт невозможен —
            создайте новый отчёт.
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
