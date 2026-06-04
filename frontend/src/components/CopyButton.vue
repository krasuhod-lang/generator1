<script setup>
/**
 * CopyButton — компактная кнопка «копировать» с галочкой-подтверждением.
 * Используется в карточках отчёта (мета-теги, ссылочная стратегия,
 * каннибализация), чтобы значение/строку можно было скопировать в один клик.
 */
import { ref } from 'vue';
import { copyToClipboard } from '../utils/clipboard.js';

const props = defineProps({
  // Текст для копирования.
  text:  { type: [String, Number], default: '' },
  // Либо функция, возвращающая текст (для «скопировать таблицу» — лениво).
  copyFn: { type: Function, default: null },
  // Подпись рядом с иконкой (необязательно).
  label: { type: String, default: '' },
});

const copied = ref(false);
let timer = null;

async function onClick() {
  const value = props.copyFn ? props.copyFn() : props.text;
  const ok = await copyToClipboard(value);
  if (!ok) return;
  copied.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <button type="button"
          class="inline-flex items-center gap-1 rounded border border-gray-700 px-1.5 py-0.5 text-[11px]
                 text-gray-300 hover:text-white hover:border-gray-500 transition-colors whitespace-nowrap"
          :class="copied ? 'border-emerald-500/60 text-emerald-300' : ''"
          :title="label ? `Копировать: ${label}` : 'Копировать'"
          @click.stop="onClick">
    <span>{{ copied ? '✓' : '📋' }}</span>
    <span v-if="label">{{ copied ? 'Скопировано' : label }}</span>
  </button>
</template>
