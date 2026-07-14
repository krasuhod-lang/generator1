<script setup>
/**
 * ForecasterSharedPage — публичная read-only страница, открываемая по
 * share-токену. НЕ требует авторизации (роут не имеет meta.auth).
 *
 * Используем сырой axios (без api-instance, чтобы не подставлять Bearer)
 * — публичный эндпоинт.
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import ForecastChart from '../components/ForecastChart.vue';
import UnifiedForecastChart from '../components/UnifiedForecastChart.vue';
import SemanticCoverageChart from '../components/SemanticCoverageChart.vue';
import ForecastAIReport from '../components/ForecastAIReport.vue';

const route = useRoute();
const task = ref(null);
const loading = ref(true);
const err = ref(null);

onMounted(async () => {
  try {
    const { data } = await axios.get(`/api/public/forecaster/${route.params.token}`, {
      timeout: 30000,
    });
    task.value = data?.task || null;
    if (!task.value) err.value = 'Ссылка недействительна';
  } catch (e) {
    err.value = e.response?.data?.error || e.message || 'Ссылка недействительна';
  } finally {
    loading.value = false;
  }
});

const monthly    = computed(() => (task.value?.monthly_series?.monthly) || []);
const fcPoints   = computed(() => (task.value?.forecast?.points) || []);
const anomalies  = computed(() => (task.value?.anomalies?.drops) || []);
const trend      = computed(() => task.value?.trend || null);
const dsSummary  = computed(() => task.value?.deepseek_summary || null);
const aiReport   = computed(() => task.value?.ai_report || null);
// Временный флаг: «Граф охвата семантики» скрыт до починки модели.
const SHOW_SEMANTIC_CHART = false;
const semanticDistribution = computed(() => {
  const d = task.value?.semantic_distribution;
  return Array.isArray(d) && d.length > 0 ? d : null;
});
const vangaSummary = computed(() => task.value?.vanga_summary || null);
const sovForecast = computed(() => task.value?.sov_forecast || null);
const unified     = computed(() => {
  const u = task.value?.unified_forecast || null;
  return u && u.verdict === 'ok' ? u : null;
});

const annualForecast = computed(() => task.value?.forecast?.annual_total || 0);
const annualHistorical = computed(() =>
  monthly.value.slice(-12).reduce((a, p) => a + p.demand, 0)
);
const growthPct = computed(() => {
  if (annualHistorical.value <= 0) return null;
  return Math.round(((annualForecast.value - annualHistorical.value) / annualHistorical.value) * 1000) / 10;
});

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('ru-RU');
}
function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return (Number(v) * 100).toFixed(digits) + '%';
}
function fmtNumSafe(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('ru-RU');
}
const sovSummaryRows = computed(() => {
  const s = sovForecast.value?.summary;
  if (!s) return [];
  return [
    { label: 'Доля рынка (SOV)', start: fmtPct(s.sov?.current, 1), target: fmtPct(s.sov?.target, 1), total: '—' },
    { label: 'Трафик', start: fmtNum(s.traffic?.current), target: fmtNum(s.traffic?.at_h), total: fmtNum(s.traffic?.total) },
    { label: 'Лиды', start: fmtNumSafe(s.leads?.current), target: fmtNumSafe(s.leads?.at_h), total: fmtNumSafe(s.leads?.total) },
  ];
});
const severityIcon = (s) => s === 'high' ? '🔴' : s === 'mid' ? '🟠' : '🟡';
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-100">
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3">
      <div class="max-w-6xl mx-auto flex items-center gap-3">
        <div class="text-lg font-semibold">📈 Прогноз спроса</div>
        <div class="text-xs text-gray-500 ml-auto">read-only · ссылка владельца отчёта</div>
      </div>
    </header>

    <main class="p-6 max-w-6xl mx-auto space-y-6">
      <div v-if="loading" class="text-sm text-gray-500">Загрузка…</div>
      <div v-else-if="err" class="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-4">
        ⚠ {{ err }}
      </div>

      <template v-else-if="task">
        <header>
          <h1 class="text-2xl font-semibold">{{ task.name || 'Прогноз спроса' }}</h1>
          <p class="text-xs text-gray-500 mt-1">
            Источник: {{ task.source_filename || '—' }}
            · строк: {{ task.source_rows_count }}
            · построено: {{ task.completed_at ? new Date(task.completed_at).toLocaleDateString('ru-RU') : '—' }}
          </p>
        </header>

        <!-- Сводные карточки -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div class="text-[11px] text-gray-500 uppercase">Спрос за 12 мес (история)</div>
            <div class="text-xl font-semibold mt-1">{{ fmtNum(annualHistorical) }}</div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div class="text-[11px] text-gray-500 uppercase">Прогноз на 12 мес</div>
            <div class="text-xl font-semibold text-indigo-300 mt-1">{{ fmtNum(annualForecast) }}</div>
            <div v-if="growthPct != null" class="text-[11px] mt-1"
                 :class="growthPct >= 0 ? 'text-emerald-400' : 'text-rose-400'">
              {{ growthPct >= 0 ? '▲' : '▼' }} {{ Math.abs(growthPct) }} % vs прошлый год
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div class="text-[11px] text-gray-500 uppercase">Аномалий</div>
            <div class="text-xl font-semibold mt-1">
              {{ anomalies.length }}
              <span v-if="task.anomalies?.summary?.max_severity && task.anomalies.summary.max_severity !== 'none'"
                    class="text-sm font-normal text-gray-400">
                · {{ task.anomalies.summary.max_severity }}
              </span>
            </div>
          </div>
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div class="text-[11px] text-gray-500 uppercase">Тренд</div>
            <div class="text-xl font-semibold mt-1"
                 :class="trend?.direction === 'up' ? 'text-emerald-300' :
                         trend?.direction === 'down' ? 'text-rose-300' : 'text-gray-200'">
              {{ trend?.direction === 'up' ? '▲ растёт' :
                 trend?.direction === 'down' ? '▼ падает' : '─ плоский' }}
            </div>
          </div>
        </div>

        <!-- 🤖 AI-аналитика прогноза (read-only) -->
        <ForecastAIReport v-if="aiReport?.verdict === 'ok'"
          :report="aiReport"
          :can-regenerate="false" />

        <!-- График -->
        <section class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-3">График спроса (история + прогноз 12 мес)</h2>
          <ForecastChart
            :historical="monthly"
            :forecast-points="fcPoints"
            :trend-ema="trend?.ema || []"
            :anomalies="anomalies"
            :width="900" :height="380" />
        </section>

        <!-- Аномалии -->
        <section v-if="anomalies.length > 0" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-3">⚠ Зоны падения спроса</h2>
          <ul class="space-y-1.5 text-sm">
            <li v-for="(a, i) in anomalies" :key="i"
                class="flex items-center justify-between gap-3 border border-gray-800 rounded px-3 py-2">
              <div class="flex items-center gap-2">
                <span>{{ severityIcon(a.severity) }}</span>
                <span>{{ a.from }} … {{ a.to }}</span>
                <span class="text-xs text-gray-500">({{ a.length_months }} мес)</span>
              </div>
              <div class="text-xs text-rose-300 font-semibold">−{{ Math.round(a.drop_pct * 100) }}%</div>
            </li>
          </ul>
        </section>

        <!-- ✨ Единый прогноз трафика: ретроданные + прогноз -->
        <section v-if="unified" class="bg-gray-900 border border-emerald-500/30 rounded-xl p-4">
          <h2 class="text-base font-semibold text-emerald-200 mb-1">🚀 Прогноз трафика, показов и лидов</h2>
          <p v-if="unified.explain?.summary" class="text-xs text-gray-400 mb-3 leading-relaxed">{{ unified.explain.summary }}</p>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] text-gray-500 uppercase">Трафик сейчас</div>
              <div class="text-xl font-semibold text-gray-100 mt-1">{{ fmtNum(unified.summary?.current_traffic) }}</div>
            </div>
            <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] text-gray-500 uppercase">Через {{ unified.horizon }} мес</div>
              <div class="text-xl font-semibold text-emerald-300 mt-1">{{ fmtNum(unified.summary?.at_horizon?.value) }}</div>
              <div class="text-[11px] text-gray-500">
                от {{ fmtNum(unified.summary?.at_horizon?.lower) }} до {{ fmtNum(unified.summary?.at_horizon?.upper) }}
              </div>
            </div>
            <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] text-gray-500 uppercase">Всего за {{ unified.horizon }} мес</div>
              <div class="text-xl font-semibold text-emerald-300 mt-1">{{ fmtNum(unified.summary?.annual?.value) }}</div>
            </div>
          </div>
          <UnifiedForecastChart :unified="unified" :height="380" />
          <p v-if="unified.explain?.horizon_line" class="text-sm text-emerald-200/90 mt-2 text-center">
            {{ unified.explain.horizon_line }}
          </p>
        </section>

        <!-- 🎯 Граф охвата семантики. Временно скрыт: показатели не
             соответствуют прогнозному росту — включим после починки. -->
        <section v-if="SHOW_SEMANTIC_CHART && semanticDistribution" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-1">🎯 Граф охвата семантики</h2>
          <p class="text-xs text-gray-500 mb-3">
            Как семантика перетекает в ТОПы по месяцам прогноза и сколько трафика это даёт.
          </p>
          <SemanticCoverageChart :distribution="semanticDistribution" />
        </section>


        <!-- SOV-прогноз (детали) — график объединён в единый выше -->
        <section v-if="sovForecast" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <details>
            <summary class="cursor-pointer select-none text-sm font-semibold">
              📈 Детали доли рынка (SOV)
            </summary>
            <div class="overflow-x-auto border border-gray-800 rounded-lg mt-3">
              <table class="w-full text-sm">
                <thead class="bg-gray-950 text-gray-400">
                  <tr>
                    <th class="text-left px-3 py-2 font-normal">Метрика</th>
                    <th class="text-right px-3 py-2 font-normal">На старте</th>
                    <th class="text-right px-3 py-2 font-normal">Цель (через {{ sovForecast.h_max }} мес)</th>
                    <th class="text-right px-3 py-2 font-normal">Суммарно за период</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in sovSummaryRows" :key="row.label" class="border-t border-gray-800">
                    <td class="px-3 py-2 text-gray-300">{{ row.label }}</td>
                    <td class="px-3 py-2 text-right text-gray-100">{{ row.start }}</td>
                    <td class="px-3 py-2 text-right text-indigo-300 font-semibold">{{ row.target }}</td>
                    <td class="px-3 py-2 text-right text-emerald-300">{{ row.total }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </section>

        <!-- Ванга — бизнес-саммари (Gemini) -->
        <section v-if="vangaSummary && vangaSummary.verdict === 'ok'"
                 class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-3">🔮 Ванга — что вас ждёт</h2>
          <p class="text-sm text-gray-200 leading-relaxed whitespace-pre-line">{{ vangaSummary.text }}</p>
        </section>

        <!-- Аналитические выводы (Gemini) -->
        <section v-if="dsSummary && dsSummary.verdict === 'ok'"
                 class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-3">🤖 Аналитические выводы</h2>
          <p v-if="dsSummary.summary" class="text-sm text-gray-200 mb-3 leading-relaxed">
            {{ dsSummary.summary }}
          </p>
          <div v-if="dsSummary.bullets && dsSummary.bullets.length">
            <div class="text-xs text-gray-500 uppercase mb-1">Ключевые наблюдения</div>
            <ul class="list-disc pl-5 text-sm text-gray-300 space-y-1">
              <li v-for="(b, i) in dsSummary.bullets" :key="'b'+i">{{ b }}</li>
            </ul>
          </div>
          <div v-if="dsSummary.recommendations && dsSummary.recommendations.length" class="mt-3">
            <div class="text-xs text-gray-500 uppercase mb-1">Рекомендации</div>
            <ul class="list-disc pl-5 text-sm text-gray-300 space-y-1">
              <li v-for="(r, i) in dsSummary.recommendations" :key="'r'+i">{{ r }}</li>
            </ul>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
