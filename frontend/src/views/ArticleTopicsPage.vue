<script setup>
/**
 * Вкладка «Темы статей» — foresight-генератор тем статей.
 *
 * Один Gemini-вызов (gemini-3.1-pro-preview) на задачу. Результат —
 * markdown-отчёт со слабыми сигналами, emerging-трендами, контентными
 * кластерами и Strategic Action Plan.
 *
 * Поддерживается два типа задач:
 *  • main      — первичный анализ ниши (Промт 1).
 *  • deep_dive — углубление выбранного тренда (Промт 2). Запускается
 *                из модалки результата завершённой main-задачи.
 *
 * UX-паттерн повторяет AcfJsonPage: слева форма, справа список задач,
 * клик по завершённой задаче — модальное окно с результатом и копированием.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useArticleTopicsStore } from '../stores/articleTopics.js';
import {
  parseMainResult, parseDeepDiveResult,
  renderInlineMarkdown, sectionToPlainText,
} from '../utils/articleTopicsParser.js';

const store  = useArticleTopicsStore();
const router = useRouter();

// ── Форма ────────────────────────────────────────────────────────────
const DRAFT_KEY = 'article_topics_draft_v1';
const form = ref({
  niche:            '',
  region:           '',
  horizon:          '12 месяцев',
  audience:         'смешанная',
  market_stage:     'растущий',
  search_ecosystem: 'оба',
  top_competitors:  '',
});

const formError  = ref('');
const submitting = ref(false);

onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }
  store.fetchTasks();
  startPolling();
});

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

async function handleCreate() {
  formError.value = '';
  const niche = (form.value.niche || '').trim();
  if (niche.length < 3) {
    formError.value = 'Поле «Ниша / тема» обязательно (от 3 символов).';
    return;
  }
  submitting.value = true;
  try {
    saveDraft();
    await store.createTask({ ...form.value, niche });
    await store.fetchTasks();
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Не удалось создать задачу';
  } finally {
    submitting.value = false;
  }
}

// ── Polling списка задач (когда есть незавершённые — раз в 5 секунд) ──
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const hasActive = store.tasks.some((t) => t.status === 'queued' || t.status === 'running');
    if (hasActive) await store.fetchTasks();
  }, 5000);
}
onUnmounted(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

// ── Модалка результата ──────────────────────────────────────────────
const activeTaskId = ref(null);
const activeTask   = ref(null);
const modalLoading = ref(false);
const modalError   = ref('');
const copyError    = ref('');

const trendInput   = ref('');
const deepDiveBusy = ref(false);
const deepDiveErr  = ref('');

// ── Структурированный рендер результата ───────────────────────────────
// 'pretty' = разбираем markdown на секции/таблицы/тренды и рисуем
//            красивыми карточками; 'raw' = старый <pre> с сырым markdown.
// По умолчанию pretty: задача всей этой страницы — давать готовый к
// шарингу результат, а не «вот тебе кусок markdown, разбирайся».
const viewMode = ref('pretty'); // 'pretty' | 'raw'

const parsedMain = computed(() => {
  if (!activeTask.value || activeTask.value.mode !== 'main' ||
      activeTask.value.status !== 'done' || !activeTask.value.result_markdown) {
    return null;
  }
  try {
    // Backend в pipeline парсит TRENDS_JSON-сентинельный блок и сохраняет
    // его в task.trends_json. Если он есть — используем его как primary
    // источник трендов (с confidence-бейджами и точными именами).
    return parseMainResult(
      activeTask.value.result_markdown,
      activeTask.value.trends_json || null,
    );
  } catch (_) {
    return null;
  }
});

const parsedDeepDive = computed(() => {
  if (!activeTask.value || activeTask.value.mode !== 'deep_dive' ||
      activeTask.value.status !== 'done' || !activeTask.value.result_markdown) {
    return null;
  }
  try {
    return parseDeepDiveResult(activeTask.value.result_markdown);
  } catch (_) {
    return null;
  }
});

// Per-section "copied" feedback — храним id последней скопированной кнопки,
// чтобы показать ✅ только на нужной кнопке, а не на всех сразу.
const lastCopied = ref({ id: '', mode: '' }); // mode: 'md' | 'text'
let lastCopiedTimer = null;

async function copyText(text, id, mode = 'text') {
  if (!text) return;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(text);
    lastCopied.value = { id, mode };
    if (lastCopiedTimer) clearTimeout(lastCopiedTimer);
    lastCopiedTimer = setTimeout(() => {
      lastCopied.value = { id: '', mode: '' };
    }, 2000);
  } catch (e) {
    copyError.value = 'Не удалось скопировать автоматически: ' + (e.message || e) +
                      '. Выделите текст и скопируйте вручную.';
  }
}
function isCopied(id, mode) {
  return lastCopied.value.id === id && lastCopied.value.mode === mode;
}

function copySection(section, mode = 'text') {
  const id = `section:${section.kind || 'other'}:${section.title}`;
  if (mode === 'md') {
    // Реконструируем markdown секции (## заголовок + body), чтобы вставка
    // в Notion/Obsidian/чат сразу выглядела как ожидается.
    copyText(`## ${section.title}\n\n${section.body || ''}`.trim(), id, 'md');
  } else {
    copyText(sectionToPlainText(section), id, 'text');
  }
}

function copyFullResult(mode = 'md') {
  const md = activeTask.value?.result_markdown;
  if (!md) return;
  if (mode === 'md') {
    copyText(md, 'all', 'md');
  } else {
    // plain text: проходим по всем распарсенным секциям.
    const parsed = parsedMain.value || parsedDeepDive.value;
    if (!parsed) return copyText(md, 'all', 'text');
    const parts = [];
    if (parsed.preamble) parts.push(parsed.preamble);
    for (const s of parsed.sections) parts.push(sectionToPlainText(s));
    copyText(parts.join('\n\n'), 'all', 'text');
  }
}

/** Готовит «список тем статей» для копирования в редакционный план. */
function copyArticleTopics() {
  // Ищем секцию Future Search (Фаза 3) — там макро-темы и long-tail.
  // Если её нет, fallback — секция трендов.
  const parsed = parsedMain.value;
  if (!parsed) return;
  const target = parsed.sections.find((s) => s.kind === 'futureSearch')
              || parsed.sections.find((s) => s.kind === 'trends');
  if (target) copyText(sectionToPlainText(target), 'topics', 'text');
}

/** Копирует полный план (Action Plan + темы) — самое нужное для команды. */
function copyActionPlan() {
  const parsed = parsedMain.value;
  if (!parsed) return;
  const ap = parsed.sections.find((s) => s.kind === 'actionPlan');
  if (ap) copyText(sectionToPlainText(ap), 'plan', 'text');
}

/** Копирует секцию deep-dive по её kind ('semanticCore' | …). */
function copyDeepDiveSectionByKind(kind) {
  const parsed = parsedDeepDive.value;
  if (!parsed) return;
  const sec = parsed.sections.find((s) => s.kind === kind);
  if (sec) copySection(sec, 'text');
}

/**
 * Запускает deep-dive по конкретному тренду (клик по кнопке в карточке).
 * Если уже идёт submit — игнорируем; иначе подставляем имя в trendInput
 * и переиспользуем существующую логику startDeepDive().
 */
async function deepDiveTrend(name) {
  if (deepDiveBusy.value) return;
  trendInput.value = name;
  await startDeepDive();
}

async function openTask(id) {
  activeTaskId.value = id;
  activeTask.value   = null;
  modalLoading.value = true;
  modalError.value   = '';
  copyError.value    = '';
  trendInput.value   = '';
  deepDiveErr.value  = '';
  try {
    activeTask.value = await store.getTask(id);
  } catch (err) {
    modalError.value = err.response?.data?.error || err.message || 'Не удалось загрузить задачу';
  } finally {
    modalLoading.value = false;
  }
}

function closeModal() {
  activeTaskId.value = null;
  activeTask.value   = null;
  copyError.value    = '';
  trendInput.value   = '';
  deepDiveErr.value  = '';
  duplicateInfo.value = { open: false, trend: '', items: [] };
  lastCopied.value   = { id: '', mode: '' };
  if (lastCopiedTimer) { clearTimeout(lastCopiedTimer); lastCopiedTimer = null; }
}

// Состояние диалога-подтверждения дубликата deep-dive.
// Когда backend возвращает 409 duplicate_deep_dive — кладём сюда
// найденные задачи и название тренда, а UI показывает баннер с
// «Открыть существующую» / «Создать всё равно».
const duplicateInfo = ref({ open: false, trend: '', items: [] });

async function startDeepDive() {
  deepDiveErr.value = '';
  duplicateInfo.value = { open: false, trend: '', items: [] };
  const trend = (trendInput.value || '').trim();
  if (trend.length < 3) {
    deepDiveErr.value = 'Введите название тренда (от 3 символов).';
    return;
  }
  if (!activeTask.value || activeTask.value.mode !== 'main' ||
      activeTask.value.status !== 'done') {
    deepDiveErr.value = 'Углубление доступно только для завершённой main-задачи.';
    return;
  }
  deepDiveBusy.value = true;
  try {
    const res = await store.createDeepDive(activeTask.value.id, trend);
    // Дубликат — НЕ создаём, показываем UX-диалог. Пользователь либо
    // открывает существующий результат, либо подтверждает пересоздание.
    if (res && res.duplicates) {
      duplicateInfo.value = { open: true, trend, items: res.duplicates };
      return;
    }
    const newId = res && res.id;
    await store.fetchTasks();
    closeModal();
    if (newId) openTask(newId);
  } catch (err) {
    deepDiveErr.value = err.response?.data?.error || err.message || 'Не удалось создать deep-dive';
  } finally {
    deepDiveBusy.value = false;
  }
}

// Подтвердить пересоздание поверх существующего деп-дайва (force=true).
async function confirmDuplicateRecreate() {
  const trend = duplicateInfo.value.trend;
  if (!trend || !activeTask.value) return;
  deepDiveBusy.value = true;
  try {
    const res = await store.createDeepDive(activeTask.value.id, trend, { force: true });
    duplicateInfo.value = { open: false, trend: '', items: [] };
    const newId = res && res.id;
    await store.fetchTasks();
    closeModal();
    if (newId) openTask(newId);
  } catch (err) {
    deepDiveErr.value = err.response?.data?.error || err.message || 'Не удалось создать deep-dive';
  } finally {
    deepDiveBusy.value = false;
  }
}

// Открыть существующий deep-dive из списка дубликатов.
function openDuplicateExisting(taskId) {
  duplicateInfo.value = { open: false, trend: '', items: [] };
  closeModal();
  openTask(taskId);
}

// ── Per-row действия ────────────────────────────────────────────────
async function removeTask(id, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm('Удалить задачу?')) return;
  try {
    await store.deleteTask(id);
  } catch (err) {
    alert('Не удалось удалить: ' + (err.response?.data?.error || err.message || ''));
  }
}

// ── Хелперы UI ──────────────────────────────────────────────────────
function statusLabel(s) {
  switch (s) {
    case 'queued':  return 'В очереди';
    case 'running': return 'Идёт обработка';
    case 'done':    return 'Готово';
    case 'error':   return 'Ошибка';
    default:        return s || '—';
  }
}
function statusClass(s) {
  switch (s) {
    case 'queued':  return 'bg-gray-800/70  text-gray-300  border-gray-700';
    case 'running': return 'bg-amber-900/40 text-amber-200 border-amber-700';
    case 'done':    return 'bg-emerald-900/40 text-emerald-200 border-emerald-700';
    case 'error':   return 'bg-red-900/40   text-red-200   border-red-700';
    default:        return 'bg-gray-800/70  text-gray-400  border-gray-700';
  }
}
function modeLabel(m) { return m === 'deep_dive' ? 'Deep-dive' : 'Анализ'; }
function fmtDate(s)   { return s ? new Date(s).toLocaleString('ru-RU') : '—'; }

// Презентация секций распарсенного отчёта: иконка + цветовой акцент. Ключи
// совпадают с PHASE_KEYWORDS / DEEPDIVE_KEYWORDS из articleTopicsParser.js.
const SECTION_META = {
  signals:       { icon: '📡', accent: 'border-l-4 border-sky-500',     pill: 'Слабые сигналы' },
  trends:        { icon: '🚀', accent: 'border-l-4 border-indigo-500',  pill: 'Тренды' },
  blindSpots:    { icon: '🎯', accent: 'border-l-4 border-fuchsia-500', pill: 'Слепые зоны' },
  futureSearch:  { icon: '🔮', accent: 'border-l-4 border-emerald-500', pill: 'Темы статей' },
  lifecycle:     { icon: '⏳', accent: 'border-l-4 border-amber-500',   pill: 'Жизненный цикл' },
  disruption:    { icon: '⚡', accent: 'border-l-4 border-rose-500',    pill: 'Disruption / SERP' },
  metaTrends:    { icon: '🌐', accent: 'border-l-4 border-violet-500',  pill: 'Мета-тренды' },
  actionPlan:    { icon: '✅', accent: 'border-l-4 border-emerald-400 bg-emerald-950/20', pill: 'Action Plan' },
  semanticCore:  { icon: '🔑', accent: 'border-l-4 border-indigo-500',  pill: 'Семантическое ядро' },
  hubAndSpoke:   { icon: '🕸️', accent: 'border-l-4 border-emerald-500', pill: 'Hub & Spoke' },
  competitorGap: { icon: '🎯', accent: 'border-l-4 border-fuchsia-500', pill: 'Конкурентный gap' },
  quickWin:      { icon: '⚡', accent: 'border-l-4 border-amber-400 bg-amber-950/20',    pill: 'Быстрая победа' },
  yandex:        { icon: '🅈',  accent: 'border-l-4 border-yellow-500',  pill: 'Яндекс-экосистема' },
  currentState:  { icon: '📅', accent: 'border-l-4 border-cyan-500',    pill: 'Состояние тренда' },
  other:         { icon: '📄', accent: 'border-l-4 border-gray-700',    pill: '' },
};
function sectionMeta(kind) { return SECTION_META[kind] || SECTION_META.other; }

// Бейдж confidence для тренда. Возвращает { label, dotClass, bgClass } или
// null, если значения нет (тогда UI просто не показывает чип).
function confidenceBadge(conf) {
  if (!conf) return null;
  const c = String(conf).toLowerCase();
  if (c === 'high')   return { label: 'high',   dotClass: 'bg-emerald-400', bgClass: 'bg-emerald-900/40 text-emerald-200 border border-emerald-700' };
  if (c === 'medium' || c === 'med') return { label: 'medium', dotClass: 'bg-amber-400',   bgClass: 'bg-amber-900/40 text-amber-200 border border-amber-700' };
  if (c === 'low')    return { label: 'low',    dotClass: 'bg-rose-400',    bgClass: 'bg-rose-900/40 text-rose-200 border border-rose-700' };
  return null;
}

// Скор evaluator-отчёта для отображения ⭐ N/10 в карточке/модалке.
// Возвращает строку либо null, если evaluator не запускался или дал NaN.
function evaluatorScore(task) {
  const s = Number(task && task.evaluator_report && task.evaluator_report.total_score);
  return Number.isFinite(s) ? s.toFixed(1) : null;
}

// Открывает /tasks/new с предзаполненными query-параметрами (нишa,
// аудитория, raw LSI из ключей quick-win и т.п.). CreateTaskPage
// читает их в onMounted и подставляет в reactive form.
function createSeoArticleFromTrend(trend) {
  if (!trend || !trend.name || !activeTask.value) return;
  // Собираем максимум контекста из текущей main-задачи.
  const t = activeTask.value;
  const query = {
    prefill_target:    `${t.niche || ''} — ${trend.name}`.trim(),
    prefill_audience:  t.audience  || '',
    prefill_region:    t.region    || '',
    prefill_brand:     '', // у article-topic задачи нет бренда — пусть юзер сам впишет.
    prefill_facts:     [
      trend.drivers ? `Драйверы: ${trend.drivers}` : '',
      trend.vector  ? `Вектор:   ${trend.vector}`  : '',
      trend.signals ? `Сигналы:  ${trend.signals}` : '',
      trend.confidence ? `Confidence (foresight): ${trend.confidence}` : '',
    ].filter(Boolean).join('\n'),
    prefill_title:     trend.name,
  };
  router.push({ path: '/tasks/new', query });
}

// «📝 Создать SEO-статью» из quick-win (deep-dive, секция 4).
function createSeoArticleFromQuickWin() {
  if (!activeTask.value) return;
  const t = activeTask.value;
  const parsed = parsedDeepDive.value;
  // Берём всё содержимое секции «Быстрая победа» как brand_facts —
  // там уже есть H1/title/description/H2 + тезисы + CTA, что является
  // готовой постановкой для SEO-генератора.
  let qwBlock = '';
  if (parsed) {
    const qw = parsed.sections.find((s) => s.kind === 'quickWin');
    if (qw) qwBlock = sectionToPlainText(qw);
  }
  router.push({
    path: '/tasks/new',
    query: {
      prefill_target:   `${t.niche || ''} — ${t.trend_name || ''}`.trim(),
      prefill_audience: t.audience || '',
      prefill_region:   t.region   || '',
      prefill_facts:    qwBlock.slice(0, 4000), // лимит query-string
      prefill_title:    t.trend_name || '',
    },
  });
}

/**
 * Возвращает «тело секции» для блочного рендера: вырезает таблицу (она
 * рисуется отдельным `<table>`) и под-секции `### ...` (они рисуются
 * отдельными карточками), чтобы тот же контент не выводился дважды.
 */
function sectionBodyForRender(section) {
  if (!section) return '';
  let body = section.body || '';
  if (section.table && section.table.raw) {
    body = body.replace(section.table.raw, '');
  }
  if (section.subs && section.subs.length) {
    // Отрезаем всё, начиная с первого ### — оно уже выведено как subs.
    body = body.split(/\n\s*###\s+/)[0];
  }
  return body;
}

// Безопасно рендерим ячейку markdown-таблицы как HTML (escape + inline md).
// renderInlineMarkdown сам экранирует HTML, поэтому output безопасен для v-html.
function renderCell(text) {
  // Заворачиваем в renderInlineMarkdown, который выдаёт <p>; нам нужен инлайн —
  // снимем единственный <p>.
  const html = renderInlineMarkdown(String(text || ''));
  return html.replace(/^<p[^>]*>/, '').replace(/<\/p>\s*$/, '');
}
function renderBlock(text) {
  return renderInlineMarkdown(String(text || ''));
}

const sortedTasks = computed(() =>
  [...(store.tasks || [])].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
);
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Шапка -->
      <div class="border-b border-gray-800 pb-4">
        <h1 class="text-2xl font-bold text-white flex items-center gap-2">
          🔮 Темы статей <span class="text-xs font-normal text-gray-500">· foresight forecaster</span>
        </h1>
        <p class="text-gray-400 text-sm mt-1">
          Foresight-анализ ниши: слабые сигналы, emerging-тренды, прогноз поискового спроса
          и Strategic Action Plan. Один проход через Gemini 3.1 Pro Preview ≈ 1–3 минуты на задачу.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Форма (слева) ── -->
        <form @submit.prevent="handleCreate" class="card space-y-4 lg:col-span-5">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая задача</h2>

          <div>
            <label class="label">Ниша / тема <span class="text-red-400">*</span></label>
            <input v-model="form.niche" type="text" class="input"
                   placeholder="Например: оформление ВНЖ Португалии для IT-предпринимателей" />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label">Фокусный регион</label>
              <input v-model="form.region" type="text" class="input"
                     placeholder="Россия / СНГ / Европа / DACH" />
            </div>
            <div>
              <label class="label">Горизонт планирования</label>
              <input v-model="form.horizon" type="text" class="input"
                     placeholder="12 месяцев / 3 года / 5 лет" />
            </div>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="label">Аудитория</label>
              <select v-model="form.audience" class="input">
                <option>B2B</option>
                <option>B2C</option>
                <option>смешанная</option>
              </select>
            </div>
            <div>
              <label class="label">Стадия рынка</label>
              <select v-model="form.market_stage" class="input">
                <option>зарождающийся</option>
                <option>растущий</option>
                <option>зрелый</option>
                <option>стагнирующий</option>
              </select>
            </div>
            <div>
              <label class="label">Поиск</label>
              <select v-model="form.search_ecosystem" class="input">
                <option>Google</option>
                <option>Яндекс</option>
                <option>оба</option>
              </select>
            </div>
          </div>

          <div>
            <label class="label">Топ-3 конкурента (по строке на каждого)</label>
            <textarea v-model="form.top_competitors" rows="3" class="textarea"
                      placeholder="example1.com — описание&#10;example2.com — описание&#10;example3.com — описание"></textarea>
          </div>

          <div v-if="formError"
               class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
            {{ formError }}
          </div>

          <button type="submit" class="btn-primary w-full" :disabled="submitting">
            {{ submitting ? '⏳ Создание задачи...' : '➕ Создать задачу' }}
          </button>
          <p class="text-[11px] text-gray-500">
            Задача поставится в очередь и обработается в фоне. Прогресс — в правой панели.
          </p>
        </form>

        <!-- ── Список задач (справа) ── -->
        <section class="lg:col-span-7 space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📋 Задачи</h2>
            <button class="btn-ghost text-xs border border-gray-700"
                    @click="store.fetchTasks()" :disabled="store.loading">
              {{ store.loading ? '...' : '↻ Обновить' }}
            </button>
          </div>

          <div v-if="store.error"
               class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">
            {{ store.error }}
          </div>

          <div v-if="!sortedTasks.length"
               class="card text-center text-gray-500 text-sm py-10">
            Пока нет задач — заполните форму слева и нажмите «Создать задачу».
          </div>

          <ul v-else class="space-y-2">
            <li v-for="t in sortedTasks" :key="t.id"
                @click="openTask(t.id)"
                class="card cursor-pointer hover:border-indigo-700 transition-colors">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs uppercase tracking-wider text-indigo-300">
                      {{ modeLabel(t.mode) }}
                    </span>
                    <span :class="['inline-block px-2 py-0.5 text-[11px] rounded border', statusClass(t.status)]">
                      {{ statusLabel(t.status) }}
                    </span>
                  </div>
                  <div class="text-sm text-white mt-1 truncate" :title="t.niche">
                    <span v-if="t.mode === 'deep_dive' && t.trend_name" class="text-indigo-300">
                      🔍 {{ t.trend_name }} ·
                    </span>
                    {{ t.niche || '—' }}
                  </div>
                  <div class="text-[11px] text-gray-500 mt-1">
                    {{ fmtDate(t.created_at) }}
                    <span v-if="t.cost_usd && Number(t.cost_usd) > 0">
                      · ${{ Number(t.cost_usd).toFixed(4) }}
                    </span>
                    <span v-if="evaluatorScore(t)"
                          class="ml-1 text-amber-300"
                          :title="'LLM-as-judge score (5 критериев, среднее)'">
                      · ⭐ {{ evaluatorScore(t) }}/10
                    </span>
                  </div>
                  <div v-if="t.status === 'error' && t.error_message"
                       class="text-[11px] text-red-300 mt-1 truncate" :title="t.error_message">
                    ⚠ {{ t.error_message }}
                  </div>
                </div>
                <button class="btn-ghost text-xs border border-gray-700 flex-shrink-0"
                        :disabled="t.status === 'running' || t.status === 'queued'"
                        @click="removeTask(t.id, $event)" title="Удалить задачу">
                  ✕
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <!-- ── Модальное окно результата ── -->
    <div v-if="activeTaskId"
         class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
         @click.self="closeModal">
      <div class="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <header class="flex items-center justify-between px-5 py-3 border-b border-gray-800 flex-shrink-0">
          <div class="min-w-0">
            <div class="text-xs text-gray-400 uppercase tracking-wider">
              {{ activeTask ? modeLabel(activeTask.mode) : 'Задача' }} ·
              <span :class="activeTask ? statusClass(activeTask.status) : ''"
                    class="inline-block px-2 py-0.5 text-[11px] rounded border align-middle">
                {{ activeTask ? statusLabel(activeTask.status) : '...' }}
              </span>
              <span v-if="activeTask && evaluatorScore(activeTask)"
                    class="ml-2 inline-block px-2 py-0.5 text-[11px] rounded border border-amber-700 bg-amber-900/40 text-amber-200 align-middle"
                    :title="'LLM-as-judge: среднее по 5 критериям (specificity / evidence / actionability / novelty / structure)'">
                ⭐ {{ evaluatorScore(activeTask) }}/10
              </span>
            </div>
            <div class="text-white truncate mt-1">
              <span v-if="activeTask?.mode === 'deep_dive' && activeTask?.trend_name"
                    class="text-indigo-300">🔍 {{ activeTask.trend_name }} · </span>
              {{ activeTask?.niche || '...' }}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <!-- Переключатель красивого / сырого вида (только когда есть результат) -->
            <div v-if="activeTask?.status === 'done' && activeTask?.result_markdown"
                 class="hidden sm:inline-flex rounded-md border border-gray-700 overflow-hidden text-xs">
              <button
                :class="['px-2.5 py-1 transition-colors',
                         viewMode === 'pretty'
                           ? 'bg-indigo-600 text-white'
                           : 'bg-transparent text-gray-300 hover:bg-gray-800']"
                @click="viewMode = 'pretty'"
                title="Структурированный вид с копированием по разделам">
                ✨ Структура
              </button>
              <button
                :class="['px-2.5 py-1 transition-colors border-l border-gray-700',
                         viewMode === 'raw'
                           ? 'bg-indigo-600 text-white'
                           : 'bg-transparent text-gray-300 hover:bg-gray-800']"
                @click="viewMode = 'raw'"
                title="Сырой markdown — для Obsidian / Notion">
                📝 Markdown
              </button>
            </div>
            <button v-if="activeTask?.status === 'done' && activeTask?.result_markdown"
                    class="btn-primary text-xs" @click="copyFullResult('md')">
              {{ isCopied('all', 'md') ? '✅ Скопировано' : '📋 Весь результат (md)' }}
            </button>
            <button class="btn-ghost border border-gray-700 text-xs" @click="closeModal">✕</button>
          </div>
        </header>

        <div class="flex-1 overflow-auto p-5">
          <div v-if="copyError"
               class="bg-amber-950/60 border border-amber-800 text-amber-200 rounded-lg px-4 py-2 text-xs mb-3">
            ⚠️ {{ copyError }}
          </div>

          <div v-if="modalLoading" class="text-gray-400 text-sm">Загрузка...</div>
          <div v-else-if="modalError"
               class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm">
            {{ modalError }}
          </div>
          <template v-else-if="activeTask">
            <div v-if="activeTask.status === 'queued' || activeTask.status === 'running'"
                 class="text-amber-300 text-sm">
              ⏳ Задача обрабатывается. Окно можно закрыть — прогресс отображается в списке справа.
            </div>
            <div v-else-if="activeTask.status === 'error'"
                 class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm whitespace-pre-wrap">
              ⚠ {{ activeTask.error_message || 'Неизвестная ошибка' }}
            </div>

            <!-- ── Сырой markdown (по запросу пользователя) ── -->
            <pre v-else-if="viewMode === 'raw' && activeTask.result_markdown"
                 class="text-sm text-gray-100 whitespace-pre-wrap font-sans leading-relaxed"
            >{{ activeTask.result_markdown }}</pre>

            <!-- ── Структурированный вид: MAIN ── -->
            <div v-else-if="parsedMain" class="space-y-5">
              <!-- Глобальные кнопки копирования -->
              <div class="flex flex-wrap gap-2 pb-1">
                <button class="btn-secondary text-xs" @click="copyArticleTopics"
                        :disabled="!parsedMain.sections.some((s) => s.kind === 'futureSearch' || s.kind === 'trends')"
                        title="Темы статей из «Фазы 3 — Future Search & Topic Clustering»">
                  {{ isCopied('topics', 'text') ? '✅ Скопировано' : '📋 Скопировать темы статей' }}
                </button>
                <button class="btn-secondary text-xs" @click="copyActionPlan"
                        :disabled="!parsedMain.sections.some((s) => s.kind === 'actionPlan')">
                  {{ isCopied('plan', 'text') ? '✅ Скопировано' : '📋 Скопировать Strategic Action Plan' }}
                </button>
                <button class="btn-secondary text-xs" @click="copyFullResult('text')">
                  {{ isCopied('all', 'text') ? '✅ Скопировано' : '📋 Весь результат как текст' }}
                </button>
              </div>

              <!-- 🚀 ТРЕНДЫ — отдельная панель с кнопкой «Углубить» -->
              <section v-if="parsedMain.trends.length"
                       class="rounded-xl border border-indigo-700/60 bg-indigo-950/30 p-4 space-y-3">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <h3 class="text-sm font-bold text-indigo-200 uppercase tracking-wider flex items-center gap-2">
                    🚀 Выбранные тренды
                    <span class="text-[11px] font-normal text-indigo-300/80 normal-case">
                      ({{ parsedMain.trends.length }} шт.) · клик «Углубить» запустит Фазу 2
                    </span>
                  </h3>
                  <button class="btn-ghost text-xs border border-indigo-700"
                          @click="copyText(parsedMain.trends.map((t) => t.name).join('\n'),
                                           'trend-names', 'text')">
                    {{ isCopied('trend-names', 'text') ? '✅ Скопировано' : '📋 Только названия' }}
                  </button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div v-for="(t, idx) in parsedMain.trends" :key="idx"
                       class="rounded-lg bg-gray-900/70 border border-gray-800 p-3 flex flex-col gap-2">
                    <div class="flex items-start justify-between gap-2">
                      <div class="text-white font-semibold text-sm leading-snug break-words">
                        {{ t.name }}
                      </div>
                      <div class="flex items-center gap-1 flex-shrink-0">
                        <span v-if="confidenceBadge(t.confidence)"
                              :class="['text-[10px] uppercase tracking-wider px-2 py-0.5 rounded inline-flex items-center gap-1',
                                       confidenceBadge(t.confidence).bgClass]"
                              :title="`Confidence: ${confidenceBadge(t.confidence).label}`">
                          <span :class="['inline-block w-1.5 h-1.5 rounded-full',
                                          confidenceBadge(t.confidence).dotClass]"></span>
                          {{ confidenceBadge(t.confidence).label }}
                        </span>
                        <span v-if="t.stage"
                              class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded
                                     bg-gray-800 text-indigo-200 border border-gray-700">
                          {{ t.stage }}
                        </span>
                      </div>
                    </div>
                    <dl class="text-[11px] text-gray-400 space-y-0.5">
                      <div v-if="t.drivers"><dt class="inline text-gray-500">Драйверы: </dt><dd class="inline text-gray-300">{{ t.drivers }}</dd></div>
                      <div v-if="t.vector"><dt class="inline text-gray-500">Вектор: </dt><dd class="inline text-gray-300">{{ t.vector }}</dd></div>
                      <div v-if="t.signals"><dt class="inline text-gray-500">Сигналы: </dt><dd class="inline text-gray-300">{{ t.signals }}</dd></div>
                      <div v-if="t.windowMonths"><dt class="inline text-gray-500">Окно (мес.): </dt><dd class="inline text-gray-300">{{ t.windowMonths }}</dd></div>
                    </dl>
                    <div class="flex items-center gap-2 mt-1 flex-wrap">
                      <button class="btn-primary text-xs flex-1 min-w-0"
                              :disabled="deepDiveBusy"
                              @click="deepDiveTrend(t.name)">
                        {{ deepDiveBusy && trendInput === t.name ? '⏳ Запуск...' : '🔍 Углубить →' }}
                      </button>
                      <button class="btn-ghost text-xs border border-emerald-700 text-emerald-200"
                              @click="createSeoArticleFromTrend(t)"
                              title="Открыть форму создания SEO-статьи с предзаполненными полями из тренда">
                        📝 SEO-статья
                      </button>
                      <button class="btn-ghost text-xs border border-gray-700"
                              @click="copyText(t.name, `trend-${idx}`, 'text')"
                              :title="`Скопировать «${t.name}»`">
                        {{ isCopied(`trend-${idx}`, 'text') ? '✅' : '📋' }}
                      </button>
                    </div>
                  </div>
                </div>
                <p v-if="deepDiveErr" class="text-xs text-red-300">{{ deepDiveErr }}</p>

                <!-- Дубликат deep-dive: backend вернул 409 — спрашиваем юзера. -->
                <div v-if="duplicateInfo.open"
                     class="rounded-lg border border-amber-700 bg-amber-950/40 p-3 space-y-2">
                  <p class="text-amber-100 text-xs leading-snug">
                    ⚠️ Вы уже исследовали тренд <strong>«{{ duplicateInfo.trend }}»</strong>
                    в одном из своих deep-dive. Откройте существующий результат —
                    или подтвердите пересоздание.
                  </p>
                  <ul class="space-y-1">
                    <li v-for="d in duplicateInfo.items" :key="d.id"
                        class="flex items-center justify-between gap-2 text-[11px] text-amber-100">
                      <span class="truncate">
                        {{ d.trend_name }}
                        <span class="text-amber-300/80">· {{ d.niche }}</span>
                        <span class="text-amber-300/60">· {{ new Date(d.created_at).toLocaleDateString() }}</span>
                        <span class="text-amber-300/80">· {{ d.status }}</span>
                      </span>
                      <button class="btn-ghost text-[11px] border border-amber-700 text-amber-100"
                              @click="openDuplicateExisting(d.id)">
                        Открыть
                      </button>
                    </li>
                  </ul>
                  <div class="flex items-center gap-2">
                    <button class="btn-secondary text-xs"
                            :disabled="deepDiveBusy"
                            @click="confirmDuplicateRecreate">
                      {{ deepDiveBusy ? '⏳ Создаём...' : '↻ Создать всё равно' }}
                    </button>
                    <button class="btn-ghost text-xs border border-gray-700"
                            @click="duplicateInfo = { open: false, trend: '', items: [] }">
                      Отмена
                    </button>
                  </div>
                </div>
              </section>

              <!-- Все секции отчёта -->
              <section v-for="(sec, idx) in parsedMain.sections" :key="idx"
                       :class="['rounded-xl bg-gray-900/60 p-4 space-y-3', sectionMeta(sec.kind).accent]">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <h3 class="text-sm font-bold text-white flex items-center gap-2">
                    <span>{{ sectionMeta(sec.kind).icon }}</span>
                    <span>{{ sec.title }}</span>
                    <span v-if="sectionMeta(sec.kind).pill"
                          class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded
                                 bg-gray-800 text-gray-300 border border-gray-700">
                      {{ sectionMeta(sec.kind).pill }}
                    </span>
                  </h3>
                  <div class="flex items-center gap-1.5">
                    <button class="btn-ghost text-[11px] border border-gray-700"
                            @click="copySection(sec, 'text')"
                            title="Копировать как plain text (готово для чата/документа)">
                      {{ isCopied(`section:${sec.kind || 'other'}:${sec.title}`, 'text')
                          ? '✅ Текст' : '📋 Текст' }}
                    </button>
                    <button class="btn-ghost text-[11px] border border-gray-700"
                            @click="copySection(sec, 'md')"
                            title="Копировать как markdown (для Notion/Obsidian)">
                      {{ isCopied(`section:${sec.kind || 'other'}:${sec.title}`, 'md')
                          ? '✅ MD' : '📋 MD' }}
                    </button>
                  </div>
                </div>

                <!-- Текстовая часть секции (без таблицы и без ### субсекций) -->
                <div v-if="sec.body"
                     v-html="renderBlock(sectionBodyForRender(sec))"
                     class="space-y-2"></div>

                <!-- Таблица секции -->
                <div v-if="sec.table" class="overflow-x-auto rounded-lg border border-gray-800">
                  <table class="min-w-full text-xs">
                    <thead class="bg-gray-800/80">
                      <tr>
                        <th v-for="(h, hi) in sec.table.headers" :key="hi"
                            class="px-3 py-2 text-left text-gray-200 font-semibold whitespace-nowrap"
                            v-html="renderCell(h)"></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(r, ri) in sec.table.rows" :key="ri"
                          class="border-t border-gray-800 hover:bg-gray-800/40">
                        <td v-for="(c, ci) in r" :key="ci"
                            class="px-3 py-2 text-gray-200 align-top"
                            v-html="renderCell(c)"></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- Подсекции (### ДЕЙСТВИЕ N — для actionPlan) -->
                <div v-if="sec.subs && sec.subs.length" class="space-y-3">
                  <div v-for="(sub, si) in sec.subs" :key="si"
                       class="rounded-lg bg-gray-950/60 border border-gray-800 p-3">
                    <div class="flex items-center justify-between gap-2 mb-2">
                      <h4 class="text-sm font-semibold text-emerald-200">{{ sub.title }}</h4>
                      <button class="btn-ghost text-[11px] border border-gray-700"
                              @click="copyText(`${sub.title}\n\n${sub.body}`,
                                                `sub:${sec.kind}:${si}`, 'text')">
                        {{ isCopied(`sub:${sec.kind}:${si}`, 'text') ? '✅' : '📋' }}
                      </button>
                    </div>
                    <div v-html="renderBlock(sub.body)"></div>
                  </div>
                </div>
              </section>
            </div>

            <!-- ── Структурированный вид: DEEP-DIVE ── -->
            <div v-else-if="parsedDeepDive" class="space-y-5">
              <div class="flex flex-wrap gap-2 pb-1">
                <button v-for="kind in ['semanticCore','hubAndSpoke','competitorGap','quickWin']"
                        :key="kind"
                        class="btn-secondary text-xs"
                        :disabled="!parsedDeepDive.sections.some((s) => s.kind === kind)"
                        @click="copyDeepDiveSectionByKind(kind)">
                  {{ isCopied(`section:${kind}:` +
                        (parsedDeepDive.sections.find((s) => s.kind === kind)?.title || ''), 'text')
                      ? '✅ Скопировано'
                      : '📋 ' + sectionMeta(kind).pill }}
                </button>
                <button class="btn-secondary text-xs" @click="copyFullResult('text')">
                  {{ isCopied('all', 'text') ? '✅ Скопировано' : '📋 Весь результат как текст' }}
                </button>
              </div>

              <section v-for="(sec, idx) in parsedDeepDive.sections" :key="idx"
                       :class="['rounded-xl bg-gray-900/60 p-4 space-y-3', sectionMeta(sec.kind).accent]">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <h3 class="text-sm font-bold text-white flex items-center gap-2">
                    <span>{{ sectionMeta(sec.kind).icon }}</span>
                    <span>{{ sec.title }}</span>
                  </h3>
                  <div class="flex items-center gap-1.5">
                    <button v-if="sec.kind === 'quickWin'"
                            class="btn-ghost text-[11px] border border-emerald-700 text-emerald-200"
                            @click="createSeoArticleFromQuickWin"
                            title="Открыть форму создания SEO-статьи с предзаполненными полями из «Быстрой победы»">
                      📝 Создать SEO-статью →
                    </button>
                    <button class="btn-ghost text-[11px] border border-gray-700"
                            @click="copySection(sec, 'text')">
                      {{ isCopied(`section:${sec.kind || 'other'}:${sec.title}`, 'text')
                          ? '✅ Текст' : '📋 Текст' }}
                    </button>
                    <button class="btn-ghost text-[11px] border border-gray-700"
                            @click="copySection(sec, 'md')">
                      {{ isCopied(`section:${sec.kind || 'other'}:${sec.title}`, 'md')
                          ? '✅ MD' : '📋 MD' }}
                    </button>
                  </div>
                </div>

                <div v-if="sec.body"
                     v-html="renderBlock(sectionBodyForRender(sec))"
                     class="space-y-2"></div>

                <div v-if="sec.table" class="overflow-x-auto rounded-lg border border-gray-800">
                  <table class="min-w-full text-xs">
                    <thead class="bg-gray-800/80">
                      <tr>
                        <th v-for="(h, hi) in sec.table.headers" :key="hi"
                            class="px-3 py-2 text-left text-gray-200 font-semibold whitespace-nowrap"
                            v-html="renderCell(h)"></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(r, ri) in sec.table.rows" :key="ri"
                          class="border-t border-gray-800 hover:bg-gray-800/40">
                        <td v-for="(c, ci) in r" :key="ci"
                            class="px-3 py-2 text-gray-200 align-top"
                            v-html="renderCell(c)"></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <!-- Fallback: парсер не справился, показываем raw -->
            <pre v-else-if="activeTask.result_markdown"
                 class="text-sm text-gray-100 whitespace-pre-wrap font-sans leading-relaxed"
            >{{ activeTask.result_markdown }}</pre>
            <div v-else class="text-gray-500 text-sm italic">Результат отсутствует.</div>
          </template>
        </div>

        <!-- Deep-dive triggers — только для main-задачи, успешно завершённой;
             свободный ввод тренда (если в таблице нужного нет) -->
        <footer v-if="activeTask?.mode === 'main' && activeTask?.status === 'done'"
                class="border-t border-gray-800 px-5 py-3 flex-shrink-0 space-y-2">
          <div class="text-xs text-gray-400 uppercase tracking-wider">
            🔍 Углубить произвольный тренд (Промт 2)
          </div>
          <div class="flex items-center gap-2">
            <input v-model="trendInput" type="text" class="input flex-1"
                   placeholder="Название тренда из отчёта или своё" />
            <button class="btn-primary text-sm" :disabled="deepDiveBusy" @click="startDeepDive">
              {{ deepDiveBusy ? '⏳' : 'Углубить' }}
            </button>
          </div>
          <p v-if="deepDiveErr" class="text-xs text-red-300">{{ deepDiveErr }}</p>
        </footer>
      </div>
    </div>
  </AppLayout>
</template>
