<script setup>
/**
 * StrategyDiagram — визуальная схема стратегии (ТЗ п.5): «понятная по
 * стратегии — что сделать, чтобы достигнуть наилучших позиций и лучших
 * конверсий». Рисует связанную диаграмму из 5 этапов воронки работ
 * (Фундамент → Контент → SERP/CTR → Доверие → Авторитет → KPI).
 * Данные приходят из gsc_snapshot.strategy_map
 * (backend/src/services/projects/strategyMap.js).
 */
import { computed } from 'vue';

const props = defineProps({
  strategyMap: { type: Object, default: null },
});

const available = computed(() => props.strategyMap && props.strategyMap.available);
const stages = computed(() => (props.strategyMap && props.strategyMap.stages) || []);
const kpis = computed(() => (props.strategyMap && props.strategyMap.kpis) || []);
const goal = computed(() => (props.strategyMap && props.strategyMap.goal) || '');
const score = computed(() => (props.strategyMap ? props.strategyMap.score : null));

const STATUS_META = {
  critical: { label: 'Критично', dot: '#ff6b6b', ring: 'rgba(255,107,107,0.35)', tint: 'rgba(255,107,107,0.08)' },
  gap: { label: 'Зона роста', dot: '#ffb454', ring: 'rgba(255,180,84,0.32)', tint: 'rgba(255,180,84,0.07)' },
  ok: { label: 'В норме', dot: '#34d399', ring: 'rgba(52,211,153,0.32)', tint: 'rgba(52,211,153,0.06)' },
};
function meta(s) { return STATUS_META[s] || STATUS_META.ok; }
</script>

<template>
  <section v-if="available" class="strat card">
    <header class="strat-head">
      <div>
        <h2 class="strat-title">Схема стратегии роста</h2>
        <p class="strat-goal">Цель: {{ goal }}</p>
      </div>
      <div v-if="score != null" class="strat-score">
        <span class="strat-score-num">{{ score }}</span>
        <span class="strat-score-den">/100 готовность</span>
      </div>
    </header>

    <!-- Связанная диаграмма этапов -->
    <div class="flow">
      <template v-for="(s, i) in stages" :key="s.id">
        <div class="node" :style="{ borderColor: meta(s.status).ring, background: meta(s.status).tint }">
          <div class="node-step">
            <span class="node-dot" :style="{ background: meta(s.status).dot }"></span>
            Этап {{ s.step }}
          </div>
          <div class="node-title">{{ s.title }}</div>
          <div class="node-sub">{{ s.subtitle }}</div>
          <div class="node-status" :style="{ color: meta(s.status).dot }">{{ meta(s.status).label }}</div>
          <ul v-if="s.actions.length" class="node-actions">
            <li v-for="(a, ai) in s.actions" :key="ai">
              <span class="act-dot" :style="{ background: meta(a.status).dot }"></span>{{ a.action }}
            </li>
          </ul>
          <div v-else class="node-clean">Зон роста не выявлено</div>
          <div class="node-outcome">→ {{ s.outcome }}</div>
        </div>
        <div v-if="i < stages.length - 1" class="connector" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12h12M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </template>
    </div>

    <!-- KPI -->
    <div v-if="kpis.length" class="kpis">
      <div class="kpis-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5v12M7 13l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="kpi-row">
        <div v-for="k in kpis" :key="k.key" class="kpi">
          <div class="kpi-label">{{ k.label }}</div>
          <div class="kpi-target">{{ k.target }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.strat {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
}
.strat-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 20px;
}
.strat-title {
  font-size: 18px; font-weight: 600; letter-spacing: -0.02em; color: #f5f5f7; margin: 0;
}
.strat-goal { font-size: 13px; color: #98989d; margin: 4px 0 0; }
.strat-score { text-align: right; white-space: nowrap; }
.strat-score-num { font-size: 28px; font-weight: 700; color: #f5f5f7; letter-spacing: -0.03em; }
.strat-score-den { font-size: 12px; color: #98989d; margin-left: 2px; }

.flow {
  display: flex; align-items: stretch; gap: 6px;
  overflow-x: auto; padding-bottom: 6px;
}
.node {
  flex: 1 0 200px; min-width: 200px;
  border: 1px solid; border-radius: 16px; padding: 14px 14px 12px;
  display: flex; flex-direction: column; gap: 6px;
  backdrop-filter: blur(8px);
}
.node-step {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #98989d;
}
.node-dot { width: 8px; height: 8px; border-radius: 50%; }
.node-title { font-size: 15px; font-weight: 600; color: #f5f5f7; letter-spacing: -0.01em; }
.node-sub { font-size: 12px; color: #98989d; }
.node-status { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.node-actions { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.node-actions li {
  display: flex; align-items: flex-start; gap: 6px;
  font-size: 12px; line-height: 1.35; color: #d2d2d7;
}
.act-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex: none; }
.node-clean { font-size: 12px; color: #34d399; }
.node-outcome {
  margin-top: auto; padding-top: 8px; font-size: 11px; color: #8e8e93; font-style: italic;
}
.connector { display: flex; align-items: center; color: #5a5a5f; flex: none; }

.kpis { margin-top: 18px; }
.kpis-arrow { display: flex; justify-content: center; color: #5a5a5f; margin-bottom: 8px; }
.kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.kpi {
  border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
  padding: 12px 14px; background: rgba(255,255,255,0.03);
}
.kpi-label { font-size: 13px; font-weight: 600; color: #f5f5f7; }
.kpi-target { font-size: 12px; color: #98989d; margin-top: 2px; }
</style>
