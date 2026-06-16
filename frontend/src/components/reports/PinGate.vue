<script setup>
/**
 * PinGate — компонент ввода 4–8-значного PIN-кода.
 * Один input на цифру, авто-фокус, paste-handler, Backspace перескакивает назад.
 */
import { nextTick, onMounted, ref } from 'vue';

const props = defineProps({
  length: { type: Number, default: 4 },
  loading: { type: Boolean, default: false },
  error: { type: String, default: null },
});
const emit = defineEmits(['submit']);

const digits = ref(Array.from({ length: props.length }, () => ''));
const refs = ref([]);

onMounted(async () => {
  await nextTick();
  refs.value[0]?.focus();
});

function onInput(i, e) {
  const v = String(e.target.value || '').replace(/\D/g, '').slice(-1);
  digits.value[i] = v;
  if (v && i < props.length - 1) {
    refs.value[i + 1]?.focus();
  }
  maybeSubmit();
}

function onKeydown(i, e) {
  if (e.key === 'Backspace' && !digits.value[i] && i > 0) {
    refs.value[i - 1]?.focus();
  } else if (e.key === 'ArrowLeft' && i > 0) {
    refs.value[i - 1]?.focus();
  } else if (e.key === 'ArrowRight' && i < props.length - 1) {
    refs.value[i + 1]?.focus();
  } else if (e.key === 'Enter') {
    if (digits.value.join('').length >= 4) emit('submit', digits.value.join(''));
  }
}

function onPaste(e) {
  const text = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, props.length);
  if (!text) return;
  e.preventDefault();
  for (let i = 0; i < props.length; i++) {
    digits.value[i] = text[i] || '';
  }
  const next = Math.min(text.length, props.length - 1);
  refs.value[next]?.focus();
  maybeSubmit();
}

function maybeSubmit() {
  const filled = digits.value.join('');
  if (filled.length === props.length) emit('submit', filled);
}

function reset() {
  digits.value = Array.from({ length: props.length }, () => '');
  refs.value[0]?.focus();
}
defineExpose({ reset });
</script>

<template>
  <div class="pin-gate">
    <h2>Введите PIN-код</h2>
    <p class="pg-sub">Этот отчёт защищён. Введите код, который дал менеджер.</p>
    <div class="pg-row">
      <input
        v-for="(_, i) in digits"
        :key="i"
        :ref="(el) => (refs[i] = el)"
        type="tel"
        inputmode="numeric"
        maxlength="1"
        autocomplete="off"
        :value="digits[i]"
        :disabled="loading"
        @input="onInput(i, $event)"
        @keydown="onKeydown(i, $event)"
        @paste="onPaste"
      />
    </div>
    <div v-if="loading" class="pg-info">Проверка…</div>
    <div v-else-if="error" class="pg-err">{{ error }}</div>
  </div>
</template>

<style scoped>
.pin-gate { max-width: 420px; margin: 80px auto; text-align: center; padding: 32px; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
.pin-gate h2 { margin: 0; font-size: 22px; }
.pg-sub { color: rgba(0,0,0,0.55); font-size: 14px; margin: 8px 0 24px; }
.pg-row { display: flex; gap: 10px; justify-content: center; }
.pg-row input { width: 48px; height: 56px; border: 2px solid rgba(0,0,0,0.12); border-radius: 10px; font-size: 26px; text-align: center; font-weight: 600; transition: border-color 0.15s; }
.pg-row input:focus { border-color: #0071e3; outline: none; }
.pg-info { margin-top: 18px; color: rgba(0,0,0,0.5); font-size: 13px; }
.pg-err { margin-top: 18px; color: #b00020; font-size: 13px; }
@media (max-width: 480px) {
  .pg-row input { width: 40px; height: 48px; font-size: 22px; }
}
</style>
