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
const topFailures = ref([]);
const promptLog = ref([]);
const failuresDays = ref(7);

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
function fmtMaybe(v, digits = 1) {
  return v == null ? '—' : Number(v).toFixed(digits);
}

async function refresh() {
  loading.value = true;
  error.value   = '';
  try {
    const [s, r, b, v, f, p] = await Promise.all([
      api.get('/aegis/status').then((x) => x.data),
      api.get('/aegis/runs?limit=20').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/backlog').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/brain/versions').then((x) => x.data).catch(() => ({ items: [] })),
      api.get(`/aegis/failures/top?days=${failuresDays.value}`).then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/prompts/log?limit=20').then((x) => x.data).catch(() => ({ items: [] })),
    ]);
    status.value   = s;
    runs.value     = r.items || [];
    backlog.value  = b.items || [];
    versions.value = v.items || [];
    topFailures.value = f.items || [];
    promptLog.value = p.items || [];
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
        <h2>🔍 Топ причин провалов за {{ failuresDays }} дней ({{ topFailures.length }})</h2>
        <p class="subtle">
          Детерминированный root-cause: <code>failureAnalyzer</code> разбирает отчёты
          (E-E-A-T, fact-check, plagiarism, readability, intent, LSI, image QA, validation)
          в стабильные симптомы. Источник — таблица <code>aegis_quality_log</code>,
          куда пишется КАЖДАЯ генерация (даже не прошедшая гейт SPQ ≥ {{ minOverall }}).
        </p>
        <table v-if="topFailures.length" class="grid">
          <thead>
            <tr>
              <th>Симптом</th>
              <th>Частота</th>
              <th>Ниш</th>
              <th>Последний раз</th>
              <th>Пример (last article)</th>
              <th>SPQ</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in topFailures" :key="f.symptom">
              <td><code>{{ f.symptom }}</code></td>
              <td><strong>{{ f.frequency }}</strong></td>
              <td>{{ f.niches ?? 0 }}</td>
              <td>{{ f.last_seen_at ? new Date(f.last_seen_at).toLocaleString() : '—' }}</td>
              <td>
                <span v-if="f.last_kind" class="subtle">{{ f.last_kind }}</span>
                {{ f.last_article_ref || '—' }}
                <span v-if="f.last_niche" class="subtle"> · {{ f.last_niche }}</span>
              </td>
              <td>{{ fmtMaybe(f.last_spq) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="subtle">
          Пока пусто. После первой завершённой генерации запись появится в
          <code>aegis_quality_log</code>, и симптомы будут сгруппированы здесь.
        </p>
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
            <a v-if="i.html_url" :href="i.html_url" target="_blank" rel="noopener">#{{ i.number }} — {{ i.title }}</a>
            <span v-else>#{{ i.number }} — {{ i.title }}</span>
            <span> · {{ i.local_status || 'pending' }}</span>
            <span v-if="i.task_kind"> · {{ i.task_kind }}</span>
            <span v-if="i.spq_overall != null"> · Spq {{ fmtMaybe(i.spq_overall) }}</span>
          </li>
        </ul>
        <p v-else class="subtle">
          Бэклог пуст или не подключён. Настройте <code>AEGIS_GITHUB_PAT</code> и
          <code>AEGIS_GITHUB_REPO</code> (см. AEGIS_SETUP.md).
        </p>
      </section>

      <section v-if="status" class="card">
        <h2>🎓 Обучающая база</h2>
        <p>Всего строк: <strong>{{ status.training_dataset?.total_rows ?? 0 }}</strong></p>
        <p>За 24ч: <strong>{{ status.training_dataset?.rows_24h ?? 0 }}</strong></p>
        <p>Средний Spq: <strong>{{ fmtMaybe(status.training_dataset?.avg_spq) }}</strong></p>
        <p>Покрытие ниш: <strong>{{ fmtMaybe(status.training_dataset?.niches_coverage_pct) }}%</strong></p>
        <p>Связано с prompt_hash: <strong>{{ status.prompt_dspy_linkage?.dspy_rows_with_prompt_hash ?? 0 }}</strong> / {{ status.prompt_dspy_linkage?.dspy_rows ?? 0 }}
          <span class="subtle">({{ fmtMaybe(status.prompt_dspy_linkage?.coverage_pct) }}%)</span></p>
        <p>Уникальных версий промтов в обучении: <strong>{{ status.prompt_dspy_linkage?.unique_prompt_hashes_in_training ?? 0 }}</strong></p>
      </section>

      <section v-if="status" class="card">
        <h2>🧭 Автономный контур Эгиды 24/7</h2>
        <p class="subtle">{{ status.autonomy?.goal }}</p>
        <ul class="compact">
          <li v-for="step in status.autonomy?.loop || []" :key="step">✅ {{ step }}</li>
        </ul>
        <p>
          DSPy: <strong>{{ status.autonomy?.enabled?.dspy ? '✅' : '⛔' }}</strong> ·
          quality-log: <strong>{{ status.autonomy?.enabled?.quality_log ? '✅' : '⛔' }}</strong> ·
          backlog: <strong>{{ status.autonomy?.enabled?.backlog ? '✅' : '⛔' }}</strong> ·
          self-mutation: <strong>{{ status.autonomy?.enabled?.self_mutation ? '✅' : '⛔' }}</strong>
          <span v-if="status.autonomy?.enabled?.human_review" class="subtle"> · human-review ON</span>
        </p>
      </section>

      <section v-if="status" class="card">
        <h2>🧩 Что можно реализовать на сайте из функций AEGIS</h2>
        <table class="grid">
          <thead><tr><th>Функция</th><th>Статус</th><th>Польза</th></tr></thead>
          <tbody>
            <tr v-for="o in status.site_opportunities || []" :key="o.key">
              <td>{{ o.title }}</td>
              <td><span class="badge">{{ o.status }}</span></td>
              <td>{{ o.value }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="status" class="card">
        <h2>🧾 Prompts-as-Code: лог изменений ({{ promptLog.length }})</h2>
        <p class="subtle">
          Всего промтов: <strong>{{ status.prompt_audit?.total_prompts ?? 0 }}</strong> ·
          связаны с DSPy/анализом: <strong>{{ status.prompt_audit?.dspy_linked ?? 0 }}</strong> ·
          writer: {{ status.prompt_audit?.writer_prompts ?? 0 }},
          critic: {{ status.prompt_audit?.critic_prompts ?? 0 }},
          analysis: {{ status.prompt_audit?.analysis_prompts ?? 0 }} ·
          изменений за 7 дней: <strong>{{ status.prompt_audit?.changes_7d ?? 0 }}</strong>
        </p>
        <table v-if="promptLog.length" class="grid">
          <thead>
            <tr><th>Когда</th><th>Промт</th><th>Роль</th><th>DSPy</th><th>Hash</th><th>Изменение</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in promptLog" :key="p.id">
              <td>{{ new Date(p.changed_at).toLocaleString() }}</td>
              <td><code>{{ p.prompt_key }}</code><br><span class="subtle">{{ p.source_path }}</span></td>
              <td>{{ p.role }}</td>
              <td>{{ p.dspy_linked ? '✅' : '—' }}</td>
              <td><code>{{ p.hash_short }}</code></td>
              <td>{{ p.change_kind }}<span v-if="p.previous_hash_short" class="subtle"> · prev {{ p.previous_hash_short }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="subtle">История появится после первого сканирования /api/aegis/status.</p>
      </section>

      <section v-if="status" class="card">
        <h2>🧬 Bio-Brain</h2>
        <p>Включён: <strong>{{ status.biobrain?.enabled ? '✅' : '⛔' }}</strong></p>
        <p>Поколение: <strong>{{ status.biobrain?.status?.generation ?? '—' }}</strong></p>
        <p>Нейроны/связи: <strong>{{ status.biobrain?.status?.nodes ?? '—' }}</strong> / <strong>{{ status.biobrain?.status?.connections ?? '—' }}</strong></p>
        <p>Mean fitness: <strong>{{ fmtMaybe(status.biobrain?.status?.mean_fitness, 4) }}</strong></p>
        <p>Fast-Reject 24ч: <strong>{{ fmtMaybe(status.biobrain?.status?.fast_reject_rate_24h) }}%</strong></p>
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
/*
 * Тёмная тема под общий стиль приложения (frontend/src/style.css:
 * bg-gray-900 карточки, gray-100 текст). До этого карточки были #fff
 * без явного цвета текста → на тёмном фоне сливались в «белым по белому».
 */
.aegis { max-width: 1200px; margin: 0 auto; padding: 16px; color: #e5e7eb; }
.aegis a { color: #93c5fd; }
.aegis a:hover { color: #bfdbfe; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; color: #f9fafb; }
.btn {
  padding: 6px 14px;
  border: 1px solid #4b5563;
  border-radius: 6px;
  background: #374151;
  color: #f9fafb;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: #4b5563; }
.btn:disabled { opacity: 0.5; cursor: wait; }
.card {
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
  color: #e5e7eb;
}
.card.subtle { background: #0b1220; }
.card h2 { margin-top: 0; font-size: 1.1rem; color: #f9fafb; }
.card p { color: #e5e7eb; }
.card strong { color: #f3f4f6; }
.card em { color: #9ca3af; }
.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; color: #e5e7eb; }
.grid th, .grid td {
  padding: 6px 10px;
  border-bottom: 1px solid #1f2937;
  text-align: left;
}
.grid th { background: #1f2937; color: #f9fafb; }
.grid tbody tr:hover { background: #1f2937; }
.ok  { color: #4ade80; font-weight: 600; }
.bad { color: #f87171; font-weight: 600; }
.err {
  color: #fecaca;
  background: rgba(244, 63, 94, 0.1);
  border: 1px solid rgba(244, 63, 94, 0.3);
  border-radius: 6px;
  padding: 8px 12px;
}
.subtle { color: #9ca3af; }
.compact { margin: 8px 0 0; padding-left: 20px; color: #e5e7eb; }
.badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  background: #1f2937;
  color: #bfdbfe;
  border: 1px solid #374151;
  font-size: 0.82rem;
}
code {
  background: #1f2937;
  color: #e5e7eb;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
}
</style>
