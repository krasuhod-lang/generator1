<script setup>
/**
 * ProjectPicker — combobox для выбора SEO-проекта (ТЗ §5/§8).
 *
 * Используется во всех формах создания задач (info-article, link-article,
 * meta-tags, article-topics, relevance, forecaster, serp-b2b), чтобы любая
 * задача знала «свой» проект. Без выбора задача создаётся «без проекта»
 * (project_id остаётся null) — backend это допускает.
 *
 * Кеш списка проектов держим в модульной переменной, чтобы переключение
 * между формами не дёргало `/api/projects/options` каждый раз. При создании
 * нового проекта вызывающая сторона может сбросить кеш вручную (см.
 * `clearProjectsCache`).
 *
 * Props:
 *   - modelValue: number | null — текущий project_id (v-model)
 *   - required: boolean — если true, показывает звёздочку и блокирует пустой выбор
 *   - placeholder: string — текст «не выбран»
 *
 * Emits:
 *   - update:modelValue(id|null)
 *   - context(project) — выбран новый проект, родителю передан полный объект
 *     {id, name, url} для предзаполнения формы (ТЗ §8).
 */
import { ref, watch, onMounted, computed } from 'vue';
import api from '../api.js';
import { loadProjectsOptions } from '../utils/projectsCache.js';

const props = defineProps({
  modelValue: { type: [String, Number, null], default: null },
  required: { type: Boolean, default: false },
  placeholder: { type: String, default: '— Без проекта —' },
  label: { type: String, default: 'Проект' },
});
const emit = defineEmits(['update:modelValue', 'context', 'fullContext']);

const projects = ref([]);
const loading = ref(false);
const error = ref(null);

async function load() {
  loading.value = true;
  try {
    projects.value = await loadProjectsOptions();
  } catch (e) {
    error.value = e?.response?.data?.error || e.message;
    projects.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const selected = computed({
  get: () => props.modelValue,
  set: (v) => {
    // project_id может быть UUID-строкой ИЛИ целым числом (legacy).
    // Не приводим к Number — это ломает UUID.
    const id = v === '' || v == null ? null : v;
    emit('update:modelValue', id);
    if (id == null) { emit('context', null); return; }
    // Лёгкий объект из cache, чтобы UI обновился немедленно.
    const proj = projects.value.find((p) => String(p.id) === String(id)) || null;
    emit('context', proj);
    // Параллельно тянем полный контекст (бренд, факты, регион — ТЗ §8).
    api.get(`/projects/${id}/context`).then((r) => {
      const ctx = r?.data?.context;
      if (ctx) emit('fullContext', ctx);
    }).catch((e) => { console.warn('[ProjectPicker] context fetch failed:', e?.message); });
  },
});

watch(() => props.modelValue, (v) => {
  if (v == null) return;
  const proj = projects.value.find((p) => String(p.id) === String(v));
  if (proj) emit('context', proj);
});
</script>

<template>
  <label class="project-picker">
    <span class="pp-label">
      {{ label }}
      <span v-if="required" class="pp-req">*</span>
    </span>
    <select v-model="selected" :disabled="loading" class="pp-select">
      <option :value="null">{{ placeholder }}</option>
      <option v-for="p in projects" :key="p.id" :value="p.id">
        {{ p.name }}<template v-if="p.url"> — {{ p.url }}</template>
      </option>
    </select>
    <span v-if="error" class="pp-error">{{ error }}</span>
  </label>
</template>

<style scoped>
.project-picker { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.pp-label { color: #455; font-weight: 600; }
.pp-req { color: #d33; margin-left: 2px; }
.pp-select {
  padding: 8px 10px; border: 1px solid #d6dbe3; border-radius: 8px;
  font-size: 14px; background: #fff;
}
.pp-select:focus { outline: none; border-color: var(--accent, #4a6cf7); }
.pp-error { color: #d33; font-size: 12px; }
</style>
