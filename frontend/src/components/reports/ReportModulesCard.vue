<script setup>
import { computed } from 'vue';

const props = defineProps({
  modules: { type: Object, default: () => ({}) },
});

const available = computed(() => {
  const m = props.modules;
  return !!(m && !m.disabled && !m.error && (
    m.striking_distance || m.ctr_gap || m.content_health || m.off_page || m.tech_audit
  ));
});

const sd = computed(() => props.modules?.striking_distance || null);
const cg = computed(() => props.modules?.ctr_gap || null);
const ch = computed(() => props.modules?.content_health || null);
const op = computed(() => props.modules?.off_page || null);
const ta = computed(() => props.modules?.tech_audit || null);

const PRIORITY_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const PRIORITY_CLASS = { high: 'badge-critical', medium: 'badge-warning', low: 'badge-healthy' };
const LEVEL_LABEL = { critical: 'Критический', warning: 'Предупреждение' };
const LEVEL_CLASS = { critical: 'badge-critical', warning: 'badge-warning' };
const HEALTH_LABEL = { healthy: 'Здорова', needs_work: 'Требует работы', critical: 'Критично' };
const HEALTH_CLASS = { healthy: 'badge-healthy', needs_work: 'badge-warning', critical: 'badge-critical' };

function num(v) { return Number(v || 0).toLocaleString('ru-RU'); }
function shortUrl(u) {
  if (!u) return '—';
  try { const x = new URL(u); return x.pathname === '/' ? x.hostname : x.pathname; } catch { return u; }
}
</script>

<template>
  <section v-if="available" id="report-modules" class="rblk">
    <h2>Точки роста и здоровье</h2>

    <!-- Striking Distance -->
    <div v-if="sd" class="module-block">
      <div class="module-head">
        <h3>Striking Distance</h3>
        <div class="kpis">
          <span class="badge badge-critical">High: {{ sd.summary.high || 0 }}</span>
          <span class="badge badge-warning">Medium: {{ sd.summary.medium || 0 }}</span>
          <span class="badge badge-healthy">Low: {{ sd.summary.low || 0 }}</span>
          <span class="kpi-muted">потенциал кликов: {{ num(sd.summary.total_opportunity_clicks) }}</span>
        </div>
      </div>
      <table v-if="sd.items?.length" class="mtable">
        <thead><tr><th>Запрос</th><th>URL</th><th>Поз.</th><th>Показы</th><th>Score</th><th>Приоритет</th></tr></thead>
        <tbody>
          <tr v-for="(it, i) in sd.items.slice(0, 15)" :key="i">
            <td class="q">{{ it.query }}</td>
            <td class="u" :title="it.url">{{ shortUrl(it.url) }}</td>
            <td>{{ it.avg_position }}</td>
            <td>{{ num(it.impressions) }}</td>
            <td>{{ num(it.opportunity_score) }}</td>
            <td><span class="badge" :class="PRIORITY_CLASS[it.priority]">{{ PRIORITY_LABEL[it.priority] || it.priority }}</span></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">Нет запросов в зоне Striking Distance за период.</div>
    </div>

    <!-- CTR Gap -->
    <div v-if="cg" class="module-block">
      <div class="module-head">
        <h3>CTR Gap</h3>
        <div class="kpis">
          <span class="badge badge-critical">Критич.: {{ cg.summary.critical || 0 }}</span>
          <span class="badge badge-warning">Предупр.: {{ cg.summary.warning || 0 }}</span>
          <span class="kpi-muted">упущено кликов: {{ num(cg.summary.lost_clicks) }}</span>
        </div>
      </div>
      <table v-if="cg.items?.length" class="mtable">
        <thead><tr><th>Запрос</th><th>Поз.</th><th>CTR</th><th>Норма</th><th>Уровень</th></tr></thead>
        <tbody>
          <tr v-for="(it, i) in cg.items.slice(0, 15)" :key="i">
            <td class="q">{{ it.query }}</td>
            <td>{{ it.position }}</td>
            <td>{{ it.ctr }}%</td>
            <td>{{ it.benchmark_ctr }}%</td>
            <td><span class="badge" :class="LEVEL_CLASS[it.level]">{{ LEVEL_LABEL[it.level] || it.level }}</span></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">Разрывов CTR не обнаружено.</div>
    </div>

    <!-- Content Health -->
    <div v-if="ch" class="module-block">
      <div class="module-head">
        <h3>Content Health</h3>
        <div class="kpis">
          <span class="kpi-muted">средний балл:</span>
          <span class="badge" :class="ch.summary.avg_score >= 80 ? 'badge-healthy' : ch.summary.avg_score >= 50 ? 'badge-warning' : 'badge-critical'">{{ ch.summary.avg_score }}</span>
          <span class="badge badge-healthy">{{ ch.summary.healthy || 0 }}</span>
          <span class="badge badge-warning">{{ ch.summary.needs_work || 0 }}</span>
          <span class="badge badge-critical">{{ ch.summary.critical || 0 }}</span>
        </div>
      </div>
      <table v-if="ch.items?.length" class="mtable">
        <thead><tr><th>Страница</th><th>Балл</th><th>Статус</th></tr></thead>
        <tbody>
          <tr v-for="(it, i) in ch.items.slice(0, 12)" :key="i">
            <td class="u" :title="it.url">{{ shortUrl(it.url) }}</td>
            <td>{{ it.score }}/100</td>
            <td><span class="badge" :class="HEALTH_CLASS[it.status]">{{ HEALTH_LABEL[it.status] || it.status }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Off-Page + Tech Audit -->
    <div class="module-grid">
      <div v-if="op" class="module-block">
        <h3>Off-Page Monitor</h3>
        <ul class="stat-list">
          <li><span>Ссылок</span><strong>{{ num(op.summary.total) }}</strong></li>
          <li><span>Доноров</span><strong>{{ num(op.summary.unique_donors) }}</strong></li>
          <li><span>В индексе Яндекс</span><strong>{{ num(op.summary.indexed_yandex) }}</strong></li>
          <li><span>В индексе Google</span><strong>{{ num(op.summary.indexed_google) }}</strong></li>
          <li><span>Битых</span><strong :class="{ 'text-bad': op.summary.broken > 0 }">{{ num(op.summary.broken) }}</strong></li>
        </ul>
      </div>
      <div v-if="ta" class="module-block">
        <h3>Tech Audit</h3>
        <ul class="stat-list">
          <li><span>Страниц</span><strong>{{ num(ta.summary.pages) }}</strong></li>
          <li><span>Изображений</span><strong>{{ num(ta.summary.total_images) }}</strong></li>
          <li><span>Без alt</span><strong :class="{ 'text-bad': ta.summary.images_no_alt > 0 }">{{ num(ta.summary.images_no_alt) }}</strong></li>
          <li><span>Не webp</span><strong>{{ num(ta.summary.images_non_webp) }}</strong></li>
          <li><span>Битых</span><strong :class="{ 'text-bad': ta.summary.broken > 0 }">{{ num(ta.summary.broken) }}</strong></li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.module-block { margin-top: 18px; }
.module-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.module-head h3, .module-block > h3 { margin: 0 0 8px; font-size: 1.05rem; }
.kpis { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kpi-muted { color: var(--rr-muted, #697391); font-size: 0.85rem; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #fff; }
.badge-critical { background: #EF4444; }
.badge-warning { background: #F59E0B; }
.badge-healthy { background: #10B981; }
.mtable { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85rem; }
.mtable th, .mtable td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,0.18); }
.mtable th { color: var(--rr-muted, #697391); font-weight: 600; }
.mtable td.q { font-weight: 600; }
.mtable td.u { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rr-muted, #697391); }
.module-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 18px; }
.stat-list { list-style: none; margin: 0; padding: 0; }
.stat-list li { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid rgba(128,128,128,0.14); }
.stat-list span { color: var(--rr-muted, #697391); }
.text-bad { color: #EF4444; }
.empty { color: var(--rr-muted, #697391); font-size: 0.85rem; padding: 6px 0; }
</style>
