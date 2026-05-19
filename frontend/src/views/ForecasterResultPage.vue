<script setup>
/**
 * ForecasterResultPage — детальная страница задачи «Прогнозатор».
 *   • SVG-график (история + прогноз + аномалии + тренд),
 *   • карточки с цифрами (годовой прогноз, max severity, top3/5/10 трафик),
 *   • выводы DeepSeek (если есть),
 *   • кнопка «Поделиться» — выпускает короткий публичный URL.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ForecastChart from '../components/ForecastChart.vue';
import { useForecasterStore } from '../stores/forecaster.js';

const route  = useRoute();
const router = useRouter();
const store  = useForecasterStore();

const task = ref(null);
const loading = ref(true);
const err = ref(null);
const shareToken = ref(null);
const shareCopied = ref(false);
const shareBusy = ref(false);

let pollHandle = null;

async function load() {
  try {
    const t = await store.getTask(route.params.id);
    if (!t) {
      err.value = 'Задача не найдена';
      task.value = null;
      return;
    }
    task.value = t;
    shareToken.value = t.share_token || null;
    err.value = null;
  } catch (e) {
    err.value = e.response?.data?.error || e.message || 'Ошибка';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  pollHandle = setInterval(() => {
    if (task.value && (task.value.status === 'queued' || task.value.status === 'running')) {
      load();
    }
  }, 3000);
});
onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});

const monthly = computed(() => (task.value?.monthly_series?.monthly) || []);
const fcPoints = computed(() => (task.value?.forecast?.points) || []);
const anomalies = computed(() => (task.value?.anomalies?.drops) || []);
const trend = computed(() => task.value?.trend || null);
const trafficEst = computed(() => task.value?.traffic_estimate || null);
const dsSummary  = computed(() => task.value?.deepseek_summary || null);

const annualForecast = computed(() => task.value?.forecast?.annual_total || 0);
const annualHistorical = computed(() => {
  const tail = monthly.value.slice(-12);
  return tail.reduce((a, p) => a + p.demand, 0);
});

const growthPct = computed(() => {
  if (annualHistorical.value <= 0) return null;
  return Math.round(((annualForecast.value - annualHistorical.value) / annualHistorical.value) * 1000) / 10;
});

const shareUrl = computed(() => {
  if (!shareToken.value) return '';
  return `${window.location.origin}/forecast/share/${shareToken.value}`;
});

async function doShare() {
  if (!task.value || task.value.status !== 'done') return;
  shareBusy.value = true;
  try {
    const token = await store.createShare(task.value.id);
    shareToken.value = token;
    await copyShareLink();
  } catch (e) {
    alert(e.response?.data?.error || e.message || 'Ошибка');
  } finally {
    shareBusy.value = false;
  }
}

async function copyShareLink() {
  if (!shareUrl.value) return;
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareCopied.value = true;
    setTimeout(() => { shareCopied.value = false; }, 2200);
  } catch (_) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = shareUrl.value;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) { /* ignore */ }
    document.body.removeChild(ta);
    shareCopied.value = true;
    setTimeout(() => { shareCopied.value = false; }, 2200);
  }
}

async function doRevoke() {
  if (!shareToken.value || !task.value) return;
  if (!confirm('Отозвать ссылку? Старая ссылка перестанет работать.')) return;
  try {
    await store.revokeShare(task.value.id);
    shareToken.value = null;
  } catch (e) {
    alert(e.response?.data?.error || e.message || 'Ошибка');
  }
}

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
  <AppLayout>
    <div class="p-6 max-w-7xl mx-auto space-y-6">
      <header class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <button @click="router.push('/forecaster')"
                  class="text-xs text-indigo-400 hover:text-indigo-300">← к списку</button>
          <h1 class="text-xl font-semibold text-gray-100 mt-1">
            📈 {{ task?.name || 'Прогноз' }}
          </h1>
          <p v-if="task" class="text-xs text-gray-500 mt-0.5">
            Статус: <span class="font-semibold">{{ task.status }}</span>
            <span v-if="task.source_filename"> · 📎 {{ task.source_filename }}</span>
            <span v-if="task.source_rows_count"> · {{ task.source_rows_count }} строк</span>
          </p>
        </div>
        <div v-if="task && task.status === 'done'" class="flex items-center gap-2">
          <template v-if="shareToken">
            <input :value="shareUrl" readonly
                   class="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 w-72" />
            <button @click="copyShareLink"
                    class="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
              {{ shareCopied ? '✓ Скопировано' : '📋 Копировать' }}
            </button>
            <button @click="doRevoke"
                    class="text-xs px-2 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-rose-300">
              Отозвать
            </button>
          </template>
          <button v-else @click="doShare" :disabled="shareBusy"
                  class="text-sm px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">
            🔗 {{ shareBusy ? '…' : 'Поделиться' }}
          </button>
        </div>
      </header>

      <div v-if="loading" class="text-sm text-gray-500">Загрузка…</div>
      <div v-else-if="err" class="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-3">
        ⚠ {{ err }}
      </div>

      <template v-else-if="task">
        <!-- in-progress -->
        <div v-if="task.status === 'queued' || task.status === 'running'"
             class="text-sm text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded p-4">
          ↻ Задача обрабатывается… (автообновление каждые 3 сек)
        </div>

        <div v-else-if="task.status === 'error'"
             class="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-4">
          ⚠ Ошибка: {{ task.error_message || 'неизвестно' }}
        </div>

        <template v-else-if="task.status === 'done'">
          <!-- Сводные карточки -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <div class="text-[11px] text-gray-500 uppercase">Спрос за 12 мес (история)</div>
              <div class="text-xl font-semibold text-gray-100 mt-1">{{ fmtNum(annualHistorical) }}</div>
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
              <div class="text-xl font-semibold text-gray-100 mt-1">
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
              <div class="text-[11px] text-gray-500 mt-1">R²: {{ trend?.r_squared ?? '—' }}</div>
            </div>
          </div>

          <!-- График -->
          <section class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">График спроса (история + прогноз 12 мес)</h2>
            <ForecastChart
              :historical="monthly"
              :forecast-points="fcPoints"
              :trend-ema="trend?.ema || []"
              :anomalies="anomalies"
              :width="960" :height="380" />
            <p v-if="task.forecast?.fallback_reason" class="text-[11px] text-amber-300 mt-2 italic">
              ℹ {{ task.forecast.fallback_reason }}
            </p>
            <p class="text-[11px] text-gray-500 mt-1">
              Модель: <code>{{ task.forecast?.method }}</code>
              <span v-if="task.forecast?.params"> · α={{ task.forecast.params.alpha }} β={{ task.forecast.params.beta }} γ={{ task.forecast.params.gamma }}</span>
              · σ остатков: {{ task.forecast?.residual_std ?? '—' }}
            </p>
          </section>

          <!-- Аномальные зоны (детально) -->
          <section v-if="anomalies.length > 0" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">⚠ Зоны падения спроса</h2>
            <ul class="space-y-1.5 text-sm">
              <li v-for="(a, i) in anomalies" :key="i"
                  class="flex items-center justify-between gap-3 border border-gray-800 rounded px-3 py-2">
                <div class="flex items-center gap-2">
                  <span>{{ severityIcon(a.severity) }}</span>
                  <span class="text-gray-200">{{ a.from }} … {{ a.to }}</span>
                  <span class="text-xs text-gray-500">({{ a.length_months }} мес)</span>
                </div>
                <div class="text-xs text-rose-300 font-semibold">
                  −{{ Math.round(a.drop_pct * 100) }}% от baseline ({{ fmtNum(a.baseline) }})
                </div>
              </li>
            </ul>
          </section>

          <!-- Трафик top3/5/10 -->
          <section v-if="trafficEst" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">🎯 Оценка трафика при росте позиций</h2>
            <p class="text-xs text-gray-500 mb-3">
              Текущий трафик/мес: <span class="text-gray-200">{{ fmtNum(trafficEst.current_traffic_input) || 'не указан' }}</span>
              · Неявный CTR сейчас: <span class="text-gray-200">{{ fmtCtr(trafficEst.implied_ctr_now) }}</span>
              <span class="text-gray-600 ml-1">({{ trafficEst.implied_ctr_now_source }})</span>
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
                <div v-if="trafficEst[key].annual_vs_current != null" class="text-[11px] text-gray-500 mt-0.5">
                  Δ = {{ trafficEst[key].annual_vs_current > 0 ? '+' : '' }}{{ fmtNum(trafficEst[key].annual_vs_current) }}
                </div>
              </div>
            </div>
          </section>

          <!-- DeepSeek выводы -->
          <section v-if="dsSummary" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">🤖 Аналитические выводы (DeepSeek)</h2>
            <div v-if="dsSummary.verdict === 'ok'">
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
              <p class="text-[10px] text-gray-600 mt-3">
                Модель: {{ dsSummary.model || '—' }} · in {{ dsSummary.tokens_in }} · out {{ dsSummary.tokens_out }}
                · ${{ (dsSummary.cost_usd || 0).toFixed(4) }}
              </p>
            </div>
            <div v-else-if="dsSummary.verdict === 'skipped'" class="text-xs text-gray-500 italic">
              DeepSeek пропущен: {{ dsSummary.reason }}
            </div>
            <div v-else-if="dsSummary.verdict === 'error'" class="text-xs text-amber-400 italic">
              DeepSeek недоступен: {{ dsSummary.reason }}
            </div>
          </section>
        </template>
      </template>
    </div>
  </AppLayout>
</template>
