<script setup>
/**
 * AnimatedNumber.vue (PR-3 эпика premium-ui-and-client-mode-implementation).
 *
 * Roll-up анимация числа при загрузке KPI на Executive Summary (PR-4)
 * и в любых местах, где меняется цифра (counters, deltas).
 *
 * Реализация — нативный requestAnimationFrame + easing-функция, без новых
 * зависимостей. Изначально в ТЗ упомянут Framer Motion, но фронт построен на
 * Vue 3, а Framer Motion — React-only. Тот же визуальный эффект (плавный
 * tween от старого значения к новому за `duration` мс) делается без него.
 *
 * Возможности:
 *   • `value` — целевое число (Number | null). null/NaN/undefined → "—".
 *   • `duration` — длительность анимации в мс (по умолчанию 700).
 *   • `decimals` — число знаков после запятой (по умолчанию 0).
 *   • `prefix`/`suffix` — текст до/после (например, '$', ' %').
 *   • `locale` — locale для Intl.NumberFormat (по умолчанию 'ru-RU').
 *   • `disableAnimation` — отключает roll-up (для prefers-reduced-motion).
 *
 * Сетка цифр выравнивается классом `.kpi-figure` (tabular-nums), чтобы
 * во время анимации не «прыгала» ширина.
 */
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue';

const props = defineProps({
  value:            { type: [Number, String, null], default: null },
  duration:         { type: Number, default: 700 },
  decimals:         { type: Number, default: 0 },
  prefix:           { type: String, default: '' },
  suffix:           { type: String, default: '' },
  locale:           { type: String, default: 'ru-RU' },
  disableAnimation: { type: Boolean, default: false },
  placeholder:      { type: String, default: '—' },
});

const displayed = ref(0);

let rafId = null;
let startTs = 0;
let fromValue = 0;
let toValue = 0;

function _easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function _coerce(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (_) { return false; }
}

function _cancel() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function _tick(now) {
  if (!startTs) startTs = now;
  const elapsed = now - startTs;
  const t = Math.min(1, elapsed / Math.max(1, props.duration));
  displayed.value = fromValue + (toValue - fromValue) * _easeOutCubic(t);
  if (t < 1) {
    rafId = requestAnimationFrame(_tick);
  } else {
    displayed.value = toValue;
    rafId = null;
  }
}

function _animateTo(target) {
  _cancel();
  fromValue = Number.isFinite(displayed.value) ? displayed.value : 0;
  toValue = target;
  if (props.disableAnimation || _prefersReducedMotion() || props.duration <= 0) {
    displayed.value = target;
    return;
  }
  startTs = 0;
  rafId = requestAnimationFrame(_tick);
}

const isNullValue = computed(() => _coerce(props.value) === null);

const formatted = computed(() => {
  if (isNullValue.value) return props.placeholder;
  const n = displayed.value;
  let body;
  try {
    body = new Intl.NumberFormat(props.locale, {
      minimumFractionDigits: props.decimals,
      maximumFractionDigits: props.decimals,
    }).format(n);
  } catch (_) {
    body = n.toFixed(props.decimals);
  }
  return `${props.prefix}${body}${props.suffix}`;
});

onMounted(() => {
  const v = _coerce(props.value);
  if (v === null) {
    displayed.value = 0;
    return;
  }
  // Стартуем с 0 → target, как обычный roll-up при первом рендере карточки.
  displayed.value = 0;
  _animateTo(v);
});

watch(() => props.value, (next) => {
  const v = _coerce(next);
  if (v === null) {
    _cancel();
    displayed.value = 0;
    return;
  }
  _animateTo(v);
});

onBeforeUnmount(_cancel);

defineExpose({ displayed, formatted });
</script>

<template>
  <span class="kpi-figure" :data-animated-number="formatted">{{ formatted }}</span>
</template>
