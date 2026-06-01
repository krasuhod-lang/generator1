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
const seoBrain = ref(null);
const seoDispatchBusy = ref(false);
const seoDispatchMsg = ref('');

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

function deltaBadge(direction) {
  return {
    grow: 'badge-ok',
    shrink: 'badge-warn',
    new: 'badge-info',
    same: 'badge-wait',
  }[direction] || 'badge-wait';
}
function deltaLabel(detail) {
  if (!detail) return '—';
  if (detail.direction === 'new') return 'новый';
  if (detail.delta_chars == null) return '—';
  if (detail.delta_chars === 0) return '±0';
  return (detail.delta_chars > 0 ? '+' : '−') + Math.abs(detail.delta_chars);
}

async function refresh() {
  loading.value = true;
  error.value   = '';
  try {
    const [s, r, b, v, f, p, sb] = await Promise.all([
      api.get('/aegis/status').then((x) => x.data),
      api.get('/aegis/runs?limit=20').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/backlog').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/brain/versions').then((x) => x.data).catch(() => ({ items: [] })),
      api.get(`/aegis/failures/top?days=${failuresDays.value}`).then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/prompts/log?limit=20').then((x) => x.data).catch(() => ({ items: [] })),
      api.get('/aegis/seo-brain').then((x) => x.data).catch(() => null),
    ]);
    status.value   = s;
    runs.value     = r.items || [];
    backlog.value  = b.items || [];
    versions.value = v.items || [];
    topFailures.value = f.items || [];
    promptLog.value = p.items || [];
    seoBrain.value = sb;
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function dispatchSeoActions() {
  if (seoDispatchBusy.value) return;
  seoDispatchBusy.value = true;
  seoDispatchMsg.value = '';
  try {
    const r = await api.post('/aegis/seo-brain/actions/dispatch', { limit: 5, min_priority: 80 });
    const d = r.data || {};
    seoDispatchMsg.value = `Отправлено: ${d.dispatched ?? 0}, ошибок: ${d.errors ?? 0}`;
    await refresh();
  } catch (e) {
    seoDispatchMsg.value = e?.response?.data?.error || e.message || 'Ошибка';
  } finally {
    seoDispatchBusy.value = false;
  }
}
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
        <div class="table-wrap">
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
        </div>
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
        <div class="kv-grid">
          <span class="k">Версия</span>
          <span class="v">
            <strong>{{ status.brain_state.version }}</strong>
            <span class="badge" :class="status.brain_state.trained ? 'badge-ok' : 'badge-wait'">
              {{ status.brain_state.trained ? 'обучен' : 'baseline (ещё не обучен)' }}
            </span>
          </span>
          <span class="k">Скомпилировано</span>
          <span class="v">{{ status.brain_state.compiled_at || '—' }}</span>
          <span class="k">Mean Spq до/после</span>
          <span class="v">{{ fmtPct(status.brain_state.mean_spq_before) }} → {{ fmtPct(status.brain_state.mean_spq_after) }}</span>
          <span class="k">Trials DSPy</span>
          <span class="v">{{ status.brain_state.trials_done ?? 0 }}</span>
          <span class="k">Модель writer'а</span>
          <span class="v"><code>{{ status.brain_state.model_writer || '—' }}</code></span>
          <span class="k">Модель критика</span>
          <span class="v"><code>{{ status.brain_state.model_critic || '—' }}</code></span>
        </div>
        <p v-if="status.brain_state.notes" class="notes">{{ status.brain_state.notes }}</p>
      </section>
      <section v-else class="card subtle">
        <h2>🧠 Состояние компилированного мозга</h2>
        <p>Мозг ещё не обучен. Первый DSPy retrain создаст
          <code>brain_state/compiled_writer.yaml</code>. Запустить вручную:
          <code>POST /api/aegis/dspy/retrain</code>.</p>
      </section>

      <section v-if="status?.brain_state?.structure" class="card">
        <h2>🔬 Устройство мозга</h2>
        <p class="subtle">
          Мозг — это набор локальных файлов в <code>{{ status.brain_state.structure.root }}</code>,
          которые backend читает <strong>синхронно на каждый запрос</strong> (без сети и внешних
          зависимостей). Поэтому он доступен 24/7, пока writer-файл на месте и парсится.
        </p>
        <div class="health-row">
          <span class="badge" :class="status.brain_state.health.ok ? 'badge-ok' : 'badge-bad'">
            {{ status.brain_state.health.ok ? '🟢 работает' : '🔴 сбой' }}
          </span>
          <span class="badge badge-info" v-if="status.brain_state.health.always_on">♾️ всегда онлайн</span>
          <span class="subtle">{{ status.brain_state.health.reason }}</span>
        </div>
        <div class="table-wrap">
        <table class="grid fixed">
          <thead>
            <tr><th>Файл</th><th>Назначение</th><th class="num">Вес</th><th class="num">Статус</th></tr>
          </thead>
          <tbody>
            <tr v-for="f in status.brain_state.structure.files" :key="f.file">
              <td><code>{{ f.file }}</code></td>
              <td>{{ f.role }}</td>
              <td class="num">{{ f.exists ? f.size_human : '—' }}</td>
              <td class="num">{{ f.exists ? (f.readable ? '🟢' : '🟡') : '⛔' }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">
                <strong>Итого</strong>
                · снапшотов истории: {{ status.brain_state.structure.history_snapshots }}
                · файлов: {{ status.brain_state.structure.files_present }}/{{ status.brain_state.structure.files_total }}
              </td>
              <td class="num"><strong>{{ status.brain_state.structure.total_human }}</strong></td>
              <td class="num">—</td>
            </tr>
          </tfoot>
        </table>
        </div>
        <p v-if="status.brain_state.health.missing?.length" class="subtle">
          ⚠ Отсутствуют файлы: <code>{{ status.brain_state.health.missing.join(', ') }}</code>
          (норма для свежей установки — создаются первым retrain'ом).
        </p>
        <p class="subtle">
          Последнее изменение файлов: {{ status.brain_state.structure.last_modified
            ? new Date(status.brain_state.structure.last_modified).toLocaleString() : '—' }}
        </p>
      </section>

      <section class="card">
        <h2>🔍 Топ причин провалов за {{ failuresDays }} дней ({{ topFailures.length }})</h2>
        <p class="subtle">
          Детерминированный root-cause: <code>failureAnalyzer</code> разбирает отчёты
          (E-E-A-T, fact-check, plagiarism, readability, intent, LSI, image QA, validation)
          в стабильные симптомы. Источник — таблица <code>aegis_quality_log</code>,
          куда пишется КАЖДАЯ генерация (даже не прошедшая гейт SPQ ≥ {{ minOverall }}).
        </p>
        <div v-if="topFailures.length" class="table-wrap">
        <table class="grid">
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
        </div>
        <p v-else class="subtle">
          Пока пусто. После первой завершённой генерации запись появится в
          <code>aegis_quality_log</code>, и симптомы будут сгруппированы здесь.
        </p>
      </section>

      <section class="card">
        <h2>Последние запуски ({{ runs.length }})</h2>
        <div v-if="runs.length" class="table-wrap">
        <table class="grid">
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
        </div>
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
        <div class="table-wrap">
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
        </div>
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
        <div v-if="promptLog.length" class="table-wrap">
        <table class="grid fixed prompts-log">
          <thead>
            <tr><th>Когда</th><th>Промт</th><th>Роль</th><th>DSPy</th><th>Hash</th><th>Что изменилось · зачем · что стало лучше</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in promptLog" :key="p.id">
              <td class="nowrap">{{ new Date(p.changed_at).toLocaleString() }}</td>
              <td><code>{{ p.prompt_key }}</code><br><span class="subtle">{{ p.source_path }}</span></td>
              <td>{{ p.role }}</td>
              <td class="num">{{ p.dspy_linked ? '✅' : '—' }}</td>
              <td><code>{{ p.hash_short }}</code></td>
              <td class="detail">
                <template v-if="p.change_detail">
                  <div class="d-what">
                    <span class="badge" :class="deltaBadge(p.change_detail.direction)">{{ deltaLabel(p.change_detail) }}</span>
                    {{ p.change_detail.what }}
                  </div>
                  <div class="d-why subtle">🎯 {{ p.change_detail.why }}</div>
                  <div class="d-improved subtle">📈 {{ p.change_detail.improved }}</div>
                </template>
                <template v-else>
                  {{ p.change_kind }}<span v-if="p.previous_hash_short" class="subtle"> · prev {{ p.previous_hash_short }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
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

      <section v-if="seoBrain" class="card">
        <h2>🧠 SEO Brain</h2>
        <p v-if="!seoBrain.snapshot">
          <span class="subtle">Snapshot ещё не построен. POST /api/aegis/seo-brain/analyze создаст первый.</span>
        </p>
        <template v-else>
          <p>
            Сайт: <strong>{{ seoBrain.snapshot.site_key }}</strong>
            · Reward: <strong>{{ fmtMaybe(seoBrain.snapshot.reward?.overall, 1) }}</strong>
            · Autonomy: <span class="badge">{{ seoBrain.snapshot.autonomy_stage || 'recommend' }}</span>
          </p>
          <div v-if="seoBrain.snapshot.diagnostics?.summary?.by_type" class="kv">
            <h3>Issues by type</h3>
            <ul>
              <li v-for="(cnt, type) in seoBrain.snapshot.diagnostics.summary.by_type" :key="type">
                <code>{{ type }}</code>: <strong>{{ cnt }}</strong>
              </li>
            </ul>
          </div>
          <div v-if="seoBrain.snapshot.action_plan?.actions?.length">
            <h3>Top-10 actions</h3>
            <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr><th>Priority</th><th>Type</th><th>Target</th><th>Risk</th><th>Status</th></tr>
              </thead>
              <tbody>
                <tr v-for="a in seoBrain.snapshot.action_plan.actions.slice(0, 10)" :key="a.action_key">
                  <td><strong>{{ a.priority }}</strong></td>
                  <td><code>{{ a.action_type }}</code></td>
                  <td><span class="subtle">{{ a.target_url || a.cluster || '—' }}</span></td>
                  <td>{{ a.low_risk ? '🟢 low' : '🟡 review' }}</td>
                  <td>{{ a.status || 'recommended' }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
          <div class="row" style="margin-top: 0.75rem;">
            <button class="btn" @click="dispatchSeoActions" :disabled="seoDispatchBusy">
              {{ seoDispatchBusy ? '…' : '🚀 Создать issue из top low-risk actions' }}
            </button>
            <span v-if="seoDispatchMsg" class="subtle" style="margin-left: 0.5rem;">{{ seoDispatchMsg }}</span>
          </div>
        </template>
      </section>

      <section class="card">
        <h2>📜 История обновлений мозга</h2>
        <div v-if="versions.length" class="table-wrap">
        <table class="grid fixed">
          <thead>
            <tr>
              <th>Когда</th><th>SHA</th>
              <th class="num">Spq до/после</th><th class="num">Δ %</th><th class="num">Trials</th><th class="num">$</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id">
              <td class="nowrap">
                {{ v.deployed_at ? new Date(v.deployed_at).toLocaleString() : '—' }}
                <span v-if="v.is_baseline" class="badge badge-info">baseline</span>
              </td>
              <td><code>{{ v.is_baseline ? 'v' + (status?.brain_state?.version ?? 1) : (v.sha || '').slice(0, 7) }}</code></td>
              <td class="num">{{ fmtPct(v.mean_spq_before) }} → {{ fmtPct(v.mean_spq_after) }}</td>
              <td class="num">{{ fmtPct(v.improvement_pct) }}</td>
              <td class="num">{{ v.trials_done || '—' }}</td>
              <td class="num">{{ fmtUsd(v.cost_usd) }}</td>
            </tr>
          </tbody>
        </table>
        </div>
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
  transition: background 0.2s ease, transform 0.1s ease, box-shadow 0.2s ease;
}
.btn:hover:not(:disabled) { background: #4b5563; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: 0.5; cursor: wait; }
.card {
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
  color: #e5e7eb;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}
.card:hover {
  border-color: #374151;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  transform: translateY(-2px);
}
.card.subtle { background: #0b1220; }
.card h2 { margin-top: 0; font-size: 1.1rem; color: #f9fafb; }
.card p { color: #e5e7eb; }
.card strong { color: #f3f4f6; }
.card em { color: #9ca3af; }
.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; color: #e5e7eb; }
/* Горизонтальный скролл-контейнер: широкие таблицы больше не распирают карточку
 * и не «вылезают» за её границы — вместо этого внутри появляется аккуратный
 * скролл, а вёрстка карточки остаётся ровной на любой ширине экрана. */
.table-wrap {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-radius: 6px;
}
/* Таблица внутри скролл-контейнера держит читаемую минимальную ширину,
 * а на широком экране растягивается на всю карточку. */
.table-wrap > .grid { min-width: 640px; }
.table-wrap > .grid.fixed { min-width: 720px; }
/* Раньше здесь стоял `table-layout: fixed`, но внутри скролл-контейнера
 * (overflow-x: auto) такие таблицы у части браузеров не перерисовывались
 * после асинхронной вставки данных Vue — становились видимы только при
 * наведении на карточку (hover → принудительный repaint). Колонки и так
 * остаются ровными за счёт word-break ниже, поэтому fixed-раскладка убрана. */
.grid td, .grid th { overflow-wrap: anywhere; word-break: break-word; }
.grid th, .grid td {
  padding: 8px 12px;
  border-bottom: 1px solid #1f2937;
  text-align: left;
  vertical-align: top;
}
.grid th { background: #1f2937; color: #f9fafb; font-weight: 600; }
.grid th.num, .grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
.grid td.nowrap { white-space: nowrap; }
.grid tfoot td { border-top: 2px solid #374151; background: #0b1220; }
.grid tbody tr { transition: background 0.15s ease; }
.grid tbody tr:hover { background: #1f2937; }
/* key→value сетка для аккуратного выравнивания состояния мозга */
.kv-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  align-items: baseline;
  margin: 4px 0;
}
.kv-grid .k { color: #9ca3af; }
.kv-grid .v { color: #e5e7eb; }
.notes {
  margin-top: 10px;
  padding: 8px 12px;
  border-left: 3px solid #374151;
  background: #0b1220;
  color: #cbd5e1;
  white-space: pre-line;
  border-radius: 0 6px 6px 0;
}
.health-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
.prompts-log .detail { line-height: 1.45; }
.prompts-log .d-why, .prompts-log .d-improved { margin-top: 2px; font-size: 0.86rem; }
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
  transition: transform 0.15s ease, filter 0.15s ease;
}
.badge:hover { transform: translateY(-1px); filter: brightness(1.15); }
.badge-ok   { background: rgba(34, 197, 94, 0.15); color: #86efac; border-color: rgba(34, 197, 94, 0.4); }
.badge-bad  { background: rgba(244, 63, 94, 0.15); color: #fca5a5; border-color: rgba(244, 63, 94, 0.4); }
.badge-warn { background: rgba(245, 158, 11, 0.15); color: #fcd34d; border-color: rgba(245, 158, 11, 0.4); }
.badge-wait { background: rgba(148, 163, 184, 0.12); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.3); }
.badge-info { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border-color: rgba(59, 130, 246, 0.4); }
code {
  background: #1f2937;
  color: #e5e7eb;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
}
</style>
