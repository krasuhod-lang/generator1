<script setup>
import { ref, reactive, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';

const route  = useRoute();
const router = useRouter();
const store  = useTasksStore();

const isEdit  = computed(() => !!route.params.id);
const loading = ref(false);
const saving  = ref(false);
const error   = ref('');

// Секции аккордеона
const openSections = reactive({ s1: true, s2: false, s3: false, s4: false, s5: false });
function toggle(key) { openSections[key] = !openSections[key]; }

// Форма
const form = reactive({
  input_target_service:  '',
  input_brand_name:      '',
  input_author_name:     '',
  input_region:          '',
  input_language:        'ru', // Язык
  input_business_type:   '',   // Тип бизнеса
  input_site_type:       '',   // Тип сайта
  input_target_audience: '',   // Целевая аудитория
  input_business_goal:   '',   // Приоритетная бизнес-цель
  input_monetization:    '',   // Основной тип монетизации
  input_project_limits:  '',   // Ограничения проекта
  input_page_priorities: '',   // Приоритетные типы страниц
  input_niche_features:  '',   // Особенности ниши
  input_raw_lsi:         '',
  input_ngrams:          '',
  input_tfidf_json:      '[]',
  input_brand_facts:     '',
  input_competitor_urls: '',
  input_min_chars:       800,
  input_max_chars:       3500,
  title:                 '',
});

// Загружаем черновик при редактировании
onMounted(async () => {
  if (isEdit.value) {
    loading.value = true;
    try {
      const task = await store.fetchTask(route.params.id);
      if (task) Object.keys(form).forEach(k => { if (task[k] !== undefined) form[k] = task[k]; });
    } catch (e) {
      error.value = 'Не удалось загрузить задачу';
    } finally {
      loading.value = false;
    }
  }
});

// TF-IDF предпросмотр
const tfidfParsed = computed(() => {
  try {
    const arr = JSON.parse(form.input_tfidf_json);
    return Array.isArray(arr) ? arr.slice(0, 15) : [];
  } catch { return []; }
});

// LSI счётчик
const lsiCount = computed(() =>
  form.input_raw_lsi.split('\n').map(s => s.trim()).filter(Boolean).length
);

// Загрузка DOCX
const docxFile       = ref(null);
const docxUploading  = ref(false);
const docxMsg        = ref('');
const docxError      = ref('');

// LLM-анализ ТЗ (Pre-Stage -1)
const llmFile      = ref(null);
const llmUploading = ref(false);
const llmMsg       = ref('');
const llmError     = ref('');

// Маппинг полей extracted → form
const LLM_FIELD_MAP = {
  niche:            'input_target_service',   // используем как запасной вариант если пустой
  keyword:          'input_target_service',
  geo:              'input_region',
  language:         'input_language',
  business_type:    'input_business_type',
  site_type:        'input_site_type',
  target_audience:  'input_target_audience',
  business_goal:    'input_business_goal',
  monetization:     'input_monetization',
  constraints:      'input_project_limits',
  priority_page_types: 'input_page_priorities',
  niche_features:   'input_niche_features',
};

// Допустимые значения для select-полей (должны совпадать с <option value="...">)
const SELECT_OPTIONS = {
  input_language:      ['ru', 'en', 'kk'],
  input_business_type: ['SaaS', 'e-commerce', 'услуги', 'affiliate', 'media', 'marketplace', 'local business', 'B2B', 'B2C', 'D2C', 'review-site', 'publisher', 'aggregator', 'expert brand'],
  input_site_type:     ['новый', 'растущий', 'зрелый', 'сильный бренд', 'слабый бренд'],
  input_business_goal: ['трафик', 'лиды', 'продажи', 'бренд', 'AI visibility', 'topical authority', 'revenue growth'],
  input_monetization:  ['лиды', 'подписка', 'продажа товаров', 'реклама', 'affiliate', 'freemium', 'enterprise sales', 'demo', 'consultation', 'booking', 'marketplace fee'],
};

/**
 * Нормализует значение для select-поля: находит ближайшее совпадение
 * по регистронезависимому сравнению. Возвращает '' если нет совпадения.
 */
function normalizeSelectValue(formKey, rawValue) {
  const options = SELECT_OPTIONS[formKey];
  if (!options) return rawValue; // текстовое поле — без нормализации
  const lower = rawValue.trim().toLowerCase();
  const match = options.find(o => o.toLowerCase() === lower);
  return match || ''; // если нет точного совпадения — не подставляем
}

async function handleLLMTzUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  llmFile.value  = file;
  llmMsg.value   = '';
  llmError.value = '';
  llmUploading.value = true;

  try {
    const result = await store.parseTZWithLLM(file);
    const ext = result?.extracted || {};
    let filled = 0;

    for (const [extKey, formKey] of Object.entries(LLM_FIELD_MAP)) {
      const val = ext[extKey];
      if (val === null || val === undefined || val === '') continue;
      // Массивы → строка через новую строку
      const strVal = Array.isArray(val) ? val.join('\n') : String(val);
      if (!strVal.trim()) continue;
      // Не перезаписываем уже заполненное поле (кроме явного Intent из keyword)
      if (extKey === 'niche' && form[formKey]?.trim()) continue;
      // Нормализуем значения для select-полей (регистронезависимое совпадение)
      const normalized = normalizeSelectValue(formKey, strVal);
      if (normalized === '' && SELECT_OPTIONS[formKey]) continue; // нет совпадения — пропускаем select
      form[formKey] = normalized;
      filled++;
    }

    // competitor_urls — отдельно, т.к. нужно объединить urls и names
    const urls  = (ext.competitor_urls  || []).join('\n');
    const names = (ext.competitor_names || []).join('\n');
    if (urls || names) {
      form.input_competitor_urls = [urls, names].filter(Boolean).join('\n');
      filled++;
    }

    // known_terms → добавляем к LSI если поле пустое
    if (ext.known_terms?.length && !form.input_raw_lsi.trim()) {
      form.input_raw_lsi = ext.known_terms.join('\n');
      filled++;
    }

    // tone_of_voice / additional_notes → brand_facts если пустые
    if (ext.tone_of_voice && !form.input_brand_facts?.trim()) {
      form.input_brand_facts = ext.tone_of_voice;
      filled++;
    }

    // Открываем секции с заполненными данными
    if (ext.keyword || ext.niche)        openSections.s1 = true;
    if (ext.known_terms?.length)         openSections.s2 = true;
    if (ext.competitor_urls?.length || ext.competitor_names?.length) openSections.s4 = true;

    // Автоматически создаём черновик и сохраняем заполненные данные
    if (filled > 0) {
      // Гарантируем, что обязательное поле заполнено для создания черновика
      if (!form.input_target_service.trim()) {
        form.input_target_service = 'Черновик';
      }

      if (!isEdit.value && !store.current?.id) {
        // Новая задача — создаём черновик автоматически
        await saveDraft({ silent: true });
        const taskId = store.current?.id;
        if (taskId) {
          router.replace(`/tasks/${taskId}/edit`);
        }
      } else {
        // Уже существующая задача — сохраняем обновлённые поля
        const taskId = isEdit.value ? route.params.id : store.current?.id;
        if (taskId) {
          try {
            await store.updateTask(taskId, { ...form });
          } catch (_) { /* поля уже в форме, ошибка не критична */ }
        }
      }
    }

    llmMsg.value = filled > 0
      ? `ИИ заполнил ${filled} полей. Проверьте и при необходимости скорректируйте.`
      : 'ТЗ проанализировано, но распознаваемых полей не найдено — заполните вручную.';
  } catch (err) {
    llmError.value = err.response?.data?.error || err.message || 'Ошибка анализа ТЗ';
  } finally {
    llmUploading.value = false;
    // Сбрасываем input чтобы можно было повторно выбрать тот же файл
    e.target.value = '';
  }
}

async function handleDocxUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  docxFile.value  = file;
  docxMsg.value   = '';
  docxError.value = '';

  // Если задача ещё не создана — создаём черновик автоматически (без редиректа)
  if (!isEdit.value && !store.current?.id) {
    // Временно подставляем placeholder если поле пустое
    const hadEmpty = !form.input_target_service.trim();
    if (hadEmpty) form.input_target_service = 'Черновик';
    await saveDraft({ silent: true });
    if (hadEmpty) form.input_target_service = '';
    if (error.value) return;
  }

  const taskId = isEdit.value ? route.params.id : store.current?.id;
  if (!taskId) { docxError.value = 'Не удалось создать черновик'; return; }

  docxUploading.value = true;
  try {
    const result = await store.uploadTZ(taskId, file);
    // Подставляем распознанные поля в форму
    const pf = result?.parsedFields || {};
    const fieldMap = [
      'input_target_service',
      'input_min_chars',
      'input_max_chars',
      'input_competitor_urls',
      'input_raw_lsi',
      'input_ngrams',
      'input_tfidf_json',
    ];
    let filled = 0;
    for (const key of fieldMap) {
      if (pf[key] !== undefined && pf[key] !== '' && pf[key] !== null) {
        form[key] = pf[key];
        filled++;
      }
    }
    docxMsg.value = filled > 0
      ? `ТЗ распознано: заполнено ${filled} полей`
      : 'Файл загружен (поля не распознаны — заполните вручную)';
    // Открываем секции с заполненными данными
    if (pf.input_target_service) openSections.s1 = true;
    if (pf.input_raw_lsi)        openSections.s2 = true;
    if (pf.input_competitor_urls) openSections.s4 = true;
    // Сохраняем распознанные поля на сервер ПЕРЕД router.replace
    // чтобы при повторном onMounted форма загрузилась уже заполненной
    if (filled > 0) {
      try {
        await store.updateTask(taskId, { ...form });
      } catch (_) { /* игнорируем ошибку сохранения, поля уже в форме */ }
    }
    // Обновляем URL на /edit если задача только что создана
    if (!isEdit.value && taskId) {
      router.replace(`/tasks/${taskId}/edit`);
    }
  } catch (err) {
    docxError.value = err.response?.data?.error || 'Ошибка загрузки файла';
  } finally {
    docxUploading.value = false;
  }
}

// Сохранить черновик
async function saveDraft({ silent = false } = {}) {
  saving.value = true;
  error.value  = '';
  try {
    const payload = { ...form };
    if (!payload.title) payload.title = payload.input_target_service || 'Черновик';

    if (isEdit.value) {
      await store.updateTask(route.params.id, payload);
    } else {
      const task = await store.createTask(payload);
      if (!silent) router.replace(`/tasks/${task.id}/edit`);
    }
  } catch (e) {
    error.value = e.response?.data?.error || 'Ошибка сохранения';
  } finally {
    saving.value = false;
  }
}

// Запустить задачу
async function startTask() {
  await saveDraft();
  if (error.value) return;
  const id = isEdit.value ? route.params.id : store.current?.id;
  if (!id) return;
  try {
    await store.startTask(id);
    router.push(`/tasks/${id}/monitor`);
  } catch (e) {
    error.value = e.response?.data?.errors?.join('; ') || e.response?.data?.error || 'Ошибка запуска';
  }
}

// Валидация кнопки запуска
const canStart = computed(() =>
  form.input_target_service.trim() &&
  form.input_target_service.trim() !== 'Черновик' &&
  form.input_brand_name.trim() &&
  form.input_author_name.trim() &&
  form.input_region.trim() &&
  lsiCount.value >= 5
);
</script>

<template>
  <div class="min-h-screen bg-gray-950">
    <!-- Шапка -->
    <header class="border-b border-gray-800 bg-gray-900 px-6 py-3 flex items-center gap-4">
      <RouterLink to="/dashboard" class="btn-ghost text-xs">
        ← Назад
      </RouterLink>
      <span class="text-white font-semibold">{{ isEdit ? 'Редактировать задачу' : 'Новая задача' }}</span>
    </header>

    <main class="max-w-3xl mx-auto px-6 py-8">
      <div v-if="loading" class="text-center py-20 text-gray-500">Загрузка...</div>

      <div v-else class="space-y-3">

        <!-- ── Секция 1: Основные данные ──────────────────────────── -->
        <div class="card p-0 overflow-hidden">
          <button
            @click="toggle('s1')"
            class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
          >
            <span class="font-medium text-white">1. Основные данные</span>
            <span class="text-gray-400 text-lg">{{ openSections.s1 ? '▲' : '▼' }}</span>
          </button>
          <div v-show="openSections.s1" class="px-5 pb-5 space-y-4 border-t border-gray-800">
            <div class="pt-4">
              <label class="label">H1 / Целевая услуга <span class="text-red-500">*</span></label>
              <input v-model="form.input_target_service" type="text" class="input"
                placeholder="Кредит наличными МФО Алматы" required />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="label">Название бренда <span class="text-red-500">*</span></label>
                <input v-model="form.input_brand_name" type="text" class="input" placeholder="FinGroup" />
              </div>
              <div>
                <label class="label">Имя автора <span class="text-red-500">*</span></label>
                <input v-model="form.input_author_name" type="text" class="input" placeholder="Иван Петров" />
              </div>
            </div>
            <div>
              <label class="label">Регион <span class="text-red-500">*</span></label>
              <input v-model="form.input_region" type="text" class="input" placeholder="Алматы, Казахстан" />
            </div>
            <div>
              <label class="label">Язык</label>
              <select v-model="form.input_language" class="input">
                <option value="ru">Русский</option>
                <option value="en">English</option>
                <option value="kk">Қазақша</option>
              </select>
            </div>
            <div>
              <label class="label">Тип бизнеса</label>
              <select v-model="form.input_business_type" class="input">
                <option value="">Не указано</option>
                <option value="SaaS">SaaS</option>
                <option value="e-commerce">E-commerce</option>
                <option value="услуги">Услуги</option>
                <option value="affiliate">Affiliate</option>
                <option value="media">Media</option>
                <option value="marketplace">Marketplace</option>
                <option value="local business">Local Business</option>
                <option value="B2B">B2B</option>
                <option value="B2C">B2C</option>
                <option value="D2C">D2C</option>
                <option value="review-site">Review Site</option>
                <option value="publisher">Publisher</option>
                <option value="aggregator">Aggregator</option>
                <option value="expert brand">Expert Brand</option>
              </select>
            </div>
            <div>
              <label class="label">Тип сайта</label>
              <select v-model="form.input_site_type" class="input">
                <option value="">Не указано</option>
                <option value="новый">Новый</option>
                <option value="растущий">Растущий</option>
                <option value="зрелый">Зрелый</option>
                <option value="сильный бренд">Сильный бренд</option>
                <option value="слабый бренд">Слабый бренд</option>
              </select>
            </div>
            <div>
              <label class="label">Целевая аудитория</label>
              <input v-model="form.input_target_audience" type="text" class="input" placeholder="Малый бизнес, предприниматели" />
            </div>
            <div>
              <label class="label">Приоритетная бизнес-цель</label>
              <select v-model="form.input_business_goal" class="input">
                <option value="">Не указано</option>
                <option value="трафик">Трафик</option>
                <option value="лиды">Лиды</option>
                <option value="продажи">Продажи</option>
                <option value="бренд">Бренд</option>
                <option value="AI visibility">AI Visibility</option>
                <option value="topical authority">Topical Authority</option>
                <option value="revenue growth">Revenue Growth</option>
              </select>
            </div>
            <div>
              <label class="label">Основной тип монетизации</label>
              <select v-model="form.input_monetization" class="input">
                <option value="">Не указано</option>
                <option value="лиды">Лиды</option>
                <option value="подписка">Подписка</option>
                <option value="продажа товаров">Продажа товаров</option>
                <option value="реклама">Реклама</option>
                <option value="affiliate">Affiliate</option>
                <option value="freemium">Freemium</option>
                <option value="enterprise sales">Enterprise Sales</option>
                <option value="demo">Demo</option>
                <option value="consultation">Consultation</option>
                <option value="booking">Booking</option>
                <option value="marketplace fee">Marketplace Fee</option>
              </select>
            </div>
            <div>
              <label class="label">Ограничения проекта</label>
              <input v-model="form.input_project_limits" type="text" class="input" placeholder="нет сильного бренда, мало ссылок" />
            </div>
            <div>
              <label class="label">Приоритетные типы страниц</label>
              <input v-model="form.input_page_priorities" type="text" class="input" placeholder="блог, категории, услуги" />
            </div>
            <div>
              <label class="label">Особенности ниши</label>
              <input v-model="form.input_niche_features" type="text" class="input" placeholder="YMYL, local-heavy" />
            </div>
          </div>
        </div>

        <!-- ── Секция 2: LSI / N-граммы / TF-IDF ─────────────────── -->
        <div class="card p-0 overflow-hidden">
          <button
            @click="toggle('s2')"
            class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
          >
            <span class="font-medium text-white">2. LSI / N-граммы / TF-IDF</span>
            <span class="text-gray-500 text-xs mr-auto ml-3">{{ lsiCount }} слов</span>
            <span class="text-gray-400 text-lg">{{ openSections.s2 ? '▲' : '▼' }}</span>
          </button>
          <div v-show="openSections.s2" class="px-5 pb-5 space-y-4 border-t border-gray-800">
            <div class="pt-4">
              <label class="label">LSI-слова (по одному на строку) <span class="text-red-500">*</span></label>
              <textarea v-model="form.input_raw_lsi" class="textarea h-40 font-mono text-xs"
                placeholder="кредит наличными&#10;займ без справок&#10;быстрый кредит&#10;..." />
              <p class="text-xs text-gray-600 mt-1">Добавлено: {{ lsiCount }} слов (минимум 5)</p>
            </div>
            <div>
              <label class="label">N-граммы (через запятую)</label>
              <input v-model="form.input_ngrams" type="text" class="input font-mono text-xs"
                placeholder="кредит наличными, займ без справок, получить кредит онлайн" />
            </div>
            <div>
              <label class="label">TF-IDF веса (JSON)</label>
              <textarea v-model="form.input_tfidf_json" class="textarea h-24 font-mono text-xs"
                placeholder='[{"term":"кредит","rangeMin":5,"rangeMax":12}]' />
              <!-- Предпросмотр -->
              <div v-if="tfidfParsed.length" class="mt-2 flex flex-wrap gap-2">
                <span
                  v-for="item in tfidfParsed"
                  :key="item.term"
                  class="text-xs bg-gray-800 border border-gray-700 px-2 py-0.5 rounded font-mono"
                >
                  {{ item.term }}
                  <span class="text-gray-500">{{ item.rangeMin }}–{{ item.rangeMax }}</span>
                </span>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="label">Мин. символов на блок</label>
                <input v-model.number="form.input_min_chars" type="number" class="input" min="201" />
              </div>
              <div>
                <label class="label">Макс. символов на блок</label>
                <input v-model.number="form.input_max_chars" type="number" class="input" />
              </div>
            </div>
          </div>
        </div>

        <!-- ── Секция 3: Факты о бренде ───────────────────────────── -->
        <div class="card p-0 overflow-hidden">
          <button
            @click="toggle('s3')"
            class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
          >
            <span class="font-medium text-white">3. Факты о бренде</span>
            <span class="text-gray-400 text-lg">{{ openSections.s3 ? '▲' : '▼' }}</span>
          </button>
          <div v-show="openSections.s3" class="px-5 pb-5 border-t border-gray-800">
            <div class="pt-4">
              <label class="label">Факты, цифры, доказательства</label>
              <textarea v-model="form.input_brand_facts" class="textarea h-36"
                placeholder="Компания основана в 2010 году. Обслужили 50,000+ клиентов. Ставка от 1.5%/мес. Лицензия №12345..." />
            </div>
          </div>
        </div>

        <!-- ── Секция 4: Конкуренты ───────────────────────────────── -->
        <div class="card p-0 overflow-hidden">
          <button
            @click="toggle('s4')"
            class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
          >
            <span class="font-medium text-white">4. Анализ конкурентов</span>
            <span class="text-gray-400 text-lg">{{ openSections.s4 ? '▲' : '▼' }}</span>
          </button>
          <div v-show="openSections.s4" class="px-5 pb-5 border-t border-gray-800">
            <div class="pt-4">
              <label class="label">URL конкурентов (по одному на строку, до 4)</label>
              <textarea v-model="form.input_competitor_urls" class="textarea h-24 font-mono text-xs"
                placeholder="https://competitor1.kz&#10;https://competitor2.kz&#10;https://competitor3.kz&#10;https://competitor4.kz" />
              <p class="text-xs text-gray-600 mt-1">Stage 0 автоматически запускается при старте задачи и анализирует эти страницы</p>
            </div>
          </div>
        </div>

        <!-- ── Секция 5: Загрузка ТЗ ─────────────────────────────── -->
        <div class="card p-0 overflow-hidden">
          <button
            @click="toggle('s5')"
            class="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
          >
            <span class="font-medium text-white">5. Загрузка ТЗ (DOCX)</span>
            <span class="text-gray-400 text-lg">{{ openSections.s5 ? '▲' : '▼' }}</span>
          </button>
          <div v-show="openSections.s5" class="px-5 pb-5 border-t border-gray-800">
            <div class="pt-4 space-y-6">

              <!-- ── LLM-анализ ТЗ (Pre-Stage -1) ───────────────────────────── -->
              <div>
                <label class="label flex items-center gap-2">
                  <span>🤖 Анализ ТЗ через ИИ</span>
                  <span class="text-xs text-gray-500 font-normal">(PDF / DOCX / TXT → автозаполнение формы)</span>
                </label>
                <div
                  class="border-2 border-dashed border-indigo-800 rounded-lg p-8 text-center
                         hover:border-indigo-500 transition-colors cursor-pointer"
                  :class="{ 'opacity-50 cursor-not-allowed': llmUploading }"
                  @click="!llmUploading && $refs.llmTzInput.click()"
                >
                  <div class="text-3xl mb-2">🧠</div>
                  <p class="text-sm text-gray-300 font-medium">
                    {{ llmFile ? llmFile.name : 'Загрузите ТЗ для автоматического заполнения всех полей' }}
                  </p>
                  <p class="text-xs text-gray-500 mt-1">PDF, DOCX, TXT · Макс. 20 MB · ~5–15 сек.</p>
                </div>
                <input
                  ref="llmTzInput"
                  type="file"
                  accept=".pdf,.docx,.doc,.txt"
                  class="hidden"
                  @change="handleLLMTzUpload"
                />
                <div v-if="llmUploading" class="mt-3 flex items-center gap-2 text-indigo-400 text-sm">
                  <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                  </svg>
                  ИИ анализирует ТЗ… это займёт 5–15 секунд
                </div>
                <div v-if="llmMsg && !llmUploading" class="mt-3 text-sm text-indigo-300 bg-indigo-950/50 border border-indigo-800 rounded px-3 py-2">
                  ✓ {{ llmMsg }}
                </div>
                <div v-if="llmError" class="mt-3 text-sm text-red-400 bg-red-950/50 border border-red-800 rounded px-3 py-2">
                  ✗ {{ llmError }}
                </div>
              </div>

              <!-- ── Существующая загрузка DOCX (regex-парсер) ──────────────── -->
              <div>
                <label class="label">Файл ТЗ для SEO-полей (.docx)</label>
              <div
                class="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center
                       hover:border-indigo-600 transition-colors cursor-pointer"
                @click="$refs.docxInput.click()"
              >
                <div class="text-3xl mb-2">📄</div>
                <p class="text-sm text-gray-400">
                  {{ docxFile ? docxFile.name : 'Нажмите или перетащите .docx файл' }}
                </p>
                <p class="text-xs text-gray-600 mt-1">Максимум 10 MB</p>
              </div>
              <input
                ref="docxInput"
                type="file"
                accept=".docx,.doc"
                class="hidden"
                @change="handleDocxUpload"
              />
              <!-- Статус загрузки -->
              <div v-if="docxUploading" class="mt-3 flex items-center gap-2 text-indigo-400 text-sm">
                <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Распознаю ТЗ...
              </div>
              <div v-if="docxMsg && !docxUploading" class="mt-3 text-sm text-green-400 bg-green-950/50 border border-green-800 rounded px-3 py-2">
                ✓ {{ docxMsg }}
              </div>
              <div v-if="docxError" class="mt-3 text-sm text-red-400 bg-red-950/50 border border-red-800 rounded px-3 py-2">
                ✗ {{ docxError }}
              </div>
              </div><!-- /docx block -->

            </div><!-- /space-y-6 -->
          </div>
        </div>

        <!-- ── Ошибка ──────────────────────────────────────────────── -->
        <div v-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-4 py-3 rounded-lg">
          {{ error }}
        </div>

        <!-- ── Кнопки ──────────────────────────────────────────────── -->
        <div class="flex items-center gap-3 pt-2">
          <button @click="saveDraft" class="btn-secondary" :disabled="saving">
            <svg v-if="saving" class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            Сохранить черновик
          </button>
          <button
            @click="startTask"
            class="btn-primary"
            :disabled="!canStart || saving"
            :title="!canStart ? 'Заполните обязательные поля (H1, бренд, ≥5 LSI)' : ''"
          >
            ▶ Запустить генерацию
          </button>
          <span v-if="!canStart" class="text-xs text-gray-600">
            Заполните: H1, бренд, ≥5 LSI
          </span>
        </div>
      </div>
    </main>
  </div>
</template>
