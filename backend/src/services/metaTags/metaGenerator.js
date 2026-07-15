'use strict';

/**
 * Meta-tag generator (Задача D — GIST Meta Filter Pipeline).
 *
 * generateDrMaxMeta теперь делегирует генерацию трёхфазному GIST Meta Filter
 * Pipeline (gistMetaFilter.runGistMetaPipeline, 11 шагов Steps 8.1–8.11):
 *   1) Candidate generation — page angle + missing nodes + 5 эвристик;
 *   2) Filter + scoring — 4 теста GIST, fallback sequence, tie-break ranker;
 *   3) Pair generation + conflict check — сборка title/description, semantic
 *      conflict (Step 8.9) и pair replaceability (Step 8.10).
 *
 * Кириллические safe ranges (§4 ТЗ):
 *   • Title 70–80 символов (GIST-фактор в первых 35);
 *   • Description desktop 180–190 (GIST-фактор в первых 90), mobile 90–105;
 *   • H1 — UX-заголовок (≤70 символов), а не копия SEO Title.
 *
 * Легаси-хелперы одновызовной DrMax-версии (SYSTEM_PROMPT, buildUserPrompt,
 * postValidate, findHardViolations) сохранены: postValidate/findHardViolations
 * используются как детерминированные guard'ы поверх результата GIST-пайплайна.
 */

const { autoCloseJSON } = require('../../utils/autoCloseJSON');
const { trimToLastWord, trimToLastSentence } = require('./lengthHelpers');
const { normalizeGeminiCopywritingModel } = require('../llm/geminiModels');
const { analyzeSnippets } = require('./snippetAnalyzer');

// Кириллические safe ranges (§4 ТЗ) — синхронны с gistMetaFilter.
const TITLE_MIN = 70;
const TITLE_MAX = 80;
const DESC_MIN  = 180;
const DESC_MAX  = 190;
const H1_MAX    = 70;
const META_GENERATION_MODEL = 'gemini-3.1-pro-preview';

const SYSTEM_PROMPT = `Ты — Senior Technical SEO-специалист и Data-Driven копирайтер.
Задача: создать идеальные мета-теги (Title, Description) и H1 для веб-страницы,
опираясь на семантический анализ конкурентов и поведенческие факторы.

<Ограничения и правила DrMax>

1. Title (70–80 символов, включая пробелы):
   - Главный ключ должен быть в первых 3 словах.
   - Главный ключ и главное УТП / differentiator_lsi ОБЯЗАНЫ находиться в первых
     50 символах — хвост после 50 символов может быть обрезан в выдаче.
   - ИСПОЛЬЗУЙ ВСЕ «важные слова» из important_words_list — по возможности
     каждое должно попасть именно в Title. Если какое-то слово никак не
     вписывается без переспама — перенеси его в Description или H1 и честно
     отметь это в coverage_self_audit.
   - Выбери одну из формул:
     a) «Ключ + выгода + срок/гарантия»
     b) «Регион + ключ + год + цена»
     c) «Сравнение + ключ + преимущество»
   - Добавь {current_year} (если передан) или цифру/акцию из {page_context}.
   - Разделители: вертикальная черта (|), длинное тире (—). НЕ используй
     ёлочки («»). Только прямые кавычки (").
   - Пример: «Кредит под залог недвижимости | Ставка от 9% | Одобрение за 24ч»

2. Meta Description (180–190 символов, включая пробелы):
   - Законченное предложение (не обрывай на полуслове).
   - Description строится ИЗ ОПРЕДЕЛЁННОГО ИНТЕНТА И LSI: сначала отработай
     переданный SERP_INTENT (коммерческий → факты/УТП/цена, информационный →
     тизер ответа), затем органично вплети оставшиеся «важные слова» и LSI из
     {lsi_list} / блока LSI-интента.
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

10. КОНКУРЕНТНОЕ ПРЕВОСХОДСТВО (главная цель):
   - Тебе передан ПОЛНЫЙ список Title и Description конкурентов ТОП-10 с их
     CTR-оценками. Внимательно изучи, как пишут конкуренты — особенно лучших
     по CTR-оценке.
   - У тебя есть требования по LSI и интенту, которых нет у конкурентов.
     Учти ВСЁ, что передано (конкуренты, LSI, интент, CTR-паттерны, УТП,
     цена), и напиши ЛУЧШУЮ версию мета-тегов: сниппет должен быть кликабельнее
     самого сильного конкурента, но не сливаться с ТОПом.

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
  // Полные мета-теги конкурентов — БЕЗ ограничения по символам (Title и
  // Description передаются как спарсились). CTR-оценки подтягиваются из
  // ctrAnalysis (по URL), чтобы модель видела самых кликабельных конкурентов.
  const ctrScoreByIdx = new Map();
  if (inputs.ctrAnalysis && Array.isArray(inputs.ctrAnalysis.competitor_titles)) {
    inputs.ctrAnalysis.competitor_titles.forEach((p, i) => {
      if (typeof p.ctr_score === 'number') ctrScoreByIdx.set(i, p.ctr_score);
    });
  }
  const competitorsMetas = (serpData || [])
    .map((c, i) => {
      const score = ctrScoreByIdx.has(i) ? ` (CTR-оценка: ${ctrScoreByIdx.get(i)}/100)` : '';
      const desc = c.snippet || c.description || '';
      return `[${i + 1}]${score} Title: ${c.title}${desc ? `\n    Description: ${desc}` : ''}`;
    })
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
    const lsiIntent = ctr.lsi_intent || null;
    const lsiIntentBlock = lsiIntent ? `
- LSI-ИНТЕНТ (анализ интента по LSI-семантике ТОПа): ${lsiIntent.value} (уверенность ${pct(lsiIntent.confidence)}).${(lsiIntent.commercial_lsi || []).length ? `
  • Коммерческие LSI: ${lsiIntent.commercial_lsi.join(', ')}.` : ''}${(lsiIntent.informational_lsi || []).length ? `
  • Информационные LSI: ${lsiIntent.informational_lsi.join(', ')}.` : ''}
  • Description строй ИЗ этого интента и этих LSI: интент задаёт тональность/структуру, LSI — словарь.` : '';
    ctrBlock = `

[АНАЛИЗ КЛИКАБЕЛЬНОСТИ ВЫДАЧИ — фактчекинг ТОП-10, использовать обязательно]
- SERP_INTENT: ${serpIntent.value || 'Mixed/Unclear'} (commercial=${pct(serpIntent.commercial_frequency)}, informational=${pct(serpIntent.informational_frequency)}). Это жёсткое условие, не переопределяй его.${lsiIntentBlock}
- Длина Title в ТОПе: p50=${p.length_p50_title}, p90=${p.length_p90_title}. Твой целевой диапазон: 70–80 символов.
- Длина Description в ТОПе: p50=${p.length_p50_desc}, p90=${p.length_p90_desc}. Твой целевой диапазон: 180–190 символов.
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
- Важные слова из ТОП-10 (important_words_list) — ИСПОЛЬЗОВАТЬ ВСЕ; по возможности КАЖДОЕ должно попасть в Title, остальные распределить между Description / H1, каждое ≥1 раз: ${importantWords.join(', ')}
- LSI-слова (lsi_list) — вплести 2–3 в Description, остальное по возможности: ${recommendedWords.join(', ')}
- Краткий контекст / УТП страницы (page_context): ${pageContext}

Полные мета-теги конкурентов из ТОП-выдачи (Title + Description, без обрезки,
с CTR-оценками; для анализа интента, формул и конкурентного превосходства):
${competitorsMetas}${audienceBlock}${relevanceBlock}${ctrBlock}

Итог: вот как пишут конкуренты (выше, с CTR-оценками), вот наши требования по
LSI и интентам (блоки выше). Учти ВСЁ переданное и напиши ЛУЧШУЮ версию
мета-тегов — кликабельнее сильнейшего конкурента, строго по правилам DrMax из
system-prompt (формулы Title, Title 70–80 симв., Description 180–190 симв.,
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

  // 2. Description: обрезаем по последнему предложению при превышении (DESC_MAX).
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

/**
 * extractFirstJsonObject — вырезает ПЕРВЫЙ сбалансированный JSON-объект.
 *
 * «Синдром болтливости» Gemini: модель корректно закрывает объект, а затем
 * дописывает мусор («"niche_analysis": "..."» в пустоту). Если в мусоре есть
 * своя }, срез «первая { … последняя }» даёт невалидный JSON и JSON.parse
 * падает с «Unexpected non-whitespace character after JSON at position N».
 * Поэтому сканируем от первой { с учётом строк/экранирования и режем ровно
 * там, где глубина скобок вернулась к нулю.
 *
 * @param {string} text
 * @returns {string|null} — подстрока с объектом или null, если объект не закрыт
 */
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let inString = false;
  let escapeNext = false;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (char === '\\') escapeNext = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null; // объект не закрыт (обрыв по MAX_TOKENS)
}

function parseMetaJson(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) throw new Error('Gemini вернул пустой ответ');

  // 1) Снимаем markdown fences
  let t = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  // 2) Вырезаем первый СБАЛАНСИРОВАННЫЙ объект — игнорируем весь мусор,
  //    который модель дописала после закрывающей } (в т.ч. с лишними скобками).
  const balanced = extractFirstJsonObject(t);
  if (balanced) {
    try { return JSON.parse(balanced); } catch (_) { /* fallback ниже */ }
  }

  // 3) Запасной срез от первой { до последней } + прямой JSON.parse
  const fb = t.indexOf('{');
  const lb = t.lastIndexOf('}');
  if (fb !== -1 && lb > fb) t = t.substring(fb, lb + 1);
  try { return JSON.parse(t); } catch (_) { /* fallback */ }

  // 4) autoCloseJSON — восстановление обрыва
  try { return JSON.parse(autoCloseJSON(t)); } catch (e) {
    const snippet = raw.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(`Gemini вернул не-JSON ответ: ${e.message}. Фрагмент: «${snippet}»`);
  }
}

/**
 * Главная функция: генерирует метатеги по одному ключу через GIST Meta Filter
 * Pipeline (Задача D). Трёхфазная схема вместо одного вызова:
 *
 *   1) Candidate generation (Steps 8.1–8.4) — задача поля, 3–5 кандидатов
 *      (page angle + missing nodes + 5 эвристик), карта шаблонов конкурентов;
 *   2) Filter + scoring (Steps 8.5/8.5b/8.6) — 4 бинарных теста, forced-choice
 *      fallback sequence, tie-break scoring 0–2;
 *   3) Pair generation + conflict check (Steps 8.7–8.10) — title вокруг одного
 *      strongest fact, description как compact sequence, semantic conflict и
 *      pair replaceability с ретраями.
 *
 * Возвращает JSON-контракт §8 (winner_fact, winner_source, scores,
 * conflict_check, replaceability_check, temporary_gist_factor, review_date,
 * manual_review_required) + легаси-поля (h1, title_length, description_length,
 * post_validation_notes, _meta) для обратной совместимости с metaStages /
 * pageMetaAudit / UI.
 *
 * @param {object} args
 * @param {string} args.keyword
 * @param {object} args.semantics  — результат extractSemantics()
 * @param {Array}  args.serpData
 * @param {object} args.inputs     — { niche, brand, toponym, phone, summary,
 *   ctrAnalysis, price_data, pageAngle, missingNodes, standalone_exposure,
 *   gemini_model }
 * @returns {Promise<object>}
 */
async function generateDrMaxMeta({ keyword, semantics, serpData, inputs }) {
  const { runGistMetaPipeline } = require('./gistMetaFilter');
  const importantWords   = ((semantics && semantics.title_mandatory_words) || []).slice(0, 6);
  const recommendedWords = ((semantics && semantics.description_mandatory_words) || []).slice(0, 10);
  const year = detectYear(importantWords, recommendedWords, serpData);

  // Копирайтерская модель задачи (та же конвенция, что у пайплайнов статей).
  const copywriterModel = normalizeGeminiCopywritingModel(inputs && inputs.gemini_model);
  const safeInputs = { ...(inputs || {}) };
  if (!safeInputs.snippetAnalysis) {
    try {
      safeInputs.snippetAnalysis = analyzeSnippets(serpData || []);
    } catch (_) { /* fail-open: генерация возможна без анализа сниппетов */ }
  }

  const result = await runGistMetaPipeline({
    keyword,
    semantics: semantics || {},
    serpData: serpData || [],
    inputs: safeInputs,
    options: { copywriterModel },
  });

  // Легаси-поля для metaStages / pageMetaAudit / UI.
  result.title_length = String(result.title || '').length;
  result.description_length = String(result.description || '').length;
  result.detected_year = year;

  const serpIntent = safeInputs && safeInputs.ctrAnalysis && safeInputs.ctrAnalysis.serp_intent;
  if (serpIntent && serpIntent.value) {
    result.intent = serpIntent.value;
    result.intent_reason = `Определено по ТОП-10: commercial ${Math.round((serpIntent.commercial_frequency || 0) * 100)}%, informational ${Math.round((serpIntent.informational_frequency || 0) * 100)}%`;
  }

  // Детерминированные guard'ы прежней версии (цены без price_data,
  // коммерческие вопросы, штампы, H1-хвосты) — теперь только warnings:
  // selection-логика GIST-пайплайна первична.
  const violations = findHardViolations(result, safeInputs || {});
  if (violations.length) {
    result.post_validation_notes = result.post_validation_notes || [];
    violations.forEach((v) => result.post_validation_notes.push(`⚠️ Guard: ${v}.`));
  }

  return result;
}

module.exports = {
  generateDrMaxMeta,
  extractPriceData,
  buildUserPrompt,
  postValidate,
  findHardViolations,
  parseMetaJson,
  extractFirstJsonObject,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX, H1_MAX,
  META_GENERATION_MODEL,
};
