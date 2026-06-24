<script setup>
/**
 * EditableValue — inline-edit для чисел/строк в отчёте (ТЗ §6).
 *
 * UX:
 *   - В readonly режиме просто рендерит displayValue.
 *   - В edit-режиме (editable=true) клик по значению превращает его в
 *     <input>, по Enter/blur эмитит `update` с новым значением (number
 *     или string, в зависимости от type), по Esc — отмена.
 *   - Если значение присутствует в overridesMap (карта path → meta из
 *     report_drafts.overrides_meta), показывается бейдж «✏️».
 *   - Правая кнопка мыши на бейдже эмитит `reset` для очистки правки
 *     (родитель шлёт PATCH с null/undefined → sentinel-удаление).
 *
 * Props:
 *   - displayValue   — то, что показывать в режиме просмотра (уже отформатированное)
 *   - rawValue       — текущее «сырое» значение (число), которым предзаполняется input
 *   - path           — dot-path для overrides (нужен только родителю — пробрасывается в emit)
 *   - type           — 'int' | 'float' | 'text'
 *   - editable       — флаг (false на публичной/превью-стороне)
 *   - overridden     — true, если значение присутствует в overrides → бейдж
 *
 * Emits:
 *   - update(path, newValue)
 *   - reset(path)
 */
import { ref, computed } from 'vue';

const props = defineProps({
  displayValue: { type: [String, Number], default: '' },
  rawValue: { type: [String, Number, null], default: null },
  path: { type: String, required: true },
  type: { type: String, default: 'text' }, // 'int' | 'float' | 'text'
  editable: { type: Boolean, default: false },
  overridden: { type: Boolean, default: false },
});
const emit = defineEmits(['update', 'reset']);

const editing = ref(false);
const draft = ref('');
const inputRef = ref(null);

function startEdit() {
  if (!props.editable) return;
  draft.value = props.rawValue == null ? '' : String(props.rawValue);
  editing.value = true;
  // фокус на след. тике
  setTimeout(() => { if (inputRef.value) { inputRef.value.focus(); inputRef.value.select(); } }, 0);
}
function commit() {
  if (!editing.value) return;
  editing.value = false;
  let v = draft.value;
  if (props.type === 'int') {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return;
    v = n;
  } else if (props.type === 'float') {
    const n = parseFloat(String(v).replace(',', '.'));
    if (Number.isNaN(n)) return;
    v = n;
  } else {
    v = String(v);
  }
  // Не отправлять, если значение фактически не поменялось.
  if (String(v) === String(props.rawValue)) return;
  emit('update', props.path, v);
}
function cancel() {
  editing.value = false;
}
function resetOverride(e) {
  e?.preventDefault?.();
  emit('reset', props.path);
}

const inputType = computed(() => (props.type === 'text' ? 'text' : 'number'));
const inputStep = computed(() => (props.type === 'float' ? '0.01' : '1'));
</script>

<template>
  <span class="editable-value" :class="{ overridden, readonly: !editable }">
    <input
      v-if="editing"
      ref="inputRef"
      :type="inputType"
      :step="inputStep"
      v-model="draft"
      @blur="commit"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      class="ev-input"
    />
    <span
      v-else
      class="ev-display"
      :title="editable ? 'Кликните, чтобы изменить (Enter — сохранить, Esc — отмена)' : ''"
      @click="startEdit"
    >{{ displayValue }}</span>
    <button
      v-if="overridden && editable && !editing"
      class="ev-badge"
      title="Изменено вручную. Правый клик — сбросить к данным из источника"
      @click.right="resetOverride"
      @click="startEdit"
    >✏️</button>
    <span v-else-if="overridden && !editing" class="ev-badge static" title="Значение отредактировано вручную">✏️</span>
  </span>
</template>

<style scoped>
.editable-value { display: inline-flex; align-items: baseline; gap: 4px; }
.ev-display { cursor: text; border-bottom: 1px dashed transparent; transition: border-color .15s; }
.editable-value:not(.readonly) .ev-display:hover { border-bottom-color: var(--accent, #4a6cf7); }
.editable-value.readonly .ev-display { cursor: default; }
.ev-input {
  width: 7em; padding: 2px 6px; border: 1px solid var(--accent, #4a6cf7);
  border-radius: 4px; font: inherit; color: inherit; background: #fff;
  font-variant-numeric: tabular-nums;
}
.ev-badge {
  border: none; background: transparent; cursor: pointer; font-size: 11px; padding: 0;
  opacity: .8;
}
.ev-badge:hover { opacity: 1; }
.ev-badge.static { cursor: default; }
.editable-value.overridden .ev-display { color: #b67500; font-weight: 600; }
</style>
