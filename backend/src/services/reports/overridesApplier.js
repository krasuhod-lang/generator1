'use strict';

/**
 * overridesApplier — применение ручных правок (ТЗ §6) поверх собранного
 * data-пейлоада отчёта.
 *
 * Формат overrides — плоский dot-path словарь:
 *   {
 *     "gsc.totals.clicks": 12345,
 *     "queries.top_queries_commercial[0].position": 4.2,
 *     "summary.executive_summary": "Текст после ручной правки",
 *     "completeness.has_partial": false
 *   }
 *
 * Поддерживается индексация `arr[N]` (только целые неотрицательные индексы).
 * Точки и квадратные скобки — единственные разделители; чтобы избежать
 * prototype-pollution, ключи `__proto__`, `prototype`, `constructor` молча
 * пропускаются (см. `_isSafeKey`).
 *
 * Контракт:
 *   - applyOverrides(data, overrides) → возвращает ИЗМЕНЁННЫЙ data
 *     (in-place мутация; вызывающая сторона должна быть готова к этому
 *     или сделать clone снаружи). Также мутация добавляет в каждом
 *     затронутом объекте поле _overrides: [<lastPathSegment>] — чтобы UI
 *     мог нарисовать бейдж «✏️ изменено вручную» рядом со значением.
 *   - deepMerge(existing, patch) → для PATCH /overrides эндпоинта:
 *     склеивает плоские dot-path словари; ключи patch=null/undefined
 *     удаляют запись из existing (sentinel-удаление с фронта).
 */

const SAFE_KEY_RE = /^[A-Za-z0-9_]+$/;

function _isSafeKey(key) {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
  return SAFE_KEY_RE.test(key);
}

/**
 * Разбирает dot-path с поддержкой `[N]` в массив сегментов.
 * Возвращает null, если путь невалиден (пустой / содержит запрещённый ключ).
 *   "a.b[2].c" → ['a', 'b', 2, 'c']
 */
function parsePath(path) {
  if (typeof path !== 'string' || !path.length) return null;
  const out = [];
  // Регулярка ловит либо `name`, либо `[N]`. Всё прочее → невалидный путь.
  const re = /([A-Za-z0-9_]+)|\[(\d+)\]/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(path)) !== null) {
    // Между токенами допустима только точка (или ничего, если перед [N])
    const between = path.slice(lastIndex, m.index);
    if (between.length && between !== '.') return null;
    if (m[1] !== undefined) {
      if (!_isSafeKey(m[1])) return null;
      out.push(m[1]);
    } else {
      out.push(Number(m[2]));
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== path.length) return null;
  return out.length ? out : null;
}

/**
 * Применяет одну правку value по пути segments к target.
 * Создаёт промежуточные объекты/массивы по мере необходимости
 * (если следующий сегмент — число, создаём [], иначе {}).
 * Возвращает ссылку на родителя последнего сегмента (для аудита).
 */
function _setAtPath(target, segments, value) {
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const nextKey = segments[i + 1];
    const wantArray = typeof nextKey === 'number';
    if (typeof key === 'number') {
      if (!Array.isArray(node)) return null;
      if (node[key] == null || typeof node[key] !== 'object') {
        node[key] = wantArray ? [] : {};
      }
      node = node[key];
    } else {
      if (!_isSafeKey(key)) return null;
      if (node == null || typeof node !== 'object' || Array.isArray(node)) return null;
      if (node[key] == null || typeof node[key] !== 'object') {
        node[key] = wantArray ? [] : {};
      }
      node = node[key];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last === 'number') {
    if (!Array.isArray(node)) return null;
    node[last] = value;
  } else {
    if (!_isSafeKey(last) || node == null || typeof node !== 'object' || Array.isArray(node)) return null;
    node[last] = value;
  }
  return { parent: node, lastKey: last };
}

/**
 * Применяет dot-path словарь overrides к data. См. JSDoc файла.
 * Игнорирует невалидные пути (логируем в console.warn), чтобы кривая правка
 * не валила весь рендер.
 */
function applyOverrides(data, overrides) {
  if (!data || typeof data !== 'object') return data;
  if (!overrides || typeof overrides !== 'object') return data;
  const touched = new Map(); // parentObject → Set(lastKey)
  for (const [path, value] of Object.entries(overrides)) {
    const segments = parsePath(path);
    if (!segments) {
      console.warn('[reports][overrides] invalid path skipped:', path);
      continue;
    }
    const res = _setAtPath(data, segments, value);
    if (!res) {
      console.warn('[reports][overrides] could not set path:', path);
      continue;
    }
    if (!touched.has(res.parent)) touched.set(res.parent, new Set());
    touched.get(res.parent).add(res.lastKey);
  }
  // Расставляем флаги _overrides для UI-бейджей.
  for (const [parent, keys] of touched.entries()) {
    if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
      parent._overrides = Array.from(keys).map(String);
    }
  }
  return data;
}

/**
 * Плоский merge patch'а в existing с поддержкой sentinel-удаления.
 * existing и patch — оба плоские словари. Возвращает новый словарь.
 * Значение null или undefined в patch → ключ удаляется из existing.
 */
function deepMerge(existing, patch) {
  const base = (existing && typeof existing === 'object') ? { ...existing } : {};
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

module.exports = {
  applyOverrides,
  deepMerge,
  parsePath,
};
