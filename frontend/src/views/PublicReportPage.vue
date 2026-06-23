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
import { collectReportChartImages, downloadBlob } from '../utils/reportExport.js';

const route = useRoute();
const loading = ref(true);
const error = ref(null);
const needPin = ref(false);
const pinError = ref(null);
const pinLoading = ref(false);
const pinRef = ref(null);
const result = ref(null); // { uuid, mode, title, period, project, payload }
const pinLength = ref(4); // адаптируется по длине ввода (4..8)
const viewRange = ref({ from: '', to: '', granularity: 'month' });
const exporting = ref(false);
const previewRef = ref(null);

const api = axios.create({ withCredentials: true, timeout: 30000 });

async function load() {
  loading.value = true; error.value = null; needPin.value = false;
  try {
    const { data } = await api.get(`/api/public/report/${route.params.uuid}`);
    result.value = data;
    if (data?.payload?.data?.period) {
      viewRange.value = {
        from: data.payload.data.period.from || '',
        to: data.payload.data.period.to || '',
        granularity: data.payload.data.period.granularity || 'month',
      };
    }
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

async function applyRange() {
  if (result.value?.mode === 'snapshot') return;
  loading.value = true;
  try {
    const { data } = await api.get(`/api/public/report/${route.params.uuid}`, { params: viewRange.value });
    result.value = data;
  } finally {
    loading.value = false;
  }
}

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

async function exportDocx() {
  if (!previewRef.value) return;
  exporting.value = true;
  try {
    const chartImages = await collectReportChartImages(previewRef.value);
    const { data } = await api.post(`/api/public/report/${route.params.uuid}/export.docx`, {
      ...viewRange.value,
      chart_images: chartImages,
    }, { responseType: 'blob' });
    downloadBlob(data, `${(result.value?.title || 'report').replace(/[^\wа-яё-]+/gi, '_')}.docx`);
  } finally {
    exporting.value = false;
  }
}
async function exportPdf() {
  exporting.value = true;
  try {
    const { data } = await api.post(`/api/public/report/${route.params.uuid}/export.pdf`, {
      ...viewRange.value,
    }, { responseType: 'blob' });
    downloadBlob(data, `${(result.value?.title || 'report').replace(/[^\wа-яё-]+/gi, '_')}.pdf`);
  } finally {
    exporting.value = false;
  }
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
        <div class="public-toolbar">
          <div class="range-grid">
            <input v-model="viewRange.from" type="date" :disabled="result.mode === 'snapshot'" />
            <input v-model="viewRange.to" type="date" :disabled="result.mode === 'snapshot'" />
            <select v-model="viewRange.granularity" :disabled="result.mode === 'snapshot'">
              <option value="day">Дни</option>
              <option value="week">Недели</option>
              <option value="month">Месяцы</option>
            </select>
          </div>
          <div class="toolbar-actions">
            <button class="tool-btn" :disabled="result.mode === 'snapshot'" @click="applyRange">Применить</button>
            <button class="tool-btn" :disabled="exporting" @click="exportDocx">{{ exporting ? 'Экспорт…' : 'Скачать .docx' }}</button>
            <button class="tool-btn" :disabled="exporting" @click="exportPdf">{{ exporting ? 'Экспорт…' : 'Скачать .pdf' }}</button>
          </div>
        </div>
        <div ref="previewRef">
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
        </div>
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
.public-toolbar {
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  background: #fff; border: 1px solid rgba(60,60,67,0.12); border-radius: 16px; padding: 12px;
}
.range-grid { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; flex: 1; }
.range-grid input, .range-grid select {
  border: 1px solid rgba(60,60,67,0.18); border-radius: 10px; padding: 9px 12px; font: inherit; background: #fff;
}
.toolbar-actions { display: flex; gap: 8px; }
.tool-btn {
  border: 0; background: #0a84ff; color: #fff; border-radius: 10px; padding: 10px 14px; cursor: pointer;
}
.tool-btn:disabled { opacity: 0.5; cursor: not-allowed; }

@media (min-width: 375px) { .public-page { padding: 20px 14px; } }
@media (min-width: 768px) { .public-page { padding: 40px 20px; } }
@media (max-width: 720px) {
  .range-grid { grid-template-columns: 1fr; }
  .public-toolbar { flex-direction: column; gap: 8px; }
  .toolbar-actions { justify-content: stretch; }
  .tool-btn { flex: 1; text-align: center; }
}
@media (max-width: 480px) {
  .public-page { padding: 10px 8px; }
  .public-toolbar { padding: 8px; border-radius: 12px; }
  .tool-btn { padding: 10px 10px; font-size: 13px; }
}
</style>
