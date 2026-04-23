'use strict';

const { callLLM }           = require('../llm/callLLM');
const { SYSTEM_PROMPTS }    = require('../../prompts/systemPrompts');
const { reAuditBlock }      = require('./stage4');
const { factCheck, computeConfidence } = require('../../utils/factCheck');
const { stripExpertBlockquotes } = require('../../utils/htmlSanitize');
const { runNaturalnessChecks }   = require('../../utils/naturalnessCheck');
const { geminiCallOpts, akbSystem, llmProvider } = require('../../utils/articleKnowledgeBase');
const { EEAT_PQ_TARGET } = require('../../utils/objectiveMetrics');

/**
 * STOP_PHRASES — фразы-маркеры "воды".
 * Источник: v3.1 index.html (СТРОГО НЕТРОНУТО).
 */
const STOP_PHRASES = [
  // Оригинальные (v3.1)
  'В современном мире',
  'В наше время',
  'Ни для кого не секрет',
  'Важно отметить',
  'Стоит учитывать',
  'Следует подчеркнуть',
  'Необходимо понимать',
  'Как мы видим',
  'Таким образом',
  'Подводя итог',
  'В заключение',
  'Нельзя отрицать',
  'Идеальный',
  'Безупречный',
  'Высококачественный',
  'Инновационный',
  'в рамках данной статьи',
  'мы детально разбираем',
  'включая такой город как',
  'включая такие города как',
  'как уже упоминалось',
  'если у вас возникают уточняющие вопросы',
  // Расширение: Яндекс.Баден-Баден / Google HCU маркеры AI-воды
  'На сегодняшний день',
  'В настоящее время',
  'Не является секретом',
  'Очевидно, что',
  'Как известно',
  'В целом можно сказать',
  'Стоит отметить',
  'Нельзя не отметить',
  'Как показывает практика',
  'С каждым годом',
  'Всё больше и больше',
  'Играет важную роль',
  'Является неотъемлемой частью',
  'Широкий спектр',
  'Индивидуальный подход',
  'Оптимальное решение',
  'Комплексный подход',
  'Профессиональная команда',
  'Многолетний опыт',
  'Высокий уровень сервиса',
  'Не секрет, что',
  'Всем известно',
];

/**
 * checkAntiWater — ищет stop-фразы в HTML-тексте блока.
 * @param {string} html
 * @returns {string[]} — найденные нежелательные фразы
 */
function checkAntiWater(html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  return STOP_PHRASES.filter(phrase =>
    text.toLowerCase().includes(phrase.toLowerCase())
  );
}

/**
 * Stage 5: Доработка (PQ-рефайн) одного блока.
 * Адаптер: gemini.
 * Логика: hard-loop до PQ >= EEAT_PQ_TARGET (макс 3 итерации).
 *
 * @param {object}   task          — строка tasks из БД
 * @param {object}   ctx           — { log, taskId }
 * @param {number}   blockIndex    — индекс блока
 * @param {string}   htmlContent   — исходный HTML блока
 * @param {string[]} lsiMust       — обязательные LSI
 * @param {object}   auditResult   — результат Stage 4
 * @param {number}   pqScore       — текущий PQ score
 * @param {object[]} competitorFacts — массив фактов из Stage 0
 * @param {string}   h2            — заголовок блока
 * @returns {{ html: string, pqScore: number, auditLog: object }}
 */
async function runStage5(
  task, ctx,
  blockIndex, htmlContent, lsiMust,
  auditResult, pqScore,
  competitorFacts = [], h2 = '',
  expertOpinionUsed = false,
  blockCharLimits = null
) {
  const { log, taskId, onTokens } = ctx;

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts || 'Нет данных';
  const brandName     = (task.input_brand_name || '').trim() || 'Нет данных';

  let currentHTML  = htmlContent;
  let currentPQ    = pqScore;
  let currentAudit = auditResult;

  // Проверяем anti-water и галлюцинации
  const waterPhrases   = checkAntiWater(currentHTML);
  const hallucinations = factCheck(
    currentHTML,
    competitorFacts.map(f => f.fact || f),
    brandFacts,
    task.input_raw_lsi || ''
  );

  // Naturalness checks: роботизированность, тавтологии, SEO-хвосты, переспам ключа.
  const naturalness = runNaturalnessChecks(currentHTML, { mainQuery: targetService });
  if (!naturalness.passed) {
    log(
      `Stage 5 блок ${blockIndex + 1}: NATURALNESS issues — ${naturalness.issues.join(' | ')}`,
      'warn'
    );
  }

  let baseSpecialInstruction = '';
  if (waterPhrases.length)   baseSpecialInstruction += `ВОДА-ФРАЗЫ НАЙДЕНЫ: ${waterPhrases.join(', ')} — удали их. `;
  if (hallucinations.length) baseSpecialInstruction += `ГАЛЛЮЦИНАЦИИ: найдены цифры ${hallucinations.join(', ')} — удали их или перефразируй предложение без конкретных цифр. `;
  if (naturalness.instructionFragment) {
    baseSpecialInstruction += `\n${naturalness.instructionFragment}\n`;
  }

  // NON-NEGOTIABLE safety rules (наследуются из Stage 3)
  baseSpecialInstruction += `
NON-NEGOTIABLE RULES (нарушение = брак):
- 100% BAN на <a> ссылки — НЕ ДОБАВЛЯЙ тег <a> ни при каких условиях.
- STOP-WORDS BAN: НЕ используй фразы: "В современном мире", "Важно отметить", "Стоит учитывать", "Как показывает практика", "На сегодняшний день", "Широкий спектр", "Индивидуальный подход", "Комплексный подход", "Высокий уровень сервиса".
- ANTI-GEO-SPAM: НЕ вставляй списки городов через запятую.
- НЕ добавляй резюмирующий абзац "Таким образом...", "В заключение...", "Подводя итог...".
- НЕ выдумывай числа, цены, сроки — если данных нет, перефразируй без конкретных цифр или удали предложение. НИКОГДА не выводи текст "[NO_DATA]".
- Разрешённые HTML-теги: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <blockquote>.
`;

  // ── Length-preservation guardrail (per-block char limits ±20%) ─────
  // Без этого Stage 5 раздувает блоки в 3-4 раза при рефайне.
  if (blockCharLimits) {
    const minAllowed = Math.round(blockCharLimits.minChars * 0.8);
    const maxAllowed = Math.round(blockCharLimits.maxChars * 1.2);
    baseSpecialInstruction += `
LENGTH CONTROL (КРИТИЧНО — нарушение = откат итерации):
- Целевой объём блока: ${blockCharLimits.minChars}–${blockCharLimits.maxChars} символов чистого текста.
- Допустимый коридор: ${minAllowed}–${maxAllowed} символов (±20%).
- НЕ раздувай блок: рефайн = точечная правка проблемных мест, а не переписывание с нуля.
- Сохраняй существующие H3, абзацы и их объём. Добавляй новый текст ТОЛЬКО там, где это нужно для устранения issues из AUDIT_REPORT.
- Если для устранения issue нужно добавить материал — компенсируй удалением воды/повторов в других местах блока.
`;
  }

  const maxAllowedChars = blockCharLimits
    ? Math.round(blockCharLimits.maxChars * 1.2)
    : Infinity;

  // ── Цикл PQ-рефайна (макс 3 итерации) ──────────────────────────
  // Запускается, если PQ < EEAT_PQ_TARGET ИЛИ обнаружены naturalness-issues
  // (роботизированность / тавтологии / SEO-хвосты / переспам ключа).
  const s5MaxLoops = 3;
  let s5Loop = 0;
  let needsRefine = currentPQ < EEAT_PQ_TARGET || !naturalness.passed;

  while (s5Loop < s5MaxLoops && needsRefine) {
    s5Loop++;
    log(`Stage 5 блок ${blockIndex + 1}: рефайн итерация ${s5Loop}/${s5MaxLoops} (PQ ${currentPQ} < ${EEAT_PQ_TARGET}). Запрос...`, 'info');

    let specialInstruction = baseSpecialInstruction;
    if (expertOpinionUsed) {
      specialInstruction += ` КРИТИЧНО: PQ-score = ${currentPQ}/10. Нужно >= ${EEAT_PQ_TARGET}. НЕ ДОБАВЛЯЙ <blockquote> — экспертное мнение уже использовано в другом блоке статьи. Демонстрируй Expertise через конкретные данные, терминологию, H3-структуру. Устрани все проблемы из actionable_next_steps.`;
    } else {
      specialInstruction += ` КРИТИЧНО: PQ-score = ${currentPQ}/10. Нужно >= ${EEAT_PQ_TARGET}. Добавь экспертное мнение (blockquote), конкретные данные, H3-структуру. Устрани все проблемы из actionable_next_steps.`;
    }

    const akbReady = !!task.__articleKnowledgeBase;
    const s5Prompt = SYSTEM_PROMPTS.stage5
      .replace('{{TARGET_SERVICE}}',   () => targetService)
      .replace('{{CURRENT_H2}}',       () => h2)
      .replace(/\{\{BRAND_NAME\}\}/g,  () => brandName)
      .replace('{{BRAND_FACTS}}',      () => akbReady ? '[См. ARTICLE KNOWLEDGE BASE → §1 Brand & Offer]' : brandFacts)
      .replace('{{ORIGINAL_HTML}}',    () => currentHTML)
      .replace('{{AUDIT_REPORT}}',     () => JSON.stringify(currentAudit))
      .replace('{{SPECIAL_INSTRUCTION}}', () => specialInstruction);

    const s5Result = await callLLM(
      llmProvider(task),
      akbSystem(task),
      s5Prompt,
      geminiCallOpts(task, { retries: 3, taskId, stageName: 'stage5', callLabel: `5 PQ Refine Block ${blockIndex + 1} iter ${s5Loop}`, temperature: 0.35, log, onTokens })
    ).catch(e => {
      log(`Stage 5 блок ${blockIndex + 1} итерация ${s5Loop} ОШИБКА: ${e.message}`, 'warn');
      return null;
    });

    if (s5Result?.html_content) {
      // Length guard: если итерация раздула HTML за допустимый коридор —
      // отвергаем результат и оставляем предыдущий best-so-far.
      // Без этого Stage 5 раздувает блок в 3-4 раза за 1 итерацию (см. логи: 2177 → 7523).
      if (s5Result.html_content.length > maxAllowedChars) {
        log(
          `Stage 5 блок ${blockIndex + 1}: итерация ${s5Loop} ОТКЛОНЕНА — ` +
          `HTML ${s5Result.html_content.length} символов > лимит ${maxAllowedChars} (cap = blockMax×1.2). ` +
          `Оставляем предыдущий HTML (${currentHTML.length} символов).`,
          'warn'
        );
        break;
      }
      currentHTML = s5Result.html_content;
      log(`Stage 5 блок ${blockIndex + 1}: итерация ${s5Loop} — HTML ${currentHTML.length} символов. Повторный аудит...`, 'success');

      // Повторная проверка naturalness после рефайна (без LLM-вызова, мгновенно)
      const naturalness2 = runNaturalnessChecks(currentHTML, { mainQuery: targetService });
      if (!naturalness2.passed) {
        // Обновляем подсказку на новые остаточные issues
        baseSpecialInstruction = baseSpecialInstruction
          .replace(/\nРОБОТИЗИРОВАННОСТЬ:[\s\S]*?(?=\n[А-Я]|$)/g, '')
          .replace(/\nТАВТОЛОГИИ:[\s\S]*?(?=\n[А-Я]|$)/g, '')
          .replace(/\nSEO-ХВОСТЫ:[\s\S]*?(?=\n[А-Я]|$)/g, '')
          .replace(/\nПЕРЕСПАМ КЛЮЧА:[\s\S]*?(?=\n[А-Я]|$)/g, '');
        if (naturalness2.instructionFragment) {
          baseSpecialInstruction += `\n${naturalness2.instructionFragment}\n`;
        }
      }

      // Повторный аудит для проверки нового PQ (только если ещё есть итерации)
      if (s5Loop < s5MaxLoops) {
        try {
          const reAudit = await reAuditBlock(task, ctx, blockIndex, currentHTML, lsiMust);
          if (reAudit?.pqScore !== undefined) {
            currentPQ    = reAudit.pqScore;
            currentAudit = reAudit.auditResult;
            log(
              `Stage 5 блок ${blockIndex + 1}: повторный аудит — PQ ${currentPQ}`,
              currentPQ >= EEAT_PQ_TARGET ? 'success' : 'warn'
            );
          }
        } catch (e) {
          log(`Stage 5 блок ${blockIndex + 1}: повторный аудит ошибка — ${e.message}`, 'warn');
          break;
        }
      }
      // Решаем, нужна ли ещё итерация
      needsRefine = currentPQ < EEAT_PQ_TARGET || !naturalness2.passed;
    } else {
      log(`Stage 5 блок ${blockIndex + 1}: html_content не получен (итерация ${s5Loop}). Ключи: [${Object.keys(s5Result || {}).join(', ')}]`, 'warn');
      break;
    }
  }

  if (currentPQ >= EEAT_PQ_TARGET) {
    log(`Stage 5 блок ${blockIndex + 1}: PQ ${currentPQ} >= ${EEAT_PQ_TARGET} ✓ (${s5Loop} итераций)`, 'success');
  } else {
    log(`Stage 5 блок ${blockIndex + 1}: PQ ${currentPQ} после ${s5Loop} итераций — продолжаем с лучшим результатом`, 'warn');
  }

  // ── Logprob confidence check (DeepSeek only) ──────────────────────
  if (currentHTML.__logprobs) {
    const confidence = computeConfidence(currentHTML.__logprobs, currentHTML);
    if (confidence.lowConfidenceCount > 0) {
      log(`Блок ${blockIndex + 1}: ${confidence.lowConfidenceCount} абзацев с низкой уверенностью — перезапись...`, 'warn');
      const lowConfParagraphs = confidence.paragraphs
        .filter(p => !p.confident)
        .map(p => `Абзац ${p.index + 1}: "${p.text}..." (mean_logprob: ${p.meanLogprob})`)
        .join('\n');

      const confInstruction = `Следующие абзацы содержат потенциально недостоверные утверждения (модель ИИ не уверена в их точности). Перепиши их, используя ТОЛЬКО подтверждённые факты из BRAND_FACTS. Если факт невозможно подтвердить — перефразируй без конкретных данных:\n${lowConfParagraphs}`;

      const confPrompt = SYSTEM_PROMPTS.stage5
        .replace('{{TARGET_SERVICE}}',      () => targetService)
        .replace('{{CURRENT_H2}}',          () => h2)
        .replace(/\{\{BRAND_NAME\}\}/g,     () => brandName)
        .replace('{{BRAND_FACTS}}',         () => task.__articleKnowledgeBase ? '[См. ARTICLE KNOWLEDGE BASE → §1 Brand & Offer]' : brandFacts)
        .replace('{{ORIGINAL_HTML}}',       () => currentHTML)
        .replace('{{AUDIT_REPORT}}',        () => JSON.stringify(currentAudit || {}))
        .replace('{{SPECIAL_INSTRUCTION}}', () => confInstruction);

      const confResult = await callLLM(
        llmProvider(task),
        akbSystem(task),
        confPrompt,
        geminiCallOpts(task, { retries: 2, taskId, stageName: 'stage5', callLabel: `5 Confidence Fix Block ${blockIndex + 1}`, temperature: 0.3, log, onTokens })
      ).catch(() => null);

      if (confResult?.html_content) {
        currentHTML = confResult.html_content;
        log(`Блок ${blockIndex + 1}: low-confidence абзацы переписаны`, 'success');
      }
    }
  }

  // ── Enforce single expert opinion: strip blockquotes if already used ──
  if (expertOpinionUsed && /<blockquote[\s>]/i.test(currentHTML)) {
    log(`Stage 5 блок ${blockIndex + 1}: экспертное мнение уже использовано — удаляем лишний blockquote после рефайна`, 'warn');
    currentHTML = stripExpertBlockquotes(currentHTML);
  }

  // ── TF-IDF overuse check ────────────────────────────────────────
  let tfIdfArr = [];
  try { tfIdfArr = JSON.parse(task.input_tfidf_json || '[]'); } catch { /* ignore */ }

  for (const item of tfIdfArr) {
    if (!item.term || !item.rangeMax) continue;
    const re    = new RegExp(item.term, 'gi');
    const count = (currentHTML.match(re) || []).length;
    if (count > item.rangeMax * 1.15) {
      log(`Блок ${blockIndex + 1}: TF-IDF превышение для '${item.term}' (${count} > ${item.rangeMax}). Запуск Stage 5 fix...`, 'warn');
      const tfInstruction = `Удали 2 вхождения слова "${item.term}" — оно используется ${count} раз, максимум ${item.rangeMax}.`;
      const tfPrompt = SYSTEM_PROMPTS.stage5
        .replace('{{TARGET_SERVICE}}',      () => targetService)
        .replace('{{CURRENT_H2}}',          () => h2)
        .replace(/\{\{BRAND_NAME\}\}/g,     () => brandName)
        .replace('{{BRAND_FACTS}}',         () => task.__articleKnowledgeBase ? '[См. ARTICLE KNOWLEDGE BASE → §1 Brand & Offer]' : brandFacts)
        .replace('{{ORIGINAL_HTML}}',       () => currentHTML)
        .replace('{{AUDIT_REPORT}}',        () => '{"mathematical_audit":{"spam_risk_detected":false,"lsi_coverage_percent":85},"pq_score":8,"actionable_next_steps":[]}')
        .replace('{{SPECIAL_INSTRUCTION}}', () => tfInstruction);

      const tfResult = await callLLM(
        llmProvider(task),
        akbSystem(task),
        tfPrompt,
        geminiCallOpts(task, { retries: 2, taskId, stageName: 'stage5', callLabel: `5 TF-IDF Fix Block ${blockIndex + 1}`, temperature: 0.2, log, onTokens })
      ).catch(() => null);

      if (tfResult?.html_content) currentHTML = tfResult.html_content;
    }
  }

  return { html: currentHTML, pqScore: currentPQ, auditLog: currentAudit };
}

module.exports = { runStage5, checkAntiWater, STOP_PHRASES };
