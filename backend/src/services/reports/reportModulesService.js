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

  const modules = assembleModules(
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

  // Дополнительные поля доступности и client-safe summary (ТЗ §14.1).
  // data_source: GSC для striking/ctr/content (через query×page),
  // backlinks/tech_audit — собственные таблицы.
  const gscAvailable = !!queryPageRows.length;
  _annotateModule(modules.striking_distance, {
    dataSource: 'gsc',
    available: gscAvailable,
    summarize: _summarizeStrikingDistance,
  });
  _annotateModule(modules.ctr_gap, {
    dataSource: 'gsc',
    available: gscAvailable,
    summarize: _summarizeCtrGap,
  });
  _annotateModule(modules.content_health, {
    dataSource: 'gsc+tech_audit',
    available: gscAvailable || techAudit.length > 0,
    summarize: _summarizeContentHealth,
  });
  _annotateModule(modules.off_page, {
    dataSource: 'backlinks',
    available: backlinks.length > 0,
    summarize: _summarizeOffPage,
  });
  _annotateModule(modules.tech_audit, {
    dataSource: 'tech_audit',
    available: techAudit.length > 0,
    summarize: _summarizeTechAudit,
  });

  return modules;
}

function _annotateModule(mod, { dataSource, available, summarize }) {
  if (!mod || typeof mod !== 'object') return;
  const hasItems = Array.isArray(mod.items) && mod.items.length > 0;
  let status = 'ready';
  let reason = null;
  if (!available) { status = 'empty'; reason = 'not_connected'; }
  else if (!hasItems) { status = 'empty'; reason = 'no_rows'; }
  mod.availability_status = status;
  mod.availability_reason = reason;
  mod.is_partial = false;
  mod.data_source = dataSource;
  mod.last_sync_at = null;
  mod.client_safe_summary = summarize ? summarize(mod) : '';
}

// ── client_safe_summary builders ─────────────────────────────────────────
// Каждый возвращает одно короткое предложение для клиента (без терминов
// «opportunity_score», «CTR ratio» и т.п.).

function _ru(n) { return Number(n || 0).toLocaleString('ru-RU'); }

function _summarizeStrikingDistance(mod) {
  const s = mod.summary || {};
  if (!s.total) return 'На границе ТОП-10 пока нет запросов с потенциалом роста.';
  const opp = s.total_opportunity_clicks || 0;
  return `Найдено ${_ru(s.total)} запросов на подходе к ТОП-10` +
    (opp > 0 ? `, потенциальный прирост — около ${_ru(opp)} кликов в месяц.` : '.');
}

function _summarizeCtrGap(mod) {
  const s = mod.summary || {};
  if (!s.total) return 'Страницы с заниженным CTR не обнаружены.';
  const lost = s.lost_clicks || 0;
  return `Найдено ${_ru(s.total)} страниц с просевшим CTR` +
    (lost > 0 ? ` — мы недополучаем около ${_ru(lost)} кликов.` : '.');
}

function _summarizeContentHealth(mod) {
  const s = mod.summary || {};
  if (!s.total) return 'Сигналов по здоровью контента пока недостаточно.';
  const need = (s.needs_work || 0) + (s.critical || 0);
  if (!need) return `Все ${_ru(s.total)} страниц в хорошем состоянии.`;
  return `${_ru(need)} из ${_ru(s.total)} страниц требуют доработки контента.`;
}

function _summarizeOffPage(mod) {
  const s = mod.summary || {};
  if (!s.total) return 'Ссылочный профиль пока не отслеживается.';
  const broken = s.broken || 0;
  if (broken) return `Из ${_ru(s.total)} ссылок ${_ru(broken)} битых — нужно починить.`;
  return `Ссылочный профиль: ${_ru(s.total)} ссылок с ${_ru(s.unique_donors || 0)} доноров.`;
}

function _summarizeTechAudit(mod) {
  const s = mod.summary || {};
  if (!s.pages) return 'Технический аудит ещё не проведён.';
  const broken = s.broken || 0;
  if (broken) return `Из ${_ru(s.pages)} проверенных страниц ${_ru(broken)} отвечают ошибкой — нужно срочно починить.`;
  const noAltRatio = Number(s.images_no_alt_ratio || 0);
  if (noAltRatio > 0.3) return `Технические проблемы: у ${Math.round(noAltRatio * 100)}% изображений нет alt-атрибута.`;
  return `Технических проблем по ${_ru(s.pages)} страницам не выявлено.`;
}

module.exports = {
  buildModulesForProject,
  loadSettings,
  loadTechAudit,
  loadBacklinks,
  // exposed for tests
  _internal: {
    _annotateModule,
    _summarizeStrikingDistance,
    _summarizeCtrGap,
    _summarizeContentHealth,
    _summarizeOffPage,
    _summarizeTechAudit,
  },
};
