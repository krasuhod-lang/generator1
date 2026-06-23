'use strict';

/**
 * reports/modules/settings.js — пороги модулей отчёта (ТЗ §3.1 project_settings).
 *
 * Значения по умолчанию совпадают со спецификацией. Реальные значения для
 * проекта берутся из таблицы project_report_settings (см. dataAggregator),
 * а здесь — нормализация и дефолты, чтобы чистые модули не зависели от БД.
 */

const DEFAULT_SETTINGS = Object.freeze({
  ctr_low_threshold: 0.02, // зарезервировано (нижний абсолютный порог CTR)
  ctr_high_impressions: 500, // минимум показов для срабатывания CTR Gap
  striking_pos_min: 11,
  striking_pos_max: 20,
  ctr_benchmark_top10: 0.025, // benchmark CTR для позиции 10 (Opportunity Score)
  report_language: 'ru',
});

function _num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Свести произвольный объект настроек к полному нормализованному виду. */
function normalizeSettings(input = {}) {
  const s = input || {};
  const out = {
    ctr_low_threshold: _num(s.ctr_low_threshold, DEFAULT_SETTINGS.ctr_low_threshold),
    ctr_high_impressions: Math.max(0, Math.round(_num(s.ctr_high_impressions, DEFAULT_SETTINGS.ctr_high_impressions))),
    striking_pos_min: Math.max(1, Math.round(_num(s.striking_pos_min, DEFAULT_SETTINGS.striking_pos_min))),
    striking_pos_max: Math.max(1, Math.round(_num(s.striking_pos_max, DEFAULT_SETTINGS.striking_pos_max))),
    ctr_benchmark_top10: _num(s.ctr_benchmark_top10, DEFAULT_SETTINGS.ctr_benchmark_top10),
    report_language: String(s.report_language || DEFAULT_SETTINGS.report_language).slice(0, 10),
  };
  if (out.striking_pos_max < out.striking_pos_min) {
    [out.striking_pos_min, out.striking_pos_max] = [out.striking_pos_max, out.striking_pos_min];
  }
  return out;
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings };
