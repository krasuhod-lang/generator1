<script setup>
/**
 * ProjectSharedPage — публичная read-only версия дашборда проекта.
 * Открывается по ссылке /share/project/:token без авторизации.
 *
 * Клиент видит данные в формате переключаемых вкладок (как в рабочем кабинете):
 *   • Google   — график GSC, AI-отчёт и все срезы по Google;
 *   • Яндекс   — эффективность и AI-отчёт по Яндекс.Вебмастеру;
 *   • Сводная  — закономерности Google ↔ Яндекс и аудит факторов ранжирования.
 * Вкладки показываются только при наличии данных; активной становится первая доступная.
 * Никаких кнопок управления (анализ, удаление, настройки интеграции).
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import GscPerformanceChart from '../components/GscPerformanceChart.vue';
import MarkdownView from '../components/MarkdownView.vue';
import CommercialInsights from '../components/CommercialInsights.vue';
import AnalyticsExtras from '../components/AnalyticsExtras.vue';
import RankingFactorsCard from '../components/RankingFactorsCard.vue';
import ActionPlanCard from '../components/ActionPlanCard.vue';
import TopPageInsightsCard from '../components/TopPageInsightsCard.vue';
import LinkProfileCard from '../components/LinkProfileCard.vue';
import MetaSuggestionsCard from '../components/MetaSuggestionsCard.vue';
import BlogTopicsCard from '../components/BlogTopicsCard.vue';
import EatTemplatesCard from '../components/EatTemplatesCard.vue';
import SchemaAuditCard from '../components/SchemaAuditCard.vue';
import AiVisibilityCard from '../components/AiVisibilityCard.vue';

const route = useRoute();
const loading = ref(true);
const error = ref('');
const project = ref(null);
const analysis = ref(null);

const snap = computed(() => analysis.value?.gsc_snapshot || null);
const ydx = computed(() => analysis.value?.ydx_snapshot || null);

// Доступность каждой верхнеуровневой вкладки определяется наличием данных,
// чтобы клиент не видел пустых разделов.
const hasGoogle = computed(() => !!(analysis.value?.report_markdown || snap.value));
const hasYandex = computed(() => !!(analysis.value?.ydx_report_markdown || ydx.value));
const hasSynthesis = computed(() => !!(analysis.value?.synthesis_markdown || analysis.value?.ranking_factors));

const tabs = computed(() => [
  { key: 'google', label: 'Google', accent: 'indigo', show: hasGoogle.value },
  { key: 'yandex', label: 'Яндекс', accent: 'red', show: hasYandex.value },
  { key: 'synthesis', label: 'Сводная', accent: 'fuchsia', show: hasSynthesis.value },
].filter((t) => t.show));

const activeTab = ref('google');
// Активная вкладка: выбранная клиентом, либо первая доступная.
const currentTab = computed(() => {
  const list = tabs.value;
  if (!list.length) return '';
  return list.some((t) => t.key === activeTab.value) ? activeTab.value : list[0].key;
});

function fmt(n) {
  return (n || 0).toLocaleString('ru');
}

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
  <div class="shared-root min-h-screen bg-gray-950 text-gray-200 px-4 py-10">
    <div class="max-w-6xl mx-auto space-y-6">
      <div v-if="loading" class="space-y-4">
        <div class="h-20 rounded-2xl animate-pulse bg-gray-900/60"></div>
        <div class="h-80 rounded-2xl animate-pulse bg-gray-900/60"></div>
      </div>

      <div v-else-if="error" class="text-center py-24 text-gray-400">{{ error }}</div>

      <template v-else>
        <header class="pb-2">
          <div class="text-[11px] uppercase tracking-[0.2em] text-indigo-400/90">Публичный отчёт</div>
          <h1 class="text-3xl font-semibold tracking-tight text-gray-50 mt-2">{{ project.name }}</h1>
          <div class="text-sm text-gray-500 mt-1">{{ project.gsc_site_url || project.url }}</div>
        </header>

        <div v-if="!analysis" class="text-sm text-gray-500 text-center py-12">
          Отчёт ещё не сформирован.
        </div>

        <template v-else>
          <!-- Apple-style сегментированный переключатель вкладок -->
          <nav v-if="tabs.length > 1" class="seg" role="tablist" aria-label="Источники данных">
            <button v-for="t in tabs" :key="t.key" type="button" role="tab"
                    class="seg-item"
                    :class="[currentTab === t.key ? 'seg-item--active' : '', `seg-item--${t.accent}`]"
                    :aria-selected="currentTab === t.key"
                    @click="activeTab = t.key">{{ t.label }}</button>
          </nav>

          <!-- ===================== GOOGLE ===================== -->
          <div v-show="currentTab === 'google'" class="space-y-5">
            <section v-if="snap" class="panel space-y-4">
              <h2 class="panel-title text-indigo-300">График эффективности · Google</h2>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="stat">
                  <div class="stat-label">Клики</div>
                  <div class="stat-value text-indigo-300">{{ fmt(snap.totals?.clicks) }}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Показы</div>
                  <div class="stat-value text-violet-300">{{ fmt(snap.totals?.impressions) }}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">CTR</div>
                  <div class="stat-value text-emerald-300">{{ snap.totals?.ctr || 0 }}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Ср. позиция</div>
                  <div class="stat-value text-amber-300">{{ snap.totals?.position || 0 }}</div>
                </div>
              </div>
              <GscPerformanceChart v-if="snap.series?.length" :series="snap.series" />
            </section>

            <section v-if="analysis.report_markdown" class="panel space-y-3">
              <h2 class="panel-title text-indigo-300">AI-отчёт · Google</h2>
              <MarkdownView :source="analysis.report_markdown" />
            </section>

            <ActionPlanCard v-if="snap?.action_plan" :plan="snap.action_plan" />

            <CommercialInsights v-if="snap?.commercial"
                                :commercial="snap.commercial"
                                :serp-verification="snap?.serp_verification || null" />

            <AnalyticsExtras v-if="snap && (snap.period_compare || snap.breakdowns || snap.page_decay || snap.brand_split || snap.seasonality)"
                             :period-compare="snap.period_compare || null"
                             :breakdowns="snap.breakdowns || null"
                             :page-decay="snap.page_decay || null"
                             :brand-split="snap.brand_split || null"
                             :seasonality="snap.seasonality || null" />

            <TopPageInsightsCard v-if="snap?.top_page_insights" :insights="snap.top_page_insights" />
            <LinkProfileCard v-if="snap?.link_audit" :link-audit="snap.link_audit" />
            <MetaSuggestionsCard v-if="snap?.page_meta_audit" :page-meta-audit="snap.page_meta_audit" />
            <BlogTopicsCard v-if="snap?.blog_plan" :blog-plan="snap.blog_plan" />
            <EatTemplatesCard v-if="snap?.eat" :eat="snap.eat" />
            <SchemaAuditCard v-if="snap?.schema_audit" :schema-audit="snap.schema_audit" />
            <AiVisibilityCard v-if="snap?.geo_aeo" :geo-aeo="snap.geo_aeo" />
          </div>

          <!-- ===================== ЯНДЕКС ===================== -->
          <div v-show="currentTab === 'yandex'" class="space-y-5">
            <section v-if="ydx" class="panel space-y-4">
              <h2 class="panel-title text-red-300">Эффективность в Яндексе</h2>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="stat">
                  <div class="stat-label">Клики</div>
                  <div class="stat-value text-red-300">{{ fmt(ydx.totals?.clicks) }}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Показы</div>
                  <div class="stat-value text-orange-300">{{ fmt(ydx.totals?.impressions) }}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">CTR</div>
                  <div class="stat-value text-emerald-300">{{ ydx.totals?.ctr || 0 }}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Ср. позиция</div>
                  <div class="stat-value text-amber-300">{{ ydx.totals?.position || 0 }}</div>
                </div>
              </div>
              <GscPerformanceChart v-if="ydx.series?.length" :series="ydx.series" />
            </section>

            <section v-if="analysis.ydx_report_markdown" class="panel space-y-3">
              <h2 class="panel-title text-red-300">AI-отчёт · Яндекс</h2>
              <MarkdownView :source="analysis.ydx_report_markdown" />
            </section>
          </div>

          <!-- ===================== СВОДНАЯ ===================== -->
          <div v-show="currentTab === 'synthesis'" class="space-y-5">
            <section v-if="analysis.synthesis_markdown" class="panel space-y-3">
              <h2 class="panel-title text-fuchsia-300">Сводка закономерностей Google ↔ Яндекс</h2>
              <MarkdownView :source="analysis.synthesis_markdown" />
            </section>

            <RankingFactorsCard v-if="analysis.ranking_factors" :ranking-factors="analysis.ranking_factors" />
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.shared-root {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text',
    'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Сегментированный контрол в стиле Apple */
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 4px;
  border-radius: 14px;
  background: rgba(17, 18, 23, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(12px);
}
.seg-item {
  appearance: none;
  border: 0;
  cursor: pointer;
  padding: 8px 20px;
  border-radius: 11px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #9ca3af;
  background: transparent;
  transition: color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}
.seg-item:hover { color: #e5e7eb; }
.seg-item--active {
  color: #f9fafb;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
}
.seg-item--indigo.seg-item--active { box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(129,140,248,.35); }
.seg-item--red.seg-item--active    { box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(248,113,113,.35); }
.seg-item--fuchsia.seg-item--active{ box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(232,121,249,.35); }

/* Карточки-панели */
.panel {
  background: rgba(17, 18, 23, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 18px;
  padding: 20px;
}
.panel-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.stat {
  background: rgba(2, 3, 8, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 12px 14px;
}
.stat-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  margin-top: 2px;
}
</style>
