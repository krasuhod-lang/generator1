<template>
  <div class="gemini-model-selector">
    <label class="title">Модель Gemini</label>
    <div class="options">
      <label
        v-for="opt in OPTIONS"
        :key="opt.value"
        class="option"
        :class="{ active: model === opt.value, disabled }"
      >
        <input
          type="radio"
          :name="`gemini-model-${uid}`"
          :value="opt.value"
          :checked="model === opt.value"
          :disabled="disabled"
          @change="$emit('update:modelValue', opt.value)"
        />
        <span class="opt-body">
          <span class="opt-name">{{ opt.label }}</span>
          <span class="opt-meta">{{ opt.priceHint }}</span>
        </span>
        <span class="tip-wrap" @click.prevent.stop="toggleTip(opt.value)">
          <button
            type="button"
            class="tip-trigger"
            :aria-label="`Описание модели ${opt.label}`"
            :aria-expanded="openTip === opt.value ? 'true' : 'false'"
            @focus="openTip = opt.value"
            @blur="openTip = null"
            @keydown.escape="openTip = null"
          >ⓘ</button>
          <span class="tip-bubble" :class="{ open: openTip === opt.value }" role="tooltip">
            {{ opt.tooltip }}
          </span>
        </span>
      </label>
    </div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const OPTIONS = [
  {
    value: 'gemini-3.1-pro-preview',
    label: '3.1 Pro Preview',
    priceHint: 'качество / reasoning',
    tooltip: 'Основная модель для сложного SEO-копирайтинга и длинных задач.',
  },
  {
    value: 'gemini-3.5-flash',
    label: '3.5 Flash',
    priceHint: 'быстрее / легче',
    tooltip: 'Новая быстрая модель для задач, где важны скорость и экономия.',
  },
];
const VALUES = new Set(OPTIONS.map((o) => o.value));

const props = defineProps({
  modelValue: { type: String, default: DEFAULT_MODEL },
  disabled:   { type: Boolean, default: false },
  hint:       { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const model = computed({
  get: () => (VALUES.has(props.modelValue) ? props.modelValue : DEFAULT_MODEL),
  set: (v) => emit('update:modelValue', VALUES.has(v) ? v : DEFAULT_MODEL),
});

let _uidCounter = 0;
const uid = `s${++_uidCounter}`;

// Тултип описания модели: hover/focus на десктопе, клик-toggle на тач-устройствах.
const openTip = ref(null);
function toggleTip(value) {
  openTip.value = openTip.value === value ? null : value;
}

onMounted(() => {
  if (!VALUES.has(props.modelValue)) emit('update:modelValue', DEFAULT_MODEL);
});
</script>

<style scoped>
.gemini-model-selector {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.title {
  font-weight: 600;
  font-size: 13px;
  color: #e5e7eb;
}
.options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  cursor: pointer;
  background: #fff;
  color: #1f2937;
  transition: all .15s ease;
  min-width: 190px;
}
.option:hover:not(.disabled) { border-color: #4a6fa5; background: #f6f9ff; }
.option.active { border-color: #4a6fa5; background: #eaf2ff; }
.option.disabled { cursor: not-allowed; opacity: .6; }
.option input[type=radio] { margin: 0; }
.opt-body { display: flex; flex-direction: column; }
.opt-name { font-weight: 600; font-size: 13px; color: #1f2937; }
.opt-meta { font-size: 11px; color: #4b5563; }
.tip-wrap { position: relative; display: inline-flex; margin-left: auto; }
.tip-trigger {
  border: none;
  background: none;
  padding: 0;
  font-size: 13px;
  color: #6b7280;
  cursor: help;
  line-height: 1;
}
.tip-trigger:hover, .tip-trigger:focus { color: #4a6fa5; }
.tip-bubble {
  position: absolute;
  bottom: calc(100% + 8px);
  right: -6px;
  width: 220px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #111827;
  border: 1px solid #374151;
  color: #e5e7eb;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  opacity: 0;
  visibility: hidden;
  transition: opacity .15s ease;
  pointer-events: none;
  z-index: 30;
}
.tip-bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  right: 10px;
  border: 6px solid transparent;
  border-top-color: #111827;
}
.tip-wrap:hover .tip-bubble,
.tip-trigger:focus + .tip-bubble,
.tip-bubble.open {
  opacity: 1;
  visibility: visible;
}
.hint { font-size: 12px; color: #9ca3af; }
</style>
