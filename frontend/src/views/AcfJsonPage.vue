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
// Бюджет вывода модели. Поднят с 8192 → 16384, чтобы JSON-обвязка
// (acf_fc_layout, schema-обёртки, повторение текста дословно) гарантированно
// помещалась рядом с самим контентом и не приходила обрезанной.
const MAX_OUTPUT_TOKENS = 16384;
// Размер чанка по умолчанию. Уменьшен с 6000 → 4000 — это оставляет головой
// запас на JSON-обвязку при MAX_OUTPUT_TOKENS=16384.
const DEFAULT_CHUNK_LEN = 4000;
// Минимальный размер чанка при авто-ретрае «finish_reason=length». Делим
// проблемный чанк пополам, но не уходим ниже 800 симв., чтобы не выродиться
// в десятки запросов из-за нескольких очень длинных слов/тегов.
const MIN_RETRY_CHUNK_LEN = 800;
// Поля JSON-вывода, которые считаются «текстовыми» при сборе фолбэка
// expert→blocks (сюда модель кладёт оригинальные абзацы).
const TEXT_FIELD_NAMES = /^(text|content|answer|expert|subtitle)$/i;

// ── Состояние ──────────────────────────────────────────────────────────────
const loadingTasks = ref(false);
const loadingHtml  = ref(false);
const formError    = ref(''); // ошибки формы создания задачи (выбор/загрузка HTML)

const selectedTaskId = ref(null);
const selectedHtml   = ref('');

// Очередь задач формирования JSON. Каждая задача — это локальный фоновый
// «job», обрабатываемый в браузере (LLM-вызов идёт прямо из фронта на
// AITunnel). Состояния: queued → processing → done | error.
// Хранится в памяти страницы (не в БД), как и всё на этой вкладке.
const jobs = ref([]);
let nextJobId = 1;
let queueRunning = false;

// Модалка с результатом
const activeJobId = ref(null);
const showModal   = ref(false);
const copyState   = ref('idle'); // idle | copied
const copyError   = ref('');     // ошибка копирования в модалке (Clipboard API недоступен и т. п.)

const activeJob = computed(() =>
  jobs.value.find((j) => j.id === activeJobId.value) || null,
);

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

// Обратная совместимость со старым именем для шаблона.
// Можно ли запустить новую задачу: HTML загружен и не пуст.
const canCreateJob = computed(() => Boolean(selectedHtml.value && !loadingHtml.value));

// ── Загрузка задач ─────────────────────────────────────────────────────────
let pollTimer = null;
onMounted(async () => {
  loadingTasks.value = true;
  try {
    await store.fetchTasks();
  } catch (e) {
    formError.value = e.response?.data?.error || e.message || 'Не удалось загрузить задачи';
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
  formError.value      = '';
  loadingHtml.value    = true;
  try {
    const data = await store.fetchResult(task.id);
    // Приоритет: отредактированный HTML (AI-Copilot) → исходный сгенерированный
    selectedHtml.value = data?.task?.full_html_edited || data?.task?.full_html || '';
    if (!selectedHtml.value) {
      formError.value = 'У выбранной задачи нет сгенерированного HTML-текста.';
    }
  } catch (e) {
    formError.value = e.response?.data?.error || e.message || 'Не удалось загрузить HTML задачи';
  } finally {
    loadingHtml.value = false;
  }
}

// ── Чанкование HTML ────────────────────────────────────────────────────────
// Принципы:
//  • Никогда не режем посередине HTML-тега и посередине слова.
//  • Иерархия точек разреза (от самой «крупной» к самой «мелкой»):
//      1) закрывающие блочные теги: </p>, </h1..6>, </ul>, </ol>, </div>,
//         </blockquote>, </table>, </section>, </article>
//      2) </li>
//      3) </tr>
//      4) граница предложения «. » / «! » / «? »
//      5) пробел между словами (только если предыдущих границ нет)
//  • Если кусок всё равно > maxLength, рекурсивно дробим его той же лестницей.
//  • Инвариант: chunks.join('') === html — проверяется перед запросом.
const SPLIT_LADDER = [
  /(?<=<\/(?:p|h[1-6]|ul|ol|div|blockquote|table|section|article)>)/i,
  /(?<=<\/li>)/i,
  /(?<=<\/tr>)/i,
  // Граница предложения: точка/!/? + пробел; исключаем уже закрытые теги, чтобы
  // не дублировать первую группу. Lookbehind по нескольким символам поддержан
  // во всех современных браузерах (поддержка Vue 3 — ES2018+).
  /(?<=[.!?])\s+/,
  // Любой пробел/перенос — последний рубеж ПЕРЕД hard-slice.
  /(?<=\s)(?=\S)/,
];

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

// Разрезает один кусок строки безопасно по лестнице сепараторов.
// Возвращает массив подкусков, каждый ≤ maxLength по возможности.
// НИКОГДА не режет по символам внутри слова или внутри тега — если ни один
// сепаратор не срабатывает, возвращает [piece] (вызывающая сторона решает,
// что делать; но мы сужаем чанк, прежде чем дойти до этого).
function splitPiece(piece, maxLength, ladderIdx = 0) {
  if (piece.length <= maxLength) return [piece];

  for (let idx = ladderIdx; idx < SPLIT_LADDER.length; idx++) {
    const re = SPLIT_LADDER[idx];
    const parts = piece.split(re);
    if (parts.length <= 1) continue;

    // Сначала пакуем как есть.
    const packed = packParts(parts, maxLength);
    // Если что-то всё ещё слишком большое — рекурсивно дробим именно этот
    // подкусок следующим уровнем лестницы.
    const result = [];
    for (const p of packed) {
      if (p.length <= maxLength) {
        result.push(p);
      } else {
        result.push(...splitPiece(p, maxLength, idx + 1));
      }
    }
    // Если на этом уровне получилось хоть какое-то реальное разбиение —
    // возвращаем результат; иначе пробуем следующий уровень.
    if (result.length > 1 || result[0].length < piece.length) return result;
  }

  // Все уровни исчерпаны (нет ни тегов, ни пробелов). Возвращаем как есть —
  // это единственное «слово» без пробелов; модель попробует его проглотить
  // целиком. Hard-slice по символам сознательно НЕ применяем, чтобы не
  // порвать слово/тег.
  return [piece];
}

function chunkHtml(html, maxLength = DEFAULT_CHUNK_LEN) {
  if (!html) return [];
  if (html.length <= maxLength) return [html];
  return splitPiece(html, maxLength, 0);
}

// ── Системный промт (перенос из JSON-v2 (2).html, оставлены только ─────────
// ── 7 типов блоков, перечисленных в техническом задании) ───────────────────
const BASE_SYSTEM_PROMPT = `РОЛЬ И ЗАДАЧА:
Ты — Умный Алгоритм-Роутер контента в JSON-структуры WordPress ACF Flexible Content.
Твоя цель: Раскидать текст по разным красивым блокам (blocks, steps, bens, price, faq, attention, expert), НО при этом не потерять ни одного слова из оригинального текста.

--- ЗАДАЧА 1: СОХРАННОСТЬ ТЕКСТА (ZERO REWRITE) ---
- ЗАПРЕЩЕНО переписывать, сжимать, перефразировать или удалять оригинальный текст из тела абзацев.
- Текст внутри полей text, content, answer должен состоять из 100% оригинальных абзацев.
- ЗАПРЕЩЕНО менять, удалять или нормализовать пробелы, переносы строк, неразрывные пробелы и пунктуацию внутри text/content/answer — даже если ты считаешь, что так «красивее» или «грамотнее». Сохраняй пробельную ткань 1-в-1.
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

  if (lastIndex === -1) {
    if (inString) {
      throw new Error('JSON оборван внутри строки (модель не закрыла кавычку — вероятно, упёрлась в лимит токенов).');
    }
    throw new Error('Не найдено корректное завершение JSON.');
  }
  return str.substring(firstBracket, lastIndex + 1);
}

// ── Утилиты пост-валидации сохранности текста ─────────────────────────────
// Снимаем теги, декодируем сущности, нормализуем пробелы.
function stripTagsAndNormalize(s) {
  if (!s) return '';
  // Сначала убираем теги, затем декодируем базовые HTML-сущности.
  let t = String(s).replace(/<[^>]*>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // NFC + сворачивание любых пробелов (вкл. неразрывный) в один обычный.
  try { t = t.normalize('NFC'); } catch (_) { /* старые движки */ }
  t = t.replace(/[\s\u00A0]+/g, ' ').trim();
  return t;
}

// Рекурсивно собирает все строковые значения из произвольной JSON-структуры.
function collectStrings(node, out) {
  if (node == null) return;
  if (typeof node === 'string') { out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectStrings(node[k], out);
  }
}

function outputPlainText(jsonArray) {
  const all = [];
  collectStrings(jsonArray, all);
  return stripTagsAndNormalize(all.join(' '));
}

// Извлекаем только все text/content/answer/expert (для фолбэка expert→blocks).
function collectTextFieldsDeep(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const v of node) collectTextFieldsDeep(v, out); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && TEXT_FIELD_NAMES.test(k)) {
        if (v.trim()) out.push(v);
      } else if (v && typeof v === 'object') {
        collectTextFieldsDeep(v, out);
      }
    }
  }
}

// Делит plain-text на «фразы сохранности»: окна по WINDOW слов с шагом STEP.
// Короткий хвост остаётся отдельным окном, чтобы не пропустить концовку.
function buildPreservationPhrases(plain, windowWords = 6, stepWords = 3) {
  const words = plain.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= windowWords) return [words.join(' ')];
  const phrases = [];
  for (let i = 0; i + windowWords <= words.length; i += stepWords) {
    phrases.push(words.slice(i, i + windowWords).join(' '));
  }
  // Гарантируем, что последняя пачка слов покрыта.
  const lastStart = Math.max(0, words.length - windowWords);
  const last = words.slice(lastStart).join(' ');
  if (phrases[phrases.length - 1] !== last) phrases.push(last);
  return phrases;
}

// Возвращает массив пропавших фраз (пусто = всё на месте).
function findMissingPhrases(inputPlain, outputPlain) {
  const phrases = buildPreservationPhrases(inputPlain);
  const missing = [];
  for (const ph of phrases) {
    if (!ph) continue;
    if (outputPlain.indexOf(ph) === -1) missing.push(ph);
  }
  return missing;
}

// ── Один HTTP-вызов к AITunnel ────────────────────────────────────────────
async function callAitunnel({ systemPrompt, userPrompt }) {
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
        max_tokens: MAX_OUTPUT_TOKENS,
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
  return data.choices[0];
}

function parseModelOutputArray(rawContent) {
  let raw = rawContent || '';
  raw = raw.replace(/```json/gi, '').replace(/```/g, '');
  const cleanJson    = extractCleanJson(raw);
  const parsedOutput = JSON.parse(cleanJson);
  return Array.isArray(parsedOutput) ? parsedOutput : [parsedOutput];
}

// Обрабатывает ОДИН чанк: запрос → авто-ретрай при finish=length →
// пост-валидация → один корректирующий ре-запрос → возврат массива блоков.
// На неустранимых пропусках кидает Error со списком потерь.
async function processChunk({
  chunkHtmlText,
  baseSystemPrompt,
  expertAlreadyUsed,
  chunkLabel,
}) {
  const systemPromptBase = expertAlreadyUsed
    ? baseSystemPrompt + `\n\n[СИСТЕМНОЕ ВАЖНОЕ УВЕДОМЛЕНИЕ]: В предыдущих частях текста ТЫ УЖЕ СОЗДАЛ блок "expert". Лимит исчерпан! В этой части КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать "acf_fc_layout": "expert". Упаковывай любые цитаты в обычные "blocks".`
    : baseSystemPrompt;

  const userPrompt = `Обработай следующие данные (это часть HTML-текста статьи) и верни массив JSON для ACF. Сохрани каждый абзац дословно, только распредели по блокам:\n\n${chunkHtmlText}`;

  const choice = await callAitunnel({ systemPrompt: systemPromptBase, userPrompt });

  // Авто-ретрай при обрыве по длине: рекурсивно дробим этот же чанк пополам
  // через тот же безопасный сплиттер и обрабатываем подкуски один за другим.
  if (choice.finish_reason === 'length') {
    const half = Math.max(MIN_RETRY_CHUNK_LEN, Math.floor(chunkHtmlText.length / 2));
    const sub = chunkHtml(chunkHtmlText, half);
    if (sub.length <= 1) {
      throw new Error(
        `Модель не смогла закрыть JSON для ${chunkLabel} (длина ${chunkHtmlText.length} симв.) даже при максимальном бюджете и не удаётся безопасно перенарезать (нет границ тегов/предложений/слов). Сократите HTML вручную.`,
      );
    }
    const merged = [];
    let expertUsedLocal = expertAlreadyUsed;
    for (let k = 0; k < sub.length; k++) {
      const subRes = await processChunk({
        chunkHtmlText: sub[k],
        baseSystemPrompt,
        expertAlreadyUsed: expertUsedLocal,
        chunkLabel: `${chunkLabel} → подчасть ${k + 1}/${sub.length}`,
      });
      for (const b of subRes.blocks) {
        if (b && b.acf_fc_layout === 'expert') expertUsedLocal = true;
        merged.push(b);
      }
    }
    return { blocks: merged, expertUsedAfter: expertUsedLocal };
  }

  let outputArray = parseModelOutputArray(choice.message?.content);

  // Пост-валидация сохранности текста.
  const inputPlain = stripTagsAndNormalize(chunkHtmlText);
  let outPlain     = outputPlainText(outputArray);
  let missing      = findMissingPhrases(inputPlain, outPlain);

  if (missing.length > 0) {
    // Один корректирующий ре-запрос: даём модели список потерянных фрагментов
    // и просим вернуть их дословно в подходящие text/content/answer.
    const sample = missing.slice(0, 20);
    const correctiveSystem = systemPromptBase + `\n\n[ИСПРАВЛЕНИЕ — КРИТИЧНО]
В предыдущей попытке ты ПОТЕРЯЛ перечисленные ниже фрагменты исходного текста. Верни ИХ ВСЕ ДОСЛОВНО внутри подходящих полей text/content/answer соответствующих блоков. Не перефразируй, не сокращай, не нормализуй пробелы.
Потерянные фрагменты (по одной строке на фрагмент):
${sample.map((m) => `• ${m}`).join('\n')}${missing.length > sample.length ? `\n• …и ещё ${missing.length - sample.length} фрагмент(ов) — не забудь их тоже.` : ''}`;
    const correctiveUser = `Сформируй массив JSON ACF заново для того же исходника, СОХРАНИВ ВСЕ потерянные фрагменты дословно. Исходник:\n\n${chunkHtmlText}`;
    const choice2 = await callAitunnel({ systemPrompt: correctiveSystem, userPrompt: correctiveUser });
    if (choice2.finish_reason !== 'length') {
      try {
        const retryArr = parseModelOutputArray(choice2.message?.content);
        const retryPlain = outputPlainText(retryArr);
        const retryMissing = findMissingPhrases(inputPlain, retryPlain);
        if (retryMissing.length === 0) {
          outputArray = retryArr;
          outPlain = retryPlain;
          missing = [];
        } else if (retryMissing.length < missing.length) {
          // Прогресс есть, но не идеально — берём лучший вариант и сообщаем.
          outputArray = retryArr;
          outPlain = retryPlain;
          missing = retryMissing;
        }
      } catch (parseErr) {
        // Если корректирующий ответ не распарсился — оставляем исходную ошибку.
        console.warn('[AcfJson] corrective retry parse failed:', parseErr);
      }
    }
  }

  if (missing.length > 0) {
    const sample = missing.slice(0, 5).map((m) => `«${m}»`).join('; ');
    const totalLost = missing.reduce((a, m) => a + m.length, 0);
    throw new Error(
      `${chunkLabel}: после ре-запроса в JSON отсутствуют ${missing.length} фрагмент(ов) исходного текста (≈${totalLost} симв.). Примеры: ${sample}. Сгенерированный JSON НЕ применён, чтобы не потерять контент.`,
    );
  }

  // Программная защита от галлюцинаций: единственность блока "expert".
  // ВАЖНО: если блок expert надо превратить в blocks, собираем ВЕСЬ текст из
  // всех текстовых полей этого блока (text/content/answer/expert/subtitle),
  // чтобы не потерять ни абзаца независимо от формы, в которой модель его дала.
  const finalBlocks = [];
  let expertUsedAfter = expertAlreadyUsed;
  for (const block of outputArray) {
    if (block && block.acf_fc_layout === 'expert') {
      if (expertUsedAfter) {
        const allTexts = [];
        collectTextFieldsDeep(block, allTexts);
        // Если HTML-обёртки не нашлось — оборачиваем сами, чтобы остаться валидными.
        const joined = allTexts.length
          ? allTexts.map((t) => (/^\s*<[^>]+>/.test(t) ? t : `<p>${t}</p>`)).join('\n')
          : '';
        const converted = {
          acf_fc_layout: 'blocks',
          title: block.title || '',
          subtitle: '',
          blocks: [{
            block_width: '12',
            bg_color:    'default',
            text:        joined,
            image:       '',
            url:         '',
          }],
          type: '1',
          vert_center: false,
          block_equal_height: false,
        };
        finalBlocks.push(converted);
        continue;
      } else {
        expertUsedAfter = true;
      }
    }
    finalBlocks.push(block);
  }

  return { blocks: finalBlocks, expertUsedAfter };
}

// ── Главное действие: добавить задачу формирования JSON в очередь ──────────
function addJob() {
  formError.value = '';

  if (!selectedTask.value) {
    formError.value = 'Сначала выберите исходную задачу слева.';
    return;
  }
  if (!selectedHtml.value) {
    formError.value = 'У выбранной задачи нет HTML — выберите другую.';
    return;
  }

  const job = {
    id:           nextJobId++,
    sourceTaskId: selectedTask.value.id,
    title:        selectedTask.value.title || selectedTask.value.input_target_service || `Задача #${selectedTask.value.id}`,
    sourceHtml:   selectedHtml.value, // снимок исходника на момент создания
    sourceChars:  selectedHtml.value.length,
    status:       'queued',           // queued | processing | done | error
    progress:     'В очереди…',
    result:       '',                 // готовый JSON-текст (string)
    error:        '',
    createdAt:    new Date().toISOString(),
    finishedAt:   null,
  };
  // Новые задачи — наверх списка, чтобы пользователь сразу видел свежесозданное.
  jobs.value.unshift(job);

  // Запускаем фоновый процессор (если ещё не крутится).
  runQueue();
}

// Удаляет задачу из списка. Удалить можно ТОЛЬКО неактивные (done/error/queued).
// Активную (processing) удалять нельзя — иначе зависший fetch будет писать
// в несуществующий объект.
function removeJob(jobId) {
  const j = jobs.value.find((x) => x.id === jobId);
  if (!j || j.status === 'processing') return;
  jobs.value = jobs.value.filter((x) => x.id !== jobId);
  if (activeJobId.value === jobId) closeModal();
}

// Сбрасывает упавшую задачу в очередь, чтобы повторить попытку.
function retryJob(jobId) {
  const j = jobs.value.find((x) => x.id === jobId);
  if (!j || j.status === 'processing') return;
  j.status   = 'queued';
  j.progress = 'В очереди…';
  j.error    = '';
  j.result   = '';
  runQueue();
}

// Фоновый процессор очереди. Выполняет задачи строго по одной — на API
// AITunnel ходим из браузера, поэтому параллелить не стоит (rate-limit + UX).
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    /* eslint-disable no-await-in-loop */
    while (true) {
      const job = jobs.value.find((j) => j.status === 'queued');
      if (!job) break;
      await runJob(job);
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    queueRunning = false;
  }
}

// Обработка одной задачи. Использует существующий безопасный сплиттер +
// post-validation (см. processChunk выше).
async function runJob(job) {
  job.status   = 'processing';
  job.progress = 'Подготовка чанков…';
  job.error    = '';
  job.result   = '';

  try {
    const html = job.sourceHtml;
    const chunks = chunkHtml(html, DEFAULT_CHUNK_LEN);

    if (chunks.join('') !== html) {
      throw new Error('Внутренняя ошибка: чанкование изменило исходный HTML (нарушен инвариант chunks.join === html).');
    }

    const total = chunks.length;
    const finalArray = [];
    let expertAlreadyUsed = false;

    for (let i = 0; i < total; i++) {
      job.progress = total > 1
        ? `Маппинг контента: часть ${i + 1} из ${total}…`
        : 'Анализ и сборка JSON…';

      // eslint-disable-next-line no-await-in-loop
      const { blocks, expertUsedAfter } = await processChunk({
        chunkHtmlText:    chunks[i],
        baseSystemPrompt: BASE_SYSTEM_PROMPT,
        expertAlreadyUsed,
        chunkLabel:       `Часть ${i + 1} из ${total}`,
      });
      expertAlreadyUsed = expertUsedAfter;
      for (const b of blocks) finalArray.push(b);
    }

    job.result     = JSON.stringify(finalArray, null, 2);
    job.status     = 'done';
    job.progress   = '';
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    console.error('[AcfJson] job error:', err);
    job.status     = 'error';
    job.progress   = '';
    job.error      = err && err.message ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
    // Никогда не пишем «битый» JSON в job.result, чтобы пользователь не
    // случайно скопировал контент с потерями.
  }
}

// ── Модалка результата ────────────────────────────────────────────────────
function openJob(jobId) {
  const j = jobs.value.find((x) => x.id === jobId);
  if (!j) return;
  // Открываем модалку для done и error (в error показываем диагностику).
  if (j.status !== 'done' && j.status !== 'error') return;
  activeJobId.value = jobId;
  copyState.value   = 'idle';
  copyError.value   = '';
  showModal.value   = true;
}

function closeModal() {
  showModal.value = false;
  activeJobId.value = null;
  copyState.value = 'idle';
  copyError.value = '';
}

// ── Копирование ────────────────────────────────────────────────────────────
async function copyActiveJson() {
  const j = activeJob.value;
  if (!j || !j.result) return;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(j.result);
    copyState.value = 'copied';
    setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch (e) {
    // Фолбэк: при отсутствии Clipboard API даём пользователю выделить руками.
    copyError.value = 'Не удалось скопировать автоматически: ' + (e.message || e) + '. Выделите JSON и скопируйте вручную.';
  }
}

function jobStatusLabel(s) {
  switch (s) {
    case 'queued':     return 'В очереди';
    case 'processing': return 'Идёт обработка';
    case 'done':       return 'Готово';
    case 'error':      return 'Ошибка';
    default:           return s;
  }
}

function jobStatusBadgeClass(s) {
  switch (s) {
    case 'queued':     return 'bg-gray-800 text-gray-300';
    case 'processing': return 'bg-indigo-900/60 text-indigo-300';
    case 'done':       return 'bg-emerald-900/60 text-emerald-300';
    case 'error':      return 'bg-red-900/60 text-red-300';
    default:           return 'bg-gray-800 text-gray-300';
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
          <span>🧩</span> JSON
        </h1>
        <p class="text-sm text-gray-500 mt-1">
          Многозадачник: выбираете готовую SEO-задачу, нажимаете «Создать задачу JSON»,
          её HTML уходит в очередь и обрабатывается в фоне моделью Qwen через AITunnel
          (раскладывается по контейнерам ACF Flexible Content). Готовый JSON открывается
          в модальном окне с кнопкой копирования. Параллельно можно поставить несколько задач.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <!-- ── Левая колонка: список исходных задач ───────────────────── -->
        <div class="lg:col-span-5 space-y-4">
          <div class="card p-0 overflow-hidden">
            <div class="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-white">Исходные SEO-задачи</h2>
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

          <!-- Превью HTML выбранной задачи + кнопка «Создать задачу JSON» -->
          <div v-if="selectedTask" class="card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-white">HTML выбранной задачи</h3>
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

            <div
              v-if="formError"
              class="mt-3 bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-3 py-2 text-xs"
            >
              🚨 {{ formError }}
            </div>

            <button
              class="btn-primary w-full justify-center mt-4"
              :disabled="!canCreateJob"
              @click="addJob"
            >
              ➕ Создать задачу JSON
            </button>
            <p class="text-[11px] text-gray-500 mt-2 text-center">
              Задача уйдёт в очередь справа. Можно поставить несколько подряд.
            </p>
          </div>
        </div>

        <!-- ── Правая колонка: очередь задач JSON ─────────────────────── -->
        <div class="lg:col-span-7">
          <div class="card h-full flex flex-col">
            <div class="flex items-center justify-between mb-4 border-b border-gray-800 pb-3">
              <h2 class="text-sm font-semibold text-white flex items-center gap-2">
                📦 Задачи формирования JSON
                <span class="text-xs text-gray-500 font-normal">({{ jobs.length }})</span>
              </h2>
            </div>

            <div
              v-if="!jobs.length"
              class="flex-1 flex flex-col items-center justify-center text-gray-600 text-sm italic border-2 border-dashed border-gray-800 rounded-lg p-8 min-h-[300px]"
            >
              Здесь появятся задачи. Выберите слева исходный SEO-текст и нажмите «Создать задачу JSON».
            </div>

            <ul v-else class="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
              <li
                v-for="j in jobs"
                :key="j.id"
                :class="[
                  'border rounded-lg p-3 transition-colors',
                  j.status === 'done' || j.status === 'error'
                    ? 'border-gray-800 hover:border-indigo-700 cursor-pointer bg-gray-900/40'
                    : 'border-gray-800 bg-gray-900/30',
                ]"
                @click="openJob(j.id)"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-sm text-white font-medium truncate">
                      #{{ j.id }} · {{ j.title }}
                    </p>
                    <p class="text-xs text-gray-500 mt-0.5">
                      {{ fmtDate(j.createdAt) }}
                      · {{ j.sourceChars.toLocaleString('ru-RU') }} симв.
                      <span v-if="j.status === 'processing' && j.progress" class="ml-2 text-indigo-400">
                        {{ j.progress }}
                      </span>
                      <span v-if="j.status === 'error'" class="ml-2 text-red-400 truncate">
                        — {{ j.error }}
                      </span>
                    </p>
                  </div>
                  <div class="flex items-center gap-2 flex-shrink-0">
                    <span
                      :class="[
                        'inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wide',
                        jobStatusBadgeClass(j.status),
                      ]"
                    >
                      <span
                        v-if="j.status === 'processing'"
                        class="inline-block w-2 h-2 border-2 border-indigo-400/40 border-t-indigo-300 rounded-full animate-spin"
                      ></span>
                      {{ jobStatusLabel(j.status) }}
                    </span>
                    <button
                      v-if="j.status === 'error'"
                      class="text-xs text-indigo-400 hover:text-indigo-300"
                      @click.stop="retryJob(j.id)"
                      title="Повторить"
                    >↻</button>
                    <button
                      v-if="j.status !== 'processing'"
                      class="text-xs text-gray-500 hover:text-red-400"
                      @click.stop="removeJob(j.id)"
                      title="Удалить из списка"
                    >✕</button>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Модальное окно с готовым JSON ─────────────────────────────── -->
    <div
      v-if="showModal && activeJob"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      @click.self="closeModal"
    >
      <div class="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between border-b border-gray-800 px-5 py-3">
          <h3 class="text-sm font-semibold text-white flex items-center gap-2">
            <span>📦</span>
            Задача #{{ activeJob.id }} · {{ activeJob.title }}
            <span
              :class="[
                'ml-2 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wide',
                jobStatusBadgeClass(activeJob.status),
              ]"
            >{{ jobStatusLabel(activeJob.status) }}</span>
          </h3>
          <div class="flex items-center gap-2">
            <button
              v-if="activeJob.status === 'done'"
              @click="copyActiveJson"
              class="btn-secondary text-xs px-3 py-1.5"
            >
              {{ copyState === 'copied' ? '✅ Скопировано' : '📋 Копировать JSON' }}
            </button>
            <button @click="closeModal" class="text-gray-400 hover:text-white text-xl leading-none px-2" title="Закрыть">✕</button>
          </div>
        </div>

        <div class="flex-1 overflow-auto p-5">
          <div
            v-if="copyError"
            class="bg-amber-950/60 border border-amber-800 text-amber-200 rounded-lg px-4 py-2 text-xs mb-3"
          >
            ⚠️ {{ copyError }}
          </div>
          <div
            v-if="activeJob.status === 'error'"
            class="bg-red-950/60 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm whitespace-pre-wrap"
          >
            🚨 {{ activeJob.error }}
          </div>
          <pre
            v-else-if="activeJob.result"
            class="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-indigo-300 whitespace-pre-wrap break-words"
          ><code>{{ activeJob.result }}</code></pre>
          <p v-else class="text-sm text-gray-500">Результата нет.</p>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
