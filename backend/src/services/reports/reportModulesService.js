'use strict';

/**
 * reports/reportModulesService.js — слой данных для модулей отчёта (ТЗ §1.4).
 *
 * Связывает чистую библиотеку reports/modules с источниками данных:
 *   • пороги — таблица project_report_settings (ТЗ §3.1);
 *   • Striking Distance / CTR Gap — срез GSC query×page (gscService);
 *   • Tech Audit / Off-Page — таблицы report_tech_audit / report_backlinks;
 *   • частотности — карта query→volume (Keys.so, опционально).
 *
 * Все обращения к внешним API/БД устойчивы к ошибкам: модуль никогда не валит
 * агрегацию отчёта, а возвращает пустой/частичный результат.
 */

const db = require('../../config/db');
const gscService = require('../projects/gscService');
const { assembleModules } = require('./modules');
const { DEFAULT_SETTINGS } = require('./modules/settings');

async function loadSettings(projectId) {
  try {
    const { rows } = await db.query(
      `SELECT ctr_low_threshold, ctr_high_impressions, striking_pos_min, striking_pos_max, report_language
         FROM project_report_settings WHERE project_id = $1`,
      [projectId],
    );
    if (!rows[0]) return { ...DEFAULT_SETTINGS };
    const r = rows[0];
    return {
      ctr_low_threshold: Number(r.ctr_low_threshold),
      ctr_high_impressions: Number(r.ctr_high_impressions),
      striking_pos_min: Number(r.striking_pos_min),
      striking_pos_max: Number(r.striking_pos_max),
      report_language: r.report_language || 'ru',
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function loadTechAudit(projectId) {
  try {
    const { rows } = await db.query(
      `SELECT url, total_images, images_no_alt, images_no_title, images_non_webp,
              page_size_kb, http_status, audited_at
         FROM report_tech_audit WHERE project_id = $1
        ORDER BY audited_at DESC`,
      [projectId],
    );
    return rows.map((r) => ({
      url: r.url,
      total_images: Number(r.total_images) || 0,
      images_no_alt: Number(r.images_no_alt) || 0,
      images_no_title: Number(r.images_no_title) || 0,
      images_non_webp: Number(r.images_non_webp) || 0,
      images_no_alt_ratio: Number(r.total_images) > 0 ? Number(r.images_no_alt) / Number(r.total_images) : 0,
      webp_ratio: Number(r.total_images) > 0 ? (Number(r.total_images) - Number(r.images_non_webp)) / Number(r.total_images) : null,
      page_size_kb: Number(r.page_size_kb) || 0,
      http_status: r.http_status != null ? Number(r.http_status) : null,
    }));
  } catch (_) {
    return [];
  }
}

async function loadBacklinks(projectId) {
  try {
    const { rows } = await db.query(
      `SELECT url, anchor, donor_domain, yandex_indexed, google_indexed, http_status, added_at
         FROM report_backlinks WHERE project_id = $1
        ORDER BY added_at DESC`,
      [projectId],
    );
    return rows;
  } catch (_) {
    return [];
  }
}

async function _gscQueryPageRows(project, from, to) {
  if (!project.gsc_connected || !project.gsc_site_url) return [];
  try {
    return await gscService.fetchQueryPageMatrix(project, { from, to });
  } catch (_) {
    return [];
  }
}

/**
 * Собрать модули отчёта для проекта за период.
 * @param {object} project строка projects (с gsc_connected/gsc_site_url)
 * @param {object} opts {from, to, config}
 */
async function buildModulesForProject(project, opts = {}) {
  const { from, to } = opts;
  const config = opts.config || {};
  const [settings, queryPageRows, techAudit, backlinks] = await Promise.all([
    loadSettings(project.id),
    _gscQueryPageRows(project, from, to),
    loadTechAudit(project.id),
    loadBacklinks(project.id),
  ]);

  return assembleModules(
    {
      queryPageRows,
      volumeByQuery: opts.volumeByQuery || {},
      techAudit,
      backlinks,
      positionDeltaByUrl: opts.positionDeltaByUrl || {},
      impressionsTrendByUrl: opts.impressionsTrendByUrl || {},
    },
    { settings, config },
  );
}

module.exports = {
  buildModulesForProject,
  loadSettings,
  loadTechAudit,
  loadBacklinks,
};
