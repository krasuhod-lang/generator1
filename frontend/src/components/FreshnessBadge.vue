<script setup>
/**
 * FreshnessBadge.vue (PR-3 эпика premium-ui-and-client-mode-implementation).
 *
 * Цветной бейдж статуса свежести данных одного источника (GSC / Yandex.
 * Webmaster / Keys.so / ...). Принимает один элемент массива, который
 * возвращает endpoint `GET /api/projects/:id/freshness` (см. PR-1,
 * backend/src/services/projects/freshnessService.js#getProjectFreshness):
 *
 *   {
 *     source: 'gsc' | 'ydx' | 'keysso' | ...,
 *     status: 'ok' | 'partial' | 'stale' | 'gap' | 'error',
 *     last_successful_sync_at: ISO | null,
 *     source_max_date:         'YYYY-MM-DD' | null,
 *     expected_max_date:       'YYYY-MM-DD' | null,
 *     rows_last_sync:          number | null,
 *     is_partial_period:       boolean,
 *     last_error:              string | null,
 *   }
 *
 * Используется:
 *   • в Topbar (PremiumLayout) — компактный режим (только источник + статус);
 *   • на дашборде в summary-карточках (PR-4) — с relative-временем «X часов
 *     назад» и hover-подсказкой.
 *
 * Цвета берутся из status-* токенов Tailwind (status-healthy / status-warning
 * / status-critical), совместимы с дизайн-системой из ТЗ §6.1.
 */
import { computed } from 'vue';

const props = defineProps({
  freshness: { type: Object, default: () => ({}) },
  compact:   { type: Boolean, default: false },
});

const SOURCE_LABELS = Object.freeze({
  gsc:    'GSC',
  google: 'GSC',
  ydx:    'Яндекс.Вебмастер',
  yandex: 'Яндекс.Вебмастер',
  keysso: 'Keys.so',
  ga4:    'GA4',
});

const STATUS_LABELS = Object.freeze({
  ok:      'Свежие',
  partial: 'Частичные',
  stale:   'Устарели',
  gap:     'Пропуск',
  error:   'Ошибка',
});

// status-* токены из tailwind.config.js (см. PR-3).
const STATUS_TOKENS = Object.freeze({
  ok:      { dot: 'bg-status-healthy',  text: 'text-status-healthy',  bg: 'bg-status-healthy/10',  border: 'border-status-healthy/30' },
  partial: { dot: 'bg-status-warning',  text: 'text-status-warning',  bg: 'bg-status-warning/10',  border: 'border-status-warning/30' },
  stale:   { dot: 'bg-status-warning',  text: 'text-status-warning',  bg: 'bg-status-warning/10',  border: 'border-status-warning/30' },
  gap:     { dot: 'bg-status-critical', text: 'text-status-critical', bg: 'bg-status-critical/10', border: 'border-status-critical/30' },
  error:   { dot: 'bg-status-critical', text: 'text-status-critical', bg: 'bg-status-critical/10', border: 'border-status-critical/30' },
});

const status = computed(() => {
  const raw = String(props.freshness?.status || '').toLowerCase();
  return STATUS_TOKENS[raw] ? raw : 'error';
});

const tokens = computed(() => STATUS_TOKENS[status.value]);

const sourceLabel = computed(() => {
  const key = String(props.freshness?.source || '').toLowerCase();
  return SOURCE_LABELS[key] || (key ? key.toUpperCase() : '—');
});

const statusLabel = computed(() => STATUS_LABELS[status.value] || 'Неизвестно');

const relativeTime = computed(() => {
  const iso = props.freshness?.last_successful_sync_at;
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'только что';
  const minute = 60 * 1000;
  const hour   = 60 * minute;
  const day    = 24 * hour;
  if (diffMs < minute)   return 'только что';
  if (diffMs < hour)     return `${Math.round(diffMs / minute)} мин назад`;
  if (diffMs < day)      return `${Math.round(diffMs / hour)} ч назад`;
  const days = Math.round(diffMs / day);
  return `${days} ${_daysWord(days)} назад`;
});

function _daysWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня';
  return 'дней';
}

const tooltip = computed(() => {
  const f = props.freshness || {};
  const parts = [`${sourceLabel.value}: ${statusLabel.value}`];
  if (relativeTime.value) parts.push(`синхр.: ${relativeTime.value}`);
  if (f.source_max_date) parts.push(`данные до ${f.source_max_date}`);
  if (f.rows_last_sync != null) parts.push(`строк: ${f.rows_last_sync}`);
  if (f.last_error) parts.push(`ошибка: ${f.last_error}`);
  return parts.join(' • ');
});
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 rounded-full border text-xs font-medium',
      'transition-colors',
      tokens.bg,
      tokens.text,
      tokens.border,
      compact ? 'px-2 py-0.5' : 'px-2.5 py-1',
    ]"
    :title="tooltip"
    role="status"
    :aria-label="tooltip"
  >
    <span :class="['inline-block w-1.5 h-1.5 rounded-full', tokens.dot]" aria-hidden="true" />
    <span class="font-semibold">{{ sourceLabel }}</span>
    <span v-if="!compact" class="opacity-80">·</span>
    <span v-if="!compact">{{ statusLabel }}</span>
    <span
      v-if="!compact && relativeTime"
      class="ml-1 text-[10px] uppercase tracking-wide opacity-70 kpi-figure"
    >{{ relativeTime }}</span>
  </span>
</template>
