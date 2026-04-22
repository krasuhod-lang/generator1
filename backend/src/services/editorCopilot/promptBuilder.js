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

// ────────────────────────────────────────────────────────────────────
// validateOutput — детерминированные пост-проверки качества ответа модели
// под каждый action. Возвращает { ok, issues[] }. Если ok=false, streamRunner
// делает корректирующий ретрай, передавая модели список issues, чтобы она
// исправила конкретные дефекты (DSPy-style self-correction, как в meta-tag
// generator). Пустой ответ — всегда невалиден, независимо от action.
// ────────────────────────────────────────────────────────────────────
function validateOutput(action, ctx, request, finalText) {
  const issues = [];
  const txt = String(finalText || '').trim();

  if (!txt) {
    issues.push('Ответ пустой. Верни непустой HTML-фрагмент по правилам [OUTPUT CONTRACT].');
    return { ok: false, issues };
  }

  const selected = String(request.selected_text || '');
  const selectedLen = selected.length;

  switch (action) {
    case 'factcheck': {
      // Длина ±15 % от исходного фрагмента
      if (selectedLen > 0) {
        if (txt.length < selectedLen * 0.7) {
          issues.push(
            `Ответ короче исходного фрагмента более чем на 30 % (${txt.length} vs ${selectedLen}). ` +
            `Сохрани все предложения, не относящиеся к заменяемому факту.`
          );
        }
        if (txt.length > selectedLen * 1.30) {
          issues.push(
            `Ответ длиннее исходного фрагмента более чем на 30 % (${txt.length} vs ${selectedLen}). ` +
            `Не дописывай новых предложений — только замени факт.`
          );
        }
        // Сохранение HTML-структуры: число основных тегов должно совпасть
        const selTagCount = countMajorTags(selected);
        const outTagCount = countMajorTags(txt);
        if (selTagCount > 0 && Math.abs(selTagCount - outTagCount) > Math.max(1, Math.floor(selTagCount * 0.2))) {
          issues.push(
            `Изменилась HTML-структура (теги <p>/<h2>/<h3>/<ul>/<li> в исходнике: ${selTagCount}, в ответе: ${outTagCount}). ` +
            `Сохрани ту же разметку, только подмени факт.`
          );
        }
        // Сохранение смысла: ≥50 % значимых слов исходника должны остаться
        const overlap = wordOverlapRatio(selected, txt);
        if (overlap < 0.5) {
          issues.push(
            `Доля общих значимых слов с исходным фрагментом всего ${(overlap * 100).toFixed(0)} %. ` +
            `Не переписывай предложения целиком — точечно подмени факт, остальное оставь как есть.`
          );
        }
      }
      break;
    }

    case 'add_faq': {
      const detailsCount = (txt.match(/<details\b/gi) || []).length;
      const summaryCount = (txt.match(/<summary\b/gi) || []).length;
      if (detailsCount !== 4) {
        issues.push(`Найдено ${detailsCount} тегов <details>, требуется ровно 4.`);
      }
      if (summaryCount !== 4) {
        issues.push(`Найдено ${summaryCount} тегов <summary>, требуется ровно 4.`);
      }
      if (!/<section[^>]*class=["']?faq["']?/i.test(txt) && !/<h2[^>]*>[^<]*вопрос/i.test(txt)) {
        issues.push('Отсутствует обёртка <section class="faq"> или заголовок <h2> "Вопросы и ответы".');
      }
      // Покрытие LSI ≥ 5 слов из lsi_unused
      const unused = (ctx?.lsi_state?.unused || []).slice(0, 60);
      if (unused.length) {
        const used = countLsiUsed(unused, txt);
        if (used < 5) {
          issues.push(
            `Использовано всего ${used} LSI-слов из списка lsi_unused, требуется минимум 5. ` +
            `Не использованы: ${unused.filter(w => !inText(w, txt)).slice(0, 8).join(', ')}.`
          );
        }
      }
      break;
    }

    case 'enrich_lsi': {
      if (selectedLen > 0 && txt.length > selectedLen * 1.30) {
        issues.push(
          `Длина ответа выросла более чем на 30 % (${txt.length} vs ${selectedLen}). ` +
          `Цель — +20 % максимум. Перепиши компактнее.`
        );
      }
      const unused = (ctx?.lsi_state?.unused || []).slice(0, 60);
      if (unused.length) {
        const used = countLsiUsed(unused, txt);
        if (used < 2) {
          issues.push(
            `Использовано всего ${used} LSI-слов из списка lsi_unused, минимум — 2 (цель — 4). ` +
            `Доступные слова: ${unused.slice(0, 12).join(', ')}.`
          );
        }
      }
      break;
    }

    case 'expand_section': {
      if (!/^\s*<h2\b/i.test(txt)) {
        issues.push('Раздел должен начинаться с тега <h2>.');
      }
      if (!/<(?:ul|ol|table)\b/i.test(txt)) {
        issues.push('Нет ни одного списка (<ul>/<ol>) или таблицы (<table>) — добавь минимум один.');
      }
      if (/<a\s[^>]*href=/i.test(txt)) {
        issues.push('Найден тег <a href=...>. Внешние и внутренние ссылки запрещены — удали их.');
      }
      const cleanText = stripToText(txt, 50_000);
      const wordCount = (cleanText.match(/\S+/g) || []).length;
      if (wordCount < 250) {
        issues.push(`Слишком короткий раздел: ${wordCount} слов. Минимум — 350.`);
      }
      if (wordCount > 900) {
        issues.push(`Слишком длинный раздел: ${wordCount} слов. Максимум — 700.`);
      }
      break;
    }

    case 'anti_spam': {
      const kw = String(request.extra_params?.keyword || '').trim();
      if (kw) {
        const occ = countOccurrencesAnyForm(kw, txt);
        if (occ > 2) {
          issues.push(
            `Ключ «${kw}» встречается ${occ} раз — нужно ≤ 2. Замени лишние вхождения ` +
            `синонимом / перифразой / местоимением.`
          );
        }
      }
      if (selectedLen > 0 && txt.length < selectedLen * 0.6) {
        issues.push(
          `Ответ значительно короче исходного фрагмента (${txt.length} vs ${selectedLen}). ` +
          `Не вырезай вхождения «вглухую» — заменяй на осмысленные синонимы.`
        );
      }
      break;
    }

    case 'custom':
    default:
      // Для custom единственный жёсткий критерий — непустой ответ (уже проверен выше).
      break;
  }

  return { ok: issues.length === 0, issues };
}

// ── Внутренние утилиты валидации ────────────────────────────────────

function countMajorTags(html) {
  if (!html) return 0;
  const m = html.match(/<\/?(?:p|h2|h3|h4|ul|ol|li|strong|em|a|table|tr|td|th)\b/gi);
  return m ? m.length : 0;
}

/**
 * wordOverlapRatio — доля значимых слов исходника, которые остались в ответе.
 * Используем простую нормализацию: lowercase + длина ≥ 4. Предлоги/союзы
 * (короткие слова) исключаем, чтобы overlap отражал реальное сохранение смысла.
 */
function wordOverlapRatio(src, out) {
  const norm = (s) => stripToText(s, 50_000)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[a-zа-я0-9]{4,}/gi) || [];
  const srcWords = norm(src);
  if (!srcWords.length) return 1;
  const outSet = new Set(norm(out));
  let kept = 0;
  for (const w of srcWords) if (outSet.has(w)) kept += 1;
  return kept / srcWords.length;
}

function inText(word, text) {
  if (!word) return false;
  const stem = String(word).toLowerCase().replace(/ё/g, 'е').slice(0, Math.max(4, Math.floor(word.length * 0.7)));
  if (!stem) return false;
  const haystack = stripToText(text, 50_000).toLowerCase().replace(/ё/g, 'е');
  return haystack.includes(stem);
}

function countLsiUsed(words, text) {
  if (!Array.isArray(words) || !words.length) return 0;
  let used = 0;
  for (const w of words) if (inText(w, text)) used += 1;
  return used;
}

function countOccurrencesAnyForm(word, text) {
  if (!word) return 0;
  const stem = String(word).toLowerCase().replace(/ё/g, 'е').slice(0, Math.max(4, Math.floor(word.length * 0.7)));
  if (!stem) return 0;
  const haystack = stripToText(text, 50_000).toLowerCase().replace(/ё/g, 'е');
  // Используем не пересекающуюся итерацию: считаем число НЕ-перекрывающихся вхождений
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(stem, idx)) !== -1) {
    count += 1;
    idx += stem.length;
  }
  return count;
}

/**
 * buildCorrectiveUserPrompt — собирает короткий блок-«дописку» к userPrompt
 * для корректирующего ретрая. Список issues подставляется как требования,
 * которые модель должна закрыть. Сам исходный userPrompt тоже передаётся,
 * чтобы модель не «потеряла» исходную задачу.
 */
function buildCorrectiveUserPrompt(originalUser, issues) {
  const issuesBlock = (Array.isArray(issues) ? issues : [String(issues)])
    .filter(Boolean)
    .map((s, i) => `  ${i + 1}) ${s}`)
    .join('\n');
  return (
    String(originalUser || '') +
    '\n\n[КОРРЕКТИРУЮЩИЙ РЕТРАЙ — обязательные правки]\n' +
    'Предыдущий ответ не прошёл автоматические проверки. Перепиши ответ так, ' +
    'чтобы устранить ВСЕ замечания ниже. Возвращать пустой ответ запрещено — ' +
    'если изменение технически невозможно, верни исходный фрагмент без изменений.\n' +
    issuesBlock
  );
}

module.exports = { buildPrompt, postProcess, validateOutput, buildCorrectiveUserPrompt };
