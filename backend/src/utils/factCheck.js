'use strict';

/**
 * factCheck — поиск потенциальных галлюцинаций в HTML-контенте.
 * Перенесено из index.html без изменений (адаптировано под Node.js).
 *
 * Извлекает числа из текстового содержимого и проверяет,
 * не выдумал ли LLM цифры, которых нет в фактах бренда.
 *
 * @param {string}   htmlContent  — HTML-текст проверяемого блока
 * @param {string[]} factsArray   — массив строк с фактами бренда
 * @param {string}   [brandFacts] — дополнительный текст фактов (brandFacts поле)
 * @param {string}   [rawLSI]     — LSI-список (числа из него считаются «безопасными»)
 * @returns {number[]} — массив «подозрительных» чисел (возможные галлюцинации)
 */
function factCheck(htmlContent, factsArray = [], brandFacts = '', rawLSI = '') {
  // Снимаем HTML-теги, оставляем только текст
  const textOnly = htmlContent.replace(/<[^>]+>/g, ' ');

  // Все числа в тексте (включая десятичные и разделённые запятой)
  const allNumbers = (textOnly.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));

  if (!factsArray.length && !brandFacts) return [];

  // Собираем «известные» числа из всех источников данных
  const knownNumbers = new Set();

  const factsText = factsArray.join(' ');
  const factsNums = (factsText.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));
  factsNums.forEach(n => knownNumbers.add(n));

  const brandText  = brandFacts + ' ' + rawLSI;
  const brandNums  = (brandText.match(/\b\d+[\d,.]*\b/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '.')));
  brandNums.forEach(n => knownNumbers.add(n));

  // Числа, которые никогда не считаются галлюцинацией
  const safeNumbers = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 1000]);

  const hallucinations = [];

  for (const num of allNumbers) {
    // Пропускаем «безопасные» и годы
    if (safeNumbers.has(num))               continue;
    if (num >= 1900 && num <= 2100)         continue;

    if (!knownNumbers.has(num)) {
      // Допускаем погрешность ±5% относительно известных чисел
      let found = false;
      for (const kn of knownNumbers) {
        if (kn > 0 && Math.abs(num - kn) / kn < 0.05) { found = true; break; }
      }
      if (!found) hallucinations.push(num);
    }
  }

  return hallucinations;
}

/**
 * CONFIDENCE_THRESHOLD — порог средней log-вероятности.
 * Если mean_logprob абзаца ниже этого порога, модель "не уверена" в содержании.
 * -1.5 — эмпирически подобранное значение (logprob = ln(P), P ≈ 22% при -1.5).
 */
const CONFIDENCE_THRESHOLD = -1.5;

/** Minimum paragraph text length to include in confidence analysis */
const MIN_PARAGRAPH_LENGTH = 20;

/** Number of leading characters used to locate a paragraph in the token stream */
const MATCH_PREFIX_LENGTH = 50;

/**
 * computeConfidence — вычисляет уверенность модели для каждого абзаца HTML.
 *
 * @param {Array<{token:string, logprob:number}>|null} logprobs — массив logprob для каждого токена
 * @param {string} htmlContent — HTML-контент блока
 * @returns {{ paragraphs: Array<{index:number, text:string, meanLogprob:number, confident:boolean}>, lowConfidenceCount: number }}
 */
function computeConfidence(logprobs, htmlContent) {
  if (!logprobs || !logprobs.length || !htmlContent) {
    return { paragraphs: [], lowConfidenceCount: 0 };
  }

  const paragraphMatches = htmlContent.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  if (!paragraphMatches.length) {
    return { paragraphs: [], lowConfidenceCount: 0 };
  }

  const fullText = logprobs.map(t => t.token).join('');

  const paragraphs = [];
  let lowConfidenceCount = 0;
  let tokenOffset = 0;

  for (let i = 0; i < paragraphMatches.length; i++) {
    const pHtml = paragraphMatches[i];
    const pText = pHtml.replace(/<[^>]+>/g, '').trim();

    if (pText.length < MIN_PARAGRAPH_LENGTH) continue;

    const pTextClean = pText.substring(0, MATCH_PREFIX_LENGTH);
    const startIdx = fullText.indexOf(pTextClean, tokenOffset);

    if (startIdx === -1) {
      paragraphs.push({ index: i, text: pText.substring(0, 100), meanLogprob: 0, confident: true });
      continue;
    }

    let charCount = 0;
    let tokenStart = -1;
    let tokenEnd = -1;

    for (let j = 0; j < logprobs.length; j++) {
      if (charCount >= startIdx && tokenStart === -1) {
        tokenStart = j;
      }
      charCount += logprobs[j].token.length;
      if (charCount >= startIdx + pText.length) {
        tokenEnd = j;
        break;
      }
    }

    if (tokenStart === -1 || tokenEnd === -1) {
      paragraphs.push({ index: i, text: pText.substring(0, 100), meanLogprob: 0, confident: true });
      continue;
    }

    const pTokens = logprobs.slice(tokenStart, tokenEnd + 1);
    const meanLogprob = pTokens.length > 0
      ? pTokens.reduce((sum, t) => sum + t.logprob, 0) / pTokens.length
      : 0;

    const confident = meanLogprob >= CONFIDENCE_THRESHOLD;
    if (!confident) lowConfidenceCount++;

    paragraphs.push({
      index: i,
      text: pText.substring(0, 100),
      meanLogprob: Math.round(meanLogprob * 1000) / 1000,
      confident,
    });

    tokenOffset = startIdx + pText.length;
  }

  return { paragraphs, lowConfidenceCount };
}

module.exports = { factCheck, computeConfidence, CONFIDENCE_THRESHOLD };
