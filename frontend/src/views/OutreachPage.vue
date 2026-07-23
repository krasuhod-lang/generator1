<template>
  <AppLayout>
    <div class="outreach-root">
      <!-- ── Заголовок ───────────────────────────────────────────── -->
      <header class="page-header">
        <h1>📨 Outreach — автоматические email-рассылки</h1>
        <p class="subtitle">
          Соберите лиды по нише и гео, оцените их по качеству и запустите
          персонализированную рассылку с прогревом домена.
        </p>
      </header>

      <!-- ── Форма создания кампании ─────────────────────────────── -->
      <section class="card form-card">
        <div class="form-grid">
          <div class="field field-wide">
            <label for="keyword">Ниша / запрос</label>
            <input
              id="keyword" v-model="form.keyword"
              type="text" placeholder="например, ремонт квартир"
              :disabled="submitting"
            />
          </div>

          <div class="field field-wide">
            <label>Города</label>
            <div class="cities-box">
              <span v-for="(c, i) in form.cities" :key="c" class="city-chip">
                {{ c }}
                <button class="chip-x" @click="removeCity(i)" :disabled="submitting">×</button>
              </span>
              <div class="city-add">
                <input
                  v-model="cityInput"
                  list="city-suggestions"
                  type="text" placeholder="+ добавить город"
                  :disabled="submitting"
                  @keyup.enter="addCity"
                />
                <datalist id="city-suggestions">
                  <option v-for="c in CITY_SUGGESTIONS" :key="c" :value="c" />
                </datalist>
                <button class="btn btn-secondary btn-sm" @click="addCity" :disabled="submitting">Добавить</button>
              </div>
            </div>
          </div>

          <div class="field">
            <label>Поисковик</label>
            <div class="radio-row">
              <label class="radio">
                <input type="radio" value="yandex" v-model="form.search_engine" :disabled="submitting" />
                Яндекс
              </label>
              <label class="radio">
                <input type="radio" value="google" v-model="form.search_engine" :disabled="submitting" />
                Google
              </label>
            </div>
          </div>

          <div class="field">
            <label for="depth">Глубина SERP</label>
            <select id="depth" v-model.number="form.depth_pages" :disabled="submitting">
              <option :value="1">1 страница</option>
              <option :value="2">2 страницы</option>
              <option :value="3">3 страницы</option>
              <option :value="5">5 страниц</option>
            </select>
          </div>

          <div class="field">
            <label for="daily">Лимит / день</label>
            <input
              id="daily" v-model.number="form.daily_limit"
              type="number" min="1" max="500"
              :disabled="submitting"
            />
            <span class="hint">прогрев: авто</span>
          </div>

          <div class="field field-wide">
            <label for="sender">Имя отправителя</label>
            <input
              id="sender" v-model="form.sender_name"
              type="text" placeholder="Иван Иванов"
              :disabled="submitting"
            />
          </div>

          <div class="field field-actions">
            <button class="btn btn-primary" :disabled="submitting" @click="createCampaign">
              <span v-if="submitting">Создаём…</span>
              <span v-else>🚀 Создать кампанию</span>
            </button>
          </div>
        </div>
        <div v-if="formError" class="form-error">{{ formError }}</div>
      </section>

      <!-- ── Информация о прогреве (аккордеон) ───────────────────── -->
      <section class="card warmup-card">
        <button class="warmup-toggle" @click="warmupOpen = !warmupOpen">
          ℹ️ Как работает прогрев домена?
          <span class="chev">{{ warmupOpen ? '▲' : '▼' }}</span>
        </button>
        <div v-if="warmupOpen" class="warmup-body">
          Неделя 1: <b>25</b> писем/день (до 3/час) → Неделя 2: <b>50</b> →
          Неделя 3: <b>100</b> → Неделя 4: <b>250</b> → Неделя 5: <b>500</b>.
          Отправка равномерно распределяется в окне <b>07:00–18:00 МСК</b>.
          Лимит повышается автоматически, чтобы сохранить репутацию домена
          и высокий open-rate.
        </div>
      </section>

      <!-- ── Список кампаний ─────────────────────────────────────── -->
      <section class="campaigns">
        <div v-if="store.loading" class="muted">Загрузка кампаний…</div>
        <div v-else-if="!store.campaigns.length" class="muted empty">
          Пока нет кампаний. Создайте первую выше ⬆️
        </div>

        <div
          v-for="c in store.campaigns" :key="c.id"
          class="card campaign-card"
        >
          <div class="cc-head">
            <div class="cc-title">
              <span class="status-dot" :class="`st-${c.status}`" :title="c.status"></span>
              <h3>{{ c.name }}</h3>
            </div>
            <span class="cc-cities">{{ (c.cities || []).join(', ') }}</span>
          </div>

          <div class="cc-meta">
            Создана: {{ formatDate(c.created_at) }} ·
            Неделя прогрева: {{ c.warmup_week }}
            (лимит: {{ warmupLimit(c.warmup_week) }}/день)
            <span v-if="c.niche"> · Ниша: {{ c.niche }}</span>
          </div>

          <div class="cc-stats">
            📊 Лидов: <b>{{ c.total_prospects }}</b> ·
            Отправлено: <b>{{ c.total_sent }}</b> ·
            Открыто: <b>{{ c.total_opened }}</b> ({{ rate(c.total_opened, c.total_sent) }}%) ·
            Кликов: <b>{{ c.total_clicked }}</b> ({{ rate(c.total_clicked, c.total_sent) }}%) ·
            Ответов: <b>{{ c.total_replied }}</b>
          </div>

          <div v-if="c.error_message" class="cc-error">⚠️ {{ c.error_message }}</div>

          <div class="cc-actions">
            <button class="btn btn-secondary btn-sm" @click="openCampaign(c.id)">Открыть</button>
            <button
              v-if="c.status === 'active'"
              class="btn btn-ghost btn-sm" @click="setStatus(c, 'paused')"
            >⏸ Пауза</button>
            <button
              v-else-if="c.status === 'paused' || c.status === 'draft'"
              class="btn btn-ghost btn-sm" @click="setStatus(c, 'active')"
            >▶ Возобновить</button>
            <button class="btn btn-danger btn-sm" @click="removeCampaign(c)">🗑 Удалить</button>
          </div>
        </div>
      </section>
    </div>
  </AppLayout>
</template>

<script setup>
/**
 * OutreachPage — главная страница модуля Outreach.
 * Форма создания кампании + список карточек кампаний с поллингом.
 * UI в стиле Apple Glassmorphism (фон #F5F5F7, карточки белые, #0071E3).
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useOutreachStore } from '../stores/outreach.js';

const store = useOutreachStore();
const router = useRouter();

const WARMUP_LIMITS = [25, 50, 100, 250, 500];

const CITY_SUGGESTIONS = [
  'Москва', 'Санкт-Петербург', 'Краснодар', 'Екатеринбург', 'Новосибирск',
  'Казань', 'Нижний Новгород', 'Ростов-на-Дону', 'Уфа', 'Самара', 'Пермь',
  'Омск', 'Челябинск', 'Воронеж', 'Волгоград', 'Красноярск', 'Тюмень',
];

const form = ref({
  keyword: '',
  cities: [],
  search_engine: 'yandex',
  depth_pages: 3,
  daily_limit: 500,
  sender_name: '',
});
const cityInput = ref('');
const submitting = ref(false);
const formError = ref('');
const warmupOpen = ref(false);

let pollTimer = null;

function addCity() {
  const city = (cityInput.value || '').trim();
  if (city && !form.value.cities.includes(city)) {
    form.value.cities.push(city);
  }
  cityInput.value = '';
}
function removeCity(i) {
  form.value.cities.splice(i, 1);
}

function warmupLimit(week) {
  return WARMUP_LIMITS[Math.min(Math.max((week || 1) - 1, 0), 4)];
}
function rate(part, total) {
  if (!total) return 0;
  return +((part / total) * 100).toFixed(1);
}
function formatDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return s; }
}

async function createCampaign() {
  formError.value = '';
  if (!form.value.keyword.trim()) { formError.value = 'Укажите нишу / запрос'; return; }
  if (!form.value.cities.length) { formError.value = 'Добавьте хотя бы один город'; return; }

  submitting.value = true;
  try {
    await store.createCampaign({ ...form.value });
    form.value = {
      keyword: '', cities: [], search_engine: 'yandex',
      depth_pages: 3, daily_limit: 500, sender_name: '',
    };
    await store.fetchCampaigns();
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания';
  } finally {
    submitting.value = false;
  }
}

async function setStatus(campaign, status) {
  try {
    await store.updateCampaign(campaign.id, { status });
    await store.fetchCampaigns();
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка обновления';
  }
}

async function removeCampaign(campaign) {
  if (!confirm(`Удалить кампанию «${campaign.name}»? Это действие необратимо.`)) return;
  try {
    await store.deleteCampaign(campaign.id);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка удаления';
  }
}

function openCampaign(id) {
  router.push(`/outreach/campaigns/${id}`);
}

onMounted(() => {
  store.fetchCampaigns();
  pollTimer = setInterval(() => store.fetchCampaigns(), 15000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.outreach-root {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 60px;
  color: #1d1d1f;
}
.page-header h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 6px;
}
.subtitle {
  color: #6e6e73;
  font-size: 15px;
  margin: 0 0 20px;
  max-width: 640px;
}
.card {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.04);
  padding: 20px;
  margin-bottom: 18px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field-wide { grid-column: 1 / -1; }
.field-actions { grid-column: 1 / -1; align-items: flex-start; }
label { font-size: 13px; font-weight: 600; color: #3a3a3c; }
input[type="text"], input[type="number"], select {
  border: 1px solid #d2d2d7;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 15px;
  background: #fbfbfd;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
input:focus, select:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
}
.hint { font-size: 12px; color: #86868b; }
.radio-row { display: flex; gap: 18px; align-items: center; padding-top: 6px; }
.radio { display: flex; gap: 6px; align-items: center; font-weight: 400; font-size: 14px; }

.cities-box {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  border: 1px solid #d2d2d7;
  border-radius: 10px;
  padding: 8px;
  background: #fbfbfd;
}
.city-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eef4ff;
  color: #0071e3;
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 13px;
  font-weight: 600;
}
.chip-x {
  border: none; background: none; cursor: pointer;
  color: #0071e3; font-size: 15px; line-height: 1; padding: 0;
}
.city-add { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 200px; }
.city-add input { flex: 1; }

.btn {
  border: none;
  border-radius: 10px;
  padding: 10px 18px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s, opacity .15s;
}
.btn:disabled { opacity: .5; cursor: default; }
.btn-sm { padding: 7px 12px; font-size: 13px; }
.btn-primary { background: #0071e3; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #0077ed; }
.btn-secondary { background: #f0f0f2; color: #1d1d1f; }
.btn-secondary:hover:not(:disabled) { background: #e5e5ea; }
.btn-ghost { background: #fff; color: #0071e3; border: 1px solid #d2d2d7; }
.btn-danger { background: #fff; color: #d70015; border: 1px solid #f0c0c0; }
.btn-danger:hover:not(:disabled) { background: #fff5f5; }

.form-error {
  margin-top: 12px;
  color: #d70015;
  font-size: 14px;
}

.warmup-card { padding: 0; overflow: hidden; }
.warmup-toggle {
  width: 100%;
  text-align: left;
  background: none; border: none; cursor: pointer;
  padding: 16px 20px;
  font-size: 15px; font-weight: 600; color: #1d1d1f;
  display: flex; justify-content: space-between; align-items: center;
}
.chev { color: #86868b; font-size: 12px; }
.warmup-body {
  padding: 0 20px 18px;
  color: #6e6e73; font-size: 14px; line-height: 1.6;
}

.campaigns { margin-top: 8px; }
.muted { color: #86868b; font-size: 15px; padding: 12px 0; }
.empty { text-align: center; padding: 40px 0; }

.campaign-card { padding: 18px 20px; }
.cc-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.cc-title { display: flex; align-items: center; gap: 10px; }
.cc-title h3 { margin: 0; font-size: 17px; font-weight: 700; }
.cc-cities { color: #86868b; font-size: 13px; text-align: right; }
.status-dot {
  width: 10px; height: 10px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.st-active { background: #34c759; }
.st-paused { background: #ff9f0a; }
.st-draft { background: #8e8e93; }
.st-completed { background: #0071e3; }
.st-error { background: #ff3b30; }
.cc-meta { color: #6e6e73; font-size: 13px; margin: 8px 0; }
.cc-stats { font-size: 14px; color: #1d1d1f; line-height: 1.7; }
.cc-error { color: #d70015; font-size: 13px; margin-top: 8px; }
.cc-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }

@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
}
</style>
