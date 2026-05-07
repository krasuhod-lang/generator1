'use strict';

/**
 * audienceNicheAnalyzer.js — глубокий анализ ЦА и ниши.
 *
 * В отличие от targetPageAnalyzer (который требует URL целевой страницы),
 * этот модуль запускается ВСЕГДА — даже если URL не указан. Он использует
 * все доступные входные данные:
 *   - input_target_service (основной запрос / тема)
 *   - input_brand_name + input_brand_facts
 *   - input_target_audience, input_niche_features (если уже заполнены)
 *   - input_business_type, input_region
 *   - результаты targetPageAnalyzer (если были)
 *
 * Производит:
 *   • audience_personas — массив 2-4 детальных персон с JTBD, болями,
 *     возражениями, критериями принятия решения, языком общения.
 *   • niche_deep_dive   — массив 4-6 структурированных инсайтов о нише:
 *     ритуалы отрасли, типичные возражения, trust-коды, сезонность,
 *     YMYL-риски, специфические термины.
 *   • content_voice     — описание тона/стиля, который ожидает аудитория
 *     в этой нише (для сенсорной иммерсии в туризме / экспертности
 *     в B2B / эмоциональности в lifestyle).
 *
 * Эти данные прокидываются в Stage 1 (entity), Stage 2 (taxonomy) и
 * особенно в Stage 3 (генерация контента) для устранения
 * «сухого перечисления фактов языком Википедии».
 */

const { callLLM } = require('../llm/callLLM');

// ── Лимиты длины строк для подстановки в промпты ────────────────────
// Используются и в promptBuilder, и при формировании входного контекста
// для самого анализатора, поэтому вынесены в модульные константы.
const MAX_KNOWN_FIELD_CHARS = 2500;  // input_target_audience / niche_features
const MAX_BRAND_FACTS_CHARS = 2000;  // input_brand_facts

const AUDIENCE_NICHE_PROMPT = `**РОЛЬ И СИСТЕМНЫЕ НАСТРОЙКИ:**
Ты — Senior Маркетинговый Аналитик и эксперт по поведенческой психологии потребителей уровня Tier-1, одновременно — Стратег конкурентной разведки и инсайдер рынка. ТВОЯ СУПЕРСИЛА:
- Глубоко понимаешь JTBD (Jobs-to-Be-Done) и истинные эмоциональные мотивы людей.
- Находишь «тёмные» страхи и скрытые тревоги, о которых люди не говорят вслух.
- Определяешь триггерные ситуации, запускающие процесс выбора и покупки.
- Говоришь на языке реальных клиентов, избегая академических и маркетинговых клише.
- Видишь нишу насквозь: знаешь типовые уловки игроков рынка, теневые схемы, профессиональный сленг (LSI-сущности).
- Отличаешь подлинные факторы доверия (E-E-A-T) от маркетинговой «мишуры».

═══════════════════════════════════════════
ВВОДНЫЕ ДАННЫЕ ПРОЕКТА
═══════════════════════════════════════════
ОСНОВНАЯ ТЕМА / ЗАПРОС: {{TARGET_SERVICE}}
БРЕНД: {{BRAND_NAME}}
СФЕРА БИЗНЕСА: {{BUSINESS_TYPE}}
РЕГИОН: {{REGION}}
ФАКТЫ О БРЕНДЕ:
{{BRAND_FACTS}}

УЖЕ ИЗВЕСТНО О ЦА:
{{KNOWN_AUDIENCE}}

УЖЕ ИЗВЕСТНО О НИШЕ:
{{KNOWN_NICHE}}

═══════════════════════════════════════════
ЗАДАЧА — ВЕРНИ JSON
═══════════════════════════════════════════
Цель — выдать рабочую voice-of-customer карту, на которой копирайтер сможет писать резонирующий контент, а маркетолог — формулировать офферы. Никакой воды, никаких академических обобщений.

1. AUDIENCE_PERSONAS (3–5 ПЕРСОН): Учитывай расслоение аудитории — сегменты должны быть РАЗНЫМИ (от «работяги, копившего годами» до «премиального клиента в режиме делегирования», включая пенсионеров с последними сбережениями, экспертов-перфекционистов, и т.д.).

   Для КАЖДОЙ персоны обязательно:
   • name                  — ёмкое, хлёсткое название сегмента («Недоверчивый работяга-семьянин», «Молодая пара в режиме горящей задачи», «Корпоративный клиент-делегатор»).
   • demographics          — возраст, доход (реальная сумма для региона), профессия, география, статус, семейное положение (1–2 предложения, плотно).
   • trigger_event         — какое конкретное СОБЫТИЕ заставило персону искать решение ПРЯМО СЕЙЧАС (не «у него потребность», а «получил диагноз», «истёк срок», «развалилась прошлая машина», «уволили», «жена устала»).
   • buyer_journey_stage   — обязательное поле, ровно одно из: "awareness" | "consideration" | "decision" | "retention". Это этап воронки, на котором персона типично попадает в нишу.
   • jobs_to_be_done       — по фреймворку JTBD: «когда [триггерная ситуация], я хочу [функциональный + эмоциональный + социальный результат], чтобы [глубинная мотивация и идентичность]». Раскрой все три уровня работы (functional / emotional / social).
   • pains                 — 4–6 КОНКРЕТНЫХ болей/страхов. Запрещены банальности уровня «дорого» или «долго». Используй формат «боится конкретно того, что [сценарий с цифрами/ситуацией]». Пример хорошего: «Боится, что потратит 300 000 ₽, а результата не будет», «Стесняется идти к врачу из-за стигмы мужского бесплодия», «Боится переплатить и услышать от друзей "тебя развели"».
   • dark_fears            — 2–3 «тёмных», стыдных, не проговариваемых вслух страха персоны (например: «втайне думает, что не справится сам и от этого ещё больше злится»).
   • objections            — 5 жёстких возражений в формате прямых цитат из головы клиента. Обязательно покрой пять типов: ценовое, временное, скептическое (недоверие к эксперту), статусное/эго, страховое (гарантии). Формат: { "type": "ценовое|временное|скептическое|статусное|страховое", "quote": "[прямая цитата]" }.
   • barriers              — 3–5 внутренних/внешних препятствий, которые мешают принять решение (деньги / время / окружение / эго / страх осуждения / прошлый плохой опыт). Каждый барьер — короткая цитата-отговорка.
   • decision_criteria     — 3–5 реальных критериев выбора (не общие «качество и цена», а конкретно: «наличие фото эндоскопии», «врач с публикациями», «фиксированная цена в договоре», «возможность поговорить с прошлыми клиентами»).
   • content_triggers      — какие фразы, факты, форматы (отзыв-видео / кейс с цифрами / чеклист / таблица «было/стало» / отчёт / схема процесса) РЕЗОНИРУЮТ с этой персоной и пробивают её защиту.
   • voice_examples        — 3–5 ЖИВЫХ разговорных фраз, как сама персона формулирует запрос на форумах / в поиске / в курилке. Это критичный LSI-компонент. Ориентир — реальные форумные формулировки (тип u-mama.ru / babyblog.ru / drive2.ru / pikabu / отраслевые тематические сообщества). Примеры стиля: «кто делал эко по квоте, долго ждать?», «спермограмма плохая, есть ли смысл пить витамины или сразу на тезе?», «куплю китайца с пробегом, они же не ломаются?». Маркетинговый/официальный язык запрещён.
   • ideal_outcome         — как персона визуализирует идеальный исход. Что она должна почувствовать в момент финала? Какую эмоциональную и социальную «работу» нанимает выполнить продукт/услугу?

2. NICHE_DEEP_DIVE (5–7 ИНСАЙТОВ ниши): Глубже банального описания. Каждый инсайт — это «что отличает эту нишу от соседних» + конкретное правило для копирайтера.

   Для КАЖДОГО инсайта:
   • theme                 — короткое название («Сезонность спроса», «YMYL-риски и ответственность», «Trust-коды отрасли», «Типичные подводные камни», «Жаргон ниши и LSI», «Региональная специфика», «Теневые схемы рынка», «Доминирующие страхи»).
   • insight               — РАЗВЁРНУТОЕ описание (3–5 предложений): что именно отличает эту нишу, какие неочевидные факторы работают, какие иллюзии у новичков. Используй фактуру и цифры, где можешь.
   • content_implication   — КОНКРЕТНОЕ ПРАВИЛО для текста, начинающееся с глагола: «всегда подчёркивать [X]», «избегать [Y]», «обязательно показывать [Z]», «никогда не использовать формулировку "[…]" — заменять на "[…]"». Пример: «В нише ЭКО силен страх гиперстимуляции — в статьях всегда подчёркивать щадящие протоколы и индивидуальный подбор доз гормонов».

3. NICHE_TERMINOLOGY (10–15 LSI-сущностей): Узкоспециализированные термины, аббревиатуры, жаргонизмы, которые используют реальные эксперты и матёрые клиенты ниши. Не маркетинговые слова, а именно профессиональный язык, по которому Google понимает экспертность контента.
   Формат: массив строк «термин — короткая хлёсткая расшифровка».
   Примеры по разным нишам: «АМГ — антимюллеров гормон, маркер овариального резерва», «микро-ТЕЗЕ — микрохирургическая экстракция сперматозоидов из ткани яичка», «эндоскопия цилиндров — осмотр камер сгорания через свечное отверстие», «контрактный мотор — двигатель из Японии/Европы без пробега по РФ».

4. NICHE_RED_FLAGS (5–8 запрещённых формулировок): Что КАТЕГОРИЧЕСКИ нельзя писать в этой нише — обещания, гарантии, формулировки, которые либо нарушают регуляторику (медицина, финансы, юр.), либо разрушают доверие у профессиональной аудитории, либо являются маркером «инфоцыганства».
   Формат: массив строк { "claim": "что нельзя обещать/писать", "reason": "почему", "replacement": "чем заменить" }. Минимум 5 пунктов.

5. CONTENT_VOICE — оптимальный тон/стиль для ниши и аудитории:
   • tone               — основной тон (экспертный / дружески-экспертный / сенсорно-эмоциональный / деловой-сдержанный / технико-инженерный / врачебно-ответственный).
   • emotional_register — какие эмоции должны вызывать тексты (доверие через доказательства / спокойствие и снижение тревоги / срочность через сценарий / восхищение технологичностью).
   • sensory_focus      — boolean: для каких ниш важна сенсорика (туризм/HoReCa/lifestyle = true; B2B/SaaS/медицина = false).
   • forbidden_voice    — массив строк: каких интонаций избегать (официоз / «вода» / агрессивный sales / wikipedia-стиль / 100% гарантии / агрессивные CTA). Для YMYL-ниш ОБЯЗАТЕЛЬНО включить:
       • «100% гарантии успеха» — заменять на «вероятность успеха зависит от индивидуальных факторов»;
       • «Запишитесь сейчас!» / «Купите сегодня!» / «Не упустите!» — заменять на «обсудите вашу ситуацию с [специалистом]»;
       • Любые обещания результата без оговорок;
       • Уменьшительно-ласкательные («операцийка», «процедурка»);
       • Категорические «единственный / лучший / №1» без подтверждения.
   • cta_style          — короткое описание правильного формата CTA для ниши (например: «не "Записаться сейчас", а "Получить консультацию репродуктолога — она ни к чему не обязывает"»).

═══════════════════════════════════════════
ПРАВИЛА (СТРОГО)
═══════════════════════════════════════════
• ОПИРАЙСЯ на входные данные, но РАСКРЫВАЙ их глубже на основе общих знаний о нише и поведенческой психологии.
• Если данных мало — используй типичные паттерны для указанной BUSINESS_TYPE и TARGET_SERVICE (это аналитика, не извлечение фактов).
• НЕ выдумывай конкретные цифры/цены/гарантии БРЕНДА — это для генерации, не для анализа. Цифры из ниши/рынка — допустимы как «обычно в нише X стоит ~Y тыс. руб.».
• voice_examples — обязательно живые разговорные фразы, не маркетинговые формулировки.
• pains и objections — обязательно через конкретные сценарии и суммы, а не общие слова.
• Для YMYL-ниш (медицина, финансы, юриспруденция, дети, безопасность) обязательно заполнен niche_red_flags и forbidden_voice с конкретикой.
• content_implication у каждого инсайта — глагольное практическое правило, не описание.
• СТРОГО JSON, без markdown, без обёрток, без приветствий.

═══════════════════════════════════════════
СТРУКТУРА ОТВЕТА
═══════════════════════════════════════════
{
  "audience_personas": [
    {
      "name": "...",
      "demographics": "...",
      "trigger_event": "...",
      "buyer_journey_stage": "awareness|consideration|decision|retention",
      "jobs_to_be_done": "...",
      "pains": ["...", "..."],
      "dark_fears": ["...", "..."],
      "objections": [
        { "type": "ценовое|временное|скептическое|статусное|страховое", "quote": "..." }
      ],
      "barriers": ["...", "..."],
      "decision_criteria": ["...", "..."],
      "content_triggers": ["...", "..."],
      "voice_examples": ["...", "..."],
      "ideal_outcome": "..."
    }
  ],
  "niche_deep_dive": [
    {
      "theme": "...",
      "insight": "...",
      "content_implication": "..."
    }
  ],
  "niche_terminology": ["термин — расшифровка", "..."],
  "niche_red_flags": [
    { "claim": "...", "reason": "...", "replacement": "..." }
  ],
  "content_voice": {
    "tone": "...",
    "emotional_register": "...",
    "sensory_focus": true,
    "forbidden_voice": ["...", "..."],
    "cta_style": "..."
  }
}

[SELF-AUDIT — silent, do not output]
  ✓ В персонах разное расслоение (доход / опыт / стадия воронки), а не клоны?
  ✓ У каждой персоны заполнено buyer_journey_stage и trigger_event?
  ✓ pains и objections — через конкретные сценарии и цифры, а не общие слова?
  ✓ voice_examples — звучат как реальные форумные/разговорные фразы, без маркетинга?
  ✓ niche_deep_dive[].content_implication — глагольное правило для копирайтера, а не описание?
  ✓ Для YMYL-ниши niche_red_flags и forbidden_voice содержательны (минимум 5 пунктов с заменами)?
  ✓ niche_terminology — реальные профессиональные термины, не маркетинговые слова?

ВЕРНИ ТОЛЬКО JSON. НИКАКОГО ТЕКСТА ДО ИЛИ ПОСЛЕ.`;

/**
 * formatPersonaForPrompt — компактное текстовое представление персоны
 * для подстановки в Stage 3.
 */
function formatPersonaForPrompt(p) {
  if (!p || typeof p !== 'object') return '';
  const lines = [];
  if (p.name)            lines.push(`▸ ${p.name}`);
  if (p.demographics)    lines.push(`  Демография: ${p.demographics}`);
  if (p.trigger_event)   lines.push(`  Триггер прямо сейчас: ${p.trigger_event}`);
  if (p.buyer_journey_stage) lines.push(`  Этап воронки: ${p.buyer_journey_stage}`);
  if (p.jobs_to_be_done) lines.push(`  JTBD: ${p.jobs_to_be_done}`);
  if (Array.isArray(p.pains) && p.pains.length)
    lines.push(`  Боли: ${p.pains.join('; ')}`);
  if (Array.isArray(p.dark_fears) && p.dark_fears.length)
    lines.push(`  «Тёмные» страхи: ${p.dark_fears.join('; ')}`);
  if (Array.isArray(p.objections) && p.objections.length) {
    const objStr = p.objections
      .map((o) => {
        if (o && typeof o === 'object') {
          const t = o.type ? `[${o.type}] ` : '';
          const q = o.quote || '';
          return q ? `${t}«${q}»` : '';
        }
        return typeof o === 'string' ? o : '';
      })
      .filter(Boolean)
      .join('; ');
    if (objStr) lines.push(`  Возражения: ${objStr}`);
  }
  if (Array.isArray(p.barriers) && p.barriers.length)
    lines.push(`  Барьеры к покупке: ${p.barriers.join('; ')}`);
  if (Array.isArray(p.decision_criteria) && p.decision_criteria.length)
    lines.push(`  Критерии решения: ${p.decision_criteria.join('; ')}`);
  if (Array.isArray(p.content_triggers) && p.content_triggers.length)
    lines.push(`  Контент-триггеры: ${p.content_triggers.join('; ')}`);
  if (Array.isArray(p.voice_examples) && p.voice_examples.length)
    lines.push(`  Голос ЦА: «${p.voice_examples.join('», «')}»`);
  if (p.ideal_outcome)   lines.push(`  Идеальный исход (JTBD-результат): ${p.ideal_outcome}`);
  return lines.join('\n');
}

/**
 * formatNicheInsightForPrompt — компактное текстовое представление инсайта.
 */
function formatNicheInsightForPrompt(n) {
  if (!n || typeof n !== 'object') return '';
  const parts = [];
  if (n.theme)               parts.push(`▸ ${n.theme}`);
  if (n.insight)             parts.push(`  ${n.insight}`);
  if (n.content_implication) parts.push(`  → Правило для текста: ${n.content_implication}`);
  return parts.join('\n');
}

/**
 * serializeAnalysisForPrompt — превращает результат анализа в готовые
 * текстовые блоки для подстановки в Stage 3 placeholders.
 *
 * @param {object|null} analysis
 * @returns {{ personasText: string, nicheDeepDiveText: string, contentVoiceText: string, nicheTerminologyText: string }}
 */
function serializeAnalysisForPrompt(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      personasText:         '',
      nicheDeepDiveText:    '',
      contentVoiceText:     '',
      nicheTerminologyText: '',
    };
  }
  const personas = Array.isArray(analysis.audience_personas) ? analysis.audience_personas : [];
  const insights = Array.isArray(analysis.niche_deep_dive)   ? analysis.niche_deep_dive   : [];
  const voice    = analysis.content_voice || {};
  const terms    = Array.isArray(analysis.niche_terminology) ? analysis.niche_terminology : [];

  const personasText = personas
    .map(formatPersonaForPrompt)
    .filter(Boolean)
    .join('\n\n');

  const nicheDeepDiveText = insights
    .map(formatNicheInsightForPrompt)
    .filter(Boolean)
    .join('\n\n');

  const voiceLines = [];
  if (voice.tone)               voiceLines.push(`Тон: ${voice.tone}`);
  if (voice.emotional_register) voiceLines.push(`Эмоциональный регистр: ${voice.emotional_register}`);
  if (typeof voice.sensory_focus === 'boolean') {
    voiceLines.push(`Сенсорика (запахи/вкусы/атмосфера): ${voice.sensory_focus ? 'ДА — обязательно использовать' : 'НЕТ — фокус на цифрах/кейсах'}`);
  }
  if (Array.isArray(voice.forbidden_voice) && voice.forbidden_voice.length) {
    voiceLines.push(`ИЗБЕГАТЬ интонаций: ${voice.forbidden_voice.join(', ')}`);
  }
  if (voice.cta_style)          voiceLines.push(`Стиль CTA: ${voice.cta_style}`);

  const redFlags = Array.isArray(analysis.niche_red_flags) ? analysis.niche_red_flags : [];
  if (redFlags.length) {
    const flagsStr = redFlags
      .map((rf) => {
        if (rf && typeof rf === 'object') {
          const claim   = rf.claim || '';
          const reason  = rf.reason ? ` (${rf.reason})` : '';
          const replace = rf.replacement ? ` → заменять на: «${rf.replacement}»` : '';
          return claim ? `• «${claim}»${reason}${replace}` : '';
        }
        return typeof rf === 'string' ? `• ${rf}` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (flagsStr) voiceLines.push(`КРАСНЫЕ ФЛАГИ ниши (нельзя говорить):\n${flagsStr}`);
  }
  const contentVoiceText = voiceLines.join('\n');

  const nicheTerminologyText = terms.length ? terms.join(', ') : '';

  return { personasText, nicheDeepDiveText, contentVoiceText, nicheTerminologyText };
}

/**
 * analyzeAudienceAndNiche — главный entrypoint.
 *
 * @param {object} task   — строка tasks (с заполненными полями)
 * @param {object} ctx    — { log, taskId, onTokens }
 * @param {object} [extra]
 * @param {object} [extra.targetPageAnalysis] — результат targetPageAnalyzer (если был)
 * @returns {Promise<object|null>} — { audience_personas, niche_deep_dive, content_voice, niche_terminology }
 */
async function analyzeAudienceAndNiche(task, ctx, extra = {}) {
  const { log, taskId, onTokens } = ctx;
  const { targetPageAnalysis = null } = extra;

  // Сводим всё, что уже знаем о ЦА и нише, в компактный текст.
  const knownAudienceParts = [];
  if (task.input_target_audience?.trim()) {
    knownAudienceParts.push(task.input_target_audience.trim());
  }
  if (targetPageAnalysis?.target_audience) {
    knownAudienceParts.push(`(из анализа страницы): ${targetPageAnalysis.target_audience}`);
  }
  const knownAudience = knownAudienceParts.join('\n').slice(0, MAX_KNOWN_FIELD_CHARS) || 'Нет данных';

  const knownNicheParts = [];
  if (task.input_niche_features?.trim()) {
    knownNicheParts.push(task.input_niche_features.trim());
  }
  if (targetPageAnalysis?.niche_features?.length) {
    knownNicheParts.push(`(из анализа страницы): ${
      Array.isArray(targetPageAnalysis.niche_features)
        ? targetPageAnalysis.niche_features.join('; ')
        : targetPageAnalysis.niche_features
    }`);
  }
  const knownNiche = knownNicheParts.join('\n').slice(0, MAX_KNOWN_FIELD_CHARS) || 'Нет данных';

  const brandFactsCompact = (task.input_brand_facts || 'Нет данных').slice(0, MAX_BRAND_FACTS_CHARS);

  const prompt = AUDIENCE_NICHE_PROMPT
    .replace('{{TARGET_SERVICE}}', task.input_target_service || 'Нет данных')
    .replace('{{BRAND_NAME}}',     task.input_brand_name     || 'Нет данных')
    .replace('{{BUSINESS_TYPE}}',  task.input_business_type  || 'не указано')
    .replace('{{REGION}}',         task.input_region         || 'Россия')
    .replace('{{BRAND_FACTS}}',    brandFactsCompact)
    .replace('{{KNOWN_AUDIENCE}}', knownAudience)
    .replace('{{KNOWN_NICHE}}',    knownNiche);

  log('Audience & Niche Analyzer: глубокий анализ ЦА и ниши...', 'info');

  try {
    const result = await callLLM(
      'deepseek',
      'Ты — стратег контент-маркетинга. Возвращай строго JSON по схеме.',
      prompt,
      {
        retries:     2,
        taskId,
        stageName:   'audience_niche_analysis',
        callLabel:   'Audience & Niche Deep Analysis',
        temperature: 0.4,
        log,
        onTokens,
      }
    );

    if (!result || typeof result !== 'object') {
      log('Audience & Niche Analyzer: некорректный JSON от LLM — пропускаем', 'warn');
      return null;
    }

    const personas = Array.isArray(result.audience_personas) ? result.audience_personas.length : 0;
    const insights = Array.isArray(result.niche_deep_dive)   ? result.niche_deep_dive.length   : 0;
    const terms    = Array.isArray(result.niche_terminology) ? result.niche_terminology.length : 0;

    log(
      `Audience & Niche Analyzer: персон ${personas}, инсайтов ниши ${insights}, ` +
      `терминов ${terms}, тон: ${result.content_voice?.tone || '—'}`,
      'success'
    );

    return result;
  } catch (err) {
    log(`Audience & Niche Analyzer: ошибка — ${err.message}`, 'warn');
    return null;
  }
}

module.exports = {
  analyzeAudienceAndNiche,
  serializeAnalysisForPrompt,
};
