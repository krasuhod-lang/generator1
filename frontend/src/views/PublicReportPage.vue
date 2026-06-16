<script setup>
/**
 * PublicReportPage — публичная read-only страница отчёта на /r/:uuid.
 * Не требует авторизации. Использует raw axios (без bearer).
 */
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import ReportRenderer from '../components/reports/ReportRenderer.vue';
import PinGate from '../components/reports/PinGate.vue';

const route = useRoute();
const loading = ref(true);
const error = ref(null);
const needPin = ref(false);
const pinError = ref(null);
const pinLoading = ref(false);
const pinRef = ref(null);
const result = ref(null); // { uuid, mode, title, period, project, payload }
const pinLength = ref(4); // адаптируется по длине ввода (4..8)

const api = axios.create({ withCredentials: true, timeout: 30000 });

async function load() {
  loading.value = true; error.value = null; needPin.value = false;
  try {
    const { data } = await api.get(`/api/public/report/${route.params.uuid}`);
    result.value = data;
  } catch (err) {
    if (err.response?.status === 403 && err.response?.data?.error === 'password_required') {
      needPin.value = true;
    } else if (err.response?.status === 410) {
      error.value = err.response.data?.error === 'expired'
        ? 'Срок действия ссылки истёк.'
        : 'Ссылка отозвана.';
    } else if (err.response?.status === 404) {
      error.value = 'Отчёт не найден.';
    } else {
      error.value = err.response?.data?.error || err.message || 'Ошибка';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function submitPin(pin) {
  pinLoading.value = true; pinError.value = null;
  try {
    await api.post(`/api/public/report/${route.params.uuid}/unlock`, { pin });
    needPin.value = false;
    await load();
  } catch (err) {
    if (err.response?.status === 401) pinError.value = 'Неверный PIN. Попробуйте ещё раз.';
    else pinError.value = err.response?.data?.error || err.message || 'Ошибка';
    pinRef.value?.reset();
  } finally {
    pinLoading.value = false;
  }
}

function trySetPinLength(n) {
  // Если сервер сообщает требуемую длину PIN — можно адаптировать.
  // Сейчас фиксированно 4. Оставляем хук на будущее.
  pinLength.value = Math.max(4, Math.min(8, n));
}
</script>

<template>
  <div class="public-page">
    <div v-if="loading" class="status">Загрузка отчёта…</div>
    <div v-else-if="error" class="status err">{{ error }}</div>
    <PinGate v-else-if="needPin" ref="pinRef" :length="pinLength" :loading="pinLoading" :error="pinError" @submit="submitPin" />
    <div v-else-if="result" class="public-shell"
         :style="{ '--accent': result.project?.color_accent || '#0071e3' }">
      <div class="public-inner">
        <ReportRenderer
          :data="result.payload?.data"
          :summary="result.payload?.summary || {}"
          :tasks-blocks="result.payload?.tasks_blocks || []"
          :title="result.title"
          :period="result.period"
          :project="result.project"
          :mode="result.mode"
          :captured-at="result.payload?.captured_at"
          :readonly="true" />
        <div class="public-footer">
          <span>Отчёт сформирован автоматически · Smart Report Builder</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.public-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #f5f5f7 0%, #ececef 100%);
  color: #1d1d1f;
  color-scheme: light;
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", Roboto, Inter, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.01em;
}
.status { padding: 80px 24px; text-align: center; color: #6e6e73; font-size: 16px; }
.status.err { color: #d70015; }
.public-shell { max-width: 1080px; margin: 0 auto; }
.public-inner { display: flex; flex-direction: column; gap: 16px; }
.public-footer { text-align: center; padding: 16px 0 36px; color: #86868b; font-size: 12px; letter-spacing: 0.02em; }

@media (min-width: 375px) { .public-page { padding: 20px 14px; } }
@media (min-width: 768px) { .public-page { padding: 40px 20px; } }
</style>
