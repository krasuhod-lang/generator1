<script setup>
/**
 * AegisPage — дашборд мозга A.E.G.I.S. («Эгида»).
 *
 * Показывает:
 *   • Статус всех подсистем (GraphRAG / VectorDB / Ray / LangGraph /
 *     DSPy / GA4 / SelfMutate) и их health (зелёный/жёлтый/красный).
 *   • Состояние компилированного мозга (brain_state/compiled_writer.yaml).
 *   • Последние aegis_runs (Spq, итерации, стоимость, verdict).
 *   • GitHub-бэклог (issues с label aegis:ready).
 *   • Историю brain_versions (timeline эволюции).
 *
 * Все API-вызовы — /api/aegis/* (auth, см. routes/aegis.routes.js).
 */
import { ref, onMounted, computed } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import api from '../api.js';

const loading  = ref(true);
const error    = ref('');
const status   = ref(null);
const runs     = ref([]);
const backlog  = ref([]);
const versions = ref([]);

const minOverall = computed(() => status.value?.quality_gate?.min_overall ?? 80);

function dot(ok) {
  return ok ? '🟢' : '🔴';
}
function fmtPct(v) {
  return v == null ? '—' : Number(v).toFixed(1);
}
function fmtUsd(v) {
  return v == null ? '—' : `$${Number(v).toFixed(4)}`;
}

async function refresh() {
  loading.value = true;
  error.value   = '';
  try {
    const [s, r, b, v] = await Promise.all([
      api.get('/aegis/status').then((x) => x.data),
      api.get('/aegis/runs?limit=20').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/backlog').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/brain/versions').then((x) => x.data).catch(() => ({ items: [] })),
    ]);
    status.value   = s;
    runs.value     = r.items || [];
    backlog.value  = b.items || [];
    versions.value = v.items || [];
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <AppLayout>
    <div class="aegis">
      <header class="head">
        <h1>🛡️ A.E.G.I.S. — мозг системы</h1>
        <button class="btn" @click="refresh" :disabled="loading">
          {{ loading ? '…' : 'Обновить' }}
        </button>
      </header>

      <p v-if="error" class="err">{{ error }}</p>

      <section v-if="status" class="card">
        <h2>Подсистемы</h2>
        <table class="grid">
          <thead>
            <tr><th>Подсистема</th><th>Включена</th><th>Health</th><th>Параметры</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>🧠 LangGraph (writer→critic→refiner)</td>
              <td>{{ status.langgraph.enabled ? '✅' : '⛔' }}</td>
              <td>—</td>
              <td>max refine: {{ status.langgraph.max_refine }}</td>
            </tr>
            <tr>
              <td>🕸️ GraphRAG (Neo4j)</td>
              <td>{{ status.graphrag.enabled ? '✅' : '⛔' }}</td>
              <td>{{ dot(status.graphrag.health?.ok) }} {{ status.graphrag.health?.reason || 'ok' }}</td>
              <td>—</td>
            </tr>
            <tr>
              <td>📦 VectorDB (Qdrant)</td>
              <td>{{ status.vectordb.enabled ? '✅' : '⛔' }}</td>
              <td>{{ dot(status.vectordb.health?.ok) }} {{ status.vectordb.health?.reason || 'ok' }}</td>
              <td>—</td>
            </tr>
            <tr>
              <td>⚡ Ray Cluster</td>
              <td>{{ status.ray.enabled ? '✅' : '⛔' }}</td>
              <td>{{ dot(status.ray.health?.ok) }} {{ status.ray.health?.reason || 'ok' }}</td>
              <td>—</td>
            </tr>
            <tr>
              <td>🎓 DSPy MIPROv2 (эволюция)</td>
              <td>{{ status.dspy.enabled ? '✅' : '⛔' }}</td>
              <td>—</td>
              <td>last: {{ status.dspy.status?.body?.last_status || '—' }}</td>
            </tr>
            <tr>
              <td>📊 GA4 RL/PPO feedback</td>
              <td>{{ status.rl_ga4.enabled ? '✅' : '⛔' }}</td>
              <td>—</td>
              <td>property: {{ status.rl_ga4.property_id_set ? '✓' : '—' }}</td>
            </tr>
            <tr>
              <td>🤖 Self-Mutation (DeepSeek-V4-Pro)</td>
              <td>{{ status.selfmutate.enabled ? '✅' : '⛔' }}</td>
              <td>—</td>
              <td>{{ status.selfmutate.require_human_review ? 'human-review ON' : '⚠ AUTO-MERGE' }}</td>
            </tr>
            <tr>
              <td>📥 GitHub Backlog</td>
              <td>{{ status.backlog.enabled ? '✅' : '⛔' }}</td>
              <td>—</td>
              <td>repo: {{ status.backlog.repo_set ? '✓' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="status" class="card">
        <h2>Жёсткий гейт качества</h2>
        <p>
          <strong>Минимальный Spq overall:</strong>
          {{ minOverall }} <em>(= {{ (minOverall / 10).toFixed(1) }} по 10-балльной шкале)</em>
        </p>
        <p>
          <strong>Минимальные суб-метрики:</strong>
          E-E-A-T ≥ {{ status.quality_gate.min_sub.eeat }},
          fact-check ≥ {{ status.quality_gate.min_sub.fact_check }},
          plagiarism ≥ {{ status.quality_gate.min_sub.plagiarism }}
        </p>
        <p>
          <strong>Поведение при провале:</strong>
          <code>{{ status.quality_gate.on_fail }}</code>
          ({{ status.quality_gate.on_fail === 'fail' ? 'отбрасываем статью' : 'отдаём с пометкой needs_human_review' }})
        </p>
      </section>

      <section v-if="status?.brain_state?.available" class="card">
        <h2>🧠 Состояние компилированного мозга</h2>
        <p>Версия: <strong>{{ status.brain_state.version }}</strong></p>
        <p>Скомпилировано: {{ status.brain_state.compiled_at || '—' }}</p>
        <p>Mean Spq до/после: {{ fmtPct(status.brain_state.mean_spq_before) }} → {{ fmtPct(status.brain_state.mean_spq_after) }}</p>
        <p>Модель writer'а: <code>{{ status.brain_state.model_writer || '—' }}</code></p>
      </section>
      <section v-else class="card subtle">
        <h2>🧠 Состояние компилированного мозга</h2>
        <p>Мозг ещё не обучен. Первый DSPy retrain создаст
          <code>brain_state/compiled_writer.yaml</code>. Запустить вручную:
          <code>POST /api/aegis/dspy/retrain</code>.</p>
      </section>

      <section class="card">
        <h2>Последние запуски ({{ runs.length }})</h2>
        <table v-if="runs.length" class="grid">
          <thead>
            <tr>
              <th>Когда</th><th>Тип</th><th>Spq</th>
              <th>Итераций</th><th>$</th><th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td>{{ new Date(r.created_at).toLocaleString() }}</td>
              <td>{{ r.kind }}</td>
              <td :class="{ ok: r.overall_score >= minOverall, bad: r.overall_score < minOverall }">
                {{ fmtPct(r.overall_score) }}
              </td>
              <td>{{ r.iterations }}</td>
              <td>{{ fmtUsd(r.cost_usd) }}</td>
              <td>{{ r.status }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="subtle">Пока пусто. Запусков ещё не было.</p>
      </section>

      <section class="card">
        <h2>📥 GitHub Backlog ({{ backlog.length }})</h2>
        <ul v-if="backlog.length">
          <li v-for="i in backlog" :key="i.id || i.number">
            <a :href="i.html_url" target="_blank" rel="noopener">#{{ i.number }} — {{ i.title }}</a>
          </li>
        </ul>
        <p v-else class="subtle">
          Бэклог пуст или не подключён. Настройте <code>AEGIS_GITHUB_PAT</code> и
          <code>AEGIS_GITHUB_REPO</code> (см. AEGIS_SETUP.md).
        </p>
      </section>

      <section class="card">
        <h2>📜 История обновлений мозга</h2>
        <table v-if="versions.length" class="grid">
          <thead>
            <tr>
              <th>Когда</th><th>SHA</th>
              <th>Spq до/после</th><th>Δ %</th><th>Trials</th><th>$</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id">
              <td>{{ new Date(v.deployed_at).toLocaleString() }}</td>
              <td><code>{{ (v.sha || '').slice(0, 7) }}</code></td>
              <td>{{ fmtPct(v.mean_spq_before) }} → {{ fmtPct(v.mean_spq_after) }}</td>
              <td>{{ fmtPct(v.improvement_pct) }}</td>
              <td>{{ v.trials_done || '—' }}</td>
              <td>{{ fmtUsd(v.cost_usd) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="subtle">Ещё нет ни одного компиляционного цикла.</p>
      </section>
    </div>
  </AppLayout>
</template>

<style scoped>
.aegis { max-width: 1200px; margin: 0 auto; padding: 16px; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; }
.btn { padding: 6px 14px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: wait; }
.card { background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
.card.subtle { background: #fafafa; }
.card h2 { margin-top: 0; font-size: 1.1rem; }
.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.grid th, .grid td { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; }
.grid th { background: #f5f5f5; }
.ok  { color: #1a7f1a; font-weight: 600; }
.bad { color: #c62828; font-weight: 600; }
.err { color: #c62828; }
.subtle { color: #666; }
code { background: #f3f3f3; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
</style>
