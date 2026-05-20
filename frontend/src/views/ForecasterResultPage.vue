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
const junkReport = computed(() => task.value?.junk_phrases || null);
const targetUrl  = computed(() => task.value?.target_url || task.value?.options?.target_url || null);
const excludedSummary = computed(() => task.value?.monthly_series?.excludedSummary || null);
const keyssoSignals   = computed(() => task.value?.keysso_signals || null);
const keyssoAgg       = computed(() => keyssoSignals.value?.aggregate || null);

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
          <p v-if="targetUrl" class="text-xs text-indigo-300 mt-0.5">
            🔗 Сайт: <a :href="targetUrl" target="_blank" rel="noopener noreferrer"
                       class="underline hover:text-indigo-200 break-all">{{ targetUrl }}</a>
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

          <!-- Трафик top3/5/10 -->
          <section v-if="trafficEst" class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">🎯 Реалистичная оценка трафика при росте позиций</h2>
            <p class="text-xs text-gray-500 mb-3">
              Текущий трафик/мес: <span class="text-gray-200">{{ fmtNum(trafficEst.current_traffic_input) || 'не указан' }}</span>
              · Неявный CTR сейчас: <span class="text-gray-200">{{ fmtCtr(trafficEst.implied_ctr_now) }}</span>
              <span class="text-gray-600 ml-1">({{ trafficEst.implied_ctr_now_source }})</span>
            </p>
            <details v-if="trafficEst.realism" class="mb-3 text-[11px] text-gray-400">
              <summary class="cursor-pointer hover:text-gray-300">
                ℹ Как считается «реалистичный» прогноз (никто не выходит в ТОП по ВСЕМ запросам)
              </summary>
              <p class="mt-1 leading-relaxed">{{ trafficEst.realism.explanation }}</p>
              <p class="mt-1">
                Доли фраз, реально доходящих до ТОП: ТОП-3 {{ Math.round(trafficEst.realism.share_top3 * 100) }}%,
                ТОП-5 {{ Math.round(trafficEst.realism.share_top5 * 100) }}%,
                ТОП-10 {{ Math.round(trafficEst.realism.share_top10 * 100) }}%.
                Кап от текущего трафика: ×{{ trafficEst.realism.max_uplift_top3 }} / ×{{ trafficEst.realism.max_uplift_top5 }} / ×{{ trafficEst.realism.max_uplift_top10 }}.
              </p>
            </details>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div v-for="key in ['top3','top5','top10']" :key="key"
                   class="border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] text-gray-500 uppercase">
                  ТОП-{{ key.replace('top','') }}
                  · реал. CTR <span class="text-gray-300">{{ fmtCtr(trafficEst[key].realistic_ctr ?? (trafficEst[key].target_ctr * (trafficEst.realism?.['share_' + key] ?? 1))) }}</span>
                </div>
                <div class="text-2xl font-semibold text-emerald-300 mt-1">{{ fmtNum(trafficEst[key].annual) }}</div>
                <div class="text-[11px] text-gray-500">визитов в год (реалистично)</div>
                <div v-if="trafficEst[key].uplift_x" class="text-xs text-emerald-400 mt-1">
                  ×{{ trafficEst[key].uplift_x }} vs текущий
                  <span v-if="trafficEst[key].uplift_capped" class="text-amber-400 ml-1" :title="`Ограничено максимумом ×${trafficEst[key].max_uplift_x} (защита от нереалистичного скачка)`">
                    🛡 cap
                  </span>
                </div>
                <div v-if="trafficEst[key].annual_vs_current != null" class="text-[11px] text-gray-500 mt-0.5">
                  Δ = {{ trafficEst[key].annual_vs_current > 0 ? '+' : '' }}{{ fmtNum(trafficEst[key].annual_vs_current) }}
                </div>
                <div v-if="trafficEst[key].optimistic" class="mt-2 pt-2 border-t border-gray-800 text-[11px] text-gray-500">
                  Потолок (идеальная выдача): <span class="text-gray-300">{{ fmtNum(trafficEst[key].optimistic.annual) }}</span>
                  <span v-if="trafficEst[key].optimistic.uplift_x" class="text-gray-500"> · ×{{ trafficEst[key].optimistic.uplift_x }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- Текущая видимость keys.so -->
          <section v-if="keyssoSignals && keyssoSignals.verdict === 'ok' && keyssoAgg"
                   class="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 class="text-sm font-semibold text-gray-200 mb-3">
              📊 Текущая видимость (keys.so)
              <span class="text-[11px] font-normal text-gray-500 ml-1">
                · домен <code class="text-gray-400">{{ keyssoSignals.domain }}</code>
                · {{ keyssoSignals.region || '—' }} · {{ keyssoSignals.engine || 'yandex' }}
              </span>
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
            <p v-if="trafficEst?.keysso_calibration" class="text-[11px] text-gray-400 mt-3 leading-relaxed">
              Прогноз скорректирован: realisticShare умножен на competition_factor =
              <b class="text-gray-200">{{ trafficEst.keysso_calibration.competition_factor }}</b>
              ({{ trafficEst.keysso_calibration.competition_label }} конкуренция).
              CTR-baseline = <b class="text-gray-200">{{ fmtCtr(trafficEst.implied_ctr_now) }}</b>
              ({{ trafficEst.implied_ctr_now_source }}).
              <span v-if="keyssoAgg.phrases_off_top50_pct > 0">
                {{ keyssoAgg.phrases_off_top50_pct }}% фраз сейчас за топ-50 — это снижает «потолок».
              </span>
            </p>
            <p class="text-[10px] text-gray-600 mt-2">
              Запрошено {{ keyssoSignals.requested }} фраз ·
              сопоставлено {{ keyssoSignals.matched }} ·
              из кеша {{ keyssoSignals.cache_hits }} ·
              {{ keyssoSignals.duration_ms }} мс
            </p>
          </section>

          <section v-else-if="keyssoSignals && keyssoSignals.verdict === 'skipped'"
                   class="text-[11px] text-gray-500 italic">
            📊 keys.so: пропущен ({{ keyssoSignals.reason }}). Прогноз использует дефолтный CTR.
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
                    · 🤖 DeepSeek-разметка ({{ junkReport.deepseek.items_count }})
                  </span>
                  <span v-else-if="junkReport.deepseek?.verdict === 'skipped'" class="text-gray-500 ml-1 italic">
                    · DeepSeek-разметка пропущена: {{ junkReport.deepseek.reason }}
                  </span>
                  <span v-else-if="junkReport.deepseek?.verdict === 'error'" class="text-amber-400 ml-1 italic">
                    · DeepSeek-разметка недоступна: {{ junkReport.deepseek.reason }}
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
