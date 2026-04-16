<script setup>
import { ref, reactive, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks';

const router = useRouter();
const tasksStore = useTasksStore();

/* ── Reactive form state ─────────────────────────────────────── */
const form = reactive({
  name: '',
  input_keyword: '',
  input_niche: '',
  input_target_audience: '',
  input_tone_of_voice: '',
  input_region: '',
  input_language: 'русский',
  input_competitor_urls: '',
  input_content_type: '',
  input_brand_name: '',
  input_unique_selling_points: '',
  input_word_count: 3000,
  input_additional: ''
});

/* ── Tone / language / content-type options ───────────────────── */
const toneOptions = ['формальный', 'дружелюбный', 'экспертный', 'разговорный'];
const languageOptions = ['русский', 'английский', 'украинский'];
const contentTypeOptions = ['статья', 'лендинг', 'обзор', 'руководство', 'карточка товара'];

/* ── TZ upload state ─────────────────────────────────────────── */
const tzLoading = ref(false);
const tzError = ref('');
const tzSuccess = ref(false);
const tzFileName = ref('');
const isDragOver = ref(false);
const fileInput = ref(null);
const highlightedFields = ref(new Set());

/* ── Submission state ────────────────────────────────────────── */
const submitting = ref(false);
const submitError = ref('');

/* ── TZ field mapping (api response key → form key) ──────────── */
const TZ_FIELD_MAP = {
  keyword: 'input_keyword',
  niche: 'input_niche',
  target_audience: 'input_target_audience',
  tone_of_voice: 'input_tone_of_voice',
  region: 'input_region',
  language: 'input_language',
  content_type: 'input_content_type',
  brand_name: 'input_brand_name',
  unique_selling_points: 'input_unique_selling_points',
  word_count_target: 'input_word_count',
  additional_requirements: 'input_additional'
};

/* ── TZ parse handler ────────────────────────────────────────── */
async function handleTzFile(file) {
  if (!file) return;

  const allowed = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(file.type) && !['pdf', 'docx', 'txt'].includes(ext)) {
    tzError.value = 'Поддерживаемые форматы: .pdf, .docx, .txt';
    return;
  }

  tzFileName.value = file.name;
  tzError.value = '';
  tzSuccess.value = false;
  tzLoading.value = true;

  try {
    const data = await tasksStore.parseTz(file);

    const filled = [];

    // Map standard fields
    for (const [apiKey, formKey] of Object.entries(TZ_FIELD_MAP)) {
      if (data[apiKey] != null && data[apiKey] !== '') {
        form[formKey] = data[apiKey];
        filled.push(formKey);
      }
    }

    // competitor_urls is an array → join with newlines
    if (Array.isArray(data.competitor_urls) && data.competitor_urls.length > 0) {
      form.input_competitor_urls = data.competitor_urls.join('\n');
      filled.push('input_competitor_urls');
    }

    // Flash highlight on filled fields
    highlightedFields.value = new Set(filled);
    await nextTick();
    setTimeout(() => {
      highlightedFields.value = new Set();
    }, 2000);

    tzSuccess.value = true;
    setTimeout(() => {
      tzSuccess.value = false;
    }, 4000);
  } catch (err) {
    tzError.value = err.response?.data?.error || 'Ошибка при анализе файла';
  } finally {
    tzLoading.value = false;
  }
}

/* ── Drag & drop handlers ────────────────────────────────────── */
function onDragOver(e) {
  e.preventDefault();
  isDragOver.value = true;
}
function onDragLeave() {
  isDragOver.value = false;
}
function onDrop(e) {
  e.preventDefault();
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  handleTzFile(file);
}
function onFileSelect(e) {
  const file = e.target.files?.[0];
  handleTzFile(file);
  e.target.value = '';
}
function openFilePicker() {
  fileInput.value?.click();
}

/* ── Submit handler ──────────────────────────────────────────── */
async function handleSubmit() {
  submitError.value = '';
  submitting.value = true;
  try {
    const payload = { name: form.name };
    for (const key of Object.keys(form)) {
      if (key.startsWith('input_') && form[key] !== '' && form[key] != null) {
        payload[key] = form[key];
      }
    }
    const task = await tasksStore.createTask(payload);
    router.push(`/tasks/${task.id}/monitor`);
  } catch (err) {
    submitError.value = err.response?.data?.error || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

/* ── Highlight helper ────────────────────────────────────────── */
function fieldClass(fieldKey) {
  return highlightedFields.value.has(fieldKey)
    ? 'ring-2 ring-green-400 border-green-400 transition-all duration-500'
    : '';
}
</script>

<template>
  <div class="max-w-4xl mx-auto px-4 py-8">
    <h1 class="text-2xl font-bold text-gray-800 mb-6">Создать задачу</h1>

    <!-- ══════════ TZ UPLOAD DROPZONE ══════════ -->
    <div class="card mb-8 relative overflow-hidden">
      <!-- Loading overlay -->
      <div
        v-if="tzLoading"
        class="absolute inset-0 bg-white/80 z-10 flex flex-col items-center justify-center rounded-xl"
      >
        <div class="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="mt-3 text-blue-700 font-medium">Анализируем ТЗ...</p>
      </div>

      <div
        class="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200"
        :class="[
          isDragOver
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
        ]"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
        @click="openFilePicker"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".pdf,.docx,.txt"
          class="hidden"
          @change="onFileSelect"
        />

        <!-- Upload icon -->
        <svg
          class="mx-auto h-12 w-12 text-gray-400 mb-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 48 48"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M24 8v24m0-24l-8 8m8-8l8 8M8 36h32"
          />
        </svg>

        <p class="text-lg font-medium text-gray-700 mb-1">
          Загрузите ТЗ для автозаполнения
        </p>
        <p class="text-sm text-gray-400">
          Перетащите файл сюда или нажмите для выбора — .pdf, .docx, .txt
        </p>

        <p v-if="tzFileName && !tzLoading" class="mt-3 text-sm text-blue-600 font-medium">
          📄 {{ tzFileName }}
        </p>
      </div>

      <!-- Success toast -->
      <Transition name="fade">
        <div
          v-if="tzSuccess"
          class="mt-3 bg-green-50 text-green-700 border border-green-200 rounded-lg px-4 py-2 text-sm flex items-center gap-2"
        >
          <svg class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
          Поля заполнены из ТЗ
        </div>
      </Transition>

      <!-- Error -->
      <div
        v-if="tzError"
        class="mt-3 bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-2 text-sm"
      >
        {{ tzError }}
      </div>
    </div>

    <!-- ══════════ FORM ══════════ -->
    <form @submit.prevent="handleSubmit" class="space-y-6">
      <div
        v-if="submitError"
        class="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 text-sm"
      >
        {{ submitError }}
      </div>

      <!-- Task name -->
      <div class="card">
        <label class="block text-sm font-medium text-gray-700 mb-1">Название задачи *</label>
        <input
          v-model="form.name"
          type="text"
          required
          class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          :class="fieldClass('name')"
          placeholder="Например: SEO-статья про фитнес"
        />
      </div>

      <div class="card space-y-5">
        <h2 class="text-lg font-semibold text-gray-800 border-b pb-2">Параметры контента</h2>

        <!-- Keyword -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Ключевой запрос *</label>
          <input
            v-model="form.input_keyword"
            type="text"
            required
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            :class="fieldClass('input_keyword')"
            placeholder="Основной ключевой запрос"
          />
        </div>

        <!-- Niche -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Ниша бизнеса</label>
          <input
            v-model="form.input_niche"
            type="text"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            :class="fieldClass('input_niche')"
            placeholder="Финансы, здоровье, технологии..."
          />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <!-- Content type -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Тип контента</label>
            <select
              v-model="form.input_content_type"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              :class="fieldClass('input_content_type')"
            >
              <option value="">— выберите —</option>
              <option v-for="opt in contentTypeOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>

          <!-- Tone of voice -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Тон коммуникации</label>
            <select
              v-model="form.input_tone_of_voice"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              :class="fieldClass('input_tone_of_voice')"
            >
              <option value="">— выберите —</option>
              <option v-for="opt in toneOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>

          <!-- Language -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Язык</label>
            <select
              v-model="form.input_language"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              :class="fieldClass('input_language')"
            >
              <option v-for="opt in languageOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </div>

          <!-- Region -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Регион</label>
            <input
              v-model="form.input_region"
              type="text"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              :class="fieldClass('input_region')"
              placeholder="Россия, Украина, весь мир..."
            />
          </div>
        </div>

        <!-- Target audience -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Целевая аудитория</label>
          <textarea
            v-model="form.input_target_audience"
            rows="2"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y"
            :class="fieldClass('input_target_audience')"
            placeholder="Опишите вашу целевую аудиторию"
          ></textarea>
        </div>

        <!-- Brand name -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Название бренда/компании</label>
          <input
            v-model="form.input_brand_name"
            type="text"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            :class="fieldClass('input_brand_name')"
            placeholder="Ваш бренд"
          />
        </div>

        <!-- USP -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">УТП (уникальные торговые преимущества)</label>
          <textarea
            v-model="form.input_unique_selling_points"
            rows="2"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y"
            :class="fieldClass('input_unique_selling_points')"
            placeholder="Чем вы отличаетесь от конкурентов"
          ></textarea>
        </div>

        <!-- Competitor URLs -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">URL конкурентов (по одному на строку)</label>
          <textarea
            v-model="form.input_competitor_urls"
            rows="3"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y font-mono text-sm"
            :class="fieldClass('input_competitor_urls')"
            placeholder="https://competitor1.com/page&#10;https://competitor2.com/page"
          ></textarea>
        </div>

        <!-- Word count -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Целевое количество слов</label>
          <input
            v-model.number="form.input_word_count"
            type="number"
            min="100"
            max="50000"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            :class="fieldClass('input_word_count')"
          />
        </div>

        <!-- Additional -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Дополнительные требования</label>
          <textarea
            v-model="form.input_additional"
            rows="3"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y"
            :class="fieldClass('input_additional')"
            placeholder="Любые дополнительные пожелания..."
          ></textarea>
        </div>
      </div>

      <!-- Submit -->
      <div class="flex justify-end gap-3">
        <router-link to="/dashboard" class="btn bg-gray-200 text-gray-700 hover:bg-gray-300">
          Отмена
        </router-link>
        <button
          type="submit"
          :disabled="submitting"
          class="btn-primary px-8"
        >
          <span v-if="submitting" class="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></span>
          {{ submitting ? 'Создаём...' : 'Создать задачу' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
