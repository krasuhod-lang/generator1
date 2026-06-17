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
import StrategyDiagram from '../components/StrategyDiagram.vue';
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
const copyToast = ref('');

const snap = computed(() => analysis.value?.gsc_snapshot || null);
const ydx = computed(() => analysis.value?.ydx_snapshot || null);

// ── Фильтрация серии по выбранному диапазону дат ──────────────────────────
const dateFrom = ref('');
const dateTo = ref('');

function _filterSeries(series) {
  if (!Array.isArray(series) || !series.length) return series;
  const from = dateFrom.value;
  const to = dateTo.value;
  if (!from && !to) return series;
  return series.filter((p) => {
    const d = String(p.date || '').slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

const filteredGscSeries = computed(() => _filterSeries(snap.value?.series));
const filteredYdxSeries = computed(() => _filterSeries(ydx.value?.series));

// Пресеты периодов (клиентская фильтрация на основе уже загруженных данных)
const datePresetKey = ref('all');
const DATE_PRESETS = [
  { key: 'all', label: 'Всё время' },
  { key: '7d', label: '7 дней', days: 7 },
  { key: '28d', label: '28 дней', days: 28 },
  { key: '3m', label: '3 месяца', days: 90 },
  { key: '6m', label: '6 месяцев', days: 180 },
];

function setDatePreset(key) {
  datePresetKey.value = key;
  if (key === 'all') {
    dateFrom.value = '';
    dateTo.value = '';
    return;
  }
  const preset = DATE_PRESETS.find((p) => p.key === key);
  if (!preset || !preset.days) return;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - preset.days);
  dateTo.value = to.toISOString().slice(0, 10);
  dateFrom.value = from.toISOString().slice(0, 10);
}

function applyCustomDate() {
  if (dateFrom.value && dateTo.value) {
    datePresetKey.value = 'custom';
  }
}

// ── Копирование ссылки ────────────────────────────────────────────────────
async function copyCurrentUrl() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(window.location.href);
    } else {
      const ta = document.createElement('textarea');
      ta.value = window.location.href;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copyToast.value = 'Ссылка скопирована!';
  } catch (_) {
    copyToast.value = 'Не удалось скопировать';
  }
  setTimeout(() => { copyToast.value = ''; }, 2500);
}

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

// Под-вкладки внутри «Google» — зеркалят личный кабинет (ProjectDetailPage),
// чтобы клиент видел те же разделы по табам, а не одной длинной простынёй.
const gscSubTab = ref('report');
const gscSubTabs = computed(() => {
  const s = snap.value || {};
  return [
    { key: 'report', label: 'Отчёт ИИ', show: !!analysis.value?.report_markdown },
    { key: 'strategy', label: 'Стратегия', show: !!(s.strategy_map && s.strategy_map.available) },
    { key: 'actionplan', label: 'План действий', show: !!s.action_plan },
    { key: 'dynamics', label: 'Динамика', show: !!(s.period_compare || s.breakdowns || s.page_decay || s.brand_split || s.seasonality) },
    { key: 'commercial', label: 'Коммерция', show: !!s.commercial },
    { key: 'toppages', label: 'Топ-страницы', show: !!s.top_page_insights },
    { key: 'links', label: 'Ссылки', show: !!s.link_audit },
    { key: 'meta', label: 'Мета', show: !!s.page_meta_audit },
    { key: 'blog', label: 'Блог', show: !!s.blog_plan },
    { key: 'eat', label: 'E-E-A-T', show: !!s.eat },
    { key: 'schema', label: 'Микроразметка', show: !!s.schema_audit },
    { key: 'geo', label: 'GEO/AEO', show: !!s.geo_aeo },
  ].filter((t) => t.show);
});
const activeGscSubTab = computed(() => {
  const list = gscSubTabs.value;
  if (!list.length) return '';
  return list.some((t) => t.key === gscSubTab.value) ? gscSubTab.value : list[0].key;
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
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div class="text-[11px] uppercase tracking-[0.2em] text-indigo-400/90">Публичный отчёт</div>
              <h1 class="text-3xl font-semibold tracking-tight text-gray-50 mt-2">{{ project.name }}</h1>
              <div class="text-sm text-gray-500 mt-1">{{ project.gsc_site_url || project.url }}</div>
            </div>
            <button class="copy-btn" @click="copyCurrentUrl" title="Скопировать ссылку">
              📋 Скопировать ссылку
            </button>
          </div>
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
            <!-- Панель выбора периода -->
            <div class="date-controls">
              <div class="flex flex-wrap gap-1.5 items-center">
                <span class="text-[11px] uppercase text-gray-500 mr-1">Период:</span>
                <button v-for="p in DATE_PRESETS" :key="p.key" type="button"
                        class="date-btn"
                        :class="datePresetKey === p.key ? 'date-btn--active' : ''"
                        @click="setDatePreset(p.key)">{{ p.label }}</button>
                <div class="flex items-center gap-1 ml-2">
                  <input type="date" v-model="dateFrom" class="date-input" />
                  <span class="text-gray-600 text-xs">—</span>
                  <input type="date" v-model="dateTo" class="date-input" />
                  <button class="date-btn" :class="datePresetKey === 'custom' ? 'date-btn--active' : ''"
                          @click="applyCustomDate">OK</button>
                </div>
              </div>
            </div>

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
              <GscPerformanceChart v-if="filteredGscSeries?.length" :series="filteredGscSeries" />
            </section>

            <!-- Под-вкладки аналитики (как в личном кабинете) -->
            <nav v-if="gscSubTabs.length" class="flex flex-wrap gap-1 border-b border-gray-800">
              <button v-for="t in gscSubTabs" :key="t.key" type="button"
                      class="px-3 py-1.5 text-xs font-medium -mb-px border-b-2 transition-colors"
                      :class="activeGscSubTab === t.key ? 'border-indigo-500 text-indigo-200' : 'border-transparent text-gray-400 hover:text-gray-200'"
                      @click="gscSubTab = t.key">{{ t.label }}</button>
            </nav>

            <div v-show="activeGscSubTab === 'report'">
              <section v-if="analysis.report_markdown" class="panel space-y-3">
                <h2 class="panel-title text-indigo-300">AI-отчёт · Google</h2>
                <MarkdownView :source="analysis.report_markdown" />
              </section>
            </div>

            <div v-show="activeGscSubTab === 'strategy'">
              <StrategyDiagram v-if="snap?.strategy_map && snap.strategy_map.available" :strategy-map="snap.strategy_map" />
            </div>

            <div v-show="activeGscSubTab === 'actionplan'">
              <ActionPlanCard v-if="snap?.action_plan" :plan="snap.action_plan" />
            </div>

            <div v-show="activeGscSubTab === 'dynamics'">
              <AnalyticsExtras v-if="snap && (snap.period_compare || snap.breakdowns || snap.page_decay || snap.brand_split || snap.seasonality)"
                               :period-compare="snap.period_compare || null"
                               :breakdowns="snap.breakdowns || null"
                               :page-decay="snap.page_decay || null"
                               :brand-split="snap.brand_split || null"
                               :seasonality="snap.seasonality || null" />
            </div>

            <div v-show="activeGscSubTab === 'commercial'">
              <CommercialInsights v-if="snap?.commercial"
                                  :commercial="snap.commercial"
                                  :serp-verification="snap?.serp_verification || null" />
            </div>

            <div v-show="activeGscSubTab === 'toppages'">
              <TopPageInsightsCard v-if="snap?.top_page_insights" :insights="snap.top_page_insights" />
            </div>

            <div v-show="activeGscSubTab === 'links'">
              <LinkProfileCard v-if="snap?.link_audit" :link-audit="snap.link_audit" />
            </div>

            <div v-show="activeGscSubTab === 'meta'">
              <MetaSuggestionsCard v-if="snap?.page_meta_audit" :page-meta-audit="snap.page_meta_audit" />
            </div>

            <div v-show="activeGscSubTab === 'blog'">
              <BlogTopicsCard v-if="snap?.blog_plan" :blog-plan="snap.blog_plan" />
            </div>

            <div v-show="activeGscSubTab === 'eat'">
              <EatTemplatesCard v-if="snap?.eat" :eat="snap.eat" />
            </div>

            <div v-show="activeGscSubTab === 'schema'">
              <SchemaAuditCard v-if="snap?.schema_audit" :schema-audit="snap.schema_audit" />
            </div>

            <div v-show="activeGscSubTab === 'geo'">
              <AiVisibilityCard v-if="snap?.geo_aeo" :geo-aeo="snap.geo_aeo" />
            </div>
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
              <GscPerformanceChart v-if="filteredYdxSeries?.length" :series="filteredYdxSeries" />
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

      <!-- Toast для копирования -->
      <transition name="fade">
        <div v-if="copyToast"
             class="fixed bottom-6 right-6 bg-gray-900 border border-indigo-700 text-indigo-200 px-4 py-2 rounded-lg shadow-lg text-sm z-50">
          {{ copyToast }}
        </div>
      </transition>
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

/* Кнопка копирования ссылки */
.copy-btn {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: #d1d5db;
  font-size: 13px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 11px;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}
.copy-btn:hover {
  background: rgba(255, 255, 255, 0.10);
  color: #f9fafb;
  border-color: rgba(129, 140, 248, 0.4);
}

/* Панель фильтрации по дате */
.date-controls {
  background: rgba(17, 18, 23, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 14px;
  padding: 12px 16px;
}
.date-btn {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: #9ca3af;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
}
.date-btn:hover { color: #e5e7eb; background: rgba(255, 255, 255, 0.05); }
.date-btn--active {
  color: #f9fafb;
  background: rgba(99, 102, 241, 0.22);
  border-color: rgba(129, 140, 248, 0.45);
}
.date-input {
  background: rgba(2, 3, 8, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: #d1d5db;
  font-size: 12px;
  padding: 4px 8px;
}
.date-input:focus {
  outline: none;
  border-color: rgba(129, 140, 248, 0.5);
}

/* Toast анимация */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
