'use strict';

/**
 * salvageJsonStrings — вытаскивает строковые значения ключей из «почти JSON».
 *
 * Зачем: LLM-ответ может оборваться по лимиту токенов на середине последнего
 * (самого длинного) поля. `JSON.parse` в этом случае бросает, и потребитель
 * теряет ВСЕ поля, хотя модель успела написать большую их часть — именно так
 * форма «СЕО-текст» оставалась пустой при переходе из отчёта релевантности.
 *
 * Функция не пытается быть JSON-парсером: она находит `"key": "…"` и, для
 * последнего незакрытого значения, забирает хвост строки.
 *
 * @param {string} raw   — сырой текст ответа модели
 * @param {string[]} keys — какие ключи ищем
 * @returns {object|null} — объект с найденными строками либо null
 */
function salvageJsonStrings(raw, keys) {
  const text = String(raw || '');
  if (!text || !Array.isArray(keys) || !keys.length) return null;
  const out = {};
  for (const key of keys) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Чередование `\\.` / `[^"\\]` не пересекается по первому символу —
    // катастрофического бэктрекинга здесь нет.
    const closed = new RegExp('"' + escaped + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
    const open   = new RegExp('"' + escaped + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$');
    const m = closed.exec(text) || open.exec(text);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse('"' + m[1] + '"');
    } catch (_) {
      value = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    if (value && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { salvageJsonStrings };
