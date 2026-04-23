<template>
  <div class="llm-provider-selector">
    <label class="title">LLM провайдер</label>
    <div class="options">
      <label
        v-for="opt in OPTIONS"
        :key="opt.value"
        class="option"
        :class="{ active: model === opt.value, disabled: disabled }"
      >
        <input
          type="radio"
          :name="`llm-provider-${uid}`"
          :value="opt.value"
          :checked="model === opt.value"
          :disabled="disabled"
          @change="$emit('update:modelValue', opt.value)"
        />
        <span class="opt-body">
          <span class="opt-name">{{ opt.label }}</span>
          <span class="opt-meta">{{ opt.priceHint }}</span>
        </span>
        <span class="tooltip" :title="opt.tooltip">ⓘ</span>
      </label>
    </div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>

<script setup>
/**
 * LlmProviderSelector — общий компонент выбора LLM-провайдера для
 * генератора SEO-статей, мета-тегов и AI-Copilot редактора.
 *
 * Контракт: v-model:modelValue → 'gemini' | 'grok'.
 * Невалидные значения сверху корректируются к 'gemini' через emit.
 *
 * Цены — справочные (на момент апреля 2026, чтобы пользователь видел
 * порядок). Точные значения считаются на бэке через priceCalculator.
 */
import { computed, onMounted } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: 'gemini' },
  disabled:   { type: Boolean, default: false },
  hint:       { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const OPTIONS = [
  {
    value: 'gemini',
    label: 'Gemini',
    priceHint: '~$2 / $12 за 1M ток.',
    tooltip:
      'Google Gemini — основной провайдер. Лучше для русскоязычного SEO-текста, ' +
      'поддержка контекстного кэша (cachedContents), стабильное качество. ' +
      'Дешевле в input-токенах.',
  },
  {
    value: 'grok',
    label: 'Grok (x.ai)',
    priceHint: '~$5 / $15 за 1M ток.',
    tooltip:
      'xAI Grok — альтернативный провайдер. Полезен для перекрёстной проверки ' +
      'и экспериментов. Не поддерживает кэш контекста, дороже Gemini, требует ' +
      'отдельный XAI_API_KEY на сервере.',
  },
];

// нормализуем значение наверх — если пришло «не gemini/grok», правим к gemini
const model = computed({
  get: () => (props.modelValue === 'grok' ? 'grok' : 'gemini'),
  set: (v) => emit('update:modelValue', v === 'grok' ? 'grok' : 'gemini'),
});

const uid = Math.random().toString(36).slice(2, 8);

onMounted(() => {
  // Если родитель прислал что-то невалидное — корректируем 1 раз
  if (props.modelValue !== 'gemini' && props.modelValue !== 'grok') {
    emit('update:modelValue', 'gemini');
  }
});
</script>

<style scoped>
.llm-provider-selector {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.title {
  font-weight: 600;
  font-size: 13px;
  color: #444;
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
  transition: all .15s ease;
  min-width: 180px;
}
.option:hover:not(.disabled) { border-color: #4a6fa5; background: #f6f9ff; }
.option.active { border-color: #4a6fa5; background: #eaf2ff; }
.option.disabled { cursor: not-allowed; opacity: .6; }
.option input[type=radio] { margin: 0; }
.opt-body { display: flex; flex-direction: column; }
.opt-name { font-weight: 600; font-size: 13px; }
.opt-meta { font-size: 11px; color: #666; }
.tooltip { font-size: 13px; color: #999; cursor: help; }
.hint { font-size: 12px; color: #777; }
</style>
