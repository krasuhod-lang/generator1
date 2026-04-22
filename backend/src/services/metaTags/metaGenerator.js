'use strict';

/**
 * DrMax meta-tag generator: переносит ШАГ 3 (Gemini) из Title-v25.html
 * на сервер. Использует общий callGemini-адаптер (с прокси, JSON-strict guard,
 * квотами и ретраями), благодаря чему работает в той же модели/инфраструктуре,
 * что и Stage 3/5/6 основного пайплайна.
 *
 * ВАЖНО (требование заказчика): H1 НЕ генерируется — поле полностью убрано
 * из промпта и ответа.
 */

const { callGemini } = require('../llm/gemini.adapter');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const { trimToLastWord, trimToLastSentence } = require('./lengthHelpers');
const { checkLsiUsage } = require('./semantics');

const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESC_MIN  = 140;
const DESC_MAX  = 160;

const SYSTEM_PROMPT = `Ты — Senior Technical SEO-специалист и Data-Driven копирайтер по методологии DrMax.
Задача: создать идеальные метатеги (Title и Description) — БЕЗ H1, опираясь на семантический анализ ТОП-выдачи и поведенческие сигналы.

<Ограничения и правила DrMax>

1. Title (50–60 символов):
   - Главное ключевое слово в первых 3 словах.
   - В Title должно поместиться 2–4 «важных слова» из списка (DF ≥ 35%) — это «ядро».
   - Выбери одну из формул:
     a) «Ключ + выгода + срок/гарантия»
     b) «Регион + ключ + год + цена»
     c) «Сравнение + ключ + преимущество»
   - Добавь год (если передан) и/или цифру/акцию.
   - Разделители: вертикальная черта (|), длинное тире (—), скобки. НЕ используй ёлочки («»).

2. Meta Description (140–160 символов):
   - Законченное предложение (не обрывай на полуслове).
   - КРИТИЧНОЕ правило покрытия LSI:
     * ВСЕ «важные слова» из списка (DF ≥ 35%), которые не вошли в Title,
       ОБЯЗАТЕЛЬНО должны появиться в Description. Каждое важное слово должно
       быть использовано хотя бы один раз — в Title ИЛИ в Description (а в идеале
       все важные распределены так, чтобы 100% списка покрыто между двумя тегами).
     * «Рекомендуемые» LSI (DF 15–35%): впиши в Description МАКСИМУМ возможных
       слов из списка, насколько позволяет лимит 160 символов и читаемость.
       Не оставляй ни одно рекомендуемое слово «за бортом», если оно органично
       вписывается без нарушения языка и длины.
   - Добавь E-E-A-T-сигнал: бренд / годы работы / гарантию — если они переданы.
   - CTA в конце: «Узнайте цены и условия», «Запишитесь онлайн», «Получите расчёт» и т. п.
   - Бренд (если указан): ОБЯЗАТЕЛЬНО добавь название бренда в Description, в середине или конце предложения. НЕ ставь бренд в самое начало.
   - Телефон (если указан): если интент transactional или commercial_investigation — добавь телефон в формате +7 (XXX) XXX-XX-XX в конце, перед CTA. Если интент informational или телефон не передан — НЕ добавляй вымышленный номер.

3. Интент:
   - Определи один из: transactional | commercial_investigation | informational | navigational.
   - Кратко обоснуй (например: «в ТОПе много карточек товаров с ценой»).

4. Анти-галлюцинации:
   - Не придумывай цены, скидки, гарантии, если их нет во входных данных.
   - Не используй другой год, кроме переданного. Если год не передан — НЕ добавляй.
   - Не используй ёлочки («»), только прямые кавычки (").
   - НЕ генерируй H1 (это поле не нужно).

</Ограничения и правила DrMax>

Выходные данные — строго JSON, без пояснений и markdown-обёрток. Структура:
{
  "niche_analysis":      "Краткий анализ конкурентной ниши (2-3 предложения)",
  "intent":              "transactional | commercial_investigation | informational | navigational",
  "intent_reason":       "почему такой интент",
  "title":               "твой вариант",
  "title_length":        число,
  "description":         "твой вариант",
  "description_length":  число,
  "used_important_words": ["слово1", "слово2"]
}`;

/**
 * Извлекает год из найденных LSI; если не нашёл — пробует выцепить из первых
 * трёх Title конкурентов. Возвращает '' если года не нашлось.
 */
function detectYear(importantWords, recommendedWords, serpData) {
  const yearRe = /20\d{2}/;
  const inImp = (importantWords || []).find((w) => yearRe.test(w));
  if (inImp) return String(inImp).match(yearRe)[0];
  const inRec = (recommendedWords || []).find((w) => yearRe.test(w));
  if (inRec) return String(inRec).match(yearRe)[0];
  const firstTitles = (serpData || []).slice(0, 3).map((d) => d.title || '').join(' ');
  const m = firstTitles.match(yearRe);
  return m ? m[0] : '';
}

function buildUserPrompt({ keyword, semantics, serpData, inputs, year }) {
  const importantWords   = (semantics.title_mandatory_words       || []).slice(0, 6);
  const recommendedWords = (semantics.description_mandatory_words || []).slice(0, 10);
  const competitorsTitles = (serpData || [])
    .map((c, i) => `[${i + 1}] ${c.title}`)
    .join('\n');

  return `Аналитика конкурентов:
- Название/Тема страницы: ${inputs.niche || keyword}
- Основное ключевое слово: ${keyword}
- Актуальный год из ТОПа: ${year} (ОБЯЗАТЕЛЬНО используй именно этот год в Title и Description, не придумывай другой!)
- Важные слова — ИСПОЛЬЗОВАТЬ ВСЕ 100% (распределить между Title и Description, каждое слово ≥1 раз): ${importantWords.join(', ')}
- Рекомендуемые LSI — ВПИСАТЬ В DESCRIPTION МАКСИМУМ возможных (по длине/читаемости): ${recommendedWords.join(', ')}
- Общее УТП (если указано): ${inputs.summary || ''}
- Бренд (только в Description): ${inputs.brand || ''}
- Регион: ${inputs.toponym || ''}
- Телефон (только в Description, если интент коммерческий): ${inputs.phone || ''}

Примеры Title конкурентов (для анализа интента и формул):
${competitorsTitles}

Создай метатеги строго по методологии DrMax (формулы, E-E-A-T, поведенческие триггеры). H1 НЕ нужен.`;
}

/**
 * Постобработка ответа модели: гарантирует длины, бренд, телефон и 100%-е
 * покрытие важных LSI-слов между Title и Description.
 * Возвращает объект с полями notes — список применённых корректировок.
 *
 * @param {object} result    — распарсенный JSON от Gemini
 * @param {object} inputs    — { niche, brand, toponym, phone, summary }
 * @param {object} semantics — { title_mandatory_words, description_mandatory_words }
 */
function postValidate(result, inputs, semantics = {}) {
  const notes = [];

  // 1. Title: укорачиваем, если перебор. Если короче 50 — оставляем как есть,
  //    модель почти всегда лучше, чем механическое расширение.
  if (typeof result.title === 'string' && result.title.length > TITLE_MAX) {
    result.title = trimToLastWord(result.title, TITLE_MAX - 3);
    notes.push(`Title обрезан до ${result.title.length} симв. (был длиннее ${TITLE_MAX}).`);
  }
  if (typeof result.title === 'string') result.title_length = result.title.length;

  // 2. Description: обрезаем по последнему предложению при превышении.
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
    notes.push(`Description обрезан до ${result.description.length} симв.`);
  }

  // 3. Force brand в Description.
  const brand = (inputs.brand || '').trim();
  if (brand && typeof result.description === 'string' && !result.description.includes(brand)) {
    result.description = result.description.replace(/\.$/, '') + `. Бренд: ${brand}.`;
    notes.push(`Бренд «${brand}» добавлен в Description (отсутствовал).`);
  }

  // 4. Force phone для коммерческих интентов.
  const phone = (inputs.phone || '').trim();
  const isCommercial =
    result.intent === 'transactional' || result.intent === 'commercial_investigation';
  if (phone && isCommercial && typeof result.description === 'string'
      && !result.description.includes(phone)) {
    result.description = result.description.replace(/\.$/, '') + `. Звоните: ${phone}.`;
    notes.push(`Телефон ${phone} добавлен в Description (коммерческий интент).`);
  }

  // 5. КРИТИЧНОЕ требование: важные LSI (DF ≥ 35%) — все 100% должны быть
  //    использованы между Title и Description. Если модель пропустила —
  //    дописываем недостающие в Description в виде хвоста «Также: word1, word2.»
  //    (укладываемся в DESC_MAX, иначе trim по предложениям).
  const importantWords = Array.isArray(semantics.title_mandatory_words)
    ? semantics.title_mandatory_words : [];
  if (importantWords.length && typeof result.description === 'string'
      && typeof result.title === 'string') {
    const combined = `${result.title} ${result.description}`;
    const { missed_lsi: missedImportant } = checkLsiUsage(combined, importantWords);
    if (missedImportant.length) {
      // Снимаем уже существующий хвост "Также: ...", финальные знаки препинания
      // и пробелы — чтобы пересобрать его аккуратно с учётом новых слов и
      // не получить артефактов вида "подробности.. Также:".
      const baseDesc = result.description
        .replace(/\.\s*Также:[^.]*\.\s*$/, '')
        .replace(/[\s.!?]+$/, '');
      const injected = [];
      for (const word of missedImportant) {
        const trySuffix = `. Также: ${[...injected, word].join(', ')}.`;
        if ((baseDesc + trySuffix).length <= DESC_MAX) {
          injected.push(word);
        } else {
          // Дальше слова уже не влезут, suffix только удлиняется.
          break;
        }
      }
      if (injected.length) {
        result.description = baseDesc + `. Также: ${injected.join(', ')}.`;
        notes.push(`В Description дописаны пропущенные важные LSI: ${injected.join(', ')}.`);
      }
      const stillMissed = missedImportant.filter((w) => !injected.includes(w));
      if (stillMissed.length) {
        notes.push(`⚠️ Не уместились в лимит ${DESC_MAX} важные LSI: ${stillMissed.join(', ')}.`);
      }
    }
  }

  // 6. Финальный контроль длины Description после всех вставок.
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
  }
  if (typeof result.description === 'string') result.description_length = result.description.length;

  // Удаляем H1, если модель всё-таки сгенерировала (страховка).
  if ('h1' in result) delete result.h1;

  return { result, notes };
}

/**
 * parseMetaJson — устойчивый парсер ответа Gemini для метатегов.
 *
 * Покрывает реальные кейсы, которые валили DrMax-генератор:
 *   - markdown-обёртка ```json … ```
 *   - вступительная фраза «Конечно! Вот ваш JSON: { ... }»
 *   - обрыв на полпути (MAX_TOKENS) — autoCloseJSON восстановит хвост
 *   - одинарные кавычки вокруг ключей (модель иногда нарушает JSON-guard)
 *
 * При полной невозможности — кидает осмысленную ошибку с фрагментом
 * сырого текста, чтобы её было видно в логах задачи.
 */
function parseMetaJson(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) throw new Error('Gemini вернул пустой ответ');

  // 1) Снимаем markdown fences
  let t = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  // 2) Берём срез от первой { до последней }
  const fb = t.indexOf('{');
  const lb = t.lastIndexOf('}');
  if (fb !== -1 && lb > fb) t = t.substring(fb, lb + 1);

  // 3) Прямой JSON.parse
  try { return JSON.parse(t); } catch (_) { /* fallback */ }

  // 4) autoCloseJSON — восстановление обрыва
  try { return JSON.parse(autoCloseJSON(t)); } catch (e) {
    const snippet = raw.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(`Gemini вернул не-JSON ответ: ${e.message}. Фрагмент: «${snippet}»`);
  }
}

/**
 * Главная функция: генерирует метатеги по одному ключу.
 *
 * @param {object} args
 * @param {string} args.keyword
 * @param {object} args.semantics  — результат extractSemantics()
 * @param {Array}  args.serpData
 * @param {object} args.inputs     — { niche, brand, toponym, phone, summary }
 * @returns {Promise<{
 *   niche_analysis: string,
 *   intent: string,
 *   intent_reason: string,
 *   title: string,
 *   title_length: number,
 *   description: string,
 *   description_length: number,
 *   used_important_words: string[],
 *   detected_year: string,
 *   post_validation_notes: string[],
 * }>}
 */
async function generateDrMaxMeta({ keyword, semantics, serpData, inputs }) {
  const importantWords   = (semantics.title_mandatory_words       || []).slice(0, 6);
  const recommendedWords = (semantics.description_mandatory_words || []).slice(0, 10);
  const year = detectYear(importantWords, recommendedWords, serpData);

  const userPrompt = buildUserPrompt({ keyword, semantics, serpData, inputs, year });

  // callGemini автоматически:
  //   - добавляет JSON-strict guard в systemInstruction
  //   - идёт через прокси (PROXY_URLS обязателен — без него throw)
  //   - ретраит при сетевых ошибках / 5xx
  //   - агрегирует все text-части кандидата
  // Возвращает { text, tokensIn, tokensOut, model, finishReason } — text это
  // сырой JSON-string. maxTokens увеличен до 8192: gemini-3.x thinking-модель
  // расходует часть бюджета на «мысли», 2048 порой обрезает JSON по MAX_TOKENS.
  const { text, tokensIn = 0, tokensOut = 0, model = '' } = await callGemini(
    SYSTEM_PROMPT,
    userPrompt,
    { temperature: 0.4, maxTokens: 8192, timeoutMs: 90000 },
  );

  const result = parseMetaJson(text);

  const { result: validated, notes } = postValidate(result, inputs, semantics);

  validated.detected_year = year;
  validated.post_validation_notes = notes;
  validated._meta = { model, tokensIn, tokensOut };
  return validated;
}

module.exports = {
  generateDrMaxMeta,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX,
};
