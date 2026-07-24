'use strict';

const { richTextToPlain } = require('./stripHtmlTags');

/**
 * fillPromptVars — заменяет плейсхолдеры «Входные данные» в system-промптах
 * реальными значениями из объекта task.
 *
 * Каждый промпт содержит строки вида:
 *   - Ниша: [тема]
 *   - Гео: [страна / регион / город / мультирегиональность]
 *   ...
 * Функция находит такие строки по ключевому слову перед «:» и подставляет
 * реальное значение из task вместо текста в квадратных скобках.
 *
 * @param {string} prompt  — исходный system-промпт
 * @param {object} task    — строка из таблицы tasks (или объект с теми же полями)
 * @returns {string}       — промпт с подставленными значениями
 */
function fillPromptVars(prompt, task) {
  if (!prompt || !task) return prompt || '';

  // ── FR5 (V6): обязательная инъекция актуального года ──────────────────
  // Freshness-контракт: контент должен опираться на реальный текущий год,
  // а не на захардкоженный литерал (Google прямо предупреждает против
  // косметической смены даты). Год берём из task.current_year (если явно
  // передан — например для тестов/бэкдейтинга) или из системного времени.
  // Подставляем во все распространённые плейсхолдеры:
  //   {{CURRENT_YEAR}}, {CURRENT_YEAR}, [текущий год], [год].
  const currentYear = String(
    (task && (task.current_year || task.currentYear)) || new Date().getFullYear(),
  );
  prompt = prompt
    .replace(/\{\{\s*CURRENT_YEAR\s*\}\}/g, currentYear)
    .replace(/\{\s*CURRENT_YEAR\s*\}/g, currentYear)
    .replace(/\[\s*текущий\s+год\s*\]/gi, currentYear)
    .replace(/\[\s*год\s*\]/gi, currentYear);

  // ── Generic {{input_*}} substitution ─────────────────────────────────
  // Некоторые расширенные промпты (напр. perplexityResearcher) ссылаются на
  // поля задачи напрямую через {{input_target_service}} / {{input_region}}.
  // Подставляем ТОЛЬКО поля с префиксом input_ (uppercase-плейсхолдеры вроде
  // {{BUSINESS_TYPE}} заполняются позже в stage3.js и здесь не затрагиваются).
  prompt = prompt.replace(/\{\{\s*(input_[a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(task, key) && task[key] != null && task[key] !== '') {
      return richTextToPlain(String(task[key]));
    }
    return m;
  });

  // Маппинг: regex для строки → значение из task
  // Каждый regex ищет «- <Ключевое слово>...: [...]» и заменяет содержимое скобок
  const rules = [
    {
      // - Ниша: [тема]
      re: /^(- Ниша:\s*)\[.*?\]/gm,
      val: () => task.input_target_service || '[не указано]',
    },
    {
      // - Гео: [страна / регион / город ...]
      re: /^(- Гео:\s*)\[.*?\]/gm,
      val: () => task.input_region || '[не указано]',
    },
    {
      // - Язык: [язык]
      re: /^(- Язык:\s*)\[.*?\]/gm,
      val: () => task.input_language || 'ru',
    },
    {
      // - Тип бизнеса: [...]
      re: /^(- Тип бизнеса:\s*)\[.*?\]/gm,
      val: () => task.input_business_type || '[не указано]',
    },
    {
      // - Тип сайта: [...]
      re: /^(- Тип сайта:\s*)\[.*?\]/gm,
      val: () => task.input_site_type || '[не указано]',
    },
    {
      // - Целевая аудитория: [описание]
      re: /^(- Целевая аудитория:\s*)\[.*?\]/gm,
      val: () => richTextToPlain(task.input_target_audience) || '[не указано]',
    },
    {
      // - Приоритетная бизнес-цель / Приоритетная цель: [...]
      re: /^(- Приоритетная\s+(?:бизнес-)?цель:\s*)\[.*?\]/gm,
      val: () => task.input_business_goal || '[не указано]',
    },
    {
      // - Основной тип монетизации / Модель монетизации / Монетизация: [...]
      re: /^(- (?:Основной\s+тип\s+м|М)онетизаци[яи](?:,\s*если\s+известна)?:\s*)\[.*?\]/gm,
      val: () => task.input_monetization || '[не указано]',
    },
    {
      // - Модель монетизации: [...] (вариант без "Основной тип")
      re: /^(- Модель\s+монетизации(?:,\s*если\s+известна)?:\s*)\[.*?\]/gm,
      val: () => task.input_monetization || '[не указано]',
    },
    {
      // - Если есть, список конкурентов: [вставить]
      // - Конкуренты, если есть: [список]
      // - Основные конкуренты, если есть: [список]
      re: /^(- (?:Если есть, список конкурентов|(?:Основные )?[Кк]онкуренты(?:,\s*если\s+есть)?):\s*)\[.*?\]/gm,
      val: () => {
        const urls = (task.input_competitor_urls || '').trim();
        return urls || '[не указано]';
      },
    },
    {
      // - Если есть, ограничения проекта: [...]
      // - Ограничения, если есть: [...]
      re: /^(- (?:Если есть, ограничения проекта|Ограничения(?:,\s*если\s+есть)?):\s*)\[.*?\]/gm,
      val: () => richTextToPlain(task.input_project_limits) || '[не указано]',
    },
    {
      // - Если есть, приоритетные типы страниц: [...]
      re: /^(- Если есть, приоритетные типы страниц:\s*)\[.*?\]/gm,
      val: () => richTextToPlain(task.input_page_priorities) || '[не указано]',
    },
    {
      // - Если есть, особенности ниши: [...]
      re: /^(- Если есть, особенности ниши:\s*)\[.*?\]/gm,
      val: () => richTextToPlain(task.input_niche_features) || '[не указано]',
    },
    {
      // - Основной продукт / услуга / категории: [список]
      re: /^(- Основной продукт\s*\/\s*услуга\s*\/\s*категории:\s*)\[.*?\]/gm,
      val: () => task.input_target_service || '[не указано]',
    },
  ];

  let result = prompt;
  for (const { re, val } of rules) {
    result = result.replace(re, (match, prefix) => `${prefix}${val()}`);
  }

  return result;
}

module.exports = { fillPromptVars };
