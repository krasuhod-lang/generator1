<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import DOMPurify from 'dompurify';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';
import { useAuthStore } from '../stores/auth.js';
import { useLinkArticleStore } from '../stores/linkArticle.js';

const store = useLinkArticleStore();
const auth  = useAuthStore();

// ── Форма ────────────────────────────────────────────────────────────
const form = ref({
  topic:         '',
  anchor_text:   '',
  anchor_url:    '',
  focus_notes:   '',
  output_format: 'html',
});
const submitting = ref(false);
const formError  = ref(null);

const DRAFT_KEY = 'link_article_draft_v1';
onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
});
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

function isValidUrl(u) {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function handleCreate() {
  formError.value = null;
  const topic = form.value.topic.trim();
  if (topic.length < 5) {
    formError.value = 'Тема должна быть не короче 5 символов.';
    return;
  }
  if (!form.value.anchor_text.trim()) {
    formError.value = 'Укажите текст анкора.';
    return;
  }
  if (!isValidUrl(form.value.anchor_url.trim())) {
    formError.value = 'Укажите корректную ссылку (http:// или https://).';
    return;
  }
  submitting.value = true;
  try {
    saveDraft();
    const id = await store.createTask({
      topic,
      anchor_text:   form.value.anchor_text.trim(),
      anchor_url:    form.value.anchor_url.trim(),
      focus_notes:   form.value.focus_notes.trim(),
      output_format: form.value.output_format,
    });
    await store.fetchTasks();
    if (id) {
      await selectTask(id);
    }
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

// ── Список задач + polling ──────────────────────────────────────────
let pollTimer = null;
onMounted(async () => {
  await store.fetchTasks();
  pollTimer = setInterval(() => {
    if (store.tasks.some((t) => t.status === 'queued' || t.status === 'running')) {
      store.fetchTasks();
    }
  }, 5000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  closeStream();
});

async function handleDelete(task) {
  if (!confirm(`Удалить задачу «${task.topic}»? Все результаты будут потеряны.`)) return;
  try {
    await store.deleteTask(task.id);
    if (selectedTask.value?.id === task.id) {
      selectedTask.value = null;
      closeStream();
    }
  } catch (err) {
    alert(err.response?.data?.error || 'Ошибка удаления');
  }
}

function statusBadgeClass(status) {
  switch (status) {
    case 'done':    return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'running': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'queued':  return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'error':   return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:        return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(s) {
  return ({ queued: 'В очереди', running: 'Генерация', done: 'Готово', error: 'Ошибка' })[s] || s;
}
function stageLabel(s) {
  return ({
    pre_stage0:                 'Стратегический анализ',
    stage0_audience:            'Анализ ЦА',
    stage1_intents:             'Сущности и интенты',
    stage1b_whitespace:         'White-space анализ',
    stage2_structure:           'Структура статьи',
    stage3_writer:              'Написание статьи',
    stage5_eeat_audit:          'E-E-A-T аудит',
    stage3_writer_eeat_refine:  'E-E-A-T улучшение',
    stage4_image_prompts:       'Промпты изображений',
    image_generation:           'Генерация изображений',
    done:                       'Готово',
  })[s] || s || '—';
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
function formatCost(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '$0.0000';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// ── Детали активной задачи + SSE ────────────────────────────────────
const selectedTask = ref(null);
const streamEvents = ref([]);
let   eventSource  = null;

function closeStream() {
  if (eventSource) {
    try { eventSource.close(); } catch (_) { /* no-op */ }
    eventSource = null;
  }
}

async function selectTask(id) {
  closeStream();
  streamEvents.value = [];
  try {
    selectedTask.value = await store.getTask(id);
  } catch (err) {
    alert(err.response?.data?.error || 'Не удалось загрузить задачу');
    return;
  }

  // SSE поток — для running/queued задач
  if (selectedTask.value && (selectedTask.value.status === 'running' || selectedTask.value.status === 'queued')) {
    openStreamFor(id);
  }
}

function openStreamFor(id) {
  try {
    const token = auth.token || localStorage.getItem('seo_token') || '';
    // EventSource не поддерживает заголовки — прокидываем токен в query string;
    // backend auth-middleware на этом роуте читает Authorization, поэтому для SSE
    // мы используем fallback: передаём Bearer-токен через ?token= параметр.
    // (Если backend не поддерживает — SSE просто упадёт, а polling задачи продолжит работать.)
    const url = `/api/link-article/${id}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    eventSource = es;
    es.onmessage = (ev) => {
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch (_) { parsed = { type: 'raw', data: ev.data }; }
      streamEvents.value.push(parsed);
      if (streamEvents.value.length > 200) streamEvents.value.splice(0, streamEvents.value.length - 200);

      // Если пришёл статус — обновляем локальную копию и перечитываем при завершении
      if (parsed?.type === 'status') {
        if (selectedTask.value) selectedTask.value.status = parsed.status;
        if (parsed.status === 'done' || parsed.status === 'error') {
          store.getTask(id).then((t) => { if (t) selectedTask.value = t; }).catch(() => {});
          store.fetchTasks();
          closeStream();
        }
      }
      if (parsed?.type === 'stage' && selectedTask.value) {
        selectedTask.value.current_stage = parsed.stage;
        selectedTask.value.progress_pct  = parsed.progress;
      }
    };
    es.onerror = () => {
      // Не спамим алертами; polling отловит финальный статус
      closeStream();
    };
  } catch (err) {
    console.warn('[linkArticle] SSE init failed:', err.message);
  }
}

// Обновляем полный объект задачи при polling
watch(() => store.tasks, (arr) => {
  if (!selectedTask.value) return;
  const fresh = arr.find((t) => t.id === selectedTask.value.id);
  if (fresh && fresh.status !== selectedTask.value.status) {
    store.getTask(selectedTask.value.id).then((t) => {
      if (t) selectedTask.value = { ...selectedTask.value, ...t };
    }).catch(() => {});
  }
}, { deep: true });

// ── Preview + Copy ──────────────────────────────────────────────────
const articlePreviewRef = ref(null);

const sanitizedHtml = computed(() => {
  const html = selectedTask.value?.article_html || '';
  if (!html) return '';
  // DOMPurify-ALLOWED_URI_REGEXP намеренно допускает data:image/(png|jpeg|jpg|webp);base64,…
  // для base64 изображений от Nano Banana Pro. Эта конфигурация применяется
  // ИСКЛЮЧИТЕЛЬНО к article_html, сгенерированной нашим бэкендом и видимой
  // только владельцу задачи (user_id-check в контроллере). Никакого
  // user-controlled HTML, который проходил бы через этот sanitize, нет.
  //
  // ВАЖНО: data:image/...;base64,… — отдельная ветка регулярки (без
  // требования закрывающего «:»), потому что реальный data-URI заканчивается
  // на «,DATA», а не на «:». Старый regex требовал «data:image/png;base64:»
  // и поэтому DOMPurify вырезал ВСЕ изображения статей.
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpeg|jpg|webp);base64,|(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
});

async function copyAsHtml() {
  const html = selectedTask.value?.article_html;
  if (!html) return;
  const plain = selectedTask.value?.article_plain || html.replace(/<[^>]+>/g, ' ');

  // Path A: Async Clipboard API + ClipboardItem (secure context only).
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const blobHtml  = new Blob([html],  { type: 'text/html' });
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobPlain }),
      ]);
      flashToast('HTML скопирован в буфер обмена');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // Path B: writeText (secure context only, но без ClipboardItem).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(html);
      flashToast('HTML скопирован как текст (вставьте в режиме «Текст» редактора)');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // Path C (legacy): document.execCommand('copy') через скрытый textarea.
  // Единственный способ копирования на HTTP / по IP-адресу без secure context.
  try {
    const ta = document.createElement('textarea');
    ta.value = html;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      flashToast('HTML скопирован как текст (вставьте в режиме «Текст» редактора)');
      return;
    }
    throw new Error('execCommand copy вернул false');
  } catch (err) {
    alert('Не удалось скопировать HTML: ' + (err.message || err));
  }
}

async function copyAsFormattedText() {
  if (!selectedTask.value) return;
  // Копируем отрендеренный узел — это обеспечит «богатое» поведение при вставке в
  // WYSIWYG-редакторы бирж (sape/miralinks/gogetlinks).
  //
  // ВАЖНО: для совместимости с биржевыми WYSIWYG (TinyMCE / CKEditor /
  // Trumbowyg / contenteditable-on-steroids) приоритет — selection-based copy
  // (Range + execCommand('copy')). Браузер сам сериализует выделение в
  // multi-part clipboard payload и встраивает каждый <img src="data:…">
  // как отдельный image-part, который редакторы корректно принимают как
  // встроенное изображение.
  //
  // ClipboardItem({'text/html': data:image/...}) — оставлен как fallback:
  // он быстрее и работает в Word/Google Docs, но ряд биржевых редакторов
  // парсит data:-URL'ы как голый текст и теряет картинки. Поэтому он —
  // именно fallback для случаев, когда selection-based copy недоступен.
  await nextTick();
  const el = articlePreviewRef.value;
  if (!el) return;

  // ── Path A (приоритет): selection-based copy через execCommand. ─────
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    if (ok) {
      flashToast('Форматированный текст скопирован');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // ── Path B (fallback): Async Clipboard API + ClipboardItem. ─────────
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const htmlContent = el.innerHTML;
      const plain = selectedTask.value.article_plain || el.innerText || '';
      const blobHtml  = new Blob([htmlContent], { type: 'text/html' });
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobPlain }),
      ]);
      flashToast('Форматированный текст скопирован (fallback)');
      return;
    }
  } catch (err) {
    alert('Не удалось скопировать: ' + (err.message || err));
  }
}

function downloadImage(img, idx) {
  if (!img?.image_base64) return;
  try {
    const a = document.createElement('a');
    a.href = `data:${img.mime_type || 'image/png'};base64,${img.image_base64}`;
    a.download = `link-article-image-${idx + 1}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    alert('Ошибка скачивания: ' + err.message);
  }
}

// ── Toast ───────────────────────────────────────────────────────────
const toastMsg = ref('');
let toastTimer = null;
function flashToast(msg) {
  toastMsg.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2500);
}

const renderedImages = computed(() => {
  const arr = Array.isArray(selectedTask.value?.image_prompts) ? selectedTask.value.image_prompts : [];
  return arr.filter((p) => p.status === 'done' && p.image_base64);
});

// ── E-E-A-T audit projection ─────────────────────────────────────────
// Бэкенд кладёт total_score в `eeat_score` (NUMERIC) и полный аудит в
// `eeat_audit` (JSONB). pg возвращает NUMERIC как строку — приводим вручную.
const eeatScore = computed(() => {
  const raw = selectedTask.value?.eeat_score;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});
const eeatVerdict = computed(() => selectedTask.value?.eeat_audit?.verdict || '');
const eeatIssuesCount = computed(() => {
  const issues = selectedTask.value?.eeat_audit?.issues;
  return Array.isArray(issues) ? issues.length : 0;
});
const eeatBadgeClass = computed(() => {
  const s = eeatScore.value;
  if (s == null) return 'border-gray-700 bg-gray-900/40 text-gray-300';
  if (s >= 8.0)  return 'border-emerald-700 bg-emerald-900/30 text-emerald-200';
  if (s >= 7.5)  return 'border-lime-700 bg-lime-900/30 text-lime-200';
  if (s >= 6.0)  return 'border-amber-700 bg-amber-900/30 text-amber-200';
  return 'border-red-700 bg-red-900/30 text-red-200';
});

const hasResult = computed(() => !!selectedTask.value?.article_html);
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Шапка -->
      <div class="flex items-end justify-between border-b border-gray-800 pb-4">
        <div>
          <h1 class="text-2xl font-bold text-white flex items-center gap-2">
            🔗 Генератор ссылочной статьи
          </h1>
          <p class="text-gray-400 text-sm mt-1">
            Статья для внешних площадок (sape / miralinks / gogetlinks) с естественной ссылкой
            и 3 изображениями от Nano Banana Pro. Изображения встроены в HTML как base64 —
            копируются вместе с текстом без внешнего хостинга.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Форма (слева) ── -->
        <form @submit.prevent="handleCreate" class="card space-y-4 lg:col-span-5">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая статья</h2>

          <div>
            <label class="label">Тема статьи</label>
            <input v-model="form.topic" type="text" class="input"
                   placeholder="Например: Оформление ВНЖ в Португалии по D7" />
          </div>

          <div>
            <label class="label">Анкор (как будет подсвечено в тексте)</label>
            <input v-model="form.anchor_text" type="text" class="input"
                   placeholder="купить ВНЖ Португалии под ключ" />
          </div>

          <div>
            <label class="label">Ссылка анкора (URL)</label>
            <input v-model="form.anchor_url" type="url" class="input"
                   placeholder="https://example.com/landing" />
          </div>

          <div>
            <label class="label">На что делаем упор / ключевые акценты</label>
            <textarea v-model="form.focus_notes" rows="4" class="textarea"
                      placeholder="Например: опыт 7 лет, сопровождение в Лиссабоне, упор на бизнес-иммиграцию..."></textarea>
          </div>

          <div>
            <label class="label">Формат вывода</label>
            <div class="flex gap-4 text-sm text-gray-300">
              <label class="inline-flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="form.output_format" value="html" class="accent-indigo-500" />
                HTML
              </label>
              <label class="inline-flex items-center gap-2 cursor-pointer">
                <input type="radio" v-model="form.output_format" value="formatted_text" class="accent-indigo-500" />
                Форматированный текст
              </label>
            </div>
            <p class="text-[11px] text-gray-500 mt-1">
              Оба формата генерируются одновременно — переключатель влияет только на то, какой
              из них предлагается по умолчанию для копирования.
            </p>
          </div>

          <div v-if="formError"
               class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
            {{ formError }}
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button type="submit" class="btn-primary" :disabled="submitting">
              {{ submitting ? '⏳ Создание...' : '🚀 Сгенерировать статью' }}
            </button>
          </div>
        </form>

        <!-- ── Лента задач (справа) ── -->
        <div class="card space-y-3 lg:col-span-7">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📚 Мои задачи</h2>
            <button class="btn-ghost text-xs" @click="store.fetchTasks()">Обновить</button>
          </div>

          <div v-if="store.loading && store.tasks.length === 0" class="text-sm text-gray-500">Загрузка…</div>
          <div v-else-if="store.tasks.length === 0" class="text-sm text-gray-500">
            Пока нет задач. Заполните форму и нажмите «Сгенерировать».
          </div>

          <ul v-else class="divide-y divide-gray-800 -mx-1">
            <li v-for="t in store.tasks" :key="t.id"
                class="px-1 py-2 flex items-center gap-3 cursor-pointer hover:bg-gray-800/40 rounded"
                :class="{ 'bg-gray-800/50': selectedTask?.id === t.id }"
                @click="selectTask(t.id)">
              <div class="flex-1 min-w-0">
                <div class="text-sm text-gray-200 truncate">{{ t.topic }}</div>
                <div class="text-[11px] text-gray-500 mt-0.5">
                  {{ formatDate(t.created_at) }} · {{ formatCost(t.cost_usd) }}
                </div>
              </div>
              <span class="text-[11px] px-2 py-0.5 rounded uppercase tracking-wider"
                    :class="statusBadgeClass(t.status)">
                {{ statusLabel(t.status) }}
              </span>
              <button class="btn-ghost text-xs px-2"
                      @click.stop="handleDelete(t)"
                      title="Удалить">✕</button>
            </li>
          </ul>
        </div>
      </div>

      <!-- ── Активная задача ── -->
      <section v-if="selectedTask" class="card space-y-4">
        <header class="flex items-center justify-between gap-3 border-b border-gray-800 pb-3">
          <div class="min-w-0">
            <div class="text-xs text-gray-500">Задача</div>
            <h2 class="text-lg font-bold text-white truncate">{{ selectedTask.topic }}</h2>
            <div class="text-[11px] text-gray-500 mt-0.5">
              Анкор: <span class="text-gray-300">{{ selectedTask.anchor_text }}</span>
              → <a :href="selectedTask.anchor_url" target="_blank" rel="noopener"
                   class="text-indigo-400 hover:underline break-all">{{ selectedTask.anchor_url }}</a>
            </div>
          </div>
          <span class="text-[11px] px-2 py-0.5 rounded uppercase tracking-wider shrink-0"
                :class="statusBadgeClass(selectedTask.status)">
            {{ statusLabel(selectedTask.status) }}
          </span>
        </header>

        <!-- Прогресс -->
        <div v-if="selectedTask.status === 'running' || selectedTask.status === 'queued'" class="space-y-2">
          <div class="flex justify-between items-center text-xs text-gray-400">
            <span>{{ stageLabel(selectedTask.current_stage) }}</span>
            <span>{{ selectedTask.progress_pct || 0 }}%</span>
          </div>
          <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div class="bg-indigo-500 h-2 transition-all duration-500"
                 :style="{ width: `${Math.min(100, selectedTask.progress_pct || 0)}%` }"></div>
          </div>
          <div v-if="streamEvents.length" class="text-[11px] text-gray-500 max-h-28 overflow-auto font-mono leading-tight">
            <div v-for="(ev, i) in streamEvents.slice(-8)" :key="i">
              <template v-if="ev.type === 'log'">· {{ ev.msg }}</template>
              <template v-else-if="ev.type === 'stage'">→ {{ stageLabel(ev.stage) }} ({{ ev.progress }}%)</template>
              <template v-else-if="ev.type === 'status'">◆ статус: {{ statusLabel(ev.status) }}</template>
            </div>
          </div>
        </div>

        <!-- Ошибка -->
        <div v-if="selectedTask.status === 'error' && selectedTask.error_message"
             class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
          <div class="font-semibold mb-1">Генерация завершилась с ошибкой</div>
          <div class="text-red-200 text-xs whitespace-pre-wrap">{{ selectedTask.error_message }}</div>
        </div>

        <!-- Результат -->
        <div v-if="hasResult" class="space-y-4">
          <!-- E-E-A-T badge (если аудит выполнен) -->
          <div v-if="eeatScore !== null"
               class="flex items-center gap-3 px-3 py-2 rounded-lg border"
               :class="eeatBadgeClass">
            <span class="text-[11px] uppercase tracking-wider opacity-80">E-E-A-T</span>
            <span class="text-base font-bold">{{ eeatScore.toFixed(1) }} / 10</span>
            <span v-if="eeatVerdict" class="text-[11px] uppercase opacity-80">· {{ eeatVerdict }}</span>
            <span v-if="eeatIssuesCount > 0" class="text-[11px] opacity-80">· {{ eeatIssuesCount }} замечан.</span>
          </div>

          <!-- Кнопки копирования -->
          <div class="flex flex-wrap gap-2">
            <button class="btn-primary" @click="copyAsHtml">
              📋 Скопировать как HTML
            </button>
            <button class="btn-ghost border border-gray-700" @click="copyAsFormattedText">
              📝 Скопировать как форматированный текст
            </button>
          </div>

          <!-- Preview -->
          <article ref="articlePreviewRef"
                   class="prose prose-invert max-w-none bg-gray-950 border border-gray-800 rounded-lg p-5 overflow-auto"
                   v-html="sanitizedHtml"></article>

          <!-- Галерея изображений -->
          <div v-if="renderedImages.length" class="space-y-2">
            <h3 class="text-sm font-semibold text-indigo-300 uppercase tracking-wider">🖼 Изображения</h3>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div v-for="(img, idx) in renderedImages" :key="img.slot || idx"
                   class="bg-gray-950 border border-gray-800 rounded-lg p-2 space-y-2">
                <img :src="`data:${img.mime_type || 'image/png'};base64,${img.image_base64}`"
                     :alt="img.alt_ru || ''"
                     class="w-full h-40 object-cover rounded" />
                <div class="text-[11px] text-gray-400 truncate" :title="img.alt_ru">{{ img.alt_ru || '—' }}</div>
                <button class="btn-ghost text-xs w-full border border-gray-700"
                        @click="downloadImage(img, idx)">
                  ⬇ Скачать PNG
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Toast -->
    <div v-if="toastMsg"
         class="fixed bottom-6 right-6 bg-emerald-900/80 border border-emerald-700 text-emerald-100 text-sm px-4 py-2 rounded-lg shadow-xl z-50">
      {{ toastMsg }}
    </div>
  </AppLayout>
</template>
