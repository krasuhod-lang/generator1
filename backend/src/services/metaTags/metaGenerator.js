'use strict';

/**
 * DrMax meta-tag generator (v2 spec — Title + Description + H1).
 * Использует общий callGemini-адаптер (прокси, JSON-strict guard, квоты,
 * ретраи) — та же модель/инфраструктура, что и Stage 3/5/6 пайплайна.
 *
 * Ключевые правила:
 *   • H1 — UX-заголовок (≤70 символов), а не копия SEO Title;
 *   • Title ≤75, Description 150–160 символов;
 *   • SERP intent и CTR-команды вычисляются до LLM;
 *   • Анализ ЦА/ниши (analyzeAudienceAndNiche) пробрасывается в
 *     user-prompt как `[АНАЛИЗ ЦА И НИШИ]`-блок через inputs.audienceNicheDigest.
 */

const { callGemini } = require('../llm/gemini.adapter');
const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const { trimToLastWord, trimToLastSentence } = require('./lengthHelpers');
const { checkLsiUsage } = require('./semantics');

const TITLE_MIN = 50;
const TITLE_MAX = 75;
const DESC_MIN  = 150;
const DESC_MAX  = 160;
const H1_MAX    = 70;
const META_GENERATION_MODEL = 'gemini-3.1-pro-preview';

const SYSTEM_PROMPT = `Ты — Senior Technical SEO-специалист и Data-Driven копирайтер.
Задача: создать идеальные мета-теги (Title, Description) и H1 для веб-страницы,
опираясь на семантический анализ конкурентов и поведенческие факторы.

<Ограничения и правила DrMax>

1. Title (до 75 символов, включая пробелы):
   - Главный ключ должен быть в первых 3 словах.
   - Главный ключ и главное УТП / differentiator_lsi ОБЯЗАНЫ находиться в первых
     50 символах — хвост после 50 символов может быть обрезан в выдаче.
   - Обязательно используй 2–4 «важных слова» из списка.
   - Выбери одну из формул:
     a) «Ключ + выгода + срок/гарантия»
     b) «Регион + ключ + год + цена»
     c) «Сравнение + ключ + преимущество»
   - Добавь {current_year} (если передан) или цифру/акцию из {page_context}.
   - Разделители: вертикальная черта (|), длинное тире (—). НЕ используй
     ёлочки («»). Только прямые кавычки (").
   - Пример: «Кредит под залог недвижимости | Ставка от 9% | Одобрение за 24ч»

2. Meta Description (150–160 символов, включая пробелы):
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
   - ОБЯЗАТЕЛЕН CTA (призыв к действию) в самом конце (например: «Узнайте цены!»,
     «Оставьте заявку онлайн.», «Запишитесь онлайн.»).

3. H1 (до 70 символов):
   - Это заголовок ДЛЯ ЧЕЛОВЕКА, который уже перешёл на сайт; он не должен
     выглядеть как SEO-спам.
   - Понятный, вовлекающий, раскрывает суть страницы и содержит главный ключ.
   - НЕ копирует Title один в один — измени порядок слов или используй синоним.
   - Не пиши топонимы/города, если они не критичны для смысла.
   - Запрещены коммерческие хвосты «цена», «недорого», «купить» — они допустимы
     только в Title.

4. SERP_INTENT:
   - НЕ определяй интент самостоятельно. Используй переданный SERP_INTENT как
     жёсткое условие и верни его без изменения.

5. АНТИ-ГАЛЛЮЦИНАЦИИ (КРИТИЧНО):
   - НЕ придумывай цены, скидки, гарантии, если их нет в {page_context}.
   - НЕ используй другой год, кроме {current_year}. Если пусто — не пиши год вообще.
     ЗАПРЕЩЕНО упоминать год МЕНЬШЕ {current_year} (устаревший SERP-кэш не оправдание).
   - Если внутри текста нужны кавычки, используй одинарные ('), чтобы не
     сломать JSON-парсер.

6. ПОИСКОВЫЕ СИСТЕМЫ (антибиас):
   - Если в important_words_list / lsi_list присутствуют названия одной поисковой
     системы («google», «яндекс», «yandex»), но в {page_context} / {brand_facts}
     НЕ указано, что бизнес работает только с ней — НЕ сужай текст до одной системы.
   - В таком случае используй обобщение («поисковые системы», «поисковая выдача»,
     «ТОП поиска») либо упомяни обе («Яндекс и Google»).
   - Конкретную поисковую систему называй ТОЛЬКО если это явно следует из
     {page_context} / {brand_facts} (например, кейс именно по Google Ads).

7. ПРАВИЛА ФОРМИРОВАНИЯ DESCRIPTION:
   - Если SERP_INTENT = "Commercial/Transactional":
     • СТРОГО ЗАПРЕЩЕНЫ знак «?» и начало с вопроса («Ищете», «Нужен», «Хотите»).
     • Используй инвертированную пирамиду: главный ключ/бренд → проверенные
      факты, УТП и цифры → CTA.
     • Главный ключ должен встретиться в первых 80 символах.
     • По возможности включи 4 CTR-компонента: Primary Keyword; подтверждённое
      УТП/эмоциональный триггер; социальное доказательство, если оно есть во
      входных данных; мягкий CTA в самом конце.
     • CTA: «Сравните условия!», «Забронируйте онлайн!», «Скачайте прайс!»,
      «Узнайте условия!».
   - Если SERP_INTENT = "Informational":
     • Вопрос в начале разрешён, но сразу после него дай тизер ответа.
     • CTA информационный и стоит в конце: «Читайте пошаговый гайд!»,
      «Узнайте подробности!», «Смотрите обзор!».
   - Если SERP_INTENT = "Mixed/Unclear": не имитируй коммерческий интент;
     используй нейтральную фактическую формулировку и CTA по контексту.
   - Самое важное УТП размести до 120-го символа.

8. ПРАВИЛА РАБОТЫ С ЦЕНАМИ:
   - Если [price_data] содержит точную подтверждённую цену, ОБЯЗАТЕЛЬНО перенеси
     именно эту цифру в Description, желательно в первую половину.
   - Если [price_data] = null, КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ слова «цена»,
     «стоимость», «руб», «₽» и любые выдуманные числа. Используй другие
     подтверждённые УТП: ассортимент, гарантии, скорость доставки.

9. NEGATIVE PROMPT:
   - Запрещён keyword stuffing и перечисление вариантов ключа через запятую.
   - Запрещены пустые штампы «В этой статье мы расскажем», «Наша компания
     предлагает», «Добро пожаловать на сайт».
   - Не оставляй главное УТП после 120-го символа и не обрывай мысль.
   - Не выдумывай эмоциональные триггеры, социальные доказательства, цифры,
     гарантии или наличие — используй только входные данные.

</Ограничения и правила DrMax>

Выдай ответ СТРОГО в формате валидного JSON. Без markdown-обёрток (без \`\`\`json),
без приветствий и пояснений. Твой ответ должен начинаться с символа { и
заканчиваться символом }.

Структура JSON:
{
  "niche_analysis":      "Краткий анализ ниши на основе ключа и контекста (2-3 предложения)",
  "intent":              "переданный SERP_INTENT без изменения",
  "intent_reason":       "SERP_INTENT определён детерминированно по ТОП-10",
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
 * Возвращает год для подстановки в Title.
 *
 * Источники (в порядке приоритета):
 *   1) важные LSI-слова из ТОПа (если там встретился 4-значный 20xx);
 *   2) рекомендуемые LSI-слова;
 *   3) первые три Title конкурентов;
 *   4) если нигде не нашли — текущий календарный год.
 *
 * Дополнительно: если найденный в SERP год МЕНЬШЕ текущего (типичный случай —
 * закэшированная выдача с прошлогодней цифрой), принудительно возвращаем
 * текущий календарный год. Так в Title не попадает устаревший год.
 *
 * @returns {string} строка с годом (например "2026"); пустая строка не
 *   возвращается никогда — это позволяет верхнему коду всегда иметь
 *   актуальный {current_year} для промпта.
 */
function detectYear(importantWords, recommendedWords, serpData) {
  const yearRe = /20\d{2}/;
  const currentYear = new Date().getFullYear();
  let detected = '';
  const inImp = (importantWords || []).find((w) => yearRe.test(w));
  if (inImp) detected = String(inImp).match(yearRe)[0];
  if (!detected) {
    const inRec = (recommendedWords || []).find((w) => yearRe.test(w));
    if (inRec) detected = String(inRec).match(yearRe)[0];
  }
  if (!detected) {
    const firstTitles = (serpData || []).slice(0, 3).map((d) => d.title || '').join(' ');
    const m = firstTitles.match(yearRe);
    if (m) detected = m[0];
  }
  if (!detected) return String(currentYear);
  // Если в SERP попался устаревший год — заменяем на текущий.
  const detectedNum = parseInt(detected, 10);
  if (Number.isFinite(detectedNum) && detectedNum < currentYear) {
    return String(currentYear);
  }
  return detected;
}

function extractPriceData(inputs = {}) {
  const explicit = inputs.price_data ?? inputs.priceData;
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  const source = [
    inputs.page_context,
    inputs.summary,
  ].filter(Boolean).join(' | ').replace(/\s+/g, ' ');
  if (!source) return null;

  const match = source.match(
    /(?:цена|стоимость)\s*[:—-]?\s*(?:от\s*)?\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб(?:\.|лей)?|р\.)/i,
  );
  return match ? match[0].trim().slice(0, 160) : null;
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
  if (inputs.page_context && inputs.page_context !== inputs.summary) {
    pageContextParts.push(`Данные страницы: ${inputs.page_context}`);
  }
  const pageContext = pageContextParts.join(' | ') || 'Нет данных';
  const priceData = extractPriceData(inputs);

  // Опциональный блок: сжатый анализ ЦА и ниши, выполненный один раз на задачу
  // (см. pipeline.runMetaTagTaskInner → analyzeAudienceAndNiche). Если анализа
  // нет (отключён, упал или не передан) — блок просто не выводим.
  const audienceBlock = (inputs.audienceNicheDigest || '').trim()
    ? `

[АНАЛИЗ ЦА И НИШИ — выполнен один раз на задачу до написания тегов]
${inputs.audienceNicheDigest.trim()}`
    : '';

  // Sprint B: relevance-артефакт (LSI/ngrams/H2-H3 наброски из общего отчёта
  // релевантности). Если задаче привязан source_relevance_report_id,
  // pipeline уже загрузил brief в inputs.relevanceBrief. Прокидываем сюда
  // дополнительным блоком — Gemini получает усиленный контекст по нише,
  // помимо TF-IDF по конкретному ключу.
  const relevanceBlock = (inputs.relevanceBrief || '').trim()
    ? `

[RELEVANCE-АРТЕФАКТ — общий контекст ниши из отчёта релевантности]
${inputs.relevanceBrief.trim()}`
    : '';

  // ТЗ §2.2: блок «Анализ кликабельности конкурентов» + двухуровневый LSI.
  // Передаём в промпт детерминированные паттерны (длины p50/p90, частоту CTA/
  // года/цены/гео) и явно перечисляем обязательные / уникальные LSI.
  const ctr = inputs.ctrAnalysis;
  let ctrBlock = '';
  if (ctr && ctr.patterns) {
    const p = ctr.patterns;
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    const must = (ctr.recommendations && ctr.recommendations.must_have) || [];
    const avoid = (ctr.recommendations && ctr.recommendations.must_avoid) || [];
    const diff = (ctr.recommendations && ctr.recommendations.differentiation) || [];
    const obligatoryLsi    = (semantics && semantics.obligatory_lsi)     || [];
    const differentiatorLsi = (semantics && semantics.differentiator_lsi) || [];
    const serpIntent = ctr.serp_intent || {};
    ctrBlock = `

[АНАЛИЗ КЛИКАБЕЛЬНОСТИ ВЫДАЧИ — фактчекинг ТОП-10, использовать обязательно]
- SERP_INTENT: ${serpIntent.value || 'Mixed/Unclear'} (commercial=${pct(serpIntent.commercial_frequency)}, informational=${pct(serpIntent.informational_frequency)}). Это жёсткое условие, не переопределяй его.
- Длина Title в ТОПе: p50=${p.length_p50_title}, p90=${p.length_p90_title} — укладывайся в этот диапазон.
- Длина Description в ТОПе: p50=${p.length_p50_desc}, p90=${p.length_p90_desc}.
- Частота CTA в Description конкурентов: ${pct(p.cta_frequency)}; года в Title: ${pct(p.year_frequency)}; цены: ${pct(p.price_frequency)}; гео: ${pct(p.geo_frequency)}; бренда: ${pct(p.brand_frequency)}.
- Штампованные начала тайтлов («${(p.common_prefixes || []).join('», «') || '—'}») и хвосты («${(p.common_suffixes || []).join('», «') || '—'}») — НЕ повторяй, чтобы сниппет не сливался с ТОПом.
- Рекомендуемая формула Title (на основе ТОПа): ${ctr.recommendations.suggested_title_formula || '—'}.${must.length ? `
- ОБЯЗАТЕЛЬНО (есть у большинства конкурентов — без этого ниже CTR):
  • ${must.join('\n  • ')}` : ''}${avoid.length ? `
- ИЗБЕГАТЬ:
  • ${avoid.join('\n  • ')}` : ''}${diff.length ? `
- ДИФФЕРЕНЦИАЦИЯ (выделит сниппет на фоне ТОПа):
  • ${diff.join('\n  • ')}` : ''}${obligatoryLsi.length ? `
- LSI ОБЯЗАТЕЛЬНЫЕ для конкуренции (есть у ≥50% ТОП-10, должны быть в Title или Description): ${obligatoryLsi.join(', ')}.` : ''}${differentiatorLsi.length ? `
- LSI ДЛЯ ДИФФЕРЕНЦИАЦИИ (нет ни у одного конкурента — добавь 1–2 ради уникальности): ${differentiatorLsi.join(', ')}.` : ''}`;
  }


  return `[ВХОДНЫЕ ДАННЫЕ]
- Бренд (brand_name): ${inputs.brand || ''}
  - Год (current_year): ${year}
  - Проверенная цена ([price_data]): ${priceData || 'null'}
- Главный поисковый запрос (target_keyword): ${keyword}
- Важные слова из ТОП-10 (important_words_list) — ИСПОЛЬЗОВАТЬ ВСЕ, распределить между Title / Description / H1, каждое ≥1 раз: ${importantWords.join(', ')}
- LSI-слова (lsi_list) — вплести 2–3 в Description, остальное по возможности: ${recommendedWords.join(', ')}
- Краткий контекст / УТП страницы (page_context): ${pageContext}

Примеры Title конкурентов из ТОП-выдачи (для анализа интента и формул):
${competitorsTitles}${audienceBlock}${relevanceBlock}${ctrBlock}

Создай мета-теги строго по правилам DrMax из system-prompt (формулы Title, длины,
бренд / CTA в Description, H1 ≤70 символов и не копия Title).`;
}

/**
 * Постобработка ответа модели: гарантирует длины Title/Description/H1 и бренд.
 * Покрытие важных LSI здесь не форсируется, чтобы не ломать читаемость.
 *
 * @param {object} result — распарсенный JSON от Gemini
 * @param {object} inputs — { niche, brand, toponym, phone, summary }
 */
function postValidate(result, inputs) {
  const notes = [];
  const serpIntent = inputs.ctrAnalysis && inputs.ctrAnalysis.serp_intent;
  if (serpIntent && serpIntent.value) {
    result.intent = serpIntent.value;
    result.intent_reason = `Определено по ТОП-10: commercial ${Math.round(serpIntent.commercial_frequency * 100)}%, informational ${Math.round(serpIntent.informational_frequency * 100)}%`;
  }

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

  // 4. Финальный контроль длины Description после всех вставок.
  if (typeof result.description === 'string' && result.description.length > DESC_MAX) {
    result.description = trimToLastSentence(result.description, DESC_MAX - 3);
  }
  if (typeof result.description === 'string') result.description_length = result.description.length;

  // 5. H1 (v2 — поле теперь поддерживается). Жёсткий лимит 70 символов,
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

function findHardViolations(result, inputs) {
  const violations = [];
  const description = String(result.description || '');
  const h1 = String(result.h1 || '');
  const intent = inputs.ctrAnalysis && inputs.ctrAnalysis.serp_intent
    && inputs.ctrAnalysis.serp_intent.value;
  const priceData = extractPriceData(inputs);

  if (intent === 'Commercial/Transactional'
      && (description.includes('?') || /^(ищете|нужен|нужна|нужно|хотите)\b/i.test(description.trim()))) {
    violations.push('Commercial Description не должен содержать вопрос или начинаться с «Ищете/Нужен/Хотите»');
  }
  if (!priceData && /(?:цен[ауы]?|стоимост|руб(?:\.|лей)?|₽)/i.test(description)) {
    violations.push('price_data отсутствует: запрещены цена, стоимость, руб и ₽');
  }
  const priceValue = priceData && priceData.match(/\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб(?:\.|лей)?|р\.)/i);
  if (priceData && priceValue
      && !description.replace(/\s+/g, ' ').toLowerCase().includes(priceValue[0].replace(/\s+/g, ' ').toLowerCase())) {
    violations.push(`точная price_data «${priceData}» не перенесена в Description`);
  }
  if (/(?:^|\W)(купить|цена|недорого)(?:\W|$)/i.test(h1)) {
    violations.push('H1 содержит запрещённый коммерческий хвост');
  }
  if (/^(в этой статье мы расскажем|наша компания предлагает|добро пожаловать на сайт)/i.test(description.trim())) {
    violations.push('Description начинается с запрещённого пустого штампа');
  }
  return violations;
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
 *   3) Если после трёх попыток слова пропущены — фиксируем warning для редактора,
 *      но не вклеиваем LSI механически.
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

  const MAX_ATTEMPTS = 3;
  const allNotes = [];
  let result = null;
  let lastMissed = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalThoughtsTokens = 0;
  let totalCachedTokens   = 0;
  let model = '';
  let attemptsMade = 0;
  let userPrompt = baseUserPrompt;
  let lastViolations = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    // callGemini автоматически: JSON-strict guard в systemInstruction,
    // прокси, ретраи на сетевых/5xx/429, агрегация text-частей. maxTokens=8192:
    // gemini-3.x thinking-модель тратит часть бюджета на «мысли».
    const callOptions = { temperature: 0.4, maxTokens: 8192, timeoutMs: 90000 };
    callOptions.model = META_GENERATION_MODEL;
    const callRes = await callGemini(
      SYSTEM_PROMPT,
      userPrompt,
      callOptions,
    );
    totalTokensIn       += callRes.tokensIn       || 0;
    totalTokensOut      += callRes.tokensOut      || 0;
    totalThoughtsTokens += callRes.thoughtsTokens || 0;
    totalCachedTokens   += callRes.cachedTokens   || 0;
    model = callRes.model || model;

    const parsed = parseMetaJson(callRes.text);
    const { result: validated, notes } = postValidate(parsed, inputs);
    result = validated;
    lastViolations = findHardViolations(result, inputs);
    if (attempt > 1) allNotes.push(`— Попытка ${attempt} (перегенерация) —`);
    allNotes.push(...notes);

    // Проверяем покрытие важных LSI между Title и Description.
    if (!importantWords.length
        || typeof result.title !== 'string'
        || typeof result.description !== 'string') {
      lastMissed = [];
      if (!lastViolations.length) break;
    } else {
      const combined = `${result.title} ${result.description}`;
      const { missed_lsi } = checkLsiUsage(combined, importantWords);
      lastMissed = missed_lsi;
    }

    if (!lastMissed.length && !lastViolations.length) break;
    if (attempt === MAX_ATTEMPTS) {
      if (lastMissed.length) {
        allNotes.push(
          `Попытка ${attempt}: после перегенерации остались непокрытые важные LSI: `
          + `${lastMissed.join(', ')}.`,
        );
      }
      if (lastViolations.length) {
        allNotes.push(`Попытка ${attempt}: остались нарушения: ${lastViolations.join('; ')}.`);
      }
      break;
    }

    if (lastMissed.length) {
      allNotes.push(
        `Попытка ${attempt}: пропущены важные LSI: ${lastMissed.join(', ')}. `
        + 'Запрашиваем органичную перегенерацию у Gemini.',
      );
    }
    if (lastViolations.length) {
      allNotes.push(`Попытка ${attempt}: нарушения правил CTR: ${lastViolations.join('; ')}.`);
    }

    // Корректирующий блок к user-prompt: явно перечисляем пропущенные слова и
    // запрещаем «костыли» (хвосты «Также: …», голые перечисления).
    userPrompt = `${baseUserPrompt}

=== УТОЧНЕНИЕ К ПРЕДЫДУЩЕМУ ОТВЕТУ ===
Предыдущая версия ответа:
- Title: ${result.title}
- Description: ${result.description}

Нарушения, которые необходимо исправить:
${lastMissed.length ? `- Не использованы обязательные важные слова: ${lastMissed.join(', ')}.` : ''}
${lastViolations.map((v) => `- ${v}.`).join('\n')}

Перепиши Title и Description так, чтобы каждое из этих слов появилось
ОРГАНИЧНО (внутри осмысленного предложения, без перечислений через запятую,
без хвостов «Также: …» / «Ключи: …»). Сохрани:
- длину Title до 75 символов; ключ + главное УТП в первых 50,
- длину Description 150–160 символов,
- H1 ≤ 70 символов и НЕ копию Title,
- CTA в конце Description,
- бренд / CTA / год / price_data по тем же правилам, что и раньше.

Если какое-то слово невозможно вписать без переспама или нарушения
читаемости — лучше честно опусти его (отметь это в coverage_self_audit),
чем испортить сниппет ради «галочки».`;
  }

  // После трёх попыток не вклеиваем LSI механически: читаемость и CTR важнее.
  if (lastMissed.length) {
    lastMissed.forEach((word) => {
      allNotes.push(`⚠️ LSI слово «${word}» не интегрировано, так как нарушает читаемость.`);
    });
  }
  if (lastViolations.length) {
    throw new Error(
      `Мета-теги отклонены после ${MAX_ATTEMPTS} попыток: ${lastViolations.join('; ')}`,
    );
  }

  result.detected_year = year;
  result.post_validation_notes = allNotes;
  result._meta = {
    model,
    tokensIn:        totalTokensIn,
    tokensOut:       totalTokensOut,
    thoughtsTokens:  totalThoughtsTokens,
    cachedTokens:    totalCachedTokens,
    attempts: attemptsMade,
    provider: 'gemini',
  };
  return result;
}

module.exports = {
  generateDrMaxMeta,
  extractPriceData,
  buildUserPrompt,
  postValidate,
  findHardViolations,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX, H1_MAX,
  META_GENERATION_MODEL,
};
