<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';
import { useAuthStore } from '../stores/auth.js';
import ResultModal from '../components/ResultModal.vue';

const route  = useRoute();
const router = useRouter();
const store  = useTasksStore();
const auth   = useAuthStore();

// ── Модалка результатов ────────────────────────────────────────────────────
const showResult = ref(false);

const taskId = route.params.id;

// ── Состояние ──────────────────────────────────────────────────────────────
const task     = ref(null);
const logs     = ref([]);           // { ts, msg, level }
const progress = ref(0);
const stage    = ref('—');
const done     = ref(false);
const failed   = ref(false);
const paused   = ref(false);  // задача на паузе
const pausing  = ref(false);  // запрос на паузу отправлен, ждём
const resuming = ref(false);  // запрос на resume отправлен

// ── Токены и стоимость ─────────────────────────────────────────────────────
const tokens = reactive({
  deepseekIn:  0, deepseekOut:  0, deepseekCost:  0,
  geminiIn:    0, geminiOut:    0, geminiCost:    0,
});
const totalCost = computed(() =>
  (tokens.deepseekCost + tokens.geminiCost).toFixed(4)
);
const totalTokens = computed(() =>
  tokens.deepseekIn + tokens.deepseekOut + tokens.geminiIn + tokens.geminiOut
);

// ── Блоки H2 ───────────────────────────────────────────────────────────────
const blocks = reactive({});  // { [idx]: { h2, status, lsi, pq } }

// ── Таймер генерации ───────────────────────────────────────────────────────
const generationStartTime = ref(null);
const generationElapsed   = ref(0);    // секунды
const generationTimeFinal = ref(null); // финальное время из pipeline_done
let   timerInterval       = null;

function startGenerationTimer() {
  generationStartTime.value = Date.now();
  timerInterval = setInterval(() => {
    generationElapsed.value = Math.floor((Date.now() - generationStartTime.value) / 1000);
  }, 1000);
}

function stopGenerationTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

const generationTimeFormatted = computed(() => {
  const sec = generationTimeFinal.value ?? generationElapsed.value;
  if (!sec && !generationStartTime.value) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}м ${s}с` : `${s}с`;
});

// ── SSE ────────────────────────────────────────────────────────────────────
let es              = null;
let reconnectTimer  = null;
let reconnectCount  = 0;
const MAX_RECONNECT = 3;
const RECONNECT_BASE_MS = 3000;

const logContainer = ref(null);

// ── Лог-терминал ──────────────────────────────────────────────────────────
const LOG_COLORS = {
  info:    'text-gray-300',
  success: 'text-green-400',
  warn:    'text-yellow-400',
  error:   'text-red-400',
  system:  'text-indigo-400',
};

function getLogClass(level) {
  return LOG_COLORS[level] || 'text-gray-400';
}

// Автоскролл вниз при добавлении строк
async function scrollLog() {
  await nextTick();
  const el = logContainer.value;
  if (!el) return;
  // Скроллим только если пользователь уже у нижней части (± 120px)
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (atBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

function pushLog(entry) {
  logs.value.push(entry);
  // Лимит: не более 500 строк, удаляем первые 100 при переполнении
  if (logs.value.length > 500) logs.value.splice(0, 100);
  scrollLog();
}

// ── Обработчик SSE-сообщений ───────────────────────────────────────────────
function handleSSEMessage(msg) {
  switch (msg.type) {

    case 'init':
      // Задача уже завершена до нашего подключения
      if (msg.status === 'completed') {
        done.value = true;
        progress.value = 100;
        stage.value = 'done';
      } else if (msg.status === 'failed') {
        failed.value = true;
      } else if (msg.status === 'paused') {
        paused.value = true;
      }
      break;

    case 'log':
      pushLog({ ts: msg.ts || '--:--:--', msg: msg.msg, level: msg.level || 'info' });
      break;

    case 'progress':
      if (msg.percent !== undefined) progress.value = msg.percent;
      if (msg.stage   !== undefined) stage.value    = msg.stage;
      // Запускаем таймер при первом прогрессе
      if (!generationStartTime.value) {
        startGenerationTimer();
      }
      break;

    case 'taxonomy':
      if (Array.isArray(msg.taxonomy)) {
        msg.taxonomy.forEach((b, idx) => {
          blocks[idx] = { h2: b.h2, status: 'pending', lsi: 0, pq: 0, type: b.type };
        });
      }
      break;

    case 'block_start':
      if (blocks[msg.blockIndex]) {
        blocks[msg.blockIndex].status = msg.status || 'writing';
      } else {
        blocks[msg.blockIndex] = { h2: msg.h2, status: msg.status || 'writing', lsi: 0, pq: 0 };
      }
      break;

    case 'block_done':
      if (blocks[msg.blockIndex]) {
        blocks[msg.blockIndex].status = 'done';
        blocks[msg.blockIndex].lsi    = msg.lsiCoverage ?? 0;
        blocks[msg.blockIndex].pq     = msg.pqScore     ?? 0;
      }
      break;

    // ── ГЛАВНЫЙ ФИКС: токены из каждого LLM-вызова ────────────────────
    case 'tokens':
      if (msg.model === 'deepseek') {
        tokens.deepseekIn   += msg.tokensIn  || 0;
        tokens.deepseekOut  += msg.tokensOut || 0;
        tokens.deepseekCost += msg.cost      || 0;
      } else if (msg.model === 'gemini') {
        tokens.geminiIn   += msg.tokensIn  || 0;
        tokens.geminiOut  += msg.tokensOut || 0;
        tokens.geminiCost += msg.cost      || 0;
      }
      break;

    case 'done':
    case 'pipeline_done':
      done.value     = true;
      progress.value = 100;
      stage.value    = 'done';
      stopGenerationTimer();
      if (msg.generationTimeSec) {
        generationTimeFinal.value = msg.generationTimeSec;
      }
      closeSSE();
      pushLog({ ts: ts(), msg: '✓ Генерация завершена!', level: 'success' });
      // Показываем модалку результатов через короткую задержку
      setTimeout(() => { showResult.value = true; }, 1500);
      break;

    case 'pausing':
      pausing.value = true;
      pushLog({ ts: ts(), msg: `⏸ ${msg.message || 'Останавливаем задачу...'}`, level: 'warn' });
      break;

    case 'paused':
      paused.value  = true;
      pausing.value = false;
      stopGenerationTimer();
      pushLog({
        ts: ts(),
        msg: `⏹ Задача приостановлена. Готово блоков: ${msg.blocksDone ?? 0} / ${msg.blocksTotal ?? 0}`,
        level: 'warn',
      });
      closeSSE();
      break;

    case 'resuming':
      resuming.value = false;
      paused.value   = false;
      pushLog({ ts: ts(), msg: `▶ ${msg.message || 'Возобновляем задачу...'}`, level: 'info' });
      break;

    case 'error':
      failed.value = true;
      stopGenerationTimer();
      pushLog({ ts: ts(), msg: `КРИТИЧЕСКАЯ ОШИБКА: ${msg.msg || 'неизвестная ошибка'}`, level: 'error' });
      closeSSE();
      break;

    case 'cancelled':
    case 'closed':
      pushLog({ ts: ts(), msg: 'Задача отменена или удалена', level: 'warn' });
      closeSSE();
      break;
  }
}

function ts() {
  return new Date().toTimeString().substring(0, 8);
}

// ── Управление SSE ─────────────────────────────────────────────────────────
function closeSSE() {
  if (es) {
    es.close();
    es = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connectSSE() {
  closeSSE(); // закрываем предыдущее соединение если было

  const token = auth.token || localStorage.getItem('seo_token');
  if (!token) return;

  // Перед открытием SSE подгружаем события, появившиеся после lastLogId,
  // — это закрывает «дыру» при кратковременном разрыве соединения.
  loadHistory().catch(() => {}).finally(() => {
    if (es) return; // мог быть переподключён за время await
    es = new EventSource(`/api/tasks/${taskId}/stream?token=${encodeURIComponent(token)}`);
    es.onopen = onSseOpen;
    es.onmessage = onSseMessage;
    es.onerror = onSseError;
  });
}

function onSseOpen() {
  reconnectCount = 0; // сбрасываем счётчик реконнектов при успешном подключении
  pushLog({ ts: ts(), msg: `SSE подключён (попытка #${reconnectCount + 1})`, level: 'system' });
}

function onSseMessage(event) {
  try {
    const msg = JSON.parse(event.data);
    handleSSEMessage(msg);
  } catch (e) {
    console.warn('[SSE] parse error:', e.message, event.data?.substring(0, 100));
  }
}

function onSseError(event) {
  // Не переподключаемся если задача уже завершена/остановлена
  if (done.value || failed.value || paused.value) {
    closeSSE();
    return;
  }

  console.warn('[SSE] onerror event:', event);
  closeSSE();

  reconnectCount++;
  if (reconnectCount > MAX_RECONNECT) {
    pushLog({
      ts: ts(),
      msg: `SSE: превышено ${MAX_RECONNECT} попыток реконнекта. ` +
           `Обновите страницу или перейдите к результатам вручную.`,
      level: 'error',
    });
    return;
  }

  // Экспоненциальный бэкофф: 3s, 6s, 12s
  const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectCount - 1);
  pushLog({
    ts: ts(),
    msg: `SSE: соединение прервано. Реконнект #${reconnectCount}/${MAX_RECONNECT} через ${delay / 1000}s...`,
    level: 'warn',
  });

  reconnectTimer = setTimeout(() => {
    if (!done.value && !failed.value && !paused.value) {
      connectSSE();
    }
  }, delay);
}

// ── Вычисляемые ────────────────────────────────────────────────────────────
const blockList = computed(() =>
  Object.entries(blocks).map(([idx, b]) => ({ idx: +idx, ...b }))
    .sort((a, b) => a.idx - b.idx)
);

const BLOCK_STATUS = {
  pending:  { label: 'Ожидание',   cls: 'bg-gray-700 text-gray-400' },
  writing:  { label: 'Генерация',  cls: 'bg-indigo-900 text-indigo-300 animate-pulse' },
  auditing: { label: 'Аудит',      cls: 'bg-yellow-900 text-yellow-300' },
  fixing:   { label: 'Доработка',  cls: 'bg-orange-900 text-orange-300' },
  done:     { label: 'Готово',     cls: 'bg-green-900 text-green-300' },
  error:    { label: 'Ошибка',     cls: 'bg-red-900 text-red-300' },
};

function blockStatus(st) {
  return BLOCK_STATUS[st] || { label: st || '?', cls: 'bg-gray-700 text-gray-400' };
}

const STAGE_LABELS = {
  stage0: 'Stage 0: Анализ конкурентов',
  stage1: 'Stage 1: Entity / Intent / Community',
  stage2: 'Stage 2: Taxonomy + LSI routing',
  stage3: 'Stage 3: Генерация контента',
  stage4: 'Stage 4: E-E-A-T аудит',
  stage5: 'Stage 5: PQ-рефайн',
  stage6: 'Stage 6: LSI-инъекция',
  stage7: 'Stage 7: Глобальный аудит',
  done:   '✓ Завершено',
};

const stageLabel = computed(() => STAGE_LABELS[stage.value] || stage.value);

// Процент выполненных блоков
const blocksTotal = computed(() => blockList.value.length);
const blocksDone  = computed(() => blockList.value.filter(b => b.status === 'done').length);

// ── Pause / Resume ────────────────────────────────────────────────────────
async function handlePause() {
  if (pausing.value) return;
  pausing.value = true;
  try {
    await store.pauseTask(taskId);
    pushLog({ ts: ts(), msg: '⏸ Запрос на остановку отправлен...', level: 'warn' });
  } catch (e) {
    pausing.value = false;
    pushLog({ ts: ts(), msg: `Ошибка остановки: ${e.response?.data?.error || e.message}`, level: 'error' });
  }
}

async function handleResume() {
  if (resuming.value) return;
  resuming.value = true;
  paused.value   = false;
  failed.value   = false;
  try {
    await store.resumeTask(taskId);
    pushLog({ ts: ts(), msg: '▶ Возобновляем задачу...', level: 'info' });
    // Reconnect SSE after a short delay so the new job has time to start
    setTimeout(() => {
      connectSSE();
      startGenerationTimer();
    }, 1500);
  } catch (e) {
    resuming.value = false;
    paused.value   = true;
    pushLog({ ts: ts(), msg: `Ошибка возобновления: ${e.response?.data?.error || e.message}`, level: 'error' });
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

// Track last-seen task_log id — passed to /logs?after= and to SSE reconnects
// so we don't re-replay history we already have.
const lastLogId = ref(0);

function _formatHistoryTs(ts) {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    return d.toTimeString().substring(0, 8);
  } catch { return '--:--:--'; }
}

// Преобразует строку из task_logs в формат, который понимает handleSSEMessage:
// {type, msg, level, ts, ...payload}.
function _logRowToEvent(row) {
  const base = { type: row.event_type || 'log', ts: _formatHistoryTs(row.ts) };
  if (row.message) base.msg = row.message;
  if (row.level)   base.level = row.level;
  if (row.stage)   base.stage = row.stage;
  if (row.payload && typeof row.payload === 'object') {
    Object.assign(base, row.payload);
  }
  return base;
}

async function loadHistory() {
  try {
    const rows = await store.fetchTaskLogs(taskId, { after: lastLogId.value || undefined, limit: 2000 });
    if (!Array.isArray(rows) || !rows.length) return;
    for (const row of rows) {
      // Восстанавливаем события через тот же handler, что и live-SSE,
      // — поэтому progress / blocks / tokens / done тоже корректно
      // ресторятся, не только log-сообщения.
      handleSSEMessage(_logRowToEvent(row));
      if (row.id && row.id > lastLogId.value) lastLogId.value = row.id;
    }
  } catch (e) {
    // Не блокируем UI при отсутствии истории — просто логируем.
    console.warn('[Monitor] history load failed:', e?.message || e);
  }
}

onMounted(async () => {
  task.value = await store.fetchTask(taskId).catch(() => null);
  // Restore paused state from task status
  if (task.value?.status === 'paused') {
    paused.value = true;
  } else if (task.value?.status === 'failed') {
    failed.value = true;
  }
  // Сначала подмёрджим историю (чтобы log-терминал и таблица блоков были
  // заполнены), потом откроем SSE — он продолжит дописывать живые события.
  await loadHistory();
  connectSSE();
});

onUnmounted(() => {
  closeSSE();
  stopGenerationTimer();
});
</script>

<template>
  <div class="min-h-screen bg-gray-950">

    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center gap-4">
      <RouterLink to="/dashboard" class="btn-ghost text-xs">← Кабинет</RouterLink>
      <span class="text-white font-semibold truncate max-w-md">
        {{ task?.input_target_service || 'Мониторинг задачи' }}
      </span>

      <!-- LLM-провайдер бейдж -->
      <span
        v-if="task?.llm_provider"
        class="badge ml-auto"
        :class="task.llm_provider === 'grok' ? 'bg-purple-900 text-purple-300' : 'bg-blue-900 text-blue-300'"
        :title="`Генерация через ${task.llm_provider === 'grok' ? 'xAI Grok' : 'Google Gemini'}`"
      >{{ task.llm_provider === 'grok' ? 'Grok' : 'Gemini' }}</span>

      <!-- Статус-бейдж -->
      <span v-if="done"   class="badge bg-green-900 text-green-300" :class="{ 'ml-auto': !task?.llm_provider }">✓ Завершено</span>
      <span v-else-if="failed" class="badge bg-red-900 text-red-300" :class="{ 'ml-auto': !task?.llm_provider }">✗ Ошибка</span>
      <span v-else class="badge bg-indigo-900 text-indigo-300 animate-pulse" :class="{ 'ml-auto': !task?.llm_provider }">⚙ Выполняется</span>
    </header>

    <main class="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-5">

      <!-- ── Левая колонка ─────────────────────────────────────────── -->
      <div class="lg:col-span-1 space-y-5">

        <!-- Прогресс -->
        <div class="card">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Прогресс</p>
          <div class="flex items-center justify-between mb-2">
            <span class="text-2xl font-bold text-white">{{ progress }}%</span>
            <span class="text-xs text-indigo-400 text-right max-w-[140px] leading-tight">{{ stageLabel }}</span>
          </div>
          <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              class="h-full bg-indigo-500 rounded-full transition-all duration-500"
              :style="{ width: progress + '%' }"
            />
          </div>
          <!-- Прогресс блоков -->
          <p v-if="blocksTotal > 0" class="text-xs text-gray-600 mt-2">
            Блоков: {{ blocksDone }} / {{ blocksTotal }}
          </p>
          <!-- Время генерации -->
          <p v-if="generationTimeFormatted" class="text-xs mt-2 flex items-center gap-1.5">
            <span class="text-gray-500">⏱ Время:</span>
            <span :class="done ? 'text-green-400' : 'text-indigo-400 animate-pulse'">{{ generationTimeFormatted }}</span>
          </p>
        </div>

        <!-- Токены (реактивно обновляются через SSE {type:"tokens"}) -->
        <div class="card space-y-3">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Расход токенов</p>

          <!-- DeepSeek -->
          <div class="bg-gray-800 rounded-lg p-3">
            <p class="text-xs font-semibold text-gray-300 mb-1.5">DeepSeek Chat</p>
            <div class="grid grid-cols-2 gap-1 text-xs font-mono">
              <span class="text-gray-500">In:</span>
              <span class="text-right text-gray-300">{{ tokens.deepseekIn.toLocaleString() }}</span>
              <span class="text-gray-500">Out:</span>
              <span class="text-right text-gray-300">{{ tokens.deepseekOut.toLocaleString() }}</span>
              <span class="text-gray-500">Cost:</span>
              <span class="text-right text-indigo-300">${{ tokens.deepseekCost.toFixed(4) }}</span>
            </div>
          </div>

          <!-- Gemini -->
          <div class="bg-gray-800 rounded-lg p-3">
            <p class="text-xs font-semibold text-gray-300 mb-1.5">Gemini 3.1 Pro</p>
            <div class="grid grid-cols-2 gap-1 text-xs font-mono">
              <span class="text-gray-500">In:</span>
              <span class="text-right text-gray-300">{{ tokens.geminiIn.toLocaleString() }}</span>
              <span class="text-gray-500">Out:</span>
              <span class="text-right text-gray-300">{{ tokens.geminiOut.toLocaleString() }}</span>
              <span class="text-gray-500">Cost:</span>
              <span class="text-right text-indigo-300">${{ tokens.geminiCost.toFixed(4) }}</span>
            </div>
          </div>

          <!-- Итого -->
          <div class="flex items-center justify-between pt-1 border-t border-gray-700 text-sm">
            <span class="text-gray-500">Итого</span>
            <div class="text-right">
              <div class="font-bold text-white">${{ totalCost }}</div>
              <div class="text-xs text-gray-600 font-mono">{{ totalTokens.toLocaleString() }} tok</div>
            </div>
          </div>
        </div>

        <!-- Блоки H2 -->
        <div class="card" v-if="blockList.length">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
            Блоки контента ({{ blockList.length }})
          </p>
          <div class="space-y-1.5">
            <div
              v-for="b in blockList"
              :key="b.idx"
              class="flex items-start gap-2 text-xs"
            >
              <span :class="['badge flex-shrink-0 mt-0.5', blockStatus(b.status).cls]">
                {{ blockStatus(b.status).label }}
              </span>
              <div class="min-w-0">
                <p class="text-gray-300 truncate">{{ b.h2 }}</p>
                <p v-if="b.status === 'done'" class="text-gray-600 mt-0.5">
                  LSI {{ b.lsi }}% · PQ {{ b.pq }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Кнопка перехода к результатам (если задача уже завершена) -->
        <div v-if="done" class="card">
          <button
            @click="showResult = true"
            class="btn w-full text-center block"
          >
            Открыть результаты →
          </button>
        </div>

        <!-- Кнопка "Стоп" — видна когда задача выполняется -->
        <div v-if="!done && !failed && !paused" class="card">
          <button
            @click="handlePause"
            :disabled="pausing"
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            :class="pausing
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-red-900/60 hover:bg-red-800 text-red-300 border border-red-700'"
          >
            <span v-if="pausing" class="w-3 h-3 rounded-full bg-red-500 animate-pulse inline-block" />
            <span v-else>⬛</span>
            <span>{{ pausing ? 'Останавливаем...' : 'Стоп' }}</span>
          </button>
        </div>

        <!-- Кнопка "Продолжить" — видна при paused или failed -->
        <div v-if="paused || failed" class="card space-y-2">
          <button
            @click="handleResume"
            :disabled="resuming"
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            :class="resuming
              ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
              : 'bg-green-900/60 hover:bg-green-800 text-green-300 border border-green-700'"
          >
            <span v-if="resuming" class="w-3 h-3 rounded-full bg-green-500 animate-pulse inline-block" />
            <span v-else>▶</span>
            <span>{{ resuming ? 'Возобновляем...' : 'Продолжить' }}</span>
          </button>
          <p v-if="paused && blocksTotal > 0" class="text-xs text-center text-gray-600">
            Готово {{ blocksDone }} из {{ blocksTotal }} блоков
          </p>
        </div>

        <!-- Ошибка -->
        <div v-if="failed && !paused" class="card border border-red-800">
          <p class="text-sm font-semibold text-red-400 mb-2">Задача завершилась с ошибкой</p>
          <p class="text-xs text-gray-500">Нажмите «Продолжить» чтобы возобновить, или вернитесь в кабинет.</p>
          <RouterLink to="/dashboard" class="btn mt-3 block text-center w-full">
            ← Вернуться в кабинет
          </RouterLink>
        </div>
      </div>

      <!-- ── Правая колонка: лог-терминал ──────────────────────────── -->
      <div class="lg:col-span-2">
        <div class="card p-0 overflow-hidden h-full flex flex-col" style="min-height: 520px">

          <!-- Заголовок терминала -->
          <div class="flex items-center gap-2 px-4 py-2.5 bg-gray-800/60 border-b border-gray-800">
            <div class="w-3 h-3 rounded-full bg-red-500"/>
            <div class="w-3 h-3 rounded-full bg-yellow-500"/>
            <div class="w-3 h-3 rounded-full bg-green-500"/>
            <span class="text-xs text-gray-500 ml-2 font-mono">
              pipeline.log — {{ logs.length }} строк
            </span>
            <!-- Индикатор реконнекта -->
            <span v-if="reconnectCount > 0 && !done && !failed"
              class="ml-auto text-xs text-yellow-500 font-mono animate-pulse">
              реконнект {{ reconnectCount }}/{{ MAX_RECONNECT }}
            </span>
          </div>

          <!-- Лог -->
          <div
            ref="logContainer"
            class="flex-1 overflow-y-auto p-4 font-mono text-xs"
            style="max-height: 560px"
          >
            <div v-if="!logs.length" class="text-gray-600 italic">
              Ожидание SSE-потока...
            </div>
            <div
              v-for="(line, idx) in logs"
              :key="idx"
              :class="['flex gap-2 leading-relaxed', getLogClass(line.level)]"
            >
              <span class="text-gray-700 flex-shrink-0 select-none">{{ line.ts }}</span>
              <span v-html="line.msg" class="break-all"/>
            </div>
          </div>

          <!-- Футер терминала -->
          <div class="px-4 py-2.5 border-t border-gray-800 bg-gray-800/40 text-xs text-gray-500 flex items-center gap-2">
            <span v-if="!done && !failed && reconnectCount === 0"
              class="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block"/>
            <span v-else-if="!done && !failed && reconnectCount > 0"
              class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse inline-block"/>
            <span v-else-if="done"  class="w-2 h-2 rounded-full bg-green-400 inline-block"/>
            <span v-else            class="w-2 h-2 rounded-full bg-red-400 inline-block"/>
            <span v-if="done">Генерация завершена</span>
            <span v-else-if="failed">Задача завершилась с ошибкой</span>
            <span v-else-if="reconnectCount > 0">SSE: восстановление соединения...</span>
            <span v-else>Live — SSE подключён</span>
          </div>
        </div>
      </div>

    </main>

    <!-- Модалка результатов -->
    <ResultModal
      :task-id="taskId"
      :visible="showResult"
      @close="showResult = false"
    />
  </div>
</template>
