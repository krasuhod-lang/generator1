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
            <div class="kpi"><span class="kpi-v">{{ campaign.total_sent }}</span><span class="kpi-l">Отправлено</span></div>
            <div class="kpi"><span class="kpi-v">{{ stats?.totals?.open_rate ?? 0 }}%</span><span class="kpi-l">Open rate</span></div>
            <div class="kpi"><span class="kpi-v">{{ campaign.total_opened }}</span><span class="kpi-l">Открыто</span></div>
            <div class="kpi"><span class="kpi-v">{{ campaign.total_clicked }}</span><span class="kpi-l">Кликов</span></div>
            <div class="kpi"><span class="kpi-v">{{ campaign.total_replied }}</span><span class="kpi-l">Ответов</span></div>
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
                  <th>Сайт</th><th>Компания</th><th>Email</th><th>Телефон</th><th>Мессенджеры</th><th>Ниша</th><th>Город</th>
                  <th>Яндекс</th><th>Google</th><th>Score</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in filteredProspects" :key="p.id">
                  <td><a :href="p.url" target="_blank" rel="noopener">{{ shortUrl(p.url) }}</a></td>
                  <td>{{ p.company_name || '—' }}</td>
                  <td>{{ (p.emails || [])[0] || '—' }}</td>
                  <td>{{ (p.phones || [])[0] || '—' }}</td>
                  <td>
                    <template v-if="(p.messengers || []).length">
                      <a
                        v-for="(m, mi) in p.messengers" :key="mi"
                        :href="m.url" target="_blank" rel="noopener"
                        class="mgr" :class="`mgr-${m.type}`" :title="m.url"
                      >{{ mgrLabel(m.type) }}</a>
                    </template>
                    <span v-else>—</span>
                  </td>
                  <td>{{ p.niche || '—' }}</td>
                  <td>{{ p.city || '—' }}</td>
                  <td><span class="dyn" :class="dynClass(p.dynamics_yandex)">{{ dynLabel(p.dynamics_yandex) }}</span></td>
                  <td><span class="dyn" :class="dynClass(p.dynamics_google)">{{ dynLabel(p.dynamics_google) }}</span></td>
                  <td><span class="score" :class="scoreClass(p.score)">{{ p.score }}</span></td>
                  <td>{{ p.status }}</td>
                </tr>
                <tr v-if="!filteredProspects.length"><td colspan="11" class="muted">Лидов пока нет</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ── ПИСЬМА ──────────────────────────────────────────── -->
        <section v-show="tab === 'emails'" class="oc-panel">
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

        <!-- ── АДРЕСНАЯ РАССЫЛКА ──────────────────────────────── -->
        <section v-show="tab === 'direct'" class="oc-panel">
          <div class="card">
            <h3 class="card-h">Контакты отправителя</h3>
            <p class="muted" style="padding:0 0 10px;">
              Указываются в подписи письма, чтобы получатель мог с вами связаться.
              Обязательны перед запуском рассылки.
            </p>
            <div class="direct-contacts">
              <label>Наш сайт
                <input v-model="senderForm.sender_site" type="text" placeholder="myseo.ru" />
              </label>
              <label>Telegram
                <input v-model="senderForm.sender_telegram" type="text" placeholder="@username или t.me/username" />
              </label>
              <button class="btn btn-secondary btn-sm" @click="saveContacts" :disabled="acting">Сохранить контакты</button>
            </div>
          </div>

          <div class="card">
            <h3 class="card-h">Отправить по своему списку</h3>
            <p class="muted" style="padding:0 0 10px;">
              По одному адресату в строке: <code>email</code> или <code>email, сайт</code>.
              Письма пройдут тот же конвейер генерации и отправки, что и общая кампания.
            </p>
            <textarea
              v-model="directList"
              class="direct-textarea"
              rows="8"
              placeholder="info@example.com, example.com&#10;sales@company.ru"
            ></textarea>
            <div class="direct-actions">
              <button class="btn btn-primary btn-sm" @click="sendDirect" :disabled="directSending">
                <span v-if="directSending">Отправляем…</span>
                <span v-else>📨 Поставить в очередь</span>
              </button>
              <span v-if="directResult" class="direct-result">
                Поставлено: {{ directResult.queued }} · Пропущено: {{ directResult.skipped }}
              </span>
            </div>
            <div v-if="directError" class="cc-error">⚠️ {{ directError }}</div>
          </div>
        </section>

        <!-- ── ЛОГИ ────────────────────────────────────────────── -->
        <section v-show="tab === 'logs'" class="oc-panel">
          <div class="logs" ref="logsBox">
            <div v-for="l in logs" :key="l.id" class="log-row" :class="`lg-${l.level}`">
              <span class="lg-dot"></span>
              <span class="lg-time">{{ formatTime(l.created_at) }}</span>
              <span class="lg-msg">{{ l.message }}</span>
            </div>
            <div v-if="!logs.length" class="muted">Логов пока нет</div>
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
          </div>
          <div class="modal-preview" v-html="sanitizedPreview(modalEmail.html_preview)"></div>
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
  { key: 'direct', label: 'Адресная рассылка' },
  { key: 'logs', label: 'Логи' },
];
const WARMUP_LIMITS = [10, 25, 60, 120, 200];

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

const prospectFilter = ref({ status: '', city: '', minScore: null });

// Адресная рассылка (req 5) + контакты отправителя (req 3).
const senderForm = ref({ sender_site: '', sender_telegram: '' });
const directList = ref('');
const directSending = ref(false);
const directResult = ref(null);
const directError = ref('');

let pollTimer = null;

function mgrLabel(type) {
  return { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' }[type] || type;
}

// Парсит textarea в список { email, site } (email или "email, сайт" на строку).
function parseRecipients(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const email = parts.find((p) => p.includes('@'));
    if (!email) continue;
    const site = parts.find((p) => !p.includes('@'));
    out.push(site ? { email, site } : { email });
  }
  return out;
}

async function saveContacts() {
  acting.value = true;
  directError.value = '';
  try {
    campaign.value = await store.updateCampaign(campaignId, {
      sender_site: senderForm.value.sender_site,
      sender_telegram: senderForm.value.sender_telegram,
    });
  } catch (err) {
    directError.value = err.response?.data?.error || err.message || 'Ошибка сохранения';
  } finally {
    acting.value = false;
  }
}

async function sendDirect() {
  directError.value = '';
  directResult.value = null;
  const recipients = parseRecipients(directList.value);
  if (!recipients.length) {
    directError.value = 'Добавьте хотя бы один email';
    return;
  }
  directSending.value = true;
  try {
    directResult.value = await store.directSend(campaignId, recipients);
    directList.value = '';
    await loadCampaign();
  } catch (err) {
    directError.value = err.response?.data?.error || err.message || 'Ошибка отправки';
  } finally {
    directSending.value = false;
  }
}

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
  else if (key === 'logs') { await loadLogs(); scrollLogs(); }
  else if (key === 'overview') await loadStats();
}

function scrollLogs() {
  nextTick(() => {
    if (logsBox.value) logsBox.value.scrollTop = logsBox.value.scrollHeight;
  });
}
watch(logs, () => { if (tab.value === 'logs') scrollLogs(); });

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

function pollActive() {
  loadCampaign();
  if (tab.value === 'overview') loadStats();
  else if (tab.value === 'logs') loadLogs();
  else if (tab.value === 'emails') loadEmails();
  else if (tab.value === 'prospects') loadProspects();
}

onMounted(async () => {
  await loadCampaign();
  if (campaign.value) {
    senderForm.value.sender_site = campaign.value.sender_site || '';
    senderForm.value.sender_telegram = campaign.value.sender_telegram || '';
  }
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
.oc-title h1 { font-size: 24px; font-weight: 700; margin: 0; }
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
.mgr {
  display: inline-block; margin: 0 4px 2px 0; padding: 2px 7px;
  border-radius: 6px; font-size: 11px; font-weight: 600; text-decoration: none; color: #fff;
}
.mgr-whatsapp { background: #25d366; }
.mgr-telegram { background: #229ed9; }
.mgr-max { background: #6c5ce7; }

.direct-contacts { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.direct-contacts label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; color: #3a3a3c; }
.direct-contacts input {
  border: 1px solid #d2d2d7; border-radius: 8px; padding: 8px 10px;
  font-size: 14px; background: #fbfbfd; min-width: 240px;
}
.direct-textarea {
  width: 100%; border: 1px solid #d2d2d7; border-radius: 10px; padding: 10px 12px;
  font-size: 14px; background: #fbfbfd; font-family: ui-monospace, monospace; resize: vertical;
}
.direct-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.direct-result { font-size: 13px; color: #34c759; font-weight: 600; }
.cc-error { color: #d70015; font-size: 13px; margin-top: 8px; }
.dyn-flat { color: #ff9f0a; }

.score { display: inline-block; min-width: 32px; text-align: center; border-radius: 6px; padding: 2px 6px; font-weight: 700; color: #fff; }
.sc-high { background: #34c759; }
.sc-mid { background: #ff9f0a; }
.sc-low { background: #ff3b30; }

.logs {
  background: #1d1d1f; border-radius: 12px; padding: 16px;
  max-height: 460px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 13px;
}
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
.chip-x { border: none; background: none; cursor: pointer; font-size: 22px; line-height: 1; color: #86868b; }

@media (max-width: 720px) {
  .kpi-grid { grid-template-columns: repeat(3, 1fr); }
}
</style>
