<template>
  <div class="llm-model-selector">
    <label class="title">Модель {{ providerLabel }}</label>
    <div v-if="options.length" class="options">
      <label
        v-for="opt in options"
        :key="opt.value"
        class="option"
        :class="{ active: model === opt.value, disabled }"
      >
        <input
          type="radio"
          :name="`llm-model-${uid}`"
          :value="opt.value"
          :checked="model === opt.value"
          :disabled="disabled"
          @change="emit('update:modelValue', opt.value)"
        />
        <span class="opt-body">
          <span class="opt-name">{{ opt.label }}</span>
          <span class="opt-meta">{{ opt.priceHint }}</span>
        </span>
        <span class="tip" :title="opt.tooltip">ⓘ</span>
      </label>
    </div>
    <p v-else class="hint">Для этого провайдера модель задаётся серверной конфигурацией.</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';

const props = defineProps({
  provider: { type: String, default: 'gemini' },
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  hint: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const OPTIONS = {
  gemini: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', priceHint: 'основной writer', tooltip: 'Основная модель для сложного русскоязычного SEO-текста и редакторской доработки.' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', priceHint: 'быстрее / дешевле', tooltip: 'Более быстрая модель для лёгких writer/refine задач. Проверьте доступность у Google API.' },
  ],
  openai: [
    { value: 'gpt-5', label: 'GPT-5', priceHint: '$1.25 / $10 за 1M', tooltip: 'Рекомендуемый баланс качества и стоимости для сложного audit и финального quality gate.' },
    { value: 'gpt-5.5', label: 'GPT-5.5', priceHint: '$5 / $30 за 1M', tooltip: 'Premium-модель для финального judge и задач повышенного риска; не включайте её на каждый этап без A/B.' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini', priceHint: '$0.25 / $2 за 1M', tooltip: 'Компактная модель для короткого JSON repair и технических классификаций.' },
  ],
  grok: [],
};

const options = computed(() => OPTIONS[props.provider] || []);
const providerLabel = computed(() => props.provider === 'openai' ? 'OpenAI' : props.provider === 'gemini' ? 'Gemini' : 'Grok');
const model = computed(() => options.value.some((item) => item.value === props.modelValue)
  ? props.modelValue
  : (options.value[0]?.value || ''));

let _uidCounter = 0;
const uid = `m${++_uidCounter}`;

function ensureModel() {
  const next = options.value[0]?.value || '';
  if (next && !options.value.some((item) => item.value === props.modelValue)) emit('update:modelValue', next);
}
onMounted(ensureModel);
watch(() => props.provider, ensureModel);
</script>

<style scoped>
.llm-model-selector { display: flex; flex-direction: column; gap: 6px; }
.title { font-weight: 600; font-size: 13px; color: #e5e7eb; }
.options { display: flex; gap: 8px; flex-wrap: wrap; }
.option { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #d0d7de; border-radius: 6px; cursor: pointer; background: #fff; color: #1f2937; min-width: 190px; }
.option:hover:not(.disabled), .option.active { border-color: #4a6fa5; background: #eaf2ff; }
.option.disabled { cursor: not-allowed; opacity: .6; }
.option input[type=radio] { margin: 0; }
.opt-body { display: flex; flex-direction: column; }
.opt-name { font-weight: 600; font-size: 13px; color: #1f2937; }
.opt-meta { font-size: 11px; color: #4b5563; }
.tip { margin-left: auto; color: #6b7280; cursor: help; }
.hint { font-size: 12px; color: #9ca3af; }
</style>
