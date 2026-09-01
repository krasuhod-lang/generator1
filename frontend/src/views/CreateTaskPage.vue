<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTasksStore } from '../stores/tasks.js';
import AppLayout from '../components/AppLayout.vue';
import LlmProviderSelector from '../components/LlmProviderSelector.vue';
import LlmModelSelector from '../components/LlmModelSelector.vue';
import RichTextInput from '../components/RichTextInput.vue';
import ProjectPicker from '../components/ProjectPicker.vue';
import AppPageHeader from '../components/AppPageHeader.vue';
import ToolHelp from '../components/ToolHelp.vue';

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
  input_target_url:      '',   // URL целевой страницы
  title:                 '',
  llm_provider:          'gemini',
  llm_model:             'gemini-3.1-pro-preview',
  gemini_model:          'gemini-3.1-pro-preview',
  // Связка с отчётом релевантности — заполняется при переходе из
  // /relevance/:id, бэкенд по этому id вытащит entity_coverage и
  // competitor_signals и вольёт их в __moduleContext / AKB §11.
  source_relevance_report_id: '',
});

// Привязка к SEO-проекту (ТЗ §5/§8). Хранится отдельно от формы:
// project_id уходит в payload createTask, бэкенд снимает project_context_snapshot.
const PROJECT_ID_LS_KEY = 'create_task_project_id_v1';
const selectedProjectId = ref(null);
const selectedProject   = ref(null);

function handleProjectSelected(project) {
  selectedProject.value = project || null;
  // «Последний выбранный проект» запоминаем только для формы создания:
  // в режиме редактирования проект принадлежит конкретной задаче.
  if (isEdit.value) return;
  try {
    if (selectedProjectId.value) {
      localStorage.setItem(PROJECT_ID_LS_KEY, String(selectedProjectId.value));
    } else {
      localStorage.removeItem(PROJECT_ID_LS_KEY);
    }
  } catch (_) { /* ignore */ }
}

/**
 * Поля, которые умеет предзаполнять проект (см. backend
 * services/projects/taskFormPrefill.js — один и тот же маппинг используется
 * и при создании задачи на бэкенде).
 */
const PROJECT_PREFILL_FIELDS = [
  'input_region',
  'input_brand_name',
  'input_target_audience',
  'input_niche_features',
  'input_project_limits',
  'input_page_priorities',
  'input_brand_facts',
];

// Последний полученный от проекта набор значений. Держим в ref, чтобы
// «долить» пустые поля после загрузки ТЗ или прифилла из релевантности —
// они приходят асинхронно и раньше затирали/блокировали друг друга.
const projectPrefill = ref(null);

/**
 * Пустое ли поле формы. RichTextInput (TipTap) отдаёт `<p></p>` для пустого
 * редактора, а прежний прифилл из ТЗ мог записать одинокий маркер «• » —
 * обычная проверка `.trim()` считала такое значение заполненным и навсегда
 * блокировала автозаполнение поля (в т.ч. на бэкенде, Stage -1).
 */
function isBlank(value) {
  if (value == null) return true;
  const raw = String(value);
  if (/<img\b/i.test(raw)) return false; // картинка — это контент
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[\u2022\u00b7*\-\u2013\u2014\s]/g, '');
  return text === '';
}

/**
 * Доливает в форму значения из выбранного проекта — только в пустые поля,
 * ручной ввод и данные из ТЗ/релевантности имеют приоритет.
 * @returns {number} сколько полей заполнено
 */
function applyProjectPrefill() {
  const prefill = projectPrefill.value;
  if (!prefill) return 0;
  let filled = 0;
  for (const key of PROJECT_PREFILL_FIELDS) {
    const incoming = String(prefill[key] ?? '').trim();
    if (!incoming) continue;
    if (!isBlank(form[key])) continue;
    form[key] = incoming;
    filled++;
  }
  if (isBlank(form.input_business_type) && prefill.input_business_type) {
    const normalized = normalizeSelectValue('input_business_type', String(prefill.input_business_type));
    if (normalized) { form.input_business_type = normalized; filled++; }
  }
  return filled;
}

/**
 * Идут ли сейчас более точные источники предзаполнения (разбор ТЗ, аналитика
 * отчёта релевантности). Пока идут — проект ждёт своей очереди.
 */
function isPrefillIdle() {
  return !relevancePrefilling.value && !llmUploading.value;
}

/** Долив из проекта, когда все более точные источники отработали. */
function applyProjectPrefillWhenIdle() {
  if (!isPrefillIdle()) return 0;
  return applyProjectPrefill();
}

/** Фолбэк для старого формата ответа /projects/:id/context (без task_prefill). */
function prefillFromRawContext(ctx) {
  const project = ctx.project || {};
  const brand   = ctx.brand   || {};
  const facts   = Array.isArray(brand.facts) ? brand.facts.filter(Boolean) : [];
  return {
    input_region:          project.region   || '',
    input_brand_name:      brand.name       || '',
    input_target_audience: project.audience || '',
    input_brand_facts:     facts.length ? facts.slice(0, 10).map((f) => `• ${f}`).join('\n') : '',
    input_business_type:   project.niche    || '',
  };
}

function handleProjectFull(ctx) {
  if (!ctx) return;
  const prefill = (ctx.task_prefill && typeof ctx.task_prefill === 'object')
    ? { ...prefillFromRawContext(ctx), ...ctx.task_prefill }
    : prefillFromRawContext(ctx);
  projectPrefill.value = prefill;
  // Контекст проекта приходит за доли секунды, а разбор ТЗ и аналитика
  // отчёта релевантности — за десятки секунд. Если ждём их, НЕ заполняем
  // поля сейчас: иначе общий текст проекта займёт места, предназначенные
  // для более точных данных. Долив сделает тот, кто закончит последним
  // (см. applyProjectPrefillWhenIdle).
  if (!isPrefillIdle()) return;
  const filled = applyProjectPrefill();
  if (filled > 0) {
    // Раскрываем секции, чтобы подставленные данные были видны сразу.
    Object.keys(openSections).forEach((k) => { openSections[k] = true; });
  }
}

// Загружаем черновик при редактировании
onMounted(async () => {
  if (isEdit.value) {
    loading.value = true;
    try {
      const task = await store.fetchTask(route.params.id);
      if (task) Object.keys(form).forEach(k => { if (task[k] !== undefined) form[k] = task[k]; });
      // Проект редактируемой задачи берём из неё самой. Использовать здесь
      // localStorage формы создания нельзя: PATCH теперь принимает
      // project_id, и «последний выбранный» проект молча перепривязал бы
      // чужую задачу вместе с её контекстом.
      selectedProjectId.value = task?.project_id || null;
    } catch (e) {
      error.value = 'Не удалось загрузить задачу';
    } finally {
      loading.value = false;
    }
    // В режиме редактирования query-прифилл не имеет смысла — выходим.
    return;
  }

  // Новая задача: восстанавливаем последний выбранный проект (ТЗ §5/§8).
  try {
    const pid = localStorage.getItem(PROJECT_ID_LS_KEY);
    if (pid) {
      const n = Number(pid);
      selectedProjectId.value = Number.isInteger(n) && n > 0 ? n : pid;
    }
  } catch (_) { /* ignore */ }

  // Прифилл из query-параметров (используется кнопкой «📝 Создать SEO-статью»
  // на странице Article Topics — закрывает петлю «foresight → готовая
  // постановка для генератора статей»). Все ключи опциональны; неизвестные
  // ключи игнорируем — никаких ошибок при «лишних» query-параметрах.
  const q = route.query || {};
  const map = {
    prefill_target:   'input_target_service',
    prefill_audience: 'input_target_audience',
    prefill_region:   'input_region',
    prefill_brand:    'input_brand_name',
    prefill_facts:    'input_brand_facts',
    prefill_title:    'title',
    // Прифилл из «Релевантность → Создать контент»: важные LSI попадают
    // как \n-разделённый блок в textarea, релевантный отчёт связывается с
    // задачей через source_relevance_report_id (бэкенд проверяет владельца).
    prefill_lsi:      'input_raw_lsi',
    prefill_relevance_report_id: 'source_relevance_report_id',
  };
  let touched = false;
  for (const [qk, fk] of Object.entries(map)) {
    const raw = q[qk];
    if (raw == null || raw === '') continue;
    const value = Array.isArray(raw) ? String(raw[0]) : String(raw);
    if (!value) continue;
    // UUID-фильтр для relevance_report_id — иначе бэкенд просто отвергнет,
    // но проще не давать заведомо мусорные данные в форму.
    if (fk === 'source_relevance_report_id' &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
      continue;
    }
    // Длина: backend всё равно валидирует, но обрезаем заранее, чтобы
    // не перегружать форму.
    form[fk] = value.slice(0, 4000);
    touched = true;
  }
  if (touched) {
    // Раскрываем все секции аккордеона, чтобы юзер сразу увидел
    // подставленные значения и не тыкал в каждую.
    Object.keys(openSections).forEach((k) => { openSections[k] = true; });
  }

  // ── Доп. автозаполнение из relevance-отчёта (DeepSeek-аналитика) ───
  // Если есть валидный source_relevance_report_id — дёргаем бэкенд,
  // который соберёт из отчёта детерминированные поля (URL цели,
  // конкуренты, n-граммы, TF-IDF) + через DeepSeek сгенерирует ЦА,
  // особенности ниши и факты. Никогда не перезаписываем уже заполненные
  // юзером поля (пустота → подставляем, текст → не трогаем).
  if (form.source_relevance_report_id) {
    void prefillFromRelevanceReport(form.source_relevance_report_id);
  }
});

async function prefillFromRelevanceReport(reportId) {
  relevancePrefilling.value = true;
  relevancePrefillMsg.value = '';
  relevancePrefillError.value = '';
  try {
    const data = await store.fetchRelevancePrefill(reportId);
    const det  = data?.deterministic || {};
    const llm  = data?.llm || {};
    let filled = 0;

    // Детерминированные поля — заполняем только пустые (не перезаписываем юзера).
    const detMap = [
      'input_target_url',
      'input_competitor_urls',
      'input_ngrams',
      // ↓ Новые поля из getRelevancePrefill (см. tasks.controller.js):
      // LSI-pool из top-60 важных+доп. лемм релевантности, плюс
      // sensible-defaults, чтобы кнопка «▶ Запустить генерацию» сразу
      // была активной (canStart требует brand/author/region/≥5 LSI).
      'input_raw_lsi',
      'input_brand_name',
      'input_author_name',
      'input_region',
    ];
    for (const k of detMap) {
      const incoming = (det[k] || '').toString().trim();
      if (incoming && isBlank(form[k])) { form[k] = incoming; filled++; }
    }
    // input_tfidf_json — пустым считаем '[]' / '' / невалидный JSON-массив.
    const incomingTfidf = (det.input_tfidf_json || '').toString().trim();
    if (incomingTfidf) {
      let currentArr = [];
      try { const p = JSON.parse(form.input_tfidf_json); if (Array.isArray(p)) currentArr = p; } catch (_) { /* пустой/невалидный JSON в форме = считаем пустым */ }
      if (currentArr.length === 0) { form.input_tfidf_json = incomingTfidf; filled++; }
    }

    // LLM-поля — тоже только в пустые.
    const llmMap = [
      'input_target_audience',
      'input_niche_features',
      'input_brand_facts',
      'input_project_limits',
      'input_page_priorities',
    ];
    for (const k of llmMap) {
      const incoming = (llm[k] || '').toString().trim();
      if (incoming && isBlank(form[k])) { form[k] = incoming; filled++; }
    }

    // Открываем релевантные секции — чтобы юзер сразу увидел подстановки.
    if (det.input_target_url || llm.input_target_audience || llm.input_niche_features || llm.input_project_limits || llm.input_page_priorities) openSections.s1 = true;
    if (det.input_ngrams || incomingTfidf) openSections.s2 = true;
    if (llm.input_brand_facts) openSections.s3 = true;
    if (det.input_competitor_urls) openSections.s4 = true;

    // Чего не дал отчёт — добираем из выбранного проекта (ограничения, типы
    // страниц, факты бренда), чтобы поля не оставались пустыми.
    filled += llmUploading.value ? 0 : applyProjectPrefill();

    if (filled > 0) {
      const llmNote = data?.llm_used ? ' (включая ЦА/нишу/факты от DeepSeek)' : '';
      relevancePrefillMsg.value = `Подставлено ${filled} полей из отчёта релевантности${llmNote}. Проверьте и при необходимости скорректируйте.`;
    } else {
      relevancePrefillMsg.value = 'Отчёт релевантности подключён — подходящих полей для автозаполнения не найдено.';
    }
    if (data?.llm_error) {
      relevancePrefillError.value = `DeepSeek-аналитика недоступна: ${data.llm_error}. Детерминированные поля подставлены.`;
    }
  } catch (err) {
    relevancePrefillError.value = err?.response?.data?.error
      || err?.message
      || 'Не удалось получить данные из отчёта релевантности';
  } finally {
    relevancePrefilling.value = false;
    // Даже если отчёт не отдал полей (ошибка/таймаут) — заполняем то,
    // что известно из проекта. Если параллельно ещё разбирается ТЗ —
    // долив сделает он.
    applyProjectPrefillWhenIdle();
  }
}

onBeforeUnmount(() => {
  if (llmTimer) { clearInterval(llmTimer); llmTimer = null; }
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
const llmElapsed   = ref(0);
let   llmTimer     = null;

// Автозаполнение из отчёта релевантности (DeepSeek-аналитика). Используется
// при переходе из RelevanceResultPage по кнопке «✍ SEO-текст». Не блокирует
// форму — пока DeepSeek думает, юзер уже видит детерминированно подставленные
// поля; LLM-поля доезжают через 10–60 сек.
const relevancePrefilling = ref(false);
const relevancePrefillMsg   = ref('');
const relevancePrefillError = ref('');

// Маппинг полей extracted → form
const LLM_FIELD_MAP = {
  niche:            'input_target_service',   // используем как запасной вариант если пустой
  keyword:          'input_target_service',
  target_page_url:  'input_target_url',
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
  audience_segments: 'input_target_audience', // дополняет аудиторию
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
  llmElapsed.value = 0;
  llmTimer = setInterval(() => { llmElapsed.value++; }, 1000);

  try {
    const result = await store.parseTZWithLLM(file);
    const ext = result?.extracted || {};
    let filled = 0;

    // Описательные поля приходят массивами и рендерятся буллитами.
    const DESCRIPTIVE_FIELDS = ['constraints', 'priority_page_types', 'niche_features', 'audience_segments'];

    for (const [extKey, formKey] of Object.entries(LLM_FIELD_MAP)) {
      const val = ext[extKey];
      if (val === null || val === undefined || val === '') continue;
      // Массивы → строка. ВАЖНО: пустой массив раньше превращался в одинокий
      // маркер «• » — поле выглядело пустым, но считалось заполненным и блокировало
      // все последующие автозаполнения (проект, релевантность, Stage -1).
      let strVal;
      if (Array.isArray(val)) {
        const items = val.map((v) => String(v ?? '').trim()).filter(Boolean);
        if (!items.length) continue;
        strVal = DESCRIPTIVE_FIELDS.includes(extKey) ? items.map((v) => `• ${v}`).join('\n') : items.join('\n');
      } else {
        strVal = String(val);
      }
      if (!strVal.trim()) continue;
      // Не перезаписываем уже заполненное поле (кроме явного Intent из keyword)
      if (extKey === 'niche' && !isBlank(form[formKey])) continue;
      // audience_segments дополняет target_audience, а не перезаписывает
      if (extKey === 'audience_segments') {
        if (!isBlank(form[formKey])) {
          form[formKey] = String(form[formKey]).trim() + '\n\nСегменты аудитории:\n' + strVal;
        } else {
          form[formKey] = 'Сегменты аудитории:\n' + strVal;
        }
        filled++;
        continue;
      }
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
    if (ext.known_terms?.length && isBlank(form.input_raw_lsi)) {
      form.input_raw_lsi = ext.known_terms.join('\n');
      filled++;
    }

    // Собираем детальные бренд-факты из расширенного TZ-экстрактора
    const brandFactParts = [];
    if (ext.tone_of_voice)                       brandFactParts.push(`Тон коммуникации: ${ext.tone_of_voice}`);
    if (ext.brand_usp?.length)                   brandFactParts.push(`УТП: ${ext.brand_usp.join('; ')}`);
    if (ext.pricing_info?.length)                brandFactParts.push(`Цены/тарифы: ${ext.pricing_info.join('; ')}`);
    if (ext.service_process?.length)             brandFactParts.push(`Процесс работы: ${ext.service_process.join('; ')}`);
    if (ext.delivery_conditions?.length)         brandFactParts.push(`Условия: ${ext.delivery_conditions.join('; ')}`);
    if (ext.guarantees?.length)                  brandFactParts.push(`Гарантии: ${ext.guarantees.join('; ')}`);
    if (ext.certifications?.length)              brandFactParts.push(`Лицензии/сертификаты: ${ext.certifications.join('; ')}`);
    if (ext.awards?.length)                      brandFactParts.push(`Награды: ${ext.awards.join('; ')}`);
    if (ext.experience_years)                    brandFactParts.push(`Опыт: ${ext.experience_years}`);
    if (ext.team_info)                           brandFactParts.push(`Команда: ${ext.team_info}`);
    if (ext.cases_portfolio?.length)             brandFactParts.push(`Кейсы: ${ext.cases_portfolio.join('; ')}`);
    if (ext.reviews_info)                        brandFactParts.push(`Отзывы: ${ext.reviews_info}`);
    if (ext.content_requirements?.length)        brandFactParts.push(`Требования к контенту: ${ext.content_requirements.join('; ')}`);
    if (ext.additional_notes)                    brandFactParts.push(`Доп. информация: ${ext.additional_notes}`);

    if (brandFactParts.length > 0) {
      const brandFactsStr = brandFactParts.join('\n');
      if (!isBlank(form.input_brand_facts)) {
        form.input_brand_facts = String(form.input_brand_facts).trim() + '\n\n' + brandFactsStr;
      } else {
        form.input_brand_facts = brandFactsStr;
      }
      filled++;
    }

    // Чего не было в ТЗ (часто — ограничения, типы страниц, факты бренда) —
    // добираем из выбранного проекта.
    filled += relevancePrefilling.value ? 0 : applyProjectPrefill();

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
            const payload = { ...form };
            payload.project_id = selectedProjectId.value || null;
            await store.updateTask(taskId, payload);
          } catch (_) { /* поля уже в форме, ошибка не критична */ }
        }
      }
    }

    // Часть полей экстрактор не нашёл в тексте и бэкенд вывел их по нише —
    // честно предупреждаем, что это предположение, а не цитата из ТЗ.
    const derivedCount = Array.isArray(result?.derived_fields) ? result.derived_fields.length : 0;
    const derivedNote  = derivedCount > 0
      ? ` ${derivedCount} полей (ЦА / особенности ниши / ограничения / типы страниц) в ТЗ не найдены и выведены по нише — проверьте их особенно внимательно.`
      : '';
    llmMsg.value = filled > 0
      ? `ИИ заполнил ${filled} полей. Проверьте и при необходимости скорректируйте.${derivedNote}`
      : 'ТЗ проанализировано, но распознаваемых полей не найдено — заполните вручную.';
  } catch (err) {
    llmError.value = err.code === 'ECONNABORTED' || err.message?.includes('timeout')
      ? 'Превышено время ожидания. Попробуйте файл меньшего размера или повторите позже.'
      : err.response?.data?.error || err.message || 'Ошибка анализа ТЗ';
  } finally {
    llmUploading.value = false;
    if (llmTimer) { clearInterval(llmTimer); llmTimer = null; }
    // Контекст проекта мог приехать, пока разбирался файл — доливаем пустые
    // поля (если не ждём ещё и аналитику отчёта релевантности).
    applyProjectPrefillWhenIdle();
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
      'input_target_url',
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
    // ТЗ §5/§8: пробрасываем выбранный проект (бэкенд снимет project_context_snapshot
    // и подтянет недостающие поля из buildProjectContext). null = «без проекта».
    payload.project_id = selectedProjectId.value || null;

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

// Скачивание примера ТЗ
function downloadExampleTZ() {
  const link = document.createElement('a');
  link.href = '/api/tasks/example-tz';
  link.download = 'Пример_ТЗ_SEO_Genius.docx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
</script>

<template>
  <AppLayout>
    <div class="app-page app-page-narrow">
      <AppPageHeader
        eyebrow="Создание контента"
        :title="isEdit ? 'Редактировать задачу' : 'Новая SEO-задача'"
        description="Заполните обязательные данные, добавьте семантику и факты — остальной контекст пайплайн соберёт автоматически."
      >
        <template #title-suffix>
          <ToolHelp title="SEO-текст" text="Форма задаёт стратегию будущей статьи: H1, бренд, регион, семантика и факты. Черновик можно сохранить без списания генерации; лимит расходуется только после запуска." />
        </template>
        <template #actions>
          <RouterLink to="/dashboard" class="btn-ghost text-xs">← К задачам</RouterLink>
        </template>
      </AppPageHeader>
      <div v-if="loading" class="text-center py-20 text-gray-500">Загрузка...</div>

      <div v-else class="space-y-3">

        <!-- ── ProjectPicker (ТЗ §5/§8) ──────────────────────────── -->
        <div class="card p-4">
          <ProjectPicker
            v-model="selectedProjectId"
            @context="handleProjectSelected"
            @fullContext="handleProjectFull"
            label="Проект (необязательно)"
            placeholder="— Без проекта —"
          />
          <p v-if="selectedProject" class="mt-2 text-xs text-emerald-300">
            📂 Контекст проекта «{{ selectedProject.name }}» подтянется в генерацию
            (бренд, ниша, регион, факты, конкуренты).
          </p>
        </div>

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
            <div v-if="form.source_relevance_report_id" class="pt-4 space-y-2">
              <div class="p-2 rounded bg-emerald-900/20 border border-emerald-800/50 text-xs text-emerald-300">
                🎯 Подключён отчёт релевантности
                <code class="font-mono">{{ form.source_relevance_report_id.slice(0, 8) }}…</code>
                — competitor_signals и mandatory_entities из ТОП-10 уйдут в __moduleContext / AKB §11.
                <button type="button"
                        class="ml-2 underline text-emerald-200 hover:text-emerald-100"
                        @click="form.source_relevance_report_id = ''">
                  отвязать
                </button>
              </div>
              <div v-if="relevancePrefilling"
                   class="p-2 rounded bg-indigo-900/20 border border-indigo-800/50 text-xs text-indigo-300 flex items-center gap-2">
                <svg class="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                🤖 DeepSeek анализирует данные отчёта (ЦА, особенности ниши, факты)…
              </div>
              <div v-if="relevancePrefillMsg && !relevancePrefilling"
                   class="p-2 rounded bg-indigo-900/20 border border-indigo-800/50 text-xs text-indigo-200">
                ✓ {{ relevancePrefillMsg }}
              </div>
              <div v-if="relevancePrefillError && !relevancePrefilling"
                   class="p-2 rounded bg-red-900/20 border border-red-800/50 text-xs text-red-300">
                ⚠ {{ relevancePrefillError }}
              </div>
            </div>
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
              <label class="label">URL целевой страницы</label>
              <input v-model="form.input_target_url" type="url" class="input font-mono text-xs"
                placeholder="https://example.com/uslugi/kredit-nalichnymi" />
              <p class="text-xs text-gray-600 mt-1">Страница, на которой будет размещён текст. При запуске задачи контент страницы будет проанализирован для определения аудитории, ниши и фактов о бренде.</p>
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
              <RichTextInput v-model="form.input_target_audience" min-height="96px"
                placeholder="Например: Физические лица 25-45 лет со средним доходом, ищущие быстрое кредитование без визита в банк." />
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
              <RichTextInput v-model="form.input_project_limits" min-height="96px"
                placeholder="Например: Нет штатных экспертов для E-E-A-T контента. Слабый ссылочный профиль — менее 50 referring domains." />
            </div>
            <div>
              <label class="label">Приоритетные типы страниц</label>
              <RichTextInput v-model="form.input_page_priorities" min-height="80px"
                placeholder="Например: Блог с экспертными статьями для привлечения информационного трафика. Страницы услуг с коммерческим интентом." />
            </div>
            <div>
              <label class="label">Особенности ниши</label>
              <RichTextInput v-model="form.input_niche_features" min-height="96px"
                placeholder="Например: YMYL-ниша — Google требует повышенного уровня экспертизы. Сильная локальная привязка." />
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
              <RichTextInput v-model="form.input_brand_facts" min-height="144px"
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

              <!-- ── Кнопка «Скачать пример задания» ─────────────────────────── -->
              <div class="flex items-center gap-3 p-4 bg-gray-800/50 border border-gray-700 rounded-lg">
                <div class="text-2xl">📋</div>
                <div class="flex-1">
                  <p class="text-sm text-white font-medium">Не знаете какой формат загружать?</p>
                  <p class="text-xs text-gray-400 mt-0.5">Скачайте пример ТЗ с правильной структурой полей и образцами данных</p>
                </div>
                <button
                  @click="downloadExampleTZ"
                  class="btn-secondary text-xs whitespace-nowrap"
                >
                  📥 Скачать пример ТЗ
                </button>
              </div>

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
                  <p class="text-xs text-gray-500 mt-1">PDF, DOCX, TXT · Макс. 20 MB</p>
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
                  ИИ анализирует ТЗ… {{ llmElapsed }} сек.
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

        <!-- ── LLM-провайдер ─────────────────────────────────────── -->
        <div class="card px-5 py-4">
          <LlmProviderSelector
            v-model="form.llm_provider"
            :allowed-providers="['gemini', 'openai', 'grok']"
            :disabled="saving"
            hint="GPT применяйте точечно для сложного quality/audit; Gemini остаётся writer-моделью по умолчанию."
          />
          <LlmModelSelector
            v-model="form.llm_model"
            :provider="form.llm_provider"
            :disabled="saving"
            class="mt-4"
            hint="Выбор модели сохраняется в задаче; legacy Gemini field синхронизируется для старых обработчиков."
          />
        </div>

        <!-- ── Ошибка ──────────────────────────────────────────────── -->
        <div v-if="error" class="bg-red-950 border border-red-800 text-red-400 text-sm px-4 py-3 rounded-lg">
          {{ error }}
        </div>

        <!-- ── Кнопки ──────────────────────────────────────────────── -->
        <div class="app-form-actions flex items-center gap-3 pt-2">
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
    </div>
  </AppLayout>
</template>
