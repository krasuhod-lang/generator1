<script setup>
/**
 * ForecasterPage — модуль «Прогнозатор».
 *   • Загрузка CSV/XLSX выгрузки Wordstat-парсера.
 *   • Поле «текущий трафик в месяц» — для калибровки модели трафика.
 *   • Список задач пользователя со статусами и быстрым переходом к результату.
 *
 * XLSX парсится прямо в браузере через `read-excel-file` (уже в deps),
 * CSV отправляется как сырая строка — бэкенд парсит сам.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { useForecasterStore } from '../stores/forecaster.js';
import readXlsxFile from 'read-excel-file';

const router = useRouter();
const store  = useForecasterStore();

const form = ref({
  name: '',
  file: null,
  fileName: '',
  keywords_text: '',
  current_traffic_per_month: '',
  region: '',
  notes: '',
  target_url: '',
  conversion_rate_pct: '',  // в %, переводим в дробь при отправке (0.02)
  intent: '',
  main_query: '',
  h_max: 12,
  // Тонкая настройка единой модели прогноза (все опциональны — есть дефолты).
  target_ctr_pct: '',            // целевой CTR ядра, % (по умолчанию 3%)
  c_yield_pct: '',               // живые клики (Zero-click), % (по умолчанию 65%)
  semantic_expansion_pct: '',    // расширение ядра, %/мес (по умолчанию 0)
  growth_k: '',                  // скорость роста (по умолчанию 0.35)
  breakthrough_month: '',        // месяц прорыва (по умолчанию 6)
  uncertainty_pct: '',           // погрешность за 1 мес, % (по умолчанию 5%)
});

// Режим источника: 'keywords' — список ключей (сезонность через Арсенкин),
// 'file' — CSV/XLSX-выгрузка Wordstat (legacy-режим).
const inputMode = ref('keywords');

const keywordsList = computed(() =>
  form.value.keywords_text
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean),
);
const keywordsCount = computed(() => new Set(keywordsList.value.map((s) => s.toLowerCase())).size);

const submitting = ref(false);
const formError  = ref(null);
const previewInfo = ref(null);

function onFileChange(ev) {
  const f = ev.target.files?.[0];
  formError.value = null;
  previewInfo.value = null;
  if (!f) {
    form.value.file = null;
    form.value.fileName = '';
    return;
  }
  // Лимит размера файла намеренно снят (по требованию: учитывать ВСЕ фразы
  // из любой выгрузки Wordstat, какой бы объёмной она ни была).
  form.value.file = f;
  form.value.fileName = f.name;
  if (!form.value.name) {
    form.value.name = f.name.replace(/\.(csv|xlsx?|tsv)$/i, '');
  }
}

// Проценты из формы → доля (2 → 0.02). Пусто/невалидно → null (бэкенд возьмёт дефолт).
function pctToFrac(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}
function numOrNull(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function readFileAsRows(file) {
  const isXlsx = /\.xlsx?$/i.test(file.name) || file.type.includes('spreadsheet') || file.type.includes('excel');
  if (isXlsx) {
    const rows = await readXlsxFile(file);
    // приводим к string[][]
    return { kind: 'rows', rows: rows.map((r) => r.map((c) => (c == null ? '' : String(c)))) };
  }
  // CSV / TSV → читаем как текст
  const text = await file.text();
  return { kind: 'csv', csv: text };
}

async function handleSubmit() {
  formError.value = null;
  if (inputMode.value === 'keywords') {
    if (keywordsCount.value === 0) {
      formError.value = 'Введите хотя бы один ключевой запрос (по одному на строке)';
      return;
    }
  } else if (!form.value.file) {
    formError.value = 'Загрузите CSV или XLSX-файл';
    return;
  }
  submitting.value = true;
  try {
    let source;
    if (inputMode.value === 'keywords') {
      source = { keywords: keywordsList.value };
    } else {
      const fileData = await readFileAsRows(form.value.file);
      source = {
        filename: form.value.fileName,
        ...(fileData.kind === 'rows' ? { rows: fileData.rows } : { csv: fileData.csv }),
      };
    }
    // CR: user вводит в %, бэкенд хранит как дробь.
    const crPct = parseFloat(form.value.conversion_rate_pct);
    const cr = Number.isFinite(crPct) && crPct > 0 ? crPct / 100 : null;
    const payload = {
      name: form.value.name?.trim() || '',
      options: {
        current_traffic_per_month: Math.max(0, parseInt(form.value.current_traffic_per_month, 10) || 0),
        region: form.value.region?.trim() || '',
        notes:  form.value.notes?.trim()  || '',
        target_url: form.value.target_url?.trim() || '',
        // По требованию владельца: считаем только объём заявок (= traffic × CR),
        // никакой выручки/маржи.
        conversion_rate: cr,
        intent: form.value.intent?.trim() || null,
        main_query: form.value.main_query?.trim() || '',
        h_max: Math.max(1, Math.min(24, parseInt(form.value.h_max, 10) || 12)),
        // ── Тонкая настройка единой модели (проценты → доли) ──────────
        target_ctr: pctToFrac(form.value.target_ctr_pct),
        c_yield: pctToFrac(form.value.c_yield_pct),
        semantic_expansion_rate: pctToFrac(form.value.semantic_expansion_pct),
        growth_k: numOrNull(form.value.growth_k),
        breakthrough_month: numOrNull(form.value.breakthrough_month),
        uncertainty_delta: pctToFrac(form.value.uncertainty_pct),
      },
      source,
    };
    const id = await store.createTask(payload);
    if (!id) throw new Error('Сервер не вернул id задачи');
    // обновляем список и идём на результат
    await store.fetchTasks();
    router.push(`/forecaster/${id}`);
  } catch (err) {
    formError.value = err.response?.data?.error || err.message || 'Ошибка создания задачи';
  } finally {
    submitting.value = false;
  }
}

// ── список + поллинг ─────────────────────────────────────────────
let pollHandle = null;
onMounted(async () => {
  await store.fetchTasks();
  pollHandle = setInterval(() => {
    // обновляем, только если есть running/queued
    if (store.tasks.some((t) => t.status === 'queued' || t.status === 'running')) {
      store.fetchTasks();
    }
  }, 4000);
});
onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});

const hasInFlight = computed(() => store.tasks.some((t) => t.status === 'queued' || t.status === 'running'));

async function removeTask(id) {
  if (!confirm('Удалить задачу?')) return;
  try { await store.deleteTask(id); } catch (_) { /* ignore */ }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ru-RU'); } catch (_) { return iso; }
}

function statusBadge(s) {
  if (s === 'done')    return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30';
  if (s === 'running') return 'bg-sky-500/10 text-sky-300 border-sky-500/30 animate-pulse';
  if (s === 'queued')  return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
  if (s === 'error')   return 'bg-rose-500/10 text-rose-300 border-rose-500/30';
  return 'bg-gray-700/40 text-gray-300 border-gray-600';
}
</script>

<template>
  <AppLayout>
    <div class="p-6 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- ─── Форма ─────────────────────────────────────────────── -->
      <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <header class="mb-4">
          <h1 class="text-xl font-semibold text-gray-100">📈 Прогнозатор</h1>
          <p class="text-sm text-gray-400 mt-1">
            Вбейте список ключевых запросов — либо загрузите готовую CSV/XLSX-выгрузку
            с помесячной частотностью. Система:
          </p>
          <ul class="text-sm text-gray-400 mt-2 list-disc pl-5 space-y-0.5">
            <li>исключит запросы со стоп-словами (бесплатно, скачать, авито, вакансии…),</li>
            <li>снимет сезонность через Арсенкин — частота в месяц по каждому запросу за последний год,</li>
            <li>построит график спроса по месяцам и подсветит зоны падения красным,</li>
            <li>спрогнозирует спрос на 12 месяцев вперёд,</li>
            <li>оценит <span class="text-gray-300">реалистичный</span> трафик при выходе в ТОП-3 / 5 / 10
                (с учётом текущего значения, а не «все запросы в ТОП»),</li>
            <li>отсеет шлак-запросы (детерминированно + AI-разметка причин),</li>
            <li>сделает выводы и даст рекомендации (DeepSeek).</li>
          </ul>
        </header>

        <form @submit.prevent="handleSubmit" class="space-y-3">
          <!-- Переключатель источника -->
          <div class="flex rounded-lg overflow-hidden border border-gray-700 text-sm">
            <button type="button" @click="inputMode = 'keywords'"
              class="flex-1 py-2 font-medium transition"
              :class="inputMode === 'keywords' ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'">
              🔑 Список ключей
            </button>
            <button type="button" @click="inputMode = 'file'"
              class="flex-1 py-2 font-medium transition"
              :class="inputMode === 'file' ? 'bg-indigo-600 text-white' : 'bg-gray-950 text-gray-400 hover:text-gray-200'">
              📎 Файл CSV/XLSX
            </button>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Название задачи</label>
            <input v-model="form.name" type="text" maxlength="200"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="Например: Окна ПВХ — сезонность 2024-2025" />
          </div>

          <div v-if="inputMode === 'keywords'">
            <label class="block text-xs text-gray-400 mb-1">Ключевые запросы — по одному на строке</label>
            <textarea v-model="form.keywords_text" rows="8"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 font-mono"
              placeholder="купить окна пвх&#10;окна пвх москва&#10;остекление балкона цена"></textarea>
            <div class="flex items-center justify-between mt-1">
              <p class="text-[11px] text-gray-500">
                {{ keywordsCount }} уникальных запросов · до 10 000 за раз
              </p>
              <p class="text-[11px] text-gray-500">
                Стоп-слова (бесплатно, скачать, авито…) будут исключены автоматически
              </p>
            </div>
          </div>

          <div v-else>
            <label class="block text-xs text-gray-400 mb-1">Файл (CSV или XLSX)</label>
            <input type="file" accept=".csv,.xlsx,.xls,.tsv,text/csv" @change="onFileChange"
              class="block w-full text-sm text-gray-300 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0
                     file:text-sm file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500" />
            <p v-if="form.fileName" class="text-xs text-gray-500 mt-1">📎 {{ form.fileName }}</p>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Текущий трафик / мес</label>
              <input v-model="form.current_traffic_per_month" type="number" min="0" step="1"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                placeholder="например, 500" />
              <p class="text-[11px] text-gray-500 mt-1">
                Если указан — модель будет калибровать «uplift при ТОП-3/5/10» от вашего текущего CTR.
              </p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">Регион</label>
              <input v-model="form.region" type="text" maxlength="100"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                placeholder="Москва / Россия / lr-код" />
              <p v-if="inputMode === 'keywords'" class="text-[11px] text-gray-500 mt-1">
                Регион сбора частот в Арсенкине. Пусто = Россия.
              </p>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">URL продвигаемого сайта</label>
            <input v-model="form.target_url" type="url" maxlength="500"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
              placeholder="https://example.com/" />
            <p class="text-[11px] text-gray-500 mt-1">
              Используется DeepSeek-аналитикой для контекста и AI-фильтром, чтобы исключить
              чужие бренды/нерелевантные запросы.
            </p>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Главный (маркерный) запрос</label>
              <input v-model="form.main_query" type="text" maxlength="300"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                placeholder="например, окна пвх москва" />
              <p class="text-[11px] text-gray-500 mt-1">
                Нужен для расчёта λ: объём кластера / объём главного запроса.
              </p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">Горизонт прогноза, мес</label>
              <input v-model="form.h_max" type="number" min="1" max="24" step="1"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100" />
              <p class="text-[11px] text-gray-500 mt-1">По умолчанию 12, максимум 24 месяца.</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Конверсия сайта, %</label>
              <input v-model="form.conversion_rate_pct" type="number" min="0.01" max="50" step="0.1"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                placeholder="например, 2.0" />
              <p class="text-[11px] text-gray-500 mt-1">
                Считаем <span class="text-gray-300">объём заявок</span> = трафик × конверсия.
                Маржу/выручку модуль не считает. Если оставить пустым — берётся preset по типу проекта.
              </p>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">Тип проекта (intent)</label>
              <select v-model="form.intent"
                class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100">
                <option value="">— не указан —</option>
                <option value="commercial">commercial (услуги, 2.0 %)</option>
                <option value="ecommerce">ecommerce (магазин, 1.2 %)</option>
                <option value="lead_gen">lead_gen (лендинг/квиз, 3.0 %)</option>
                <option value="info">info (контент, 0.3 %)</option>
                <option value="b2b">b2b (длинный цикл, 0.8 %)</option>
              </select>
              <p class="text-[11px] text-gray-500 mt-1">
                Используется как стартовый CR, если поле «конверсия» пустое.
              </p>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Заметка (необязательно)</label>
            <textarea v-model="form.notes" rows="2" maxlength="1000"
              class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"></textarea>
          </div>

          <!-- ─── Тонкая настройка модели прогноза (необязательно) ─── -->
          <details class="bg-gray-950/50 border border-gray-800 rounded-lg">
            <summary class="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-gray-300">
              ⚙️ Тонкая настройка модели прогноза (необязательно)
            </summary>
            <div class="px-3 pb-3 pt-1 space-y-3">
              <p class="text-[11px] text-gray-500 leading-relaxed">
                Все поля можно оставить пустыми — тогда берутся разумные значения по умолчанию.
                Меняйте их, только если понимаете, что делаете: это «ручки» будущего роста трафика.
              </p>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Целевой CTR ядра, %</label>
                  <input v-model="form.target_ctr_pct" type="number" min="0.1" max="30" step="0.1"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 3" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    Какую долю всех кликов по вашим запросам реально соберёт сайт «на потолке». Обычно 1–5%.
                  </p>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Живые клики (Zero-click), %</label>
                  <input v-model="form.c_yield_pct" type="number" min="1" max="100" step="1"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 65" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    Сколько людей реально кликают, а не читают ответ прямо в поиске. Обычно 60–70%.
                  </p>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Расширение семантики, %/мес</label>
                  <input v-model="form.semantic_expansion_pct" type="number" min="0" max="20" step="0.5"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 0" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    Если каждый месяц добавляете новые страницы и темы — на сколько % растёт охват. 0 = ядро не растёт.
                  </p>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Скорость роста (агрессивность)</label>
                  <input v-model="form.growth_k" type="number" min="0.05" max="1.5" step="0.05"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 0.35" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    Насколько круто идёт разгон продвижения. 0.3–0.5 — оптимально.
                  </p>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Месяц прорыва</label>
                  <input v-model="form.breakthrough_month" type="number" min="1" max="24" step="1"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 6" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    На каком месяце ждём самый быстрый рост (перегиб S-кривой).
                  </p>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Погрешность за 1 мес, %</label>
                  <input v-model="form.uncertainty_pct" type="number" min="0" max="30" step="1"
                    class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100"
                    placeholder="по умолчанию 5" />
                  <p class="text-[11px] text-gray-500 mt-1">
                    Ширина «коридора» прогноза. Чем дальше месяц, тем шире неопределённость.
                  </p>
                </div>
              </div>
            </div>
          </details>

          <div v-if="formError" class="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
            ⚠ {{ formError }}
          </div>

          <button type="submit" :disabled="submitting"
            class="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:cursor-not-allowed
                   text-white font-semibold py-2.5 rounded transition">
            {{ submitting ? 'Загрузка…' : 'Построить прогноз' }}
          </button>
        </form>
      </section>

      <!-- ─── Список задач ─────────────────────────────────────── -->
      <section class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <header class="mb-3 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-gray-100">Мои прогнозы</h2>
          <button @click="store.fetchTasks()"
                  class="text-xs text-indigo-400 hover:text-indigo-300">↻ обновить</button>
        </header>

        <div v-if="store.loading && store.tasks.length === 0" class="text-sm text-gray-500">Загрузка…</div>
        <div v-else-if="store.tasks.length === 0" class="text-sm text-gray-500">
          Пока нет ни одного прогноза. Введите ключевые запросы слева.
        </div>

        <ul v-else class="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          <li v-for="t in store.tasks" :key="t.id"
              class="border border-gray-800 rounded-lg p-3 hover:border-indigo-600 transition cursor-pointer"
              @click="router.push(`/forecaster/${t.id}`)">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-100 truncate">{{ t.name || '(без имени)' }}</div>
                <div class="text-xs text-gray-500 mt-0.5">
                  {{ fmtDate(t.created_at) }} · {{ t.source_rows_count || 0 }} строк
                  <span v-if="t.source_filename"> · 📎 {{ t.source_filename }}</span>
                </div>
                <div v-if="t.error_message" class="text-xs text-rose-400 mt-1 truncate">⚠ {{ t.error_message }}</div>
              </div>
              <div class="flex flex-col items-end gap-1">
                <span class="text-[10px] uppercase font-semibold border rounded px-1.5 py-0.5"
                      :class="statusBadge(t.status)">{{ t.status }}</span>
                <button v-if="t.status === 'done' || t.status === 'error'" @click.stop="removeTask(t.id)"
                        class="text-[11px] text-gray-500 hover:text-rose-400">удалить</button>
              </div>
            </div>
          </li>
        </ul>

        <p v-if="hasInFlight" class="text-[11px] text-gray-500 mt-3 italic">
          ↻ Автообновление каждые 4 секунды, пока есть активные задачи.
        </p>
      </section>
    </div>
  </AppLayout>
</template>
