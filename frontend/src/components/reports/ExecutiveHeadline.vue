<script setup>
/**
 * ExecutiveHeadline.vue — Sprint 2 (client-first layout).
 *
 * Single-screen "что главное произошло" блок поверх отчёта. Источник —
 * deteremined `data.headline` объект, который собирает
 * backend/src/services/reports/headlineBuilder.js. Если headline пуст —
 * ничего не рендерим (silent fallback на остальной отчёт).
 *
 * Props:
 *   • headline   — объект из data.headline (или null)
 *   • viewMode   — 'analyst' | 'client' (визуальные акценты в client mode)
 *   • accent     — основной цвет акцента (берётся из проекта)
 */
import { computed } from 'vue';

const props = defineProps({
  headline: { type: Object, default: null },
  viewMode: { type: String, default: 'analyst' },
  accent:   { type: String, default: '#0a84ff' },
});

const isClient = computed(() => props.viewMode === 'client');

const show = computed(() => {
  const h = props.headline;
  if (!h || typeof h !== 'object') return false;
  return !!(h.main_kpi || h.change_summary || (h.top_achievements && h.top_achievements.length) || (h.top_risks && h.top_risks.length));
});

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('ru-RU');
}

const mainKpiDisplay = computed(() => {
  const k = props.headline?.main_kpi;
  if (!k) return null;
  return {
    label: k.label || '',
    value: fmtNum(k.value),
    unit:  k.unit || '',
    source: k.source || '',
  };
});

const deltaDisplay = computed(() => {
  const d = props.headline?.delta;
  if (!d) return null;
  return {
    direction: d.direction || 'stable',
    label:     d.label || '',
  };
});
</script>

<template>
  <section v-if="show" class="exec-headline" :class="{ 'exec-headline--client': isClient }"
           :style="{ '--accent': accent }"
           aria-label="Executive Headline">
    <div class="exec-headline__top">
      <div class="exec-headline__kpi" v-if="mainKpiDisplay">
        <div class="exec-headline__kpi-label">{{ mainKpiDisplay.label }}</div>
        <div class="exec-headline__kpi-value">
          {{ mainKpiDisplay.value }}<span v-if="mainKpiDisplay.unit" class="unit"> {{ mainKpiDisplay.unit }}</span>
        </div>
        <div v-if="mainKpiDisplay.source" class="exec-headline__kpi-src">Источник: {{ mainKpiDisplay.source }}</div>
      </div>
      <div v-if="deltaDisplay" class="exec-headline__delta"
           :class="`exec-headline__delta--${deltaDisplay.direction}`">
        <span class="arrow" aria-hidden="true">
          {{ deltaDisplay.direction === 'up' ? '▲' : deltaDisplay.direction === 'down' ? '▼' : '·' }}
        </span>
        <span class="delta-label">{{ deltaDisplay.label || '—' }}</span>
        <span class="delta-cap">vs. предыдущему периоду</span>
      </div>
    </div>

    <p v-if="headline.change_summary" class="exec-headline__summary">{{ headline.change_summary }}</p>

    <div v-if="headline.secondary_kpis && headline.secondary_kpis.length" class="exec-headline__sec">
      <div v-for="(k, i) in headline.secondary_kpis" :key="i" class="exec-headline__sec-item">
        <div class="sec-label">{{ k.label }}</div>
        <div class="sec-value">{{ k.value }}</div>
      </div>
    </div>

    <div class="exec-headline__cols">
      <div v-if="headline.top_achievements && headline.top_achievements.length" class="exec-headline__col">
        <h3 class="exec-headline__col-h">Главное достигли</h3>
        <ul>
          <li v-for="(item, i) in headline.top_achievements" :key="`a-${i}`">{{ item }}</li>
        </ul>
      </div>
      <div v-if="headline.top_risks && headline.top_risks.length" class="exec-headline__col exec-headline__col--risk">
        <h3 class="exec-headline__col-h">На что обратить внимание</h3>
        <ul>
          <li v-for="(item, i) in headline.top_risks" :key="`r-${i}`">{{ item }}</li>
        </ul>
      </div>
    </div>

    <div v-if="headline.completeness_note" class="exec-headline__note" role="note">
      ⓘ {{ headline.completeness_note }}
    </div>
  </section>
</template>

<style scoped>
.exec-headline {
  --accent: #0a84ff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, #fff) 0%, #fff 80%);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, #e6e9ee);
  border-radius: 18px;
  padding: 28px 32px;
  margin: 0 0 24px;
  box-shadow: 0 6px 24px color-mix(in srgb, var(--accent) 10%, transparent);
}
.exec-headline--client {
  padding: 36px 40px;
}
.exec-headline__top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 28px 48px;
  margin-bottom: 8px;
}
.exec-headline__kpi-label {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6b7280;
  margin-bottom: 6px;
}
.exec-headline__kpi-value {
  font-size: 56px;
  line-height: 1.05;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -1px;
}
.exec-headline__kpi-value .unit {
  font-size: 22px;
  font-weight: 500;
  color: #475569;
  margin-left: 6px;
}
.exec-headline__kpi-src {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 4px;
}
.exec-headline__delta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 15px;
  background: #f1f5f9;
  color: #475569;
}
.exec-headline__delta--up    { background: #dcfce7; color: #15803d; }
.exec-headline__delta--down  { background: #fee2e2; color: #b91c1c; }
.exec-headline__delta .delta-cap {
  font-weight: 400;
  font-size: 12px;
  color: inherit;
  opacity: 0.75;
}
.exec-headline__summary {
  font-size: 16px;
  line-height: 1.55;
  color: #0f172a;
  margin: 4px 0 18px;
}
.exec-headline__sec {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 12px 0 18px;
  border-top: 1px dashed #e2e8f0;
  border-bottom: 1px dashed #e2e8f0;
  margin-bottom: 18px;
}
.exec-headline__sec-item {
  min-width: 140px;
}
.exec-headline__sec-item .sec-label {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 2px;
}
.exec-headline__sec-item .sec-value {
  font-size: 18px;
  font-weight: 600;
  color: #0f172a;
}
.exec-headline__cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}
@media (max-width: 720px) {
  .exec-headline__cols { grid-template-columns: 1fr; }
  .exec-headline__kpi-value { font-size: 40px; }
  .exec-headline { padding: 20px; }
}
.exec-headline__col-h {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6b7280;
  margin: 0 0 8px;
}
.exec-headline__col ul {
  list-style: disc;
  padding-left: 20px;
  margin: 0;
  color: #1f2937;
}
.exec-headline__col li {
  margin-bottom: 4px;
  line-height: 1.45;
}
.exec-headline__col--risk ul {
  color: #7c2d12;
}
.exec-headline__note {
  margin-top: 16px;
  font-size: 13px;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fef3c7;
  border-radius: 8px;
  padding: 8px 12px;
}
</style>
