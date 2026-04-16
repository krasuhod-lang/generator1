'use strict';

const { callLLM }              = require('../llm/callLLM');
const { SYSTEM_PROMPTS }       = require('../../prompts/systemPrompts');
const { calculateCoverage }    = require('../../utils/calculateCoverage');

/**
 * Stage 6: Инъекция LSI — цикл до 100% покрытия (максимум 3 итерации).
 * Адаптер: gemini.
 *
 * @param {object}   task          — строка tasks из БД
 * @param {object}   ctx           — { log, taskId }
 * @param {number}   blockIndex    — индекс блока
 * @param {string}   htmlContent   — HTML блока после Stage 5
 * @param {string[]} lsiMust       — обязательные LSI для этого блока
 * @returns {{ html: string, lsiCoverage: number, finalCoverage: object }}
 */
async function runStage6(task, ctx, blockIndex, htmlContent, lsiMust) {
  const { log, taskId, onTokens } = ctx;

  const targetService = task.input_target_service;
  const brandFacts    = task.input_brand_facts || 'Нет данных';

  let currentHTML = htmlContent;
  let loopCount   = 0;
  const maxLoops  = 3;

  while (loopCount < maxLoops) {
    loopCount++;

    const coverage = calculateCoverage(currentHTML, lsiMust);

    if (coverage.percent >= 100 || coverage.missing.length === 0) {
      log(`Блок ${blockIndex + 1}: 100% LSI покрытие достигнуто (цикл ${loopCount})`, 'success');
      return { html: currentHTML, lsiCoverage: coverage.percent, finalCoverage: coverage };
    }

    log(`Блок ${blockIndex + 1}: LSI ${coverage.percent}% — инъекция (цикл ${loopCount}/${maxLoops})...`, 'warn');

    // Формируем список для инъекции — каждое пропущенное слово по 1 разу
    const injectList = coverage.missing.map(w => ({
      слово: w,
      внедрить_раз: 1,
    }));

    const stage6Prompt = SYSTEM_PROMPTS.stage6
      .replace('{{CURRENT_HTML}}',  () => currentHTML)
      .replace('{{MISSING_LSI}}',   () => JSON.stringify(injectList))
      .replace('{{TARGET_SERVICE}}',() => targetService)
      .replace('{{BRAND_FACTS}}',   () => brandFacts);

    log(
      `Stage 6 блок ${blockIndex + 1}: инъекция LSI цикл ${loopCount} — ` +
      `${coverage.missing.length} пропущенных слов, промпт ${stage6Prompt.length} символов...`,
      'info'
    );

    const stage6Result = await callLLM(
      'gemini',
      '',
      stage6Prompt,
      { retries: 3, taskId, stageName: 'stage6', callLabel: `6 LSI Inject Block ${blockIndex + 1} cycle ${loopCount}`, log, onTokens }
    ).catch(e => {
      log(`Stage 6 блок ${blockIndex + 1} цикл ${loopCount} ОШИБКА: ${e.message}`, 'warn');
      return null;
    });

    if (stage6Result?.html_content) {
      currentHTML = stage6Result.html_content;
      log(`Stage 6 блок ${blockIndex + 1}: цикл ${loopCount} завершён, HTML ${currentHTML.length} символов`, 'success');
    } else {
      log(`Stage 6 блок ${blockIndex + 1}: цикл ${loopCount} — html_content не получен. Прерываем цикл.`, 'warn');
      break;
    }
  }

  // Финальное измерение покрытия
  const finalCoverage = calculateCoverage(currentHTML, lsiMust);
  log(`Блок ${blockIndex + 1} — финальное LSI покрытие: ${finalCoverage.percent}%`, finalCoverage.percent >= 100 ? 'success' : 'warn');

  return {
    html:         currentHTML,
    lsiCoverage:  finalCoverage.percent,
    finalCoverage,
  };
}

module.exports = { runStage6 };
