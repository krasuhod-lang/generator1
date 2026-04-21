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

const AUDIENCE_NICHE_PROMPT = `Ты — стратег контент-маркетинга, эксперт по customer research и нишевой аналитике. Твоя задача — провести ГЛУБОКИЙ анализ целевой аудитории и ниши на основе предоставленных данных. От качества этого анализа зависит ВСЯ дальнейшая генерация контента.

═══════════════════════════════════════════
ВХОДНЫЕ ДАННЫЕ
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

1. AUDIENCE_PERSONAS (2-4 ПЕРСОНЫ): Не «широкая аудитория», а конкретные сегменты.
   Для КАЖДОЙ персоны:
   • name              — короткое название сегмента («Семья с детьми 5-12 лет», «Молодая пара 25-30», «Корпоративный клиент»)
   • demographics      — возраст, доход, география, статус (1 предложение)
   • jobs_to_be_done   — какую «работу» персона нанимает услугу/продукт выполнить (по фреймворку JTBD: «когда [ситуация], я хочу [результат], чтобы [глубинная мотивация]»)
   • pains             — 2-4 конкретные боли/страха/триггера (массив строк, без воды)
   • objections        — 2-4 типичных возражения, которые надо снять в тексте (массив строк)
   • decision_criteria — 2-4 критерия выбора (цена / скорость / рейтинг / гарантия / опыт компании / ...)
   • content_triggers  — какие фразы / факты / форматы (отзыв / кейс / список / таблица цен) РЕЗОНИРУЮТ с этой персоной
   • voice_examples    — 2-3 примера, КАК эта персона сама формулирует свой запрос (живой разговорный язык, не маркетинговый)

2. NICHE_DEEP_DIVE (4-6 ИНСАЙТОВ ниши): Глубже стандартного описания.
   Для КАЖДОГО инсайта:
   • theme    — короткое название («Сезонность спроса», «YMYL-риски», «Trust-коды отрасли», «Типичные подводные камни», «Жаргон ниши», «Региональная специфика»)
   • insight  — РАЗВЁРНУТОЕ описание (2-4 предложения): что именно отличает эту нишу, что важно учитывать копирайтеру
   • content_implication — конкретное правило для текста: «использовать X», «избегать Y», «обязательно упомянуть Z»

3. CONTENT_VOICE — описание оптимального тона/стиля для этой ниши и аудитории:
   • tone               — основной тон (экспертный / дружеский / сенсорный-эмоциональный / деловой / ...)
   • emotional_register — какие эмоции должны вызывать тексты (доверие / восторг / спокойствие / срочность)
   • sensory_focus      — для каких ниш важна сенсорика (туризм/HoReCa/lifestyle = да: запахи, вкусы, атмосфера; B2B/SaaS = нет: цифры, кейсы, метрики)
   • forbidden_voice    — каких интонаций избегать (официоз / «вода» / агрессивный sales / wikipedia-стиль)

4. NICHE_TERMINOLOGY — массив 5-10 специфических терминов/жаргонизмов ниши, которые должны звучать в тексте для демонстрации экспертности (массив строк).

═══════════════════════════════════════════
ПРАВИЛА (СТРОГО)
═══════════════════════════════════════════
• ОПИРАЙСЯ на входные данные, но РАСКРЫВАЙ их глубже на основе общих знаний о нише.
• Если данных мало — используй типичные паттерны для указанной BUSINESS_TYPE и TARGET_SERVICE (это анализ, не извлечение фактов).
• НЕ выдумывай конкретные цифры / цены / гарантии бренда (это для генерации, не для анализа).
• Все описания РАЗВЁРНУТЫЕ, а не однословные.
• СТРОГО JSON, без markdown, без обёрток.

═══════════════════════════════════════════
СТРУКТУРА ОТВЕТА
═══════════════════════════════════════════
{
  "audience_personas": [
    {
      "name": "...",
      "demographics": "...",
      "jobs_to_be_done": "...",
      "pains": ["...", "..."],
      "objections": ["...", "..."],
      "decision_criteria": ["...", "..."],
      "content_triggers": ["...", "..."],
      "voice_examples": ["...", "..."]
    }
  ],
  "niche_deep_dive": [
    {
      "theme": "...",
      "insight": "...",
      "content_implication": "..."
    }
  ],
  "content_voice": {
    "tone": "...",
    "emotional_register": "...",
    "sensory_focus": true,
    "forbidden_voice": ["...", "..."]
  },
  "niche_terminology": ["...", "..."]
}

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
  if (p.jobs_to_be_done) lines.push(`  JTBD: ${p.jobs_to_be_done}`);
  if (Array.isArray(p.pains) && p.pains.length)
    lines.push(`  Боли: ${p.pains.join('; ')}`);
  if (Array.isArray(p.objections) && p.objections.length)
    lines.push(`  Возражения: ${p.objections.join('; ')}`);
  if (Array.isArray(p.decision_criteria) && p.decision_criteria.length)
    lines.push(`  Критерии решения: ${p.decision_criteria.join('; ')}`);
  if (Array.isArray(p.content_triggers) && p.content_triggers.length)
    lines.push(`  Контент-триггеры: ${p.content_triggers.join('; ')}`);
  if (Array.isArray(p.voice_examples) && p.voice_examples.length)
    lines.push(`  Голос ЦА: «${p.voice_examples.join('», «')}»`);
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
  const knownAudience = knownAudienceParts.join('\n').slice(0, 2500) || 'Нет данных';

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
  const knownNiche = knownNicheParts.join('\n').slice(0, 2500) || 'Нет данных';

  const brandFactsCompact = (task.input_brand_facts || 'Нет данных').slice(0, 2000);

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
