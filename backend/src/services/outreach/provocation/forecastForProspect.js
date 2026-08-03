'use strict';
/**
 * forecastForProspect — персональный прогноз под лида + публичная share-ссылка.
 *
 * Поток:
 *   1) маркерные запросы домена лида (keys.so) → source.keywords;
 *   2) создаём forecaster_tasks (target_url = сайт лида, region = его город);
 *   3) прогоняем пайплайн до конца (в слоте пользователя);
 *   4) выпускаем share-токен;
 *   5) сохраняем токен у лида, отдаём URL /forecast/share/:token.
 *
 * Идемпотентно: если у лида уже есть готовый прогноз — просто возвращаем ссылку.
 * ИЗОЛЯЦИЯ: переиспуем экспортированные функции прогнозатора, ничего не меняя.
 */
const db = require('../../../config/db');
const { processForecasterTask } = require('../../forecaster/forecasterPipeline');
const { withUserSlot } = require('../../../utils/perUserConcurrency');
const { generateShareToken } = require('../../forecaster/shareToken');
const { resolveRegionLr } = require('../../forecaster/arsenkinClient');
const { fetchDomainKeywords, resolveBase } = require('./keyssoEnrich');

const MAX_MARKER_KEYWORDS = 120;

function _normUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function _publicUrl(appUrl, token) {
  const base = String(appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
  return `${base}/forecast/share/${token}`;
}

/**
 * Гарантирует прогноз + ссылку для лида.
 * @param {object} prospect — outreach_prospects (url, city, user_id, forecast_*)
 * @param {object} [opts]
 * @param {object} [opts.campaign]  — кампания (для user_id/keyword fallback)
 * @param {string} [opts.appUrl]    — база публичного URL (по умолч. process.env.APP_URL)
 * @returns {Promise<null | {forecast_task_id:string, share_token:string, status:string, url:string}>}
 */
async function ensureForecastForProspectV2(prospect, opts = {}) {
  const { campaign, appUrl } = opts;
  if (!prospect || !prospect.url) return null;

  // Идемпотентность: готовый прогноз уже есть.
  if (prospect.forecast_status === 'done' && prospect.forecast_share_token) {
    return {
      forecast_task_id: prospect.forecast_task_id,
      share_token: prospect.forecast_share_token,
      status: 'done',
      url: _publicUrl(appUrl, prospect.forecast_share_token),
    };
  }

  const userId = prospect.user_id || campaign?.user_id;
  if (!userId) return null;

  // 1. Маркерные запросы домена лида.
  const base = resolveBase(prospect.city);
  let keywords = [];
  try {
    const kws = await fetchDomainKeywords(prospect.url, { base });
    keywords = kws
      .filter((k) => k.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .map((k) => k.phrase)
      .slice(0, MAX_MARKER_KEYWORDS);
  } catch (err) {
    console.warn(`[forecastForProspect] keywords failed: ${err.message}`);
  }
  if (!keywords.length && campaign?.keyword) keywords = [campaign.keyword];
  if (!keywords.length) return null;

  // 2. Создаём forecaster-задачу.
  const options = {
    target_url: _normUrl(prospect.url),
    region: prospect.city || '',
    region_lr: resolveRegionLr(prospect.city),
    intent: 'lead_gen',
    notes: 'Автопрогноз для outreach (провокационный режим)',
  };
  let taskId;
  try {
    const { rows } = await db.query(
      `INSERT INTO forecaster_tasks (user_id, name, status, source_filename, options, source_columns)
       VALUES ($1, $2, 'queued', $3, $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        userId,
        `Прогноз (outreach): ${prospect.url}`,
        `outreach: ${keywords.length} запросов`,
        JSON.stringify(options),
        JSON.stringify({ keywords }),
      ],
    );
    taskId = rows[0].id;
  } catch (err) {
    console.warn(`[forecastForProspect] insert task failed: ${err.message}`);
    return null;
  }

  // 3. Считаем прогноз до конца (в слоте пользователя, как в контроллере).
  try {
    await withUserSlot(userId, () => processForecasterTask(taskId));
  } catch (err) {
    console.warn(`[forecastForProspect] pipeline failed: ${err.message}`);
  }

  // 4. Проверяем статус.
  const { rows: st } = await db.query('SELECT status FROM forecaster_tasks WHERE id = $1', [taskId]);
  const status = st[0]?.status || 'failed';
  if (status !== 'done') {
    await _mark(prospect.id, taskId, null, status);
    return null;
  }

  // 5. Выпускаем share-токен (с обработкой коллизии уникального индекса).
  let token = null;
  for (let i = 0; i < 3; i++) {
    const t = generateShareToken();
    try {
      const { rowCount } = await db.query(
        `UPDATE forecaster_tasks
            SET share_token = $2, share_created_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND share_token IS NULL`,
        [taskId, t],
      );
      // Если share_token уже был выставлен ранее — забираем существующий.
      if (rowCount === 0) {
        const { rows } = await db.query('SELECT share_token FROM forecaster_tasks WHERE id = $1', [taskId]);
        token = rows[0]?.share_token || null;
      } else {
        token = t;
      }
      break;
    } catch (err) {
      if (err && err.code === '23505') continue; // collision → пробуем другой токен
      console.warn(`[forecastForProspect] share failed: ${err.message}`);
      break;
    }
  }
  if (!token) {
    await _mark(prospect.id, taskId, null, 'done');
    return null;
  }

  // 6. Сохраняем у лида.
  await _mark(prospect.id, taskId, token, 'done');
  return { forecast_task_id: taskId, share_token: token, status: 'done', url: _publicUrl(appUrl, token) };
}

/** Записывает результат прогноза в outreach_prospects (best-effort). */
async function _mark(prospectId, taskId, token, status) {
  if (!prospectId) return;
  try {
    await db.query(
      `UPDATE outreach_prospects
          SET forecast_task_id = $2, forecast_share_token = $3, forecast_status = $4
        WHERE id = $1`,
      [prospectId, taskId, token, status],
    );
  } catch (err) {
    console.warn(`[forecastForProspect] mark failed: ${err.message}`);
  }
}

module.exports = { ensureForecastForProspectV2, _publicUrl };
