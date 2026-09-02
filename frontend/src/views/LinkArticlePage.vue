<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import DOMPurify from 'dompurify';
import AppLayout from '../components/AppLayout.vue';
import LlmProviderSelector from '../components/LlmProviderSelector.vue';
import LlmModelSelector from '../components/LlmModelSelector.vue';
import ProjectPicker from '../components/ProjectPicker.vue';
import ToolHelp from '../components/ToolHelp.vue';
import AppPageHeader from '../components/AppPageHeader.vue';
import api from '../api.js';
import { useAuthStore } from '../stores/auth.js';
import { useLinkArticleStore } from '../stores/linkArticle.js';
import { filterAndSortTasks, groupTasksByDate, isTaskActiveStatus } from '../utils/taskHistory.js';

const store = useLinkArticleStore();
const auth  = useAuthStore();
const route = useRoute();
const isClient = computed(() => !auth.user || String(auth.user.role || '').toLowerCase() === 'client');

// История задач: фильтруем локально по уже загруженным server-side страницам.
const historySearch = ref('');
const historyStatus = ref('all');
const historySort = ref('newest');
const filteredTasks = computed(() => filterAndSortTasks(store.tasks, {
  search: historySearch.value,
  status: historyStatus.value,
  sort: historySort.value,
}));
const taskGroups = computed(() => groupTasksByDate(filteredTasks.value));
const historyStats = computed(() => {
  const tasks = Array.isArray(store.tasks) ? store.tasks : [];
  return {
    total: store.total || tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
    active: tasks.filter((task) => isTaskActiveStatus(task.status)).length,
    errors: tasks.filter((task) => ['error', 'timeout'].includes(task.status)).length,
  };
});
function clearHistoryFilters() {
  historySearch.value = '';
  historyStatus.value = 'all';
  historySort.value = 'newest';
}

// ── Форма ────────────────────────────────────────────────────────────
const form = ref({
  topic:         '',
  anchor_text:   '',
  anchor_url:    '',
  focus_notes:   '',
  output_format: 'html',
  llm_provider:  'gemini',
  llm_model:     'gemini-3.1-pro-preview',
  gemini_model:  'gemini-3.1-pro-preview',
});
const submitting = ref(false);
const formError  = ref(null);

// ── ProjectPicker (ТЗ §5/§8) ─────────────────────────────────────────
const PROJECT_ID_LS_KEY = 'link_article_project_id_v1';
const selectedProjectId = ref(null);
const selectedProject   = ref(null);
function handleProjectSelected(project) {
  selectedProject.value = project || null;
  try {
    if (selectedProjectId.value) localStorage.setItem(PROJECT_ID_LS_KEY, String(selectedProjectId.value));
    else localStorage.removeItem(PROJECT_ID_LS_KEY);
  } catch (_) { /* ignore */ }
}
function handleProjectFull(ctx) {
  if (!ctx) return;
  if (!form.value.anchor_url?.trim() && ctx.project?.site_url) {
    form.value.anchor_url = ctx.project.site_url;
  }
}

const DRAFT_KEY = 'link_article_draft_v1';
onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
  try {
    const pid = localStorage.getItem(PROJECT_ID_LS_KEY);
    if (pid) {
      const n = Number(pid);
      selectedProjectId.value = Number.isInteger(n) && n > 0 ? n : pid;
    }
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
      llm_provider:  form.value.llm_provider,
      llm_model:     form.value.llm_model,
      gemini_model:  form.value.gemini_model,
      project_id:    selectedProjectId.value || null,
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
  // Deep-link из проекта/центра задач: открываем задачу тем же путём, что и клик.
  try {
    const openId = route.query && route.query.open;
    const id = Array.isArray(openId) ? openId[0] : openId;
    if (id && typeof id === 'string') await selectTask(id);
  } catch (_) { /* no-op */ }
  pollTimer = setInterval(() => {
    if (store.tasks.some((t) => isTaskActiveStatus(t.status))) {
      store.fetchTasks();
    }
  }, 5000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  closeStream();
});

async function handleDelete(task) {
  if (!confirm(`Переместить задачу «${task.topic}» в архив? Текст, изображения и история сохранятся.`)) return;
  try {
    await store.deleteTask(task.id);
    if (String(selectedTask.value?.id || selectedTaskId.value) === String(task.id)) {
      selectedTask.value = null;
      selectedTaskId.value = '';
      selectedTaskError.value = '';
      closeStream();
    }
  } catch (err) {
    alert(err.response?.data?.error || 'Ошибка удаления');
  }
}

function statusBadgeClass(status, task = null) {
  if (task?.archived_at) return 'bg-gray-800 text-gray-400 border border-gray-700';
  switch (status) {
    case 'done':    return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
    case 'running': case 'processing': case 'in_progress': return 'bg-sky-900/40 text-sky-300 border border-sky-800/60 animate-pulse';
    case 'queued': case 'pending': return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
    case 'partial': return 'bg-yellow-900/40 text-yellow-300 border border-yellow-800/60';
    case 'timeout': return 'bg-orange-900/40 text-orange-300 border border-orange-800/60';
    case 'error':   return 'bg-red-900/40 text-red-300 border border-red-800/60';
    default:        return 'bg-gray-800 text-gray-400 border border-gray-700';
  }
}
function statusLabel(s, task = null) {
  if (task?.archived_at) return 'В архиве';
  return ({ queued: 'В очереди', pending: 'Ожидает слота', running: 'Генерация', processing: 'Обработка', in_progress: 'Выполняется', partial: 'Частично', timeout: 'Тайм-аут', done: 'Готово', error: 'Ошибка' })[s] || s || 'Неизвестно';
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
    linguaforensic:             'LinguaForensic',
    meta_tags:                  'Мета-теги (GIST)',
    done:                       'Готово',
  })[s] || s || '—';
}
function formatDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('ru-RU'); } catch (_) { return String(d); }
}
function formatCost(v) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '$0.000000';
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`;
}
function taskStageLabel(task) {
  return stageLabel(task?.current_stage || task?.stage || task?.status);
}
function taskProgressLabel(task) {
  const value = Number(task?.progress_pct ?? task?.progress ?? NaN);
  return Number.isFinite(value) && value >= 0 ? `${Math.max(0, Math.min(100, Math.round(value)))}%` : '';
}
function taskQueueLabel(task) {
  const reason = String(task?.queue_reason || task?.queueReason || '').trim();
  if (reason === 'user_limit') return 'ожидает свободный слот';
  if (reason === 'waiting_for_publisher') return 'ожидает публикации job';
  if (reason === 'admitted') return 'слот свободен';
  return '';
}

// ── Детали активной задачи + SSE ────────────────────────────────────
const selectedTask = ref(null);
const selectedTaskId = ref('');
const streamEvents = ref([]);
let   eventSource  = null;

function closeStream() {
  if (eventSource) {
    try { eventSource.close(); } catch (_) { /* no-op */ }
    eventSource = null;
  }
}

const selectedTaskLoading = ref(false);
const selectedTaskError = ref('');
const selectedTaskSectionRef = ref(null);
let selectionRequestSeq = 0;

async function selectTask(id) {
  const requestSeq = ++selectionRequestSeq;
  closeStream();
  streamEvents.value = [];
  selectedTaskError.value = '';
  selectedTaskLoading.value = true;
  // Не оставляем старую статью на экране, пока открывается новая.
  selectedTask.value = null;
  selectedTaskId.value = String(id ?? '');

  try {
    const task = await store.getTask(id);
    if (requestSeq !== selectionRequestSeq) return;
    selectedTask.value = task;
    if (!task) {
      selectedTaskError.value = 'Выбранная задача не найдена. Обновите список и попробуйте ещё раз.';
      return;
    }

    // Панель результата находится ниже формы и списка. После её появления
    // переносим пользователя к ней, чтобы клик имел очевидный визуальный эффект.
    await nextTick();
    if (requestSeq !== selectionRequestSeq) return;
    selectedTaskSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // SSE поток — для running/queued задач; клиенту доступны только статус и результат.
    if (!isClient.value && isTaskActiveStatus(task.status)) {
      openStreamFor(id);
    }
  } catch (_) {
    if (requestSeq !== selectionRequestSeq) return;
    selectedTask.value = null;
    selectedTaskError.value = 'Не удалось открыть задачу. Обновите список и попробуйте ещё раз.';
  } finally {
    if (requestSeq === selectionRequestSeq) selectedTaskLoading.value = false;
  }
}

// Если router меняет query без размонтирования компонента, deep-link всё равно
// должен открыть новую задачу, а не оставлять старый результат.
watch(() => route.query.open, (openId, previousOpenId) => {
  if (openId === previousOpenId) return;
  const id = Array.isArray(openId) ? openId[0] : openId;
  if (id && typeof id === 'string') selectTask(id);
});

function openStreamFor(id) {
  if (isClient.value) return;
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
  const fresh = arr.find((t) => String(t.id) === String(selectedTask.value.id));
  if (fresh && (
    fresh.status !== selectedTask.value.status
    || fresh.updated_at !== selectedTask.value.updated_at
    || fresh.progress_pct !== selectedTask.value.progress_pct
    || Boolean(fresh.article_html || fresh.article_html_with_schema || fresh.article_plain)
      !== Boolean(selectedTask.value.article_html || selectedTask.value.article_html_with_schema || selectedTask.value.article_plain)
  )) {
    store.getTask(selectedTask.value.id).then((t) => {
      if (t) selectedTask.value = { ...selectedTask.value, ...t };
    }).catch(() => {});
  }
}, { deep: true });

// ── Preview + Copy ──────────────────────────────────────────────────
const articlePreviewRef = ref(null);
const LINK_ARTICLE_CONTENT_FIELDS = Object.freeze([
  // Новые и legacy-форматы сохранённых результатов. Порядок важен: schema
  // сохраняет полноценную публикационную HTML-версию, plain — последний fallback.
  'article_html_with_schema', 'article_html', 'content_html', 'html', 'article_content', 'content',
]);

const articleHtmlCandidates = computed(() => {
  const task = selectedTask.value || {};
  return LINK_ARTICLE_CONTENT_FIELDS
    .map((key) => task[key])
    .filter((value) => typeof value === 'string' && value.trim());
});

const articleSourceHtml = computed(() => articleHtmlCandidates.value[0] || '');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function plainTextToHtml(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  return text.split(/\n{2,}/).map((paragraph) =>
    `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
  ).join('');
}

const sanitizedHtml = computed(() => {
  const plain = selectedTask.value?.article_plain || selectedTask.value?.text || '';
  if (!articleHtmlCandidates.value.length && !plain.trim()) return '';
  for (const candidate of articleHtmlCandidates.value) {
    const cleaned = DOMPurify.sanitize(candidate, {
      ADD_ATTR: ['target'],
      ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpeg|jpg|webp);base64,|(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
    if (cleaned.trim()) return cleaned;
  }
  return plainTextToHtml(plain);
});

async function copyAsHtml() {
  const html = articleSourceHtml.value || plainTextToHtml(selectedTask.value?.article_plain || '');
  if (!html) return;

  // ВАЖНО: «Скопировать HTML» должна класть в буфер именно ИСХОДНЫЙ HTML
  // как plain-text, чтобы при вставке в WYSIWYG-редактор биржи / блог-движка
  // (sape, miralinks, gogetlinks, WordPress…) пользователь получил сам
  // HTML-код для вставки в режиме «Текст / HTML», а НЕ отрендеренный
  // «форматированный» вариант. Раньше регистрировался ClipboardItem с MIME
  // 'text/html' + 'text/plain' (стрипаный) — браузер при вставке в WYSIWYG
  // выбирал text/html и рендерил разметку, а вставка в plain-text режим
  // давала «полотно текста без html разметки». Для копирования именно
  // отрендеренного варианта есть отдельная кнопка
  // «Скопировать форматированный текст» (copyAsFormattedText).

  // Path A: Async Clipboard API — пишем HTML только как text/plain.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(html);
      flashToast('HTML скопирован (вставьте в режим «Текст / HTML» редактора)');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // Path B (legacy): document.execCommand('copy') через скрытый textarea.
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
      flashToast('HTML скопирован (вставьте в режим «Текст / HTML» редактора)');
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

const hasResult = computed(() => Boolean(
  articleSourceHtml.value.trim() || String(selectedTask.value?.article_plain || '').trim(),
));

// ── Мета-теги (GIST Meta Filter, Задача D) ──────────────────────────
// Контракт metaFacade (source/gist_fact/ctr_score/...). Старые задачи хранят
// «сырой» результат GIST (winner_fact/winner_source) — нормализуем оба вида,
// чтобы блок одинаково работал и для уже сгенерированных статей.
const metaTags = computed(() => {
  const mt = selectedTask.value?.meta_tags;
  if (!mt || (!mt.title && !mt.description)) return null;
  return {
    ...mt,
    gist_fact: mt.gist_fact || mt.winner_fact || null,
    gist_fact_source: mt.gist_fact_source || mt.winner_source || null,
  };
});

const metaCtrClass = computed(() => {
  const s = metaTags.value?.ctr_score?.score;
  if (s == null) return 'bg-gray-800 text-gray-300 border border-gray-700';
  if (s >= 75) return 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';
  if (s >= 60) return 'bg-amber-900/40 text-amber-300 border border-amber-800/60';
  return 'bg-red-900/40 text-red-300 border border-red-800/60';
});
async function copyMetaField(label, value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    flashToast(`✅ ${label} скопирован`);
  } catch (_) {
    flashToast('⚠️ Не удалось скопировать');
  }
}
</script>

<template>
  <AppLayout>
    <div class="app-page space-y-6">
      <AppPageHeader
        eyebrow="Создание контента"
        title="Ссылочная статья"
        description="Материал для внешней площадки с естественным анкором, целевым URL и готовой HTML-структурой для публикации."
      >
        <template #title-suffix>
          <ToolHelp title="Ссылочная статья" text="Укажите тему, точный анкор и URL. Сервис создаст статью вокруг ссылки; после завершения материал можно открыть, проверить и экспортировать." />
        </template>
      </AppPageHeader>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Форма (слева) ── -->
        <form @submit.prevent="handleCreate" class="card space-y-4 lg:col-span-5">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая статья</h2>

          <!-- ── ProjectPicker (ТЗ §5/§8) ── -->
          <div>
            <ProjectPicker
              v-model="selectedProjectId"
              @context="handleProjectSelected"
              @fullContext="handleProjectFull"
              label="Проект (необязательно)"
              placeholder="— Без проекта —"
            />
            <p v-if="selectedProject" class="mt-1 text-[11px] text-emerald-300">
              📂 Контекст проекта «{{ selectedProject.name }}» подтянется в генерацию.
            </p>
          </div>

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

          <LlmProviderSelector
            v-model="form.llm_provider"
            :allowed-providers="['gemini', 'openai']"
            :disabled="submitting"
            hint="GPT можно включить точечно для сложного writer/refine; Gemini остаётся стандартом для ссылочных статей."
          />
          <LlmModelSelector
            v-model="form.llm_model"
            :provider="form.llm_provider"
            :disabled="submitting"
            class="mt-3"
            hint="Модель сохраняется вместе с задачей и применяется к writer-вызову."
          />

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

        <!-- ── Структурированная история задач ── -->
        <div class="card space-y-3 lg:col-span-7">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📚 Мои задачи</h2>
              <div class="text-[11px] text-gray-500 mt-1">
                Всего: {{ historyStats.total }} · Готово: {{ historyStats.done }} · В работе: {{ historyStats.active }} · Ошибки: {{ historyStats.errors }}
              </div>
            </div>
              <button class="btn-ghost text-xs shrink-0" @click="store.fetchTasks()">Обновить</button>
          </div>
          <div v-if="selectedTaskLoading" role="status" aria-live="polite"
               class="rounded-lg border border-indigo-800/60 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
            Открываем выбранную задачу и готовим результат…
          </div>
          <div v-else-if="selectedTaskError" role="alert"
               class="rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
            {{ selectedTaskError }}
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
            <input v-model="historySearch" type="search" class="input text-xs"
                   placeholder="Поиск по теме, анкору или URL…" aria-label="Поиск задач" />
            <select v-model="historyStatus" class="input text-xs" aria-label="Фильтр по статусу">
              <option value="all">Все статусы</option>
              <option value="active">В работе и очереди</option>
              <option value="done">Готовые</option>
              <option value="error">Ошибки и тайм-ауты</option>
            </select>
            <select v-model="historySort" class="input text-xs" aria-label="Сортировка задач">
              <option value="newest">Сначала новые</option>
              <option value="oldest">Сначала старые</option>
              <option value="recently_updated">Недавно обновлённые</option>
            </select>
          </div>
          <div v-if="historySearch || historyStatus !== 'all' || historySort !== 'newest'" class="flex items-center justify-between text-[11px] text-gray-500">
            <span>Показано: {{ filteredTasks.length }} из {{ store.tasks.length }}</span>
            <button class="underline hover:text-gray-300" @click="clearHistoryFilters">Сбросить фильтры</button>
          </div>

          <div v-if="store.loading && store.tasks.length === 0" class="text-sm text-gray-500">Загрузка…</div>
          <div v-else-if="store.tasks.length === 0" class="text-sm text-gray-500">
            Пока нет задач. Заполните форму и нажмите «Сгенерировать».
          </div>
          <div v-else-if="filteredTasks.length === 0" class="text-sm text-gray-500">
            По выбранным фильтрам задач не найдено.
          </div>
          <div v-else class="space-y-4">
            <section v-for="group in taskGroups" :key="group.label">
              <h3 class="text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-800 pb-1 mb-1">{{ group.label }}</h3>
              <ul class="divide-y divide-gray-800 -mx-1">
                <li v-for="t in group.tasks" :key="t.id"
                    class="px-1 py-2 flex items-center gap-3 cursor-pointer hover:bg-gray-800/40 rounded"
                    :class="{ 'bg-indigo-950/40 ring-1 ring-inset ring-indigo-700/60': selectedTaskId === String(t.id) }"
                    :aria-current="selectedTaskId === String(t.id) ? 'true' : undefined"
                    role="button"
                    tabindex="0"
                    @click="selectTask(t.id)"
                    @keydown.enter.prevent="selectTask(t.id)"
                    @keydown.space.prevent="selectTask(t.id)">
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-gray-200 truncate">{{ t.topic }}</div>
                    <div class="text-[11px] text-gray-500 mt-0.5">
                      {{ formatDate(t.created_at) }}<span v-if="!isClient"> · {{ formatCost(t.cost_usd) }}</span>
                      <span v-if="!isClient && taskStageLabel(t) && !['done', 'error'].includes(t.status)" class="text-indigo-300">· {{ taskStageLabel(t) }}</span>
                      <span v-if="!isClient && taskProgressLabel(t)" class="text-sky-300">· {{ taskProgressLabel(t) }}</span>
                      <span v-if="!isClient && taskQueueLabel(t)" class="text-amber-300">· {{ taskQueueLabel(t) }}</span>
                      <span v-if="t.anchor_text" class="text-gray-600">· {{ t.anchor_text }}</span>
                    </div>
                    <div v-if="!isClient && (t.error_message || t.error)" class="text-[11px] text-red-300/90 truncate" :title="t.error_message || t.error">
                      {{ t.error_message || t.error }}
                    </div>
                  </div>
                  <span class="text-[11px] px-2 py-0.5 rounded uppercase tracking-wider" :class="statusBadgeClass(t.status, t)">{{ statusLabel(t.status, t) }}</span>
                  <button v-if="!t.archived_at" class="btn-ghost text-xs px-2" @click.stop="handleDelete(t)" title="В архив">✕</button>
                </li>
              </ul>
            </section>
            <button v-if="store.hasMore && historyStatus === 'all' && !historySearch" class="btn-ghost w-full text-xs" :disabled="store.loading" @click="store.loadMoreTasks()">
              {{ store.loading ? 'Загрузка…' : 'Показать более старые задачи' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── Активная задача ── -->
      <section v-if="selectedTask" ref="selectedTaskSectionRef" class="card space-y-4 scroll-mt-6">
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

        <div v-if="isClient && isTaskActiveStatus(selectedTask.status)" class="rounded-lg border border-indigo-900/60 bg-indigo-950/20 px-4 py-3 text-sm text-indigo-100">
          {{ selectedTask.status_message || 'Задача выполняется. Готовый результат появится здесь автоматически.' }}
        </div>

        <!-- Прогресс -->
        <div v-if="!isClient && isTaskActiveStatus(selectedTask.status)" class="space-y-2">
          <div class="flex justify-between items-center text-xs text-gray-400">
            <span>{{ stageLabel(selectedTask.current_stage) }}</span>
            <span>{{ selectedTask.progress_pct || 0 }}%</span>
          </div>
          <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div class="bg-indigo-500 h-2 transition-all duration-500"
                 :style="{ width: `${Math.min(100, selectedTask.progress_pct || 0)}%` }"></div>
          </div>
          <div v-if="!isClient && streamEvents.length" class="text-[11px] text-gray-500 max-h-28 overflow-auto font-mono leading-tight">
            <div v-for="(ev, i) in streamEvents.slice(-8)" :key="i">
              <template v-if="ev.type === 'log'">· {{ ev.msg }}</template>
              <template v-else-if="ev.type === 'stage'">→ {{ stageLabel(ev.stage) }} ({{ ev.progress }}%)</template>
              <template v-else-if="ev.type === 'status'">◆ статус: {{ statusLabel(ev.status) }}</template>
            </div>
          </div>
        </div>

        <!-- Ошибка -->
        <div v-if="selectedTask.status === 'error' || selectedTask.status === 'timeout'"
             class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
          <div class="font-semibold mb-1">Генерация завершилась с ошибкой</div>
          <div v-if="isClient" class="text-red-200 text-xs">Попробуйте запустить задачу повторно. Технические детали доступны служебным ролям.</div>
          <div v-else-if="selectedTask.error_message" class="text-red-200 text-xs whitespace-pre-wrap">{{ selectedTask.error_message }}</div>
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

          <!-- Мета-теги (GIST Meta Filter) — копируются отдельно от статьи -->
          <div v-if="metaTags" class="bg-gray-950 border border-gray-800 rounded-lg p-4 space-y-3">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-indigo-300 uppercase tracking-wider">🏷 Мета-теги (GIST)</h3>
              <span v-if="metaTags.ctr_score" class="text-[11px] px-2 py-0.5 rounded font-medium" :class="metaCtrClass">
                CTR-скор {{ metaTags.ctr_score.score }}/100
              </span>
              <span v-if="metaTags.manual_review_required"
                    class="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60 uppercase">
                manual review
              </span>
              <span v-if="metaTags.source" class="text-[11px] text-gray-600">источник: {{ metaTags.source }}</span>
            </div>
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] text-gray-500 uppercase">Title · {{ (metaTags.title || '').length }} симв.</span>
                <button class="btn-ghost text-xs border border-gray-700 px-2 py-0.5"
                        @click="copyMetaField('Title', metaTags.title)">📋 Копировать</button>
              </div>
              <div class="text-sm text-gray-200 bg-gray-900 border border-gray-800 rounded px-3 py-2 break-words">{{ metaTags.title }}</div>
            </div>
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] text-gray-500 uppercase">Description · {{ (metaTags.description || '').length }} симв.</span>
                <button class="btn-ghost text-xs border border-gray-700 px-2 py-0.5"
                        @click="copyMetaField('Description', metaTags.description)">📋 Копировать</button>
              </div>
              <div class="text-sm text-gray-200 bg-gray-900 border border-gray-800 rounded px-3 py-2 break-words">{{ metaTags.description }}</div>
            </div>
            <div v-if="metaTags.gist_fact" class="text-[11px] text-gray-500">
              GIST-фактор: <span class="text-gray-300">{{ metaTags.gist_fact }}</span>
              <template v-if="metaTags.gist_fact_source"> · источник факта: {{ metaTags.gist_fact_source }}</template>
            </div>
            <ul v-if="metaTags.notes && metaTags.notes.length" class="text-[11px] text-gray-500 space-y-0.5">
              <li v-for="(n, i) in metaTags.notes" :key="i">• {{ n }}</li>
            </ul>
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
        <div v-else-if="selectedTask.status === 'done'"
             class="rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
          Задача завершена, но готовый текст пока не найден. Обновите список через несколько секунд или обратитесь к администратору.
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
