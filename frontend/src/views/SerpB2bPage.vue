<script setup>
/**
 * SerpB2bPage — SERP Crawler & B2B Contact Extractor.
 *
 * Поток:
 *   1. Пользователь вводит поисковый запрос + кол-во страниц SERP +
 *      выбирает движок (Яндекс/Google) → POST /api/serp-b2b.
 *   2. Каждые 2 секунды поллим GET /api/serp-b2b/:id и подсвечиваем
 *      инкрементальные строки результата.
 *   3. По завершении («done») активируется кнопка «Скачать .xlsx».
 *
 * UI спроектирован в стиле Apple (Glassmorphism / SF Pro / 12-px радиусы):
 *   • фон #F5F5F7, карточки белые с лёгкой тенью,
 *   • прилипающий хедер таблицы с backdrop-filter: blur(10px),
 *   • Skeleton-строки во время парсинга,
 *   • кнопки `--apple-blue` (#0071E3) с плавными ховерами.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import { useSerpB2bStore } from '../stores/serpB2b.js';

const store = useSerpB2bStore();

// ── Форма ────────────────────────────────────────────────────────────
const form = ref({
  keyword: '',
  search_engine: 'yandex',
  depth_pages: 3,
  region: '', // код Яндекс-региона (lr); пусто = без географии
});

// Список регионов (Яндекс-коды lr). Покрывает Россию по федеральным
// округам + крупнейшие города; «Без региона» = пусто.
const REGION_OPTIONS = [
  { value: '',    label: 'Без региона (вся выдача)' },
  { value: '225', label: 'Россия' },
  { value: '213', label: 'Москва' },
  { value: '1',   label: 'Москва и область' },
  { value: '2',   label: 'Санкт-Петербург' },
  { value: '10174', label: 'Санкт-Петербург и область' },
  { value: '54',  label: 'Екатеринбург' },
  { value: '47',  label: 'Нижний Новгород' },
  { value: '43',  label: 'Казань' },
  { value: '65',  label: 'Новосибирск' },
  { value: '66',  label: 'Омск' },
  { value: '50',  label: 'Самара' },
  { value: '51',  label: 'Уфа' },
  { value: '63',  label: 'Челябинск' },
  { value: '35',  label: 'Краснодар' },
  { value: '39',  label: 'Ростов-на-Дону' },
  { value: '20',  label: 'Воронеж' },
  { value: '53',  label: 'Красноярск' },
  { value: '67',  label: 'Иркутск' },
  { value: '75',  label: 'Владивосток' },
  { value: '11316', label: 'Калининград' },
  { value: '23',  label: 'Волгоград' },
  { value: '38',  label: 'Тюмень' },
  { value: '187', label: 'Украина' },
  { value: '149', label: 'Беларусь' },
  { value: '159', label: 'Казахстан' },
];

const submitting = ref(false);
const formError = ref(null);

// ── Активная задача ──────────────────────────────────────────────────
const activeTask = ref(null);     // { id, status, results, total_sites, processed_sites, ... }
let pollTimer = null;

const isRunning = computed(() => {
  const s = activeTask.value?.status;
  return s === 'queued' || s === 'running';
});

const isDone = computed(() => activeTask.value?.status === 'done');
const isError = computed(() => activeTask.value?.status === 'error');

const progressPct = computed(() => {
  const t = activeTask.value;
  if (!t || !t.total_sites) return 0;
  return Math.min(100, Math.round((t.processed_sites / t.total_sites) * 100));
});

const progressLabel = computed(() => {
  const t = activeTask.value;
  if (!t) return '';
  if (t.status === 'queued') return 'Задача в очереди…';
  if (t.status === 'running') {
    if (!t.total_sites) return 'Получаем выдачу из поиска…';
    return `Обработано ${t.processed_sites || 0} / ${t.total_sites} сайтов`;
  }
  if (t.status === 'done') {
    return `Готово — ${t.processed_sites || 0} сайтов проверено`;
  }
  if (t.status === 'error') return `Ошибка: ${t.error_message || 'неизвестная ошибка'}`;
  return '';
});

// Скелетоны: показываем (total - processed) строк ПЛЮС начальный плейсхолдер,
// если total ещё не известен.
const skeletonCount = computed(() => {
  const t = activeTask.value;
  if (!t || !isRunning.value) return 0;
  if (!t.total_sites) return 6;
  return Math.max(0, t.total_sites - (t.processed_sites || 0));
});

const rows = computed(() => {
  const r = activeTask.value?.results;
  return Array.isArray(r) ? r : [];
});

// ── Ранее запущенные задачи (для быстрого переключения) ─────────────
const history = computed(() => store.tasks);

// ── Действия ─────────────────────────────────────────────────────────
async function startTask() {
  formError.value = null;
  if (!form.value.keyword.trim()) {
    formError.value = 'Введите поисковый запрос';
    return;
  }
  submitting.value = true;
  try {
    const selectedRegion = REGION_OPTIONS.find(r => r.value === form.value.region);
    const regionName = selectedRegion && selectedRegion.value !== '' ? selectedRegion.label : '';
    const taskName = regionName ? `${form.value.keyword.trim()} (${regionName})` : form.value.keyword.trim();

    const task = await store.createTask({
      name: taskName,
      keyword: form.value.keyword.trim(),
      search_engine: form.value.search_engine,
      depth_pages: Number(form.value.depth_pages) || 1,
      region: form.value.region || '',
    });
    if (!task?.id) throw new Error('Сервер не вернул задачу');
    activeTask.value = { ...task, results: [] };
    startPolling(task.id);
    await store.fetchTasks();
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Не удалось создать задачу';
  } finally {
    submitting.value = false;
  }
}

function startPolling(id) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const t = await store.getTask(id);
      if (!t) return;
      activeTask.value = t;
      if (t.status === 'done' || t.status === 'error') {
        stopPolling();
        await store.fetchTasks();
      }
    } catch (err) {
      // При сетевой ошибке просто подождём следующий тик.
      // eslint-disable-next-line no-console
      console.warn('[serpB2b] poll failed:', err.message);
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function openHistoryTask(t) {
  stopPolling();
  const fresh = await store.getTask(t.id);
  if (!fresh) return;
  activeTask.value = fresh;
  if (fresh.status === 'queued' || fresh.status === 'running') startPolling(t.id);
}

async function deleteHistoryTask(t) {
  if (!confirm(`Удалить задачу «${t.name || t.query}»?`)) return;
  try {
    await store.deleteTask(t.id);
    if (activeTask.value?.id === t.id) {
      stopPolling();
      activeTask.value = null;
    }
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Не удалось удалить';
  }
}

function copyTable() {
  if (!rows.value.length) return;
  const headers = ['#', 'Сайт', 'Юр. лицо', 'ИНН', 'Контакты'];
  const lines = [headers.join('\t')];
  rows.value.forEach((r, i) => {
    const site = r.url || '';
    const company = r.company_name || '';
    const inn = r.inn || '';
    const contacts = [
      ...(r.phones || []),
      ...(r.emails || []),
    ].join(', ');
    lines.push([i + 1, site, company, inn, contacts].join('\t'));
  });
  const tsv = lines.join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    alert('Таблица скопирована в буфер обмена');
  }).catch(err => {
    console.error('Failed to copy: ', err);
  });
}

async function downloadXlsx() {
  if (!activeTask.value?.id) return;
  // Скачиваем через api с Bearer-токеном (axios с responseType:'blob').
  const api = (await import('../api.js')).default;
  try {
    const { data, headers } = await api.get(
      `/serp-b2b/${activeTask.value.id}/export.xlsx`,
      { responseType: 'blob' },
    );
    const blob = new Blob([data], {
      type: headers['content-type']
        || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serp-b2b-${activeTask.value.id.slice(0, 8)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Не удалось скачать XLSX';
  }
}

function fmtList(arr) {
  return Array.isArray(arr) ? arr.filter(Boolean).join(', ') : (arr || '');
}

// Возвращает массивы [сотовые, городские]. Если бэкенд уже посчитал
// разбиение — используем его; иначе классифицируем по первой цифре кода
// зоны (9XX → сотовый).
function splitPhones(row) {
  if (Array.isArray(row.phones_mobile) || Array.isArray(row.phones_landline)) {
    return [
      Array.isArray(row.phones_mobile) ? row.phones_mobile : [],
      Array.isArray(row.phones_landline) ? row.phones_landline : [],
    ];
  }
  const mobile = [];
  const landline = [];
  for (const p of (row.phones || [])) {
    const digits = String(p || '').replace(/\D+/g, '');
    if (digits.length >= 11 && digits[1] === '9') mobile.push(p);
    else landline.push(p);
  }
  return [mobile, landline];
}

function rowStatusLabel(s) {
  if (s === 'ok')      return 'Найдено';
  if (s === 'empty')   return 'Пусто';
  if (s === 'error')   return 'Ошибка';
  if (s === 'pending') return '…';
  return s || '';
}

// Источник имени юр. лица (`company_name_source`) — короткий бейдж.
function companyNameSourceLabel(s) {
  if (!s) return '';
  const map = { jsonld: 'JSON-LD', html: 'HTML', dadata: 'Dadata', llm: 'LLM' };
  return map[String(s).toLowerCase()] || String(s);
}

// Статус юр. лица в реестре (`company_status`, как у Dadata).
// Возвращает {label, kind} — kind влияет на цвет бейджа.
function companyStatusInfo(s) {
  if (!s) return null;
  const norm = String(s).toUpperCase();
  if (norm === 'ACTIVE')       return { label: 'действует',     kind: 'ok' };
  if (norm === 'LIQUIDATING')  return { label: 'ликвидируется', kind: 'warn' };
  if (norm === 'LIQUIDATED')   return { label: 'ликвидирована', kind: 'bad' };
  if (norm === 'BANKRUPT')     return { label: 'банкрот',       kind: 'bad' };
  if (norm === 'REORGANIZING') return { label: 'реорганизация', kind: 'warn' };
  return { label: String(s), kind: 'neutral' };
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ru-RU'); } catch (_) { return iso; }
}

// ── Lifecycle ────────────────────────────────────────────────────────
onMounted(async () => {
  await store.fetchTasks();
});

onUnmounted(() => stopPolling());
</script>

<template>
  <AppLayout>
    <div class="serp-b2b-root">
      <!-- ── Заголовок ───────────────────────────────────────────── -->
      <header class="page-header">
        <h1>SERP B2B-парсер</h1>
        <p class="subtitle">
          Соберите контакты компаний из поисковой выдачи —
          сайт, реквизиты, телефон, email — и выгрузите в Excel.
        </p>
      </header>

      <!-- ── Форма запуска ───────────────────────────────────────── -->
      <section class="card form-card">
        <div class="form-grid">
          <div class="field field-wide">
            <label for="keyword">Поисковый запрос</label>
            <input
              id="keyword" v-model="form.keyword"
              type="text" placeholder="например, оптовые поставщики кофе"
              :disabled="submitting || isRunning"
              @keyup.enter="startTask"
            />
          </div>
          <div class="field">
            <label for="engine">Поисковик</label>
            <select id="engine" v-model="form.search_engine" :disabled="submitting || isRunning">
              <option value="yandex">Яндекс</option>
              <option value="google">Google</option>
            </select>
          </div>
          <div class="field">
            <label for="region">Регион</label>
            <select id="region" v-model="form.region" :disabled="submitting || isRunning">
              <option v-for="r in REGION_OPTIONS" :key="r.value" :value="r.value">
                {{ r.label }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="depth">Страниц SERP</label>
            <input
              id="depth" v-model.number="form.depth_pages"
              type="number" min="1" max="10"
              :disabled="submitting || isRunning"
            />
          </div>
          <div class="field field-actions">
            <button
              class="btn btn-primary"
              :disabled="submitting || isRunning"
              @click="startTask"
            >
              <span v-if="submitting || isRunning">Парсим…</span>
              <span v-else>Запустить парсинг</span>
            </button>
          </div>
        </div>
        <div v-if="formError" class="form-error">{{ formError }}</div>
      </section>

      <!-- ── Прогресс / результаты ───────────────────────────────── -->
      <section v-if="activeTask" class="card results-card">
        <div class="results-head">
          <div class="results-title">
            <h2>{{ activeTask.name || activeTask.query }}</h2>
            <span class="badge" :class="`badge-${activeTask.status}`">
              {{ rowStatusLabel(activeTask.status) || activeTask.status }}
            </span>
          </div>
          <div class="results-actions">
            <button
              class="btn btn-secondary"
              :disabled="!isDone || !rows.length"
              @click="copyTable"
              style="margin-right: 8px;"
            >
              ⎘ Скопировать таблицу
            </button>
            <button
              class="btn btn-secondary"
              :disabled="!isDone || !rows.length"
              @click="downloadXlsx"
            >
              ⤓ Скачать .xlsx
            </button>
          </div>
        </div>

        <div v-if="isRunning || isDone" class="progress-line">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: `${progressPct}%` }"></div>
          </div>
          <div class="progress-label">{{ progressLabel }}</div>
        </div>
        <div v-else-if="isError" class="error-box">{{ progressLabel }}</div>

        <div class="table-wrap">
          <table class="data-grid">
            <thead>
              <tr>
                <th class="col-num col-sticky col-sticky-1">#</th>
                <th class="col-sticky col-sticky-2">Сайт</th>
                <th>Юр. лицо</th>
                <th>ИНН</th>
                <th>ОГРН</th>
                <th>Сотовый</th>
                <th>Городской</th>
                <th>Email</th>
                <th>Услуги</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in rows" :key="`${row.url}-${i}`">
                <td class="col-num col-sticky col-sticky-1">{{ i + 1 }}</td>
                <td class="col-sticky col-sticky-2">
                  <a :href="row.url" target="_blank" rel="noopener noreferrer">
                    {{ row.url }}
                  </a>
                </td>
                <td class="company-cell">
                  <template v-if="row.company_name">
                    <div class="company-name">{{ row.company_name }}</div>
                    <div class="company-meta">
                      <span
                        v-if="companyStatusInfo(row.company_status)"
                        class="entity-badge"
                        :class="`entity-${companyStatusInfo(row.company_status).kind}`"
                        :title="`Статус юр. лица в реестре: ${companyStatusInfo(row.company_status).label}`"
                      >{{ companyStatusInfo(row.company_status).label }}</span>
                      <span
                        v-if="row.company_name_source"
                        class="source-badge"
                        :title="`Источник имени: ${companyNameSourceLabel(row.company_name_source)}`"
                      >{{ companyNameSourceLabel(row.company_name_source) }}</span>
                    </div>
                  </template>
                  <template v-else>—</template>
                </td>
                <td class="mono">{{ row.inn || '—' }}</td>
                <td class="mono">{{ row.ogrn || '—' }}</td>
                <td>{{ fmtList(splitPhones(row)[0]) || '—' }}</td>
                <td>{{ fmtList(splitPhones(row)[1]) || '—' }}</td>
                <td class="email-cell">{{ fmtList(row.emails) || '—' }}</td>
                <td class="services-cell">{{ fmtList(row.services) || '—' }}</td>
                <td>
                  <span class="row-badge" :class="`row-${row.status}`">
                    {{ rowStatusLabel(row.status) }}
                  </span>
                </td>
              </tr>
              <!-- Skeleton-строки для ещё необработанных сайтов -->
              <tr v-for="n in skeletonCount" :key="`sk-${n}`" class="skeleton-row">
                <td class="col-num col-sticky col-sticky-1">{{ rows.length + n }}</td>
                <td colspan="9"><div class="skeleton-bar"></div></td>
              </tr>
              <tr v-if="!rows.length && !isRunning && isDone">
                <td colspan="10" class="empty-row">
                  Не удалось извлечь контакты ни с одного сайта.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ── История задач ───────────────────────────────────────── -->
      <section v-if="history.length" class="card history-card">
        <h2>Предыдущие задачи</h2>
        <ul class="history-list">
          <li v-for="t in history" :key="t.id" class="history-row">
            <button class="history-main" @click="openHistoryTask(t)">
              <span class="history-query">{{ t.name || t.query }}</span>
              <span class="history-meta">
                {{ t.search_engine }} · {{ t.depth_pages }} стр. ·
                {{ t.processed_sites || 0 }}/{{ t.total_sites || 0 }} сайтов ·
                {{ fmtDate(t.created_at) }}
              </span>
            </button>
            <span class="badge badge-sm" :class="`badge-${t.status}`">
              {{ rowStatusLabel(t.status) || t.status }}
            </span>
            <button class="history-del" @click="deleteHistoryTask(t)">×</button>
          </li>
        </ul>
      </section>
    </div>
  </AppLayout>
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────────
 * Apple Design Language: SF Pro, светло-серый фон, мягкие тени,
 * 12-px радиусы, glassmorphism для прилипающего хедера таблицы.
 * ───────────────────────────────────────────────────────────────────── */

.serp-b2b-root {
  --apple-bg:        #F5F5F7;
  --apple-card:      #FFFFFF;
  --apple-text:      #1D1D1F;
  --apple-muted:     #86868B;
  --apple-blue:      #0071E3;
  --apple-blue-hov:  #0077ED;
  --apple-border:    rgba(0, 0, 0, 0.06);
  --apple-shadow:    0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.05);

  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
               'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: var(--apple-text);
  background: var(--apple-bg);
  min-height: calc(100vh - 80px);
  padding: 32px 24px 64px;
  max-width: 1280px;
  margin: 0 auto;
}

/* ── Заголовок ─────────────────────────────────────────────────────── */
.page-header {
  margin-bottom: 24px;
}
.page-header h1 {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
}
.subtitle {
  color: var(--apple-muted);
  font-size: 15px;
  margin: 0;
  max-width: 640px;
  line-height: 1.5;
}

/* ── Карточки ──────────────────────────────────────────────────────── */
.card {
  background: var(--apple-card);
  border: 1px solid var(--apple-border);
  border-radius: 14px;
  box-shadow: var(--apple-shadow);
  padding: 20px 22px;
  margin-bottom: 20px;
}

/* ── Форма ─────────────────────────────────────────────────────────── */
.form-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr auto;
  gap: 14px 16px;
  align-items: end;
}
.field { display: flex; flex-direction: column; }
.field-wide { grid-column: 1 / 2; }
.field-actions { align-self: end; }
.field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--apple-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.field input, .field select {
  font: inherit;
  font-size: 15px;
  padding: 10px 12px;
  border: 1px solid var(--apple-border);
  border-radius: 10px;
  background: #FBFBFD;
  color: var(--apple-text);
  transition: border 0.18s, box-shadow 0.18s;
}
.field input:focus, .field select:focus {
  outline: none;
  border-color: var(--apple-blue);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
}
.field input:disabled, .field select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn {
  font: inherit; font-weight: 500;
  font-size: 15px;
  padding: 10px 18px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}
.btn-primary {
  background: var(--apple-blue);
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  background: var(--apple-blue-hov);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 113, 227, 0.25);
}
.btn-primary:disabled {
  opacity: 0.5; cursor: not-allowed;
}
.btn-secondary {
  background: #F5F5F7;
  color: var(--apple-text);
  border-color: var(--apple-border);
}
.btn-secondary:hover:not(:disabled) {
  background: #ECECEE;
}
.btn-secondary:disabled {
  opacity: 0.45; cursor: not-allowed;
}

.form-error {
  margin-top: 12px;
  padding: 10px 14px;
  background: rgba(255, 59, 48, 0.08);
  color: #B00020;
  border-radius: 10px;
  font-size: 14px;
}

/* ── Прогресс ──────────────────────────────────────────────────────── */
.results-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 16px; margin-bottom: 16px;
}
.results-title {
  display: flex; align-items: center; gap: 12px; min-width: 0;
}
.results-title h2 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 720px;
}

.progress-line {
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 14px;
}
.progress-bar {
  flex: 1;
  height: 6px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 999px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--apple-blue), #5AC8FA);
  border-radius: 999px;
  transition: width 0.4s ease;
}
.progress-label {
  font-size: 13px;
  color: var(--apple-muted);
  white-space: nowrap;
}

.error-box {
  padding: 12px 14px;
  background: rgba(255, 59, 48, 0.08);
  color: #B00020;
  border-radius: 10px;
  font-size: 14px;
  margin-bottom: 14px;
}

/* ── Таблица ───────────────────────────────────────────────────────── */
.table-wrap {
  border: 1px solid var(--apple-border);
  border-radius: 12px;
  /* Горизонтальный скролл нужен для широкой таблицы (10 колонок:
     #, Сайт, Юр.лицо, ИНН, ОГРН, Сотовый, Городской, Email, Услуги, Статус).
     На узких экранах пользователь скроллит вправо к реквизитам, а
     первые два столбца («#» и «Сайт») остаются прилипшими слева — без
     этого непонятно, какому сайту принадлежит строка. */
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  background: #fff;
}
.data-grid {
  /* min-width вместо 100% — даёт строкам растянуться шире контейнера и
     включает горизонтальный скролл. */
  min-width: 1100px;
  width: 100%;
  border-collapse: separate; /* для sticky-колонок нужен separate */
  border-spacing: 0;
  font-size: 14px;
}
.data-grid thead th {
  position: sticky; top: 0; z-index: 2;
  background: rgba(245, 245, 247, 0.95);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--apple-muted);
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid var(--apple-border);
}
.data-grid tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  vertical-align: top;
  background: #fff;
}
.data-grid tbody tr:last-child td {
  border-bottom: none;
}
.data-grid tbody tr:hover td {
  background: #F4F8FF;
}

/* Прилипшие первые два столбца (# + Сайт) — пользователь видит, к
   какому сайту относятся реквизиты при скролле вправо. */
.col-sticky {
  position: sticky;
  left: 0;
  z-index: 1;
}
.col-sticky-1 { left: 0; min-width: 40px; }
.col-sticky-2 {
  left: 40px;
  min-width: 220px;
  max-width: 320px;
  /* Тень-разделитель между прилипшими колонками и скроллящимися. */
  box-shadow: 4px 0 6px -4px rgba(0, 0, 0, 0.08);
}
.data-grid thead th.col-sticky { z-index: 3; }
.col-num {
  width: 40px;
  color: var(--apple-muted);
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
}
.email-cell {
  word-break: break-all;
}
.services-cell {
  max-width: 280px;
  font-size: 13px;
  color: var(--apple-text);
}

/* Колонка «Юр. лицо»: имя + бейджи статуса/источника. */
.company-cell .company-name {
  font-weight: 500;
  line-height: 1.3;
}
.company-cell .company-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.entity-badge,
.source-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 6px;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.entity-ok {
  background: rgba(52, 199, 89, 0.12);
  color: #1F8A3F;
}
.entity-warn {
  background: rgba(255, 159, 10, 0.15);
  color: #B25C00;
}
.entity-bad {
  background: rgba(255, 59, 48, 0.13);
  color: #B81E14;
}
.entity-neutral {
  background: rgba(0, 0, 0, 0.06);
  color: var(--apple-muted);
}
.source-badge {
  background: rgba(0, 113, 227, 0.10);
  color: #0050A0;
}
.data-grid a {
  color: var(--apple-blue);
  text-decoration: none;
}
.data-grid a:hover {
  text-decoration: underline;
}
.empty-row {
  text-align: center;
  color: var(--apple-muted);
  padding: 24px 16px !important;
}

/* ── Skeleton-строки ───────────────────────────────────────────────── */
.skeleton-row td { padding: 14px 16px; }
.skeleton-bar {
  height: 14px;
  border-radius: 6px;
  background: linear-gradient(90deg,
    rgba(0, 0, 0, 0.04) 0%,
    rgba(0, 0, 0, 0.10) 50%,
    rgba(0, 0, 0, 0.04) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── Бейджи ────────────────────────────────────────────────────────── */
.badge, .row-badge {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
  color: var(--apple-text);
  white-space: nowrap;
}
.badge-sm { font-size: 11px; padding: 2px 8px; }
.badge-running, .badge-queued { background: rgba(0, 113, 227, 0.12); color: var(--apple-blue); }
.badge-done { background: rgba(48, 209, 88, 0.15); color: #1D9F3F; }
.badge-error { background: rgba(255, 59, 48, 0.12); color: #B00020; }
.row-ok { background: rgba(48, 209, 88, 0.15); color: #1D9F3F; }
.row-empty { background: rgba(255, 159, 10, 0.15); color: #C77100; }
.row-error { background: rgba(255, 59, 48, 0.12); color: #B00020; }
.row-pending { background: rgba(0, 0, 0, 0.06); color: var(--apple-muted); }

/* ── История ───────────────────────────────────────────────────────── */
.history-card h2 {
  font-size: 16px; font-weight: 600; margin: 0 0 12px;
}
.history-list {
  list-style: none; padding: 0; margin: 0;
}
.history-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  transition: background 0.15s;
}
.history-row:hover { background: #FAFAFC; }
.history-main {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start;
  gap: 2px;
  background: none; border: none; padding: 0;
  cursor: pointer; text-align: left; font: inherit;
}
.history-query {
  font-size: 14px; font-weight: 500; color: var(--apple-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 720px;
}
.history-meta {
  font-size: 12px; color: var(--apple-muted);
}
.history-del {
  background: none; border: none; cursor: pointer;
  width: 28px; height: 28px; border-radius: 50%;
  font-size: 18px; line-height: 1;
  color: var(--apple-muted);
  transition: all 0.15s;
}
.history-del:hover {
  background: rgba(255, 59, 48, 0.1);
  color: #B00020;
}

/* ── Адаптив ───────────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .form-grid {
    grid-template-columns: 1fr 1fr;
  }
  .field-wide { grid-column: 1 / -1; }
  .field-actions { grid-column: 1 / -1; }
  .data-grid { font-size: 13px; }
  .data-grid thead th, .data-grid tbody td { padding: 10px 12px; }
}
</style>
