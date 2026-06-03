<script setup>
/**
 * ProjectSharedPage — публичная read-only версия дашборда проекта.
 * Открывается по ссылке /share/project/:token без авторизации.
 * Клиент видит график GSC (из снапшота последнего анализа) и AI-отчёт.
 * Никаких кнопок управления (анализ, удаление, настройки интеграции).
 */
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import GscPerformanceChart from '../components/GscPerformanceChart.vue';
import MarkdownView from '../components/MarkdownView.vue';
import CommercialInsights from '../components/CommercialInsights.vue';
import AnalyticsExtras from '../components/AnalyticsExtras.vue';

const route = useRoute();
const loading = ref(true);
const error = ref('');
const project = ref(null);
const analysis = ref(null);

onMounted(async () => {
  try {
    const { data } = await axios.get(`/api/public/project/${route.params.token}`);
    project.value = data.project;
    analysis.value = data.analysis;
  } catch (err) {
    error.value = err.response?.data?.error || 'Ссылка недействительна или отозвана';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="min-h-screen bg-gray-950 text-gray-200 px-4 py-8">
    <div class="max-w-6xl mx-auto space-y-5">
      <div v-if="loading" class="space-y-4">
        <div class="h-20 rounded-lg animate-pulse bg-gray-900/60"></div>
        <div class="h-80 rounded-lg animate-pulse bg-gray-900/60"></div>
      </div>

      <div v-else-if="error" class="text-center py-20 text-gray-400">{{ error }}</div>

      <template v-else>
        <header class="border-b border-gray-800 pb-4">
          <div class="text-xs uppercase tracking-wider text-indigo-400">Публичный отчёт</div>
          <h1 class="text-2xl font-bold text-gray-100 mt-1">{{ project.name }}</h1>
          <div class="text-sm text-gray-500">{{ project.gsc_site_url || project.url }}</div>
        </header>

        <div v-if="!analysis" class="text-sm text-gray-500 text-center py-10">
          Отчёт ещё не сформирован.
        </div>

        <template v-else>
          <!-- Totals + chart из снапшота -->
          <section v-if="analysis.gsc_snapshot" class="bg-gray-900/40 border border-gray-800 rounded-xl p-4 space-y-4">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">График эффективности</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Клики</div>
                <div class="text-xl font-bold text-indigo-300">{{ (analysis.gsc_snapshot.totals?.clicks || 0).toLocaleString('ru') }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Показы</div>
                <div class="text-xl font-bold text-violet-300">{{ (analysis.gsc_snapshot.totals?.impressions || 0).toLocaleString('ru') }}</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">CTR</div>
                <div class="text-xl font-bold text-emerald-300">{{ analysis.gsc_snapshot.totals?.ctr || 0 }}%</div>
              </div>
              <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div class="text-[11px] uppercase text-gray-500">Ср. позиция</div>
                <div class="text-xl font-bold text-amber-300">{{ analysis.gsc_snapshot.totals?.position || 0 }}</div>
              </div>
            </div>
            <GscPerformanceChart v-if="analysis.gsc_snapshot.series?.length"
                                 :series="analysis.gsc_snapshot.series" />
          </section>

          <!-- AI report -->
          <section class="bg-gray-900/40 border border-gray-800 rounded-xl p-4 space-y-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-indigo-300">AI-отчёт</h2>
            <MarkdownView :source="analysis.report_markdown" />
          </section>

          <!-- Коммерческий срез -->
          <CommercialInsights v-if="analysis.gsc_snapshot?.commercial"
                              :commercial="analysis.gsc_snapshot.commercial"
                              :serp-verification="analysis.gsc_snapshot?.serp_verification || null" />

          <AnalyticsExtras v-if="analysis.gsc_snapshot && (analysis.gsc_snapshot.period_compare || analysis.gsc_snapshot.breakdowns || analysis.gsc_snapshot.page_decay || analysis.gsc_snapshot.brand_split)"
                           :period-compare="analysis.gsc_snapshot.period_compare || null"
                           :breakdowns="analysis.gsc_snapshot.breakdowns || null"
                           :page-decay="analysis.gsc_snapshot.page_decay || null"
                           :brand-split="analysis.gsc_snapshot.brand_split || null" />
        </template>
      </template>
    </div>
  </div>
</template>
