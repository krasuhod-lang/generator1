'use strict';

/**
 * aegis/shannonEntropy — детерминированный расчёт энтропии Шеннона H
 * для текста, по символам (буквы/цифры с нормализацией в lower-case).
 *
 * Используется на Этапе 0 (Рецепторы) Super-Core SEO для отбраковки
 * мусорного контента: если H < 3.5 — текст вырожденный (повторы,
 * случайный шум, низкий лексический разнообразие), отбраковываем.
 *
 * Чистая функция, без side-effects, без I/O.
 */

const { getAegisFlags } = require('./featureFlags');

/**
 * Нормализует текст: приводит к нижнему регистру, оставляет только
 * буквы/цифры (включая кириллицу) и пробел. Никаких символов препинания —
 * иначе они задирают энтропию у одного и того же текста.
 *
 * @param {string} text
 * @returns {string}
 */
function _normalize(text) {
  if (typeof text !== 'string') return '';
  // \p{L}\p{N} требует флага u; включает кириллицу/цифры разных алфавитов.
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
}

/**
 * shannonEntropy(text) — H в битах/символ (Shannon entropy).
 *
 *   H = -Σ p(c) · log2 p(c)
 *
 * @param {string} text
 * @returns {number} H в диапазоне [0, log2(unique_chars)]. Для русского текста
 *                  обычно 4.0–4.6; для англ. — 4.0–4.5; для мусора (повторы,
 *                  base64-шум одной буквы) → ниже 3.5.
 */
function shannonEntropy(text) {
  const normalized = _normalize(text);
  if (!normalized.length) return 0;

  const freq = new Map();
  for (const ch of normalized) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  const total = normalized.length;
  let H = 0;
  for (const count of freq.values()) {
    const p = count / total;
    H -= p * Math.log2(p);
  }
  return H;
}

/**
 * isLowEntropy(text, opts?) — true если текст следует отбраковать
 * как мусор (H < minEntropy и длина ≥ minLength).
 *
 * @param {string} text
 * @param {{ minEntropy?:number, minLength?:number }} [opts]
 * @returns {boolean}
 */
function isLowEntropy(text, opts = {}) {
  const flags = getAegisFlags().shannon;
  const minEntropy = Number.isFinite(opts.minEntropy) ? opts.minEntropy : flags.minEntropy;
  const minLength  = Number.isFinite(opts.minLength)  ? opts.minLength  : flags.minLength;

  if (typeof text !== 'string' || text.length < minLength) {
    return false; // слишком короткий — не отбраковываем
  }
  return shannonEntropy(text) < minEntropy;
}

/**
 * filterLowEntropyBlocks(blocks, opts?) — массово фильтрует массив
 * текстовых блоков (например, выдачу SERP-параграфов). Возвращает
 * { kept, dropped, stats: { dropped_count, min_h, max_h, avg_h_kept } }.
 *
 * @param {Array<{text:string, [k:string]:any}>} blocks
 * @param {{ minEntropy?:number, minLength?:number, textKey?:string }} [opts]
 */
function filterLowEntropyBlocks(blocks, opts = {}) {
  const textKey = opts.textKey || 'text';
  const kept = [];
  const dropped = [];
  const entropies = [];

  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!b || typeof b !== 'object') continue;
    const text = String(b[textKey] || '');
    const H = shannonEntropy(text);
    if (isLowEntropy(text, opts)) {
      dropped.push({ ...b, _shannon_h: Number(H.toFixed(3)) });
    } else {
      kept.push(b);
      entropies.push(H);
    }
  }

  const stats = {
    dropped_count: dropped.length,
    kept_count:    kept.length,
    min_h:         entropies.length ? Math.min(...entropies) : null,
    max_h:         entropies.length ? Math.max(...entropies) : null,
    avg_h_kept:    entropies.length ? entropies.reduce((s, v) => s + v, 0) / entropies.length : null,
  };
  return { kept, dropped, stats };
}

module.exports = {
  shannonEntropy,
  isLowEntropy,
  filterLowEntropyBlocks,
  _normalize, // экспонируем для unit-тестов
};
