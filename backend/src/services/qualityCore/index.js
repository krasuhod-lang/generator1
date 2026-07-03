'use strict';

/**
 * qualityCore — единый Quality Core для трёх пайплайнов (V1 ТЗ Content Generator v2).
 *
 * Публичный фасад:
 *   - checkers    — чистые функции-проверки (freshness, plagiarism, intent, …).
 *   - qualityGate — finalize()/persistReport()/summarize() поверх checkers.
 *
 * Использование в пайплайне (пример):
 *   const { qualityGate } = require('../qualityCore');
 *   const verdict = qualityGate.finalize('info', {
 *     html, niche: task.input_target_service,
 *     plagiarismReport, factReport, intentReport, lsiOverdoseReport,
 *     links, riskReport, authorship, informationGainBrief,
 *   });
 *   if (!verdict.canPublish) { // блокируем финализацию, показываем verdict.blockers }
 *   await qualityGate.persistReport({ pipeline: 'info', taskId, result: verdict });
 */

const checkers = require('./checkers');
const qualityGate = require('./qualityGate');

module.exports = { checkers, qualityGate };
