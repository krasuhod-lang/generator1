<template>
  <AppLayout>
    <div class="oc-root">
      <div class="oc-back">
        <button class="btn btn-ghost btn-sm" @click="$router.push('/outreach')">← К списку кампаний</button>
      </div>

      <div v-if="!campaign" class="muted">Загрузка…</div>

      <template v-else>
        <header class="oc-header">
          <div class="oc-title">
            <span class="status-dot" :class="`st-${campaign.status}`"></span>
            <h1>{{ campaign.name }}</h1>
          </div>
          <div class="oc-controls">
            <button class="btn btn-secondary btn-sm" @click="runNow" :disabled="acting">▶ Запустить сейчас</button>
            <button
              v-if="campaign.status === 'active'"
              class="btn btn-ghost btn-sm" @click="setStatus('paused')" :disabled="acting"
            >⏸ Пауза</button>
            <button
              v-else
              class="btn btn-ghost btn-sm" @click="setStatus('active')" :disabled="acting"
            >▶ Возобновить</button>
          </div>
        </header>
        <p class="oc-sub">
          {{ (campaign.cities || []).join(', ') }}
          <span v-if="campaign.niche"> · {{ campaign.niche }}</span>
          <span v-if="campaign.business_type"> · {{ campaign.business_type }}</span>
        </p>

        <!-- ── Вкладки ─────────────────────────────────────────── -->
        <nav class="oc-tabs">
          <button
            v-for="t in TABS" :key="t.key"
            class="oc-tab" :class="{ active: tab === t.key }"
            @click="switchTab(t.key)"
          >{{ t.label }}</button>
        </nav>

        <!-- ── ОБЗОР ───────────────────────────────────────────── -->
        <section v-show="tab === 'overview'" class="oc-panel">
          <div class="kpi-grid">
            <div class="kpi"><span class="kpi-v">{{ campaign.total_prospects }}</span><span class="kpi-l">Лидов</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.sent ?? campaign.total_sent }}</span><span class="kpi-l">Отправлено</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.open_rate ?? 0 }}%</span><span class="kpi-l">Open rate</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.opened ?? campaign.total_opened }}</span><span class="kpi-l">Открыто</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.clicked ?? campaign.total_clicked }}</span><span class="kpi-l">Кликов</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.replied ?? campaign.total_replied }}</span><span class="kpi-l">Ответов</span></div>
          </div>

          <div class="card">
            <h3 class="card-h">Динамика по дням</h3>
            <VChart v-if="chartOption" class="chart" :option="chartOption" autoresize />
            <div v-else class="muted">Нет данных для графика</div>
          </div>

          <div class="card">
            <h3 class="card-h">Прогрев домена</h3>
            <div class="warmup-progress">
              <div class="wp-track">
                <div class="wp-fill" :style="{ width: (campaign.warmup_week / 5 * 100) + '%' }"></div>
              </div>
              <div class="wp-label">
                Неделя {{ campaign.warmup_week }} из 5 · лимит {{ warmupLimit(campaign.warmup_week) }} писем/день
              </div>
            </div>
          </div>
        </section>

        <!-- ── ЛИДЫ ────────────────────────────────────────────── -->
        <section v-show="tab === 'prospects'" class="oc-panel">
          <div class="filters">
            <select v-model="prospectFilter.status">
              <option value="">Все статусы</option>
              <option value="new">new</option>
              <option value="queued">queued</option>
              <option value="sent">sent</option>
              <option value="replied">replied</option>
              <option value="unsubscribed">unsubscribed</option>
              <option value="rejected">rejected</option>
            </select>
            <input v-model="prospectFilter.city" type="text" placeholder="Город" />
            <input v-model.number="prospectFilter.minScore" type="number" min="0" max="100" placeholder="Score ≥" />
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Сайт</th><th>Компания</th><th>Email</th><th>Ниша</th><th>Город</th>
                  <th>Яндекс</th><th>Google</th><th>Score</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in filteredProspects" :key="p.id">
                  <td><a :href="p.url" target="_blank" rel="noopener">{{ shortUrl(p.url) }}</a></td>
                  <td>{{ p.company_name || '—' }}</td>
                  <td>{{ (p.emails || [])[0] || '—' }}</td>
                  <td>{{ p.niche || '—' }}</td>
                  <td>{{ p.city || '—' }}</td>
                  <td><span class="dyn" :class="dynClass(p.dynamics_yandex)">{{ dynLabel(p.dynamics_yandex) }}</span></td>
                  <td><span class="dyn" :class="dynClass(p.dynamics_google)">{{ dynLabel(p.dynamics_google) }}</span></td>
                  <td><span class="score" :class="scoreClass(p.score)">{{ p.score }}</span></td>
                  <td>{{ p.status }}</td>
                </tr>
                <tr v-if="!filteredProspects.length"><td colspan="9" class="muted">Лидов пока нет</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ── ПИСЬМА ──────────────────────────────────────────── -->
        <section v-show="tab === 'emails'" class="oc-panel">
          <div class="card ds-card">
            <h3 class="card-h">Прямая отправка по адресам</h3>
            <p class="muted ds-hint">
              Укажите пул email-адресов (через запятую или с новой строки) — для
              каждого будет сгенерировано письмо и поставлено в очередь отправки.
            </p>
            <textarea
              v-model="directEmails"
              class="ds-textarea"
              rows="3"
              placeholder="info@example.ru, sales@company.com"
            ></textarea>
            <div class="ds-row">
              <input v-model="directNiche" type="text" class="ds-input" placeholder="Ниша (необязательно)" />
              <input v-model="directCity" type="text" class="ds-input" placeholder="Город (необязательно)" />
              <button class="btn btn-primary" :disabled="dsSending || !directEmails.trim()" @click="sendDirect">
                {{ dsSending ? 'Отправка…' : 'Сгенерировать и отправить' }}
              </button>
            </div>
            <div v-if="dsResult" class="ds-result">
              <span v-if="dsResult.error" class="ds-skip">{{ dsResult.error }}</span>
              <template v-else>
                <span class="ds-ok">В очередь: {{ dsResult.queued }}</span>
                <span v-if="dsResult.skipped_count" class="ds-skip">Пропущено: {{ dsResult.skipped_count }}</span>
                <ul v-if="dsResult.skipped && dsResult.skipped.length" class="ds-skip-list">
                  <li v-for="s in dsResult.skipped" :key="s.email">{{ s.email }} — {{ s.reason }}</li>
                </ul>
              </template>
            </div>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr><th>Получатель</th><th>Тема</th><th>Статус</th><th>Отправлено</th><th>Открыто</th><th>Кликнуто</th></tr>
              </thead>
              <tbody>
                <tr v-for="e in emails" :key="e.id" class="clickable" @click="openEmail(e)">
                  <td>{{ e.recipient_email }}</td>
                  <td>{{ e.subject || '—' }}</td>
                  <td>{{ emailStatusIcon(e.status) }} {{ e.status }}</td>
                  <td>{{ formatTime(e.sent_at) }}</td>
                  <td>{{ formatTime(e.opened_at) }}</td>
                  <td>{{ formatTime(e.clicked_at) }}</td>
                </tr>
                <tr v-if="!emails.length"><td colspan="6" class="muted">Писем пока нет</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ── ЛОГИ ────────────────────────────────────────────── -->
        <section v-show="tab === 'logs'" class="oc-panel">
          <div class="logs-wrap">
            <div class="logs" ref="logsBox" @scroll="onLogsScroll">
              <div v-for="l in logs" :key="l.id" class="log-row" :class="`lg-${l.level}`">
                <span class="lg-dot"></span>
                <span class="lg-time">{{ formatTime(l.created_at) }}</span>
                <span class="lg-msg">{{ l.message }}</span>
              </div>
              <div v-if="!logs.length" class="muted">Логов пока нет</div>
            </div>
            <button
              v-if="!stickToBottom && logs.length"
              class="logs-jump" @click="jumpToBottom"
            >↓ К свежим</button>
          </div>
        </section>
      </template>

      <!-- ── Модалка превью письма ─────────────────────────────── -->
      <div v-if="modalEmail" class="modal-backdrop" @click.self="modalEmail = null">
        <div class="modal">
          <div class="modal-head">
            <h3>{{ modalEmail.subject || 'Письмо' }}</h3>
            <button class="chip-x" @click="modalEmail = null">×</button>
          </div>
          <div class="modal-meta">
            Кому: {{ modalEmail.recipient_email }} · Статус: {{ modalEmail.status }}
            <span v-if="modalEmail.subject_strategy" class="badge badge-strategy">{{ strategyLabel(modalEmail.subject_strategy) }}</span>
            <span v-if="modalEmail.manual_review_required" class="badge badge-review">⚠ ручная проверка</span>
          </div>
          <!-- Полный HTML письма в изолированном iframe (sandbox без скриптов):
               показываем письмо ровно так, как его увидит получатель. -->
          <iframe
            v-if="modalEmail.html_full"
            class="modal-frame"
            sandbox=""
            :srcdoc="modalEmail.html_full"
          ></iframe>
          <div v-else class="modal-preview" v-html="sanitizedPreview(modalEmail.html_preview)"></div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
/**
 * OutreachCampaignPage — детальная страница кампании.
 * Вкладки: Обзор | Лиды | Письма | Логи. График ECharts, поллинг логов.
 */
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useOutreachStore } from '../stores/outreach.js';

import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import VChart from 'vue-echarts';

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent]);

const TABS = [
  { key: 'overview', label: 'Обзор' },
  { key: 'prospects', label: 'Лиды' },
  { key: 'emails', label: 'Письма' },
  { key: 'logs', label: 'Логи' },
];
const WARMUP_LIMITS = [25, 50, 100, 250, 500];

const route = useRoute();
const store = useOutreachStore();
const campaignId = route.params.id;

const campaign = ref(null);
const stats = ref(null);
const prospects = ref([]);
const emails = ref([]);
const logs = ref([]);
const tab = ref('overview');
const acting = ref(false);
const modalEmail = ref(null);
const logsBox = ref(null);
// Автоскролл логов «прилипает» к низу только если пользователь уже внизу —
// иначе поллинг (loadLogs каждые 5с) не будет дёргать прокрутку вверх при
// чтении истории (фикс «логи прыгают вниз при прокрутке»).
const stickToBottom = ref(true);

const prospectFilter = ref({ status: '', city: '', minScore: null });

// Прямая отправка по пулу адресов (вкладка «Письма»).
const directEmails = ref('');
const directNiche = ref('');
const directCity = ref('');
const dsSending = ref(false);
const dsResult = ref(null);

let pollTimer = null;

function warmupLimit(week) {
  return WARMUP_LIMITS[Math.min(Math.max((week || 1) - 1, 0), 4)];
}
function shortUrl(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; }
}
function formatTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return s; }
}
function dynLabel(d) {
  return d === 'decline' ? '↓ падение' : d === 'growth' ? '↑ рост' : d === 'stagnation' ? '→ стагн.' : '—';
}
function dynClass(d) {
  return d === 'decline' ? 'dyn-down' : d === 'growth' ? 'dyn-up' : d === 'stagnation' ? 'dyn-flat' : '';
}
function scoreClass(s) {
  return s >= 70 ? 'sc-high' : s >= 40 ? 'sc-mid' : 'sc-low';
}
function emailStatusIcon(s) {
  return { queued: '📤', sent: '✅', delivered: '📬', opened: '👁', clicked: '🖱', bounced: '⚠️', complained: '🚫', failed: '❌' }[s] || '•';
}
function strategyLabel(s) {
  return {
    numeric_drop: '📉 цифра падения',
    competitor: '⚔ конкуренты',
    question: '❓ вопрос',
    fallback: '🛟 шаблон',
  }[s] || s;
}
// Простая санитизация превью: показываем только как текст с сохранением
// переносов — исключаем исполнение потенциально опасного HTML.
function sanitizedPreview(html) {
  if (!html) return '<i>нет превью</i>';
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML.replace(/\n/g, '<br>');
}

const filteredProspects = computed(() => {
  return prospects.value.filter((p) => {
    if (prospectFilter.value.status && p.status !== prospectFilter.value.status) return false;
    if (prospectFilter.value.city && !(p.city || '').toLowerCase().includes(prospectFilter.value.city.toLowerCase())) return false;
    if (prospectFilter.value.minScore != null && prospectFilter.value.minScore !== '' && p.score < prospectFilter.value.minScore) return false;
    return true;
  });
});

const chartOption = computed(() => {
  const daily = stats.value?.daily;
  if (!daily || !daily.length) return null;
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['Отправлено', 'Открыто', 'Кликов'], top: 0 },
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: daily.map((d) => d.day.slice(5)) },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      { name: 'Отправлено', type: 'line', smooth: true, data: daily.map((d) => d.sent), itemStyle: { color: '#0071e3' } },
      { name: 'Открыто', type: 'line', smooth: true, data: daily.map((d) => d.opened), itemStyle: { color: '#34c759' } },
      { name: 'Кликов', type: 'line', smooth: true, data: daily.map((d) => d.clicked), itemStyle: { color: '#ff9f0a' } },
    ],
  };
});

async function loadCampaign() {
  campaign.value = await store.getCampaign(campaignId);
}
async function loadStats() {
  stats.value = await store.getCampaignStats(campaignId);
}
async function loadProspects() {
  const res = await store.getCampaignProspects(campaignId, 1);
  prospects.value = res.prospects || [];
}
async function loadEmails() {
  const res = await store.getCampaignEmails(campaignId, 1);
  emails.value = res.emails || [];
}
async function loadLogs() {
  logs.value = await store.getCampaignLogs(campaignId);
}

async function switchTab(key) {
  tab.value = key;
  if (key === 'prospects') await loadProspects();
  else if (key === 'emails') await loadEmails();
  else if (key === 'logs') { stickToBottom.value = true; await loadLogs(); scrollLogs(); }
  else if (key === 'overview') await loadStats();
}

function scrollLogs() {
  nextTick(() => {
    if (logsBox.value) logsBox.value.scrollTop = logsBox.value.scrollHeight;
  });
}
// Обновляем флаг «внизу ли пользователь» на каждый скролл контейнера логов.
function onLogsScroll() {
  const el = logsBox.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom.value = distanceFromBottom <= 40;
}
// Ручной переход к свежим логам (кнопка «↓ К свежим»).
function jumpToBottom() {
  stickToBottom.value = true;
  scrollLogs();
}
// Автоскролл только когда пользователь уже у нижнего края.
watch(logs, () => { if (tab.value === 'logs' && stickToBottom.value) scrollLogs(); });

async function setStatus(status) {
  acting.value = true;
  try {
    campaign.value = await store.updateCampaign(campaignId, { status });
  } finally { acting.value = false; }
}
async function runNow() {
  acting.value = true;
  try {
    campaign.value = await store.updateCampaign(campaignId, { run_now: true });
  } finally { acting.value = false; }
}

function openEmail(e) { modalEmail.value = e; }

async function sendDirect() {
  if (dsSending.value || !directEmails.value.trim()) return;
  dsSending.value = true;
  dsResult.value = null;
  try {
    dsResult.value = await store.directSend(campaignId, {
      emails: directEmails.value,
      niche: directNiche.value || undefined,
      city: directCity.value || undefined,
    });
    if (dsResult.value?.queued > 0) {
      directEmails.value = '';
      await loadEmails();
      await loadCampaign();
    }
  } catch (err) {
    dsResult.value = { queued: 0, skipped_count: 0, error: err?.response?.data?.error || err.message };
  } finally {
    dsSending.value = false;
  }
}

function pollActive() {
  loadCampaign();
  if (tab.value === 'overview') loadStats();
  else if (tab.value === 'logs') loadLogs();
  else if (tab.value === 'emails') loadEmails();
  else if (tab.value === 'prospects') loadProspects();
}

onMounted(async () => {
  await loadCampaign();
  await loadStats();
  pollTimer = setInterval(pollActive, 5000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<style scoped>
.oc-root { max-width: 1080px; margin: 0 auto; padding: 20px; color: #1d1d1f; }
.oc-back { margin-bottom: 12px; }
.oc-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.oc-title { display: flex; align-items: center; gap: 10px; }
.oc-title h1 { font-size: 24px; font-weight: 700; margin: 0; color: #fff; }
.oc-controls { display: flex; gap: 8px; }
.oc-sub { color: #6e6e73; font-size: 14px; margin: 6px 0 18px; }

.status-dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
.st-active { background: #34c759; }
.st-paused { background: #ff9f0a; }
.st-draft { background: #8e8e93; }
.st-completed { background: #0071e3; }
.st-error { background: #ff3b30; }

.oc-tabs { display: flex; gap: 4px; border-bottom: 1px solid #e5e5ea; margin-bottom: 18px; }
.oc-tab {
  background: none; border: none; cursor: pointer;
  padding: 10px 16px; font-size: 15px; font-weight: 600; color: #6e6e73;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.oc-tab.active { color: #0071e3; border-bottom-color: #0071e3; }

.card {
  background: #fff; border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.04);
  padding: 20px; margin-bottom: 18px;
}
.card-h { margin: 0 0 14px; font-size: 16px; font-weight: 700; }

.kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 18px; }
.kpi {
  background: #fff; border-radius: 12px; padding: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06); text-align: center;
  display: flex; flex-direction: column; gap: 4px;
}
.kpi-v { font-size: 24px; font-weight: 700; color: #1d1d1f; }
.kpi-l { font-size: 12px; color: #86868b; }

.chart { height: 300px; width: 100%; }

.warmup-progress { display: flex; flex-direction: column; gap: 8px; }
.wp-track { height: 10px; background: #eef4ff; border-radius: 6px; overflow: hidden; }
.wp-fill { height: 100%; background: #0071e3; transition: width .3s; }
.wp-label { font-size: 13px; color: #6e6e73; }

.filters { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.filters select, .filters input {
  border: 1px solid #d2d2d7; border-radius: 8px; padding: 8px 10px;
  font-size: 14px; background: #fbfbfd;
}

.table-wrap { overflow-x: auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #f0f0f2; white-space: nowrap; }
.tbl th { background: #fafafa; font-weight: 600; color: #3a3a3c; position: sticky; top: 0; }
.tbl a { color: #0071e3; text-decoration: none; }
.clickable { cursor: pointer; }
.clickable:hover { background: #f7faff; }

.dyn { font-size: 12px; font-weight: 600; }
.dyn-down { color: #ff3b30; }
.dyn-up { color: #34c759; }
.dyn-flat { color: #ff9f0a; }

.score { display: inline-block; min-width: 32px; text-align: center; border-radius: 6px; padding: 2px 6px; font-weight: 700; color: #fff; }
.sc-high { background: #34c759; }
.sc-mid { background: #ff9f0a; }
.sc-low { background: #ff3b30; }

.logs-wrap { position: relative; }
.logs {
  background: #1d1d1f; border-radius: 12px; padding: 16px;
  max-height: 460px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 13px;
}
.logs-jump {
  position: absolute; right: 16px; bottom: 16px;
  border: none; border-radius: 999px; padding: 8px 14px; cursor: pointer;
  background: #0a84ff; color: #fff; font-size: 12px; font-weight: 600;
  box-shadow: 0 4px 12px rgba(10,132,255,.4);
}
.logs-jump:hover { background: #0071e3; }
.log-row { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; color: #d1d1d6; }
.lg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #0a84ff; }
.lg-success .lg-dot { background: #34c759; }
.lg-info .lg-dot { background: #0a84ff; }
.lg-warn .lg-dot { background: #ff9f0a; }
.lg-error .lg-dot { background: #ff3b30; }
.lg-time { color: #8e8e93; flex-shrink: 0; }
.lg-msg { color: #f5f5f7; }

.btn { border: none; border-radius: 10px; padding: 10px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.btn-sm { padding: 7px 12px; font-size: 13px; }
.btn-secondary { background: #f0f0f2; color: #1d1d1f; }
.btn-ghost { background: #fff; color: #0071e3; border: 1px solid #d2d2d7; }
.btn-primary { background: #0071e3; color: #fff; }
.btn-primary:hover { background: #0062c4; }

/* Прямая отправка по пулу адресов */
.ds-card { margin-bottom: 14px; }
.ds-hint { padding: 0 0 10px; }
.ds-textarea {
  width: 100%; box-sizing: border-box; border: 1px solid #d2d2d7; border-radius: 8px;
  padding: 10px; font-size: 14px; background: #fbfbfd; resize: vertical; font-family: inherit;
}
.ds-row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.ds-input {
  flex: 1 1 160px; border: 1px solid #d2d2d7; border-radius: 8px; padding: 9px 10px;
  font-size: 14px; background: #fbfbfd;
}
.ds-result { margin-top: 12px; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
.ds-ok { color: #34c759; font-weight: 600; }
.ds-skip { color: #ff9f0a; font-weight: 600; }
.ds-skip-list { margin: 4px 0 0; padding-left: 18px; color: #86868b; font-size: 13px; }

.muted { color: #86868b; font-size: 14px; padding: 12px; }

.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #fff; border-radius: 14px; width: min(640px, 92vw);
  max-height: 82vh; overflow-y: auto; padding: 20px;
  box-shadow: 0 20px 60px rgba(0,0,0,.25);
}
.modal-head { display: flex; justify-content: space-between; align-items: center; }
.modal-head h3 { margin: 0; font-size: 17px; }
.modal-meta { color: #86868b; font-size: 13px; margin: 8px 0 14px; }
.modal-preview { border: 1px solid #f0f0f2; border-radius: 10px; padding: 16px; font-size: 14px; color: #333; }
.modal-frame { width: 100%; height: 60vh; border: 1px solid #f0f0f2; border-radius: 10px; background: #fff; }
.badge { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.badge-strategy { background: #eef4ff; color: #0071e3; }
.badge-review { background: #fff4e5; color: #b26a00; }
.chip-x { border: none; background: none; cursor: pointer; font-size: 22px; line-height: 1; color: #86868b; }

@media (max-width: 720px) {
  .kpi-grid { grid-template-columns: repeat(3, 1fr); }
}
</style>
