<script setup>
/**
 * ForecasterResultPage — детальная страница задачи «Прогнозатор».
 *   • SVG-график (история + прогноз + аномалии + тренд),
 *   • карточки с цифрами (годовой прогноз, max severity, top3/5/10 трафик),
 *   • аналитические AI-выводы (Gemini, если есть),
 *   • кнопка «Поделиться» — выпускает короткий публичный URL.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ForecastChart from '../components/ForecastChart.vue';
import UnifiedForecastChart from '../components/UnifiedForecastChart.vue';
import SemanticCoverageChart from '../components/SemanticCoverageChart.vue';
import ForecastAIReport from '../components/ForecastAIReport.vue';
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
const rerunBusy = ref(false);

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
    if (!task.value) return;
    const running = task.value.status === 'queued' || task.value.status === 'running';
    const reportGenerating = task.value.ai_report?.verdict === 'generating';
    if (running || reportGenerating) load();
  }, 3000);
});
onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});

const monthly = computed(() => (task.value?.monthly_series?.monthly) || []);
const fcPoints = computed(() => (task.value?.forecast?.points) || []);
const anomalies = computed(() => (task.value?.anomalies?.drops) || []);
const trend = computed(() => task.value?.trend || null);
const dsSummary  = computed(() => task.value?.deepseek_summary || null);
const vangaSummary = computed(() => task.value?.vanga_summary || null);
const noCommercialIntent = computed(() => task.value?.error_code === 'failed_no_commercial_intent');
const junkReport = computed(() => task.value?.junk_phrases || null);
const targetUrl  = computed(() => task.value?.target_url || task.value?.options?.target_url || null);
const excludedSummary = computed(() => task.value?.monthly_series?.excludedSummary || null);
const keyssoSignals   = computed(() => task.value?.keysso_signals || null);
const keyssoAgg       = computed(() => keyssoSignals.value?.aggregate || null);
const arsenkinReport  = computed(() => task.value?.arsenkin_report || null);
const arsenkinExcluded = computed(() => arsenkinReport.value?.stop_words_excluded || []);
const arsenkinExcludedOpen = ref(false);
const opportunities   = computed(() => task.value?.opportunities || null);
const oppList         = computed(() => opportunities.value?.opportunities || []);
const oppClusters     = computed(() => opportunities.value?.clusters || []);
const oppSummary      = computed(() => opportunities.value?.summary || null);
const leadsSummary    = computed(() => task.value?.leads_summary || null);
const expertReports   = computed(() => task.value?.expert_reports || null);
const sovForecast     = computed(() => task.value?.sov_forecast || null);
const progress        = computed(() => task.value?.progress || null);
const progressPct     = computed(() => {
  const p = Number(progress.value?.percent);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null;
});
const unified         = computed(() => {
  const u = task.value?.unified_forecast || null;
  return u && u.verdict === 'ok' ? u : null;
});
const unifiedParams   = computed(() => unified.value?.params || null);
const unifiedExplain  = computed(() => unified.value?.explain || null);
const unifiedSummary  = computed(() => unified.value?.summary || null);
const nicheStrategist = computed(() => expertReports.value?.niche_strategist || null);
const aiReport = computed(() => task.value?.ai_report || null);
// Временный флаг: «Граф охвата семантики» скрыт до починки модели
// распределения (показатели не соответствуют прогнозному росту).
const SHOW_SEMANTIC_CHART = false;
const semanticDistribution = computed(() => {
  const d = task.value?.semantic_distribution;
  return Array.isArray(d) && d.length > 0 ? d : null;
});

// Перегенерация AI-аналитики (только владелец задачи).
const reportBusy = ref(false);
async function regenerateReport() {
  if (!task.value || reportBusy.value) return;
  reportBusy.value = true;
  try {
    await store.regenerateReport(task.value.id);
    // Мгновенный skeleton — дальше poll подтянет готовый отчёт.
    task.value = { ...task.value, ai_report: { verdict: 'generating' } };
  } catch (e) {
    alert(e.response?.data?.error || e.message || 'Ошибка');
  } finally {
    reportBusy.value = false;
  }
}
const opportunityHunter = computed(() => expertReports.value?.opportunity_hunter || null);
const clusterPlanner  = computed(() => expertReports.value?.cluster_planner || null);

// Эксперт OpportunityHunter возвращает массив; индексируем по фразе для
// inline-отрисовки в таблице opportunities.
const hunterByPhrase = computed(() => {
  const out = new Map();
  const arr = opportunityHunter.value?.payload;
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    if (it && it.phrase) out.set(String(it.phrase).toLowerCase().trim(), it);
  }
  return out;
});

function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return (Number(v) * 100).toFixed(digits) + '%';
}
function fmtNumSafe(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('ru-RU');
}
function confidenceColor(c) {
  if (c === 'high') return 'text-emerald-300';
  if (c === 'mid')  return 'text-amber-300';
  if (c === 'low')  return 'text-rose-300';
  return 'text-gray-400';
}

function momentumIcon(m) {
  if (m === 'positive') return '↑';
  if (m === 'negative') return '↓';
  return '→';
}

// Фильтр шлак-таблицы
const junkFilter = ref('all');
const junkSeverityFilter = ref('all');
const junkVisible = computed(() => {
  const list = junkReport.value?.flagged || [];
  return list.filter((f) => {
    if (junkSeverityFilter.value !== 'all' && f.severity !== junkSeverityFilter.value) return false;
    if (junkFilter.value !== 'all' && !(f.reasons || []).includes(junkFilter.value)) return false;
    return true;
  });
});
const junkReasonsList = computed(() => Object.keys(junkReport.value?.counts?.by_reason || {}));
const junkReasonLabels = computed(() => junkReport.value?.reason_labels || {});

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

async function doRerun() {
  if (!task.value || rerunBusy.value) return;
  if (task.value.status === 'queued' || task.value.status === 'running') return;
  if (!confirm('Запустить расчёт заново? Текущие результаты будут пересчитаны.')) return;
  rerunBusy.value = true;
  try {
    const t = await store.rerunTask(task.value.id);
    if (t) {
      task.value = { ...task.value, ...t };
      shareToken.value = t.share_token || shareToken.value;
    }
    await load();
  } catch (e) {
    alert(e.response?.data?.error || e.message || 'Ошибка');
  } finally {
    rerunBusy.value = false;
  }
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('ru-RU');
}

const severityIcon = (s) => s === 'high' ? '🔴' : s === 'mid' ? '🟠' : '🟡';

const sovSummaryRows = computed(() => {
  const s = sovForecast.value?.summary;
  if (!s) return [];
  return [
    { label: 'Доля рынка (SOV)', start: fmtPct(s.sov?.current, 1), target: fmtPct(s.sov?.target, 1), total: '—' },
    { label: 'Трафик', start: fmtNum(s.traffic?.current), target: fmtNum(s.traffic?.at_h), total: fmtNum(s.traffic?.total) },
    { label: 'Лиды', start: fmtNumSafe(s.leads?.current), target: fmtNumSafe(s.leads?.at_h), total: fmtNumSafe(s.leads?.total) },
  ];
});
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
          <p v-if="targetUrl" class="text-xs text-indigo-300 mt-0.5">
            🔗 Сайт: <a :href="targetUrl" target="_blank" rel="noopener noreferrer"
                       class="underline hover:text-indigo-200 break-all">{{ targetUrl }}</a>
          </p>
        </div>
        <div v-if="task && (task.status === 'done' || task.status === 'error')"
             class="flex items-center gap-2">
          <button @click="doRerun" :disabled="rerunBusy"
                  class="text-sm px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white font-semibold"
                  title="Перезапустить расчёт (на случай ошибок или обновления данных)">
            🔄 {{ rerunBusy ? '…' : 'Запустить снова' }}
          </button>
          <template v-if="task.status === 'done'">
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
          </template>
        </div>
      </header>

      <div v-if="loading" class="text-sm text-gray-500">Загрузка…</div>
      <div v-else-if="err" class="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-3">
        ⚠ {{ err }}
      </div>

      <template v-else-if="task">
        <!-- in-progress: ползунок «сколько данных уже получили» -->
        <div v-if="task.status === 'queued' || task.status === 'running'"
             class="text-sm text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded p-4 space-y-3">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <span>↻ {{ progress?.label || 'Задача обрабатывается…' }}</span>
            <span class="font-semibold tabular-nums">{{ progressPct != null ? progressPct + ' %' : '…' }}</span>
          </div>
          <div class="h-2.5 bg-gray-800 rounded-full overflow-hidden" role="progressbar"
               :aria-valuenow="progressPct ?? 0" aria-valuemin="0" aria-valuemax="100">
            <div class="h-full bg-gradient-to-r from-sky-500 to-emerald-500 rounded-full transition-all duration-700"
                 :style="{ width: (progressPct ?? 2) + '%' }"></div>
          </div>
          <div class="text-xs text-sky-200/70">
            <span v-if="progress?.detail">{{ progress.detail }} · </span>автообновление каждые 3 сек
          </div>
        </div>

        <div v-else-if="task.status === 'error' && noCommercialIntent"
             class="text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-4">
          <div class="font-semibold">🛒 В вашем списке нет коммерческих запросов</div>
          <p class="text-xs text-amber-200/80 mt-2 leading-relaxed">
            Включён строгий коммерческий фильтр, но ни одна фраза не содержит коммерческого маркера
            (купить, цена, заказать, «под ключ», интернет-магазин…). Добавьте коммерческие запросы
            или создайте задачу без строгого фильтра.
          </p>
          <button @click="doRerun" :disabled="rerunBusy"
                  class="mt-3 text-sm px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white font-semibold">
            🔄 {{ rerunBusy ? 'Запускаю…' : 'Запустить снова' }}
          </button>
        </div>

        <div v-else-if="task.status === 'error'"
             class="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-4">
          <div>⚠ Ошибка: {{ task.error_message || 'неизвестно' }}</div>
          <button @click="doRerun" :disabled="rerunBusy"
                  class="mt-3 text-sm px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white font-semibold">
            🔄 {{ rerunBusy ? 'Запускаю…' : 'Запустить снова' }}
          </button>
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

          <!-- 🤖 AI-аналитика прогноза (сразу после шапки с KPI) -->
          <ForecastAIReport
            :report="aiReport"
            :can-regenerate="true"
            :busy="reportBusy"
            @regenerate="regenerateReport" />

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

          <!-- Banner: Исключено N фраз из расчёта прогноза -->
          <div v-if="excludedSummary && excludedSummary.phrases > 0"
               class="bg-amber-500/5 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200">
            🚫 Из расчёта прогноза исключено
            <b class="text-amber-100">{{ excludedSummary.phrases }}</b> фраз
            с суммарным спросом
            <b class="text-amber-100">{{ fmtNum(excludedSummary.total_demand) }}</b>
            (однословные ВЧ / мёртвые / чужие бренды).
            <span v-if="excludedSummary.sample_phrases?.length" class="text-amber-300/80">
              Например: {{ excludedSummary.sample_phrases.slice(0, 3).join(', ') }}.
            </span>
            <span class="text-gray-400">Цифры прогноза «честные» — без раздутого спроса.</span>
          </div>

          <!-- ✨ Единый прогноз трафика (главная модель): ретроданные + прогноз -->
          <section v-if="unified" class="bg-gradient-to-br from-gray-900 to-gray-900/60 border border-emerald-500/30 rounded-xl p-4">
            <div class="flex items-start justify-between gap-3 mb-1">
              <h2 class="text-base font-semibold text-emerald-200">
                🚀 Прогноз трафика, показов и лидов
              </h2>
              <span class="text-[10px] uppercase font-semibold border border-emerald-500/40 text-emerald-300 rounded px-1.5 py-0.5 whitespace-nowrap">
                единая модель
              </span>
            </div>
            <p v-if="unifiedExplain?.summary" class="text-xs text-gray-400 mb-3 leading-relaxed">
              {{ unifiedExplain.summary }}
            </p>

            <!-- Крупные цифры: сейчас → через горизонт -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">Трафик сейчас</div>
                <div class="text-xl font-semibold text-gray-100 mt-1">{{ fmtNum(unifiedSummary?.current_traffic) }}</div>
                <div class="text-[11px] text-gray-500">визитов / мес</div>
              </div>
              <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">Через {{ unified.horizon }} мес</div>
                <div class="text-xl font-semibold text-emerald-300 mt-1">{{ fmtNum(unifiedSummary?.at_horizon?.value) }}</div>
                <div class="text-[11px] text-gray-500">
                  от {{ fmtNum(unifiedSummary?.at_horizon?.lower) }} до {{ fmtNum(unifiedSummary?.at_horizon?.upper) }}
                </div>
              </div>
              <div class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">Всего за {{ unified.horizon }} мес</div>
                <div class="text-xl font-semibold text-emerald-300 mt-1">{{ fmtNum(unifiedSummary?.annual?.value) }}</div>
                <div class="text-[11px] text-gray-500">
                  {{ fmtNum(unifiedSummary?.annual?.lower) }} – {{ fmtNum(unifiedSummary?.annual?.upper) }}
                </div>
              </div>
              <div v-if="unifiedSummary?.annual_impressions != null" class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">Показов за {{ unified.horizon }} мес</div>
                <div class="text-xl font-semibold text-violet-300 mt-1">{{ fmtNum(unifiedSummary?.annual_impressions) }}</div>
                <div class="text-[11px] text-gray-500">видимость в выдаче</div>
              </div>
              <div v-if="unifiedSummary?.leads_annual != null" class="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">Заявок за {{ unified.horizon }} мес</div>
                <div class="text-xl font-semibold text-indigo-300 mt-1">{{ fmtNum(unifiedSummary?.leads_annual) }}</div>
                <div class="text-[11px] text-gray-500">визиты × конверсия</div>
              </div>
            </div>

            <UnifiedForecastChart :unified="unified" :height="400" />
            <p v-if="unifiedExplain?.horizon_line" class="text-sm text-emerald-200/90 mt-2 text-center">
              {{ unifiedExplain.horizon_line }}
            </p>

            <!-- Что где и почему: расшифровка факторов простым языком -->
            <details class="mt-4 group">
              <summary class="cursor-pointer text-sm text-gray-300 hover:text-emerald-200 select-none">
                💡 Что где и почему — из чего собран этот прогноз (для маркетолога и бизнеса)
              </summary>
              <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                <div v-for="f in (unifiedExplain?.factors || [])" :key="f.key"
                     class="border border-gray-800 rounded-lg p-3 bg-gray-950/40">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-semibold text-gray-200">{{ f.label }}</span>
                    <span class="text-sm font-mono text-emerald-300">{{ f.value }}</span>
                  </div>
                  <p class="text-[11px] text-gray-400 mt-1 leading-relaxed">{{ f.plain }}</p>
                </div>
              </div>
              <p class="text-[11px] text-gray-600 mt-2 italic">
                Формула: Прогноз = (спрос × сезонность × живые клики × расширение ядра) × ваша доля рынка.
                Зелёная зона на графике — «вилка» оптимистичного и осторожного сценария (растёт с горизонтом,
                потому что будущее всегда менее точно).
              </p>
            </details>
          </section>

          <!-- 🎯 Граф охвата семантики (по месяцам прогноза).
               Временно скрыт: показатели распределения не соответствуют
               прогнозному росту — включим обратно после починки модели
               (SHOW_SEMANTIC_CHART = true). -->
          <section v-if="SHOW_SEMANTIC_CHART && semanticDistribution" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-1">🎯 Граф охвата семантики</h2>
            <p class="text-xs text-gray-500 mb-3">
              Как семантика перетекает в ТОПы по месяцам прогноза и сколько трафика это даёт.
            </p>
            <SemanticCoverageChart :distribution="semanticDistribution" />
          </section>


          <!-- SOV-прогноз (детали) — график объединён в единый выше -->
          <section v-if="sovForecast" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <details>
              <summary class="cursor-pointer select-none text-sm font-semibold text-gray-200">
                📈 Детали доли рынка (SOV) — старт → цель → сумма за период
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
              <p class="text-[11px] text-gray-500 mt-2">
                λ={{ sovForecast.constants?.lambda }} · C_serp={{ sovForecast.constants?.c_serp }} · CR_final={{ fmtPct(sovForecast.constants?.cr_final, 2) }}.
                Динамика доли рынка учтена в едином графике выше (в тултипе — SOV по каждому месяцу).
              </p>
            </details>
          </section>

          <!-- Сбор сезонности через Арсенкин (режим «список ключей») -->
          <section v-if="arsenkinReport" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">
              🌊 Сбор сезонности (Арсенкин)
              <span class="ml-2 text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5"
                    :class="arsenkinReport.verdict === 'ok'
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      : 'bg-rose-500/10 text-rose-300 border-rose-500/30'">
                {{ arsenkinReport.verdict }}
              </span>
              <span v-if="arsenkinReport.commercial_only"
                    class="ml-1 text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5 bg-indigo-500/10 text-indigo-300 border-indigo-500/30">
                только коммерческие
              </span>
            </h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Ключей введено</div>
                <div class="text-lg font-semibold text-gray-100 mt-0.5">{{ arsenkinReport.keywords_input ?? '—' }}</div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Исключено стоп-словами</div>
                <div class="text-lg font-semibold text-amber-300 mt-0.5">{{ arsenkinExcluded.length }}</div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Отправлено в сбор</div>
                <div class="text-lg font-semibold text-sky-300 mt-0.5">{{ arsenkinReport.keywords_kept ?? '—' }}</div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Частоты получены</div>
                <div class="text-lg font-semibold text-emerald-300 mt-0.5">{{ arsenkinReport.matched ?? '—' }}</div>
              </div>
            </div>
            <p v-if="arsenkinReport.reason" class="text-[11px] text-rose-400 mt-2">
              ⚠ {{ arsenkinReport.reason }}
            </p>
            <div v-if="arsenkinExcluded.length > 0" class="mt-3">
              <button @click="arsenkinExcludedOpen = !arsenkinExcludedOpen"
                      class="text-xs text-indigo-400 hover:text-indigo-300">
                {{ arsenkinExcludedOpen ? '▾ скрыть' : '▸ показать' }} исключённые запросы ({{ arsenkinExcluded.length }})
              </button>
              <div v-if="arsenkinExcludedOpen" class="mt-2 max-h-60 overflow-y-auto border border-gray-800 rounded">
                <table class="w-full text-xs">
                  <thead class="text-gray-500 sticky top-0 bg-gray-900">
                    <tr><th class="text-left px-2 py-1.5">Запрос</th><th class="text-left px-2 py-1.5">Причина</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(e, i) in arsenkinExcluded" :key="i" class="border-t border-gray-800/60">
                      <td class="px-2 py-1 text-gray-300">{{ e.phrase }}</td>
                      <td class="px-2 py-1 text-amber-300">{{ e.matched === 'non_commercial' ? 'нет коммерческого маркера' : e.matched }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <!-- Текущая видимость -->
          <section v-if="keyssoSignals && keyssoSignals.verdict === 'ok' && keyssoAgg"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">
              📊 Текущая видимость
            </h2>
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Средняя позиция</div>
                <div class="text-lg font-semibold text-gray-100 mt-0.5">
                  {{ keyssoAgg.avg_current_position ?? '—' }}
                </div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">В топ-10</div>
                <div class="text-lg font-semibold text-emerald-300 mt-0.5">{{ keyssoAgg.phrases_in_top10_pct }}%</div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">В топ-30</div>
                <div class="text-lg font-semibold text-sky-300 mt-0.5">{{ keyssoAgg.phrases_in_top30_pct }}%</div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Медиана конкуренции</div>
                <div class="text-lg font-semibold text-gray-100 mt-0.5">
                  {{ keyssoAgg.median_competition ?? '—' }}
                </div>
              </div>
              <div class="border border-gray-800 rounded p-2.5">
                <div class="text-[10px] text-gray-500 uppercase">Momentum 3м</div>
                <div class="text-lg font-semibold mt-0.5"
                     :class="keyssoAgg.momentum === 'positive' ? 'text-emerald-300' :
                             keyssoAgg.momentum === 'negative' ? 'text-rose-300' : 'text-gray-300'">
                  {{ momentumIcon(keyssoAgg.momentum) }} {{ keyssoAgg.momentum }}
                </div>
              </div>
            </div>
            <p v-if="keyssoAgg.phrases_off_top50_pct > 0"
               class="text-[11px] text-gray-400 mt-3 leading-relaxed">
              {{ keyssoAgg.phrases_off_top50_pct }}% фраз сейчас за топ-50 — это снижает «потолок».
            </p>
          </section>

          <section v-else-if="keyssoSignals && keyssoSignals.verdict !== 'ok'"
                   class="text-[11px] text-gray-500 italic">
            📊 Текущая видимость: данные временно недоступны.
          </section>

          <!-- Шлак-запросы -->
          <section v-if="junkReport && junkReport.flagged && junkReport.flagged.length"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <header class="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div>
                <h2 class="text-sm font-semibold text-gray-200">🧹 Шлак-запросы (AI-фильтр)</h2>
                <p class="text-xs text-gray-500 mt-1">
                  Помечено
                  <span class="text-gray-200 font-semibold">{{ junkReport.counts?.junk_count || 0 }}</span>
                  из {{ junkReport.counts?.total_rows || 0 }} фраз
                  · <span :class="junkReport.summary?.warn ? 'text-amber-300' : 'text-gray-400'">
                    {{ junkReport.summary?.junk_pct }} %
                  </span>
                  <span v-if="junkReport.summary?.warn" class="text-amber-400">⚠ много мусора в ядре</span>
                  <span v-if="junkReport.deepseek?.verdict === 'ok'" class="text-emerald-300 ml-1">
                    · 🤖 AI-разметка ({{ junkReport.deepseek.items_count }})
                  </span>
                  <span v-else-if="junkReport.deepseek?.verdict === 'skipped'" class="text-gray-500 ml-1 italic">
                    · AI-разметка пропущена: {{ junkReport.deepseek.reason }}
                  </span>
                  <span v-else-if="junkReport.deepseek?.verdict === 'error'" class="text-amber-400 ml-1 italic">
                    · AI-разметка недоступна: {{ junkReport.deepseek.reason }}
                  </span>
                </p>
                <p v-if="junkReport.overflow" class="text-[11px] text-gray-500 mt-0.5 italic">
                  Показано {{ junkReport.overflow.stored }} из {{ junkReport.overflow.total }} помеченных.
                </p>
              </div>
              <div class="flex gap-2 items-center flex-wrap">
                <select v-model="junkSeverityFilter"
                        class="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200">
                  <option value="all">все важности</option>
                  <option value="high">🔴 high</option>
                  <option value="mid">🟠 mid</option>
                  <option value="low">🟡 low</option>
                </select>
                <select v-model="junkFilter"
                        class="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200">
                  <option value="all">все причины</option>
                  <option v-for="r in junkReasonsList" :key="r" :value="r">
                    {{ r }} ({{ junkReport.counts.by_reason[r] }})
                  </option>
                </select>
              </div>
            </header>
            <div class="max-h-[420px] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="bg-gray-950 sticky top-0">
                  <tr class="text-gray-400">
                    <th class="text-left px-2 py-1.5 font-normal">Фраза</th>
                    <th class="text-right px-2 py-1.5 font-normal w-20">Частотка</th>
                    <th class="text-left px-2 py-1.5 font-normal w-32">Причины</th>
                    <th class="text-left px-2 py-1.5 font-normal w-20">AI</th>
                    <th class="text-left px-2 py-1.5 font-normal">Комментарий</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, idx) in junkVisible" :key="'jp'+idx"
                      class="border-t border-gray-800 hover:bg-gray-950/50 transition">
                    <td class="px-2 py-1.5 text-gray-200">
                      <span class="mr-1">{{ severityIcon(f.severity) }}</span>{{ f.phrase }}
                      <span v-if="f.exclude_from_forecast"
                            class="ml-1 text-[10px] bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded px-1.5 py-0.5"
                            title="Эта фраза исключена из агрегации прогноза (однословник / мёртвая / чужой бренд)">
                        🚫 исключено из прогноза
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-right text-gray-400">{{ fmtNum(f.total) }}</td>
                    <td class="px-2 py-1.5">
                      <span v-for="r in f.reasons" :key="r"
                            class="inline-block text-[10px] bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded px-1.5 py-0.5 mr-1 mb-0.5"
                            :title="junkReasonLabels[r] || r">
                        {{ r }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5">
                      <span v-if="f.ai_verdict === 'drop'" class="text-rose-300 font-semibold">drop</span>
                      <span v-else-if="f.ai_verdict === 'keep'" class="text-emerald-300 font-semibold">keep</span>
                      <span v-else-if="f.ai_verdict === 'unsure'" class="text-amber-300">unsure</span>
                      <span v-else class="text-gray-600">—</span>
                    </td>
                    <td class="px-2 py-1.5 text-gray-400">{{ f.ai_reason || '—' }}</td>
                  </tr>
                  <tr v-if="junkVisible.length === 0">
                    <td colspan="5" class="px-2 py-3 text-center text-gray-500 italic">
                      Нет фраз под выбранные фильтры.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- ─── 👥 Заявки (объём, без выручки) ─── -->
          <section v-if="leadsSummary" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">
              👥 Заявки (объём, без выручки)
              <span class="text-xs text-gray-500 font-normal">
                · CR {{ leadsSummary.conversion_rate_pct }}%
                <span class="text-gray-600">({{ leadsSummary.conversion_rate_source }})</span>
                <span v-if="leadsSummary.intent" class="text-gray-600">· intent: {{ leadsSummary.intent }}</span>
              </span>
            </h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-xs text-gray-500">сейчас / год</div>
                <div class="text-base font-semibold text-gray-200 mt-0.5">
                  {{ fmtNumSafe(leadsSummary.current_leads_annual) }}
                </div>
                <div class="text-[10px] text-gray-500">
                  ≈ {{ fmtNumSafe(leadsSummary.current_leads_per_month) }} / мес
                </div>
              </div>
              <div class="bg-emerald-500/5 border border-emerald-500/20 rounded p-2">
                <div class="text-xs text-emerald-400">ТОП-3 / год</div>
                <div class="text-base font-semibold text-emerald-300 mt-0.5">
                  {{ fmtNumSafe(leadsSummary.top3_annual) }}
                </div>
              </div>
              <div class="bg-sky-500/5 border border-sky-500/20 rounded p-2">
                <div class="text-xs text-sky-400">ТОП-5 / год</div>
                <div class="text-base font-semibold text-sky-300 mt-0.5">
                  {{ fmtNumSafe(leadsSummary.top5_annual) }}
                </div>
              </div>
              <div class="bg-indigo-500/5 border border-indigo-500/20 rounded p-2">
                <div class="text-xs text-indigo-400">ТОП-10 / год</div>
                <div class="text-base font-semibold text-indigo-300 mt-0.5">
                  {{ fmtNumSafe(leadsSummary.top10_annual) }}
                </div>
              </div>
            </div>
            <p class="text-[11px] text-gray-500 mt-2 italic">
              leads = traffic × conversion_rate. Маржу/выручку модуль не считает — только объём.
            </p>
          </section>

          <!-- ─── 🎯 Точки усиления (opportunityAnalyzer) ─── -->
          <section v-if="opportunities && opportunities.verdict === 'ok' && oppList.length > 0"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <header class="mb-3">
              <h2 class="text-sm font-semibold text-gray-200">
                🎯 Точки усиления
                <span class="text-xs text-gray-500 font-normal">
                  · {{ oppSummary.opportunities_returned }} из {{ oppSummary.opportunities_total }}
                  · просадок {{ oppSummary.drop_count }}
                  · вне топ-10 {{ oppSummary.off_top10_count }}
                </span>
              </h2>
              <p class="text-[11px] text-gray-500 mt-1 leading-relaxed">
                Ранжировано по composite_score (просадка + объём + лёгкость конкуренции − негативный momentum).
                Сценарии: позиция (Verhulst-логистика) × CTR (power-law) × ramp-up (exp-decay).
              </p>
            </header>
            <div v-if="oppSummary.portfolio_ci" class="grid grid-cols-3 gap-2 mb-3 text-xs">
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-gray-500">портфель p10 / год (трафик)</div>
                <div class="text-gray-300 font-semibold">{{ fmtNumSafe(oppSummary.portfolio_ci.p10) }}</div>
              </div>
              <div class="bg-gray-950 border border-emerald-500/20 rounded p-2">
                <div class="text-emerald-400">портфель p50 / год (трафик)</div>
                <div class="text-emerald-300 font-semibold">{{ fmtNumSafe(oppSummary.portfolio_ci.p50) }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-gray-500">портфель p90 / год (трафик)</div>
                <div class="text-gray-300 font-semibold">{{ fmtNumSafe(oppSummary.portfolio_ci.p90) }}</div>
              </div>
              <div class="bg-gray-950 border border-sky-500/20 rounded p-2 col-span-3">
                <div class="text-sky-400">портфель заявок / год — best {{ fmtNumSafe(oppSummary.portfolio_best_annual_leads) }} · safe {{ fmtNumSafe(oppSummary.portfolio_safe_annual_leads) }}</div>
              </div>
            </div>
            <div class="max-h-[440px] overflow-y-auto border border-gray-800 rounded">
              <table class="w-full text-xs">
                <thead class="bg-gray-950 sticky top-0">
                  <tr class="text-gray-400">
                    <th class="text-left px-2 py-1.5 font-normal">Фраза</th>
                    <th class="text-right px-2 py-1.5 font-normal w-16">Спрос/мес</th>
                    <th class="text-right px-2 py-1.5 font-normal w-16">Поз.</th>
                    <th class="text-right px-2 py-1.5 font-normal w-16">Просад.</th>
                    <th class="text-right px-2 py-1.5 font-normal w-20">Трафик ТОП-3</th>
                    <th class="text-right px-2 py-1.5 font-normal w-20">Заявок ТОП-3</th>
                    <th class="text-right px-2 py-1.5 font-normal w-16">Score</th>
                    <th class="text-left px-2 py-1.5 font-normal">Действие (AI)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(o, idx) in oppList" :key="'op'+idx"
                      class="border-t border-gray-800 hover:bg-gray-950/50 transition">
                    <td class="px-2 py-1.5 text-gray-200">{{ o.phrase }}</td>
                    <td class="px-2 py-1.5 text-right text-gray-400">{{ fmtNumSafe(o.demand_monthly) }}</td>
                    <td class="px-2 py-1.5 text-right">
                      <span v-if="o.current_position != null" class="text-gray-300">{{ o.current_position }}</span>
                      <span v-else class="text-gray-600">—</span>
                    </td>
                    <td class="px-2 py-1.5 text-right">
                      <span :class="o.drop_pct >= 0.5 ? 'text-rose-300' : o.drop_pct >= 0.2 ? 'text-amber-300' : 'text-gray-500'">
                        {{ fmtPct(o.drop_pct, 0) }}
                      </span>
                    </td>
                    <td class="px-2 py-1.5 text-right text-emerald-300">
                      {{ fmtNumSafe(o.scenarios?.high?.top3?.expected_traffic_monthly) }}
                    </td>
                    <td class="px-2 py-1.5 text-right text-indigo-300">
                      {{ fmtNumSafe(o.scenarios?.high?.top3?.expected_leads_monthly) }}
                    </td>
                    <td class="px-2 py-1.5 text-right text-gray-300 font-mono">{{ o.composite_score }}</td>
                    <td class="px-2 py-1.5">
                      <template v-if="hunterByPhrase.get(o.phrase.toLowerCase().trim())">
                        <div class="text-[11px]">
                          <span class="inline-block bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 rounded px-1.5 py-0.5 mr-1">
                            {{ hunterByPhrase.get(o.phrase.toLowerCase().trim()).action_type }}
                          </span>
                          <span :class="confidenceColor(hunterByPhrase.get(o.phrase.toLowerCase().trim()).confidence)" class="text-[10px]">
                            ·{{ hunterByPhrase.get(o.phrase.toLowerCase().trim()).confidence }}
                          </span>
                          <span class="text-gray-500 text-[10px]">
                            · {{ hunterByPhrase.get(o.phrase.toLowerCase().trim()).effort_estimate_h }}ч
                          </span>
                          <div class="text-gray-400 text-[11px] mt-0.5">
                            {{ hunterByPhrase.get(o.phrase.toLowerCase().trim()).why }}
                          </div>
                        </div>
                      </template>
                      <span v-else class="text-gray-600">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section v-else-if="opportunities && opportunities.verdict === 'skipped'"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-500">
            🎯 Точки усиления: пропущено ({{ opportunities.reason }}).
          </section>

          <!-- ─── 🧭 NicheStrategist ─── -->
          <section v-if="nicheStrategist && nicheStrategist.verdict === 'ok' && nicheStrategist.payload"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-2">
              🧭 Стратегия ниши <span class="text-xs text-gray-500 font-normal">(NicheStrategist)</span>
            </h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-xs">
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-gray-500">ниша</div>
                <div class="text-gray-200 font-semibold">{{ nicheStrategist.payload.niche_label }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-gray-500">сложность</div>
                <div class="text-gray-200 font-semibold">{{ '★'.repeat(nicheStrategist.payload.niche_difficulty) }}{{ '☆'.repeat(5 - nicheStrategist.payload.niche_difficulty) }}</div>
              </div>
              <div class="bg-indigo-500/5 border border-indigo-500/20 rounded p-2">
                <div class="text-indigo-400">strategy lane</div>
                <div class="text-indigo-300 font-semibold">{{ nicheStrategist.payload.strategy_lane }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded p-2">
                <div class="text-gray-500">горизонт</div>
                <div class="text-gray-200 font-semibold">{{ nicheStrategist.payload.expected_horizon_months }} мес</div>
              </div>
            </div>
            <p v-if="nicheStrategist.payload.rationale" class="text-sm text-gray-300 mb-3 leading-relaxed italic">
              {{ nicheStrategist.payload.rationale }}
            </p>
            <div v-if="nicheStrategist.payload.primary_levers && nicheStrategist.payload.primary_levers.length">
              <div class="text-xs text-gray-500 uppercase mb-1">Основные рычаги</div>
              <ul class="list-disc pl-5 text-sm text-gray-300 space-y-0.5">
                <li v-for="(l, i) in nicheStrategist.payload.primary_levers" :key="'lv'+i">{{ l }}</li>
              </ul>
            </div>
            <div v-if="nicheStrategist.payload.decision_matrix && nicheStrategist.payload.decision_matrix.length" class="mt-3">
              <div class="text-xs text-gray-500 uppercase mb-1">Матрица решений</div>
              <table class="w-full text-xs border border-gray-800 rounded">
                <thead class="bg-gray-950">
                  <tr class="text-gray-400">
                    <th class="text-left px-2 py-1 font-normal">Если</th>
                    <th class="text-left px-2 py-1 font-normal">То</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(d, i) in nicheStrategist.payload.decision_matrix" :key="'dm'+i"
                      class="border-t border-gray-800">
                    <td class="px-2 py-1 text-amber-300">{{ d.if_condition }}</td>
                    <td class="px-2 py-1 text-emerald-300">{{ d.then_action }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="text-[10px] text-gray-600 mt-3">
              {{ nicheStrategist.model || '—' }} · in {{ nicheStrategist.tokens_in }} · out {{ nicheStrategist.tokens_out }}
              · ${{ (nicheStrategist.cost_usd || 0).toFixed(4) }}
            </p>
          </section>
          <section v-else-if="nicheStrategist && nicheStrategist.verdict !== 'ok'"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-500">
            🧭 NicheStrategist: {{ nicheStrategist.verdict }}{{ nicheStrategist.reason ? ' — ' + nicheStrategist.reason : '' }}
          </section>

          <!-- ─── 📋 ClusterPlanner ─── -->
          <section v-if="clusterPlanner && clusterPlanner.verdict === 'ok' && clusterPlanner.payload && clusterPlanner.payload.length"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">
              📋 План работ по кластерам <span class="text-xs text-gray-500 font-normal">(ClusterPlanner)</span>
            </h2>
            <div class="space-y-3 max-h-[420px] overflow-y-auto pr-1">
              <div v-for="(c, idx) in clusterPlanner.payload" :key="'cp'+idx"
                   class="bg-gray-950 border border-gray-800 rounded p-3">
                <div class="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <div class="text-sm text-gray-200 font-semibold">🪺 {{ c.cluster_centroid }}</div>
                    <div class="text-[11px] text-gray-500 mt-0.5">
                      целевой объём: <b class="text-gray-300">{{ c.content_units_target }}</b> юнитов ·
                      покрытие +{{ fmtPct(c.expected_coverage_gain, 0) }} ·
                      input-links ≥ {{ c.internal_links_min }}
                    </div>
                  </div>
                  <div class="flex gap-1 flex-wrap justify-end">
                    <span v-for="pt in (c.page_types || [])" :key="pt"
                          class="text-[10px] bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 rounded px-1.5 py-0.5">
                      {{ pt }}
                    </span>
                  </div>
                </div>
                <div v-if="c.phases && c.phases.length" class="space-y-1">
                  <div v-for="(ph, j) in c.phases" :key="'ph'+idx+'_'+j"
                       class="flex items-start gap-2 text-[11px] border-l-2 border-indigo-500/30 pl-2">
                    <span class="text-indigo-400 font-mono shrink-0">M{{ ph.month }}</span>
                    <div>
                      <div class="text-gray-200">{{ ph.milestone }}</div>
                      <ul v-if="ph.deliverables && ph.deliverables.length" class="list-disc pl-5 text-gray-500 mt-0.5">
                        <li v-for="(d, k) in ph.deliverables" :key="'dl'+idx+'_'+j+'_'+k">{{ d }}</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p class="text-[10px] text-gray-600 mt-3">
              {{ clusterPlanner.model || '—' }} · in {{ clusterPlanner.tokens_in }} · out {{ clusterPlanner.tokens_out }}
              · ${{ (clusterPlanner.cost_usd || 0).toFixed(4) }}
            </p>
          </section>
          <section v-else-if="clusterPlanner && clusterPlanner.verdict !== 'ok'"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-500">
            📋 ClusterPlanner: {{ clusterPlanner.verdict }}{{ clusterPlanner.reason ? ' — ' + clusterPlanner.reason : '' }}
          </section>

          <!-- Ванга — бизнес-саммари (Gemini) -->
          <section v-if="vangaSummary" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">🔮 Ванга — что вас ждёт</h2>
            <div v-if="vangaSummary.verdict === 'ok'">
              <p class="text-sm text-gray-200 leading-relaxed whitespace-pre-line">{{ vangaSummary.text }}</p>
              <p class="text-[10px] text-gray-600 mt-3">
                Модель: {{ vangaSummary.model || '—' }} · in {{ vangaSummary.tokens_in }} · out {{ vangaSummary.tokens_out }}
                · ${{ (vangaSummary.cost_usd || 0).toFixed(4) }}
              </p>
            </div>
            <div v-else class="text-xs text-gray-500 italic">
              Аналитика ИИ временно недоступна, но математический прогноз готов.
            </div>
          </section>

          <!-- Аналитические выводы (Gemini) -->
          <section v-if="dsSummary" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">🤖 Аналитические выводы</h2>
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
              Аналитика пропущена: {{ dsSummary.reason }}
            </div>
            <div v-else-if="dsSummary.verdict === 'error'" class="text-xs text-amber-400 italic">
              Аналитика недоступна: {{ dsSummary.reason }}
            </div>
          </section>
        </template>
      </template>
    </div>
  </AppLayout>
</template>
