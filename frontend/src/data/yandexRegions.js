/**
 * Backward-compatible entry point for the Yandex LR dictionary.
 * The canonical Russian snapshot lives in yandexRegionsRu.js.
 */
export {
  YANDEX_REGIONS,
  YANDEX_REGIONS_RU,
  findRegionByCode,
  regionParentLabel,
  searchRegions,
} from './yandexRegionsRu.js';

export { YANDEX_REGIONS as default } from './yandexRegionsRu.js';
