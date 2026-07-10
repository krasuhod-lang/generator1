<script setup>
/**
 * AuditSharedPage — публичная клиентская страница отчёта аудита /audit/share/:token (ТЗ 9).
 *
 * Урезанный дашборд для клиента: шапка «SEO-аудит: домен», большой цветной
 * Health Score, ошибки в аккордеоне с человеческими объяснениями
 * (из ISSUE_DEFS), зелёный блок «Что мы исправим» и CTA «Заказать исправление».
 * Вкладка «Страницы» и технические детали скрыты.
 * Без авторизации; данные отдаёт GET /api/public/audit/:token.
 */
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import IssueAccordion from '../components/IssueAccordion.vue';
import api from '../api.js';

const route = useRoute();

const loading = ref(true);
const error = ref(null);
const data = ref(null);
const ctaOpen = ref(false);
const ctaName = ref('');
const ctaContact = ref('');
const ctaSent = ref(false);

const summary = computed(() => data.value?.summary || {});
const issueDefs = computed(() => data.value?.issue_defs || {});
const groups = computed(() => data.value?.issue_groups || []);

function scoreColor(score) {
  if (score == null) return '#6b7280';
  if (score >= 80) return '#16a34a';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}
const scoreDash = computed(() => {
  const s = Number(summary.value.health_score) || 0;
  const c = 2 * Math.PI * 62;
  return `${(s / 100) * c} ${c}`;
});
function scoreVerdict(score) {
  if (score == null) return '';
  if (score >= 80) return 'Хорошее состояние сайта';
  if (score >= 50) return 'Есть проблемы, требующие внимания';
  return 'Критическое состояние — нужны срочные исправления';
}

function submitCta() {
  // Заявка уходит по mailto (простая форма без бэкенда заявок)
  const subj = encodeURIComponent(`Заявка на исправление: SEO-аудит ${data.value?.host || ''}`);
  const body = encodeURIComponent(
    `Имя: ${ctaName.value}\nКонтакт: ${ctaContact.value}\nОтчёт: ${window.location.href}`);
  window.location.href = `mailto:?subject=${subj}&body=${body}`;
  ctaSent.value = true;
}

onMounted(async () => {
  try {
    const { data: resp } = await api.get(`/public/audit/${route.params.token}`);
    data.value = resp;
  } catch (e) {
    error.value = e.response?.status === 404
      ? 'Ссылка не найдена, отозвана или срок её действия истёк.'
      : 'Не удалось загрузить отчёт. Попробуйте позже.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="shared-audit">
    <div v-if="loading" class="center muted">Загрузка отчёта…</div>
    <div v-else-if="error" class="center card error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Шапка -->
      <header class="head card">
        <div class="head-title">SEO-аудит: <b>{{ data.host }}</b></div>
        <div class="muted">Подготовил: агентство ·
          {{ data.finished_at ? new Date(data.finished_at).toLocaleDateString('ru-RU') : '' }}</div>
      </header>

      <!-- Health Score -->
      <section class="card score-plate">
        <svg viewBox="0 0 140 140" class="score-svg">
          <circle cx="70" cy="70" r="62" fill="none" stroke="#e5e7eb" stroke-width="12" />
          <circle cx="70" cy="70" r="62" fill="none"
                  :stroke="scoreColor(summary.health_score)" stroke-width="12"
                  stroke-linecap="round" :stroke-dasharray="scoreDash"
                  transform="rotate(-90 70 70)" />
          <text x="70" y="78" text-anchor="middle" class="score-text"
                :fill="scoreColor(summary.health_score)">{{ summary.health_score }}</text>
        </svg>
        <div class="score-meta">
          <div class="score-verdict" :style="{ color: scoreColor(summary.health_score) }">
            {{ scoreVerdict(summary.health_score) }}</div>
          <div class="sev-counters">
            <div class="sev-counter sev-critical"><b>{{ summary.issues_critical }}</b><span>Critical</span></div>
            <div class="sev-counter sev-high"><b>{{ summary.issues_high }}</b><span>High</span></div>
            <div class="sev-counter sev-medium"><b>{{ summary.issues_medium }}</b><span>Medium</span></div>
            <div class="sev-counter sev-low"><b>{{ summary.issues_low }}</b><span>Low</span></div>
          </div>
          <div class="muted">Проверено {{ summary.total_pages }} страниц</div>
        </div>
      </section>

      <!-- Что мы исправим -->
      <section v-if="data.fix_note" class="card fix-note">
        <h3>✅ Что мы исправим</h3>
        <p>{{ data.fix_note }}</p>
      </section>

      <!-- Ошибки в аккордеоне -->
      <section class="card">
        <h3>Найденные проблемы</h3>
        <IssueAccordion :groups="groups" :defs="issueDefs" :duplicates="data.duplicates || {}" />
      </section>

      <!-- CTA -->
      <section class="card cta">
        <template v-if="!ctaOpen">
          <button class="cta-btn" @click="ctaOpen = true">Заказать исправление</button>
        </template>
        <template v-else-if="!ctaSent">
          <h3>Заявка на исправление</h3>
          <div class="cta-form">
            <input v-model="ctaName" placeholder="Ваше имя" />
            <input v-model="ctaContact" placeholder="Телефон или email" />
            <button class="cta-btn" :disabled="!ctaContact.trim()" @click="submitCta">Отправить заявку</button>
          </div>
        </template>
        <p v-else class="cta-thanks">Спасибо! Мы свяжемся с вами в ближайшее время.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.shared-audit { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem; color: #1f2937;
                font-family: system-ui, -apple-system, sans-serif; }
.center { text-align: center; padding: 3rem 0; }
.muted { color: #6b7280; }
.error { color: #b91c1c; }
.card { background: #fff; border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 1rem;
        box-shadow: 0 1px 3px rgba(0,0,0,.06); border: 1px solid #e5e7eb; }
.head-title { font-size: 1.25rem; }

.score-plate { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
.score-svg { width: 160px; height: 160px; flex: none; }
.score-text { font-size: 2.6rem; font-weight: 800; }
.score-meta { flex: 1; min-width: 260px; }
.score-verdict { font-size: 1.1rem; font-weight: 700; margin-bottom: .6rem; }
.sev-counters { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: .5rem; }
.sev-counter { border-radius: 8px; padding: .5rem .9rem; min-width: 84px; text-align: center; }
.sev-counter b { display: block; font-size: 1.35rem; }
.sev-counter span { font-size: .7rem; text-transform: uppercase; font-weight: 600; }
.sev-counter.sev-critical { background: #fee2e2; color: #7f1d1d; }
.sev-counter.sev-high     { background: #ffedd5; color: #7c2d12; }
.sev-counter.sev-medium   { background: #fef9c3; color: #713f12; }
.sev-counter.sev-low      { background: #f3f4f6; color: #374151; }

.fix-note { background: #f0fdf4; border-color: #bbf7d0; }
.fix-note h3 { margin: 0 0 .4rem; color: #166534; }
.fix-note p { margin: 0; white-space: pre-line; }

h3 { margin-top: 0; }

.cta { text-align: center; }
.cta-btn { background: #16a34a; color: #fff; border: 0; border-radius: 8px;
           padding: .7rem 1.6rem; font-size: 1rem; font-weight: 700; cursor: pointer; }
.cta-btn:hover { background: #15803d; }
.cta-btn:disabled { background: #9ca3af; cursor: default; }
.cta-form { display: flex; gap: .5rem; justify-content: center; flex-wrap: wrap; margin-top: .5rem; }
.cta-form input { padding: .55rem .7rem; border: 1px solid #cbd5e1; border-radius: 6px; min-width: 220px; }
.cta-thanks { color: #166534; font-weight: 600; }
</style>
