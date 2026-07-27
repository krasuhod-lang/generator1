'use strict';

/**
 * metaTags/lengthConfig — ЕДИНАЯ точка правды по длинам мета-тегов.
 *
 * Раньше коридоры дублировались в gistMetaFilter, metaGenerator, ctrScore и
 * (со своими числами!) в UI: бэкенд целился в Title 70–80 / Description
 * 180–190, а страница результатов подсвечивала 40–50 / 130–145 — счётчик у
 * корректной пары всегда горел жёлтым.
 *
 * Разделяем два понятия:
 *   • ЦЕЛЕВОЙ коридор (`*_TARGET_*`) — куда метим при генерации и за что даём
 *     полный балл CTR-скора. Description сознательно смещён вниз (150–170):
 *     в трёхсоставном описании на 185+ символов третье предложение почти
 *     всегда оказывается водой.
 *   • ЖЁСТКИЙ максимум (`*_MAX`) — граница обрезки в выдаче, за неё выходить
 *     нельзя ни при каких условиях.
 */

// ── Title ─────────────────────────────────────────────────────────
const TITLE_TARGET_MIN = 60;
const TITLE_TARGET_MAX = 70;
const TITLE_MAX = 80;          // жёсткий максимум (обрезка в выдаче)
const TITLE_MIN = TITLE_TARGET_MIN; // ниже — считаем title недописанным

// ── Description (desktop) ─────────────────────────────────────────
const DESC_TARGET_MIN = 150;
const DESC_TARGET_MAX = 170;
const DESC_MAX = 190;          // жёсткий максимум
const DESC_MIN = DESC_TARGET_MIN;

// ── Description (mobile) ──────────────────────────────────────────
const DESC_MOBILE_MIN = 90;
const DESC_MOBILE_MAX = 105;

// ── H1 ────────────────────────────────────────────────────────────
const H1_MAX = 70;

// GIST-фактор должен попасть в начало поля (окна «до обрезки в выдаче»).
const TITLE_FACT_WINDOW = 35;
const DESC_FACT_WINDOW = 90;

/**
 * Сериализуемое описание коридоров для API/UI (`GET /api/meta-tags/limits`).
 * Держим плоскую структуру: фронтенд подсвечивает длину по target-коридору и
 * предупреждает при выходе за hard-максимум.
 */
function describeLengthRanges() {
  return {
    title: {
      target_min: TITLE_TARGET_MIN,
      target_max: TITLE_TARGET_MAX,
      hard_max: TITLE_MAX,
    },
    description: {
      target_min: DESC_TARGET_MIN,
      target_max: DESC_TARGET_MAX,
      hard_max: DESC_MAX,
    },
    description_mobile: {
      target_min: DESC_MOBILE_MIN,
      target_max: DESC_MOBILE_MAX,
      hard_max: DESC_MOBILE_MAX,
    },
    h1: { target_min: 0, target_max: H1_MAX, hard_max: H1_MAX },
  };
}

module.exports = {
  TITLE_MIN,
  TITLE_MAX,
  TITLE_TARGET_MIN,
  TITLE_TARGET_MAX,
  DESC_MIN,
  DESC_MAX,
  DESC_TARGET_MIN,
  DESC_TARGET_MAX,
  DESC_MOBILE_MIN,
  DESC_MOBILE_MAX,
  H1_MAX,
  TITLE_FACT_WINDOW,
  DESC_FACT_WINDOW,
  describeLengthRanges,
};
