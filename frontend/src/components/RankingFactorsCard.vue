<script setup>
/**
 * RankingFactorsCard — детерминированный аудит факторов ранжирования:
 * «чего не хватает для большего роста». Показывает общий score готовности,
 * приоритезированные точки роста (critical/gap) и полный список факторов
 * с понятными статусами. Данные приходят из project_analyses.ranking_factors
 * (backend/src/services/projects/rankingFactors.js).
 */
import { computed } from 'vue';

const props = defineProps({
  rankingFactors: { type: Object, default: null },
});

const available = computed(() => props.rankingFactors && props.rankingFactors.available);
const score = computed(() => (props.rankingFactors ? props.rankingFactors.score : null));
const gaps = computed(() => (props.rankingFactors && props.rankingFactors.gaps) || []);
const factors = computed(() => (props.rankingFactors && props.rankingFactors.factors) || []);
const summary = computed(() => (props.rankingFactors && props.rankingFactors.summary) || '');

function scoreClass(s) {
  if (s == null) return 'text-gray-400';
  if (s >= 80) return 'text-emerald-300';
  if (s >= 60) return 'text-lime-300';
  if (s >= 40) return 'text-amber-300';
  return 'text-red-300';
}

const STATUS_META = {
  critical: { label: 'Критично', badge: 'border-red-500/40 text-red-300 bg-red-500/10', dot: 'bg-red-400' },
  gap: { label: 'Зона роста', badge: 'border-amber-500/40 text-amber-300 bg-amber-500/10', dot: 'bg-amber-400' },
  ok: { label: 'В норме', badge: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10', dot: 'bg-emerald-400' },
  unknown: { label: 'Нет данных', badge: 'border-gray-700 text-gray-400 bg-gray-800/40', dot: 'bg-gray-600' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.unknown; }

// Группировка полного списка факторов по их группе для аккуратного вывода.
const grouped = computed(() => {
  const order = [];
  const map = {};
  for (const f of factors.value) {
    const key = f.group || 'other';
    if (!map[key]) { map[key] = []; order.push(key); }
    map[key].push(f);
  }
  return order.map((k) => ({ group: k, items: map[k] }));
});

const GROUP_LABELS = {
  content: 'Контент и релевантность',
  serp: 'Сниппеты и CTR',
  structure: 'Структура и каннибализация',
  trust: 'Авторитет и доверие (E-E-A-T)',
  tech: 'Техника и разметка',
  authority: 'Ссылочный профиль',
  aeo: 'Нейровыдача (AI/SGE)',
  other: 'Прочее',
};
function groupLabel(g) { return GROUP_LABELS[g] || g; }
</script>

<template>
  <section v-if="available" class="card space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-fuchsia-300">
        🚀 Чего не хватает для роста
      </h2>
      <div v-if="score != null" class="flex items-center gap-2">
        <span class="text-[11px] uppercase text-gray-500">Готовность</span>
        <span class="text-2xl font-extrabold tabular-nums" :class="scoreClass(score)">{{ score }}<span class="text-sm text-gray-500">/100</span></span>
      </div>
    </div>

    <!-- Прогресс-бар готовности -->
    <div v-if="score != null" class="h-2 w-full rounded-full bg-gray-800 overflow-hidden">
      <div class="h-full rounded-full transition-all"
           :class="score >= 80 ? 'bg-emerald-400' : score >= 60 ? 'bg-lime-400' : score >= 40 ? 'bg-amber-400' : 'bg-red-400'"
           :style="{ width: Math.max(3, score) + '%' }"></div>
    </div>

    <p v-if="summary" class="text-sm text-gray-300">{{ summary }}</p>

    <!-- Приоритетные точки роста -->
    <div v-if="gaps.length" class="space-y-2">
      <h3 class="text-[11px] uppercase tracking-wider text-gray-500">Приоритетные точки роста</h3>
      <div v-for="(g, i) in gaps" :key="i"
           class="rounded-lg border p-3 space-y-1"
           :class="g.status === 'critical' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'">
        <div class="flex items-center gap-2">
          <span class="text-[10px] uppercase px-2 py-0.5 rounded-full border" :class="statusMeta(g.status).badge">
            {{ statusMeta(g.status).label }}
          </span>
          <span class="text-sm font-semibold text-gray-100">{{ g.label }}</span>
        </div>
        <p class="text-sm text-gray-300">{{ g.finding }}</p>
        <p v-if="g.action" class="text-xs text-fuchsia-200/90">→ {{ g.action }}</p>
      </div>
    </div>

    <!-- Полная карта факторов -->
    <div class="space-y-3 pt-1">
      <h3 class="text-[11px] uppercase tracking-wider text-gray-500">Карта факторов ранжирования</h3>
      <div v-for="grp in grouped" :key="grp.group" class="space-y-1.5">
        <div class="text-[11px] uppercase text-gray-600">{{ groupLabel(grp.group) }}</div>
        <div class="grid sm:grid-cols-2 gap-2">
          <div v-for="f in grp.items" :key="f.key"
               class="flex items-start gap-2 rounded-lg bg-gray-800/40 px-3 py-2">
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="statusMeta(f.status).dot"></span>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-gray-100">{{ f.label }}</span>
                <span class="text-[10px] uppercase text-gray-500">{{ statusMeta(f.status).label }}</span>
              </div>
              <p class="text-xs text-gray-400">{{ f.finding }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
