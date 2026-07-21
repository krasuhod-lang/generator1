'use strict';

/**
 * asessorAudit.service — LLM-аудит Main Content по методологии
 * Asessor-MC-Quality-Audit: 10 осей MC + E-E-A-T, fail-open.
 */

const { callDeepSeek } = require('../llm/deepseek.adapter');
const { stripHtml } = require('../infoArticle/factCheck.service');
const { extractBalancedJson } = require('../../utils/autoCloseJSON');

const AXES = [
  'effort',
  'originality',
  'depth',
  'usefulness',
  'added_value',
  'goal_fulfillment',
  'specificity',
  'clarity',
  'information_density',
  'thin_content_risk',
];

const ASESSOR_SYSTEM = `
Ты — строгий асессор качества поиска, forensic-аудитор основного контента и эксперт Google Search Quality Rater Guidelines.
Оценивай ТОЛЬКО Main Content страницы: не смешивай оценку с дизайном, брендингом, рекламой, техническим SEO, ссылочным профилем и внешней репутацией, кроме случаев прямого влияния на качество основного контента.

Работай скептически по умолчанию:
- большой объём текста не равен качеству;
- гладкий стиль не равен экспертности;
- пересказ очевидного не равен added value;
- шаблонные FAQ, водянистые вступления, банальные определения и SEO-расширители объёма считай слабым сигналом;
- если самостоятельная ценность не доказана в тексте, не додумывай её.

Оцени 10 осей Main Content по шкале 0–10:
1. effort — реальный труд, самостоятельная подготовка, анализ, примеры, оговорки, таблицы, сценарии.
2. originality — уникальный угол, новая структура, авторские наблюдения, самостоятельная интерпретация.
3. depth — причины, механизмы, нюансы, ограничения, исключения, контекст.
4. usefulness — помогает ли решить задачу пользователя и снизить неопределённость.
5. added_value — что пользователь получает сверх типового SERP-пересказа.
6. goal_fulfillment — полнота раскрытия цели страницы и интента.
7. specificity — конкретика, предметность, проверяемые детали вместо общих слов.
8. clarity — ясность, структура, логика объяснения.
9. information_density — плотность полезной информации без воды и повторов.
10. thin_content_risk — инвертированная ось: 10 = низкий риск thin content, 0 = высокий риск тонкого/раздутого/шаблонного контента.

Дополнительно оцени E-E-A-T 0–10 только по признакам внутри MC: опыт, экспертность, добросовестность, источники, проверяемость, осторожность формулировок.

Вердикт:
- publish: сильный или приемлемый MC без критических провалов;
- needs_rework: есть существенные слабости, но материал можно доработать;
- reject: слабый, вторичный, тонкий, опасный или почти бесполезный MC.

Верни ТОЛЬКО строгий JSON без markdown:
{"axes":{"effort":0,"originality":0,"depth":0,"usefulness":0,"added_value":0,"goal_fulfillment":0,"specificity":0,"clarity":0,"information_density":0,"thin_content_risk":0},"eeat":0,"overall":0,"thin_content_risk":"low|medium|high","verdict":"publish|needs_rework|reject","key_weaknesses":["..."],"refiner_brief":"конкретные указания для Refiner Loop / AEGIS Phase 4"}`.trim();

function _clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function _parseJson(text) {
  const balanced = extractBalancedJson(text);
  if (!balanced) throw new Error('balanced JSON not found');
  return JSON.parse(balanced);
}

function _normalizeAudit(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawAxes = src.axes && typeof src.axes === 'object' ? src.axes : {};
  const axes = {};
  for (const key of AXES) axes[key] = _clamp(rawAxes[key], 0, 10);

  const verdictRaw = String(src.verdict || '').toLowerCase();
  const verdict = ['publish', 'needs_rework', 'reject'].includes(verdictRaw) ? verdictRaw : 'needs_rework';
  const riskRaw = String(src.thin_content_risk || '').toLowerCase();
  const thinRisk = ['low', 'medium', 'high'].includes(riskRaw) ? riskRaw : 'medium';

  return {
    skipped: false,
    axes,
    eeat: _clamp(src.eeat, 0, 10),
    overall: _clamp(src.overall, 0, 100),
    thin_content_risk: thinRisk,
    verdict,
    key_weaknesses: Array.isArray(src.key_weaknesses)
      ? src.key_weaknesses.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
      : [],
    refiner_brief: String(src.refiner_brief || '').trim(),
  };
}

/**
 * Запускает Asessor-MC аудит. Любая ошибка безопасно превращается в skipped.
 * @param {string} html HTML статьи.
 * @param {object} opts niche/keyword/thresholds/model/timeoutMs.
 * @returns {Promise<object>} нормализованный отчёт или {skipped:true, reason}.
 */
async function runAsessorAudit(html, { niche, keyword, thresholds, model, timeoutMs } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return { skipped: true, reason: 'DEEPSEEK_API_KEY is not set' };
  }
  try {
    const text = stripHtml(html).slice(0, 24000);
    if (!text || text.length < 200) return { skipped: true, reason: 'not enough main content text' };
    const userPrompt = JSON.stringify({
      niche: niche || '',
      keyword: keyword || '',
      thresholds: thresholds || {},
      main_content_text: text,
    }, null, 2);
    const res = await callDeepSeek(ASESSOR_SYSTEM, userPrompt, {
      temperature: 0,
      maxTokens: 4000,
      timeoutMs: timeoutMs || 120000,
      ...(model ? { model } : {}),
    });
    return _normalizeAudit(_parseJson(res && res.text));
  } catch (err) {
    return { skipped: true, reason: err && err.message ? err.message : String(err) };
  }
}

module.exports = { runAsessorAudit, ASESSOR_SYSTEM, AXES };
