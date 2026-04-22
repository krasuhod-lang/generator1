'use strict';

/**
 * actionPresets — микро-инструкции (modifiers) для каждого Intent-пресета
 * AI-Copilot редактора. Каждая запись описывает:
 *   - modifierFile  — имя файла промпта в backend/src/prompts/editorCopilot/
 *   - needsSelected — обязателен ли selected_text
 *   - needsArticle  — нужен ли полный текст статьи в промпте
 *   - needsLsi      — нужны ли неиспользованные LSI
 *   - needsExtra    — нужны ли extra_params (например keyword для anti_spam)
 *   - extraSchema   — { fieldName: 'type:required|optional' } — простая валидация
 *   - displayLabel  — человекочитаемое имя действия
 *   - applyMode     — как фронт должен интегрировать ответ в редактор:
 *                       'replace'      — заменить выделение результатом;
 *                       'insert_below' — вставить ниже курсора;
 *                       'auto'         — replace при наличии selected_text,
 *                                        иначе insert_below.
 *                     Это единый источник правды; UI читает поле через /presets.
 *
 * Поддерживаемые actions:
 *   factcheck, add_faq, enrich_lsi, expand_section, anti_spam, custom
 */

const PRESETS = {
  factcheck: {
    displayLabel:  'Фактчекинг (замена факта в фрагменте)',
    modifierFile:  'factcheck.txt',
    needsSelected: true,
    needsArticle:  false,
    needsLsi:      false,
    needsExtra:    false,
    extraSchema:   {},
    applyMode:     'replace',
  },
  add_faq: {
    displayLabel:  'Добавить FAQ-блок',
    modifierFile:  'add_faq.txt',
    needsSelected: false,
    needsArticle:  true,
    needsLsi:      true,
    needsExtra:    false,
    extraSchema:   {},
    applyMode:     'insert_below',
  },
  enrich_lsi: {
    displayLabel:  'Обогатить блок LSI-словами',
    modifierFile:  'enrich_lsi.txt',
    needsSelected: true,
    needsArticle:  false,
    needsLsi:      true,
    needsExtra:    false,
    extraSchema:   {},
    applyMode:     'replace',
  },
  expand_section: {
    displayLabel:  'Расширить структуру (новый раздел)',
    modifierFile:  'expand_section.txt',
    needsSelected: false,
    needsArticle:  true,
    needsLsi:      true,
    needsExtra:    false,
    extraSchema:   {},
    applyMode:     'insert_below',
  },
  anti_spam: {
    displayLabel:  'Анти-спам (снизить плотность ключа)',
    modifierFile:  'anti_spam.txt',
    needsSelected: true,
    needsArticle:  false,
    needsLsi:      true,
    needsExtra:    true,
    extraSchema:   { keyword: 'string:required' },
    applyMode:     'replace',
  },
  custom: {
    // Свой запрос. Если пользователь предварительно выделил фрагмент — пресет
    // работает в режиме «доработай и замени выделенное», иначе — «вставь блок ниже».
    // Единый файл-модификатор custom.txt описывает оба сценария и обязательно
    // включает: (1) внутреннюю доработку запроса пользователя, (2) исправление
    // ошибок в выделенном тексте, (3) возврат ТОЛЬКО заменяющего варианта,
    // чтобы EditorCopilotPage мог автоматически подставить его на место выделения.
    displayLabel:  'Свой запрос',
    modifierFile:  'custom.txt',
    needsSelected: false,
    needsArticle:  true,
    needsLsi:      true,
    needsExtra:    false,
    extraSchema:   {},
    applyMode:     'auto',
  },
};

/**
 * Проверяет валидность action и его параметров.
 * @returns {string|null} — текст ошибки, либо null если всё ОК.
 */
function validateRequest({ action, selected_text, user_prompt, extra_params }) {
  const preset = PRESETS[action];
  if (!preset) return `Неизвестный action: ${action}`;

  if (preset.needsSelected && (!selected_text || !String(selected_text).trim())) {
    return `Действие "${preset.displayLabel}" требует выделенного фрагмента (selected_text)`;
  }
  // user_prompt всегда желателен; для factcheck/expand_section/custom — обязателен
  const requiresPrompt = action === 'factcheck' || action === 'expand_section' || action === 'custom';
  if (requiresPrompt && (!user_prompt || !String(user_prompt).trim())) {
    return `Действие "${preset.displayLabel}" требует пользовательский промпт (user_prompt)`;
  }

  if (preset.needsExtra) {
    const schema = preset.extraSchema || {};
    for (const [field, rule] of Object.entries(schema)) {
      const required = String(rule).includes('required');
      const value    = extra_params && extra_params[field];
      if (required && (value === undefined || value === null || String(value).trim() === '')) {
        return `Действие "${preset.displayLabel}" требует параметр extra_params.${field}`;
      }
    }
  }

  return null;
}

function getPreset(action) {
  return PRESETS[action] || null;
}

function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({
    action:        key,
    label:         p.displayLabel,
    needsSelected: p.needsSelected,
    needsArticle:  p.needsArticle,
    needsLsi:      p.needsLsi,
    needsExtra:    p.needsExtra,
    extraSchema:   p.extraSchema,
    applyMode:     p.applyMode || 'auto',
  }));
}

module.exports = { PRESETS, validateRequest, getPreset, listPresets };
