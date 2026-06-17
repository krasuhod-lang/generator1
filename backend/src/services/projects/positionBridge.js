'use strict';

const db = require('../../config/db');

function _normalizeDomain(input) {
  if (!input) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(String(input)) ? String(input) : `https://${String(input)}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return String(input).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
  }
}

async function ensureLinkedPositionProject(project, opts = {}) {
  if (!project?.id || !project?.user_id) return null;
  const { rows: existingRows } = await db.query(
    `SELECT id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
            device::text AS device, schedule::text AS schedule, parent_project_id
       FROM position_projects
      WHERE parent_project_id = $1
      LIMIT 1`,
    [project.id],
  );
  if (existingRows[0]) return existingRows[0];

  const domain = _normalizeDomain(opts.domain || project.url || project.keys_so_domain || '');
  const name = String(opts.name || project.name || domain || 'Проект').slice(0, 200);
  const geoLr = String(opts.geo_lr || '').slice(0, 16);
  const geoLoc = String(opts.geo_loc || '').slice(0, 200);
  const engine = ['yandex', 'google', 'both'].includes(opts.engine) ? opts.engine : 'both';
  const device = ['desktop', 'mobile'].includes(opts.device) ? opts.device : 'desktop';
  const schedule = ['daily', 'weekly', 'manual'].includes(opts.schedule) ? opts.schedule : 'manual';

  const { rows } = await db.query(
    `INSERT INTO position_projects
       (user_id, name, domain, engine, geo_lr, geo_loc, device, schedule, parent_project_id)
     VALUES ($1,$2,$3,$4::position_engine,$5,$6,$7::position_device,$8::position_schedule,$9)
     ON CONFLICT (parent_project_id) WHERE parent_project_id IS NOT NULL
     DO UPDATE SET
       name = EXCLUDED.name,
       domain = EXCLUDED.domain,
       updated_at = NOW()
     RETURNING id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
               device::text AS device, schedule::text AS schedule, parent_project_id`,
    [project.user_id, name, domain, engine, geoLr, geoLoc, device, schedule, project.id],
  );
  return rows[0] || null;
}

async function syncLinkedPositionProject(project) {
  if (!project?.id) return null;
  const domain = _normalizeDomain(project.url || project.keys_so_domain || '');
  const { rows } = await db.query(
    `UPDATE position_projects
        SET name = $2,
            domain = $3,
            updated_at = NOW()
      WHERE parent_project_id = $1
      RETURNING id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
                device::text AS device, schedule::text AS schedule, parent_project_id`,
    [project.id, String(project.name || domain || 'Проект').slice(0, 200), domain],
  );
  return rows[0] || null;
}

module.exports = {
  ensureLinkedPositionProject,
  syncLinkedPositionProject,
};
