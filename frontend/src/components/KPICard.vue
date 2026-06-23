<script setup>
/**
 * KPICard.vue (PR-4 эпика premium-ui-and-client-mode-implementation).
 *
 * Карточка одного KPI на Executive Summary. Дизайн-токены — из PR-3
 * (surface-*, status-growth/attention/danger, brand-indigo). Анимация
 * roll-up для основного числа — через AnimatedNumber.vue (PR-3).
 *
 * Контракт:
 *   • title       — короткое название показателя ('Клики', 'Показы', ...).
 *   • value       — текущее значение (Number | null). null → '—'.
 *   • previous    — предыдущее значение для расчёта delta (опционально).
 *   • delta       — заранее посчитанная delta (если не нужен auto).
 *   • format      — 'integer' | 'decimal' | 'percent' | 'position'.
 *     'percent' умножает значение на 100 (если оно ≤ 1) и добавляет '%'.
 *   • lowerIsBetter — для position: меньшее значение = рост KPI.
 *   • hint        — пояснение под числом ('за последний полный месяц').
 *   • icon        — emoji/символ слева от заголовка.
 *   • duration    — длительность roll-up (передаётся в AnimatedNumber).
 *
 * Внешний вид: hover-elevation (translateY + shadow), вверху-справа —
 * delta-чип цвета healthy/warning/danger в зависимости от знака.
 */
import { computed } from 'vue';
import AnimatedNumber from './AnimatedNumber.vue';

const props = defineProps({
  title:        { type: String, required: true },
  value:        { type: [Number, String, null], default: null },
  previous:     { type: [Number, String, null], default: null },
  delta:        { type: [Number, null], default: null },
  format:       { type: String, default: 'integer' }, // integer | decimal | percent | position
  lowerIsBetter:{ type: Boolean, default: false },
  hint:         { type: String, default: '' },
  icon:         { type: String, default: '' },
  duration:     { type: Number, default: 700 },
  loading:      { type: Boolean, default: false },
});

function _coerce(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const decimals = computed(() => {
  switch (props.format) {
    case 'percent':  return 2;
    case 'decimal':  return 2;
    case 'position': return 1;
    default:         return 0;
  }
});

const suffix = computed(() => (props.format === 'percent' ? ' %' : ''));

// percent в headline_kpi приходит как 0..1 (CTR=0.045). Мульти на 100 здесь же,
// чтобы карточка была plug-and-play.
const displayValue = computed(() => {
  const v = _coerce(props.value);
  if (v === null) return null;
  if (props.format === 'percent' && Math.abs(v) <= 1) return v * 100;
  return v;
});

const computedDelta = computed(() => {
  if (props.delta != null) return _coerce(props.delta);
  const cur = _coerce(props.value);
  const prv = _coerce(props.previous);
  if (cur === null || prv === null || prv === 0) return null;
  // relative delta в долях (например 0.12 = +12 %)
  return (cur - prv) / Math.abs(prv);
});

const deltaState = computed(() => {
  const d = computedDelta.value;
  if (d === null || Math.abs(d) < 0.001) return 'neutral';
  const positive = props.lowerIsBetter ? d < 0 : d > 0;
  if (positive) return 'growth';
  return Math.abs(d) >= 0.1 ? 'danger' : 'attention';
});

const deltaText = computed(() => {
  const d = computedDelta.value;
  if (d === null) return null;
  const pct = d * 100;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct).toFixed(1)} %`;
});

const deltaArrow = computed(() => {
  const d = computedDelta.value;
  if (d === null || Math.abs(d) < 0.001) return '→';
  if (props.lowerIsBetter) return d < 0 ? '↓' : '↑';
  return d > 0 ? '↑' : '↓';
});

const deltaClasses = computed(() => {
  switch (deltaState.value) {
    case 'growth':    return 'bg-status-growth/15 text-status-growth border-status-growth/30';
    case 'attention': return 'bg-status-attention/15 text-status-attention border-status-attention/30';
    case 'danger':    return 'bg-status-danger/15 text-status-danger border-status-danger/30';
    default:          return 'bg-surface-muted/40 text-gray-300 border-surface-muted';
  }
});
</script>

<template>
  <div
    class="group relative rounded-xl border border-surface-muted bg-surface-raised p-5
           shadow-lg shadow-black/20 transition-all duration-200
           hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30
           hover:border-brand-indigo/40 overflow-hidden"
    :aria-busy="loading"
  >
    <!-- ambient highlight (на hover) -->
    <div
      class="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100
             transition-opacity duration-300"
      aria-hidden="true"
      style="background: radial-gradient(60% 60% at 100% 0%, rgba(99,102,241,0.15), transparent 70%);"
    ></div>

    <div class="relative flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-400">
          <span v-if="icon" aria-hidden="true">{{ icon }}</span>
          <span class="truncate">{{ title }}</span>
        </div>
      </div>

      <span
        v-if="deltaText"
        :class="['shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold kpi-figure', deltaClasses]"
        :aria-label="`Изменение: ${deltaText}`"
      >
        <span aria-hidden="true">{{ deltaArrow }}</span>
        <span>{{ deltaText }}</span>
      </span>
    </div>

    <div class="relative mt-3 text-3xl font-semibold text-white leading-tight">
      <span v-if="loading" class="inline-block w-24 h-7 rounded bg-surface-muted/40 animate-pulse" aria-hidden="true"></span>
      <AnimatedNumber
        v-else
        :value="displayValue"
        :decimals="decimals"
        :suffix="suffix"
        :duration="duration"
      />
    </div>

    <div v-if="hint" class="relative mt-1 text-xs text-gray-500">{{ hint }}</div>
  </div>
</template>
