<script setup>
/**
 * ForecastAIReport.vue — карточка «AI-аналитика прогноза».
 *
 * UX-состояния:
 *   • report == null и задача done → кнопка «Сгенерировать аналитику»,
 *   • report.verdict === 'generating' → skeleton-loader,
 *   • report.verdict === 'ok' → полная карточка с секциями,
 *   • report.verdict error/skipped → плашка с кнопкой «Повторить».
 *
 * Кнопки генерации/перегенерации — только для владельца задачи
 * (canRegenerate=false на шаренной странице): шлют emit('regenerate'),
 * родитель делает POST /api/forecaster/:id/regenerate-report и поллит задачу.
 */
import { computed } from 'vue';

const props = defineProps({
  report:        { type: Object, default: null }, // ai_report
  canRegenerate: { type: Boolean, default: false },
  busy:          { type: Boolean, default: false },
});
const emit = defineEmits(['regenerate']);

const verdict = computed(() => props.report?.verdict || null);
const rep = computed(() => (verdict.value === 'ok' ? props.report?.report || null : null));

const impactBadge = (impact) => {
  if (impact === 'high') return { label: 'HIGH', cls: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' };
  if (impact === 'low')  return { label: 'LOW',  cls: 'bg-gray-500/15 border-gray-500/40 text-gray-400' };
  return { label: 'MED', cls: 'bg-amber-500/15 border-amber-500/40 text-amber-300' };
};
</script>

<template>
  <section class="bg-gradient-to-br from-gray-900 to-gray-900/60 border border-indigo-500/30 rounded-xl p-4">
    <div class="flex items-start justify-between gap-3 mb-3">
      <h2 class="text-base font-semibold text-indigo-200">🤖 AI-аналитика прогноза</h2>
      <button v-if="canRegenerate && verdict === 'ok'"
              @click="emit('regenerate')" :disabled="busy"
              class="text-xs px-3 py-1.5 rounded border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-60 font-semibold">
        {{ busy ? '…' : '↻ Перегенерировать' }}
      </button>
    </div>

    <!-- Нет отчёта → кнопка генерации -->
    <div v-if="!verdict" class="text-center py-6">
      <p class="text-sm text-gray-400 mb-3">
        Экспертная интерпретация прогноза: почему такая динамика, где узкие места семантики и что делать дальше.
      </p>
      <button v-if="canRegenerate" @click="emit('regenerate')" :disabled="busy"
              class="text-sm px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold">
        {{ busy ? 'Запускаю…' : '✨ Сгенерировать аналитику' }}
      </button>
      <p v-else class="text-xs text-gray-500 italic">AI-аналитика ещё не сгенерирована.</p>
    </div>

    <!-- Генерация → skeleton -->
    <div v-else-if="verdict === 'generating'" class="space-y-3 animate-pulse" aria-label="Генерация отчёта…">
      <div class="h-4 bg-gray-800 rounded w-3/4"></div>
      <div class="h-4 bg-gray-800 rounded w-full"></div>
      <div class="h-4 bg-gray-800 rounded w-5/6"></div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="h-20 bg-gray-800 rounded"></div>
        <div class="h-20 bg-gray-800 rounded"></div>
      </div>
      <p class="text-xs text-indigo-300/80 text-center">🤖 AI анализирует прогноз… обычно до минуты.</p>
    </div>

    <!-- Ошибка → плашка «Повторить» -->
    <div v-else-if="verdict !== 'ok'"
         class="text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-3">
      <div>⚠ Не удалось сгенерировать аналитику{{ report?.reason ? `: ${report.reason}` : '' }}.</div>
      <button v-if="canRegenerate" @click="emit('regenerate')" :disabled="busy"
              class="mt-2 text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white font-semibold">
        {{ busy ? '…' : '🔄 Повторить' }}
      </button>
      <p v-else class="text-xs text-amber-300/70 mt-1 italic">Математический прогноз при этом полностью готов.</p>
    </div>

    <!-- Готовый отчёт -->
    <div v-else-if="rep" class="space-y-4">
      <!-- 📋 Резюме -->
      <div v-if="rep.executive_summary">
        <h3 class="text-xs text-gray-500 uppercase mb-1">📋 Резюме</h3>
        <p class="text-sm text-gray-200 leading-relaxed">{{ rep.executive_summary }}</p>
      </div>

      <!-- 📈 Динамика роста · 🔍 Семантические пробелы -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div v-if="rep.growth_narrative" class="bg-gray-950/50 border border-gray-800 rounded-lg p-3">
          <h3 class="text-xs text-gray-500 uppercase mb-1">📈 Динамика роста</h3>
          <p class="text-sm text-gray-300 leading-relaxed">{{ rep.growth_narrative }}</p>
        </div>
        <div v-if="rep.semantic_gap_analysis" class="bg-gray-950/50 border border-gray-800 rounded-lg p-3">
          <h3 class="text-xs text-gray-500 uppercase mb-1">🔍 Семантические пробелы</h3>
          <p class="text-sm text-gray-300 leading-relaxed">{{ rep.semantic_gap_analysis }}</p>
        </div>
      </div>

      <!-- 🚀 Точки роста -->
      <div v-if="rep.top_opportunities && rep.top_opportunities.length">
        <h3 class="text-xs text-gray-500 uppercase mb-1.5">🚀 Точки роста</h3>
        <ul class="space-y-1.5">
          <li v-for="(o, i) in rep.top_opportunities" :key="'op'+i"
              class="flex items-start gap-2 text-sm border border-gray-800 rounded px-3 py-2">
            <span class="text-[10px] font-semibold border rounded px-1.5 py-0.5 mt-0.5 shrink-0"
                  :class="impactBadge(o.impact).cls">{{ impactBadge(o.impact).label }}</span>
            <div>
              <span class="text-gray-200 font-semibold">{{ o.title }}</span>
              <span v-if="o.description" class="text-gray-400"> — {{ o.description }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- ⚠️ Риски -->
      <div v-if="rep.risks && rep.risks.length">
        <h3 class="text-xs text-gray-500 uppercase mb-1.5">⚠️ Риски</h3>
        <ul class="space-y-1.5">
          <li v-for="(r, i) in rep.risks" :key="'rk'+i"
              class="text-sm border border-rose-500/20 bg-rose-500/5 rounded px-3 py-2">
            <span class="text-rose-200 font-semibold">{{ r.title }}</span>
            <span v-if="r.description" class="text-gray-400"> — {{ r.description }}</span>
          </li>
        </ul>
      </div>

      <!-- 📅 План действий -->
      <div v-if="rep.action_plan && rep.action_plan.length">
        <h3 class="text-xs text-gray-500 uppercase mb-1.5">📅 План действий</h3>
        <ul class="space-y-1">
          <li v-for="(a, i) in rep.action_plan" :key="'ap'+i"
              class="flex items-start gap-2 text-sm border-l-2 border-indigo-500/40 pl-2.5 py-0.5">
            <span class="text-indigo-300 font-mono text-xs shrink-0 mt-0.5">{{ a.month_range || '—' }}</span>
            <div class="text-gray-300">
              {{ a.action }}
              <span v-if="a.expected_effect" class="text-emerald-300/90"> → {{ a.expected_effect }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 💡 Достоверность -->
      <div v-if="rep.confidence_comment" class="border-t border-gray-800 pt-3">
        <h3 class="text-xs text-gray-500 uppercase mb-1">💡 Достоверность прогноза</h3>
        <p class="text-sm text-gray-400 italic leading-relaxed">{{ rep.confidence_comment }}</p>
      </div>

      <p class="text-[10px] text-gray-600">
        Модель: {{ report.model || '—' }} · in {{ report.tokens_in }} · out {{ report.tokens_out }}
        · ${{ (report.cost_usd || 0).toFixed(4) }}
      </p>
    </div>
  </section>
</template>
