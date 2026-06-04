/**
 * clipboard.js — единый помощник копирования в буфер обмена.
 *
 * Использует Async Clipboard API, а при его отсутствии/запрете (HTTP, старые
 * браузеры, iframe без permissions) — откатывается на execCommand('copy').
 * Возвращает Promise<boolean>: true, если копирование удалось.
 */

function _fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * Копирует строку в буфер обмена.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  const value = text == null ? '' : String(text);
  if (!value) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      // упадём в fallback ниже
    }
  }
  return _fallbackCopy(value);
}

/**
 * Собирает таблицу (массив массивов ячеек) в TSV-строку, удобную для вставки
 * в Google Sheets / Excel без потери колонок.
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function toTsv(rows) {
  return (rows || [])
    .map((row) => (row || [])
      .map((cell) => String(cell == null ? '' : cell).replace(/[\t\n\r]+/g, ' ').trim())
      .join('\t'))
    .join('\n');
}
