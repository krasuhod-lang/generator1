'use strict';

/**
 * images/slug — детерминированная транслитерация RU→LAT и построение
 * filename_slug для SEO-friendly имён файлов изображений.
 *
 * Без внешних зависимостей: чистая функция, тот же вход → тот же выход.
 */

const RU_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};

/**
 * transliterate — переводит строку в латиницу по таблице RU_MAP.
 * Небуквенные символы сохраняются как есть (нормализуются в slugify).
 */
function transliterate(input) {
  const s = String(input || '');
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(RU_MAP, lower)) {
      const mapped = RU_MAP[lower];
      out += ch === lower ? mapped : (mapped ? mapped[0].toUpperCase() + mapped.slice(1) : '');
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * slugify — строит безопасный slug: транслит → lower → только [a-z0-9-],
 * коллапс дефисов, обрезка до maxLen (по границе дефиса), fallback 'image'.
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {number} [opts.maxLen=60]
 * @param {string} [opts.fallback='image']
 */
function slugify(input, opts = {}) {
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : 60;
  const fallback = opts.fallback || 'image';
  let s = transliterate(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    // Не обрываем посередине слова — режем по последнему дефису.
    const lastDash = s.lastIndexOf('-');
    if (lastDash > maxLen * 0.5) s = s.slice(0, lastDash);
    s = s.replace(/-+$/g, '');
  }
  return s || fallback;
}

module.exports = { transliterate, slugify, RU_MAP };
