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
   - Правило покрытия LSI (приоритет — читаемость и CTR, не «галочка»):
     * Стремись покрыть ВСЕ «важные слова» (DF ≥ 35%) между Title и Description —
       по возможности 100%, но НЕ ценой читаемости. Лучше органично упустить
       1 слово, чем получить переспам или сноску в духе «Также: слово1, слово2».
       Запрещено: перечисления голых ключевых слов через запятую без смысла,
       хвосты «Также: …», «Ключи: …», «Теги: …» и подобные SEO-костыли —
       за такие конструкции поисковик переписывает сниппет, и CTR падает.
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
  "used_important_words": ["слово1", "слово2"],
  "coverage_self_audit": "Самопроверка одной строкой: все ли важные слова из списка покрыты между Title и Description? Если нет — какие пропущены и почему оставлены (например: «не уместилось без переспама»)."
}

Перед тем как выдать JSON, мысленно сверь поле coverage_self_audit со списком
важных слов: пройди по каждому и убедись, что оно встречается в title или
description. Если какое-то слово пришлось опустить ради читаемости — честно
напиши это в coverage_self_audit, не подделывай результат.`;

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
 * Постобработка ответа модели: гарантирует длины, бренд, телефон.
 * Покрытие важных LSI здесь НЕ форсируется — этим занимается оркестратор
 * generateDrMaxMeta (retry-вызовом + мягкой подстановкой), чтобы не ломать
 * читаемость Description «костыльными» хвостами вида «Также: …».
 *
 * @param {object} result — распарсенный JSON от Gemini
 * @param {object} inputs — { niche, brand, toponym, phone, summary }
 */
function postValidate(result, inputs) {
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

  // 5. Финальный контроль длины Description после всех вставок.
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
  }
  if (typeof result.description === 'string') result.description_length = result.description.length;

  // Удаляем H1, если модель всё-таки сгенерировала (страховка).
  if ('h1' in result) delete result.h1;

  // На случай, если модель всё-таки сгенерировала «Также: …» хвост сама —
  // снимаем его, оставляем только осмысленную часть Description.
  if (typeof result.description === 'string'
      && /\.\s*Также:[^.]*\.\s*$/i.test(result.description)) {
    result.description = result.description
      .replace(/\.\s*Также:[^.]*\.\s*$/i, '')
      .replace(/[\s.!?]+$/, '') + '.';
    result.description_length = result.description.length;
    notes.push('Удалён хвост «Также: …» из Description (это переспам, снижает CTR).');
  }

  return { result, notes };
}

/**
 * Мягкая «последняя соломинка»: если после двух Gemini-попыток в Description
 * всё ещё пропущены важные LSI — пробуем вставить их в существующий
 * перечислительный ряд (после первой запятой), чтобы грамматика осталась
 * корректной. Триггер — наличие запятой в Description: только тогда
 * добавление «, WORD» читается как продолжение списка, а не как костыль.
 *
 * Если в Description нет запятой — НЕ трогаем текст: лучше зафиксировать
 * пропуск в notes, чем испортить CTR неестественной концовкой.
 *
 * @returns {{description: string, injected: string[]}}
 */
function trySoftLsiInjection(description, missedWords) {
  if (typeof description !== 'string' || !description) {
    return { description, injected: [] };
  }
  if (!Array.isArray(missedWords) || !missedWords.length) {
    return { description, injected: [] };
  }
  // Нужна хотя бы одна запятая, чтобы новые слова продолжили существующий
  // ряд однородных членов и не выглядели как ярлыки/теги.
  if (!/,\s/.test(description)) {
    return { description, injected: [] };
  }

  let base = description.replace(/[\s.!?]+$/, '');
  const injected = [];
  for (const word of missedWords) {
    const candidate = `${base}, ${word}`;
    const candidateWithPeriod = `${candidate}.`;
    if (candidateWithPeriod.length <= DESC_MAX) {
      base = candidate;
      injected.push(word);
    } else {
      // suffix только удлиняется — следующие слова тоже не влезут
      break;
    }
  }
  if (!injected.length) return { description, injected: [] };
  return { description: `${base}.`, injected };
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
 * Стратегия покрытия важных LSI (DF ≥ 35%) — три ступени по убыванию качества:
 *   1) Первый Gemini-вызов с self-audit полем (Chain-of-Verification в один запрос).
 *   2) Если важные слова всё-таки пропущены — второй Gemini-вызов с явным
 *      корректирующим блоком в user-prompt («не использованы: X, Y — перепиши
 *      органично»). DSPy-style self-correction, как в TZ-extractor.
 *   3) Если и после второй попытки слова пропущены — мягкая подстановка в
 *      существующий перечислительный ряд Description (только при наличии
 *      запятой). Что не помещается / не вписывается — фиксируется в
 *      post_validation_notes с маркером ⚠️, текст не корраптится.
 *
 * @param {object} args
 * @param {string} args.keyword
 * @param {object} args.semantics  — результат extractSemantics()
 * @param {Array}  args.serpData
 * @param {object} args.inputs     — { niche, brand, toponym, phone, summary }
 * @returns {Promise<object>}
 */
async function generateDrMaxMeta({ keyword, semantics, serpData, inputs }) {
  const importantWords   = (semantics.title_mandatory_words       || []).slice(0, 6);
  const recommendedWords = (semantics.description_mandatory_words || []).slice(0, 10);
  const year = detectYear(importantWords, recommendedWords, serpData);

  const baseUserPrompt = buildUserPrompt({ keyword, semantics, serpData, inputs, year });

  const MAX_ATTEMPTS = 2; // первый вызов + один retry «с уточнением»
  const allNotes = [];
  let result = null;
  let lastMissed = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let model = '';
  let attemptsMade = 0;
  let userPrompt = baseUserPrompt;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    // callGemini автоматически: JSON-strict guard в systemInstruction, прокси,
    // ретраи на сетевых/5xx/429, агрегация text-частей. maxTokens=8192:
    // gemini-3.x thinking-модель тратит часть бюджета на «мысли».
    const callRes = await callGemini(
      SYSTEM_PROMPT,
      userPrompt,
      { temperature: 0.4, maxTokens: 8192, timeoutMs: 90000 },
    );
    totalTokensIn  += callRes.tokensIn  || 0;
    totalTokensOut += callRes.tokensOut || 0;
    model = callRes.model || model;

    const parsed = parseMetaJson(callRes.text);
    const { result: validated, notes } = postValidate(parsed, inputs);
    result = validated;
    if (attempt > 1) allNotes.push(`— Попытка ${attempt} (перегенерация) —`);
    allNotes.push(...notes);

    // Проверяем покрытие важных LSI между Title и Description.
    if (!importantWords.length
        || typeof result.title !== 'string'
        || typeof result.description !== 'string') {
      lastMissed = [];
      break;
    }
    const combined = `${result.title} ${result.description}`;
    const { missed_lsi } = checkLsiUsage(combined, importantWords);
    lastMissed = missed_lsi;

    if (!lastMissed.length) break;
    if (attempt === MAX_ATTEMPTS) {
      allNotes.push(
        `Попытка ${attempt}: после перегенерации остались непокрытые важные LSI: `
        + `${lastMissed.join(', ')}.`,
      );
      break;
    }

    allNotes.push(
      `Попытка ${attempt}: пропущены важные LSI: ${lastMissed.join(', ')}. `
      + 'Запрашиваем органичную перегенерацию у Gemini.',
    );

    // Корректирующий блок к user-prompt: явно перечисляем пропущенные слова и
    // запрещаем «костыли» (хвосты «Также: …», голые перечисления).
    userPrompt = `${baseUserPrompt}

=== УТОЧНЕНИЕ К ПРЕДЫДУЩЕМУ ОТВЕТУ ===
Предыдущая версия ответа:
- Title: ${result.title}
- Description: ${result.description}

В ней НЕ использованы обязательные «важные слова»: ${lastMissed.join(', ')}.

Перепиши Title и Description так, чтобы каждое из этих слов появилось
ОРГАНИЧНО (внутри осмысленного предложения, без перечислений через запятую,
без хвостов «Также: …» / «Ключи: …»). Сохрани:
- длину Title 50–60 символов,
- длину Description 140–160 символов,
- CTA в конце Description,
- бренд / телефон / год по тем же правилам, что и раньше.

Если какое-то слово невозможно вписать без переспама или нарушения
читаемости — лучше честно опусти его (отметь это в coverage_self_audit),
чем испортить сниппет ради «галочки».`;
  }

  // Ступень 3 — мягкая подстановка как «последняя соломинка».
  if (lastMissed.length) {
    const soft = trySoftLsiInjection(result.description, lastMissed);
    if (soft.injected.length) {
      result.description = soft.description;
      result.description_length = result.description.length;
      allNotes.push(
        `Мягко вшиты в существующий ряд Description пропущенные LSI: `
        + `${soft.injected.join(', ')}.`,
      );
    }
    const stillMissed = lastMissed.filter((w) => !soft.injected.includes(w));
    if (stillMissed.length) {
      allNotes.push(
        `⚠️ Не удалось органично вписать важные LSI (оставлены ради читаемости/CTR): `
        + `${stillMissed.join(', ')}. SEO-специалист может решить, нужны ли они для этого ключа.`,
      );
    }
  }

  result.detected_year = year;
  result.post_validation_notes = allNotes;
  result._meta = {
    model,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    attempts: attemptsMade,
  };
  return result;
}

module.exports = {
  generateDrMaxMeta,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX,
};
