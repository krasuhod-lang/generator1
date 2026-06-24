<script setup>
/**
 * DataStateWrapper.vue — обёртка для любой секции/модуля, чтобы
 * единообразно показывать empty/partial/error состояния (ТЗ §7.4, §10.4).
 *
 * Источник правды — backend (см. backend/src/services/reports/dataAggregator.js):
 *   • status: ready | empty | partial | error
 *   • reason: not_connected | token_expired | no_rows | source_lag | source_failed | disabled
 *
 * Использование:
 *   <DataStateWrapper :status="section.status" :reason="section.reason">
 *     <template #ready>...основной контент...</template>
 *   </DataStateWrapper>
 *
 * Можно переопределить empty/partial/error через одноимённые слоты.
 */
import { computed } from 'vue';

const props = defineProps({
  status:      { type: String, default: 'ready' },
  reason:      { type: String, default: '' },
  lastSyncAt:  { type: String, default: '' },
  title:       { type: String, default: '' },
  // Принудительно показать только заголовок состояния, без обёртки.
  compact:     { type: Boolean, default: false },
});

const normalized = computed(() => {
  const s = String(props.status || '').toLowerCase();
  return ['ready', 'empty', 'partial', 'error'].includes(s) ? s : 'ready';
});

const REASON_TEXT = {
  not_connected: 'Интеграция не подключена',
  token_expired: 'Источник временно недоступен, нужна повторная авторизация',
  no_rows:       'За выбранный период сигналы не найдены',
  source_lag:    'Данные неполны из-за ограничений источника',
  source_failed: 'Не удалось получить данные из источника',
  disabled:      'Модуль отключён в настройках отчёта',
};

const REASON_HINT = {
  not_connected: 'Подключите источник в настройках проекта, чтобы увидеть этот блок.',
  token_expired: 'Откройте проект и подтвердите доступ к источнику.',
  no_rows:       'Расширьте период или дождитесь следующего цикла сбора.',
  source_lag:    'Свежие данные подтянутся при следующей синхронизации.',
  source_failed: 'Повторите чуть позже — мы попробуем синхронизироваться ещё раз.',
  disabled:      'Включить можно в конфигурации отчёта (Аналитик).',
};

const reasonLabel = computed(() => REASON_TEXT[props.reason] || '');
const reasonHint  = computed(() => REASON_HINT[props.reason] || '');

const stateClass = computed(() => `dsw dsw--${normalized.value}`);
const lastSyncLabel = computed(() => {
  if (!props.lastSyncAt) return '';
  try {
    const d = new Date(props.lastSyncAt);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
});
</script>

<template>
  <div :class="stateClass">
    <!-- READY: основной контент через default-слот -->
    <template v-if="normalized === 'ready'">
      <slot name="ready"><slot /></slot>
    </template>

    <!-- PARTIAL: показываем контент + ленту-предупреждение сверху -->
    <template v-else-if="normalized === 'partial'">
      <div class="dsw-banner dsw-banner--partial" role="status">
        <span class="dsw-icon" aria-hidden="true">⚠</span>
        <span>
          <strong>Данные неполны.</strong>
          {{ reasonLabel || 'Часть периода ещё не закрыта источником.' }}
          <span v-if="lastSyncLabel" class="dsw-meta"> · обновлено {{ lastSyncLabel }}</span>
        </span>
      </div>
      <slot name="partial"><slot name="ready"><slot /></slot></slot>
    </template>

    <!-- EMPTY: вместо контента — отдельный слот или fallback -->
    <template v-else-if="normalized === 'empty'">
      <slot name="empty">
        <div class="dsw-state dsw-state--empty" role="status">
          <div class="dsw-state-icon" aria-hidden="true">∅</div>
          <div class="dsw-state-body">
            <div v-if="title" class="dsw-state-title">{{ title }}</div>
            <div class="dsw-state-text">{{ reasonLabel || 'Нет данных для этого блока.' }}</div>
            <div v-if="reasonHint" class="dsw-state-hint">{{ reasonHint }}</div>
          </div>
        </div>
      </slot>
    </template>

    <!-- ERROR -->
    <template v-else-if="normalized === 'error'">
      <slot name="error">
        <div class="dsw-state dsw-state--error" role="alert">
          <div class="dsw-state-icon" aria-hidden="true">⚠</div>
          <div class="dsw-state-body">
            <div v-if="title" class="dsw-state-title">{{ title }}</div>
            <div class="dsw-state-text">{{ reasonLabel || 'Не удалось загрузить данные.' }}</div>
            <div v-if="reasonHint" class="dsw-state-hint">{{ reasonHint }}</div>
          </div>
        </div>
      </slot>
    </template>
  </div>
</template>

<style scoped>
.dsw { display: block; }

.dsw-banner {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}
.dsw-banner--partial {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fbbf24;
}
.dsw-icon { font-size: 1rem; line-height: 1.2; }
.dsw-meta { opacity: 0.7; }

.dsw-state {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 1rem 1.25rem;
  border-radius: 10px;
  margin: 0.5rem 0;
}
.dsw-state--empty {
  background: #f3f4f6;
  color: #4b5563;
  border: 1px dashed #d1d5db;
}
.dsw-state--error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}
.dsw-state-icon {
  font-size: 1.5rem;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 0.1rem;
}
.dsw-state-body { min-width: 0; }
.dsw-state-title { font-weight: 600; margin-bottom: 0.15rem; }
.dsw-state-text { font-size: 0.95rem; }
.dsw-state-hint { font-size: 0.85rem; opacity: 0.75; margin-top: 0.25rem; }
</style>
