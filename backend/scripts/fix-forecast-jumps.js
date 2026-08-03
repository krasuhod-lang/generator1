/* eslint-disable no-console */
'use strict';

/**
 * fix-forecast-jumps.js — пересчёт уже сохранённых отчётов «Прогнозатора»
 * после фикса скачка трафика в первый месяц (ramp-up + cap прироста
 * в services/forecaster/unifiedForecast.js).
 *
 * Результаты моделей лежат в JSONB-полях forecaster_tasks (unified_forecast /
 * sov_forecast), поэтому изменение математики само по себе старые отчёты не
 * чинит — их нужно пересчитать из сохранённых входных данных
 * (monthly_series + forecast + options). Внешние API (Арсенкин/keys.so) при
 * этом НЕ дёргаются: коэффициенты C_serp / λ / коммерциализации берутся из
 * ранее сохранённых результатов.
 *
 * Использование:
 *   node backend/scripts/fix-forecast-jumps.js [--dry-run] [--id <uuid>] [--limit N]
 *
 *   --dry-run   только показать, что изменится (без UPDATE)
 *   --id        пересчитать одну задачу
 *   --limit     ограничить число задач (по умолчанию — все completed)
 */

const { buildUnifiedForecast } = require('../src/services/forecaster/unifiedForecast');
const { buildSovForecast } = require('../src/services/forecaster/sovForecast');
const { getForecasterConfig } = require('../src/services/forecaster/config');

function _clampInt(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function _sanitizeUnit(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// Тот же выбор CR, что и в forecasterPipeline: пользовательский CR →
// preset по intent → дефолт из config.leads.
function _resolveCrBase(options, cfg) {
  const userCr = Number(options.conversion_rate);
  if (Number.isFinite(userCr) && userCr >= cfg.leads.minCr && userCr <= cfg.leads.maxCr) return userCr;
  const intent = options.intent ? String(options.intent).trim() : null;
  if (intent && cfg.leads.intentPresets[intent] != null) return cfg.leads.intentPresets[intent];
  return cfg.leads.defaultConversionRate;
}

/**
 * SERP-элементы для пересчёта. Сырой список сохраняется в options только если
 * пользователь ввёл его руками; коллекторы Арсенкина отдают его в рантайме и
 * в БД не пишут. Поэтому при отсутствии списка восстанавливаем ЭКВИВАЛЕНТНЫЙ
 * штраф из сохранённого C_serp: C_serp = 1 − w_other·count → count.
 */
function _serpElementsFor(task, cfg) {
  const fromOptions = Array.isArray(task.options && task.options.serp_elements)
    ? task.options.serp_elements.filter((el) => el && Number(el.count) > 0)
    : [];
  if (fromOptions.length) return fromOptions;

  const cSerp = Number(
    (task.unified_forecast && task.unified_forecast.params && task.unified_forecast.params.c_serp)
    ?? (task.sov_forecast && task.sov_forecast.constants && task.sov_forecast.constants.c_serp),
  );
  if (!Number.isFinite(cSerp) || cSerp >= 1) return [];
  const wOther = Number((cfg.sov.serpWeights || {}).other) || 0.05;
  return [{ type: 'other', count: Math.max(0, (1 - cSerp) / wOther) }];
}

/** λ = clusterVolume / mainQueryVolume — восстанавливаем из sov_forecast. */
function _volumesFor(task) {
  const lambda = Number(task.sov_forecast && task.sov_forecast.constants && task.sov_forecast.constants.lambda);
  if (!Number.isFinite(lambda) || lambda < 1) return { clusterVolume: 0, mainQueryVolume: 0 };
  return { clusterVolume: lambda, mainQueryVolume: 1 };
}

/**
 * Пересчитывает unified/sov для одной задачи по сохранённым данным.
 * Чистая функция (без БД) — используется скриптом и тестами.
 *
 * @param {Object} task — строка forecaster_tasks (JSONB-поля уже распарсены)
 * @param {Object} cfg  — getForecasterConfig()
 * @returns {{unified:Object, sov:Object}|{skip:string}}
 */
function rebuildTaskForecast(task, cfg) {
  const options = (task && task.options) || {};
  const monthly = (task && task.monthly_series && Array.isArray(task.monthly_series.monthly))
    ? task.monthly_series.monthly : [];
  if (monthly.length < 3) return { skip: 'нет monthly_series (<3 месяцев)' };

  const forecastPoints = (task.forecast && Array.isArray(task.forecast.points)) ? task.forecast.points : [];
  const currentTraffic = Math.max(0, Number(options.current_traffic_per_month) || 0);
  const hMax = _clampInt(options.h_max, cfg.sov.hMaxDefault, 1, cfg.sov.hMaxLimit);
  const serpElements = _serpElementsFor(task, cfg);

  // Коммерциализация: сначала пользовательское значение, затем сохранённое
  // в результатах прошлого расчёта (Арсенкин повторно не дёргаем).
  let commPercent = _sanitizeUnit(options.comm_percent);
  if (commPercent == null && options.commercial_only === true) commPercent = 1.0;
  if (commPercent == null) {
    commPercent = _sanitizeUnit(
      task.unified_forecast && task.unified_forecast.params && task.unified_forecast.params.comm_percent,
    );
  }
  if (commPercent == null) commPercent = 1.0;

  const crBase = _resolveCrBase(options, cfg);
  const crFinal = Math.round(crBase * commPercent * 100000) / 100000;
  const { clusterVolume, mainQueryVolume } = _volumesFor(task);

  const unified = buildUnifiedForecast({
    monthly,
    forecastPoints,
    options: { ...options, h_max: hMax },
    currentTrafficPerMonth: currentTraffic,
    serpElements,
    commPercent,
    crFinal,
    cfg,
  });

  const sov = buildSovForecast({
    monthly,
    forecastPoints,
    vCurrent: currentTraffic,
    hMax,
    crBase,
    commPercent,
    serpElements,
    clusterVolume,
    mainQueryVolume,
    cfg,
    unifiedForecast: unified,
    startMonth: options.start_month || null,
  });

  return { unified, sov };
}

/** Обновляет unified_*-поля в leads_summary (шапка результата на фронте). */
function rebuildLeadsSummary(leadsSummary, unified) {
  if (!leadsSummary || typeof leadsSummary !== 'object') return null;
  return {
    ...leadsSummary,
    unified_annual:       unified?.summary?.annual?.value ?? null,
    unified_annual_lower: unified?.summary?.annual?.lower ?? null,
    unified_annual_upper: unified?.summary?.annual?.upper ?? null,
    unified_leads_annual: unified?.summary?.leads_annual ?? null,
  };
}

function _firstValue(unified) {
  const p = unified && Array.isArray(unified.forecast) ? unified.forecast[0] : null;
  return p ? p.value : null;
}

async function run() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const dryRun = args.includes('--dry-run');
  const onlyId = arg('id');
  const limit = Math.max(0, Number(arg('limit')) || 0);

  const db = require('../src/config/db');
  const cfg = getForecasterConfig();

  const where = ["status = 'completed'", 'unified_forecast IS NOT NULL'];
  const params = [];
  if (onlyId) {
    params.push(onlyId);
    where.push(`id = $${params.length}`);
  }
  let sql = `SELECT id, options, monthly_series, forecast, unified_forecast, sov_forecast, leads_summary
               FROM forecaster_tasks
              WHERE ${where.join(' AND ')}
              ORDER BY created_at ASC`;
  if (limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }

  const { rows } = await db.query(sql, params);
  console.log(`Найдено задач: ${rows.length}${dryRun ? ' (dry-run)' : ''}`);

  let updated = 0, skipped = 0, errors = 0;
  for (const task of rows) {
    try {
      const before = _firstValue(task.unified_forecast);
      const result = rebuildTaskForecast(task, cfg);
      if (result.skip) {
        skipped++;
        console.log(`- ${task.id}: пропуск — ${result.skip}`);
        continue;
      }
      if (result.unified.verdict !== 'ok') {
        skipped++;
        console.log(`- ${task.id}: пропуск — новый вердикт ${result.unified.verdict}`);
        continue;
      }
      const after = _firstValue(result.unified);
      console.log(`- ${task.id}: M1 ${before ?? '—'} → ${after ?? '—'}`);
      if (dryRun) { updated++; continue; }

      const leadsSummary = rebuildLeadsSummary(task.leads_summary, result.unified);
      await db.query(
        `UPDATE forecaster_tasks
            SET unified_forecast = $2::jsonb,
                sov_forecast     = $3::jsonb,
                leads_summary    = COALESCE($4::jsonb, leads_summary),
                updated_at       = NOW()
          WHERE id = $1`,
        [
          task.id,
          JSON.stringify(result.unified),
          JSON.stringify(result.sov),
          leadsSummary ? JSON.stringify(leadsSummary) : null,
        ],
      );
      updated++;
    } catch (e) {
      errors++;
      console.error(`- ${task.id}: ошибка — ${(e && e.message) || e}`);
    }
  }

  console.log(`Готово: обновлено ${updated}, пропущено ${skipped}, ошибок ${errors}`);
}

module.exports = { rebuildTaskForecast, rebuildLeadsSummary };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
