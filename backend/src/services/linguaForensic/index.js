/**
 * LinguaForensic v3.6 — единый слой детекции AI-текста и целевого рерайта
 * для всех генераторов контента (SEO-текст, статья для блога, ссылочная статья).
 *
 * Каркас НЕ заменяется — слой подключается как дополнительный graceful-проход
 * ПОСЛЕ финальной сборки HTML и ПЕРЕД Unified Quality Gate:
 *   1. detect()  — «Режим 2. Полная детекция» по skill-файлу
 *                  skills/AI-detect-v-3-6.md (284 признака + 16 маркеров +
 *                  knockoff-слой + fluency);
 *   2. rewrite() — «Режим 3. Стратегический рерайт» (fluency-проход F1–F7),
 *                  запускается только если роботность выше порога;
 *   3. runLinguaForensicPass() — orchestration: detect → (rewrite → re-detect),
 *                  защита объёма ±15%, никогда не бросает исключений.
 *
 * Управление:
 *   LINGUAFORENSIC_ENABLED       — 'true'|'false' (default: true; при
 *                                  отсутствии skill-файла слой сам отключается)
 *   LINGUAFORENSIC_SKILL_PATH    — путь к skill-файлу
 *                                  (default: <repo>/skills/AI-detect-v-3-6.md)
 *   LF_TARGET_ROBOTNESS          — порог рерайта, % (default: 25 — стандарт
 *                                  GIST M9; legacy-алиас LINGUAFORENSIC_MAX_ROBOTNESS)
 *   LF_MAX_PASSES                — максимум рерайт-итераций (default: 3 — как
 *                                  в GIST M8→M9; legacy-алиас LINGUAFORENSIC_MAX_PASSES)
 *   LF_STRATEGY_THRESHOLDS       — пороги градуированных стратегий
 *                                  light/medium/deep/full (default: '35,55,75')
 *
 * Градуированный выбор стратегии (ТЗ GIST, Задача C):
 *   strategy = light  если r ≤ 35%
 *              medium если 35% < r ≤ 55%
 *              deep   если 55% < r ≤ 75%
 *              full   если r > 75%
 *
 * Тот же skill-файл использует gist_py (M8 LinguaForensic) — единый источник
 * правды для детектора во всех пайплайнах.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { callLLM } = require('../llm/callLLM');

// ── Конфигурация ────────────────────────────────────────────────────────────

const DEFAULT_SKILL_PATH = path.resolve(__dirname, '../../../..', 'skills', 'AI-detect-v-3-6.md');

const ENABLED        = String(process.env.LINGUAFORENSIC_ENABLED ?? 'true') === 'true';
const SKILL_PATH     = process.env.LINGUAFORENSIC_SKILL_PATH || DEFAULT_SKILL_PATH;
const MAX_ROBOTNESS  = Number(
  process.env.LF_TARGET_ROBOTNESS ?? process.env.LINGUAFORENSIC_MAX_ROBOTNESS ?? 25,
);
const MAX_PASSES     = Math.max(
  0,
  Number(process.env.LF_MAX_PASSES ?? process.env.LINGUAFORENSIC_MAX_PASSES ?? 3),
);
const VOLUME_TOLERANCE = 0.15; // ±15% объёма (см. «Параметры рерайта» в skill)

// Пороги градуированных стратегий рерайта (light/medium/deep) — как в GIST M9.
const STRATEGY_THRESHOLDS = (() => {
  const raw = String(process.env.LF_STRATEGY_THRESHOLDS || '35,55,75')
    .split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
  return raw.length === 3 ? raw : [35, 55, 75];
})();

// Интенсивность рерайта в терминах skill-файла (Light|Medium|Deep|Full).
const STRATEGY_INTENSITY = { light: 'Light', medium: 'Medium', deep: 'Deep', full: 'Full' };

/**
 * pickRewriteStrategy — градуированный выбор стратегии по роботности r (%):
 * light (r≤35), medium (35<r≤55), deep (55<r≤75), full (r>75).
 */
function pickRewriteStrategy(robotness, thresholds = STRATEGY_THRESHOLDS, maxStrategy = 'full') {
  const r = Number(robotness) || 0;
  const [t1, t2, t3] = Array.isArray(thresholds) && thresholds.length === 3
    ? thresholds : STRATEGY_THRESHOLDS;
  let strategy = 'full';
  if (r <= t1) strategy = 'light';
  else if (r <= t2) strategy = 'medium';
  else if (r <= t3) strategy = 'deep';
  const order = ['light', 'medium', 'deep', 'full'];
  const maxIdx = order.includes(maxStrategy) ? order.indexOf(maxStrategy) : order.length - 1;
  const strategyIdx = order.indexOf(strategy);
  return order[Math.min(strategyIdx, maxIdx)];
}

// Домены skill-файла для трёх генераторов контента
const PIPELINE_DOMAINS = {
  seo:  'Смешанный (SEO-текст, коммерческо-информационный)',
  info: 'News/Opinion (информационная статья для блога)',
  link: 'News (ссылочная/аутрич-статья)',
};

let _skillCache = null;

/** Загрузить skill-файл (system prompt детектора). null → слой недоступен. */
function loadSkill() {
  if (_skillCache !== null) return _skillCache || null;
  try {
    _skillCache = fs.readFileSync(SKILL_PATH, 'utf8');
  } catch (_) {
    _skillCache = '';
  }
  return _skillCache || null;
}

function isEnabled() {
  return ENABLED && !!loadSkill();
}

// ── Промпты (user prompts поверх skill-а) ───────────────────────────────────

function buildDetectPrompt(articleText, domainHint) {
  return [
    'Режим 2. Полная детекция.',
    `Доменная подсказка: ${domainHint}.`,
    '',
    'Проанализируй текст ниже по полной методологии (284 признака, 16 структурных',
    'маркеров, knockoff-слой, доменные веса) и верни СТРОГО один JSON-объект без',
    'markdown-обёртки со следующими полями:',
    '{',
    '  "robotness_score": число 0-100,',
    '  "confidence_interval": число (± п.п.),',
    '  "domain": "News|Creative|Opinion|Scientific|Factual|Conversational|Смешанный",',
    '  "verdict": "строка",',
    '  "llm_family": "Группа A|Группа B|неопределено",',
    '  "top_contributing_categories": [{"category": "...", "contribution_pct": число}],',
    '  "structural_markers_found": ["12.X — название: краткая цитата", ...],',
    '  "fluency_issues": ["F1: ...", "F3: ...", ...],',
    '  "knockoff": {"s_statistic": число, "symmetric": true|false},',
    '  "recommended_strategy": "Экспертная|Нарративная|Разговорная|Минимальная",',
    '  "recommended_intensity": "Light|Medium|Deep|Full"',
    '}',
    '',
    'Текст (HTML, анализируй только видимый текст, теги игнорируй):',
    '---',
    articleText,
    '---',
  ].join('\n');
}

function buildRewritePrompt(articleHtml, report, domainHint, opts = {}) {
  const markers = (report.structural_markers_found || []).map((m) => `- ${m}`).join('\n') || '-';
  const fluency = (report.fluency_issues || []).map((m) => `- ${m}`).join('\n') || '-';
  const topCats = (report.top_contributing_categories || [])
    .map((c) => `- ${c.category}: +${c.contribution_pct}%`).join('\n') || '-';
  // Градуированная интенсивность по текущей роботности (light/medium/deep/full)
  const gradStrategy  = report.__lfStrategyOverride ||
    pickRewriteStrategy(report.robotness_score, opts.thresholds, opts.maxStrategy);
  const gradIntensity = STRATEGY_INTENSITY[gradStrategy];
  return [
    'Режим 3. Стратегический рерайт.',
    `Доменная подсказка: ${domainHint}.`,
    `Текущая роботность: ${report.robotness_score}%.`,
    `Стратегия: ${report.recommended_strategy || 'по домену'}; интенсивность: ${gradIntensity} ` +
      `(градуированная стратегия «${gradStrategy}» по роботности; пороги ${(opts.thresholds || STRATEGY_THRESHOLDS).join('/')}%).`,
    '',
    'Вклад TOP-категорий:',
    topCats,
    'Найденные структурные маркеры:',
    markers,
    'Fluency-проблемы:',
    fluency,
    '',
    'ЖЁСТКИЕ ОГРАНИЧЕНИЯ (текст — часть продакшн-пайплайна генерации контента):',
    '- Вход и выход — HTML. СОХРАНИ всю HTML-разметку: заголовки h1-h4, списки,',
    '  таблицы, ссылки (href не менять), схемы, атрибуты. Меняй только текст.',
    '- Объём: не более ±15% слов.',
    '- Все ключевые термины, факты, цифры, названия — сохранить без искажений.',
    '- Структуру абзацев и порядок секций — сохранить.',
    '- Обязательный fluency-проход F1–F7 согласно приоритетам стратегии.',
    '- Не добавлять тире-коннекторы и шаблонные «хеджи-вставки» — это AI-маркеры.',
    '',
    'Верни СТРОГО один JSON-объект без markdown-обёртки:',
    '{',
    '  "rewritten_html": "полный переписанный HTML",',
    '  "applied_techniques": ["F1", "F3", ...],',
    '  "changes_summary": "краткое описание правок",',
    '  "post_validation": {"length_delta_pct": число, "terms_preserved": true|false, "facts_intact": true|false}',
    '}',
    '',
    'Исходный HTML:',
    '---',
    articleHtml,
    '---',
  ].join('\n');
}

// ── Вспомогательное ─────────────────────────────────────────────────────────

function _wordCount(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
}

function _volumeOk(originalHtml, rewrittenHtml) {
  const ow = _wordCount(originalHtml);
  const rw = _wordCount(rewrittenHtml);
  if (!ow || !rw) return false;
  return Math.abs(rw - ow) / ow <= VOLUME_TOLERANCE + 0.05; // небольшой допуск
}

function _normalizeReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const knockoff = raw.knockoff && typeof raw.knockoff === 'object' ? raw.knockoff : {};
  return {
    robotness_score:  Number(raw.robotness_score) || 0,
    confidence_interval: raw.confidence_interval ?? null,
    domain:           raw.domain || null,
    verdict:          raw.verdict || null,
    llm_family:       raw.llm_family || null,
    top_contributing_categories: Array.isArray(raw.top_contributing_categories)
      ? raw.top_contributing_categories : [],
    structural_markers_found: Array.isArray(raw.structural_markers_found)
      ? raw.structural_markers_found : [],
    fluency_issues:   Array.isArray(raw.fluency_issues) ? raw.fluency_issues : [],
    knockoff_s:       knockoff.s_statistic ?? null,
    knockoff_symmetric: knockoff.symmetric ?? null,
    recommended_strategy:  raw.recommended_strategy || null,
    recommended_intensity: raw.recommended_intensity || null,
  };
}

// ── Публичный API ───────────────────────────────────────────────────────────

/**
 * Режим 2 — полная детекция. Бросает исключение при сбое LLM
 * (перехватывается в runLinguaForensicPass).
 */
async function detect(articleHtml, { pipeline = 'seo', taskId = null, log = null, onTokens = null } = {}) {
  const skill = loadSkill();
  if (!skill) throw new Error(`Skill-файл LinguaForensic не найден: ${SKILL_PATH}`);
  const domainHint = PIPELINE_DOMAINS[pipeline] || PIPELINE_DOMAINS.seo;
  const raw = await callLLM(
    'gemini',
    skill,
    buildDetectPrompt(articleHtml, domainHint),
    {
      retries: 2, taskId, stageName: 'linguaforensic',
      callLabel: 'LinguaForensic Detect (Режим 2)',
      temperature: 0.1, onLog: log, onTokens,
    },
  );
  const report = _normalizeReport(raw);
  if (!report) throw new Error('LinguaForensic не вернул JSON-отчёт детекции');
  return report;
}

/**
 * Режим 3 — стратегический рерайт по отчёту детекции.
 * Возвращает { html, accepted, changes } — при нарушении объёма/разметки
 * рерайт отклоняется и остаётся оригинал.
 */
async function rewrite(
  articleHtml,
  report,
  { pipeline = 'seo', taskId = null, log = null, onTokens = null, thresholds, maxStrategy = 'full' } = {},
) {
  const skill = loadSkill();
  if (!skill) throw new Error(`Skill-файл LinguaForensic не найден: ${SKILL_PATH}`);
  const domainHint = PIPELINE_DOMAINS[pipeline] || PIPELINE_DOMAINS.seo;
  const raw = await callLLM(
    'gemini',
    skill,
    buildRewritePrompt(articleHtml, report, domainHint, { thresholds, maxStrategy }),
    {
      retries: 2, taskId, stageName: 'linguaforensic',
      callLabel: 'LinguaForensic Rewrite (Режим 3)',
      temperature: 0.6, onLog: log, onTokens,
      maxTokens: 32000,
    },
  );
  const rewritten = raw && typeof raw.rewritten_html === 'string' ? raw.rewritten_html.trim() : '';
  const changes = {
    applied_techniques: Array.isArray(raw?.applied_techniques) ? raw.applied_techniques : [],
    changes_summary:    raw?.changes_summary || null,
    post_validation:    raw?.post_validation || null,
  };
  if (!rewritten || !_volumeOk(articleHtml, rewritten)) {
    return { html: articleHtml, accepted: false, changes: { ...changes, rejected: 'volume_or_empty' } };
  }
  return { html: rewritten, accepted: true, changes };
}

/**
 * Полный graceful-проход: детекция → (при превышении порога) рерайт →
 * повторная детекция. НИКОГДА не бросает исключений и не роняет пайплайн:
 * при любой ошибке возвращает исходный HTML и verdict 'skipped'/'error'.
 *
 * @param {string} articleHtml — финальный HTML статьи
 * @param {object} opts — { pipeline: 'seo'|'info'|'link', taskId, log, onTokens,
 *                          maxRobotness, maxPasses, thresholds, maxStrategy,
 *                          strategySequence }
 * @returns {Promise<{html: string, report: object}>}
 *   report: { verdict: 'ok'|'rewritten'|'skipped'|'error',
 *             robotness_before, robotness_after, detection, passes, changes }
 */
async function runLinguaForensicPass(articleHtml, opts = {}) {
  const {
    pipeline = 'seo',
    taskId = null,
    log = null,
    onTokens = null,
    maxRobotness = MAX_ROBOTNESS,
    maxPasses = MAX_PASSES,
    thresholds = STRATEGY_THRESHOLDS,
    maxStrategy = 'full',
    strategySequence = null,
  } = opts;
  const logFn = typeof log === 'function' ? log : () => {};

  if (!isEnabled()) {
    return { html: articleHtml, report: { verdict: 'skipped', reason: ENABLED ? 'skill_missing' : 'disabled' } };
  }
  if (!articleHtml || _wordCount(articleHtml) < 100) {
    return { html: articleHtml, report: { verdict: 'skipped', reason: 'too_short' } };
  }

  try {
    let detection = await detect(articleHtml, { pipeline, taskId, log, onTokens });
    const robotnessBefore = detection.robotness_score;
    logFn(
      `LinguaForensic v3.6: роботность ${robotnessBefore}%` +
      (detection.confidence_interval != null ? ` ±${detection.confidence_interval}` : '') +
      ` | домен: ${detection.domain || '—'} | knockoff s: ${detection.knockoff_s ?? '—'}`,
      'info',
    );

    if (robotnessBefore <= maxRobotness || maxPasses < 1) {
      return {
        html: articleHtml,
        report: {
          verdict: 'ok',
          robotness_before: robotnessBefore,
          robotness_after:  robotnessBefore,
          detection,
          passes: 0,
        },
      };
    }

    let html = articleHtml;
    let passes = 0;
    const allChanges = [];
    for (let i = 0; i < maxPasses; i++) {
      const strategyOverride = Array.isArray(strategySequence) ? strategySequence[i] : null;
      const rewriteReport = strategyOverride
        ? { ...detection, __lfStrategyOverride: strategyOverride }
        : detection;
      logFn(
        `LinguaForensic: роботность ${detection.robotness_score}% > порога ${maxRobotness}% — ` +
        `рерайт (стратегия: ${strategyOverride || pickRewriteStrategy(detection.robotness_score, thresholds, maxStrategy)}` +
        `${detection.recommended_strategy ? ` / ${detection.recommended_strategy}` : ''}, ` +
        `проход ${i + 1}/${maxPasses})`,
        'info',
      );
      const res = await rewrite(html, rewriteReport, {
        pipeline, taskId, log, onTokens, thresholds, maxStrategy,
      });
      allChanges.push(res.changes);
      if (!res.accepted) {
        logFn('LinguaForensic: рерайт отклонён (объём ±15% или пустой ответ) — оставляем текущую версию', 'warn');
        break;
      }
      html = res.html;
      passes += 1;
      detection = await detect(html, { pipeline, taskId, log, onTokens });
      logFn(`LinguaForensic: после рерайта роботность ${detection.robotness_score}%`, 'info');
      if (detection.robotness_score <= maxRobotness) break;
    }

    return {
      html,
      report: {
        verdict: passes > 0 ? 'rewritten' : 'ok',
        robotness_before: robotnessBefore,
        robotness_after:  detection.robotness_score,
        detection,
        passes,
        changes: allChanges,
      },
    };
  } catch (e) {
    logFn(`LinguaForensic: ошибка — ${e.message} — слой пропущен, текст не изменён`, 'warn');
    return { html: articleHtml, report: { verdict: 'error', reason: e.message } };
  }
}

module.exports = {
  isEnabled,
  loadSkill,
  detect,
  rewrite,
  runLinguaForensicPass,
  // для тестов
  pickRewriteStrategy,
  // для тестов
  _internal: {
    buildDetectPrompt, buildRewritePrompt, _volumeOk, _wordCount, _normalizeReport,
    SKILL_PATH, PIPELINE_DOMAINS, STRATEGY_THRESHOLDS, MAX_ROBOTNESS, MAX_PASSES,
  },
};
