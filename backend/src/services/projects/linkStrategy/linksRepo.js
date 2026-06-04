'use strict';

/**
 * linkStrategy/linksRepo — хранилище импортированных ссылочных данных GSC
 * (таблица project_gsc_links, миграция 066). Один импорт = пачка строк одного
 * типа таблицы (sites/pages/anchors) с меткой import_batch + датой.
 */

const dbDefault = require('../../../config/db');

/**
 * Сохраняет результат импорта (linksImporter.importLinksCsv) для проекта.
 * Перезаписывает прошлый импорт того же типа (один актуальный срез на тип).
 */
async function saveImport({ projectId, userId, type, rows }, db = dbDefault) {
  if (!projectId || !type || !Array.isArray(rows)) return { ok: false, inserted: 0 };
  await db.query('DELETE FROM project_gsc_links WHERE project_id = $1 AND table_type = $2',
    [projectId, type]);
  let inserted = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO project_gsc_links
         (project_id, user_id, table_type, donor, target_page, anchor, links)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [projectId, userId || null, type,
        r.donor || null, r.target_page || null, r.anchor || null, Number(r.links) || 0],
    );
    inserted += 1;
  }
  return { ok: true, inserted };
}

/**
 * Загружает все импортированные ссылочные данные проекта, сгруппированные по
 * типу таблицы: { anchors:[], pages:[], sites:[] }.
 */
async function loadLinks(projectId, db = dbDefault) {
  const empty = { anchors: [], pages: [], sites: [] };
  if (!projectId) return empty;
  try {
    const { rows } = await db.query(
      `SELECT table_type, donor, target_page, anchor, links
         FROM project_gsc_links WHERE project_id = $1`,
      [projectId],
    );
    const out = { anchors: [], pages: [], sites: [] };
    rows.forEach((r) => {
      if (r.table_type === 'anchors') out.anchors.push({ anchor: r.anchor, links: r.links });
      else if (r.table_type === 'pages') out.pages.push({ target_page: r.target_page, links: r.links });
      else if (r.table_type === 'sites') out.sites.push({ donor: r.donor, links: r.links });
    });
    return out;
  } catch (_) {
    return empty;
  }
}

module.exports = { saveImport, loadLinks };
