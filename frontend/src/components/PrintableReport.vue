<script setup>
/**
 * PrintableReport.vue (PR-6 эпика premium-ui-and-client-mode-implementation).
 *
 * Печатный layout премиум-отчёта — белый фон, тёмный текст, шрифт Inter,
 * tabular-nums для всех числовых ячеек. Используется как off-screen-узел
 * для html2canvas/jsPDF (`utils/pdfExporter.js`).
 *
 * Контракт ТЗ §6.6:
 *   • Контейнер логотипа: object-fit: contain + фиксированная высота, чтобы
 *     не было обрезки при экспорте.
 *   • Логотип должен приходить как `logoDataUrl` (data:URL, base64),
 *     полученный из `prepareLogoForExport()` — иначе будут CORS-проблемы
 *     с html2canvas (`useCORS: true` помогает только частично).
 *
 * Props (полностью статичный input — никакого fetch внутри):
 *   • projectName, periodLabel, generatedAt — шапка.
 *   • logoDataUrl   — заранее конвертированный логотип (`data:image/...`).
 *   • clientName    — название клиента под логотипом (для брендинга).
 *   • kpiCards      — массив { title, value, format, delta, hint } —
 *                     ровно то, что строит ExecutiveSummary.
 *   • monthly       — `monthly_periods` (PR-1) для табличного представления
 *                     динамики (график в PDF не дублируется как ECharts —
 *                     html2canvas снимет его как картинку с самой страницы,
 *                     если экспортируется DOM дашборда; здесь — отдельный
 *                     текстовый блок-fallback на случай печати отдельной
 *                     страницы отчёта).
 *   • works         — массив project_works (уже отсанитизированный под mode).
 *   • mode          — 'analyst' | 'client'.
 */
import { computed } from 'vue';

const props = defineProps({
  projectName:   { type: String, default: '—' },
  periodLabel:   { type: String, default: '' },
  generatedAt:   { type: String, default: () => new Date().toISOString() },
  logoDataUrl:   { type: String, default: '' },
  clientName:    { type: String, default: '' },
  kpiCards:      { type: Array, default: () => [] },
  monthly:       { type: Array, default: () => [] },
  works:         { type: Array, default: () => [] },
  mode:          { type: String, default: 'analyst' },
});

const generatedHuman = computed(() => {
  const d = new Date(props.generatedAt);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
});

const completeMonthly = computed(() =>
  (Array.isArray(props.monthly) ? props.monthly : []).filter((m) => m && m.complete),
);

function fmtNumber(v, decimals = 0) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

function fmtCard(card) {
  const v = Number(card.value);
  if (!Number.isFinite(v)) return '—';
  switch (card.format) {
    case 'percent':  return fmtNumber(Math.abs(v) <= 1 ? v * 100 : v, 2) + ' %';
    case 'decimal':  return fmtNumber(v, 2);
    case 'position': return fmtNumber(v, 1);
    default:         return fmtNumber(v, 0);
  }
}

function fmtDelta(delta, lowerIsBetter) {
  if (delta === null || delta === undefined) return '';
  const pct = Number(delta) * 100;
  if (!Number.isFinite(pct)) return '';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct).toFixed(1)}% ${lowerIsBetter ? (pct < 0 ? '▲' : '▼') : (pct > 0 ? '▲' : '▼')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ru-RU') : '—';
}
</script>

<template>
  <article class="printable-report">
    <!-- Шапка с логотипом -->
    <header class="pr-head">
      <!--
        PR-6: object-fit: contain + фиксированная высота 64px. Контейнер
        ограничивает изображение, а сам логотип не обрезается. logoDataUrl
        — всегда data:URL (см. prepareLogoForExport), благодаря чему
        html2canvas рендерит логотип без CORS-проблем.
      -->
      <div class="pr-logo-frame" aria-hidden="true">
        <img
          v-if="logoDataUrl"
          :src="logoDataUrl"
          alt=""
          class="pr-logo-img"
        />
        <div v-else class="pr-logo-placeholder">{{ (clientName || projectName || '?').slice(0, 1).toUpperCase() }}</div>
      </div>
      <div class="pr-head-info">
        <div class="pr-eyebrow">Premium Executive Summary</div>
        <h1 class="pr-title">{{ projectName }}</h1>
        <div class="pr-sub">
          <span v-if="periodLabel">{{ periodLabel }}</span>
          <span v-if="periodLabel" class="pr-dot">•</span>
          <span>Сформировано: {{ generatedHuman }}</span>
        </div>
      </div>
    </header>

    <!-- KPI -->
    <section class="pr-section">
      <h2 class="pr-h2">Ключевые показатели</h2>
      <div class="pr-grid">
        <div v-for="(card, idx) in kpiCards" :key="card.key || idx" class="pr-kpi">
          <div class="pr-kpi-title">{{ card.title }}</div>
          <div class="pr-kpi-value">{{ fmtCard(card) }}</div>
          <div class="pr-kpi-meta">
            <span v-if="card.delta != null" class="pr-kpi-delta">{{ fmtDelta(card.delta, card.lowerIsBetter) }}</span>
            <span v-if="card.hint" class="pr-kpi-hint">{{ card.hint }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Динамика по месяцам -->
    <section v-if="completeMonthly.length" class="pr-section">
      <h2 class="pr-h2">Динамика по полным месяцам</h2>
      <table class="pr-table">
        <thead>
          <tr>
            <th>Месяц</th>
            <th>Клики</th>
            <th>Показы</th>
            <th>CTR</th>
            <th>Позиция</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in completeMonthly" :key="m.key">
            <td>{{ m.key }}</td>
            <td>{{ fmtNumber(m?.totals?.clicks) }}</td>
            <td>{{ fmtNumber(m?.totals?.impressions) }}</td>
            <td>{{ fmtNumber((Number(m?.totals?.ctr) <= 1 ? m?.totals?.ctr * 100 : m?.totals?.ctr), 2) }} %</td>
            <td>{{ fmtNumber(m?.totals?.position, 1) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Журнал работ -->
    <section v-if="works.length" class="pr-section">
      <h2 class="pr-h2">{{ mode === 'client' ? 'Что мы сделали' : 'Журнал работ' }}</h2>
      <ul class="pr-works">
        <li v-for="w in works" :key="w.id" class="pr-work">
          <div class="pr-work-row">
            <span class="pr-work-date">{{ fmtDate(w.performed_at) }}</span>
            <span class="pr-work-title">{{ w.title }}</span>
          </div>
          <p v-if="mode === 'client'" class="pr-work-body">{{ w.client_summary || w.title }}</p>
          <template v-else>
            <p v-if="w.client_summary" class="pr-work-body"><b>Клиенту:</b> {{ w.client_summary }}</p>
            <p v-if="w.description" class="pr-work-body">{{ w.description }}</p>
          </template>
        </li>
      </ul>
    </section>

    <footer class="pr-footer">
      <span>{{ clientName || projectName }}</span>
      <span>SEO Genius • {{ generatedHuman }}</span>
    </footer>
  </article>
</template>

<style scoped>
.printable-report {
  /* A4-friendly ширина 794px @ 96 DPI; html2canvas снимет в scale=2 для Retina. */
  width: 794px;
  background: #ffffff;
  color: #0f172a;
  font-family: Inter, system-ui, sans-serif;
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: 'tnum' 1, 'lnum' 1;
  padding: 40px 44px;
  box-sizing: border-box;
}

.pr-head {
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 2px solid #6366f1;
  padding-bottom: 18px;
  margin-bottom: 28px;
}

.pr-logo-frame {
  width: 96px;
  height: 64px;
  flex: 0 0 auto;
  border-radius: 10px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.pr-logo-img {
  max-width: 100%;
  max-height: 100%;
  /*
   * Ключевое требование PR-6: object-fit:contain не даёт логотипу обрезаться
   * при экспорте независимо от пропорций исходного файла (квадратный/широкий/
   * SVG). Сочетается с max-width/max-height — изображение вписывается, а не
   * растягивается.
   */
  object-fit: contain;
  display: block;
}

.pr-logo-placeholder {
  font-weight: 700;
  font-size: 28px;
  color: #6366f1;
}

.pr-head-info { min-width: 0; }
.pr-eyebrow {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #64748b;
  font-weight: 600;
}
.pr-title {
  margin: 4px 0 4px;
  font-size: 26px;
  font-weight: 700;
  color: #0f172a;
}
.pr-sub { font-size: 12px; color: #475569; }
.pr-dot { margin: 0 6px; }

.pr-section { margin-bottom: 28px; }
.pr-h2 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #334155;
  margin: 0 0 12px;
  font-weight: 600;
}

.pr-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.pr-kpi {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  background: #f8fafc;
}
.pr-kpi-title { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.pr-kpi-value { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 4px; }
.pr-kpi-meta  { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 11px; }
.pr-kpi-delta { color: #10b981; font-weight: 600; }
.pr-kpi-hint  { color: #94a3b8; }

.pr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pr-table th,
.pr-table td {
  border-bottom: 1px solid #e2e8f0;
  padding: 8px 10px;
  text-align: right;
}
.pr-table th:first-child,
.pr-table td:first-child {
  text-align: left;
  font-weight: 600;
  color: #1e293b;
}
.pr-table th { color: #64748b; font-weight: 600; background: #f8fafc; }

.pr-works { list-style: none; padding: 0; margin: 0; }
.pr-work  { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
.pr-work:last-child { border-bottom: 0; }
.pr-work-row { display: flex; gap: 12px; align-items: baseline; font-size: 12px; }
.pr-work-date  { color: #64748b; min-width: 90px; }
.pr-work-title { font-weight: 600; color: #0f172a; font-size: 13px; }
.pr-work-body  { margin: 4px 0 0; color: #475569; font-size: 12px; line-height: 1.5; }

.pr-footer {
  margin-top: 36px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #64748b;
}
</style>
