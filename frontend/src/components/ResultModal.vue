<script setup>
import { ref, computed, watch } from 'vue';
import { useTasksStore } from '../stores/tasks.js';

const props = defineProps({
  taskId:  { type: String, default: null },
  visible: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

const store = useTasksStore();

// ── Данные ─────────────────────────────────────────────────────────────────
const loading  = ref(false);
const error    = ref(null);
const task     = ref(null);
const blocks   = ref([]);
const metrics  = ref(null);
const verdict  = ref(null);
const fullHtml = ref('');

// ── Вкладки ────────────────────────────────────────────────────────────────
const htmlTab = ref('preview');  // 'preview' | 'code'

// ── Копирование ────────────────────────────────────────────────────────────
const copiedHtml      = ref(false);
const copiedFormatted = ref(false);

// ── Загрузка при открытии ──────────────────────────────────────────────────
watch(() => [props.visible, props.taskId], async ([vis, id]) => {
  if (!vis || !id) return;
  loading.value = true;
  error.value   = null;
  try {
    const data = await store.fetchResult(id);
    task.value     = data.task;
    blocks.value   = data.blocks  || [];
    metrics.value  = data.metrics || {};
    verdict.value  = data.task?.stage7_result || null;
    fullHtml.value = data.task?.full_html || '';
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}, { immediate: true });

// ── Метрики ────────────────────────────────────────────────────────────────
const lsiCoverage = computed(() => metrics.value?.lsi_coverage  ?? 0);
const eeatScore   = computed(() => metrics.value?.eeat_score    ?? 0);
const bm25Score   = computed(() => metrics.value?.bm25_score    ?? 0);

const deepseekIn   = computed(() => metrics.value?.deepseek_tokens_in  ?? 0);
const deepseekOut  = computed(() => metrics.value?.deepseek_tokens_out ?? 0);
const deepseekCost = computed(() => metrics.value?.deepseek_cost_usd   ?? 0);
const geminiIn     = computed(() => metrics.value?.gemini_tokens_in    ?? 0);
const geminiOut    = computed(() => metrics.value?.gemini_tokens_out   ?? 0);
const geminiCost   = computed(() => metrics.value?.gemini_cost_usd     ?? 0);
const totalTokens  = computed(() =>
  metrics.value?.total_tokens ?? (deepseekIn.value + deepseekOut.value + geminiIn.value + geminiOut.value)
);
const totalCost = computed(() =>
  metrics.value?.total_cost_usd ?? (deepseekCost.value + geminiCost.value)
);

// E-E-A-T
const EEAT_CRITERIA = [
  { key: 'experience',         label: 'Experience'        },
  { key: 'expertise',          label: 'Expertise'         },
  { key: 'authoritativeness',  label: 'Authoritativeness' },
  { key: 'trustworthiness',    label: 'Trustworthiness'   },
  { key: 'content_depth',      label: 'Content Depth'     },
  { key: 'factual_accuracy',   label: 'Factual Accuracy'  },
  { key: 'source_quality',     label: 'Source Quality'    },
  { key: 'user_intent',        label: 'User Intent Match' },
  { key: 'readability',        label: 'Readability'       },
  { key: 'uniqueness',         label: 'Uniqueness'        },
  { key: 'freshness',          label: 'Freshness'         },
  { key: 'safety',             label: 'Safety'            },
];

const eeatDetails = computed(() => {
  const src = verdict.value?.global_audit?.eeat_breakdown || verdict.value?.eeat_breakdown || {};
  return EEAT_CRITERIA.map(c => ({ label: c.label, score: src[c.key] ?? 0 }));
});

function eeatBarColor(score) {
  if (score >= 8) return 'bg-green-500';
  if (score >= 5) return 'bg-yellow-500';
  return 'bg-red-500';
}

// Stage 7 verdict
const hcuStatus      = computed(() => verdict.value?.global_audit?.hcu_status || '—');
const pqScore        = computed(() => verdict.value?.global_audit?.page_quality_score ?? '—');
const overallVerdict = computed(() => verdict.value?.global_audit?.overall_verdict || '—');

const hcuBadge = computed(() => {
  const s = hcuStatus.value?.toLowerCase() || '';
  if (s.includes('pass') || s.includes('safe') || s.includes('соответств')) return 'bg-green-900 text-green-300';
  if (s.includes('warn') || s.includes('риск'))  return 'bg-yellow-900 text-yellow-300';
  if (s.includes('fail') || s.includes('не соо') || s.includes('danger')) return 'bg-red-900 text-red-300';
  return 'bg-gray-700 text-gray-300';
});

// ── Копирование HTML ───────────────────────────────────────────────────────
function copyHtmlSource() {
  if (!fullHtml.value) return;
  navigator.clipboard.writeText(fullHtml.value).then(() => {
    copiedHtml.value = true;
    setTimeout(() => { copiedHtml.value = false; }, 2000);
  });
}

function copyFormatted() {
  if (!fullHtml.value) return;
  const blob = new Blob([fullHtml.value], { type: 'text/html' });
  const textBlob = new Blob([stripHtml(fullHtml.value)], { type: 'text/plain' });
  navigator.clipboard.write([
    new ClipboardItem({
      'text/html':  blob,
      'text/plain': textBlob,
    }),
  ]).then(() => {
    copiedFormatted.value = true;
    setTimeout(() => { copiedFormatted.value = false; }, 2000);
  });
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

function exportHtml() {
  if (!fullHtml.value) return;
  const blob = new Blob([fullHtml.value], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `seo-result-task-${props.taskId}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(n, digits = 0) {
  return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function closeModal() {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <transition name="modal">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
        @mousedown.self="closeModal"
      >
        <!-- Оверлей -->
        <div class="fixed inset-0 bg-black/70 backdrop-blur-sm" @click="closeModal" />

        <!-- Контейнер модалки -->
        <div class="relative w-full max-w-5xl mx-4 my-8 z-10">
          <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">

            <!-- Шапка -->
            <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/95 sticky top-0 z-10">
              <div class="flex items-center gap-3 min-w-0">
                <span class="badge bg-green-900 text-green-300">✓ Готово</span>
                <h2 class="text-white font-semibold truncate text-lg">
                  {{ task?.input_target_service || 'Результаты задачи' }}
                </h2>
              </div>
              <button
                @click="closeModal"
                class="text-gray-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-gray-800"
                aria-label="Закрыть"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <!-- Загрузка -->
            <div v-if="loading" class="flex items-center justify-center py-20">
              <div class="flex gap-2 items-center text-gray-400">
                <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Загрузка результатов...
              </div>
            </div>

            <!-- Ошибка -->
            <div v-else-if="error" class="p-6">
              <div class="card border border-red-800 text-red-300">
                <p class="font-semibold mb-1">Ошибка загрузки</p>
                <p class="text-sm text-red-400">{{ error }}</p>
              </div>
            </div>

            <!-- Содержимое -->
            <div v-else class="p-6 space-y-5 max-h-[80vh] overflow-y-auto">

              <!-- ══ Метрики ═══════════════════════════════════════════════ -->
              <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div class="card py-3 px-4">
                  <p class="text-xs text-gray-500 uppercase tracking-wide">LSI Coverage</p>
                  <p class="text-2xl font-bold mt-1" :class="lsiCoverage >= 70 ? 'text-green-400' : lsiCoverage >= 50 ? 'text-yellow-400' : 'text-red-400'">
                    {{ lsiCoverage }}%
                  </p>
                </div>
                <div class="card py-3 px-4">
                  <p class="text-xs text-gray-500 uppercase tracking-wide">E-E-A-T</p>
                  <p class="text-2xl font-bold mt-1" :class="eeatScore >= 8 ? 'text-green-400' : eeatScore >= 6 ? 'text-yellow-400' : 'text-red-400'">
                    {{ eeatScore }}<span class="text-base text-gray-600">/10</span>
                  </p>
                </div>
                <div class="card py-3 px-4">
                  <p class="text-xs text-gray-500 uppercase tracking-wide">BM25</p>
                  <p class="text-2xl font-bold text-indigo-400 mt-1">
                    {{ typeof bm25Score === 'number' ? bm25Score.toFixed(2) : bm25Score }}
                  </p>
                </div>
                <div class="card py-3 px-4">
                  <p class="text-xs text-gray-500 uppercase tracking-wide">PQ Score</p>
                  <p class="text-2xl font-bold mt-1" :class="pqScore >= 8 ? 'text-green-400' : pqScore >= 6 ? 'text-yellow-400' : 'text-red-400'">
                    {{ pqScore }}<span class="text-base text-gray-600">/10</span>
                  </p>
                </div>
              </div>

              <!-- ══ Токены и стоимость ════════════════════════════════════ -->
              <div class="card">
                <p class="text-xs text-gray-500 uppercase tracking-wide mb-3">Расход токенов</p>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div class="bg-gray-800 rounded-lg p-3">
                    <p class="text-xs font-semibold text-gray-400 mb-2">DeepSeek</p>
                    <div class="grid grid-cols-2 gap-1 text-xs font-mono">
                      <span class="text-gray-500">In:</span>
                      <span class="text-right text-gray-300">{{ fmt(deepseekIn) }}</span>
                      <span class="text-gray-500">Out:</span>
                      <span class="text-right text-gray-300">{{ fmt(deepseekOut) }}</span>
                      <span class="text-gray-500">Cost:</span>
                      <span class="text-right text-indigo-300">${{ Number(deepseekCost).toFixed(4) }}</span>
                    </div>
                  </div>
                  <div class="bg-gray-800 rounded-lg p-3">
                    <p class="text-xs font-semibold text-gray-400 mb-2">Gemini</p>
                    <div class="grid grid-cols-2 gap-1 text-xs font-mono">
                      <span class="text-gray-500">In:</span>
                      <span class="text-right text-gray-300">{{ fmt(geminiIn) }}</span>
                      <span class="text-gray-500">Out:</span>
                      <span class="text-right text-gray-300">{{ fmt(geminiOut) }}</span>
                      <span class="text-gray-500">Cost:</span>
                      <span class="text-right text-indigo-300">${{ Number(geminiCost).toFixed(4) }}</span>
                    </div>
                  </div>
                  <div class="bg-indigo-950 border border-indigo-800 rounded-lg p-3 flex flex-col justify-between">
                    <p class="text-xs font-semibold text-indigo-300 mb-2">Итого</p>
                    <div class="text-xs font-mono">
                      <span class="text-gray-500">Токены: </span>
                      <span class="text-gray-300">{{ fmt(totalTokens) }}</span>
                    </div>
                    <div class="text-lg font-bold text-white mt-1">${{ Number(totalCost).toFixed(4) }}</div>
                  </div>
                </div>
              </div>

              <!-- ══ HCU / Вердикт ════════════════════════════════════════ -->
              <div v-if="verdict" class="card">
                <p class="text-xs text-gray-500 uppercase tracking-wide mb-3">Stage 7 — Вердикт</p>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div class="space-y-3">
                    <div class="flex items-center gap-3">
                      <span class="text-xs text-gray-400 w-28">HCU Status</span>
                      <span :class="['badge text-xs font-semibold', hcuBadge]">{{ hcuStatus }}</span>
                    </div>
                    <div>
                      <span class="text-xs text-gray-400">Вердикт</span>
                      <p class="text-sm text-gray-300 bg-gray-800 rounded-lg p-2.5 mt-1 leading-relaxed">
                        {{ overallVerdict }}
                      </p>
                    </div>
                  </div>
                  <div>
                    <p class="text-xs text-gray-400 mb-2">E-E-A-T</p>
                    <div class="space-y-1.5">
                      <div v-for="c in eeatDetails" :key="c.label" class="flex items-center gap-2">
                        <span class="text-[10px] text-gray-500 w-28 truncate">{{ c.label }}</span>
                        <div class="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div :class="['h-full rounded-full', eeatBarColor(c.score)]"
                               :style="{ width: (c.score / 10 * 100) + '%' }"/>
                        </div>
                        <span class="text-[10px] font-mono text-gray-400 w-5 text-right">{{ c.score }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ══ HTML-контент ═════════════════════════════════════════ -->
              <div v-if="fullHtml" class="card">
                <div class="flex flex-wrap items-center gap-3 mb-4">
                  <p class="text-xs text-gray-500 uppercase tracking-wide">Финальный контент</p>

                  <!-- Вкладки -->
                  <div class="flex gap-1 ml-2">
                    <button
                      :class="['text-xs px-3 py-1 rounded-md transition-colors',
                        htmlTab === 'preview'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700']"
                      @click="htmlTab = 'preview'"
                    >Preview</button>
                    <button
                      :class="['text-xs px-3 py-1 rounded-md transition-colors',
                        htmlTab === 'code'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700']"
                      @click="htmlTab = 'code'"
                    >HTML-код</button>
                  </div>

                  <!-- Кнопки копирования -->
                  <div class="ml-auto flex gap-2 flex-wrap">
                    <button
                      class="text-xs px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors flex items-center gap-1.5"
                      @click="copyHtmlSource"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                      </svg>
                      {{ copiedHtml ? '✓ Скопировано!' : 'Скопировать HTML' }}
                    </button>
                    <button
                      class="text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5"
                      @click="copyFormatted"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>
                      {{ copiedFormatted ? '✓ Скопировано!' : 'Копировать текст' }}
                    </button>
                    <button
                      class="text-xs px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors flex items-center gap-1.5"
                      @click="exportHtml"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                      </svg>
                      Скачать .html
                    </button>
                  </div>
                </div>

                <!-- Preview -->
                <div v-if="htmlTab === 'preview'" class="rounded-lg overflow-hidden border border-gray-700">
                  <iframe
                    :srcdoc="fullHtml"
                    class="w-full bg-white"
                    style="height: 500px; border: none;"
                    sandbox="allow-same-origin"
                  />
                </div>

                <!-- HTML-код -->
                <div v-else>
                  <pre class="text-xs font-mono text-gray-300 bg-gray-950 rounded-lg p-4 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all max-h-[500px]">{{ fullHtml }}</pre>
                </div>
              </div>

              <!-- Блоки контента -->
              <div v-if="blocks.length" class="card">
                <p class="text-xs text-gray-500 uppercase tracking-wide mb-3">
                  Блоки контента ({{ blocks.length }})
                </p>
                <div class="space-y-2">
                  <div
                    v-for="(block, idx) in blocks"
                    :key="block.block_index ?? idx"
                    class="flex items-center gap-3 bg-gray-800 rounded-lg px-4 py-2.5"
                  >
                    <span class="text-xs text-gray-500 font-mono w-5 text-center">{{ (block.block_index ?? idx) + 1 }}</span>
                    <p class="text-sm text-gray-300 flex-1 truncate">{{ block.h2_title || '(без заголовка)' }}</p>
                    <span class="text-xs font-mono" :class="block.lsi_coverage >= 70 ? 'text-green-400' : 'text-yellow-400'">
                      LSI {{ block.lsi_coverage ?? 0 }}%
                    </span>
                    <span class="text-xs font-mono" :class="block.pq_score >= 8 ? 'text-green-400' : 'text-yellow-400'">
                      PQ {{ block.pq_score ?? 0 }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active .bg-gray-900,
.modal-leave-active .bg-gray-900 {
  transition: transform 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
