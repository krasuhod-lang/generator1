<script setup>
/**
 * ForecasterPrefillV2 — отдельный компонент «Заполнить по сайту» (V2).
 *
 * Самодостаточный: свои поля (домен + город), свой вызов API, свой индикатор
 * загрузки (спиннер + прогресс-бар). На успехе эмитит `apply` с готовым
 * payload — родитель раскладывает его по полям формы. Существующую логику формы
 * не заменяет — это ДОПОЛНЕНИЕ.
 *
 * keys.so отвечает небыстро → показываем движущийся прогресс-бар и подсказку,
 * чтобы не казалось, что «зависло».
 */
import { ref } from 'vue';
import api from '../api.js';

const emit = defineEmits(['apply']);

const domain  = ref('');
const region  = ref('');
const loading = ref(false);
const error   = ref(null);
const info    = ref(null);

async function run() {
  const d = domain.value.trim();
  if (!d || loading.value) return;
  loading.value = true;
  error.value = null;
  info.value = null;
  try {
    // keys.so отвечает небыстро — даём запас по времени (2 мин).
    const { data } = await api.post('/forecaster/prefill-from-domain', {
      domain: d,
      region: region.value.trim(),
      max_keywords: 300,
    }, { timeout: 120000 });
    const m = data.meta || {};
    const traffic = (m.traffic_month || 0).toLocaleString('ru-RU');
    info.value = `Собрано: ${m.keywords_count || 0} запросов · трафик ~${traffic}/мес. Проверьте поля ниже и запустите.`;
    emit('apply', data);
  } catch (e) {
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
    error.value = isTimeout
      ? 'keys.so долго отвечает — попробуйте ещё раз через минуту (или проверьте домен/регион).'
      : (e.response?.data?.error || e.message || 'Не удалось получить данные');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="rounded-lg border border-indigo-700/50 bg-indigo-950/30 p-3 space-y-2">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-sm font-semibold text-indigo-300">✨ Заполнить по сайту</span>
      <span class="text-[11px] text-gray-500">— подтянем ключи, трафик и вводные автоматически</span>
    </div>

    <div class="flex flex-col sm:flex-row gap-2">
      <input
        v-model="domain" type="text" maxlength="253" :disabled="loading"
        @keyup.enter="run"
        class="flex-1 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 disabled:opacity-60"
        placeholder="site.ru" />
      <input
        v-model="region" type="text" maxlength="100" :disabled="loading"
        @keyup.enter="run"
        class="sm:w-44 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 disabled:opacity-60"
        placeholder="Город (напр. Москва)" />
      <button
        type="button" @click="run" :disabled="loading || !domain.trim()"
        class="px-4 py-2 rounded text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-500
               disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 justify-center whitespace-nowrap">
        <svg v-if="loading" class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
        </svg>
        {{ loading ? 'Собираю…' : 'Заполнить' }}
      </button>
    </div>

    <!-- Живой прогресс-бар на время запроса к keys.so (он небыстрый) -->
    <div v-if="loading" class="space-y-1">
      <div class="pb-track"><div class="pb-fill"></div></div>
      <p class="text-[11px] text-indigo-300/80">
        Собираю данные из keys.so — это занимает несколько секунд, подождите…
      </p>
    </div>

    <p v-if="info" class="text-[11px] text-emerald-400">{{ info }}</p>
    <p v-if="error" class="text-[11px] text-red-400">{{ error }}</p>
  </div>
</template>

<style scoped>
.pb-track {
  height: 4px;
  background: rgba(99, 102, 241, 0.18);
  border-radius: 999px;
  overflow: hidden;
}
.pb-fill {
  height: 100%;
  width: 40%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6366f1, #818cf8);
  animation: pb-slide 1.15s ease-in-out infinite;
}
@keyframes pb-slide {
  0%   { margin-left: -40%; }
  100% { margin-left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .pb-fill { animation: none; width: 100%; opacity: 0.6; }
}
</style>
