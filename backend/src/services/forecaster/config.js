'use strict';

/**
 * forecaster/config.js — конфигурация модуля «Прогнозатор».
 *
 * Значения зашиты прямо в код намеренно, по требованию владельца продукта
 * (см. memory «env configuration»). Никакого чтения из process.env здесь нет.
 * Чтобы поменять кривую CTR, порог аномалий или метод прогноза — отредактируй
 * соответствующее поле и перезапусти backend.
 */

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

const FORECASTER_CONFIG = deepFreeze({
  // ── Парсер CSV / XLSX ────────────────────────────────────────────
  parser: {
    maxFileBytes:   10 * 1024 * 1024, // 10 MB
    maxRows:        50000,            // защитный потолок
    csvDelimiters:  [';', ',', '\t', '|'],
    encodingFallback: 'utf-8',
  },

  // ── Детектор аномалий (зон падения спроса) ───────────────────────
  // baseline = медиана предыдущих `baselineWindow` точек; падение
  // считаем, если value <= baseline * (1 - minDropPct) и спад
  // продолжался не меньше `minRunMonths` подряд.
  anomalies: {
    baselineWindow: 6,
    minDropPct:     0.20,   // ≥20 % ниже бейзлайна
    minRunMonths:   2,      // подряд минимум 2 месяца
    severityHigh:   0.40,   // ≥40 % падение → severity=high
    severityMid:    0.25,   // ≥25 % → mid; иначе low
  },

  // ── Прогноз ──────────────────────────────────────────────────────
  forecast: {
    horizonMonths: 12,
    season:        12,      // годовая сезонность
    // Грид-серч параметров Holt-Winters: α (level), β (trend), γ (season).
    gridAlpha:     [0.1, 0.3, 0.5, 0.7, 0.9],
    gridBeta:      [0.0, 0.1, 0.3, 0.5],
    gridGamma:     [0.0, 0.1, 0.3, 0.5, 0.7],
    // Минимальная длина ряда для Holt-Winters; иначе fallback на трендовую модель.
    minPointsForHoltWinters: 18,
    // Минимум для любой осмысленной модели; меньше → возвращаем плоский прогноз.
    minPointsForAnyModel:    4,
    // 95 % CI ≈ ±1.96 σ residuals (используется для зоны неопределённости).
    confidenceZ:   1.96,
  },

  // ── Модель оценки трафика при росте позиции ──────────────────────
  // CTR-кривые по позициям 1..10 (агрегированные публичные данные;
  // числа можно подкрутить, если будет своя статистика).
  // Источник: усреднённые значения по обзорам AWR/Yandex.WS/Sistrix
  // 2023-2024 для коммерческой выдачи RU. Хранятся в коде, чтобы
  // изменения CTR-моделей не требовали правок .env.
  traffic: {
    // Сумма используется для нормирования при «расчёте текущей доли»
    // вокруг top-10 (позиции 11+ суммарно дают < 5 %).
    ctrByPosition: {
      1:  0.281,
      2:  0.157,
      3:  0.109,
      4:  0.080,
      5:  0.061,
      6:  0.047,
      7:  0.038,
      8:  0.031,
      9:  0.026,
      10: 0.022,
    },
    // Усреднённый CTR группы (для оценки трафика при ВХОДЕ в группу,
    // когда позиция внутри группы неизвестна).
    avgCtrTop3:  0.182, // (0.281+0.157+0.109)/3
    avgCtrTop5:  0.138,
    avgCtrTop10: 0.085,
    // Если пользователь НЕ указал текущий трафик, считаем «как если
    // бы мы были на позиции defaultCurrentPosition» (≈ топ-20-30).
    defaultCurrentCtr: 0.005,
  },

  // ── DeepSeek-аналитик ────────────────────────────────────────────
  deepseek: {
    // Гейт фичи: на случай если ключа нет — пайплайн просто пропускает шаг.
    enabled:       true,
    temperature:   0.3,
    maxTokens:     1500,
    timeoutMs:     60000,
  },

  // ── Share-ссылка ─────────────────────────────────────────────────
  share: {
    tokenBytes:    12,   // 12 bytes base64url ≈ 16 символов
  },
});

function getForecasterConfig() {
  return FORECASTER_CONFIG;
}

module.exports = { getForecasterConfig };
