<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import DOMPurify from 'dompurify';
import readXlsxFile from 'read-excel-file';
import AppLayout from '../components/AppLayout.vue';
import { useAuthStore } from '../stores/auth.js';
import { useInfoArticleStore } from '../stores/infoArticle.js';

const store = useInfoArticleStore();
const auth  = useAuthStore();
const route = useRoute();

// ── Form state (топик + регион + опционально + Excel) ─────────────────
const form = ref({
  topic:         '',
  region:        '',
  brand_name:    '',
  author_name:   '',
  brand_facts:   '',
  output_format: 'html',
});
const optionalOpen = ref(false);
const submitting   = ref(false);
const formError    = ref(null);

const DRAFT_KEY = 'info_article_draft_v1';
onMounted(() => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) Object.assign(form.value, JSON.parse(raw));
  } catch (_) { /* ignore */ }

  // Префилл из query-параметров (например, переход из /article-topics →
  // «Создать статью для блога» после Phase 2 / quick-win). Параметры
  // перекрывают draft, чтобы свежий контекст из «Тем статей» не терялся.
  // Поддерживаются: prefill_target → topic, prefill_title → topic (fallback),
  // prefill_region → region, prefill_brand → brand_name, prefill_facts → brand_facts.
  try {
    const q = route.query || {};
    const pickStr = (v, max) => {
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === 'string' ? s.trim().slice(0, max) : '';
    };
    const topic = pickStr(q.prefill_target, 200) || pickStr(q.prefill_title, 200);
    if (topic) form.value.topic = topic;
    const region = pickStr(q.prefill_region, 200);
    if (region) form.value.region = region;
    const brand = pickStr(q.prefill_brand, 200);
    if (brand) form.value.brand_name = brand;
    const facts = pickStr(q.prefill_facts, 4000);
    if (facts) form.value.brand_facts = facts;
    if (topic || region || brand || facts) {
      // Раскроем «опциональный» блок, если что-то предзаполнили — иначе
      // brand_facts «прячется» под коллапсом и пользователь его не увидит.
      optionalOpen.value = true;
    }
  } catch (_) { /* ignore */ }
});
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form.value)); } catch (_) { /* ignore */ }
}

// ── Excel: загрузка / парсинг / превью ────────────────────────────────
//
// Парсинг на клиенте через read-excel-file (нет CDN-загрузки, без вызова
// xlsx-парсера на бэкенде — это даёт мгновенную обратную связь и валидацию
// до отправки задачи). Файл НЕ отправляется на бэкенд: бэкенд получает
// уже распарсенный JSON-массив `[{url, h1}]` через POST /api/info-article.
//
// MIME-allowlist + размер ≤ 2МБ страхуют от случайных не-Excel'ей.
const ALLOWED_FILE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'text/csv',                                                          // .csv
  'application/csv',
]);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_LINKS_CLIENT = 200;

const fileMeta   = ref(null);  // { name, size }
const parsedLinks = ref([]);   // [{ url, h1 }]
const dropActive = ref(false);
const parseError = ref(null);
const parseInfo  = ref(null);

function clearLinks() {
  fileMeta.value   = null;
  parsedLinks.value = [];
  parseError.value = null;
  parseInfo.value  = null;
}

function detectColumnIndices(headerRow) {
  // Принимаем русские/английские варианты заголовков.
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const urlAliases = ['url', 'ссылка', 'link', 'href', 'адрес', 'страница'];
  const h1Aliases  = ['h1', 'название', 'заголовок', 'раздел', 'anchor', 'якорь', 'имя', 'title'];
  let urlIdx = -1, h1Idx = -1;
  for (let i = 0; i < headerRow.length; i += 1) {
    const c = norm(headerRow[i]);
    if (urlIdx === -1 && urlAliases.includes(c)) urlIdx = i;
    if (h1Idx  === -1 && h1Aliases.includes(c))  h1Idx  = i;
  }
  return { urlIdx, h1Idx };
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let v = value.trim();
  if (!/^https?:\/\//i.test(v) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
  } catch (_) { return null; }
}

async function parseExcelFile(file) {
  parseError.value = null;
  parseInfo.value  = null;

  // Validate type/size BEFORE invoking the heavy parser.
  if (file.size > MAX_FILE_SIZE) {
    parseError.value = `Файл слишком большой (${(file.size / 1024 / 1024).toFixed(1)} МБ, максимум 2 МБ)`;
    return;
  }
  // CSV не идёт через read-excel-file — поэтому делаем его отдельно ниже.
  const isCsv = /\.csv$/i.test(file.name) || file.type.includes('csv');
  if (!isCsv && !ALLOWED_FILE_TYPES.has(file.type) && !/\.(xlsx?|csv)$/i.test(file.name)) {
    parseError.value = 'Поддерживаются только .xlsx, .xls и .csv';
    return;
  }

  let rows = [];
  try {
    if (isCsv) {
      const text = await file.text();
      rows = parseCsv(text);
    } else {
      rows = await readXlsxFile(file);
    }
  } catch (err) {
    parseError.value = `Не удалось прочитать файл: ${err.message || err}`;
    return;
  }
  if (!Array.isArray(rows) || rows.length < 1) {
    parseError.value = 'Файл пустой';
    return;
  }

  // Авто-детект заголовков; если заголовков нет — считаем 1-я колонка url, 2-я h1.
  const header = rows[0] || [];
  const { urlIdx, h1Idx } = detectColumnIndices(header);
  const hasHeader = urlIdx !== -1 || h1Idx !== -1;
  const dataRows  = hasHeader ? rows.slice(1) : rows;
  const finalUrlIdx = urlIdx === -1 ? 0 : urlIdx;
  const finalH1Idx  = h1Idx  === -1 ? 1 : h1Idx;

  const links = [];
  let dropped = 0;
  const seen = new Set();
  for (const row of dataRows) {
    if (!Array.isArray(row)) continue;
    const url = isValidHttpUrl(row[finalUrlIdx]);
    const h1Raw = row[finalH1Idx];
    const h1 = (h1Raw == null ? '' : String(h1Raw).replace(/\s+/g, ' ').trim()).slice(0, 300);
    if (!url || !h1) { dropped += 1; continue; }
    if (seen.has(url)) { dropped += 1; continue; }
    seen.add(url);
    links.push({ url, h1 });
    if (links.length >= MAX_LINKS_CLIENT) break;
  }

  if (!links.length) {
    parseError.value = 'Не удалось извлечь ни одной валидной строки (нужны url + h1)';
    return;
  }
  fileMeta.value    = { name: file.name, size: file.size };
  parsedLinks.value = links;
  parseInfo.value   = `Загружено ${links.length} ссылок` + (dropped ? ` · отбраковано ${dropped}` : '');
}

// Минимальный CSV-парсер: запятая или точка с запятой как разделитель,
// поддержка двойных кавычек. Достаточно для типовых выгрузок из Excel и Google Sheets.
function parseCsv(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length);
  if (!lines.length) return [];
  // Угадываем разделитель по первой строке.
  const firstLine = lines[0];
  const delim = (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ';' : ',';
  const out = [];
  for (const line of lines) {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

function onFilesChosen(ev) {
  const file = ev.target?.files?.[0];
  if (file) parseExcelFile(file);
  ev.target.value = '';
}
function onDrop(ev) {
  ev.preventDefault();
  dropActive.value = false;
  const file = ev.dataTransfer?.files?.[0];
  if (file) parseExcelFile(file);
}

// ── Form submit ───────────────────────────────────────────────────────
async function handleCreate() {
  formError.value = null;
  const topic  = form.value.topic.trim();
  const region = form.value.region.trim();
  if (topic.length < 5)  { formError.value = 'Тема должна быть не короче 5 символов'; return; }
  if (!region)           { formError.value = 'Укажите регион'; return; }
  // Excel опционален: если файла нет — генерим статью БЕЗ перелинковки.
  // Парсинг ошибки (parseError ≠ null) при наличии файла остаётся блокирующим.
  if (parseError.value) {
    formError.value = 'Сначала исправьте ошибку Excel-парсера или очистите загруженный файл';
    return;
  }

  submitting.value = true;
  try {
    saveDraft();
    const payload = {
      topic,
      region,
      brand_name:   form.value.brand_name.trim(),
      author_name:  form.value.author_name.trim(),
      brand_facts:  form.value.brand_facts.trim(),
      output_format: form.value.output_format,
      commercial_links: parsedLinks.value,
      commercial_links_filename: fileMeta.value?.name || '',
    };
    const { id, normalized } = await store.createTask(payload);
    if (normalized) {
      parseInfo.value = `Серверная нормализация: ${normalized.kept} принято, ${normalized.dropped} отбраковано`;
    }
    await store.fetchTasks();
    if (id) await selectTask(id);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

// ── Tasks list + polling ──────────────────────────────────────────────
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
    pre_stage0:                'Стратегический анализ',
    stage0_audience:           'Анализ ЦА',
    stage1_intents:            'Сущности и интенты',
    stage1b_whitespace:        'White-space анализ',
    stage2_outline:            'Структура статьи',
    stage2b_lsi:               'LSI-набор',
    stage2c_link_plan:         'Семантическая перелинковка',
    stage3_writer:             'Написание статьи',
    stage5_audits:             'E-E-A-T + аудит ссылок',
    stage3_writer_refine:      'Корректировочный проход',
    stage4_image_prompts:      'Промпты изображений',
    image_generation:          'Генерация изображений',
    done:                      'Готово',
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
function formatTokens(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Generation timer ─────────────────────────────────────────────────
// Один общий «тиктак» 1 раз в секунду, пока на странице есть активная
// (running/queued) задача. Используется для пересчёта live-секундомера —
// сами поля started_at/completed_at в БД уже есть (миграция 017), так что
// никаких изменений на бэкенде не требуется.
const nowTick = ref(Date.now());
let tickTimer = null;

function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
}
function stopTicker() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function isActiveStatus(s) {
  return s === 'running' || s === 'queued';
}

/** Длительность генерации в миллисекундах. Для активных задач — от
 *  started_at до текущего тика; для done/error — от started_at до completed_at.
 *  Если started_at ещё не выставлен (queued, бэкенд не успел) — fallback на
 *  created_at, чтобы цифра не прыгала с «—» на большое число. */
function taskDurationMs(t) {
  if (!t) return 0;
  const startStr = t.started_at || t.created_at;
  if (!startStr) return 0;
  const start = Date.parse(startStr);
  if (!Number.isFinite(start)) return 0;
  const endStr = isActiveStatus(t.status) ? null : t.completed_at;
  const end = endStr ? Date.parse(endStr) : nowTick.value;
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}ч ${pad(m)}м ${pad(s)}с`;
  return `${pad(m)}:${pad(s)}`;
}

// ── Active task + SSE ────────────────────────────────────────────────
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
  activeResultTab.value = 'article';
  try {
    selectedTask.value = await store.getTask(id);
  } catch (err) {
    alert(err.response?.data?.error || 'Не удалось загрузить задачу');
    return;
  }
  if (selectedTask.value && (selectedTask.value.status === 'running' || selectedTask.value.status === 'queued')) {
    openStreamFor(id);
  }
}

function openStreamFor(id) {
  try {
    const token = auth.token || localStorage.getItem('seo_token') || '';
    // EventSource не поддерживает заголовки — токен идёт через query.
    // Тот же compromise что и в LinkArticlePage; rate-limit на роуте + JWT-проверка
    // в sseAuth страхуют от перебора.
    const url = `/api/info-article/${id}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    eventSource = es;
    es.onmessage = (ev) => {
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch (_) { parsed = { type: 'raw', data: ev.data }; }
      streamEvents.value.push(parsed);
      if (streamEvents.value.length > 200) streamEvents.value.splice(0, streamEvents.value.length - 200);
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
    es.onerror = () => { closeStream(); };
  } catch (err) { console.warn('[infoArticle] SSE init failed:', err.message); }
}

watch(() => store.tasks, (arr) => {
  if (!selectedTask.value) return;
  const fresh = arr.find((t) => t.id === selectedTask.value.id);
  if (fresh && fresh.status !== selectedTask.value.status) {
    store.getTask(selectedTask.value.id).then((t) => {
      if (t) selectedTask.value = { ...selectedTask.value, ...t };
    }).catch(() => {});
  }
}, { deep: true });

// ── Result tabs + helpers ────────────────────────────────────────────
const activeResultTab = ref('article'); // 'article' | 'links' | 'quality' | 'metrics'
const articlePreviewRef = ref(null);

const sanitizedHtml = computed(() => {
  const html = selectedTask.value?.article_html || '';
  if (!html) return '';
  // ALLOWED_URI_REGEXP допускает data:image/(png|jpeg|webp) — это base64 от
  // Nano Banana Pro, который мы сами генерируем на бэкенде. Sanitize применяется
  // ИСКЛЮЧИТЕЛЬНО к article_html текущего user_id; user-controlled HTML здесь
  // не проходит. Та же конфигурация, что и в LinkArticlePage.
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/(png|jpeg|jpg|webp);base64):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
});

async function copyAsHtml() {
  const html = selectedTask.value?.article_html;
  if (!html) return;

  // ВАЖНО: для «Скопировать как HTML» нам нужно положить в буфер
  // ИСХОДНУЮ HTML-разметку как обычный текст (text/plain), а НЕ как
  // text/html-flavor. Если положить text/html, любой WYSIWYG-редактор
  // (TinyMCE, Gutenberg, Word) при вставке выберет именно этот flavor
  // и отрисует разметку как форматированный текст — пользователь получит
  // не код `<h1>…</h1>`, а уже стилизованный заголовок. Поэтому ниже
  // мы НЕ кладём 'text/html' ни в ClipboardItem, ни как fallback —
  // только plain text. Для копирования рендеренного представления есть
  // отдельная кнопка copyAsFormattedText().

  // Path A: writeText — самый надёжный способ положить в буфер
  // строго plain text. Работает в secure context (HTTPS / localhost).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(html);
      flashToast('HTML скопирован');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // Path B: ClipboardItem только с text/plain (без text/html), для
  // окружений, где есть ClipboardItem, но writeText по какой-то причине
  // недоступен/заблокирован.
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const blobPlain = new Blob([html], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPlain })]);
      flashToast('HTML скопирован');
      return;
    }
  } catch (_) { /* fallthrough */ }

  // Path C (legacy fallback): document.execCommand('copy') через скрытый
  // <textarea>. Работает на HTTP / IP-адресах без secure context, что
  // нужно при доступе к приложению через локальную сеть или просто по IP.
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
      flashToast('HTML скопирован');
      return;
    }
    throw new Error('execCommand copy вернул false');
  } catch (err) {
    alert('Не удалось скопировать HTML: ' + (err.message || err));
  }
}

async function copyAsFormattedText() {
  if (!selectedTask.value) return;
  // Path A (приоритет): selection-based copy через execCommand —
  // обеспечивает корректную вставку в WYSIWYG-редакторы блогов и Word.
  await nextTick();
  const el = articlePreviewRef.value;
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    if (ok) { flashToast('Форматированный текст скопирован'); return; }
  } catch (_) { /* fallthrough */ }
  // Path B fallback: ClipboardItem с text/html.
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const htmlContent = el.innerHTML;
      const plain = selectedTask.value.article_plain || el.innerText || '';
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([htmlContent], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
      flashToast('Форматированный текст скопирован (fallback)');
    }
  } catch (err) { alert('Не удалось скопировать: ' + (err.message || err)); }
}

function downloadHtml() {
  const html = selectedTask.value?.article_html;
  if (!html) return;
  const blob = new Blob([
    `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>${escapeAttr(selectedTask.value.topic)}</title></head><body>${html}</body></html>`,
  ], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(selectedTask.value.topic)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function escapeAttr(s) { return String(s || '').replace(/[<>"&]/g, (c) => ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', '&':'&amp;' })[c]); }
function slug(s) { return String(s || 'article').toLowerCase().replace(/[^a-z0-9а-я]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'article'; }

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

// ── Quality / link-plan / E-E-A-T projections ────────────────────────
const eeatScore = computed(() => {
  const raw = selectedTask.value?.eeat_score;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});
const eeatReport = computed(() => selectedTask.value?.eeat_report || null);
const eeatBadgeClass = computed(() => {
  const s = eeatScore.value;
  if (s == null) return 'border-gray-700 bg-gray-900/40 text-gray-300';
  if (s >= 8.0)  return 'border-emerald-700 bg-emerald-900/30 text-emerald-200';
  if (s >= 7.5)  return 'border-lime-700 bg-lime-900/30 text-lime-200';
  if (s >= 6.0)  return 'border-amber-700 bg-amber-900/30 text-amber-200';
  return 'border-red-700 bg-red-900/30 text-red-200';
});
const linkPlan  = computed(() => Array.isArray(selectedTask.value?.link_plan) ? selectedTask.value.link_plan : []);
const linkAudit = computed(() => selectedTask.value?.link_audit || null);
const linkCoveragePct = computed(() => {
  const raw = linkAudit.value?.coverage_pct;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});
const linkBadgeClass = computed(() => {
  const c = linkCoveragePct.value;
  if (c == null) return 'border-gray-700 bg-gray-900/40 text-gray-300';
  if (c >= 100)  return 'border-emerald-700 bg-emerald-900/30 text-emerald-200';
  if (c >= 80)   return 'border-amber-700 bg-amber-900/30 text-amber-200';
  return 'border-red-700 bg-red-900/30 text-red-200';
});

const lsiSet = computed(() => selectedTask.value?.lsi_set || null);

const hasResult = computed(() => !!selectedTask.value?.article_html);

// Live cost (уже считается на бэкенде после каждой стадии).
const liveCost = computed(() => Number(selectedTask.value?.cost_usd || 0));

// Live длительность генерации текущей задачи (в мс) и её форматированный вид.
const liveDurationMs = computed(() => taskDurationMs(selectedTask.value));
const liveDurationLabel = computed(() => formatDuration(liveDurationMs.value));

// Запускаем секундомер пока виден активный таск (текущий или хотя бы один в
// списке). Это дёшево (один setInterval, ничего не дёргает на бэкенде).
const hasAnyActiveTask = computed(() => {
  const list = Array.isArray(store.tasks) ? store.tasks : [];
  return isActiveStatus(selectedTask.value?.status) || list.some((t) => isActiveStatus(t.status));
});
watch(hasAnyActiveTask, (active) => {
  if (active) startTicker(); else stopTicker();
}, { immediate: true });
onUnmounted(() => { stopTicker(); });
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <!-- Шапка -->
      <div class="flex items-end justify-between border-b border-gray-800 pb-4">
        <div>
          <h1 class="text-2xl font-bold text-white flex items-center gap-2">
            📰 Генератор информационной статьи в блог
          </h1>
          <p class="text-gray-400 text-sm mt-1">
            При загруженном Excel модель сама подберёт 1–2 семантически точных коммерческих ссылки
            на каждый <code class="text-indigo-300">&lt;h2&gt;</code>. Без Excel — статья создаётся
            <strong>без перелинковки</strong> (LSI/E-E-A-T/мнение эксперта/FAQ — всё на месте).
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Форма ── -->
        <form @submit.prevent="handleCreate" class="card space-y-4 lg:col-span-5">
          <h2 class="text-base font-bold text-indigo-300 uppercase tracking-wider">📝 Новая статья</h2>

          <div>
            <label class="label">Тема статьи <span class="text-red-400">*</span></label>
            <input v-model="form.topic" type="text" class="input" maxlength="200"
                   placeholder="Как выбрать школу английского для ребёнка" />
            <div class="text-[11px] text-gray-500 mt-1">{{ form.topic.length }} / 200 символов</div>
          </div>

          <div>
            <label class="label">Регион <span class="text-red-400">*</span></label>
            <input v-model="form.region" type="text" class="input" maxlength="200"
                   placeholder="Москва, РФ, Лиссабон, …" />
          </div>

          <!-- Excel uploader (опциональный) -->
          <div>
            <label class="label">
              Excel с коммерческими страницами
              <span class="text-gray-500 text-[11px] font-normal">(опционально)</span>
            </label>
            <div v-if="!parsedLinks.length"
                 class="mb-2 rounded-md border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[11px] text-amber-200">
              Без Excel-базы статья будет сгенерирована <strong>без перелинковки</strong>:
              коммерческие <code>&lt;a href&gt;</code> не вставляются, остальные шаги
              (LSI, мнение эксперта, FAQ, картинки, E-E-A-T аудит) — в полной силе.
            </div>
            <div class="rounded-lg border-2 border-dashed transition-colors p-4 text-center"
                 :class="dropActive ? 'border-indigo-500 bg-indigo-900/10' : 'border-gray-700 bg-gray-950'"
                 @dragover.prevent="dropActive = true"
                 @dragleave.prevent="dropActive = false"
                 @drop="onDrop">
              <div v-if="!parsedLinks.length">
                <div class="text-3xl mb-1">📥</div>
                <div class="text-sm text-gray-300">
                  Перетащите файл сюда или
                  <label class="text-indigo-400 hover:underline cursor-pointer">
                    выберите
                    <input type="file" class="hidden" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" @change="onFilesChosen" />
                  </label>
                </div>
                <div class="text-[11px] text-gray-500 mt-1">
                  .xlsx / .xls / .csv до 2 МБ; колонки <code>url</code> и <code>h1</code> (или «ссылка»/«название»)
                </div>
              </div>
              <div v-else class="text-left space-y-2">
                <div class="flex items-center justify-between">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-200 truncate">📊 {{ fileMeta?.name }}</div>
                    <div class="text-[11px] text-gray-500">
                      {{ parsedLinks.length }} ссылок · {{ ((fileMeta?.size || 0) / 1024).toFixed(1) }} КБ
                    </div>
                  </div>
                  <button type="button" class="btn-ghost text-xs" @click="clearLinks">✕ Очистить</button>
                </div>
                <div class="text-[11px] text-gray-500">Превью первых 5 строк:</div>
                <ul class="text-[11px] text-gray-400 max-h-32 overflow-auto bg-gray-950 rounded border border-gray-800 p-2 font-mono">
                  <li v-for="(l, i) in parsedLinks.slice(0, 5)" :key="i" class="truncate">
                    <span class="text-indigo-300">{{ l.h1 }}</span> →
                    <span class="text-gray-500">{{ l.url }}</span>
                  </li>
                  <li v-if="parsedLinks.length > 5" class="text-gray-600">… +{{ parsedLinks.length - 5 }}</li>
                </ul>
              </div>
            </div>
            <div v-if="parseError" class="mt-2 text-xs text-red-400">{{ parseError }}</div>
            <div v-else-if="parseInfo" class="mt-2 text-xs text-emerald-400">{{ parseInfo }}</div>
          </div>

          <!-- Optional collapsible block -->
          <div class="rounded-lg border border-gray-800">
            <button type="button"
                    class="w-full text-left px-3 py-2 text-xs uppercase tracking-wider text-gray-400 hover:text-gray-200 flex items-center justify-between"
                    @click="optionalOpen = !optionalOpen">
              <span>⚙ Опционально (бренд, автор, факты, формат)</span>
              <span>{{ optionalOpen ? '−' : '+' }}</span>
            </button>
            <div v-if="optionalOpen" class="p-3 space-y-3 border-t border-gray-800">
              <div>
                <label class="label">Бренд / название компании</label>
                <input v-model="form.brand_name" type="text" class="input" maxlength="200" placeholder="Если пусто — выведем из домена" />
              </div>
              <div>
                <label class="label">Имя автора</label>
                <input v-model="form.author_name" type="text" class="input" maxlength="200" placeholder="Например: Анна Петрова, методист" />
              </div>
              <div>
                <label class="label">Краткие факты о бренде / нише</label>
                <textarea v-model="form.brand_facts" rows="3" class="textarea" maxlength="4000"
                          placeholder="Например: 7 лет на рынке, методика Cambridge, школы в 4 городах…"></textarea>
              </div>
              <div>
                <label class="label">Формат вывода</label>
                <div class="flex gap-4 text-sm text-gray-300">
                  <label class="inline-flex items-center gap-2 cursor-pointer">
                    <input type="radio" v-model="form.output_format" value="html" class="accent-indigo-500" /> HTML
                  </label>
                  <label class="inline-flex items-center gap-2 cursor-pointer">
                    <input type="radio" v-model="form.output_format" value="formatted_text" class="accent-indigo-500" /> Форматированный текст
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div v-if="formError" class="p-3 rounded bg-red-900/30 border border-red-800 text-red-300 text-sm">{{ formError }}</div>

          <div class="flex items-center gap-3 pt-1">
            <button type="submit" class="btn-primary" :disabled="submitting">
              {{ submitting ? '⏳ Создание...' : '🚀 Сгенерировать статью' }}
            </button>
          </div>
        </form>

        <!-- ── Лента задач ── -->
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
                  <span class="font-mono"
                        :class="t.status === 'running' || t.status === 'queued' ? 'text-sky-400' : 'text-gray-500'">
                    · ⏱ {{ formatDuration(taskDurationMs(t)) }}
                  </span>
                  <span v-if="t.commercial_links_count">· {{ t.commercial_links_count }} ссылок</span>
                  <span v-if="t.eeat_score">· E-E-A-T {{ Number(t.eeat_score).toFixed(1) }}</span>
                </div>
              </div>
              <span class="text-[11px] px-2 py-0.5 rounded uppercase tracking-wider"
                    :class="statusBadgeClass(t.status)">{{ statusLabel(t.status) }}</span>
              <button class="btn-ghost text-xs px-2" @click.stop="handleDelete(t)" title="Удалить">✕</button>
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
              Регион: <span class="text-gray-300">{{ selectedTask.region || '—' }}</span>
              · {{ selectedTask.commercial_links_count }} коммерч. ссылок
              · Стоимость: <span class="text-gray-300">{{ formatCost(liveCost) }}</span>
              · Время: <span class="font-mono"
                             :class="selectedTask.status === 'running' || selectedTask.status === 'queued' ? 'text-sky-300' : 'text-gray-300'">{{ liveDurationLabel }}</span>
            </div>
          </div>
          <span class="text-[11px] px-2 py-0.5 rounded uppercase tracking-wider shrink-0"
                :class="statusBadgeClass(selectedTask.status)">{{ statusLabel(selectedTask.status) }}</span>
        </header>

        <!-- Прогресс -->
        <div v-if="selectedTask.status === 'running' || selectedTask.status === 'queued'" class="space-y-2">
          <div class="flex justify-between items-center text-xs text-gray-400">
            <span>{{ stageLabel(selectedTask.current_stage) }}</span>
            <span class="flex items-center gap-3">
              <span class="font-mono text-sky-300" title="Время с момента старта генерации">⏱ {{ liveDurationLabel }}</span>
              <span>{{ selectedTask.progress_pct || 0 }}%</span>
            </span>
          </div>
          <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div class="bg-indigo-500 h-2 transition-all duration-500"
                 :style="{ width: `${Math.min(100, selectedTask.progress_pct || 0)}%` }"></div>
          </div>
          <div v-if="streamEvents.length" class="text-[11px] text-gray-500 max-h-32 overflow-auto font-mono leading-tight">
            <div v-for="(ev, i) in streamEvents.slice(-12)" :key="i">
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
          <!-- Бейджи качества -->
          <div class="flex flex-wrap gap-2">
            <div v-if="eeatScore !== null" class="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm" :class="eeatBadgeClass">
              <span class="text-[11px] uppercase tracking-wider opacity-80">E-E-A-T</span>
              <span class="font-bold">{{ eeatScore.toFixed(1) }} / 10</span>
            </div>
            <div v-if="linkCoveragePct !== null" class="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm" :class="linkBadgeClass">
              <span class="text-[11px] uppercase tracking-wider opacity-80">Ссылки</span>
              <span class="font-bold">{{ linkCoveragePct }}% попаданий</span>
            </div>
          </div>

          <!-- Табы -->
          <div class="border-b border-gray-800 flex gap-1 -mb-px">
            <button v-for="tab in [
                     { k: 'article', label: '📄 Статья' },
                     { k: 'links',   label: '🔗 Перелинковка' },
                     { k: 'quality', label: '🧪 Качество' },
                     { k: 'metrics', label: '💰 Метрики' },
                   ]" :key="tab.k"
                   type="button"
                   class="px-3 py-2 text-xs uppercase tracking-wider border-b-2 transition-colors"
                   :class="activeResultTab === tab.k ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'"
                   @click="activeResultTab = tab.k">
              {{ tab.label }}
            </button>
          </div>

          <!-- TAB: Статья -->
          <div v-if="activeResultTab === 'article'" class="space-y-3">
            <div class="flex flex-wrap gap-2">
              <button class="btn-primary" @click="copyAsHtml">📋 Скопировать как HTML</button>
              <button class="btn-ghost border border-gray-700" @click="copyAsFormattedText">📝 Скопировать форматированный текст</button>
              <button class="btn-ghost border border-gray-700" @click="downloadHtml">⬇ Скачать .html</button>
            </div>
            <article ref="articlePreviewRef"
                     class="prose prose-invert max-w-none bg-gray-950 border border-gray-800 rounded-lg p-5 overflow-auto"
                     v-html="sanitizedHtml"></article>

            <div v-if="renderedImages.length" class="space-y-2">
              <h3 class="text-sm font-semibold text-indigo-300 uppercase tracking-wider">🖼 Изображения</h3>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div v-for="(img, idx) in renderedImages" :key="img.slot || idx"
                     class="bg-gray-950 border border-gray-800 rounded-lg p-2 space-y-2">
                  <img :src="`data:${img.mime_type || 'image/png'};base64,${img.image_base64}`"
                       :alt="img.alt_ru || ''"
                       class="w-full h-40 object-cover rounded" />
                  <div class="text-[11px] text-gray-400 truncate" :title="img.alt_ru">{{ img.alt_ru || '—' }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: Перелинковка -->
          <div v-if="activeResultTab === 'links'" class="space-y-3">
            <div v-if="linkAudit" class="text-xs text-gray-400">
              Вердикт: <span class="text-gray-200 font-semibold">{{ linkAudit.verdict || '—' }}</span>
              · вставлено: {{ linkAudit.total_inserted || 0 }} / {{ linkAudit.total_planned || 0 }}
              · misplacements: {{ (linkAudit.misplacements || []).length }}
              · extras: {{ (linkAudit.extras || []).length }}
              · density violations: {{ (linkAudit.density_violations || []).length }}
            </div>
            <div v-if="!linkPlan.length" class="text-sm text-gray-500">План перелинковки ещё не готов.</div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-xs border border-gray-800 rounded-lg">
                <thead class="bg-gray-900 text-gray-400 uppercase tracking-wider">
                  <tr>
                    <th class="px-2 py-2 text-left">H2</th>
                    <th class="px-2 py-2 text-left">URL</th>
                    <th class="px-2 py-2 text-left">Анкор</th>
                    <th class="px-2 py-2 text-left">Роль</th>
                    <th class="px-2 py-2 text-right">Score</th>
                    <th class="px-2 py-2 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="block in linkPlan" :key="block.h2_index">
                    <tr v-for="(p, i) in (block.picks || [])" :key="`${block.h2_index}-${i}`"
                        class="border-t border-gray-800 align-top">
                      <td class="px-2 py-2 text-gray-200" :class="{ 'pt-3': i === 0 }">
                        <span v-if="i === 0">#{{ block.h2_index }}: <span class="text-gray-400">{{ block.h2_text || block.h2 }}</span></span>
                      </td>
                      <td class="px-2 py-2 text-indigo-300 break-all">
                        <a :href="p.url" target="_blank" rel="noopener noreferrer">{{ p.url }}</a>
                      </td>
                      <td class="px-2 py-2 text-gray-200">{{ p.anchor_text }}</td>
                      <td class="px-2 py-2">
                        <span class="text-[10px] uppercase px-1.5 py-0.5 rounded"
                              :class="p.role === 'primary'
                                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-800'
                                : 'bg-sky-900/40 text-sky-300 border border-sky-800'">
                          {{ p.role || '—' }}
                        </span>
                      </td>
                      <td class="px-2 py-2 text-right text-gray-300 font-mono">{{ Number(p.semantic_score || 0).toFixed(2) }}</td>
                      <td class="px-2 py-2 text-gray-400">{{ p.reason || '—' }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>

          <!-- TAB: Качество -->
          <div v-if="activeResultTab === 'quality'" class="space-y-4">
            <div v-if="!eeatReport" class="text-sm text-gray-500">E-E-A-T аудит не выполнен.</div>
            <div v-else class="space-y-3">
              <div class="flex items-center gap-3 px-3 py-2 rounded-lg border" :class="eeatBadgeClass">
                <span class="text-[11px] uppercase tracking-wider opacity-80">PQ Score</span>
                <span class="text-base font-bold">{{ Number(eeatReport.total_score || 0).toFixed(1) }} / 10</span>
                <span v-if="eeatReport.verdict" class="text-[11px] uppercase opacity-80">· {{ eeatReport.verdict }}</span>
              </div>

              <div v-if="Array.isArray(eeatReport.factors) && eeatReport.factors.length"
                   class="space-y-2">
                <h4 class="text-sm text-indigo-300 uppercase tracking-wider">12 факторов E-E-A-T</h4>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div v-for="(f, i) in eeatReport.factors" :key="i"
                       class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                    <div class="flex items-center justify-between mb-1">
                      <div class="text-sm text-gray-200">{{ f.name || f.factor || `Фактор ${i + 1}` }}</div>
                      <div class="text-sm font-mono text-indigo-300">{{ Number(f.score || 0).toFixed(1) }}</div>
                    </div>
                    <div class="text-[11px] text-gray-500">{{ f.rationale || f.notes || '' }}</div>
                  </div>
                </div>
              </div>

              <div v-if="Array.isArray(eeatReport.issues) && eeatReport.issues.length"
                   class="space-y-2">
                <h4 class="text-sm text-amber-300 uppercase tracking-wider">Замечания ({{ eeatReport.issues.length }})</h4>
                <ul class="text-xs text-gray-300 list-disc list-inside space-y-1">
                  <li v-for="(it, i) in eeatReport.issues" :key="i">
                    <span class="text-amber-300">[{{ it.severity || 'minor' }}|{{ it.category || 'misc' }}]</span>
                    {{ it.problem }}
                    <span v-if="it.fix_instruction" class="text-gray-500"> → {{ it.fix_instruction }}</span>
                  </li>
                </ul>
              </div>
            </div>

            <div v-if="lsiSet" class="space-y-2">
              <h4 class="text-sm text-indigo-300 uppercase tracking-wider">LSI-набор</h4>
              <div class="text-[11px] text-gray-500 mb-1">important ({{ (lsiSet.important || []).length }})</div>
              <div class="flex flex-wrap gap-1">
                <span v-for="(t, i) in (lsiSet.important || [])" :key="`i-${i}`"
                      class="text-[11px] px-2 py-0.5 rounded bg-indigo-900/30 text-indigo-200 border border-indigo-800/40">{{ t }}</span>
              </div>
              <div v-if="(lsiSet.supporting || []).length" class="text-[11px] text-gray-500 mt-2 mb-1">supporting ({{ lsiSet.supporting.length }})</div>
              <div v-if="(lsiSet.supporting || []).length" class="flex flex-wrap gap-1">
                <span v-for="(t, i) in (lsiSet.supporting || [])" :key="`s-${i}`"
                      class="text-[11px] px-2 py-0.5 rounded bg-gray-900 text-gray-400 border border-gray-800">{{ t }}</span>
              </div>
            </div>
          </div>

          <!-- TAB: Метрики -->
          <div v-if="activeResultTab === 'metrics'" class="space-y-3">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[10px] uppercase text-gray-500">DeepSeek in</div>
                <div class="text-base text-gray-200 font-mono">{{ formatTokens(selectedTask.deepseek_tokens_in) }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[10px] uppercase text-gray-500">DeepSeek out</div>
                <div class="text-base text-gray-200 font-mono">{{ formatTokens(selectedTask.deepseek_tokens_out) }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[10px] uppercase text-gray-500">Gemini in</div>
                <div class="text-base text-gray-200 font-mono">{{ formatTokens(selectedTask.gemini_tokens_in) }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[10px] uppercase text-gray-500">Gemini out</div>
                <div class="text-base text-gray-200 font-mono">{{ formatTokens(selectedTask.gemini_tokens_out) }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[10px] uppercase text-gray-500">Image calls</div>
                <div class="text-base text-gray-200 font-mono">{{ selectedTask.gemini_image_calls || 0 }}</div>
              </div>
              <div class="bg-emerald-900/20 border border-emerald-800 rounded-lg p-3 col-span-2">
                <div class="text-[10px] uppercase text-emerald-300">Total cost</div>
                <div class="text-base text-emerald-100 font-mono">{{ formatCost(liveCost) }}</div>
              </div>
              <div class="bg-sky-900/20 border border-sky-800 rounded-lg p-3 col-span-2">
                <div class="text-[10px] uppercase text-sky-300">Время генерации</div>
                <div class="text-base text-sky-100 font-mono">⏱ {{ liveDurationLabel }}</div>
                <div v-if="selectedTask.started_at" class="text-[10px] text-sky-300/70 mt-0.5">
                  Старт: {{ formatDate(selectedTask.started_at) }}<span v-if="selectedTask.completed_at">
                  · Финиш: {{ formatDate(selectedTask.completed_at) }}</span>
                </div>
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
