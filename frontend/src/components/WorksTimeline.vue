<script setup>
/**
 * WorksTimeline.vue (PR-5 эпика premium-ui-and-client-mode-implementation).
 *
 * Вертикальный таймлайн журнала работ SEO-специалиста. Дизайн-токены —
 * surface-*, status-* (PR-3), tabular-nums для дат.
 *
 * Контракт ТЗ §6.5:
 *   • В Analyst Mode выводим title + description + impact + ссылки;
 *   • В Client Mode выводим только title + client_summary + дату/тип;
 *     запись со статусом 'planned' уже отфильтрована на backend (worksService).
 *
 * Сам компонент НЕ дёргает API — это умеет владелец-страница. Принимает
 * массив works и режим. Это позволяет переиспользовать таймлайн в публичной
 * shared-странице (Client Mode) и на дашборде (любой режим).
 *
 * Props:
 *   • works   — массив записей `project_works` (см. worksService.js shape).
 *   • mode    — 'analyst' | 'client'.
 *   • loading — скелетон.
 *   • limit   — обрезка списка (UI «Показать ещё»).
 */
import { computed, ref } from 'vue';

const props = defineProps({
  works:   { type: Array, default: () => [] },
  mode:    { type: String, default: 'analyst' },
  loading: { type: Boolean, default: false },
  limit:   { type: Number, default: 20 },
});

const expanded = ref(false);

const isClient = computed(() => props.mode === 'client');

const visible = computed(() => {
  const arr = Array.isArray(props.works) ? props.works : [];
  if (expanded.value) return arr;
  return arr.slice(0, props.limit);
});

const hasMore = computed(() => {
  const total = Array.isArray(props.works) ? props.works.length : 0;
  return !expanded.value && total > props.limit;
});

const TYPE_META = Object.freeze({
  tech:    { icon: '⚙️', label: 'Тех. работы' },
  content: { icon: '✍️', label: 'Контент' },
  meta:    { icon: '🏷️', label: 'Мета-теги' },
  links:   { icon: '🔗', label: 'Ссылки' },
  ux:      { icon: '🎨', label: 'UX/CRO' },
  semantic:{ icon: '🧭', label: 'Семантика' },
  other:   { icon: '🛠️', label: 'Прочее' },
});

const STATUS_META = Object.freeze({
  done:        { label: 'Сделано',     tone: 'bg-status-growth/15 text-status-growth border-status-growth/30' },
  in_progress: { label: 'В работе',    tone: 'bg-status-attention/15 text-status-attention border-status-attention/30' },
  planned:     { label: 'В плане',     tone: 'bg-surface-muted/40 text-gray-300 border-surface-muted' },
});

function typeInfo(t) {
  const key = String(t || 'other').toLowerCase();
  return TYPE_META[key] || TYPE_META.other;
}

function statusInfo(s) {
  return STATUS_META[s] || STATUS_META.done;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

function impactEntries(impact) {
  if (!impact || typeof impact !== 'object') return [];
  return Object.entries(impact)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 6)
    .map(([k, v]) => ({ key: k, value: typeof v === 'number' ? v : String(v) }));
}
</script>

<template>
  <div class="rounded-xl border border-surface-muted bg-surface-raised p-5 shadow-lg shadow-black/20">
    <div class="flex items-baseline justify-between mb-4">
      <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider">Журнал работ</h2>
      <span v-if="!loading" class="text-xs text-gray-500 kpi-figure">
        {{ works.length }} {{ isClient ? 'выполнено' : 'записей' }}
      </span>
    </div>

    <!-- Empty / loading state -->
    <div v-if="loading" class="space-y-3" aria-busy="true">
      <div v-for="i in 3" :key="i" class="flex gap-3">
        <div class="w-2 h-2 rounded-full bg-surface-muted/60 mt-2"></div>
        <div class="flex-1">
          <div class="h-3 w-1/2 bg-surface-muted/40 rounded animate-pulse"></div>
          <div class="h-3 w-2/3 bg-surface-muted/40 rounded animate-pulse mt-2"></div>
        </div>
      </div>
    </div>

    <div v-else-if="!works.length" class="text-sm text-gray-500 text-center py-8">
      <div class="text-2xl mb-2" aria-hidden="true">🛠️</div>
      <div>{{ isClient ? 'По проекту пока не отчитались работы.' : 'Журнал работ пуст. Добавьте первую запись.' }}</div>
    </div>

    <!-- Timeline -->
    <ol v-else class="relative pl-6 space-y-5">
      <!-- vertical track -->
      <div
        class="absolute left-2 top-1 bottom-1 w-px bg-gradient-to-b from-brand-indigo/40 via-surface-muted to-transparent"
        aria-hidden="true"
      ></div>

      <li
        v-for="work in visible"
        :key="work.id"
        class="relative timeline-item"
      >
        <!-- Dot -->
        <span
          class="absolute -left-[18px] top-1 inline-flex items-center justify-center w-4 h-4 rounded-full
                 bg-surface-raised border-2 border-brand-indigo shadow-sm shadow-brand-indigo/40"
          aria-hidden="true"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-brand-indigo"></span>
        </span>

        <div class="flex items-start gap-2 flex-wrap">
          <span class="text-base" aria-hidden="true">{{ typeInfo(work.type).icon }}</span>
          <h3 class="text-sm font-semibold text-gray-100 flex-1 min-w-0">{{ work.title }}</h3>

          <!-- Status badge (всегда видно — клиенту тоже полезно знать «в работе») -->
          <span
            v-if="!isClient || work.status === 'in_progress'"
            :class="['inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', statusInfo(work.status).tone]"
          >{{ statusInfo(work.status).label }}</span>
        </div>

        <div class="mt-1 flex items-center gap-2 text-xs text-gray-500 kpi-figure">
          <time :datetime="work.performed_at">{{ formatDate(work.performed_at) }}</time>
          <span aria-hidden="true">•</span>
          <span>{{ typeInfo(work.type).label }}</span>
        </div>

        <!-- Description / summary -->
        <p
          v-if="isClient"
          class="mt-2 text-sm text-gray-300 leading-relaxed"
        >{{ work.client_summary || work.title }}</p>
        <template v-else>
          <p
            v-if="work.client_summary"
            class="mt-2 text-sm text-gray-200 leading-relaxed"
          >
            <span class="text-[10px] uppercase tracking-wider text-gray-500 mr-1">Клиенту:</span>
            {{ work.client_summary }}
          </p>
          <p
            v-if="work.description"
            class="mt-1.5 text-sm text-gray-400 leading-relaxed whitespace-pre-line"
          >{{ work.description }}</p>

          <!-- Impact (Analyst Mode only) -->
          <div v-if="impactEntries(work.impact).length" class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="entry in impactEntries(work.impact)"
              :key="entry.key"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-status-growth/10 border border-status-growth/30 text-[11px] text-status-growth kpi-figure"
            >
              <span>{{ entry.key }}</span>
              <span class="font-semibold">{{ entry.value }}</span>
            </span>
          </div>
        </template>

        <!-- Links (видны в обоих режимах — это полезные пруфы) -->
        <div v-if="Array.isArray(work.links) && work.links.length" class="mt-2 flex flex-wrap gap-2">
          <a
            v-for="(link, idx) in work.links"
            :key="idx"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-brand-indigo hover:text-brand-light underline underline-offset-2"
          >{{ link.label || link.url }}</a>
        </div>
      </li>
    </ol>

    <button
      v-if="hasMore"
      type="button"
      class="mt-4 text-xs text-brand-indigo hover:text-brand-light underline underline-offset-2"
      @click="expanded = true"
    >Показать ещё {{ works.length - limit }}</button>
  </div>
</template>

<style scoped>
.timeline-item {
  animation: timeline-in 320ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}
@keyframes timeline-in {
  0%   { opacity: 0; transform: translateY(6px); }
  100% { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .timeline-item { animation: none; }
}
</style>
