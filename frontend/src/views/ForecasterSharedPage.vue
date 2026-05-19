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
const trafficEst = computed(() => task.value?.traffic_estimate || null);
const dsSummary  = computed(() => task.value?.deepseek_summary || null);

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
function fmtCtr(c) {
  if (c == null || !Number.isFinite(c)) return '—';
  return (c * 100).toFixed(2) + '%';
}
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

        <!-- Трафик -->
        <section v-if="trafficEst" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 class="text-sm font-semibold mb-3">🎯 Потенциальный трафик при росте позиций</h2>
          <p class="text-xs text-gray-500 mb-3">
            Текущий трафик/мес: <span class="text-gray-200">{{ fmtNum(trafficEst.current_traffic_input) || 'не указан' }}</span>
            · Базовый CTR: <span class="text-gray-200">{{ fmtCtr(trafficEst.implied_ctr_now) }}</span>
          </p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div v-for="key in ['top3','top5','top10']" :key="key"
                 class="border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] text-gray-500 uppercase">
                ТОП-{{ key.replace('top','') }} · CTR {{ fmtCtr(trafficEst[key].target_ctr) }}
              </div>
              <div class="text-2xl font-semibold text-emerald-300 mt-1">{{ fmtNum(trafficEst[key].annual) }}</div>
              <div class="text-[11px] text-gray-500">визитов в год</div>
              <div v-if="trafficEst[key].uplift_x" class="text-xs text-emerald-400 mt-1">
                ×{{ trafficEst[key].uplift_x }} vs текущий
              </div>
            </div>
          </div>
        </section>

        <!-- DeepSeek -->
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
