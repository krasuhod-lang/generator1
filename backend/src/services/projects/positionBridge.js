'use strict';

const db = require('../../config/db');

/**
 * Маппинг ru-регионов из keys_so_region (msk/spb/…) в Яндекс-lr.
 * Используем для авто-инициализации geo_lr связанного position_projects,
 * чтобы съём позиций по дефолту шёл в том же гео, что и AI-аналитика
 * проекта (а не в «общем» Яндексе → искажение позиций).
 *
 * Источник кодов lr: https://yandex.ru/support/search/robots/regions.html.
 * Покрываем только те регионы, что присутствуют в KEYS_SO_REGIONS
 * (projects.controller._sanitizeKeysSoRegion). Если регион не из списка —
 * geo_lr не выставляем (XMLStock ходит без региона = «по умолчанию»).
 */
const KEYS_SO_REGION_TO_LR = Object.freeze({
  msk: '213',   // Москва
  spb: '2',     // Санкт-Петербург
  ekb: '54',    // Екатеринбург
  nsk: '65',    // Новосибирск
  nnv: '47',    // Нижний Новгород
  kzn: '43',    // Казань
  rnd: '39',    // Ростов-на-Дону
  che: '56',    // Челябинск
  sam: '51',    // Самара
  ufa: '172',   // Уфа
  krr: '35',    // Краснодар
  vrn: '193',   // Воронеж
  vlg: '38',    // Волгоград
  prm: '50',    // Пермь
  oms: '66',    // Омск
  sar: '11079', // Саратов
  tom: '67',    // Томск
  tmn: '55',    // Тюмень
  gru: '11029', // Грозный
  zen: '11020', // Зеленоград
  gkv: '11023', // Грозный/Кавказ (placeholder)
  kry: '146',   // Симферополь / Крым
  mns: '157',   // Минск
  gmns: '11108',
  gny: '11079',
});

/**
 * Маппинг тех же регионов в Google location string (для opts.loc XMLStock).
 * Формат «City,Region,Country» — самый совместимый.
 */
const KEYS_SO_REGION_TO_LOC = Object.freeze({
  msk: 'Moscow,Moscow,Russia',
  spb: 'Saint Petersburg,Saint Petersburg,Russia',
  ekb: 'Yekaterinburg,Sverdlovsk Oblast,Russia',
  nsk: 'Novosibirsk,Novosibirsk Oblast,Russia',
  nnv: 'Nizhny Novgorod,Nizhny Novgorod Oblast,Russia',
  kzn: 'Kazan,Tatarstan,Russia',
  rnd: 'Rostov-on-Don,Rostov Oblast,Russia',
  che: 'Chelyabinsk,Chelyabinsk Oblast,Russia',
  sam: 'Samara,Samara Oblast,Russia',
  ufa: 'Ufa,Bashkortostan,Russia',
  krr: 'Krasnodar,Krasnodar Krai,Russia',
  vrn: 'Voronezh,Voronezh Oblast,Russia',
  vlg: 'Volgograd,Volgograd Oblast,Russia',
  prm: 'Perm,Perm Krai,Russia',
  oms: 'Omsk,Omsk Oblast,Russia',
  sar: 'Saratov,Saratov Oblast,Russia',
  tom: 'Tomsk,Tomsk Oblast,Russia',
  tmn: 'Tyumen,Tyumen Oblast,Russia',
  kry: 'Simferopol,Crimea,Russia',
  mns: 'Minsk,Minsk Region,Belarus',
});

/**
 * Возвращает {geo_lr, geo_loc} из проекта по keys_so_region,
 * либо пустые строки, если регион не задан / не из словаря. Учитывает
 * приоритет явно переданных opts.geo_lr / opts.geo_loc.
 *
 * @param {object} project — строка projects (минимум { keys_so_region })
 * @param {object} [opts]  — { geo_lr, geo_loc }
 */
function resolveGeoFromProject(project, opts = {}) {
  const explicitLr = String(opts.geo_lr || '').trim();
  const explicitLoc = String(opts.geo_loc || '').trim();
  const region = (project && project.keys_so_region)
    ? String(project.keys_so_region).toLowerCase()
    : '';
  const lr = explicitLr || KEYS_SO_REGION_TO_LR[region] || '';
  const loc = explicitLoc || KEYS_SO_REGION_TO_LOC[region] || '';
  return {
    geo_lr: String(lr).slice(0, 16),
    geo_loc: String(loc).slice(0, 200),
  };
}

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
  const { geo_lr: geoLr, geo_loc: geoLoc } = resolveGeoFromProject(project, opts);
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
  // Если geo_lr пуст у связанного проекта, а в SEO-проекте стоит keys_so_region
  // → дозаливаем geo при синке. Уже выставленные пользователем значения
  // не перезаписываем (NULL-IF) — оператор имеет право указать индивидуальное
  // гео для съёма.
  const { geo_lr: geoLrFromProject, geo_loc: geoLocFromProject } = resolveGeoFromProject(project);
  const { rows } = await db.query(
    `UPDATE position_projects
        SET name = $2,
            domain = $3,
            geo_lr = CASE WHEN COALESCE(NULLIF(geo_lr, ''), '') = ''
                          THEN $4 ELSE geo_lr END,
            geo_loc = CASE WHEN COALESCE(NULLIF(geo_loc, ''), '') = ''
                           THEN $5 ELSE geo_loc END,
            updated_at = NOW()
      WHERE parent_project_id = $1
      RETURNING id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
                device::text AS device, schedule::text AS schedule, parent_project_id`,
    [
      project.id,
      String(project.name || domain || 'Проект').slice(0, 200),
      domain,
      geoLrFromProject,
      geoLocFromProject,
    ],
  );
  return rows[0] || null;
}

/**
 * Атомарный апдейт настроек связанного position_projects (engine/device/
 * schedule/geo_lr/geo_loc). Используется в PATCH /projects/:id/positions/settings.
 * Если связанного проекта позиций нет — возвращает null (вызывающий должен
 * сначала вызвать ensureLinkedPositionProject).
 *
 * Валидация на уровне контроллера; здесь только пишем то, что пришло.
 *
 * @param {string} parentProjectId
 * @param {object} patch — { engine, device, schedule, geo_lr, geo_loc, name }
 */
async function updateLinkedPositionSettings(parentProjectId, patch = {}) {
  if (!parentProjectId) return null;
  const fields = [];
  const params = [];
  function add(col, val, cast) {
    params.push(val);
    fields.push(`${col} = $${params.length}${cast ? `::${cast}` : ''}`);
  }
  if (typeof patch.name === 'string')     add('name',     String(patch.name).slice(0, 200));
  if (typeof patch.engine === 'string')   add('engine',   patch.engine, 'position_engine');
  if (typeof patch.device === 'string')   add('device',   patch.device, 'position_device');
  if (typeof patch.schedule === 'string') add('schedule', patch.schedule, 'position_schedule');
  if (typeof patch.geo_lr === 'string')   add('geo_lr',   String(patch.geo_lr).slice(0, 16));
  if (typeof patch.geo_loc === 'string')  add('geo_loc',  String(patch.geo_loc).slice(0, 200));
  if (!fields.length) {
    const { rows } = await db.query(
      `SELECT id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
              device::text AS device, schedule::text AS schedule, parent_project_id, last_run_at
         FROM position_projects WHERE parent_project_id = $1 LIMIT 1`,
      [parentProjectId],
    );
    return rows[0] || null;
  }
  fields.push('updated_at = NOW()');
  params.push(parentProjectId);
  const { rows } = await db.query(
    `UPDATE position_projects SET ${fields.join(', ')}
      WHERE parent_project_id = $${params.length}
      RETURNING id, user_id, name, domain, engine::text AS engine, geo_lr, geo_loc,
                device::text AS device, schedule::text AS schedule, parent_project_id, last_run_at`,
    params,
  );
  return rows[0] || null;
}

module.exports = {
  ensureLinkedPositionProject,
  syncLinkedPositionProject,
  updateLinkedPositionSettings,
  resolveGeoFromProject,
  KEYS_SO_REGION_TO_LR,
  KEYS_SO_REGION_TO_LOC,
};
