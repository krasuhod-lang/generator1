'use strict';

/**
 * tzFieldDeriver — «дожимает» описательные поля формы задачи, которых нет в
 * тексте ТЗ.
 *
 * Зачем: TZ_EXTRACTOR_PROMPT намеренно работает в режиме zero-hallucination —
 * «нет в тексте → null». Реальные ТЗ почти никогда не содержат отдельных
 * разделов «Ограничения проекта», «Приоритетные типы страниц», «Особенности
 * ниши», поэтому после загрузки файла эти поля формы оставались пустыми, а
 * дальше блокировали и остальные автозаполнения.
 *
 * Решение: отдельный, явно помеченный шаг вывода (inference). Он работает
 * ТОЛЬКО по недостающим полям, опирается на нишу/бизнес-тип/услуги из того же
 * ТЗ и запрещает придумывать цифры, лицензии, названия и цены. Результат —
 * предположение, которое пользователь видит в форме и может поправить.
 *
 * Kill-switch: TZ_DERIVE_ENABLED=false отключает шаг целиком.
 */

const { callLLM } = require('../llm/callLLM');

// Поля, которые имеет смысл выводить: ровно те описательные поля формы,
// которые оставались пустыми после загрузки ТЗ.
const DERIVABLE_FIELDS = ['target_audience', 'niche_features', 'constraints', 'priority_page_types'];
const ARRAY_FIELDS = new Set(['niche_features', 'constraints', 'priority_page_types']);

const MAX_TZ_CHARS = 12000;
const MAX_ITEMS    = 6;
const MAX_ITEM_LEN = 500;
// 2500 токенов не хватало на 4 развёрнутых поля — ответ обрывался и шаг
// молча возвращал «LLM не вернул JSON». callLLM сам удвоит лимит, если
// ответ всё же окажется обрезанным.
const MAX_OUTPUT_TOKENS = 6000;
const TIMEOUT_MS        = 180000;

const FIELD_SPECS = {
  target_audience:
    'target_audience — строка, 2–5 предложений: кто аудитория, их задачи (JTBD), боли, ' +
    'критерии выбора и сценарии обращения.',
  niche_features:
    'niche_features — массив из 2–5 строк: особенности ниши (YMYL/не-YMYL, сезонность, ' +
    'локальная привязка, уровень конкуренции, регуляторные требования, длина цикла принятия решения).',
  constraints:
    'constraints — массив из 2–4 строк: ограничения проекта (что нельзя обещать/писать, ' +
    'юридические и регуляторные рамки ниши, требования к тону и оформлению, ограничения по данным).',
  priority_page_types:
    'priority_page_types — массив из 2–4 строк: приоритетные типы страниц для этой ниши ' +
    'с пояснением, зачем они (коммерческие страницы услуг, категории, статьи, FAQ и т.д.).',
};

function isEnabled() {
  return String(process.env.TZ_DERIVE_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * Какие из derivable-полей реально пустые в результате экстрактора.
 * @param {object} extracted
 * @returns {string[]}
 */
function missingDerivableFields(extracted) {
  const ext = extracted && typeof extracted === 'object' ? extracted : {};
  return DERIVABLE_FIELDS.filter((field) => {
    const val = ext[field];
    if (val == null) return true;
    if (Array.isArray(val)) return val.filter((v) => String(v || '').trim()).length === 0;
    return !String(val).trim();
  });
}

/**
 * Достраивает недостающие поля. Никогда не бросает — при любой ошибке
 * возвращает { filled: [], error }.
 *
 * @param {string} tzText    — исходный текст ТЗ
 * @param {object} extracted — результат callExtractorLLM (мутируется на месте)
 * @returns {Promise<{ filled: string[], error: string|null }>}
 */
async function deriveMissingTzFields(tzText, extracted) {
  const missing = missingDerivableFields(extracted);
  if (!missing.length) return { filled: [], error: null };
  if (!isEnabled()) return { filled: [], error: null };

  const text = String(tzText || '').trim();
  if (text.length < 200) return { filled: [], error: null };

  const systemMsg =
    'Ты — SEO-стратег. По тексту ТЗ и уже извлечённым данным ты формулируешь недостающие ' +
    'аналитические поля брифа. Возвращай СТРОГО JSON без markdown-обёрток. ' +
    'ЗАПРЕЩЕНО придумывать конкретные цифры, цены, лицензии, награды, имена и названия компаний — ' +
    'если их нет в ТЗ, формулируй обобщённо («характерно для ниши…», «ожидание аудитории…»). ' +
    'Пиши по-русски, по делу, без воды и без markdown-разметки.';

  const userPrompt =
    'Уже известно из ТЗ:\n' + _knownFacts(extracted) + '\n\n' +
    'Текст ТЗ (может быть обрезан):\n"""\n' + text.slice(0, MAX_TZ_CHARS) + '\n"""\n\n' +
    'Сформулируй ТОЛЬКО следующие поля:\n' +
    missing.map((f) => `• ${FIELD_SPECS[f]}`).join('\n') + '\n\n' +
    'Верни ТОЛЬКО JSON-объект с этими ключами и никакими другими.';

  try {
    const parsed = await _callWithFallback(systemMsg, userPrompt);
    if (!parsed) return { filled: [], error: 'LLM не вернул JSON' };

    const filled = [];
    for (const field of missing) {
      const value = _normalizeValue(field, parsed[field]);
      if (value == null) continue;
      extracted[field] = value;
      filled.push(field);
    }
    return { filled, error: null };
  } catch (err) {
    return { filled: [], error: (err && err.message) || 'DeepSeek error' };
  }
}

/**
 * DeepSeek → Gemini (fail-soft). callLLM берёт на себя устойчивый парсинг
 * JSON, повтор с удвоенным лимитом токенов при обрыве ответа, семафор
 * провайдера и бэкофф на 429/503.
 *
 * @returns {Promise<object|null>} распарсенный объект либо null
 */
async function _callWithFallback(systemMsg, userPrompt) {
  const opts = {
    temperature: 0.3,
    maxTokens:   MAX_OUTPUT_TOKENS,
    timeoutMs:   TIMEOUT_MS,
    retries:     2,
    stageName:   'tz_derive',
    callLabel:   'TZ Field Deriver',
  };

  for (const adapter of ['deepseek', 'gemini']) {
    try {
      const parsed = await callLLM(adapter, systemMsg, userPrompt, opts);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      console.warn(`[tzFieldDeriver] ${adapter} вернул не-объект — пробуем следующий провайдер`);
    } catch (err) {
      console.warn(`[tzFieldDeriver] ${adapter} failed: ${err.message}`);
    }
  }
  return null;
}

/** Короткая сводка уже извлечённых данных — контекст для вывода. */
function _knownFacts(extracted) {
  const ext = extracted && typeof extracted === 'object' ? extracted : {};
  const parts = [];
  const push = (label, value) => {
    if (value == null) return;
    const str = Array.isArray(value)
      ? value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 8).join('; ')
      : String(value).trim();
    if (str) parts.push(`${label}: ${str.slice(0, 600)}`);
  };
  push('Ключевой запрос', ext.keyword);
  push('Ниша', ext.niche);
  push('Регион', ext.geo);
  push('Тип бизнеса', ext.business_type);
  push('Бизнес-цель', ext.business_goal);
  push('Монетизация', ext.monetization);
  push('Продукты/услуги', ext.products_services);
  push('УТП', ext.brand_usp);
  push('Целевая аудитория', ext.target_audience);
  push('Требования к контенту', ext.content_requirements);
  return parts.length ? parts.join('\n') : '(в ТЗ почти нет структурированных данных)';
}

/** Приводит значение к типу поля из TZ_SCHEMA; пустое → null. */
function _normalizeValue(field, value) {
  if (value == null) return null;
  if (ARRAY_FIELDS.has(field)) {
    const arr = Array.isArray(value) ? value : String(value).split('\n');
    const items = arr
      .map((v) => String(v || '').replace(/^[\s•\-*]+/, '').trim().slice(0, MAX_ITEM_LEN))
      .filter(Boolean)
      .slice(0, MAX_ITEMS);
    return items.length ? items : null;
  }
  const str = (Array.isArray(value) ? value.join('; ') : String(value)).trim();
  return str ? str.slice(0, 4000) : null;
}

module.exports = {
  deriveMissingTzFields,
  missingDerivableFields,
  DERIVABLE_FIELDS,
};
