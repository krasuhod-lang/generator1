'use strict';

/**
 * LLM-fallback для извлечения юр. лица в serpB2b.
 *
 * Когда детерминированные методы (regex по footer/contacts + JSON-LD +
 * Dadata по ИНН) не дали результата, прогоняем чистый текст футера/
 * контактных страниц через LLM. Используем уже подключённый в проекте
 * адаптер DeepSeek — он дешёвый (~$0.14 / 1M output) и на нём уже
 * настроены rate-limit/budget guard'ы. Внешние ключи Anthropic/OpenAI
 * в проекте не требуются.
 *
 * Гейтинг: если в окружении нет `DEEPSEEK_API_KEY` (`callDeepSeek`
 * проверяет это сам) — вызов вернёт null без падения.
 *
 * Контракт ответа LLM: JSON `{"name": "ООО \"Ромашка\"" | null}`.
 *  Любое значение, не похожее на юр. лицо (ООО/АО/ПАО/ИП/НКО/ТОО или
 * полная форма «Общество с …»), отбрасывается.
 */

const { callLLM } = require('../llm/callLLM');

const SYSTEM_PROMPT =
  'You are an entity extractor for Russian B2B websites. Your task is to '
  + 'extract the official legal entity name of the company that OWNS or '
  + 'operates this website (containing ООО, АО, ПАО, ЗАО, ИП, НКО, ТОО, or '
  + 'the full form «Общество с ограниченной ответственностью» / '
  + '«Индивидуальный предприниматель») from the provided page text. '
  + 'The owner is normally found in the footer requisites, privacy policy, '
  + 'personal-data consent, contacts page, or «О компании» section, usually '
  + 'next to ИНН/ОГРН. '
  + 'IMPORTANT: do NOT return names of clients, partners, contractors, '
  + 'case studies, testimonials, or organizations merely mentioned on the '
  + 'page — only the entity that the site itself belongs to. '
  + 'Return ONLY a strict JSON object: {"name": "<official name as it appears, '
  + 'preserving quotes and form>" } or {"name": null} if no owner legal entity '
  + 'is present. Do not invent names, do not translate, do not include any '
  + 'commentary, do not include extra fields.';

const LEGAL_FORM_RE = /(?:^|[^А-Яа-яёЁA-Za-z])(ООО|ОАО|ЗАО|ПАО|АО|НКО|ТОО|ИП)\s/;
const FULL_FORM_RE = /(Общество\s+с\s+ограниченной\s+ответственностью|Акционерное\s+общество|Публичное\s+акционерное\s+общество|Открытое\s+акционерное\s+общество|Закрытое\s+акционерное\s+общество|Индивидуальный\s+предприниматель)/i;

function _looksLikeLegalEntity(name) {
  if (!name || typeof name !== 'string') return false;
  const s = name.trim();
  if (s.length < 3 || s.length > 200) return false;
  return LEGAL_FORM_RE.test(s) || FULL_FORM_RE.test(s);
}

/**
 * Нарезаем текст до разумного размера: footer/contacts обычно укладываются
 * в 3–5 KB, обрезаем до 6 KB чтобы не платить за длинный prompt.
 */
function _trimText(text, maxChars = 6000) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/**
 * @param {string} text — очищенный текст со страниц `/contacts` / `<footer>`.
 * @param {object} [opts]
 * @param {string} [opts.taskId]
 * @param {string} [opts.stageName]
 * @returns {Promise<string|null>}
 */
async function extractCompanyNameWithLLM(text, opts = {}) {
  const trimmed = _trimText(text);
  if (!trimmed) return null;

  // adapter='deepseek' — у нас есть проверка ключа внутри callDeepSeek;
  // если ключа нет, callLLM выбросит ошибку, которую мы перехватим и
  // вернём null (LLM-фолбэк опциональный).
  let parsed;
  try {
    parsed = await callLLM(
      'deepseek',
      SYSTEM_PROMPT,
      trimmed,
      {
        retries: 1,
        temperature: 0,
        maxTokens: 200,
        timeoutMs: 20000,
        taskId: opts.taskId || null,
        stageName: opts.stageName || 'serpB2b.companyLLM',
        callLabel: 'company-name',
      },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[serpB2b.companyLLM] failed: ${err.message}`);
    return null;
  }

  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim() : null;
  if (!name || name.toLowerCase() === 'null') return null;
  if (!_looksLikeLegalEntity(name)) return null;
  return name;
}

module.exports = {
  extractCompanyNameWithLLM,
  // for tests
  _looksLikeLegalEntity,
};
