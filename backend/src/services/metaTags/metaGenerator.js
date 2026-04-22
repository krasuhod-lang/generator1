'use strict';

/**
 * DrMax meta-tag generator (v2 spec — Title + Description + H1).
 * Использует общий callGemini-адаптер (прокси, JSON-strict guard, квоты,
 * ретраи) — та же модель/инфраструктура, что и Stage 3/5/6 пайплайна.
 *
 * v2 отличия от v1:
 *   • H1 ВКЛЮЧЁН (≤70 символов, главный ключ, не копия Title);
 *   • Description: 140–155 символов (раньше 140–160);
 *   • Бренд — обязательно в середине/конце, телефон — в формате
 *     +7 (XXX) XXX-XX-XX перед CTA для коммерческих интентов;
 *   • Анализ ЦА/ниши (analyzeAudienceAndNiche) пробрасывается в
 *     user-prompt как `[АНАЛИЗ ЦА И НИШИ]`-блок через inputs.audienceNicheDigest.
 */

const { callGemini } = require('../llm/gemini.adapter');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const { trimToLastWord, trimToLastSentence } = require('./lengthHelpers');
const { checkLsiUsage } = require('./semantics');

const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESC_MIN  = 140;
const DESC_MAX  = 155;
const H1_MAX    = 70;

const SYSTEM_PROMPT = `Ты — Senior Technical SEO-специалист и Data-Driven копирайтер.
Задача: создать идеальные мета-теги (Title, Description) и H1 для веб-страницы,
опираясь на семантический анализ конкурентов и поведенческие факторы.

<Ограничения и правила DrMax>

1. Title (строго 50–60 символов, включая пробелы):
   - Главный ключ должен быть в первых 3 словах.
   - Обязательно используй 2–4 «важных слова» из списка.
   - Выбери одну из формул:
     a) «Ключ + выгода + срок/гарантия»
     b) «Регион + ключ + год + цена»
     c) «Сравнение + ключ + преимущество»
   - Добавь {current_year} (если передан) или цифру/акцию из {page_context}.
   - Разделители: вертикальная черта (|), длинное тире (—). НЕ используй
     ёлочки («»). Только прямые кавычки (").
   - Пример: «Кредит под залог недвижимости | Ставка от 9% | Одобрение за 24ч»

2. Meta Description (строго 140–155 символов, включая пробелы):
   - Законченное предложение (не обрывай на полуслове).
   - Вплети оставшиеся «важные слова» и 2–3 слова из {lsi_list}.
   - Правило покрытия LSI (приоритет — читаемость и CTR, не «галочка»):
     стремись покрыть ВСЕ важные слова между Title и Description, но НЕ ценой
     читаемости. Лучше органично упустить 1 слово, чем получить переспам.
     ЗАПРЕЩЕНО: перечисления голых ключевых слов через запятую без смысла,
     хвосты «Также: …», «Ключи: …», «Теги: …» — за такие конструкции
     поисковик переписывает сниппет, и CTR падает.
   - Добавь E-E-A-T-сигнал (опыт / экспертность / доверие), если он есть в
     {page_context}.
   - Если передан {brand_name}: ОБЯЗАТЕЛЬНО добавь его в середину или конец
     текста (например: «… от компании "Seniko"»). НЕ ставь бренд в самое начало.
   - Если определён интент transactional или commercial_investigation И передан
     {phone_number}: добавь телефон в формате +7 (XXX) XXX-XX-XX в конце,
     перед CTA.
   - ОБЯЗАТЕЛЕН CTA (призыв к действию) в самом конце (например: «Узнайте цены!»,
     «Оставьте заявку онлайн.», «Запишитесь онлайн.»).
   - Пример: «Нужен кредит под залог? ООО 'Финанс Плюс' выдаёт от 500 тыс. до
     30 млн. Ставка 9%. Звоните: +7 (495) 123-45-67. Оставьте заявку онлайн.»

3. H1 (до 70 символов):
   - Понятный человеку, содержит главный ключ.
   - НЕ копирует Title один в один — измени порядок слов или используй синоним.
   - Пример: «Кредит под залог недвижимости — быстрое решение»

4. Изолированный Интент:
   - Определи ОДИН из четырёх типов:
     transactional | commercial_investigation | informational | navigational.
   - Кратко обоснуй выбор.

5. АНТИ-ГАЛЛЮЦИНАЦИИ (КРИТИЧНО):
   - НЕ придумывай цены, скидки, гарантии, если их нет в {page_context}.
   - НЕ придумывай телефон, если {phone_number} пуст.
   - НЕ используй другой год, кроме {current_year}. Если пусто — не пиши год вообще.
   - Если внутри текста нужны кавычки, используй одинарные ('), чтобы не
     сломать JSON-парсер.

</Ограничения и правила DrMax>

Выдай ответ СТРОГО в формате валидного JSON. Без markdown-обёрток (без \`\`\`json),
без приветствий и пояснений. Твой ответ должен начинаться с символа { и
заканчиваться символом }.

Структура JSON:
{
  "niche_analysis":      "Краткий анализ ниши на основе ключа и контекста (2-3 предложения)",
  "intent":              "transactional | commercial_investigation | informational | navigational",
  "intent_reason":       "почему выбран именно этот интент",
  "title":               "твой вариант Title",
  "title_length":        число,
  "description":         "твой вариант Description",
  "description_length":  число,
  "h1":                  "твой вариант H1",
  "used_important_words": ["слово1", "слово2"],
  "used_lsi_words":      ["слово1", "слово2"],
  "coverage_self_audit": "Самопроверка одной строкой: все ли важные слова покрыты между Title, Description и H1? Если нет — какие пропущены и почему оставлены (например: 'не уместилось без переспама')."
}

Перед тем как выдать JSON, мысленно сверь поле coverage_self_audit со списком
важных слов: пройди по каждому и убедись, что оно встречается в title /
description / h1. Если какое-то слово пришлось опустить ради читаемости —
честно напиши это в coverage_self_audit, не подделывай результат.`;

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

  // Контекст страницы: бизнес-УТП + регион + название ниши.
  // Это значение подставляется в промпт под именем {page_context}.
  const pageContextParts = [];
  if (inputs.niche)    pageContextParts.push(`Тема страницы: ${inputs.niche}`);
  if (inputs.toponym)  pageContextParts.push(`Регион: ${inputs.toponym}`);
  if (inputs.summary)  pageContextParts.push(`УТП / факты: ${inputs.summary}`);
  const pageContext = pageContextParts.join(' | ') || 'Нет данных';

  // Опциональный блок: сжатый анализ ЦА и ниши, выполненный один раз на задачу
  // (см. pipeline.runMetaTagTaskInner → analyzeAudienceAndNiche). Если анализа
  // нет (отключён, упал или не передан) — блок просто не выводим.
  const audienceBlock = (inputs.audienceNicheDigest || '').trim()
    ? `

[АНАЛИЗ ЦА И НИШИ — выполнен один раз на задачу до написания тегов]
${inputs.audienceNicheDigest.trim()}`
    : '';

  return `[ВХОДНЫЕ ДАННЫЕ]
- Бренд (brand_name): ${inputs.brand || ''}
- Телефон (phone_number): ${inputs.phone || ''}
- Год (current_year): ${year}
- Главный поисковый запрос (target_keyword): ${keyword}
- Важные слова из ТОП-10 (important_words_list) — ИСПОЛЬЗОВАТЬ ВСЕ, распределить между Title / Description / H1, каждое ≥1 раз: ${importantWords.join(', ')}
- LSI-слова (lsi_list) — вплести 2–3 в Description, остальное по возможности: ${recommendedWords.join(', ')}
- Краткий контекст / УТП страницы (page_context): ${pageContext}

Примеры Title конкурентов из ТОП-выдачи (для анализа интента и формул):
${competitorsTitles}${audienceBlock}

Создай мета-теги строго по правилам DrMax из system-prompt (формулы Title, длины,
бренд / телефон / CTA в Description, H1 ≤70 символов и не копия Title).`;
}

/**
 * Нормализует телефонный номер к виду «+7 (XXX) XXX-XX-XX».
 *
 * Поддерживаемые входные форматы:
 *   • 11-значный с лидирующей 7 или 8: «+74951234567», «8 (495) 123-45-67»
 *   • 10-значный (без кода страны):     «4951234567»  → достраиваем «7»
 *
 * Если на входе мусор / меньше 10 цифр / нероссийский номер — возвращаем
 * исходную строку (trim), так как промпт явно запрещает выдумывать номер,
 * а вшивать неполный — хуже, чем оставить как есть.
 */
function formatPhoneRu(raw) {
  const s = String(raw || '');
  const digits = s.replace(/\D/g, '');
  let core = digits;
  if (core.length === 11 && (core.startsWith('7') || core.startsWith('8'))) {
    core = `7${core.slice(1)}`;
  } else if (core.length === 10) {
    core = `7${core}`;
  } else {
    // Пустая строка, <10 цифр, >11 цифр или 11 цифр не с 7/8 → не наш формат.
    return s.trim();
  }
  // core = '7XXXXXXXXXX' (11)
  const a = core.slice(1, 4);
  const b = core.slice(4, 7);
  const c = core.slice(7, 9);
  const d = core.slice(9, 11);
  return `+7 (${a}) ${b}-${c}-${d}`;
}

/**
 * Постобработка ответа модели: гарантирует длины Title/Description/H1, бренд,
 * телефон. Покрытие важных LSI здесь НЕ форсируется — этим занимается
 * оркестратор generateDrMaxMeta (retry-вызовом + мягкой подстановкой), чтобы
 * не ломать читаемость Description «костыльными» хвостами вида «Также: …».
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

  // 2. Description: обрезаем по последнему предложению при превышении (DESC_MAX = 155).
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
    notes.push(`Description обрезан до ${result.description.length} симв.`);
  }

  // 3. Force brand в Description (новая v2-формулировка: «… от компании "Brand"»),
  //    но БЕЗ голого «Бренд: X.» хвоста. Если бренд уже есть — не трогаем.
  const brand = (inputs.brand || '').trim();
  if (brand && typeof result.description === 'string' && !result.description.includes(brand)) {
    const insertion = ` от компании "${brand}"`;
    const stripped = result.description.replace(/[\s.!?]+$/, '');
    if ((stripped + insertion + '.').length <= DESC_MAX) {
      result.description = `${stripped}${insertion}.`;
      notes.push(`Бренд «${brand}» добавлен в Description (отсутствовал).`);
    } else {
      notes.push(`⚠️ Бренд «${brand}» не уместился в Description (лимит ${DESC_MAX}).`);
    }
  }

  // 4. Force phone для коммерческих интентов — в формате +7 (XXX) XXX-XX-XX
  //    перед CTA (по правилу 2 спеки v2).
  const rawPhone = (inputs.phone || '').trim();
  const isCommercial =
    result.intent === 'transactional' || result.intent === 'commercial_investigation';
  if (rawPhone && isCommercial && typeof result.description === 'string') {
    const phone = formatPhoneRu(rawPhone);
    // Считаем «телефон уже есть», если в Description встречается либо
    // отформатированная, либо сырая (digits-only) форма.
    const digitsInDesc = result.description.replace(/\D/g, '');
    const phoneDigits  = phone.replace(/\D/g, '');
    if (phoneDigits && !digitsInDesc.includes(phoneDigits)) {
      const insertion = ` Звоните: ${phone}.`;
      const stripped = result.description.replace(/[\s.!?]+$/, '') + '.';
      if ((stripped + insertion).length <= DESC_MAX) {
        result.description = `${stripped}${insertion}`;
        notes.push(`Телефон ${phone} добавлен в Description (коммерческий интент).`);
      } else {
        notes.push(`⚠️ Телефон ${phone} не уместился в Description (лимит ${DESC_MAX}).`);
      }
    }
  }

  // 5. Финальный контроль длины Description после всех вставок.
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
  }
  if (typeof result.description === 'string') result.description_length = result.description.length;

  // 6. H1 (v2 — поле теперь поддерживается). Жёсткий лимит 70 символов,
  //    обрезаем по последнему слову при перепреве. Если модель вернула
  //    Title и H1 идентично — фиксируем замечание (но не правим: это работа
  //    промпта/retry, копирование ради уникальности нельзя сделать механически
  //    без потери читаемости).
  if (typeof result.h1 === 'string' && result.h1.length > H1_MAX) {
    result.h1 = trimToLastWord(result.h1, H1_MAX);
    notes.push(`H1 обрезан до ${result.h1.length} симв. (лимит ${H1_MAX}).`);
  }
  if (typeof result.h1 === 'string'
      && typeof result.title === 'string'
      && result.h1.trim() === result.title.trim()) {
    notes.push('⚠️ H1 совпадает с Title — желательна перегенерация для уникальности.');
  }

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
- длину Description 140–155 символов,
- H1 ≤ 70 символов и НЕ копию Title,
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
  formatPhoneRu,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX, H1_MAX,
};
