<script setup>
/**
 * ProposalConstructorPage — конструктор КП «Фронт работ» (5 шагов).
 *   Шаг 1 — настройки КП (название, клиент, горизонт 3/6, дата, менеджер, исполнитель).
 *   Шаг 2 — выбор задач: аккордеон модулей с чекбоксами, один или несколько месяцев для каждой задачи,
 *           фильтры (приоритет / месяц / поиск / только выбранные), боковая панель
 *           со счётчиком по месяцам, редактирование справочника (модули и задачи
 *           можно добавлять/менять/удалять — правки сохраняются для всех КП).
 *   Шаг 3 — предпросмотр: Таблица / Список / Kanban по месяцам.
 *   Шаг 4 — стоимость: основной + доп. бюджет, месяц или «Общее», итоги, прайс-лист.
 *   Шаг 5 — формирование: сохранить, скачать PDF/Excel, публичная ссылка.
 *   Автосохранение черновика каждые 30 сек. + «Сбросить всё» с подтверждением.
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const route = useRoute();
const router = useRouter();

const proposalId = ref(route.params.id || null);
const step = ref(1);
const STEPS = ['Настройки', 'Задачи', 'Предпросмотр', 'Стоимость', 'Формирование'];

const form = reactive({
  title: '',
  client: '',
  manager: '',
  responsible: '',   // исполнитель по умолчанию для выбираемых задач
  horizon: 3,
  start_date: '',
  status: 'draft',
});

// ── Справочник модулей ──
const modules = ref([]);
const openModules = ref({});
const catalogLoading = ref(false);

// selection: catalogTaskId → { months: [1, 2, …], responsible }
const selection = reactive({});
// Задачи КП, которых нет в справочнике (например, задача каталога удалена).
const extraTasks = ref([]);

const error = ref(null);
const notice = ref(null);
let noticeTimer = null;
function flash(msg) {
  notice.value = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = null; }, 4000);
}

const PRIORITY_BADGE = {
  high: { label: '🔴 Высокий', cls: 'bg-red-900/50 text-red-300' },
  medium: { label: '🟡 Средний', cls: 'bg-yellow-900/50 text-yellow-300' },
  low: { label: '🟢 Низкий', cls: 'bg-emerald-900/50 text-emerald-300' },
};

const months = computed(() => Array.from({ length: Number(form.horizon) }, (_, i) => i + 1));

// ── Фильтры шага 2 ──
const filterPriority = ref('');
const filterMonth = ref('');
const filterText = ref('');
const onlySelected = ref(false);

function taskVisible(t) {
  if (filterPriority.value && t.priority !== filterPriority.value) return false;
  if (onlySelected.value && !selection[t.id]) return false;
  if (filterMonth.value && (!selection[t.id] || !(selection[t.id].months || []).some((m) => String(m) === String(filterMonth.value)))) return false;
  if (filterText.value) {
    const q = filterText.value.toLowerCase();
    if (!`${t.title} ${t.description || ''} ${t.tool || ''}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

const filteredModules = computed(() =>
  modules.value
    .map((m) => ({ ...m, visibleTasks: (m.tasks || []).filter(taskVisible) }))
    .filter((m) => m.visibleTasks.length > 0 || !(filterText.value || filterPriority.value || filterMonth.value || onlySelected.value)),
);

// ── Счётчики (боковая панель) ──
const selectedCount = computed(() => Object.keys(selection).length + extraTasks.value.length);
const countsByMonth = computed(() => {
  const counts = {};
  for (const m of months.value) counts[m] = 0;
  for (const sel of Object.values(selection)) {
    for (const mo of sel.months || []) {
      const m = Math.min(Number(mo) || 1, Number(form.horizon));
      counts[m] = (counts[m] || 0) + 1;
    }
  }
  for (const t of extraTasks.value) {
    const m = Math.min(Number(t.month) || 1, Number(form.horizon));
    counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
});

function toggleTask(t, moduleObj) {
  if (selection[t.id]) delete selection[t.id];
  else selection[t.id] = { months: [1], responsible: form.responsible || '', _module: moduleObj.id };
}
function selectAllModule(m, on) {
  for (const t of m.tasks || []) {
    if (on && !selection[t.id]) selection[t.id] = { months: [1], responsible: form.responsible || '', _module: m.id };
    if (!on && selection[t.id]) delete selection[t.id];
  }
}
// Переключение месяца у выбранной задачи (мультивыбор, минимум один месяц).
function toggleTaskMonth(taskId, mo) {
  const sel = selection[taskId];
  if (!sel) return;
  const months = sel.months || [];
  if (months.includes(mo)) {
    if (months.length > 1) sel.months = months.filter((m) => m !== mo);
  } else {
    sel.months = [...months, mo].sort((a, b) => a - b);
  }
}
// Быстрая периодичность: ежемесячно / через месяц / разово (месяц 1).
function setTaskRecurrence(taskId, mode) {
  const sel = selection[taskId];
  if (!sel) return;
  const h = Number(form.horizon) || 3;
  if (mode === 'monthly') sel.months = months.value.slice();
  else if (mode === 'every_2') sel.months = months.value.filter((m) => m % 2 === 1);
  else sel.months = [Math.min(sel.months?.[0] || 1, h)];
}
// Подпись периодичности — та же логика, что показывается клиенту
// (backend/src/services/proposals/mediaPlan.js).
function recurrenceLabel(monthsArr = []) {
  const uniq = [...new Set(monthsArr.map((m) => Number(m) || 1))].sort((a, b) => a - b);
  if (!uniq.length) return '—';
  if (uniq.length === 1) return `Разово · М${uniq[0]}`;
  const h = Number(form.horizon) || 3;
  if (uniq.length === h && uniq[0] === 1 && uniq[uniq.length - 1] === h) return 'Ежемесячно';
  const steps = uniq.slice(1).map((m, i) => m - uniq[i]);
  if (steps.every((s) => s === 2)) return `Раз в 2 месяца · ${uniq.map((m) => `М${m}`).join(', ')}`;
  return uniq.map((m) => `М${m}`).join(', ');
}
// Склонение: 1 работа / 2 работы / 5 работ.
function worksWord(n) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'работ';
  if (last > 1 && last < 5) return 'работы';
  if (last === 1) return 'работа';
  return 'работ';
}
function moduleSelectedCount(m) {
  return (m.tasks || []).filter((t) => selection[t.id]).length;
}

// При смене горизонта 6 → 3 задачи из месяцев 4–6 переезжают в месяц 3.
watch(() => form.horizon, (h) => {
  for (const sel of Object.values(selection)) {
    const clamped = [...new Set((sel.months || []).map((m) => Math.min(Number(m) || 1, Number(h))))].sort((a, b) => a - b);
    sel.months = clamped.length ? clamped : [1];
  }
  for (const t of extraTasks.value) {
    if (Number(t.month) > Number(h)) t.month = Number(h);
  }
  for (const p of pricing.value) {
    if (p.month !== '' && Number(p.month) > Number(h)) p.month = Number(h);
  }
});

// ── Сборка задач КП из выбора ──
function buildTasks() {
  const out = [];
  for (const m of modules.value) {
    for (const t of m.tasks || []) {
      const sel = selection[t.id];
      if (!sel) continue;
      for (const mo of sel.months || [1]) {
        out.push({
          module_id: m.id,
          module_name: m.name,
          task_id: t.id,
          task_title: t.title,
          task_description: t.description,
          priority: t.priority,
          tool: t.tool,
          month: Number(mo) || 1,
          responsible: sel.responsible || form.responsible || '',
        });
      }
    }
  }
  for (const t of extraTasks.value) out.push({ ...t });
  return out;
}

const previewTasks = computed(() => buildTasks().sort((a, b) =>
  (a.month - b.month)
  || ((a.module_id || 0) - (b.module_id || 0))
  || String(a.task_id || '').localeCompare(String(b.task_id || ''), undefined, { numeric: true })));

// По умолчанию — медиа-план: именно этот формат первым видит клиент
// на публичной странице КП.
const previewMode = ref('mediaplan'); // mediaplan | kanban | table | list

// Медиа-план: уникальные задачи (строки) × месяцы (колонки), Set месяцев на задачу.
// Ровно тот же вид, который получает клиент по публичной ссылке и в PDF/Excel.
const mediaPlanRows = computed(() => {
  const map = new Map();
  for (const t of previewTasks.value) {
    const key = `${t.module_id || ''}·${t.task_id || ''}·${t.task_title || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        module_id: t.module_id,
        module_name: t.module_name,
        task_id: t.task_id,
        task_title: t.task_title,
        task_description: t.task_description,
        priority: t.priority,
        months: new Set(),
      });
    }
    map.get(key).months.add(Number(t.month) || 1);
  }
  return Array.from(map.values());
});

// Медиа-план, сгруппированный по модулям (как в клиентском виде).
const mediaPlanModules = computed(() => {
  const groups = [];
  const index = new Map();
  for (const row of mediaPlanRows.value) {
    // Работы без модуля собираются в одну общую группу.
    const name = row.module_name || 'Прочие работы';
    const key = row.module_id ?? `name:${name}`;
    let group = index.get(key);
    if (!group) {
      group = { key, module_id: row.module_id, module_name: name, rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
});

const previewCountsByMonth = computed(() => {
  const counts = {};
  for (const m of months.value) counts[m] = 0;
  for (const t of previewTasks.value) {
    const m = Number(t.month) || 1;
    counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
});

// ── Стоимость ──
const pricing = ref([]);
const templates = ref([]);

function addPricingRow(preset) {
  pricing.value.push({
    item_name: preset?.item_name || '',
    base_budget: preset ? Number(preset.base_budget) : 0,
    additional_budget: '',
    additional_note: '',
    month: '',
    currency: preset?.currency || 'RUB',
  });
}
function removePricingRow(i) { pricing.value.splice(i, 1); }
function rowTotal(p) {
  return (Number(p.base_budget) || 0) + (Number(p.additional_budget) || 0);
}
const pricingTotals = computed(() => {
  const byMonth = {};
  let base = 0; let add = 0;
  for (const p of pricing.value) {
    const key = p.month === '' || p.month == null ? 'total' : Number(p.month);
    if (!byMonth[key]) byMonth[key] = { base: 0, add: 0 };
    byMonth[key].base += Number(p.base_budget) || 0;
    byMonth[key].add += Number(p.additional_budget) || 0;
    base += Number(p.base_budget) || 0;
    add += Number(p.additional_budget) || 0;
  }
  return { byMonth, base, add, grand: base + add };
});
function fmtMoney(v) { return Number(v || 0).toLocaleString('ru-RU'); }

// ── Сохранение / автосохранение ──
const saving = ref(false);
const lastSavedAt = ref(null);
const dirty = ref(false);
let autosaveTimer = null;

watch([form, selection, extraTasks, pricing], () => { dirty.value = true; }, { deep: true });

function buildPayload() {
  return {
    title: form.title.trim(),
    client: form.client,
    manager: form.manager,
    horizon: Number(form.horizon),
    start_date: form.start_date || null,
    status: form.status,
    tasks: buildTasks(),
    pricing: pricing.value
      .filter((p) => String(p.item_name || '').trim())
      .map((p) => ({
        item_name: p.item_name,
        base_budget: Number(p.base_budget) || 0,
        additional_budget: p.additional_budget === '' ? null : Number(p.additional_budget) || null,
        additional_note: p.additional_note,
        month: p.month === '' ? null : Number(p.month),
        currency: p.currency || 'RUB',
      })),
  };
}

async function save({ silent } = {}) {
  if (!form.title.trim()) {
    if (!silent) error.value = 'Название КП обязательно';
    return false;
  }
  saving.value = true;
  error.value = null;
  try {
    const payload = buildPayload();
    if (proposalId.value) {
      await api.put(`/proposals/${proposalId.value}`, payload);
    } else {
      const { data } = await api.post('/proposals', payload);
      proposalId.value = data.proposal.id;
      router.replace(`/proposals/${proposalId.value}`);
    }
    dirty.value = false;
    lastSavedAt.value = new Date();
    if (!silent) flash('💾 Черновик сохранён');
    else flash('💾 Автосохранение выполнено');
    return true;
  } catch (e) {
    if (!silent) error.value = e.response?.data?.error || 'Не удалось сохранить КП';
    return false;
  } finally {
    saving.value = false;
  }
}

function resetAll() {
  if (!confirm('Сбросить всё? Выбранные задачи, месяцы и стоимость будут очищены.')) return;
  for (const k of Object.keys(selection)) delete selection[k];
  extraTasks.value = [];
  pricing.value = [];
  flash('Форма очищена');
}

// ── Шаг 5: формирование ──
const generating = ref(false);
const shareUrl = ref('');

// Предупреждение о несохранённых изменениях при закрытии вкладки.
function beforeUnload(e) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}

// Чек-лист готовности КП — что ещё стоит заполнить перед отправкой клиенту.
const readiness = computed(() => [
  { ok: !!form.title.trim(), label: 'Название КП заполнено' },
  { ok: !!form.client.trim(), label: 'Указан клиент (сайт / компания)' },
  { ok: previewTasks.value.length > 0, label: 'Выбраны работы' },
  {
    ok: months.value.every((m) => (previewCountsByMonth.value[m] || 0) > 0),
    label: 'В каждом месяце есть работы',
  },
  { ok: pricingTotals.value.grand > 0, label: 'Заполнена стоимость' },
  { ok: !!form.manager.trim(), label: 'Указан менеджер (контакт для клиента)' },
  { ok: !!form.start_date, label: 'Указана дата начала' },
]);
const readinessScore = computed(() => readiness.value.filter((r) => r.ok).length);

async function generate() {
  generating.value = true;
  try {
    const ok = await save({ silent: true });
    if (!ok) { error.value = 'Заполните название КП (шаг 1)'; return; }
    await download('pdf');
    await download('xlsx');
    flash('✅ КП сформировано и сохранено в историю');
  } finally {
    generating.value = false;
  }
}

async function download(ext) {
  if (!proposalId.value) { const ok = await save({ silent: true }); if (!ok) return; }
  try {
    const { data } = await api.get(`/proposals/${proposalId.value}/export/${ext}`, { responseType: 'blob' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(form.title || 'proposal').replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = 'Не удалось скачать файл';
  }
}

async function createShare() {
  if (!proposalId.value) { const ok = await save({ silent: true }); if (!ok) return; }
  try {
    const { data } = await api.post(`/proposals/${proposalId.value}/share`);
    shareUrl.value = `${window.location.origin}/proposal/share/${data.share_token}`;
  } catch (e) {
    error.value = e.response?.data?.error || 'Не удалось создать ссылку';
  }
}
async function revokeShare() {
  try {
    await api.delete(`/proposals/${proposalId.value}/share`);
    shareUrl.value = '';
    flash('Публичная ссылка отозвана');
  } catch (e) { /* ignore */ }
}
function copyShare() {
  navigator.clipboard?.writeText(shareUrl.value);
  flash('Ссылка скопирована');
}

// ── Редактирование справочника (модули/задачи можно менять — сохраняется везде) ──
const catalogEdit = ref(false);
const editingTask = ref(null);   // { ...task, module_id } или { module_id } для новой
const editingModule = ref(null); // { id?, name, description, estimated_days }

function openTaskEditor(moduleId, task) {
  editingTask.value = task
    ? { id: task.id, module_id: moduleId, title: task.title, description: task.description || '', tool: task.tool || '', priority: task.priority }
    : { id: null, module_id: moduleId, title: '', description: '', tool: '', priority: 'medium' };
}
async function saveTaskEditor() {
  const t = editingTask.value;
  if (!t || !t.title.trim()) return;
  try {
    if (t.id) {
      await api.put(`/proposals/modules/tasks/${t.id}`, { title: t.title, description: t.description, tool: t.tool, priority: t.priority });
    } else {
      await api.post(`/proposals/modules/${t.module_id}/tasks`, { title: t.title, description: t.description, tool: t.tool, priority: t.priority });
    }
    editingTask.value = null;
    await loadCatalog();
    flash('Справочник обновлён — правка доступна во всех КП');
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось сохранить задачу');
  }
}
async function deleteCatalogTask(t) {
  if (!confirm(`Удалить задачу «${t.title}» из справочника? Она исчезнет из конструктора для всех новых КП.`)) return;
  try {
    await api.delete(`/proposals/modules/tasks/${t.id}`);
    delete selection[t.id];
    await loadCatalog();
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось удалить задачу');
  }
}
function openModuleEditor(m) {
  editingModule.value = m
    ? { id: m.id, name: m.name, description: m.description || '', estimated_days: m.estimated_days || '' }
    : { id: null, name: '', description: '', estimated_days: '' };
}
async function saveModuleEditor() {
  const m = editingModule.value;
  if (!m || !m.name.trim()) return;
  try {
    if (m.id) await api.put(`/proposals/modules/${m.id}`, m);
    else await api.post('/proposals/modules', m);
    editingModule.value = null;
    await loadCatalog();
    flash('Справочник обновлён');
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось сохранить модуль');
  }
}
async function deleteCatalogModule(m) {
  if (!confirm(`Удалить модуль «${m.name}» вместе со всеми его задачами из справочника?`)) return;
  try {
    await api.delete(`/proposals/modules/${m.id}`);
    for (const t of m.tasks || []) delete selection[t.id];
    await loadCatalog();
  } catch (e) {
    alert(e.response?.data?.error || 'Не удалось удалить модуль');
  }
}

// ── Загрузка ──
async function loadCatalog() {
  catalogLoading.value = true;
  try {
    const { data } = await api.get('/proposals/modules');
    modules.value = data.modules || [];
  } finally {
    catalogLoading.value = false;
  }
}

async function loadTemplates() {
  try {
    const { data } = await api.get('/proposals/pricing-templates');
    templates.value = data.templates || [];
  } catch (e) { /* прайс-лист опционален */ }
}

async function loadProposal(id) {
  const { data } = await api.get(`/proposals/${id}`);
  const p = data.proposal;
  form.title = p.title;
  form.client = p.client || '';
  form.manager = p.manager || '';
  form.horizon = Number(p.horizon) || 3;
  form.start_date = p.start_date ? String(p.start_date).slice(0, 10) : '';
  form.status = p.status;
  if (p.share_token) shareUrl.value = `${window.location.origin}/proposal/share/${p.share_token}`;

  const catalogIds = new Set();
  for (const m of modules.value) for (const t of m.tasks || []) catalogIds.add(t.id);

  // Полный сброс прошлого выбора: иначе при переходе между КП в одном
  // экземпляре страницы задачи предыдущего КП «прилипают» к текущему.
  for (const k of Object.keys(selection)) delete selection[k];
  extraTasks.value = [];
  for (const t of p.tasks || []) {
    if (t.task_id && catalogIds.has(t.task_id)) {
      const mo = Number(t.month) || 1;
      if (selection[t.task_id]) {
        if (!selection[t.task_id].months.includes(mo)) {
          selection[t.task_id].months = [...selection[t.task_id].months, mo].sort((a, b) => a - b);
        }
      } else {
        selection[t.task_id] = { months: [mo], responsible: t.responsible || '' };
      }
    } else {
      extraTasks.value.push({
        module_id: t.module_id, module_name: t.module_name, task_id: t.task_id,
        task_title: t.task_title, task_description: t.task_description,
        priority: t.priority, tool: t.tool, month: Number(t.month) || 1,
        responsible: t.responsible || '',
      });
    }
  }
  pricing.value = (p.pricing || []).map((x) => ({
    item_name: x.item_name,
    base_budget: Number(x.base_budget) || 0,
    additional_budget: x.additional_budget == null ? '' : Number(x.additional_budget),
    additional_note: x.additional_note || '',
    month: x.month == null ? '' : Number(x.month),
    currency: x.currency || 'RUB',
  }));
}

onMounted(async () => {
  try {
    await loadCatalog();
    await loadTemplates();
    if (proposalId.value) await loadProposal(proposalId.value);
    if (modules.value[0]) openModules.value[modules.value[0].id] = true;
  } catch (e) {
    error.value = e.response?.data?.error || 'Не удалось загрузить данные';
  }
  // Автосохранение черновика каждые 30 секунд (только если есть изменения).
  autosaveTimer = setInterval(() => {
    if (dirty.value && form.title.trim() && !saving.value) save({ silent: true });
  }, 30_000);
  // Сброс dirty после первичной загрузки.
  setTimeout(() => { dirty.value = false; }, 0);
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => {
  clearInterval(autosaveTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-7xl mx-auto">
      <!-- Заголовок + прогресс-бар -->
      <header class="mb-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="text-xl font-semibold text-gray-100">
              🧱 {{ proposalId ? 'Редактирование КП' : 'Новое КП' }}
              <span v-if="form.title" class="text-gray-400 font-normal">— {{ form.title }}</span>
            </h1>
            <p class="text-xs text-gray-500 mt-1">
              Шаг {{ step }}/5 · {{ STEPS[step - 1] }}
              <span v-if="lastSavedAt" class="ml-2">· сохранено {{ lastSavedAt.toLocaleTimeString('ru-RU') }}</span>
            </p>
          </div>
          <div class="flex gap-2">
            <router-link to="/proposals" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">← История</router-link>
            <button @click="resetAll" class="px-3 py-2 text-sm rounded-lg border border-red-900 text-red-400 hover:text-red-300 transition">Сбросить всё</button>
            <button @click="save()" :disabled="saving"
              class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition">
              {{ saving ? 'Сохраняю…' : '💾 Сохранить' }}
            </button>
          </div>
        </div>
        <!-- Прогресс-бар шагов -->
        <div class="flex gap-1 mt-4">
          <button v-for="(name, i) in STEPS" :key="i" @click="step = i + 1"
            class="flex-1 rounded-lg py-2 text-xs font-medium transition border"
            :class="step === i + 1
              ? 'bg-indigo-600 border-indigo-500 text-white'
              : 'bg-gray-950 border-gray-800 text-gray-400 hover:text-gray-200'">
            {{ i + 1 }}. {{ name }}
          </button>
        </div>
      </header>

      <div v-if="notice" class="mb-3 p-2.5 rounded-lg bg-emerald-900/40 border border-emerald-800 text-emerald-300 text-sm">{{ notice }}</div>
      <div v-if="error" class="mb-3 p-2.5 rounded-lg bg-red-900/40 border border-red-800 text-red-300 text-sm">{{ error }}</div>

      <!-- ─── Шаг 1: Настройки ─────────────────────────────────── -->
      <section v-if="step === 1" class="bg-gray-900 border border-gray-800 rounded-xl p-5 max-w-2xl">
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Название КП <span class="text-red-400">*</span></label>
            <input v-model="form.title" type="text" maxlength="255" placeholder="Например: SEO-продвижение example.ru — H2 2026"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Клиент (сайт / компания)</label>
            <input v-model="form.client" type="text" maxlength="255"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-2">Горизонт</label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 text-sm text-gray-200">
                <input type="radio" :value="3" v-model.number="form.horizon" /> 3 месяца
              </label>
              <label class="flex items-center gap-2 text-sm text-gray-200">
                <input type="radio" :value="6" v-model.number="form.horizon" /> 6 месяцев
              </label>
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Дата начала</label>
            <input v-model="form.start_date" type="date"
              class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Менеджер</label>
              <input v-model="form.manager" type="text" maxlength="255"
                class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">Исполнитель (по умолчанию)</label>
              <input v-model="form.responsible" type="text" maxlength="255"
                class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
            </div>
          </div>
          <div class="pt-2">
            <button @click="step = 2" class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition">Далее: выбор задач →</button>
          </div>
        </div>
      </section>

      <!-- ─── Шаг 2: Выбор задач ───────────────────────────────── -->
      <section v-if="step === 2" class="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-5">
        <div>
          <!-- Фильтры -->
          <div class="flex flex-wrap gap-2 mb-3">
            <input v-model="filterText" type="text" placeholder="Поиск по задачам…"
              class="flex-1 min-w-[180px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
            <select v-model="filterPriority" class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
              <option value="">Любой приоритет</option>
              <option value="high">🔴 Высокий</option>
              <option value="medium">🟡 Средний</option>
              <option value="low">🟢 Низкий</option>
            </select>
            <select v-model="filterMonth" class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
              <option value="">Любой месяц</option>
              <option v-for="m in months" :key="m" :value="String(m)">Месяц {{ m }}</option>
            </select>
            <label class="flex items-center gap-2 text-sm text-gray-300 px-2">
              <input v-model="onlySelected" type="checkbox" class="rounded" /> только выбранные
            </label>
            <label class="flex items-center gap-2 text-sm text-gray-300 px-2" title="Редактирование справочника: правки сохраняются для всех КП">
              <input v-model="catalogEdit" type="checkbox" class="rounded" /> ✏️ редактировать справочник
            </label>
          </div>

          <div v-if="catalogEdit" class="mb-3">
            <button @click="openModuleEditor(null)"
              class="px-3 py-1.5 text-xs rounded-lg border border-dashed border-gray-600 text-gray-400 hover:text-white transition">
              ➕ Добавить модуль
            </button>
          </div>

          <div v-if="catalogLoading" class="text-gray-400 text-sm py-6">Загрузка справочника…</div>

          <!-- Аккордеон модулей -->
          <div v-for="m in filteredModules" :key="m.id" class="mb-2 border border-gray-800 rounded-xl overflow-hidden">
            <div class="flex items-center justify-between bg-gray-900 px-4 py-3 cursor-pointer" @click="openModules[m.id] = !openModules[m.id]">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-gray-500">{{ openModules[m.id] ? '▾' : '▸' }}</span>
                <span class="font-medium text-gray-100 truncate">{{ m.id }}. {{ m.name }}</span>
                <span class="text-xs text-gray-500 shrink-0">{{ (m.tasks || []).length }} задач · {{ m.estimated_days || '—' }}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span v-if="moduleSelectedCount(m)" class="text-xs px-2 py-0.5 rounded-full bg-indigo-900/60 text-indigo-300">выбрано {{ moduleSelectedCount(m) }}</span>
                <button @click.stop="selectAllModule(m, true)" class="text-xs text-gray-400 hover:text-white">Выбрать всё</button>
                <button @click.stop="selectAllModule(m, false)" class="text-xs text-gray-400 hover:text-white">Снять всё</button>
                <template v-if="catalogEdit">
                  <button @click.stop="openModuleEditor(m)" class="text-xs text-gray-400 hover:text-white" title="Изменить модуль">✏️</button>
                  <button @click.stop="deleteCatalogModule(m)" class="text-xs text-gray-400 hover:text-red-400" title="Удалить модуль">🗑️</button>
                </template>
              </div>
            </div>
            <div v-if="openModules[m.id]" class="divide-y divide-gray-800 bg-gray-950">
              <p v-if="m.description" class="px-4 py-2 text-xs text-gray-500">{{ m.description }}</p>
              <div v-for="t in m.visibleTasks" :key="t.id" class="px-4 py-2.5 flex flex-wrap items-start gap-2">
                <label class="flex items-start gap-2 flex-1 min-w-[240px] cursor-pointer">
                  <input type="checkbox" :checked="!!selection[t.id]" @change="toggleTask(t, m)" class="mt-1 rounded" />
                  <span>
                    <span class="text-sm text-gray-100">{{ t.id }} · {{ t.title }}</span>
                    <span class="ml-2 text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span>
                    <span v-if="t.tool" class="ml-2 text-xs text-gray-500">🛠 {{ t.tool }}</span>
                    <span v-if="t.description" class="block text-xs text-gray-500 mt-0.5">{{ t.description }}</span>
                  </span>
                </label>
                <div class="flex items-center gap-1 shrink-0">
                  <div v-if="selection[t.id]" class="flex flex-col items-end gap-1">
                    <div class="flex flex-wrap gap-1" title="Можно выбрать несколько месяцев">
                      <button v-for="mo in months" :key="mo" type="button" @click="toggleTaskMonth(t.id, mo)"
                        class="px-2 py-1 text-xs rounded-lg border transition"
                        :class="(selection[t.id].months || []).includes(mo)
                          ? 'bg-indigo-600 border-indigo-500 text-white'
                          : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'">
                        М{{ mo }}
                      </button>
                    </div>
                    <div class="flex flex-wrap gap-1 justify-end">
                      <button type="button" @click="setTaskRecurrence(t.id, 'monthly')"
                        class="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-white transition"
                        title="Работа выполняется каждый месяц">Ежемесячно</button>
                      <button type="button" @click="setTaskRecurrence(t.id, 'every_2')"
                        class="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-white transition"
                        title="Работа выполняется через месяц">Через месяц</button>
                      <button type="button" @click="setTaskRecurrence(t.id, 'once')"
                        class="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-white transition"
                        title="Работа выполняется один раз">Разово</button>
                      <span class="text-[11px] text-gray-500 self-center">{{ recurrenceLabel(selection[t.id].months || []) }}</span>
                    </div>
                  </div>
                  <template v-if="catalogEdit">
                    <button @click="openTaskEditor(m.id, t)" class="text-xs text-gray-400 hover:text-white px-1" title="Изменить задачу">✏️</button>
                    <button @click="deleteCatalogTask(t)" class="text-xs text-gray-400 hover:text-red-400 px-1" title="Удалить задачу">🗑️</button>
                  </template>
                </div>
              </div>
              <div v-if="catalogEdit" class="px-4 py-2">
                <button @click="openTaskEditor(m.id, null)" class="text-xs text-gray-400 hover:text-white border border-dashed border-gray-700 rounded-lg px-3 py-1.5">➕ Добавить задачу в модуль</button>
              </div>
            </div>
          </div>

          <div class="flex justify-between mt-4">
            <button @click="step = 1" class="px-4 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 transition">← Назад</button>
            <button @click="step = 3" class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition">Далее: предпросмотр →</button>
          </div>
        </div>

        <!-- Боковая панель: счётчик по месяцам -->
        <aside class="lg:sticky lg:top-4 h-fit bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 class="text-sm font-semibold text-gray-100 mb-3">📊 Задачи по месяцам</h3>
          <div v-for="m in months" :key="m" class="flex items-center justify-between text-sm py-1.5 border-b border-gray-800 last:border-0">
            <span class="text-gray-400">Месяц {{ m }}</span>
            <span class="text-gray-100 font-medium">{{ countsByMonth[m] || 0 }}</span>
          </div>
          <div class="flex items-center justify-between text-sm pt-3 font-semibold">
            <span class="text-gray-300">Всего выбрано</span>
            <span class="text-indigo-400">{{ selectedCount }}</span>
          </div>
        </aside>
      </section>

      <!-- ─── Шаг 3: Предпросмотр ──────────────────────────────── -->
      <section v-if="step === 3">
        <div class="flex items-center justify-between mb-3">
          <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm">
            <button v-for="v in [['mediaplan','🗓 Медиа-план'],['kanban','🧩 Kanban'],['table','📋 Таблица'],['list','📝 Список']]" :key="v[0]"
              @click="previewMode = v[0]"
              class="px-4 py-1.5 font-medium transition"
              :class="previewMode === v[0] ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'">
              {{ v[1] }}
            </button>
          </div>
          <span class="text-sm text-gray-400">{{ previewTasks.length }} задач</span>
        </div>

        <div v-if="!previewTasks.length" class="text-center py-10 text-gray-500">Задачи ещё не выбраны — вернитесь на шаг 2.</div>

        <!-- Таблица -->
        <div v-else-if="previewMode === 'table'" class="overflow-x-auto rounded-xl border border-gray-800">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-900 text-gray-400 text-left">
              <tr>
                <th class="px-3 py-2 font-medium">Месяц</th>
                <th class="px-3 py-2 font-medium">Модуль</th>
                <th class="px-3 py-2 font-medium">Задача</th>
                <th class="px-3 py-2 font-medium">Описание</th>
                <th class="px-3 py-2 font-medium">Приоритет</th>
                <th class="px-3 py-2 font-medium">Инструмент</th>
                <th class="px-3 py-2 font-medium">Исполнитель</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800 bg-gray-950">
              <tr v-for="(t, i) in previewTasks" :key="i">
                <td class="px-3 py-2 text-gray-300">{{ t.month }}</td>
                <td class="px-3 py-2 text-gray-300">{{ t.module_name }}</td>
                <td class="px-3 py-2 text-gray-100">{{ t.task_id }} · {{ t.task_title }}</td>
                <td class="px-3 py-2 text-gray-500 text-xs max-w-md">{{ t.task_description }}</td>
                <td class="px-3 py-2"><span class="text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span></td>
                <td class="px-3 py-2 text-gray-400 text-xs">{{ t.tool }}</td>
                <td class="px-3 py-2 text-gray-400 text-xs">{{ t.responsible || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Список -->
        <div v-else-if="previewMode === 'list'" class="space-y-4">
          <div v-for="m in months" :key="m">
            <template v-if="previewTasks.some((t) => t.month === m)">
              <h3 class="text-sm font-semibold text-gray-200 mb-2">Месяц {{ m }}</h3>
              <ul class="space-y-1.5">
                <li v-for="(t, i) in previewTasks.filter((x) => x.month === m)" :key="i"
                  class="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm">
                  <span class="text-gray-500 text-xs">{{ t.module_name }}</span>
                  <span class="block text-gray-100">{{ t.task_id }} · {{ t.task_title }}
                    <span class="ml-2 text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span>
                  </span>
                  <span v-if="t.task_description" class="block text-xs text-gray-500 mt-0.5">{{ t.task_description }}</span>
                </li>
              </ul>
            </template>
          </div>
        </div>

        <!-- Kanban -->
        <div v-else-if="previewMode === 'kanban'" class="grid gap-3" :style="{ gridTemplateColumns: `repeat(${months.length}, minmax(220px, 1fr))` }">
          <div v-for="m in months" :key="m" class="bg-gray-900 border border-gray-800 rounded-xl p-3 min-h-[140px]">
            <h3 class="text-xs font-semibold text-gray-300 mb-2">Месяц {{ m }} · {{ previewTasks.filter((t) => t.month === m).length }}</h3>
            <div v-for="(t, i) in previewTasks.filter((x) => x.month === m)" :key="i"
              class="bg-gray-950 border border-gray-800 rounded-lg p-2 mb-2 text-xs">
              <span class="text-gray-500 block">{{ t.module_name }}</span>
              <span class="text-gray-100">{{ t.task_title }}</span>
              <span class="block mt-1 px-1.5 py-0.5 rounded w-fit" :class="PRIORITY_BADGE[t.priority]?.cls">{{ PRIORITY_BADGE[t.priority]?.label }}</span>
            </div>
          </div>
        </div>

        <!-- Медиа-план: месяцы сверху, работы слева, закрашенные ячейки -->
        <div v-else>
          <p class="mb-2 text-xs text-gray-500">👁 Именно так фронт работ увидит клиент по публичной ссылке и в PDF/Excel.</p>
          <div class="overflow-x-auto rounded-xl border border-gray-800">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-900 text-gray-400 text-left">
                <tr>
                  <th class="px-3 py-2 font-medium sticky left-0 bg-gray-900 min-w-[280px]">Фронт работ</th>
                  <th class="px-3 py-2 font-medium min-w-[130px]">Периодичность</th>
                  <th v-for="m in months" :key="m" class="px-3 py-2 font-medium text-center whitespace-nowrap">Месяц {{ m }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800 bg-gray-950">
                <template v-for="mod in mediaPlanModules" :key="mod.key">
                  <tr class="bg-gray-900/60">
                    <td :colspan="months.length + 2" class="px-3 py-1.5 text-xs font-semibold text-indigo-300 sticky left-0 bg-gray-900/60">
                      {{ mod.module_name }} · {{ mod.rows.length }} {{ worksWord(mod.rows.length) }}
                    </td>
                  </tr>
                  <tr v-for="(row, i) in mod.rows" :key="`${mod.key}-${i}`">
                    <td class="px-3 py-2 sticky left-0 bg-gray-950">
                      <span class="text-gray-100">{{ row.task_id }} · {{ row.task_title }}
                        <span class="ml-1 text-xs px-1.5 py-0.5 rounded" :class="PRIORITY_BADGE[row.priority]?.cls">{{ PRIORITY_BADGE[row.priority]?.label }}</span>
                      </span>
                      <span v-if="row.task_description" class="block text-xs text-gray-500 mt-0.5 max-w-md">{{ row.task_description }}</span>
                    </td>
                    <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{{ recurrenceLabel([...row.months]) }}</td>
                    <td v-for="m in months" :key="m" class="px-1.5 py-1.5 text-center align-middle">
                      <div class="h-7 rounded-md mx-auto"
                        :class="row.months.has(m) ? 'bg-indigo-500/80 shadow-[0_0_8px_rgba(99,102,241,0.35)]' : 'bg-gray-900 border border-gray-800/60'"
                        :title="row.months.has(m) ? `Месяц ${m}: выполняется` : ''"></div>
                    </td>
                  </tr>
                </template>
              </tbody>
              <tfoot>
                <tr class="bg-gray-900 text-gray-400">
                  <td class="px-3 py-2 text-xs font-medium sticky left-0 bg-gray-900">Работ в месяце</td>
                  <td class="px-3 py-2"></td>
                  <td v-for="m in months" :key="m" class="px-3 py-2 text-center text-xs text-gray-200">{{ previewCountsByMonth[m] || 0 }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div class="flex justify-between mt-4">
          <button @click="step = 2" class="px-4 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 transition">← Назад</button>
          <button @click="step = 4" class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition">Далее: стоимость →</button>
        </div>
      </section>

      <!-- ─── Шаг 4: Стоимость ─────────────────────────────────── -->
      <section v-if="step === 4">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 class="text-lg font-semibold text-gray-100">💰 Стоимость</h2>
          <div class="flex gap-2">
            <select v-if="templates.length" @change="(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) addPricingRow(t); e.target.value = ''; }"
              class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
              <option value="">＋ Из прайс-листа…</option>
              <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.item_name }} — {{ fmtMoney(t.base_budget) }} ₽</option>
            </select>
            <button @click="addPricingRow()" class="px-3 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition">➕ Статья</button>
          </div>
        </div>

        <div class="overflow-x-auto rounded-xl border border-gray-800">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-900 text-gray-400 text-left">
              <tr>
                <th class="px-3 py-2 font-medium">Название статьи *</th>
                <th class="px-3 py-2 font-medium">Основной бюджет *</th>
                <th class="px-3 py-2 font-medium">Доп. бюджет</th>
                <th class="px-3 py-2 font-medium">Описание доп. бюджета</th>
                <th class="px-3 py-2 font-medium">Месяц *</th>
                <th class="px-3 py-2 font-medium text-right">Итого</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-800 bg-gray-950">
              <tr v-for="(p, i) in pricing" :key="i">
                <td class="px-2 py-1.5"><input v-model="p.item_name" type="text" class="w-full min-w-[180px] bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-1.5"><input v-model.number="p.base_budget" type="number" min="0" class="w-28 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-1.5"><input v-model="p.additional_budget" type="number" min="0" class="w-28 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100" /></td>
                <td class="px-2 py-1.5"><textarea v-model="p.additional_note" rows="1" class="w-full min-w-[160px] bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100"></textarea></td>
                <td class="px-2 py-1.5">
                  <select v-model="p.month" class="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-100">
                    <option value="">Общее</option>
                    <option v-for="m in months" :key="m" :value="m">Месяц {{ m }}</option>
                  </select>
                </td>
                <td class="px-2 py-1.5 text-right text-gray-100">{{ fmtMoney(rowTotal(p)) }}</td>
                <td class="px-2 py-1.5 text-right"><button @click="removePricingRow(i)" class="text-gray-500 hover:text-red-400">🗑️</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Итоговые строки -->
        <div class="mt-4 bg-gray-900 border border-gray-800 rounded-xl p-4 max-w-lg space-y-1.5 text-sm">
          <template v-for="m in months" :key="m">
            <div v-if="pricingTotals.byMonth[m]" class="flex justify-between text-gray-300">
              <span>Месяц {{ m }}: основной {{ fmtMoney(pricingTotals.byMonth[m].base) }} / доп. {{ fmtMoney(pricingTotals.byMonth[m].add) }}</span>
              <span class="font-medium text-gray-100">{{ fmtMoney(pricingTotals.byMonth[m].base + pricingTotals.byMonth[m].add) }} ₽</span>
            </div>
          </template>
          <div v-if="pricingTotals.byMonth.total" class="flex justify-between text-gray-300">
            <span>Общее: основной {{ fmtMoney(pricingTotals.byMonth.total.base) }} / доп. {{ fmtMoney(pricingTotals.byMonth.total.add) }}</span>
            <span class="font-medium text-gray-100">{{ fmtMoney(pricingTotals.byMonth.total.base + pricingTotals.byMonth.total.add) }} ₽</span>
          </div>
          <div class="flex justify-between pt-2 border-t border-gray-800 font-semibold text-gray-100">
            <span>Итого за весь период</span>
            <span class="text-indigo-400">{{ fmtMoney(pricingTotals.grand) }} ₽</span>
          </div>
        </div>

        <div class="flex justify-between mt-4">
          <button @click="step = 3" class="px-4 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 transition">← Назад</button>
          <button @click="step = 5" class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition">Далее: формирование →</button>
        </div>
      </section>

      <!-- ─── Шаг 5: Формирование ──────────────────────────────── -->
      <section v-if="step === 5" class="max-w-2xl">
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <h2 class="text-lg font-semibold text-gray-100">🚀 Формирование КП</h2>
          <ul class="text-sm text-gray-400 space-y-1">
            <li>• Задач выбрано: <span class="text-gray-100">{{ selectedCount }}</span></li>
            <li>• Горизонт: <span class="text-gray-100">{{ form.horizon }} мес.</span></li>
            <li>• Итоговый бюджет: <span class="text-gray-100">{{ fmtMoney(pricingTotals.grand) }} ₽</span></li>
          </ul>

          <!-- Чек-лист готовности КП -->
          <div class="rounded-lg border border-gray-800 bg-gray-950 p-3">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-semibold text-gray-200">✅ Готовность КП</h3>
              <span class="text-xs" :class="readinessScore === readiness.length ? 'text-emerald-400' : 'text-yellow-400'">
                {{ readinessScore }} / {{ readiness.length }}
              </span>
            </div>
            <ul class="space-y-1 text-sm">
              <li v-for="(r, i) in readiness" :key="i" :class="r.ok ? 'text-gray-400' : 'text-yellow-300'">
                {{ r.ok ? '✅' : '⚠️' }} {{ r.label }}
              </li>
            </ul>
          </div>

          <div class="flex flex-wrap gap-2">
            <button @click="generate" :disabled="generating"
              class="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 transition">
              {{ generating ? 'Формирую…' : '📦 Сформировать КП (PDF + Excel)' }}
            </button>
            <button @click="download('pdf')" class="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">📄 PDF</button>
            <button @click="download('xlsx')" class="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">📊 Excel</button>
          </div>

          <div class="pt-3 border-t border-gray-800">
            <h3 class="text-sm font-semibold text-gray-200 mb-2">🔗 Публичная ссылка</h3>
            <p class="text-xs text-gray-500 mb-2">Клиент увидит фронт работ в трёх форматах (медиа-план, канбан, таблица) и стоимость — read-only, без авторизации, с кнопкой «Скачать PDF».</p>
            <div v-if="shareUrl" class="flex flex-wrap items-center gap-2">
              <input :value="shareUrl" readonly class="flex-1 min-w-[220px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300" />
              <button @click="copyShare" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">Копировать</button>
              <a :href="shareUrl" target="_blank" rel="noopener"
                class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">👁 Посмотреть как клиент</a>
              <button @click="revokeShare" class="px-3 py-2 text-sm rounded-lg border border-red-900 text-red-400 transition">Отозвать</button>
            </div>
            <button v-else @click="createShare" class="px-4 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-white transition">Создать ссылку</button>
          </div>
        </div>
        <div class="flex justify-between mt-4">
          <button @click="step = 4" class="px-4 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 transition">← Назад</button>
        </div>
      </section>

      <!-- ─── Модалка: задача справочника ──────────────────────── -->
      <div v-if="editingTask" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-lg">
          <h3 class="text-lg font-semibold text-gray-100 mb-3">{{ editingTask.id ? 'Изменить задачу справочника' : 'Новая задача справочника' }}</h3>
          <p class="text-xs text-gray-500 mb-3">Правка сохранится в справочнике и будет доступна во всех будущих КП.</p>
          <div class="space-y-3">
            <input v-model="editingTask.title" type="text" maxlength="500" placeholder="Название задачи *"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
            <textarea v-model="editingTask.description" rows="3" placeholder="Описание"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"></textarea>
            <div class="grid grid-cols-2 gap-3">
              <input v-model="editingTask.tool" type="text" maxlength="255" placeholder="Инструмент"
                class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
              <select v-model="editingTask.priority" class="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100">
                <option value="high">🔴 Высокий</option>
                <option value="medium">🟡 Средний</option>
                <option value="low">🟢 Низкий</option>
              </select>
            </div>
          </div>
          <div class="flex justify-end gap-2 mt-4">
            <button @click="editingTask = null" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300">Отмена</button>
            <button @click="saveTaskEditor" :disabled="!editingTask.title.trim()"
              class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">Сохранить</button>
          </div>
        </div>
      </div>

      <!-- ─── Модалка: модуль справочника ──────────────────────── -->
      <div v-if="editingModule" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-lg">
          <h3 class="text-lg font-semibold text-gray-100 mb-3">{{ editingModule.id ? 'Изменить модуль' : 'Новый модуль' }}</h3>
          <div class="space-y-3">
            <input v-model="editingModule.name" type="text" maxlength="255" placeholder="Название модуля *"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
            <textarea v-model="editingModule.description" rows="2" placeholder="Описание"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"></textarea>
            <input v-model="editingModule.estimated_days" type="text" maxlength="100" placeholder="Срок (например: 3–7 дней)"
              class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" />
          </div>
          <div class="flex justify-end gap-2 mt-4">
            <button @click="editingModule = null" class="px-3 py-2 text-sm rounded-lg border border-gray-700 text-gray-300">Отмена</button>
            <button @click="saveModuleEditor" :disabled="!editingModule.name.trim()"
              class="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
