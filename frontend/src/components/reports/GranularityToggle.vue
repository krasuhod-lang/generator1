<script setup>
/**
 * GranularityToggle — общий segmented-control «День / Неделя / Месяц» для
 * графиков отчёта. Используется в ReportEditorPage (4 чарта) и в
 * PublicReportPage (тулбар периода). Раньше в каждом месте был свой набор
 * inline-кнопок (см. П.4) — поведение расходилось при изменениях.
 *
 * v-model:value — текущая гранулярность ('day' | 'week' | 'month'); если
 * родитель использует короткие коды (d/w/m) — лучше нормализовать перед
 * передачей сюда.
 */
import { computed } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: 'month' },
  disabled:   { type: Boolean, default: false },
  size:       { type: String, default: 'md' }, // sm|md
});
const emit = defineEmits(['update:modelValue']);

const value = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const items = [
  { id: 'day',   label: 'Дни' },
  { id: 'week',  label: 'Недели' },
  { id: 'month', label: 'Месяцы' },
];
</script>

<template>
  <div class="gt-seg" :data-size="size" role="group" aria-label="Гранулярность">
    <button v-for="it in items" :key="it.id"
            type="button"
            class="gt-btn"
            :class="{ active: value === it.id }"
            :disabled="disabled"
            @click="value = it.id">{{ it.label }}</button>
  </div>
</template>

<style scoped>
.gt-seg {
  display: inline-flex; gap: 0; border: 1px solid rgba(60,60,67,0.18);
  border-radius: 10px; padding: 2px; background: rgba(255,255,255,0.6);
}
.gt-btn {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  padding: 6px 12px; font-size: 13px; border-radius: 8px; transition: background 0.15s;
}
.gt-btn.active { background: var(--accent, #0a84ff); color: #fff; }
.gt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gt-seg[data-size="sm"] .gt-btn { padding: 4px 9px; font-size: 12px; }
</style>
