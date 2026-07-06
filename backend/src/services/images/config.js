'use strict';

/**
 * images/config — единая точка конфигурации content-grounded image pipeline.
 *
 * Читает ENV-переменные IMAGE_PIPELINE_* и отдаёт нормализованный,
 * замороженный snapshot. Все флаги по умолчанию подобраны так, чтобы
 * поведение существующих пайплайнов НЕ менялось, пока новый flow не
 * включён явно (backward compatibility — см. ТЗ «Требования к backward
 * compatibility»).
 *
 * ENV-контракт (документируется в .env.example / IMAGE_PIPELINE.md):
 *   IMAGE_PIPELINE_ENABLE_INTENT_PLANNER    = true|false   (default false)
 *   IMAGE_PIPELINE_ENABLE_SCENE_EXTRACTION  = true|false   (default false)
 *   IMAGE_PIPELINE_ENABLE_SEMANTIC_QA       = true|false   (default false)
 *   IMAGE_PIPELINE_STORAGE_MODE             = inline_base64|cdn_upload
 *   IMAGE_PIPELINE_REQUIRE_PRODUCTION_URL   = true|false   (default false)
 *   IMAGE_PIPELINE_GENERIC_SCORE_THRESHOLD  = 0..1         (default 0.65)
 *   IMAGE_PIPELINE_MAX_INLINE_IMAGES        = int 0..12    (default 6)
 *   IMAGE_PIPELINE_EDITORIAL_MODE_DEFAULT   = strict|relaxed (default strict)
 *   IMAGE_PIPELINE_SEMANTIC_QA_FALLBACK     = warn_only|hard_fail (default warn_only)
 *   IMAGE_PIPELINE_STORAGE_DIR              = абсолютный/относительный путь для файлов
 *   IMAGE_PIPELINE_PUBLIC_BASE_URL          = базовый URL, под которым доступна STORAGE_DIR
 */

const STORAGE_MODES = ['inline_base64', 'cdn_upload'];
const EDITORIAL_MODES = ['strict', 'relaxed'];
const QA_FALLBACKS = ['warn_only', 'hard_fail'];

function _bool(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  return String(raw).trim().toLowerCase() === 'true';
}

function _enum(name, allowed, dflt) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return allowed.includes(raw) ? raw : dflt;
}

function _float(name, dflt, min, max) {
  const v = parseFloat(process.env[name]);
  if (!Number.isFinite(v)) return dflt;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function _int(name, dflt, min, max) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return dflt;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * getImageConfig — возвращает актуальный snapshot конфигурации.
 *
 * Читает process.env при каждом вызове (тесты могут переопределять ENV
 * и получать свежий конфиг). Результат заморожен, чтобы исключить
 * случайные мутации у потребителей.
 */
function getImageConfig() {
  const cfg = {
    intentPlannerEnabled:   _bool('IMAGE_PIPELINE_ENABLE_INTENT_PLANNER', false),
    sceneExtractionEnabled: _bool('IMAGE_PIPELINE_ENABLE_SCENE_EXTRACTION', false),
    semanticQaEnabled:      _bool('IMAGE_PIPELINE_ENABLE_SEMANTIC_QA', false),
    storageMode:            _enum('IMAGE_PIPELINE_STORAGE_MODE', STORAGE_MODES, 'inline_base64'),
    requireProductionUrl:   _bool('IMAGE_PIPELINE_REQUIRE_PRODUCTION_URL', false),
    genericScoreThreshold:  _float('IMAGE_PIPELINE_GENERIC_SCORE_THRESHOLD', 0.65, 0, 1),
    maxInlineImages:        _int('IMAGE_PIPELINE_MAX_INLINE_IMAGES', 6, 0, 12),
    editorialModeDefault:   _enum('IMAGE_PIPELINE_EDITORIAL_MODE_DEFAULT', EDITORIAL_MODES, 'strict'),
    semanticQaFallback:     _enum('IMAGE_PIPELINE_SEMANTIC_QA_FALLBACK', QA_FALLBACKS, 'warn_only'),
    storageDir:             String(process.env.IMAGE_PIPELINE_STORAGE_DIR || '').trim(),
    publicBaseUrl:          String(process.env.IMAGE_PIPELINE_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  };
  return Object.freeze(cfg);
}

/**
 * isNewPipelineEnabled — «мастер-переключатель»: хотя бы один из
 * планировочных слоёв включён. Если false — пайплайны используют legacy
 * flow (section-based prompts). Semantic QA и storage могут включаться
 * независимо, но интент-планер — базовый вход нового flow.
 */
function isNewPipelineEnabled(cfg = getImageConfig()) {
  return Boolean(cfg.intentPlannerEnabled || cfg.sceneExtractionEnabled);
}

module.exports = {
  getImageConfig,
  isNewPipelineEnabled,
  STORAGE_MODES,
  EDITORIAL_MODES,
  QA_FALLBACKS,
};
