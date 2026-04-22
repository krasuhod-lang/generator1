'use strict';

const fs   = require('fs');
const path = require('path');
const { getPreset } = require('./actionPresets');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts', 'editorCopilot');

let _systemTpl = null;
const _modifierCache = new Map();

function loadSystemTemplate() {
  if (_systemTpl === null) {
    _systemTpl = fs.readFileSync(path.join(PROMPTS_DIR, 'system.txt'), 'utf8');
  }
  return _systemTpl;
}

function loadModifier(modifierFile) {
  if (!modifierFile) return '';
  if (_modifierCache.has(modifierFile)) return _modifierCache.get(modifierFile);
  const text = fs.readFileSync(path.join(PROMPTS_DIR, modifierFile), 'utf8');
  _modifierCache.set(modifierFile, text);
  return text;
}

/**
 * buildPrompt — собирает финальный (system, user) промпт для streamGenerate.
 * Возвращает 2 строки:
 *   - system   — пойдёт в Gemini systemInstruction
 *   - user     — пойдёт в contents.parts.text
 *
 * @param {object} ctx     — результат contextBuilder.buildContext()
 * @param {object} request — { action, selected_text, user_prompt, extra_params }
 * @returns {{ system: string, user: string, modelHints: object }}
 */
function buildPrompt(ctx, request) {
  const preset = getPreset(request.action);
  if (!preset) throw new Error(`Unknown action: ${request.action}`);

  const tpl = loadSystemTemplate();

  const audienceProfile = clip(ctx.audience_personas, 4000) || 'Не указано (см. SEO-метаданные задачи)';
  const eeat            = clip(ctx.eeat_brief, 3000)        || 'Стандартные требования E-E-A-T для информационного контента';
  const tov             = clip(ctx.content_voice, 2000)     || 'Профессиональный, дружелюбный, без канцелярита';
  const brand           = (ctx.input_data?.brand || '').trim() || 'Не указан';

  // Урезаем full_article_text по необходимости; для FAQ нужен полный, для enrich/anti_spam достаточно фрагмента.
  const fullArticle = preset.needsArticle
    ? stripToText(ctx.full_article_text || '', 18000)
    : '— (полный текст не передан для этого действия)';

  // LSI: только реально неиспользованные.
  let lsiUnusedStr = '— (нет необходимости использовать LSI для этого действия)';
  if (preset.needsLsi) {
    const unused = (ctx.lsi_state?.unused || []).slice(0, 60);
    lsiUnusedStr = unused.length
      ? unused.map(w => `- ${w}`).join('\n')
      : '(все LSI уже использованы — можно повторно выделить акценты на самых важных)';
  }

  const selectedText = preset.needsSelected
    ? clip(request.selected_text || '', 12000)
    : (request.selected_text ? clip(request.selected_text, 4000) : '— (фрагмент не выделен)');

  // Собираем user_prompt + добавляем extra_params для anti_spam в текстовом виде.
  let userPromptCombined = String(request.user_prompt || '').trim();
  if (preset.needsExtra && request.extra_params) {
    const extras = Object.entries(request.extra_params)
      .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      .map(([k, v]) => `${k} = ${v}`)
      .join('; ');
    if (extras) userPromptCombined += `\n[extra: ${extras}]`;
  }
  if (!userPromptCombined) userPromptCombined = '(пользователь не оставил комментария — выполни действие согласно микро-инструкции ниже)';

  const modifier = loadModifier(preset.modifierFile)
    || 'Свободная задача. Выполни запрос пользователя, не нарушая ограничений.';

  // Финальная сборка через простую подстановку.
  const filled = tpl
    .replace(/\{\{BRAND_NAME\}\}/g,        () => brand)
    .replace(/\{\{TONE_OF_VOICE\}\}/g,     () => tov)
    .replace(/\{\{AUDIENCE_PROFILE\}\}/g,  () => audienceProfile)
    .replace(/\{\{EEAT_REQUIREMENTS\}\}/g, () => eeat)
    .replace(/\{\{FULL_ARTICLE_TEXT\}\}/g, () => fullArticle)
    .replace(/\{\{SELECTED_TEXT\}\}/g,     () => selectedText)
    .replace(/\{\{LSI_UNUSED\}\}/g,        () => lsiUnusedStr)
    .replace(/\{\{USER_PROMPT\}\}/g,       () => userPromptCombined)
    .replace(/\{\{ACTION_MODIFIER\}\}/g,   () => modifier);

  // Делим на system + user. Берём первую логическую секцию (СИСТЕМНАЯ РОЛЬ + КОНТЕКСТ ЗАДАЧИ)
  // как system, остальное — user. Это уменьшает шанс сжатия моделью «контекста» как пользовательского ввода.
  // Простая эвристика: всё ДО маркера [ВЫДЕЛЕННЫЙ ФРАГМЕНТ] идёт в system; остальное в user.
  const splitMarker = '[ВЫДЕЛЕННЫЙ ФРАГМЕНТ';
  const splitIdx    = filled.indexOf(splitMarker);
  let system, user;
  if (splitIdx > 0) {
    system = filled.slice(0, splitIdx).trim();
    user   = filled.slice(splitIdx).trim();
  } else {
    system = filled;
    user   = userPromptCombined;
  }

  return {
    system,
    user,
    modelHints: {
      // Для коротких правок температура ниже, для расширения — выше
      temperature: (request.action === 'expand_section' || request.action === 'add_faq') ? 0.7 : 0.4,
      maxTokens:   (request.action === 'expand_section') ? 4096 : 2048,
    },
  };
}

function clip(s, max) {
  if (!s) return '';
  s = String(s);
  return s.length > max ? s.slice(0, max) + '\n…[обрезано]' : s;
}

function stripToText(html, max) {
  if (!html) return '';
  // ВАЖНО: порядок декодирования сущностей. Сначала декодируем именованные
  // (&lt; &gt; &nbsp; и т.п.), а &amp; — В САМОМ КОНЦЕ. Иначе строка вида
  // "&amp;lt;" сначала превратится в "&lt;", а потом в "<" — двойное
  // декодирование (CodeQL js/double-escaping). Корректно: "&amp;lt;" →
  // "&lt;" (после &amp;→&) и больше ничего.
  // Также tag-filter регэкспы должны допускать любой whitespace внутри
  // закрывающего тега ("</script\n bar>", "</style >").
  const text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')   // <- последняя замена
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + ' …[обрезано]' : text;
}

/**
 * postProcess — чистит ответ модели от типичных «обёрток».
 * Не парсит и не санитайзит HTML — это работа фронтенда (DOMPurify) перед apply.
 */
function postProcess(text) {
  if (!text) return '';
  let out = String(text).trim();
  // Снимаем markdown fences ```html ... ``` или ``` ... ```
  const fenceMatch = out.match(/^```(?:html|markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) out = fenceMatch[1].trim();
  // Снимаем «Конечно, вот ваш текст:» и подобные вводные на 1 строке
  out = out.replace(/^(?:конечно|вот|here\s+is|итак|готово)[^\n]{0,80}[:\.\-]\s*\n+/i, '');
  return out.trim();
}

module.exports = { buildPrompt, postProcess };
