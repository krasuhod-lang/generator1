'use strict';

const { callLLM }              = require('../llm/callLLM');
const { SYSTEM_PROMPTS }       = require('../../prompts/systemPrompts');
const { calculateCoverage }    = require('../../utils/calculateCoverage');
const { computeSemanticCoverage } = require('../../utils/semanticSimilarity');
const { LSI_COVERAGE_TARGET }  = require('../../utils/objectiveMetrics');
const { geminiCallOpts, akbSystem, llmProvider } = require('../../utils/articleKnowledgeBase');
const { STYLE_GROUNDING_CONTRACT } = require('../../utils/styleGroundingContract');
const { DOCTOR_MAX_WRITER_CONTRACT } = require('../../utils/doctorMaxWriterContract');

/**
 * Stage 6: Инъекция LSI — цикл до достижения LSI_COVERAGE_TARGET (≥ 80%),
 * максимум 3 итерации. Адаптер: gemini.
 *
 * Улучшение: Гибридный поиск — используем семантическое сходство
 * для определения лучшего параграфа для инъекции каждого термина.
 * Это позволяет модели органично встраивать LSI-фразы.
 *
 * @param {object}   task          — строка tasks из БД
 * @param {object}   ctx           — { log, taskId }
 * @param {number}   blockIndex    — индекс блока
 * @param {string}   htmlContent   — HTML блока после Stage 5
 * @param {string[]} lsiMust       — обязательные LSI для этого блока
 * @param {object}   [blockCharLimits] { minChars, maxChars } — per-block лимиты;
 *   при инъекции HTML не должен превышать maxChars*1.5, иначе результат отвергается.
 * @returns {{ html: string, lsiCoverage: number, finalCoverage: object }}
 */
async function runStage6(task, ctx, blockIndex, htmlContent, lsiMust, blockCharLimits = null) {
  const { log, taskId, onTokens } = ctx;

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts || 'Нет данных';
  const brandName     = (task.input_brand_name || '').trim() || 'Нет данных';

  let currentHTML = htmlContent;
  let bestHTML = htmlContent;
  let bestCoverage = calculateCoverage(htmlContent, lsiMust);
  let loopCount   = 0;
  let budgetSkipped = false;
  const configuredLoops = parseInt(process.env.SEO_STAGE6_MAX_LOOPS, 10);
  const maxLoops  = Number.isFinite(configuredLoops) && configuredLoops >= 1
    ? Math.min(3, configuredLoops)
    : 3;
  const configuredGain = Number(process.env.SEO_STAGE6_MIN_COVERAGE_GAIN_PCT);
  const minCoverageGain = Number.isFinite(configuredGain) && configuredGain >= 0
    ? configuredGain
    : 2;

  // Length guard: LSI-инъекция должна быть микро-вставкой. Если итерация
  // увеличивает HTML > 1.5× от исходного ИЛИ выходит за blockMax×1.5 —
  // отвергаем результат и оставляем pre-injection HTML.
  const startLength    = htmlContent.length;
  const expansionCap   = Math.round(startLength * 1.5);
  const absoluteCap    = blockCharLimits
    ? Math.round(blockCharLimits.maxChars * 1.5)
    : Infinity;
  const maxAllowedChars = Math.min(expansionCap, absoluteCap);

  while (loopCount < maxLoops) {
    loopCount++;

    const coverage = calculateCoverage(currentHTML, lsiMust);

    if (coverage.percent >= LSI_COVERAGE_TARGET || coverage.missing.length === 0) {
      log(
        `Блок ${blockIndex + 1}: LSI ${coverage.percent}% ≥ ${LSI_COVERAGE_TARGET}% — целевой порог достигнут (цикл ${loopCount})`,
        'success'
      );
      return { html: currentHTML, lsiCoverage: coverage.percent, finalCoverage: coverage };
    }

    log(`Блок ${blockIndex + 1}: LSI ${coverage.percent}% — инъекция (цикл ${loopCount}/${maxLoops})...`, 'warn');

    // ── Гибридный поиск: семантический анализ для organic placement ──
    // Вычисляем семантическое сходство пропущенных терминов с параграфами
    const semanticData = computeSemanticCoverage(currentHTML, coverage.missing);

    // Формируем список для инъекции с семантическими подсказками
    const injectList = coverage.missing.map(w => {
      const hint = semanticData.paragraphHints.find(h => h.term === w);
      return {
        слово: w,
        внедрить_раз: 1,
        // Подсказка для Gemini: куда семантически лучше всего вставить
        ...(hint && hint.similarity > 0.1
          ? { semantic_hint: `best fit near paragraph #${hint.bestParagraphIndex} (similarity: ${hint.similarity})` }
          : {}),
      };
    });

    const stage6Prompt = SYSTEM_PROMPTS.stage6
      .replace('{{CURRENT_HTML}}',  () => currentHTML)
      .replace('{{MISSING_LSI}}',   () => JSON.stringify(injectList))
      .replace('{{TARGET_SERVICE}}',() => targetService)
      .replace(/\{\{BRAND_NAME\}\}/g, () => brandName)
      .replace('{{BRAND_FACTS}}',   () => task.__articleKnowledgeBase ? '[См. ARTICLE KNOWLEDGE BASE → §1 Brand & Offer]' : brandFacts)
      + STYLE_GROUNDING_CONTRACT
      + DOCTOR_MAX_WRITER_CONTRACT;

    log(
      `Stage 6 блок ${blockIndex + 1}: инъекция LSI цикл ${loopCount} — ` +
      `${coverage.missing.length} пропущенных слов (${semanticData.semanticallyCovered.length} семантически покрыты, BM25+TF-IDF hybrid), ` +
      `промпт ${stage6Prompt.length} символов...`,
      'info'
    );

    const stage6Result = await callLLM(
      llmProvider(task),
      akbSystem(task, { purpose: 'repair' }),
      stage6Prompt,
      geminiCallOpts(task, { retries: 1, repairOnJsonError: true, repairMaxTokens: 8192, maxTokens: 12288, maxTruncationTokens: 16384, taskId, stageName: 'stage6', callLabel: `6 LSI Inject Block ${blockIndex + 1} cycle ${loopCount}`, temperature: 0.2, log, onTokens, skipOnBudget: true })
    ).catch(e => {
      if (e?.isBudgetExceeded || /gemini token budget exhausted/i.test(String(e?.message || ''))) {
        budgetSkipped = true;
        log(`Stage 6 блок ${blockIndex + 1}: budget_skip — LSI-инъекция пропущена, сохраняем лучший HTML`, 'info');
      } else {
        log(`Stage 6 блок ${blockIndex + 1} цикл ${loopCount} ОШИБКА: ${e.message}`, 'warn');
      }
      return null;
    });

    if (stage6Result?.html_content) {
      // Length guard: отвергаем итерацию, если LSI-инъекция раздула HTML.
      // (LSI-injection — это микро-правка, а не переписывание.)
      if (stage6Result.html_content.length > maxAllowedChars) {
        log(
          `Stage 6 блок ${blockIndex + 1}: цикл ${loopCount} ОТКЛОНЁН — ` +
          `HTML ${stage6Result.html_content.length} символов > лимит ${maxAllowedChars} ` +
          `(start=${startLength}, cap=min(start×1.5, blockMax×1.5)). ` +
          `Оставляем HTML до инъекции (${currentHTML.length} символов).`,
          'warn'
        );
        break;
      }
      const candidateHTML = stage6Result.html_content;
      const nextCoverage = calculateCoverage(candidateHTML, lsiMust);
      const coverageGain = nextCoverage.percent - coverage.percent;
      if (nextCoverage.percent <= coverage.percent) {
        currentHTML = bestHTML;
        log(
          `Stage 6 блок ${blockIndex + 1}: кандидат отклонён — coverage ${coverage.percent}% → ${nextCoverage.percent}% без положительного прироста; сохранён best-so-far`,
          'warn'
        );
        break;
      }
      currentHTML = candidateHTML;
      if (nextCoverage.percent > bestCoverage.percent) {
        bestHTML = currentHTML;
        bestCoverage = nextCoverage;
      }
      log(
        `Stage 6 блок ${blockIndex + 1}: цикл ${loopCount} завершён, `
        + `HTML ${currentHTML.length} символов, coverage ${coverage.percent}% → ${nextCoverage.percent}% `
        + `(gain ${coverageGain.toFixed(1)} п.п.)`,
        'success'
      );
      // Если модель не добавила покрытие либо прирост уже ниже порога,
      // следующий полный Gemini rewrite обычно даёт только стоимость и
      // риск раздувания текста. Оставляем best-so-far; env позволяет
      // отключить эвристику значением 0 или сделать её строже.
      if (
        nextCoverage.percent < LSI_COVERAGE_TARGET
        && nextCoverage.missing.length > 0
        && coverageGain < minCoverageGain
      ) {
        log(
          `Stage 6 блок ${blockIndex + 1}: ранний выход — прирост coverage `
          + `${coverageGain.toFixed(1)} п.п. < ${minCoverageGain} п.п.`,
          'info'
        );
        break;
      }
    } else {
      log(`Stage 6 блок ${blockIndex + 1}: цикл ${loopCount} — html_content не получен. Прерываем цикл.`, 'warn');
      break;
    }
  }

  // Финальное измерение покрытия: никогда не возвращаем rewrite хуже best-so-far.
  const finalBeforeRollback = calculateCoverage(currentHTML, lsiMust);
  if (finalBeforeRollback.percent < bestCoverage.percent) {
    currentHTML = bestHTML;
  }
  const finalCoverage = calculateCoverage(currentHTML, lsiMust);
  log(
    `Блок ${blockIndex + 1} — финальное LSI покрытие: ${finalCoverage.percent}% ` +
    `(цель ≥ ${LSI_COVERAGE_TARGET}%)`,
    finalCoverage.percent >= LSI_COVERAGE_TARGET ? 'success' : 'warn'
  );

  return {
    html:          currentHTML,
    lsiCoverage:  finalCoverage.percent,
    finalCoverage,
    budgetSkipped,
  };
}

module.exports = { runStage6 };
