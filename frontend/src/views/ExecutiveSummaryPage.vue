<script setup>
/**
 * ExecutiveSummaryPage.vue (PR-4 эпика premium-ui-and-client-mode-implementation).
 *
 * Главный дашборд проекта (Executive Summary). Использует PremiumLayout
 * (PR-3) + KPICardGrid (8 карточек) + TrafficChart (ECharts).
 *
 * Источник данных:
 *   • `snapshot.headline_kpi` — PR-1: last_complete_month / prev_complete_month /
 *     partial_month; karточки строятся ТОЛЬКО по полным месяцам.
 *   • `snapshot.monthly_periods` — массив помесячных totals (clicks /
 *     impressions / ctr / position) для главного графика.
 *   • `/api/projects/:id/freshness` — FreshnessBadge в шапке.
 *
 * Если у проекта ещё нет анализа (snapshot=null) — показываем зашёрсенный
 * скелетон и кнопку «Запустить AI-анализ», которая дёргает существующий
 * endpoint /projects/:id/analyze (через projectsStore.startAnalysis).
 *
 * View-mode (Аналитик/Клиент, PR-2) меняет только панель «Сырые числа»
 * под графиком: в Client Mode прячем технические totals и position
 * (показываем только клики+рост), чтобы клиент не видел деталей.
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PremiumLayout from '../components/PremiumLayout.vue';
import KPICardGrid from '../components/KPICardGrid.vue';
import TrafficChart from '../components/TrafficChart.vue';
import FreshnessBadge from '../components/FreshnessBadge.vue';
import WorksTimeline from '../components/WorksTimeline.vue';
import PrintableReport from '../components/PrintableReport.vue';
import { useProjectsStore } from '../stores/projects.js';
import { useViewModeStore } from '../stores/viewMode.js';
import { exportNodeToPdf, prepareLogoForExport, nextFrame } from '../utils/pdfExporter.js';

const route = useRoute();
const router = useRouter();
const projectsStore = useProjectsStore();
const viewMode = useViewModeStore();

const loading = ref(true);
const error = ref(null);
const project = ref(null);
const analysis = ref(null);
const freshness = ref([]);
const works = ref([]);
const worksLoading = ref(false);
const startingAnalysis = ref(false);

// PR-6: ссылка на off-screen printable layout (PrintableReport) и
// флаг загрузки во время рендера PDF.
const printableRef = ref(null);
const exporting = ref(false);
const logoDataUrl = ref('');

const projectId = computed(() => route.params.id);

const snapshot = computed(() => analysis.value?.gsc_snapshot || null);
const headline = computed(() => snapshot.value?.headline_kpi || null);
const last = computed(() => headline.value?.last_complete_month?.totals || null);
const prev = computed(() => headline.value?.prev_complete_month?.totals || null);

const lastMonthLabel = computed(() => headline.value?.last_complete_month?.key || '—');

const cards = computed(() => {
  if (!last.value) return [];
  const arr = [
    {
      key: 'clicks',
      title: 'Клики',
      icon: '🖱️',
      value: last.value.clicks,
      previous: prev.value?.clicks ?? null,
      format: 'integer',
      hint: `за ${lastMonthLabel.value}`,
    },
    {
      key: 'impressions',
      title: 'Показы',
      icon: '👁️',
      value: last.value.impressions,
      previous: prev.value?.impressions ?? null,
      format: 'integer',
      hint: `за ${lastMonthLabel.value}`,
    },
    {
      key: 'ctr',
      title: 'CTR',
      icon: '🎯',
      value: last.value.ctr,
      previous: prev.value?.ctr ?? null,
      format: 'percent',
      hint: 'средневзвешенный CTR',
    },
    {
      key: 'position',
      title: 'Средняя позиция',
      icon: '📍',
      value: last.value.position,
      previous: prev.value?.position ?? null,
      format: 'position',
      lowerIsBetter: true,
      hint: 'меньше — лучше',
    },
  ];

  // В режиме «Аналитик» показываем расширенный блок — производные метрики из
  // monthly_periods (среднее за 3 месяца) + индикаторы из data_source_health.
  if (viewMode.isAnalyst) {
    const months = Array.isArray(snapshot.value?.monthly_periods)
      ? snapshot.value.monthly_periods.filter((m) => m && m.complete).slice(-3)
      : [];
    const sum = (k) => months.reduce((acc, m) => acc + Number(m?.totals?.[k] || 0), 0);
    const cnt = months.length || 1;
    arr.push(
      {
        key: 'clicks_3m_avg',
        title: 'Клики · ср. 3м',
        icon: '📈',
        value: sum('clicks') / cnt,
        format: 'integer',
        hint: 'среднее за 3 полных месяца',
      },
      {
        key: 'impressions_3m_avg',
        title: 'Показы · ср. 3м',
        icon: '📊',
        value: sum('impressions') / cnt,
        format: 'integer',
        hint: 'среднее за 3 полных месяца',
      },
      {
        key: 'sources_ok',
        title: 'Источники свежие',
        icon: '🟢',
        value: freshness.value.filter((s) => s.status === 'ok').length,
        format: 'integer',
        hint: `из ${freshness.value.length || 0}`,
      },
      {
        key: 'completeness',
        title: 'Полнота месяца',
        icon: '🗓️',
        value: headline.value?.partial_month ? 0 : 1,
        format: 'percent',
        hint: headline.value?.partial_month ? 'текущий месяц неполный' : 'данные за месяц готовы',
      },
    );
  } else {
    // Client Mode: даём прирост клик-показов как «бизнесовый» KPI и без
    // технических полей вроде position/CTR-distribution.
    const growth = (() => {
      const a = Number(last.value.clicks || 0);
      const b = Number(prev.value?.clicks || 0);
      if (!b) return null;
      return (a - b) / b;
    })();
    arr.push(
      {
        key: 'growth',
        title: 'Рост клик-трафика',
        icon: '🚀',
        value: growth,
        format: 'percent',
        hint: 'месяц к месяцу',
      },
    );
  }

  return arr;
});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const id = projectId.value;
    const proj = await projectsStore.getProject(id);
    project.value = proj?.project || proj || null;

    const fresh = await projectsStore.getFreshness(id).catch(() => ({ sources: [] }));
    freshness.value = Array.isArray(fresh?.sources) ? fresh.sources : [];

    const analyses = await projectsStore.listAnalyses(id).catch(() => []);
    if (analyses && analyses.length) {
      const latest = analyses[0];
      analysis.value = await projectsStore.getAnalysis(id, latest.id).catch(() => null);
    } else {
      analysis.value = null;
    }

    // Works Log (PR-5) — параллельно после остального, чтобы не блокировать
    // отрисовку KPI. Backend возвращает уже отсанитизированный список
    // в соответствии с режимом X-Client-Mode (axios-перехватчик в api.js).
    worksLoading.value = true;
    try {
      const resp = await projectsStore.listWorks(id);
      works.value = Array.isArray(resp?.works) ? resp.works : [];
    } catch (_) {
      works.value = [];
    } finally {
      worksLoading.value = false;
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || 'Не удалось загрузить дашборд';
  } finally {
    loading.value = false;
  }
}

async function startAnalysis() {
  if (startingAnalysis.value) return;
  startingAnalysis.value = true;
  try {
    await projectsStore.startAnalysis(projectId.value, {});
    // Polling — простая стратегия: перезагрузим через 5 секунд несколько раз.
    setTimeout(() => load(), 5000);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || 'Не удалось запустить анализ';
  } finally {
    startingAnalysis.value = false;
  }
}

onMounted(load);

/**
 * PR-6: экспорт текущего дашборда в PDF через html2canvas + jsPDF.
 * Снимок снимаем не с самого дашборда (тёмный фон, ECharts canvas-внутри
 * canvas — html2canvas плохо это сшивает), а с печатного off-screen
 * layout `PrintableReport` (белый фон, table-формат динамики). Логотип
 * проекта конвертируем в base64 заранее — обходит CORS и не даёт обрезки
 * (`object-fit:contain` в .pr-logo-frame).
 */
async function exportPdf() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    // Берём URL логотипа из проекта (поле logo_url); если такого нет —
    // оставляем заглушку (заглавная буква).
    const rawLogo = project.value?.logo_url || project.value?.logo || '';
    logoDataUrl.value = (await prepareLogoForExport(rawLogo)) || '';

    // Ждём, пока Vue перерисует PrintableReport со свежим логотипом.
    await nextFrame();
    await nextFrame();

    const node = printableRef.value;
    if (!node) throw new Error('PrintableReport не смонтирован');
    const projName = project.value?.name || project.value?.site_url || 'project';
    const safeName = String(projName).replace(/[^a-zA-Zа-яА-Я0-9-_]+/g, '_').slice(0, 60);
    await exportNodeToPdf(node, {
      filename: `executive-summary_${safeName}.pdf`,
      scale: 2,
      backgroundColor: '#ffffff',
    });
  } catch (e) {
    error.value = e?.message || 'Не удалось сформировать PDF';
  } finally {
    exporting.value = false;
  }
}

// Карточки для печатной версии (повторяем shape из `cards`, но с готовыми
// delta — берём из computedDelta KPICard было бы громоздко, пересчитываем
// здесь же).
const printableCards = computed(() => cards.value.map((c) => {
  const cur = Number(c.value);
  const prv = Number(c.previous);
  let delta = c.delta != null ? Number(c.delta) : null;
  if (delta === null && Number.isFinite(cur) && Number.isFinite(prv) && prv !== 0) {
    delta = (cur - prv) / Math.abs(prv);
  }
  return { ...c, delta };
}));
</script>

<template>
  <PremiumLayout>
    <template #title>
      <div class="flex flex-col">
        <span class="text-xs uppercase tracking-wider text-gray-500">Executive Summary</span>
        <span class="text-sm font-semibold text-gray-100 truncate">
          {{ project?.name || project?.site_url || 'Проект' }}
        </span>
      </div>
    </template>

    <template #freshness>
      <FreshnessBadge
        v-for="src in freshness"
        :key="src.source"
        :freshness="src"
        :compact="true"
      />
      <!-- PR-6: «Скачать PDF» — экспортирует off-screen PrintableReport
           через html2canvas + jsPDF (utils/pdfExporter.js). -->
      <button
        type="button"
        class="ml-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand-indigo text-white hover:bg-brand-dark disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        :disabled="exporting || loading"
        @click="exportPdf"
        data-testid="export-pdf"
      >
        <span v-if="exporting">Формируем PDF…</span>
        <span v-else>Скачать PDF</span>
      </button>
    </template>

    <div class="p-6 space-y-6">
      <div v-if="error" class="rounded-lg border border-status-danger/40 bg-status-danger/10 px-4 py-3 text-sm text-status-danger">
        {{ error }}
      </div>

      <!-- Empty state — нет анализа -->
      <div
        v-if="!loading && !headline"
        class="rounded-xl border border-dashed border-surface-muted bg-surface-raised p-10 text-center"
      >
        <div class="text-4xl mb-3" aria-hidden="true">📊</div>
        <h2 class="text-lg font-semibold text-gray-100">Executive Summary ещё не построен</h2>
        <p class="mt-1 text-sm text-gray-400 max-w-md mx-auto">
          Запустите AI-анализ — мы соберём KPI за последние полные месяцы из подключённых
          источников (GSC, Яндекс.Вебмастер). Расчёт идёт несколько минут.
        </p>
        <button
          type="button"
          class="btn-primary mt-5"
          :disabled="startingAnalysis"
          @click="startAnalysis"
        >
          {{ startingAnalysis ? 'Запускаем…' : 'Запустить AI-анализ' }}
        </button>
        <p class="mt-3 text-xs text-gray-500">
          Или перейдите на
          <button type="button" class="underline hover:text-gray-300" @click="router.push(`/projects/${projectId}`)">страницу проекта</button>
          для тонкой настройки.
        </p>
      </div>

      <!-- KPI grid -->
      <section v-if="loading || headline" aria-labelledby="kpi-heading" class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h2 id="kpi-heading" class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Ключевые показатели
          </h2>
          <span class="text-xs text-gray-500">
            <template v-if="lastMonthLabel !== '—'">Полный месяц: {{ lastMonthLabel }}</template>
          </span>
        </div>
        <KPICardGrid :cards="cards" :loading="loading" />
      </section>

      <!-- Traffic chart -->
      <section v-if="loading || headline" aria-labelledby="chart-heading" class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h2 id="chart-heading" class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Динамика трафика
          </h2>
          <span class="text-xs text-gray-500">только полные месяцы</span>
        </div>
        <TrafficChart :monthly="snapshot?.monthly_periods || []" height="340px" />
      </section>

      <!-- Works Log (PR-5) — таймлайн работ SEO-специалиста.
           Backend (worksService) уже отрезал technical-поля в Client Mode. -->
      <section aria-labelledby="works-heading" class="space-y-3">
        <div class="flex items-baseline justify-between">
          <h2 id="works-heading" class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Список работ
          </h2>
          <span class="text-xs text-gray-500">
            {{ viewMode.isClient ? 'Что мы делали для роста проекта' : 'Журнал SEO-специалиста' }}
          </span>
        </div>
        <WorksTimeline :works="works" :mode="viewMode.mode" :loading="worksLoading" />
      </section>
    </div>

    <!--
      PR-6: off-screen printable layout. Расположен за пределами viewport
      (left: -10000px), но в DOM, так что html2canvas может его снять.
      Не aria-hidden — потому что внутри есть смысловое содержимое,
      но для AT он отдалён, и пользователь его не видит.
    -->
    <div
      aria-hidden="true"
      style="position: fixed; left: -10000px; top: 0; pointer-events: none;"
    >
      <PrintableReport
        ref="printableRef"
        :project-name="project?.name || project?.site_url || 'Проект'"
        :period-label="lastMonthLabel !== '—' ? `Полный месяц: ${lastMonthLabel}` : ''"
        :generated-at="new Date().toISOString()"
        :logo-data-url="logoDataUrl"
        :client-name="project?.client_name || ''"
        :kpi-cards="printableCards"
        :monthly="snapshot?.monthly_periods || []"
        :works="works"
        :mode="viewMode.mode"
      />
    </div>
  </PremiumLayout>
</template>
