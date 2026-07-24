'use strict';

/**
 * maintenance/storageRetention — единый сервис ретеншена хранилища.
 *
 * Цель: генерации старше N дней (по умолчанию 21) автоматически и полностью
 * удаляются из хранилища — из БД и с диска, освобождая место. Неуспешные
 * (failed/зависшие) задачи чистятся по более короткому порогу.
 *
 * Как работает один прогон (sweep):
 *   1. Для каждой таблицы генераций выбираются «просроченные» строки:
 *        • успешные (completed/done)     — старше RETENTION_DAYS;
 *        • неуспешные/зависшие (всё, что НЕ success) — старше RETENTION_FAILED_DAYS.
 *      Возраст считается по completed_at/finished_at → updated_at → created_at.
 *   2. Перед удалением строк удаляются связанные файлы на диске
 *      (storage/images/<taskId>, исходный DOCX) через artifactCleanup.
 *   3. Строки удаляются пакетами (LIMIT), чтобы не держать долгую блокировку.
 *   4. dry-run режим: только логирует, что будет удалено, ничего не трогает.
 *   5. После удаления по расписанию запускается VACUUM (обычный — для
 *      переиспользования места). Тяжёлый VACUUM FULL — только opt-in
 *      (STORAGE_RETENTION_VACUUM_FULL=1), т.к. он берёт эксклюзивную блокировку;
 *      на проде предпочтительнее pg_repack.
 *
 * Решение по вопросу «Эгида уже проанализировала»: удаляем чисто по возрасту
 * (RETENTION_DAYS). Это самый простой и безопасный сигнал, не завязанный на
 * состояние датасета Aegis; порог задаётся ENV и по умолчанию покрывает окно,
 * за которое анализ гарантированно успевает пройти.
 *
 * Kill-switch и настройки — через ENV (см. .env.example):
 *   STORAGE_RETENTION_ENABLED       = 1|0     (планировщик; сервис-функция работает всегда)
 *   STORAGE_RETENTION_DAYS          = 21      (порог для успешных)
 *   STORAGE_RETENTION_FAILED_DAYS   = 5       (порог для failed/зависших)
 *   STORAGE_RETENTION_BATCH         = 200     (размер пакета удаления)
 *   STORAGE_RETENTION_MAX_BATCHES   = 50      (потолок пакетов на таблицу за прогон)
 *   STORAGE_RETENTION_DRY_RUN       = 1|0     (лог без удаления)
 *   STORAGE_RETENTION_VACUUM        = 1|0     (VACUUM после удаления, default 1)
 *   STORAGE_RETENTION_VACUUM_FULL   = 1|0     (VACUUM FULL, default 0 — блокирует!)
 */

const dbModule = require('../../config/db');
const { cleanupTaskArtifacts } = require('./artifactCleanup');

/**
 * Описание таблиц генераций. Для каждой:
 *   • table          — имя таблицы;
 *   • idCol          — PK-колонка;
 *   • successStatuses — статусы «успешно завершено»;
 *   • completedAgeExpr — SQL-выражение возраста для успешных строк;
 *   • failedAgeExpr    — SQL-выражение возраста для неуспешных/зависших;
 *   • docxCol        — колонка с путём к исходному DOCX (или null);
 *   • hasImageDir    — есть ли у задачи каталог storage/images/<id>.
 *
 * Возраст берётся с COALESCE, т.к. набор timestamp-колонок в таблицах разный.
 */
const TABLES = [
  {
    table: 'tasks',
    idCol: 'id',
    successStatuses: ['completed'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: 'input_tz_docx_path',
    hasImageDir: true,
  },
  {
    table: 'link_article_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: null,
    hasImageDir: true,
  },
  {
    table: 'info_article_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: null,
    hasImageDir: true,
  },
  {
    table: 'meta_tag_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
  {
    table: 'relevance_reports',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, created_at)',
    failedAgeExpr: 'COALESCE(started_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
  {
    table: 'article_topic_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
  {
    table: 'audit_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(finished_at, created_at)',
    failedAgeExpr: 'COALESCE(started_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
  {
    table: 'forecaster_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(completed_at, updated_at, created_at)',
    failedAgeExpr: 'COALESCE(updated_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
  {
    table: 'site_crawl_tasks',
    idCol: 'id',
    successStatuses: ['done'],
    completedAgeExpr: 'COALESCE(finished_at, created_at)',
    failedAgeExpr: 'COALESCE(started_at, created_at)',
    docxCol: null,
    hasImageDir: false,
  },
];

function _int(name, dflt, min, max) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return dflt;
  if (min != null && v < min) return min;
  if (max != null && v > max) return max;
  return v;
}

function _bool(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * getRetentionConfig — актуальный snapshot настроек (читает ENV при вызове).
 */
function getRetentionConfig(overrides = {}) {
  return {
    retentionDays: _int('STORAGE_RETENTION_DAYS', 21, 1),
    failedDays: _int('STORAGE_RETENTION_FAILED_DAYS', 5, 1),
    batchSize: _int('STORAGE_RETENTION_BATCH', 200, 1, 5000),
    maxBatches: _int('STORAGE_RETENTION_MAX_BATCHES', 50, 1, 10000),
    dryRun: _bool('STORAGE_RETENTION_DRY_RUN', false),
    vacuum: _bool('STORAGE_RETENTION_VACUUM', true),
    vacuumFull: _bool('STORAGE_RETENTION_VACUUM_FULL', false),
    ...overrides,
  };
}

/**
 * Строит SELECT одной порции просроченных строк для таблицы.
 * $1 = successStatuses (text[]), $2 = retentionDays, $3 = failedDays, $4 = limit.
 */
function _buildSelectSql(desc) {
  const cols = [desc.idCol];
  if (desc.docxCol) cols.push(desc.docxCol);
  return `
    SELECT ${cols.join(', ')}
      FROM ${desc.table}
     WHERE (
             status::text = ANY($1)
             AND ${desc.completedAgeExpr} < NOW() - ($2 || ' days')::interval
           )
        OR (
             NOT (status::text = ANY($1))
             AND ${desc.failedAgeExpr} < NOW() - ($3 || ' days')::interval
           )
     ORDER BY ${desc.idCol}
     LIMIT $4`;
}

/**
 * sweepTable — обрабатывает одну таблицу: батчами выбирает просроченные строки,
 * чистит файлы и удаляет строки. В dry-run только считает.
 *
 * @param {object} desc — дескриптор таблицы из TABLES
 * @param {object} cfg  — конфиг ретеншена
 * @param {object} [deps] — { db, cleanup } для тестов
 * @returns {Promise<{table:string, scanned:number, deleted:number,
 *                     imageDirs:number, docx:number, batches:number,
 *                     dryRun:boolean, error?:string}>}
 */
async function sweepTable(desc, cfg, deps = {}) {
  const db = deps.db || dbModule;
  const cleanup = deps.cleanup || cleanupTaskArtifacts;
  const selectSql = _buildSelectSql(desc);
  const stat = {
    table: desc.table,
    scanned: 0,
    deleted: 0,
    imageDirs: 0,
    docx: 0,
    batches: 0,
    dryRun: !!cfg.dryRun,
  };

  try {
    for (let b = 0; b < cfg.maxBatches; b += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await db.query(selectSql, [
        desc.successStatuses,
        cfg.retentionDays,
        cfg.failedDays,
        cfg.batchSize,
      ]);
      if (!rows.length) break;
      stat.batches += 1;
      stat.scanned += rows.length;

      // 1. Удаляем файлы на диске до удаления строк (best-effort).
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        const res = await cleanup({
          taskId: desc.hasImageDir ? row[desc.idCol] : undefined,
          docxPath: desc.docxCol ? row[desc.docxCol] : undefined,
        });
        if (res && res.imageDir) stat.imageDirs += 1;
        if (res && res.docx) stat.docx += 1;
      }

      if (cfg.dryRun) {
        // В dry-run не удаляем строки — но и не зациклимся: выходим после
        // первой (и единственной) выборки, иначе SELECT вернёт те же строки.
        console.log(`[storageRetention] DRY-RUN ${desc.table}: удалили бы ${rows.length} строк (первый батч)`);
        break;
      }

      // 2. Удаляем строки пакетом.
      const ids = rows.map((r) => r[desc.idCol]);
      // eslint-disable-next-line no-await-in-loop
      const del = await db.query(
        `DELETE FROM ${desc.table} WHERE ${desc.idCol} = ANY($1)`,
        [ids],
      );
      stat.deleted += del.rowCount || 0;

      // Если выбрали меньше лимита — просроченных больше нет.
      if (rows.length < cfg.batchSize) break;
    }
  } catch (err) {
    stat.error = err.message;
    console.warn(`[storageRetention] Ошибка при обработке ${desc.table}:`, err.message);
  }
  return stat;
}

/**
 * runVacuum — освобождение места в Postgres после пакетного удаления.
 * Обычный VACUUM переиспользует место внутри таблицы (без эксклюзивной
 * блокировки). VACUUM FULL реально возвращает место ОС, но блокирует таблицу —
 * поэтому только opt-in.
 *
 * @param {string[]} tables — какие таблицы вакуумировать
 * @param {object} cfg
 * @param {object} [deps]
 */
async function runVacuum(tables, cfg, deps = {}) {
  const db = deps.db || dbModule;
  if (!cfg.vacuum && !cfg.vacuumFull) return;
  for (const table of tables) {
    const sql = cfg.vacuumFull
      ? `VACUUM (FULL, ANALYZE) ${table}`
      : `VACUUM (ANALYZE) ${table}`;
    try {
      if (cfg.vacuumFull) {
        console.log(`[storageRetention] ${sql} (эксклюзивная блокировка таблицы!)`);
      }
      // eslint-disable-next-line no-await-in-loop
      await db.query(sql);
    } catch (err) {
      console.warn(`[storageRetention] VACUUM для ${table} не удался:`, err.message);
    }
  }
}

/**
 * runStorageRetention — полный прогон ретеншена по всем таблицам.
 *
 * @param {object} [overrides] — переопределения конфига (напр. { dryRun: true })
 * @param {object} [deps]      — { db, cleanup, tables } для тестов
 * @returns {Promise<{startedAt:string, finishedAt:string, config:object,
 *                     totals:object, tables:Array}>}
 */
async function runStorageRetention(overrides = {}, deps = {}) {
  const cfg = getRetentionConfig(overrides);
  const tables = deps.tables || TABLES;
  const startedAt = new Date().toISOString();

  const results = [];
  for (const desc of tables) {
    // eslint-disable-next-line no-await-in-loop
    const stat = await sweepTable(desc, cfg, deps);
    results.push(stat);
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.scanned += r.scanned;
      acc.deleted += r.deleted;
      acc.imageDirs += r.imageDirs;
      acc.docx += r.docx;
      return acc;
    },
    { scanned: 0, deleted: 0, imageDirs: 0, docx: 0 },
  );

  // VACUUM только по таблицам, где реально что-то удалили, и не в dry-run.
  if (!cfg.dryRun && totals.deleted > 0) {
    const touched = results.filter((r) => r.deleted > 0).map((r) => r.table);
    await runVacuum(touched, cfg, deps);
  }

  const finishedAt = new Date().toISOString();
  console.log(
    `[storageRetention] Прогон завершён: удалено строк=${totals.deleted}, `
    + `каталогов картинок=${totals.imageDirs}, DOCX=${totals.docx}`
    + `${cfg.dryRun ? ' (DRY-RUN)' : ''}`,
  );

  return { startedAt, finishedAt, config: cfg, totals, tables: results };
}

module.exports = {
  runStorageRetention,
  sweepTable,
  runVacuum,
  getRetentionConfig,
  TABLES,
  _buildSelectSql,
};
