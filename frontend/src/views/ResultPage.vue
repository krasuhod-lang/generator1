<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';

const route  = useRoute();
const router = useRouter();
const store  = useTasksStore();

const taskId = route.params.id;

// ── Данные ─────────────────────────────────────────────────────────────────
const loading = ref(true);
const error   = ref(null);

const task    = ref(null);   // объект задачи (task_metrics внутри)
const blocks  = ref([]);     // массив task_content_blocks
const metrics = ref(null);   // task_metrics
const verdict = ref(null);   // task.stage7_result (JSONB)
const fullHtml = ref('');    // task.full_html

// ── Вкладки HTML-превью ────────────────────────────────────────────────────
const htmlTab = ref('preview');  // 'preview' | 'code'

// ── Раскрытие блоков ──────────────────────────────────────────────────────
const expandedBlock   = ref(null);  // index блока с открытым HTML
const expandedAudit   = ref(null);  // index блока с открытым аудитом

function toggleBlockHtml(idx) {
  expandedBlock.value = expandedBlock.value === idx ? null : idx;
}
function toggleAudit(idx) {
  expandedAudit.value = expandedAudit.value === idx ? null : idx;
}

// ── Загрузка данных ────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    const data = await store.fetchResult(taskId);
    // data = { task, blocks, metrics }
    task.value    = data.task;
    blocks.value  = data.blocks  || [];
    metrics.value = data.metrics || {};
    verdict.value = data.task?.stage7_result || null;
    fullHtml.value = data.task?.full_html || '';
  } catch (e) {
    error.value = e.response?.data?.error || e.message || 'Ошибка загрузки результата';
  } finally {
    loading.value = false;
  }
});

// ── Вычисляемые метрики ────────────────────────────────────────────────────
const lsiCoverage = computed(() => metrics.value?.lsi_coverage  ?? 0);
const eeatScore   = computed(() => metrics.value?.eeat_score    ?? 0);
const bm25Score   = computed(() => metrics.value?.bm25_score    ?? 0);
const tfidfStatus = computed(() => {
  const s = verdict.value?.global_audit?.tfidf_spam_report;
  if (!s) return { label: 'OK', cls: 'bg-green-900 text-green-300' };
  const violations = s?.violations?.length || 0;
  if (violations === 0) return { label: 'OK — нет нарушений', cls: 'bg-green-900 text-green-300' };
  if (violations <= 3)  return { label: `${violations} нарушения`, cls: 'bg-yellow-900 text-yellow-300' };
  return { label: `${violations} нарушений`, cls: 'bg-red-900 text-red-300' };
});

const deepseekIn   = computed(() => metrics.value?.deepseek_tokens_in  ?? 0);
const deepseekOut  = computed(() => metrics.value?.deepseek_tokens_out ?? 0);
const deepseekCost = computed(() => metrics.value?.deepseek_cost_usd   ?? 0);
const geminiIn     = computed(() => metrics.value?.gemini_tokens_in    ?? 0);
const geminiOut    = computed(() => metrics.value?.gemini_tokens_out   ?? 0);
const geminiCost   = computed(() => metrics.value?.gemini_cost_usd     ?? 0);
const totalTokens  = computed(() => metrics.value?.total_tokens ?? (deepseekIn.value + deepseekOut.value + geminiIn.value + geminiOut.value));
const totalCost    = computed(() => metrics.value?.total_cost_usd ?? (deepseekCost.value + geminiCost.value));

// ── Время генерации ────────────────────────────────────────────────────────
const generationTime = computed(() => {
  const started   = task.value?.started_at;
  const completed = task.value?.completed_at;
  if (!started || !completed) return null;
  const sec = Math.round((new Date(completed) - new Date(started)) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}м ${s}с` : `${s}с`;
});

// ── Stage 7: вердикт ──────────────────────────────────────────────────────
const hcuStatus = computed(() => verdict.value?.global_audit?.hcu_status || '—');
const pqScore   = computed(() => verdict.value?.global_audit?.page_quality_score ?? '—');
const overallVerdict = computed(() => verdict.value?.global_audit?.overall_verdict || '—');

const hcuBadge = computed(() => {
  const s = hcuStatus.value?.toLowerCase() || '';
  if (s.includes('pass') || s.includes('safe') || s.includes('соответств')) return 'bg-green-900 text-green-300';
  if (s.includes('warn') || s.includes('риск'))  return 'bg-yellow-900 text-yellow-300';
  if (s.includes('fail') || s.includes('не соо') || s.includes('danger')) return 'bg-red-900 text-red-300';
  return 'bg-gray-700 text-gray-300';
});

// 12 E-E-A-T критериев
const EEAT_CRITERIA = [
  { key: 'experience',         label: 'Experience'          },
  { key: 'expertise',          label: 'Expertise'           },
  { key: 'authoritativeness',  label: 'Authoritativeness'   },
  { key: 'trustworthiness',    label: 'Trustworthiness'     },
  { key: 'content_depth',      label: 'Content Depth'       },
  { key: 'factual_accuracy',   label: 'Factual Accuracy'    },
  { key: 'source_quality',     label: 'Source Quality'      },
  { key: 'user_intent',        label: 'User Intent Match'   },
  { key: 'readability',        label: 'Readability'         },
  { key: 'uniqueness',         label: 'Uniqueness'          },
  { key: 'freshness',          label: 'Freshness'           },
  { key: 'safety',             label: 'Safety'              },
];

const eeatDetails = computed(() => {
  const src = verdict.value?.global_audit?.eeat_breakdown || verdict.value?.eeat_breakdown || {};
  return EEAT_CRITERIA.map(c => ({
    label: c.label,
    score: src[c.key] ?? 0,
  }));
});

function eeatBarColor(score) {
  if (score >= 8) return 'bg-green-500';
  if (score >= 5) return 'bg-yellow-500';
  return 'bg-red-500';
}

// TF-IDF нарушения
const tfidfViolations = computed(() =>
  verdict.value?.global_audit?.tfidf_spam_report?.violations || []
);

// Критические улучшения
const criticalImprovements = computed(() =>
  verdict.value?.global_audit?.critical_improvements ||
  verdict.value?.global_audit?.improvements || []
);

// ── Аудит блока (audit_log_json) ──────────────────────────────────────────
function parseAudit(block) {
  try {
    if (!block.audit_log_json) return null;
    if (typeof block.audit_log_json === 'string') {
      return JSON.parse(block.audit_log_json);
    }
    return block.audit_log_json;
  } catch {
    return null;
  }
}

// ── Экспорт HTML ──────────────────────────────────────────────────────────
const copied = ref(false);

function copyHtml() {
  if (!fullHtml.value) return;
  navigator.clipboard.writeText(fullHtml.value).then(() => {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  });
}

function exportHtml() {
  if (!fullHtml.value) return;
  const blob = new Blob([fullHtml.value], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `seo-result-task-${taskId}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Числовой форматтер ────────────────────────────────────────────────────
function fmt(n, digits = 0) {
  return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
</script>

<template>
  <div class="min-h-screen bg-gray-950">

    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center gap-3">
      <RouterLink to="/dashboard" class="btn-ghost text-xs">← Кабинет</RouterLink>
      <span class="text-white font-semibold truncate max-w-lg">
        {{ task?.input_target_service || 'Результаты задачи' }}
      </span>
      <span class="badge bg-green-900 text-green-300 ml-auto">✓ Готово</span>
    </header>

    <!-- Загрузка -->
    <div v-if="loading" class="flex items-center justify-center h-64">
      <div class="flex gap-2 items-center text-gray-400">
        <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
        </svg>
        Загрузка результатов...
      </div>
    </div>

    <!-- Ошибка -->
    <div v-else-if="error" class="max-w-2xl mx-auto mt-16 px-6">
      <div class="card border border-red-800 text-red-300">
        <p class="font-semibold mb-1">Ошибка загрузки</p>
        <p class="text-sm text-red-400">{{ error }}</p>
        <button class="btn mt-4" @click="router.push('/dashboard')">← Вернуться в кабинет</button>
      </div>
    </div>

    <!-- Содержимое -->
    <main v-else class="max-w-7xl mx-auto px-6 py-6 space-y-6">

      <!-- ══ Ряд 1: 5 карточек метрик ════════════════════════════════════ -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">

        <!-- LSI Coverage -->
        <div class="card flex flex-col gap-1">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">LSI Coverage</p>
          <p class="text-3xl font-bold" :class="lsiCoverage >= 70 ? 'text-green-400' : lsiCoverage >= 50 ? 'text-yellow-400' : 'text-red-400'">
            {{ lsiCoverage }}%
          </p>
          <div class="h-1.5 bg-gray-800 rounded-full mt-1 overflow-hidden">
            <div class="h-full rounded-full transition-all"
              :class="lsiCoverage >= 70 ? 'bg-green-500' : lsiCoverage >= 50 ? 'bg-yellow-500' : 'bg-red-500'"
              :style="{ width: Math.min(lsiCoverage, 100) + '%' }"
            />
          </div>
        </div>

        <!-- E-E-A-T Score -->
        <div class="card flex flex-col gap-1">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">E-E-A-T Score</p>
          <p class="text-3xl font-bold" :class="eeatScore >= 8 ? 'text-green-400' : eeatScore >= 6 ? 'text-yellow-400' : 'text-red-400'">
            {{ eeatScore }}<span class="text-lg text-gray-600">/10</span>
          </p>
          <div class="h-1.5 bg-gray-800 rounded-full mt-1 overflow-hidden">
            <div class="h-full rounded-full transition-all"
              :class="eeatScore >= 8 ? 'bg-green-500' : eeatScore >= 6 ? 'bg-yellow-500' : 'bg-red-500'"
              :style="{ width: (eeatScore / 10 * 100) + '%' }"
            />
          </div>
        </div>

        <!-- BM25 Score -->
        <div class="card flex flex-col gap-1">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">BM25 Score</p>
          <p class="text-3xl font-bold text-indigo-400">
            {{ typeof bm25Score === 'number' ? bm25Score.toFixed(2) : bm25Score }}
          </p>
          <p class="text-xs text-gray-600 mt-1">Релевантность контента</p>
        </div>

        <!-- TF-IDF Status -->
        <div class="card flex flex-col gap-1">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">TF-IDF Спам</p>
          <span :class="['badge text-sm font-semibold mt-1 self-start', tfidfStatus.cls]">
            {{ tfidfStatus.label }}
          </span>
          <p class="text-xs text-gray-600 mt-auto">Анализ плотности</p>
        </div>

        <!-- Время генерации -->
        <div class="card flex flex-col gap-1">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">⏱ Время</p>
          <p class="text-3xl font-bold text-cyan-400">
            {{ generationTime || '—' }}
          </p>
          <p class="text-xs text-gray-600 mt-1">Генерация контента</p>
        </div>
      </div>

      <!-- ══ Ряд 2: Стоимость ═══════════════════════════════════════════ -->
      <div class="card">
        <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-4">Расход токенов и стоимость</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">

          <!-- DeepSeek -->
          <div class="bg-gray-800 rounded-lg p-4">
            <p class="text-sm font-semibold text-gray-300 mb-3">DeepSeek Chat</p>
            <div class="grid grid-cols-2 gap-1.5 text-xs font-mono">
              <span class="text-gray-500">Input:</span>
              <span class="text-right text-gray-300">{{ fmt(deepseekIn) }} tok</span>
              <span class="text-gray-500">Output:</span>
              <span class="text-right text-gray-300">{{ fmt(deepseekOut) }} tok</span>
              <span class="text-gray-500">Стоимость:</span>
              <span class="text-right text-indigo-300 font-semibold">${{ deepseekCost.toFixed(4) }}</span>
            </div>
          </div>

          <!-- Gemini -->
          <div class="bg-gray-800 rounded-lg p-4">
            <p class="text-sm font-semibold text-gray-300 mb-3">Gemini 3.1 Pro</p>
            <div class="grid grid-cols-2 gap-1.5 text-xs font-mono">
              <span class="text-gray-500">Input:</span>
              <span class="text-right text-gray-300">{{ fmt(geminiIn) }} tok</span>
              <span class="text-gray-500">Output:</span>
              <span class="text-right text-gray-300">{{ fmt(geminiOut) }} tok</span>
              <span class="text-gray-500">Стоимость:</span>
              <span class="text-right text-indigo-300 font-semibold">${{ geminiCost.toFixed(4) }}</span>
            </div>
          </div>

          <!-- Итого -->
          <div class="bg-indigo-950 border border-indigo-800 rounded-lg p-4 flex flex-col justify-between">
            <p class="text-sm font-semibold text-indigo-300 mb-3">Итого</p>
            <div class="grid grid-cols-2 gap-1.5 text-xs font-mono">
              <span class="text-gray-500">Токены:</span>
              <span class="text-right text-gray-300">{{ fmt(totalTokens) }}</span>
              <span class="text-gray-500">Стоимость:</span>
              <span class="text-right text-2xl font-bold text-white col-span-2 mt-1">
                ${{ totalCost.toFixed(4) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Ряд 3: Блоки контента ══════════════════════════════════════ -->
      <div class="card" v-if="blocks.length">
        <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-4">
          Блоки контента ({{ blocks.length }})
        </p>
        <div class="space-y-3">
          <div
            v-for="(block, idx) in blocks"
            :key="block.block_index ?? idx"
            class="bg-gray-800 rounded-lg overflow-hidden"
          >
            <!-- Заголовок блока -->
            <div class="flex flex-wrap items-center gap-2 px-4 py-3">
              <span class="text-xs text-gray-500 w-6 text-center font-mono">{{ (block.block_index ?? idx) + 1 }}</span>
              <p class="text-sm text-gray-200 font-medium flex-1 min-w-0 truncate">
                {{ block.h2_title || '(без заголовка)' }}
              </p>

              <!-- Метрики блока -->
              <div class="flex items-center gap-3 text-xs font-mono ml-auto">
                <span class="text-gray-500">
                  LSI
                  <span :class="block.lsi_coverage >= 70 ? 'text-green-400' : block.lsi_coverage >= 50 ? 'text-yellow-400' : 'text-red-400'">
                    {{ block.lsi_coverage ?? 0 }}%
                  </span>
                </span>
                <span class="text-gray-500">
                  PQ
                  <span :class="block.pq_score >= 8 ? 'text-green-400' : block.pq_score >= 6 ? 'text-yellow-400' : 'text-red-400'">
                    {{ block.pq_score ?? 0 }}
                  </span>
                </span>
              </div>

              <!-- Кнопки раскрытия -->
              <button
                class="text-xs px-2.5 py-1 rounded bg-gray-700 hover:bg-gray-600 text-indigo-300 transition-colors"
                @click="toggleAudit(idx)"
              >
                E-E-A-T отчёт {{ expandedAudit === idx ? '▲' : '▼' }}
              </button>
              <button
                class="text-xs px-2.5 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 transition-colors"
                @click="toggleBlockHtml(idx)"
              >
                HTML {{ expandedBlock === idx ? '▲' : '▼' }}
              </button>
            </div>

            <!-- E-E-A-T аудит блока -->
            <div v-if="expandedAudit === idx && parseAudit(block)" class="border-t border-gray-700 px-4 py-3 bg-gray-900">
              <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Аудит блока</p>
              <pre class="text-xs font-mono text-gray-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ JSON.stringify(parseAudit(block), null, 2) }}</pre>
            </div>
            <div v-else-if="expandedAudit === idx" class="border-t border-gray-700 px-4 py-3 text-xs text-gray-600 italic">
              Нет данных аудита для этого блока.
            </div>

            <!-- HTML блока -->
            <div v-if="expandedBlock === idx" class="border-t border-gray-700">
              <div class="p-3 max-h-64 overflow-y-auto">
                <pre class="text-xs font-mono text-gray-400 whitespace-pre-wrap break-all">{{ block.html_content || '(пусто)' }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ Ряд 4: Финальный HTML ══════════════════════════════════════ -->
      <div class="card" v-if="fullHtml">
        <div class="flex flex-wrap items-center gap-3 mb-4">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Финальный HTML</p>

          <!-- Вкладки -->
          <div class="flex gap-1 ml-2">
            <button
              :class="['text-xs px-3 py-1 rounded-md transition-colors',
                htmlTab === 'preview'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700']"
              @click="htmlTab = 'preview'"
            >
              Preview
            </button>
            <button
              :class="['text-xs px-3 py-1 rounded-md transition-colors',
                htmlTab === 'code'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700']"
              @click="htmlTab = 'code'"
            >
              HTML-код
            </button>
          </div>

          <!-- Кнопки экспорта -->
          <div class="ml-auto flex gap-2">
            <button
              class="text-xs px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors flex items-center gap-1.5"
              @click="copyHtml"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
              {{ copied ? 'Скопировано!' : 'Скопировать HTML' }}
            </button>
            <button
              class="text-xs px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5"
              @click="exportHtml"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Экспортировать HTML-файл
            </button>
          </div>
        </div>

        <!-- Preview -->
        <div v-if="htmlTab === 'preview'" class="rounded-lg overflow-hidden border border-gray-700">
          <iframe
            :srcdoc="fullHtml"
            class="w-full bg-white"
            style="height: 600px; border: none;"
            sandbox="allow-same-origin"
          />
        </div>

        <!-- Код -->
        <div v-else class="relative">
          <pre class="text-xs font-mono text-gray-300 bg-gray-900 rounded-lg p-4 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all max-h-[600px]">{{ fullHtml }}</pre>
        </div>
      </div>

      <!-- ══ Ряд 5: Stage 7 — Вердикт ══════════════════════════════════ -->
      <div class="card" v-if="verdict">
        <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-5">Stage 7 — Глобальный вердикт</p>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

          <!-- Левая часть: HCU + PQ + вердикт -->
          <div class="space-y-4">

            <!-- HCU Status -->
            <div class="flex items-center gap-3">
              <p class="text-sm text-gray-400 w-36 flex-shrink-0">HCU Status</p>
              <span :class="['badge text-sm font-semibold', hcuBadge]">{{ hcuStatus }}</span>
            </div>

            <!-- Page Quality Score -->
            <div class="flex items-center gap-3">
              <p class="text-sm text-gray-400 w-36 flex-shrink-0">Page Quality</p>
              <span class="text-2xl font-bold"
                :class="pqScore >= 8 ? 'text-green-400' : pqScore >= 6 ? 'text-yellow-400' : 'text-red-400'">
                {{ pqScore }}<span class="text-base text-gray-600">/10</span>
              </span>
            </div>

            <!-- Overall Verdict -->
            <div>
              <p class="text-sm text-gray-400 mb-2">Общий вердикт</p>
              <p class="text-sm text-gray-300 leading-relaxed bg-gray-800 rounded-lg p-3">
                {{ overallVerdict }}
              </p>
            </div>

            <!-- TF-IDF нарушения -->
            <div v-if="tfidfViolations.length">
              <p class="text-sm text-gray-400 mb-2">TF-IDF нарушения ({{ tfidfViolations.length }})</p>
              <ul class="space-y-1.5">
                <li
                  v-for="(v, idx) in tfidfViolations"
                  :key="idx"
                  class="flex items-start gap-2 text-xs text-red-300 bg-red-950/40 rounded px-3 py-1.5"
                >
                  <span class="text-red-500 mt-0.5 flex-shrink-0">⚠</span>
                  {{ typeof v === 'string' ? v : JSON.stringify(v) }}
                </li>
              </ul>
            </div>

            <!-- Критические улучшения -->
            <div v-if="criticalImprovements.length">
              <p class="text-sm text-gray-400 mb-2">Критические улучшения</p>
              <ul class="space-y-1.5">
                <li
                  v-for="(item, idx) in criticalImprovements"
                  :key="idx"
                  class="flex items-start gap-2 text-xs text-yellow-300 bg-yellow-950/30 rounded px-3 py-1.5"
                >
                  <span class="text-yellow-500 mt-0.5 flex-shrink-0">→</span>
                  {{ typeof item === 'string' ? item : JSON.stringify(item) }}
                </li>
              </ul>
            </div>
          </div>

          <!-- Правая часть: E-E-A-T breakdown 12 критериев -->
          <div>
            <p class="text-sm text-gray-400 mb-3">E-E-A-T разбивка (12 критериев)</p>
            <div class="space-y-2">
              <div
                v-for="c in eeatDetails"
                :key="c.label"
                class="flex items-center gap-3"
              >
                <span class="text-xs text-gray-500 w-36 flex-shrink-0 truncate">{{ c.label }}</span>
                <div class="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    :class="['h-full rounded-full transition-all', eeatBarColor(c.score)]"
                    :style="{ width: (c.score / 10 * 100) + '%' }"
                  />
                </div>
                <span class="text-xs font-mono text-gray-400 w-8 text-right">{{ c.score }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Нет данных Stage 7 -->
      <div v-else class="card text-center text-gray-600 py-8">
        Данные Stage 7 недоступны для этой задачи.
      </div>

    </main>
  </div>
</template>
