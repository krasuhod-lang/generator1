'use strict';

const { callLLM }           = require('../llm/callLLM');
const { SYSTEM_PROMPTS }    = require('../../prompts/systemPrompts');
const { reAuditBlock }      = require('./stage4');
const { factCheck }         = require('../../utils/factCheck');
const { stripExpertBlockquotes } = require('../../utils/htmlSanitize');

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
 * Логика: hard-loop до PQ >= 8 (макс 3 итерации).
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
  expertOpinionUsed = false
) {
  const { log, taskId, onTokens } = ctx;

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts || 'Нет данных';

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

  let baseSpecialInstruction = '';
  if (waterPhrases.length)   baseSpecialInstruction += `ВОДА-ФРАЗЫ НАЙДЕНЫ: ${waterPhrases.join(', ')} — удали их. `;
  if (hallucinations.length) baseSpecialInstruction += `ГАЛЛЮЦИНАЦИИ: найдены цифры ${hallucinations.join(', ')} — удали их или перефразируй предложение без конкретных цифр. `;

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

  // ── Цикл PQ-рефайна (макс 3 итерации) ──────────────────────────
  const s5MaxLoops = 3;
  let s5Loop = 0;

  while (s5Loop < s5MaxLoops && currentPQ < 8) {
    s5Loop++;
    log(`Stage 5 блок ${blockIndex + 1}: рефайн итерация ${s5Loop}/${s5MaxLoops} (PQ ${currentPQ} < 8). Запрос...`, 'info');

    let specialInstruction = baseSpecialInstruction;
    if (expertOpinionUsed) {
      specialInstruction += ` КРИТИЧНО: PQ-score = ${currentPQ}/10. Нужно >= 8. НЕ ДОБАВЛЯЙ <blockquote> — экспертное мнение уже использовано в другом блоке статьи. Демонстрируй Expertise через конкретные данные, терминологию, H3-структуру. Устрани все проблемы из actionable_next_steps.`;
    } else {
      specialInstruction += ` КРИТИЧНО: PQ-score = ${currentPQ}/10. Нужно >= 8. Добавь экспертное мнение (blockquote), конкретные данные, H3-структуру. Устрани все проблемы из actionable_next_steps.`;
    }

    const s5Prompt = SYSTEM_PROMPTS.stage5
      .replace('{{TARGET_SERVICE}}',   () => targetService)
      .replace('{{CURRENT_H2}}',       () => h2)
      .replace('{{BRAND_FACTS}}',      () => brandFacts)
      .replace('{{ORIGINAL_HTML}}',    () => currentHTML)
      .replace('{{AUDIT_REPORT}}',     () => JSON.stringify(currentAudit))
      .replace('{{SPECIAL_INSTRUCTION}}', () => specialInstruction);

    const s5Result = await callLLM(
      'gemini',
      '',
      s5Prompt,
      { retries: 3, taskId, stageName: 'stage5', callLabel: `5 PQ Refine Block ${blockIndex + 1} iter ${s5Loop}`, temperature: 0.35, log, onTokens }
    ).catch(e => {
      log(`Stage 5 блок ${blockIndex + 1} итерация ${s5Loop} ОШИБКА: ${e.message}`, 'warn');
      return null;
    });

    if (s5Result?.html_content) {
      currentHTML = s5Result.html_content;
      log(`Stage 5 блок ${blockIndex + 1}: итерация ${s5Loop} — HTML ${currentHTML.length} символов. Повторный аудит...`, 'success');

      // Повторный аудит для проверки нового PQ (только если ещё есть итерации)
      if (s5Loop < s5MaxLoops) {
        try {
          const reAudit = await reAuditBlock(task, ctx, blockIndex, currentHTML, lsiMust);
          if (reAudit?.pqScore !== undefined) {
            currentPQ    = reAudit.pqScore;
            currentAudit = reAudit.auditResult;
            log(
              `Stage 5 блок ${blockIndex + 1}: повторный аудит — PQ ${currentPQ}`,
              currentPQ >= 8 ? 'success' : 'warn'
            );
          }
        } catch (e) {
          log(`Stage 5 блок ${blockIndex + 1}: повторный аудит ошибка — ${e.message}`, 'warn');
          break;
        }
      }
    } else {
      log(`Stage 5 блок ${blockIndex + 1}: html_content не получен (итерация ${s5Loop}). Ключи: [${Object.keys(s5Result || {}).join(', ')}]`, 'warn');
      break;
    }
  }

  if (currentPQ >= 8) {
    log(`Stage 5 блок ${blockIndex + 1}: PQ ${currentPQ} >= 8 ✓ (${s5Loop} итераций)`, 'success');
  } else {
    log(`Stage 5 блок ${blockIndex + 1}: PQ ${currentPQ} после ${s5Loop} итераций — продолжаем с лучшим результатом`, 'warn');
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
        .replace('{{BRAND_FACTS}}',         () => brandFacts)
        .replace('{{ORIGINAL_HTML}}',       () => currentHTML)
        .replace('{{AUDIT_REPORT}}',        () => '{"mathematical_audit":{"spam_risk_detected":false,"lsi_coverage_percent":85},"pq_score":8,"actionable_next_steps":[]}')
        .replace('{{SPECIAL_INSTRUCTION}}', () => tfInstruction);

      const tfResult = await callLLM(
        'gemini',
        '',
        tfPrompt,
        { retries: 2, taskId, stageName: 'stage5', callLabel: `5 TF-IDF Fix Block ${blockIndex + 1}`, temperature: 0.2, log, onTokens }
      ).catch(() => null);

      if (tfResult?.html_content) currentHTML = tfResult.html_content;
    }
  }

  return { html: currentHTML, pqScore: currentPQ, auditLog: currentAudit };
}

module.exports = { runStage5, checkAntiWater, STOP_PHRASES };
