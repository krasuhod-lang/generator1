'use strict';

const crypto = require('crypto');
const os = require('os');
const dbDefault = require('../../config/db');
const { normalizeBullJobId, makeBullJobId } = require('../../queue/jobIds');
const {
  generationQueue,
  parserQueue,
  siteCrawlerQueue,
  auditQueue,
  projectAnalysisQueue,
  reportSummaryQueue,
} = require('../../queue/queue');

const LEASE_SECONDS = Math.max(30, Number(process.env.TASK_LEASE_SECONDS) || 60);
const RECOVERY_INTERVAL_MS = Math.max(10000, Number(process.env.TASK_RECOVERY_INTERVAL_MS) || 30000);
const MAX_RECOVERY_ATTEMPTS = Math.max(1, Number(process.env.MAX_RECOVERY_ATTEMPTS) || 3);
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

const QUEUES = Object.freeze({
  'content-generation': generationQueue,
  'parser-scans': parserQueue,
  'site-crawls': siteCrawlerQueue,
  'audit-jobs': auditQueue,
  'project-analysis': projectAnalysisQueue,
  'report-summary': reportSummaryQueue,
});

function newToken() {
  return crypto.randomUUID();
}

function shortWorkerId() {
  return WORKER_ID.slice(0, 96);
}

function leaseSql(seconds = LEASE_SECONDS) {
  return `NOW() + make_interval(secs => $${seconds})`;
}

async function enqueueOutbox({ queueName, jobName, jobId, payload }, db = dbDefault) {
  if (!QUEUES[queueName]) throw new Error(`Unknown reliability queue: ${queueName}`);
  const safeJobId = normalizeBullJobId(jobId);
  const { rows } = await db.query(
    `INSERT INTO generator_task_outbox (queue_name, job_name, job_id, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (queue_name, job_id) DO NOTHING
     RETURNING id`,
    [queueName, jobName, safeJobId, JSON.stringify(payload || {})],
  );
  return rows[0]?.id || null;
}

/**
 * Publishes pending outbox rows while holding row locks. The transaction is
 * deliberately kept open during queue.add(): a second publisher cannot take
 * the same row and duplicate the logical job.
 */
async function publishPendingOutbox(db = dbDefault, limit = 50) {
  const client = await db.getClient();
  let published = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, queue_name, job_name, job_id, payload
         FROM generator_task_outbox
        WHERE published_at IS NULL
          AND (available_at <= NOW() OR job_id LIKE '%:%')
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.min(200, limit))],
    );

    for (const row of rows) {
      const queue = QUEUES[row.queue_name];
      if (!queue) {
        await client.query(
          `UPDATE generator_task_outbox
              SET attempts=attempts+1, last_error=$2, available_at=NOW()+INTERVAL '5 minutes'
            WHERE id=$1`,
          [row.id, `unknown_queue:${row.queue_name}`],
        );
        continue;
      }
      const safeJobId = normalizeBullJobId(row.job_id);
      try {
        await queue.add(row.job_name, row.payload || {}, {
          jobId: safeJobId,
          attempts: 1,
          removeOnComplete: { age: 3 * 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 500 },
        });
        await client.query(
          `UPDATE generator_task_outbox
              SET job_id=$2, published_at=NOW(), attempts=attempts+1, last_error=NULL
            WHERE id=$1`,
          [row.id, safeJobId],
        );
        await client.query(
          `UPDATE tasks SET bull_job_id=$2, updated_at=NOW() WHERE bull_job_id=$1`,
          [row.job_id, safeJobId],
        );
        published += 1;
      } catch (e) {
        const message = String(e.message || e).slice(0, 500);
        // Redis may have accepted queue.add() before PostgreSQL was able to
        // mark outbox.published_at. Treat an existing deterministic jobId as
        // idempotent success; otherwise the outbox remains pending forever.
        if (/already exists|job.*exists|duplicated/i.test(message)) {
          await client.query(
            `UPDATE generator_task_outbox
                SET job_id=$2, published_at=NOW(), attempts=attempts+1, last_error=NULL
              WHERE id=$1`,
            [row.id, safeJobId],
          );
          await client.query(
            `UPDATE tasks SET bull_job_id=$2, updated_at=NOW() WHERE bull_job_id=$1`,
            [row.job_id, safeJobId],
          );
          published += 1;
        } else {
          await client.query(
            `UPDATE generator_task_outbox
                SET attempts=attempts+1,
                    last_error=$2,
                    available_at=NOW()+make_interval(secs => LEAST(300, GREATEST(5, attempts * 5)))
              WHERE id=$1`,
            [row.id, message],
          );
        }
      }
    }
    await client.query('COMMIT');
    return published;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function claimParserItem(itemId, workerId = shortWorkerId(), db = dbDefault) {
  const token = newToken();
  const { rows } = await db.query(
    `UPDATE parser_task_items
        SET status='running', worker_id=$2, lease_token=$3::uuid,
            lease_until=NOW()+make_interval(secs => $4), heartbeat_at=NOW(),
            attempts=attempts+1, updated_at=NOW()
      WHERE id=$1
        AND status IN ('queued','retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        AND (lease_until IS NULL OR lease_until < NOW())
      RETURNING *`,
    [itemId, workerId, token, LEASE_SECONDS],
  );
  return rows[0] ? { row: rows[0], token } : null;
}

async function heartbeatParserItem(itemId, token, checkpoint, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE parser_task_items
        SET heartbeat_at=NOW(), lease_until=NOW()+make_interval(secs => $3),
            checkpoint=$4::jsonb, updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid`,
    [itemId, token, LEASE_SECONDS, JSON.stringify(checkpoint || {})],
  );
  return rowCount === 1;
}

async function retryParserItem(itemId, token, error, delayMs = 5000, db = dbDefault) {
  const { rows } = await db.query(
    `UPDATE parser_task_items
        SET status='retry_wait', error_code=$3, error_message=$4,
            next_attempt_at=NOW()+make_interval(secs => $5),
            lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid
      RETURNING task_id, attempts`,
    [itemId, token, error?.code || 'temporary_error', error?.message || String(error || ''), Math.max(1, Math.ceil(delayMs / 1000))],
  );
  return rows[0] || null;
}

async function heartbeatParserTask(taskId, token, checkpoint, progress, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE parser_tasks
        SET heartbeat_at=NOW(), lease_until=NOW()+make_interval(secs => $3),
            checkpoint=$4::jsonb, progress=COALESCE($5, progress), updated_at=NOW()
      WHERE id=$1 AND status IN ('queued','running')
        AND (lease_token IS NULL OR lease_token=$2::uuid)`,
    [taskId, token, LEASE_SECONDS, JSON.stringify(checkpoint || {}), progress == null ? null : progress],
  );
  return rowCount === 1;
}

async function finishParserItem(itemId, token, result, status = 'completed', error = null, db = dbDefault) {
  const { rows } = await db.query(
    `UPDATE parser_task_items
        SET status=$3, result=$4::jsonb, error_code=$5, error_message=$6,
            lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            checkpoint=NULL, finished_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid
      RETURNING task_id`,
    [itemId, token, status, JSON.stringify(result || null), error?.code || null, error?.message || null],
  );
  return rows[0] || null;
}

async function claimSiteCrawlerTask(taskId, workerId = shortWorkerId(), db = dbDefault) {
  const token = newToken();
  const { rows } = await db.query(
    `UPDATE site_crawl_tasks
        SET status='running', worker_id=$2, lease_token=$3::uuid,
            lease_until=NOW()+make_interval(secs => $4), heartbeat_at=NOW(),
            attempts=attempts+1, updated_at=NOW(), started_at=COALESCE(started_at,NOW())
      WHERE id=$1
        AND (status='queued' OR (status='running' AND lease_until < NOW()))
      RETURNING *`,
    [taskId, workerId, token, LEASE_SECONDS],
  );
  return rows[0] ? { row: rows[0], token } : null;
}

async function heartbeatSiteCrawlerTask(taskId, token, stats, checkpoint, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE site_crawl_tasks
        SET stats=$3::jsonb, checkpoint=$4::jsonb, heartbeat_at=NOW(),
            lease_until=NOW()+make_interval(secs => $5), updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid`,
    [taskId, token, JSON.stringify(stats || {}), JSON.stringify(checkpoint || {}), LEASE_SECONDS],
  );
  return rowCount === 1;
}

async function finishSiteCrawlerTask(taskId, token, status, stats, error = null, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE site_crawl_tasks
        SET status=$3, stats=$4::jsonb, error=$5, last_error_code=$6,
            lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            finished_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND lease_token=$2::uuid`,
    [taskId, token, status, JSON.stringify(stats || {}), error?.message || null, error?.code || null],
  );
  return rowCount === 1;
}

async function claimProjectAnalysis(analysisId, jobId, workerId = shortWorkerId(), db = dbDefault) {
  const token = newToken();
  const { rows } = await db.query(
    `UPDATE project_analyses
        SET status='running', worker_id=$3, lease_token=$4::uuid,
            lease_until=NOW()+make_interval(secs => $5), heartbeat_at=NOW(),
            attempts=COALESCE(attempts,0)+1, started_at=COALESCE(started_at,NOW()),
            updated_at=NOW()
      WHERE id=$1 AND job_id=$2 AND status IN ('queued','running')
        AND (lease_until IS NULL OR lease_until < NOW())
      RETURNING *`,
    [analysisId, jobId, workerId, token, LEASE_SECONDS],
  );
  return rows[0] ? { row: rows[0], token } : null;
}

async function heartbeatProjectAnalysis(analysisId, token, checkpoint = {}, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE project_analyses
        SET heartbeat_at=NOW(), lease_until=NOW()+make_interval(secs => $3),
            checkpoint=$4::jsonb, updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid`,
    [analysisId, token, LEASE_SECONDS, JSON.stringify(checkpoint || {})],
  );
  return rowCount === 1;
}

async function finishProjectAnalysis(analysisId, token, status, error = null, db = dbDefault) {
  const { rowCount } = await db.query(
    `UPDATE project_analyses
        SET status=$3, error_message=$4, last_error_code=$5,
            lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            completed_at=CASE WHEN $3 IN ('done','error') THEN NOW() ELSE completed_at END,
            updated_at=NOW()
      WHERE id=$1 AND status='running' AND lease_token=$2::uuid`,
    [analysisId, token, status, error?.message || null, error?.code || null],
  );
  return rowCount === 1;
}

async function recoverExpiredWork(db = dbDefault) {
  const recovered = { tasks: 0, parserTasks: 0, parserItems: 0, crawls: 0 };

  const main = await db.query(
    `UPDATE tasks
        SET status='queued', bull_job_id=NULL, worker_id=NULL, lease_token=NULL,
            lease_until=NULL, heartbeat_at=NOW(), recovery_attempts=COALESCE(recovery_attempts,0)+1,
            last_error_code='worker_restarted', updated_at=NOW()
      WHERE status='processing'
        AND (lease_until IS NULL OR lease_until < NOW())
        AND COALESCE(recovery_attempts,0) < $1
      RETURNING id, pipeline_checkpoint, recovery_attempts`,
    [MAX_RECOVERY_ATTEMPTS],
  );
  recovered.tasks = main.rowCount || 0;

  const pTasks = await db.query(
    `UPDATE parser_tasks
        SET status='queued', worker_id=NULL, lease_token=NULL, lease_until=NULL,
            heartbeat_at=NOW(), recovery_attempts=COALESCE(recovery_attempts,0)+1,
            last_error_code='worker_restarted', updated_at=NOW()
      WHERE status='running'
        AND total=0
        AND NOT EXISTS (SELECT 1 FROM parser_task_items i WHERE i.task_id=parser_tasks.id)
        AND COALESCE(recovery_attempts,0) < $1
      RETURNING id`,
    [MAX_RECOVERY_ATTEMPTS],
  );
  recovered.parserTasks = pTasks.rowCount || 0;

  const pItems = await db.query(
    `UPDATE parser_task_items
        SET status=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
            worker_id=NULL, lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            next_attempt_at=CASE WHEN attempts >= $1 THEN NULL ELSE NOW() END,
            error_code=CASE WHEN attempts >= $1 THEN 'max_attempts' ELSE 'worker_restarted' END,
            error_message=CASE WHEN attempts >= $1 THEN 'Превышено число попыток' ELSE 'Worker перезапущен' END,
            updated_at=NOW(), finished_at=CASE WHEN attempts >= $1 THEN NOW() ELSE NULL END
      WHERE status='running' AND (lease_until IS NULL OR lease_until < NOW())
      RETURNING id, task_id, status`,
    [Math.max(1, Number(process.env.PARSER_ITEM_MAX_ATTEMPTS) || 3)],
  );
  recovered.parserItems = pItems.rowCount || 0;

  // До durable items старая версия parser сохраняла только total и держала
  // URL в памяти. Такие задачи нельзя безопасно продолжить после рестарта;
  // переводим их в понятный retryable error, а не оставляем навсегда queued.
  await db.query(
    `UPDATE parser_tasks
        SET status='error', error='Задача создана старой версией и не содержит сохраненных URL; запустите ее повторно',
            last_error_code='legacy_task_without_items', finished_at=NOW(), updated_at=NOW()
      WHERE status IN ('queued','running') AND total > 0
        AND NOT EXISTS (SELECT 1 FROM parser_task_items i WHERE i.task_id=parser_tasks.id)
        AND COALESCE(options->>'search_query','')=''`,
  );

  const crawls = await db.query(
    `UPDATE site_crawl_tasks
        SET status=CASE WHEN attempts >= $1 THEN 'error' ELSE 'queued' END,
            worker_id=NULL, lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            recovery_attempts=COALESCE(recovery_attempts,0)+1,
            last_error_code=CASE WHEN attempts >= $1 THEN 'max_attempts' ELSE 'worker_restarted' END,
            error=CASE WHEN attempts >= $1 THEN 'Превышено число попыток' ELSE 'Ожидает автоматического возобновления после перезапуска worker' END,
            updated_at=NOW(), finished_at=CASE WHEN attempts >= $1 THEN NOW() ELSE NULL END
      WHERE status='running' AND (lease_until IS NULL OR lease_until < NOW())
      RETURNING id, status`,
    [Math.max(1, Number(process.env.SITE_CRAWL_MAX_ATTEMPTS) || 3)],
  );
  recovered.crawls = crawls.rowCount || 0;

  const projectAnalyses = await db.query(
    `UPDATE project_analyses
        SET status=CASE WHEN COALESCE(recovery_attempts,0) >= $1 THEN 'error' ELSE 'queued' END,
            worker_id=NULL, lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
            recovery_attempts=COALESCE(recovery_attempts,0)+1,
            last_error_code=CASE WHEN COALESCE(recovery_attempts,0) >= $1 THEN 'max_recovery_attempts' ELSE 'worker_restarted' END,
            error_message=CASE WHEN COALESCE(recovery_attempts,0) >= $1 THEN 'Превышено число восстановлений анализа' ELSE 'Worker перезапущен; анализ будет возобновлён' END,
            completed_at=CASE WHEN COALESCE(recovery_attempts,0) >= $1 THEN NOW() ELSE completed_at END,
            updated_at=NOW()
      WHERE status='running' AND (lease_until IS NULL OR lease_until < NOW())
      RETURNING id, status, job_id`,
    [MAX_RECOVERY_ATTEMPTS],
  );
  recovered.projectAnalyses = projectAnalyses.rowCount || 0;

  const reportSummaries = await db.query(
    `UPDATE report_drafts
        SET llm_status=CASE WHEN COALESCE(llm_recovery_attempts,0) >= $1 THEN 'error' ELSE 'queued' END,
            llm_worker_id=NULL, llm_lease_token=NULL, llm_lease_until=NULL, llm_heartbeat_at=NOW(),
            llm_recovery_attempts=COALESCE(llm_recovery_attempts,0)+1,
            llm_last_error_code=CASE WHEN COALESCE(llm_recovery_attempts,0) >= $1 THEN 'max_recovery_attempts' ELSE 'worker_restarted' END,
            llm_error=CASE WHEN COALESCE(llm_recovery_attempts,0) >= $1 THEN 'Превышено число восстановлений AI summary' ELSE 'Worker перезапущен; AI summary будет возобновлено' END,
            updated_at=NOW()
      WHERE llm_status='running' AND (llm_lease_until IS NULL OR llm_lease_until < NOW())
      RETURNING id, llm_status, llm_job_id`,
    [MAX_RECOVERY_ATTEMPTS],
  );
  recovered.reportSummaries = reportSummaries.rowCount || 0;

  return recovered;
}

async function reconcileParserAndCrawlerJobs(db = dbDefault) {
  let parserQueued = 0;
  let crawlQueued = 0;
  let projectReportQueued = 0;
  const { rows: parserDispatches } = await db.query(
    `SELECT id, options
       FROM parser_tasks
      WHERE status='queued' AND total=0
        AND options->>'search_query' IS NOT NULL
      ORDER BY updated_at
      LIMIT 50`,
  );
  for (const task of parserDispatches) {
    const inserted = await enqueueOutbox({
      queueName: 'parser-scans',
      jobName: 'dispatch-search',
      jobId: makeBullJobId('parser', task.id, 'dispatch', 'reconcile'),
      payload: { taskId: task.id },
    }, db);
    if (inserted) parserQueued += 1;
  }

  const { rows: parserItems } = await db.query(
    `SELECT i.id, i.task_id
       FROM parser_task_items i
       JOIN parser_tasks t ON t.id=i.task_id
      WHERE i.status='queued'
        AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= NOW())
        AND t.status IN ('queued','running')
      ORDER BY i.updated_at
      LIMIT 100`,
  );
  for (const item of parserItems) {
    const jobId = makeBullJobId('parser', item.task_id, item.id, 'reconcile');
    const inserted = await enqueueOutbox({
      queueName: 'parser-scans',
      jobName: 'parse-url',
      jobId,
      payload: { taskId: item.task_id, itemId: item.id },
    }, db);
    if (inserted) parserQueued += 1;
  }

  const { rows: crawlTasks } = await db.query(
    `SELECT id, start_url, options
       FROM site_crawl_tasks
      WHERE status='queued'
      ORDER BY updated_at NULLS FIRST, created_at
      LIMIT 50`,
  );
  for (const task of crawlTasks) {
    const inserted = await enqueueOutbox({
      queueName: 'site-crawls',
      jobName: 'crawl-site',
      jobId: makeBullJobId('site-crawl', task.id, 'reconcile'),
      payload: { taskId: task.id, startUrl: task.start_url, options: task.options || {} },
    }, db);
    if (inserted) crawlQueued += 1;
  }
  const { rows: analysisRows } = await db.query(
    `SELECT id, job_id
       FROM project_analyses
      WHERE status='queued'
      ORDER BY updated_at NULLS FIRST, created_at
      LIMIT 100`,
  );
  const liveProjectStates = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
  for (const row of analysisRows) {
    let jobId = row.job_id;
    if (!jobId) {
      jobId = makeBullJobId('project-analysis', row.id, 'reconcile');
      await db.query(
        `UPDATE project_analyses SET job_id=$2, updated_at=NOW() WHERE id=$1 AND status='queued'`,
        [row.id, jobId],
      );
    }
    const safeJobId = normalizeBullJobId(jobId);
    const existing = await projectAnalysisQueue.getJob(safeJobId).catch(() => null);
    const state = existing ? await existing.getState().catch(() => 'unknown') : 'missing';
    if (existing && liveProjectStates.has(state)) continue;
    if (existing && (state === 'completed' || state === 'failed')) {
      await existing.remove().catch(() => {});
    }

    // published_at мог остаться установленным после Redis restart/flush или
    // старого worker outage. Если live BullMQ job отсутствует, делаем outbox
    // снова pending; иначе PostgreSQL считает dispatch завершённым навсегда.
    const reset = await db.query(
      `UPDATE generator_task_outbox
          SET published_at=NULL, available_at=NOW(), attempts=attempts+1,
              last_error='project_analysis_job_missing_or_terminal'
        WHERE queue_name='project-analysis' AND job_id=$1`,
      [safeJobId],
    );
    if ((reset.rowCount || 0) === 0) {
      const inserted = await enqueueOutbox({
        queueName: 'project-analysis',
        jobName: 'run-analysis',
        jobId: safeJobId,
        payload: { analysisId: row.id, jobId: safeJobId },
      }, db);
      if (inserted) projectReportQueued += 1;
    } else {
      projectReportQueued += 1;
    }
  }

  const { rows: summaryRows } = await db.query(
    `SELECT id, user_id, llm_job_id
       FROM report_drafts
      WHERE llm_status='queued' AND llm_job_id IS NOT NULL
      ORDER BY updated_at NULLS FIRST, created_at
      LIMIT 100`,
  );
  for (const row of summaryRows) {
    const inserted = await enqueueOutbox({
      queueName: 'report-summary',
      jobName: 'run-summary',
      jobId: row.llm_job_id,
      payload: { draftId: row.id, userId: row.user_id, jobId: row.llm_job_id, opts: {} },
    }, db);
    if (inserted) projectReportQueued += 1;
  }

  return {
    parserQueued,
    crawlQueued,
    projectReportQueued,
  };
}

async function reconcileGenerationTasks(db = dbDefault) {
  const client = await db.getClient();
  let lockHeld = false;
  let queued = 0;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, ['generator-queue-reconcile']);
    lockHeld = !!lock.rows[0]?.locked;
    if (!lockHeld) return 0;
    const { rows } = await client.query(
      `SELECT id, pipeline_checkpoint, recovery_attempts
         FROM tasks
        WHERE status='queued' AND bull_job_id IS NULL
          AND COALESCE(recovery_attempts,0) < $1
        ORDER BY updated_at NULLS FIRST, created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED`, [MAX_RECOVERY_ATTEMPTS]);
    for (const task of rows) {
      const jobId = makeBullJobId('generation', task.id, 'reconcile');
      await generationQueue.add('generate', {
        taskId: task.id,
        resumeFrom: task.pipeline_checkpoint || null,
        autoRetries: 0,
      }, { jobId, attempts: 1 });
      const updated = await client.query(
        `UPDATE tasks
            SET bull_job_id=$2, recovery_attempts=COALESCE(recovery_attempts,0)+1,
                last_error_code=NULL, updated_at=NOW()
          WHERE id=$1 AND status='queued' AND bull_job_id IS NULL`,
        [task.id, jobId],
      );
      if (updated.rowCount === 1) queued += 1;
    }

    const { rows: assigned } = await client.query(
      `SELECT id, bull_job_id, pipeline_checkpoint, recovery_attempts
         FROM tasks
        WHERE status='queued' AND bull_job_id IS NOT NULL
        ORDER BY updated_at
        LIMIT 100`,
    );
    for (const task of assigned) {
      const existing = await generationQueue.getJob(String(task.bull_job_id)).catch(() => null);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        const liveStates = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
        if (liveStates.has(state)) continue;
      }
      const jobId = makeBullJobId('generation', task.id, 'reconcile', Number(task.recovery_attempts || 0) + 1);
      await client.query(
        `INSERT INTO generator_task_outbox (queue_name,job_name,job_id,payload)
         VALUES ('content-generation','generate',$1,$2::jsonb)
         ON CONFLICT (queue_name,job_id) DO NOTHING`,
        [jobId, JSON.stringify({ taskId: task.id, resumeFrom: task.pipeline_checkpoint || null })],
      );
      const updated = await client.query(
        `UPDATE tasks SET bull_job_id=$2, recovery_attempts=COALESCE(recovery_attempts,0)+1,
                updated_at=NOW() WHERE id=$1 AND status='queued'`, [task.id, jobId]);
      if (updated.rowCount === 1) queued += 1;
    }
    return queued;
  } finally {
    if (lockHeld) {
      try { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['generator-queue-reconcile']); } catch (_) {}
    }
    client.release();
  }
}

async function recoverOnStartup(db = dbDefault) {
  const client = await db.getClient();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['generator-task-recovery']);
    const result = await recoverExpiredWork(db);
    const generationQueued = await reconcileGenerationTasks(db);
    const parserCrawlQueued = await reconcileParserAndCrawlerJobs(db);
    const published = await publishPendingOutbox(db, 200);
    return { ...result, generationQueued, ...parserCrawlQueued, published };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['generator-task-recovery']); } catch (_) {}
    client.release();
  }
}

let recoveryTimer = null;
function startReliabilityScheduler(db = dbDefault, extraRecovery = null) {
  if (recoveryTimer) return;
  recoverOnStartup(db)
    .then(() => extraRecovery ? extraRecovery() : null)
    .catch((e) => console.warn('[Reliability] startup recovery failed:', e.message));
  recoveryTimer = setInterval(async () => {
    try {
      await recoverExpiredWork(db);
      await reconcileGenerationTasks(db);
      await reconcileParserAndCrawlerJobs(db);
      await publishPendingOutbox(db, 100);
      if (extraRecovery) await extraRecovery();
    } catch (e) {
      console.warn('[Reliability] recovery tick failed:', e.message);
    }
  }, RECOVERY_INTERVAL_MS);
  if (recoveryTimer.unref) recoveryTimer.unref();
  console.log(`[Reliability] task recovery scheduler started (${RECOVERY_INTERVAL_MS}ms)`);
}

function stopReliabilityScheduler() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

module.exports = {
  WORKER_ID,
  LEASE_SECONDS,
  MAX_RECOVERY_ATTEMPTS,
  enqueueOutbox,
  publishPendingOutbox,
  claimParserItem,
  heartbeatParserItem,
  retryParserItem,
  heartbeatParserTask,
  finishParserItem,
  claimSiteCrawlerTask,
  heartbeatSiteCrawlerTask,
  finishSiteCrawlerTask,
  claimProjectAnalysis,
  heartbeatProjectAnalysis,
  finishProjectAnalysis,
  recoverExpiredWork,
  reconcileParserAndCrawlerJobs,
  reconcileGenerationTasks,
  recoverOnStartup,
  startReliabilityScheduler,
  stopReliabilityScheduler,
};
