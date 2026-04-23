<script setup>
/**
 * Вкладка «Сформировать JSON»
 *
 * Вспомогательный помощник: берёт HTML сгенерированного на вкладке
 * «Генератор SEO текста» текста и через AITunnel API (модель Qwen)
 * формирует ACF Flexible Content JSON для импорта в WordPress.
 *
 * Логика и системный промт перенесены из вспомогательного файла
 * `JSON-v2 (2).html` в корне репозитория.
 *
 * ВАЖНО: API-ключ AITunnel зашит прямо в код (по требованию задачи).
 *        НЕ читается из ENV и НЕ оборачивается в backend-прокси —
 *        запросы уходят напрямую из браузера на api.aitunnel.ru.
 *
 * Главное правило: текст НЕ переписывается — только распределяется
 * по контейнерам ACF из задания (blocks / steps / bens / price / faq /
 * attention / expert).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import { useTasksStore } from '../stores/tasks.js';

const store = useTasksStore();

// ── API AITunnel ───────────────────────────────────────────────────────────
// Ключ зашит в код намеренно (см. требования задачи). Не выносить в ENV.
const AITUNNEL_API_KEY = 'sk-aitunnel-S81NPYt7iGa9X5Lsx9g4e8D9WXlAh5cm';
const AITUNNEL_URL     = 'https://api.aitunnel.ru/v1/chat/completions';
// «Qwen3.5 Plus» из ТЗ — у AITunnel это модель `qwen-plus`.
const AITUNNEL_MODEL   = 'qwen3.5-plus-02-15';

// ── Состояние ──────────────────────────────────────────────────────────────
const loadingTasks = ref(false);
const loadingHtml  = ref(false);
const generating   = ref(false);
const progressText = ref('');
const errorMsg     = ref('');
const resultJson   = ref('');
const copyState    = ref('idle'); // idle | copied

const selectedTaskId = ref(null);
const selectedHtml   = ref('');

// Только задачи, у которых есть сгенерированный текст
const eligibleTasks = computed(() =>
  (store.tasks || [])
    .filter((t) => t.status === 'completed')
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
);

const selectedTask = computed(() =>
  eligibleTasks.value.find((t) => t.id === selectedTaskId.value) || null,
);

const htmlPreview = computed(() => {
  const s = selectedHtml.value || '';
  return s.length > 1500 ? s.slice(0, 1500) + '…' : s;
});

const htmlSize = computed(() => {
  const s = selectedHtml.value || '';
  return {
    chars: s.length,
    kb: (s.length / 1024).toFixed(1),
  };
});

// ── Загрузка задач ─────────────────────────────────────────────────────────
let pollTimer = null;
onMounted(async () => {
  loadingTasks.value = true;
  try {
    await store.fetchTasks();
  } catch (e) {
    errorMsg.value = e.response?.data?.error || e.message || 'Не удалось загрузить задачи';
  } finally {
    loadingTasks.value = false;
  }
  // Освежаем список раз в 15 сек, чтобы новые завершившиеся задачи появлялись
  pollTimer = setInterval(() => {
    store.fetchTasks().catch(() => { /* тихо игнорируем фоновый сбой */ });
  }, 15000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

// ── Выбор задачи → подгрузка HTML ──────────────────────────────────────────
async function selectTask(task) {
  if (!task) return;
  selectedTaskId.value = task.id;
  selectedHtml.value   = '';
  resultJson.value     = '';
  errorMsg.value       = '';
  loadingHtml.value    = true;
  try {
    const data = await store.fetchResult(task.id);
    // Приоритет: отредактированный HTML (AI-Copilot) → исходный сгенерированный
    selectedHtml.value = data?.task?.full_html_edited || data?.task?.full_html || '';
    if (!selectedHtml.value) {
      errorMsg.value = 'У выбранной задачи нет сгенерированного HTML-текста.';
    }
  } catch (e) {
    errorMsg.value = e.response?.data?.error || e.message || 'Не удалось загрузить HTML задачи';
  } finally {
    loadingHtml.value = false;
  }
}

// ── Чанкование HTML ────────────────────────────────────────────────────────
// Делим по границам блочных HTML-тегов, чтобы не рвать абзац посередине.
// Если границ нет — режем по пустым строкам, как в исходном JSON-v2 (2).html.
function chunkHtml(html, maxLength = 6000) {
  if (!html) return [];
  if (html.length <= maxLength) return [html];

  // 1) Пытаемся резать по закрывающим блочным тегам
  const parts = html.split(/(?<=<\/(?:p|h[1-6]|ul|ol|div|blockquote|table|section|article)>)/i);
  if (parts.length > 1) {
    return packParts(parts, maxLength);
  }

  // 2) Запасной вариант — по двойному переносу строки
  const byBlanks = html.split(/\n\n+/);
  if (byBlanks.length > 1) {
    return packParts(byBlanks.map((p, i, arr) => (i < arr.length - 1 ? p + '\n\n' : p)), maxLength);
  }

  // 3) Жёсткая нарезка по символам как последний рубеж
  const chunks = [];
  for (let i = 0; i < html.length; i += maxLength) {
    chunks.push(html.slice(i, i + maxLength));
  }
  return chunks;
}

function packParts(parts, maxLength) {
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if (cur.length + p.length > maxLength && cur.length > 0) {
      chunks.push(cur);
      cur = '';
    }
    cur += p;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// ── Системный промт (перенос из JSON-v2 (2).html, оставлены только ─────────
// ── 7 типов блоков, перечисленных в техническом задании) ───────────────────
const BASE_SYSTEM_PROMPT = `РОЛЬ И ЗАДАЧА:
Ты — Умный Алгоритм-Роутер контента в JSON-структуры WordPress ACF Flexible Content.
Твоя цель: Раскидать текст по разным красивым блокам (blocks, steps, bens, price, faq, attention, expert), НО при этом не потерять ни одного слова из оригинального текста.

--- ЗАДАЧА 1: СОХРАННОСТЬ ТЕКСТА (ZERO REWRITE) ---
- ЗАПРЕЩЕНО переписывать, сжимать, перефразировать или удалять оригинальный текст из тела абзацев.
- Текст внутри полей text, content, answer должен состоять из 100% оригинальных абзацев.
- Все текстовые поля должны быть обернуты в валидный HTML (<p>, <ul>, <li>, <strong>).
- ЗАПРЕЩЕНО дублировать контент. Каждый абзац должен попасть в JSON только 1 раз.
- ЗАПРЕЩЕНО придумывать факты, цифры, цены или цитаты, которых нет в исходном тексте.

--- ЗАДАЧА 2: УМНАЯ НАРЕЗКА В СЛОЖНЫЕ БЛОКИ (SMART CHUNKING) ---
Чтобы упаковать сплошной текст в сложные массивы (steps, bens, faq, expert), используй следующий алгоритм:
1. Анализируй заголовок раздела И сам текст внутри абзацев.
2. Выбери подходящий блок (для процесса -> "steps", для плюсов -> "bens", для вопросов -> "faq", для цитат -> "expert").
3. Разбей сплошной текст под этим заголовком на абзацы.
4. РАЗРЕШЕНИЕ НА ГЕНЕРАЦИЮ: Ты ИМЕЕШЬ ПРАВО самостоятельно придумать короткий логичный заголовок для каждого абзаца (в поля title или question).
5. Вставь оригинальный абзац ЦЕЛИКОМ в поле text, content или answer.

--- ПРАВИЛО ВЫДЕЛЕНИЯ ЭКСПЕРТОВ (EXPERT DETECTOR) ---
Внимательно сканируй каждый абзац на наличие реальных цитат.
КРИТИЧЕСКОЕ ОГРАНИЧЕНИЕ: Блок "expert" разрешено использовать СТРОГО 1 РАЗ на весь итоговый JSON!
1. Если ты видишь ПРЯМУЮ РЕЧЬ конкретного специалиста с указанием имени (например: "Иванов Дмитрий, эксперт: ...") -> ИЗОЛИРУЙ этот абзац в блок "expert".
2. ЗАПРЕЩЕНО создавать блок "expert", если в тексте просто встречается слово "эксперты" (например, "Профильные эксперты подтверждают..."). Блок создается только для конкретного лица.
3. Если ты уже создал один блок "expert", то лимит исчерпан. Все последующие цитаты или упоминания экспертов оставляй внутри обычных текстовых блоков ("blocks").

АЛГОРИТМ ВЫБОРА ОСТАЛЬНЫХ БЛОКОВ:
- "Преимущества", "Плюсы", "Вызовы", "Конкуренция" -> блок "bens"
- "Этапы", "Процесс", "Сценарии", "Как мы работаем" -> блок "steps"
- "Вопросы", "FAQ", "Частые вопросы" -> блок "faq"
- "Цены", "Стоимость", "Тарифы", "Прайс" -> блок "price"
- "Внимание", "Важно", выделенные предупреждения -> блок "attention"
- Введение, Выводы, История, общие размышления, описания -> блок "blocks"

--- ДОСТУПНЫЕ ТИПЫ БЛОКОВ (acf_fc_layout) И ИХ СХЕМЫ ---

1. "blocks" (Универсальный сплошной текст)
{ "acf_fc_layout": "blocks", "title": "Заголовок", "subtitle": "<p>Подзаголовок</p>", "blocks": [ { "block_width": "12", "bg_color": "default", "text": "<p>Текст</p>", "image": "", "url": "" } ], "type": "1", "vert_center": false, "block_equal_height": false }

2. "steps" (Этапы процедуры)
{ "acf_fc_layout": "steps", "title": "Процесс", "subtitle": "Подзаголовок", "items": [ { "title": "Шаг 1", "text": "<p>Текст</p>" } ], "columns": "4" }

3. "bens" (Преимущества)
{ "acf_fc_layout": "bens", "title": "Преимущества", "color_title": "#000000", "subtitle": "Подзаголовок", "items": [ { "title": "Плюс 1", "image": "", "text": "<p>Текст</p>" } ], "columns": "4", "image": "" }

4. "price" (Прайс-лист)
{ "acf_fc_layout": "price", "title": "Прайс", "subtitle": "<p>Подзаголовок</p>", "items": [ { "title": "Услуга", "text": "Описание", "price": "5 000 Р" } ] }

5. "faq" (Вопросы и ответы)
{ "acf_fc_layout": "faq", "title": "FAQ", "subtitle": "<p>Подзаголовок</p>", "faq": [ { "question": "Вопрос?", "answer": "<p>Ответ</p>" } ] }

6. "attention" (Важная вставка)
{ "acf_fc_layout": "attention", "title": "Внимание", "text": "<p>Выделенный текст</p>", "image": "" }

7. "expert" (Мнение эксперта)
{ "acf_fc_layout": "expert", "title": "Мнение", "expert": "", "text": "<p>Цитата</p>" }

--- ТЕХНИЧЕСКИЕ ПРАВИЛА ВЫВОДА JSON (КРИТИЧЕСКИ ВАЖНО) ---
1. Вывод ДОЛЖЕН БЫТЬ строго JSON массивом объектов.
2. НЕ используй форматирование кода markdown. Выводи только чистый JSON.
3. Внутри текстовых полей (text, content, answer) КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать символ двойной кавычки. ВООБЩЕ.
   - Для атрибутов HTML используй ТОЛЬКО одинарные кавычки (например, <a href='link'>).
   - Для цитат в тексте используй ТОЛЬКО елочки (« ») или одинарные кавычки (' ').`;

// ── Безопасное извлечение JSON-массива из «грязной» строки ────────────────
function extractCleanJson(str) {
  const firstBracket = str.indexOf('[');
  if (firstBracket === -1) throw new Error('В ответе нет JSON массива.');

  let lastIndex = -1;
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBracket; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') braceCount++;
    if (ch === '}') braceCount--;
    if (ch === '[') bracketCount++;
    if (ch === ']') bracketCount--;

    if (braceCount === 0 && bracketCount === 0) {
      lastIndex = i;
      break;
    }
  }

  if (lastIndex === -1) throw new Error('Не найдено корректное завершение JSON.');
  return str.substring(firstBracket, lastIndex + 1);
}

// ── Главное действие: сформировать JSON ────────────────────────────────────
async function generateJson() {
  errorMsg.value   = '';
  resultJson.value = '';
  copyState.value  = 'idle';

  if (!selectedHtml.value) {
    errorMsg.value = 'Сначала выберите задачу со сгенерированным HTML-текстом.';
    return;
  }

  generating.value = true;
  try {
    const chunks = chunkHtml(selectedHtml.value, 6000);
    const total  = chunks.length;
    const finalArray = [];
    let expertAlreadyUsed = false;

    for (let i = 0; i < total; i++) {
      progressText.value = total > 1
        ? `Маппинг контента: часть ${i + 1} из ${total}…`
        : 'Анализ и сборка JSON…';

      let systemPrompt = BASE_SYSTEM_PROMPT;
      if (expertAlreadyUsed) {
        systemPrompt += `\n\n[СИСТЕМНОЕ ВАЖНОЕ УВЕДОМЛЕНИЕ]: В предыдущих частях текста ТЫ УЖЕ СОЗДАЛ блок "expert". Лимит исчерпан! В этой части КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать "acf_fc_layout": "expert". Упаковывай любые цитаты в обычные "blocks".`;
      }

      const userPrompt = `Обработай следующие данные (это часть HTML-текста статьи) и верни массив JSON для ACF. Сохрани каждый абзац дословно, только распредели по блокам:\n\n${chunks[i]}`;

      let response;
      try {
        response = await fetch(AITUNNEL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // .trim() — на случай случайных пробелов/переносов в константе
            Authorization: `Bearer ${AITUNNEL_API_KEY.trim()}`,
          },
          body: JSON.stringify({
            model: AITUNNEL_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 8192,
          }),
        });
      } catch (networkError) {
        throw new Error(
          `Сеть недоступна (Failed to fetch). Проверьте интернет/VPN. Детали: ${networkError.message}`,
        );
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ошибка AITunnel ${response.status}: ${errText}`);
      }

      const data = await response.json();
      if (!data.choices || data.choices.length === 0) {
        throw new Error('AITunnel вернул пустой ответ.');
      }
      if (data.choices[0].finish_reason === 'length') {
        throw new Error('Текст слишком большой — модель не успела закрыть JSON. Попробуйте сократить HTML.');
      }

      let raw = data.choices[0].message?.content || '';
      raw = raw.replace(/```json/gi, '').replace(/```/g, '');

      const cleanJson    = extractCleanJson(raw);
      const parsedOutput = JSON.parse(cleanJson);
      const outputArray  = Array.isArray(parsedOutput) ? parsedOutput : [parsedOutput];

      // Программная защита от галлюцинаций: единственность блока "expert"
      for (const block of outputArray) {
        if (block && block.acf_fc_layout === 'expert') {
          if (expertAlreadyUsed) {
            // Принудительно конвертируем в обычный "blocks"
            block.acf_fc_layout = 'blocks';
            block.blocks = [{
              block_width: '12',
              bg_color:    'default',
              text:        block.text || '',
              image:       '',
              url:         '',
            }];
            delete block.expert;
            delete block.text;
          } else {
            expertAlreadyUsed = true;
          }
        }
        finalArray.push(block);
      }
    }

    resultJson.value = JSON.stringify(finalArray, null, 2);
    progressText.value = '';
  } catch (err) {
    console.error('[AcfJson] generation error:', err);
    errorMsg.value = 'Ошибка: ' + err.message;
  } finally {
    generating.value = false;
  }
}

// ── Копирование ────────────────────────────────────────────────────────────
async function copyJson() {
  if (!resultJson.value) return;
  try {
    await navigator.clipboard.writeText(resultJson.value);
    copyState.value = 'copied';
    setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch (e) {
    errorMsg.value = 'Не удалось скопировать: ' + (e.message || e);
  }
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
</script>

<template>
  <AppLayout>
    <div class="max-w-7xl mx-auto px-6 py-8">
      <!-- Заголовок -->
      <div class="mb-6">
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span>🧩</span> Сформировать JSON
        </h1>
        <p class="text-sm text-gray-500 mt-1">
          Выберите задачу со сгенерированным текстом — её HTML будет передан
          в Qwen через AITunnel и распределён по контейнерам ACF Flexible Content
          для импорта в WordPress. Текст не переписывается — только раскладывается по блокам.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Левая колонка: список задач ────────────────────────────── -->
        <div class="lg:col-span-5 space-y-4">
          <div class="card p-0 overflow-hidden">
            <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-white">Готовые задачи</h2>
              <span class="text-xs text-gray-500">{{ eligibleTasks.length }}</span>
            </div>

            <div v-if="loadingTasks" class="px-5 py-8 text-center text-gray-500 text-sm">
              Загрузка задач…
            </div>
            <div v-else-if="!eligibleTasks.length" class="px-5 py-8 text-center text-gray-500 text-sm">
              Пока нет завершённых задач со сгенерированным текстом.
            </div>
            <ul v-else class="max-h-[60vh] overflow-y-auto divide-y divide-gray-800">
              <li
                v-for="t in eligibleTasks"
                :key="t.id"
                @click="selectTask(t)"
                :class="[
                  'px-5 py-3 cursor-pointer transition-colors',
                  selectedTaskId === t.id
                    ? 'bg-indigo-950/40 border-l-4 border-indigo-500'
                    : 'hover:bg-gray-800/40 border-l-4 border-transparent',
                ]"
              >
                <p class="text-sm text-white font-medium truncate">
                  {{ t.title || t.input_target_service || `Задача #${t.id}` }}
                </p>
                <p class="text-xs text-gray-500 mt-0.5">
                  {{ fmtDate(t.created_at) }}
                  <span v-if="t.lsi_coverage" class="ml-2">· LSI {{ t.lsi_coverage }}%</span>
                </p>
              </li>
            </ul>
          </div>

          <!-- Превью HTML выбранной задачи -->
          <div v-if="selectedTask" class="card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-white">HTML задачи</h3>
              <span v-if="selectedHtml" class="text-xs text-gray-500">
                {{ htmlSize.chars.toLocaleString('ru-RU') }} симв. · {{ htmlSize.kb }} KB
              </span>
            </div>
            <div v-if="loadingHtml" class="text-sm text-gray-500 py-6 text-center">
              Загрузка HTML…
            </div>
            <pre
              v-else-if="selectedHtml"
              class="text-xs text-gray-400 bg-gray-950 border border-gray-800 rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap break-words"
            >{{ htmlPreview }}</pre>
            <p v-else class="text-sm text-gray-500">Нет HTML.</p>

            <button
              class="btn-primary w-full justify-center mt-4"
              :disabled="generating || !selectedHtml"
              @click="generateJson"
            >
              <span
                v-if="generating"
                class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
              ></span>
              {{ generating ? (progressText || 'Формируем JSON…') : '✨ Сформировать JSON' }}
            </button>
          </div>
        </div>

        <!-- ── Правая колонка: результат ──────────────────────────────── -->
        <div class="lg:col-span-7">
          <div class="card h-full flex flex-col">
            <div class="flex items-center justify-between mb-4 border-b border-gray-800 pb-3">
              <h2 class="text-sm font-semibold text-white flex items-center gap-2">
                📦 Готовый JSON
                <span
                  v-if="resultJson"
                  class="bg-emerald-900/50 text-emerald-300 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wide"
                >
                  Валидный
                </span>
              </h2>
              <button
                v-if="resultJson"
                @click="copyJson"
                class="btn-secondary text-xs px-3 py-1.5"
              >
                {{ copyState === 'copied' ? '✅ Скопировано' : '📋 Копировать' }}
              </button>
            </div>

            <div
              v-if="errorMsg"
              class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm mb-4"
            >
              🚨 {{ errorMsg }}
            </div>

            <div
              v-if="!resultJson && !generating"
              class="flex-1 flex flex-col items-center justify-center text-gray-600 text-sm italic border-2 border-dashed border-gray-800 rounded-lg p-8 min-h-[300px]"
            >
              Здесь появится массив ACF для импорта в WordPress
            </div>

            <div
              v-else-if="generating"
              class="flex-1 flex flex-col items-center justify-center text-emerald-400 space-y-3 border-2 border-dashed border-gray-800 rounded-lg p-8 min-h-[300px]"
            >
              <div class="w-8 h-8 border-2 border-emerald-500/40 border-t-emerald-400 rounded-full animate-spin"></div>
              <p class="text-sm font-mono text-center">
                {{ progressText || 'Идёт маппинг контента…' }}
              </p>
              <p class="text-xs text-gray-500">Раскладываем по blocks, steps, bens, faq, price, attention, expert</p>
            </div>

            <pre
              v-else
              class="flex-1 m-0 bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-indigo-300 overflow-auto max-h-[70vh]"
            ><code>{{ resultJson }}</code></pre>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
