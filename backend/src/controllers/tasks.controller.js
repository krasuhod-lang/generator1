'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../config/db');
const { parseTZ } = require('../utils/parseTZ');
const { generationQueue } = require('../queue/queue');
const { closeTask, getClientCount } = require('../services/sse/sseManager');
const { publish }         = require('../services/sse/sseManager');

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Загружает задачу из БД с проверкой владельца.
 * Бросает { status, message } если не найдено или не принадлежит пользователю.
 */
async function loadOwnTask(taskId, userId) {
  const { rows } = await db.query(
    `SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  if (!rows.length) {
    const err = new Error('Задача не найдена или доступ запрещён');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

/**
 * Валидация полей перед запуском задачи (ТЗ §16).
 * Возвращает массив ошибок (пустой = OK).
 */
function validateTaskForStart(task) {
  const errors = [];
  if (!task.input_target_service?.trim() || task.input_target_service.trim() === 'Черновик')
    errors.push('Укажите H1 / целевую услугу');
  const lsiTrimmed = task.input_raw_lsi?.trim() || '';
  if (!lsiTrimmed || lsiTrimmed.split('\n').map(s => s.trim()).filter(Boolean).length < 5)
    errors.push('Добавьте минимум 5 LSI-слов (по одному на строку)');
  if (!task.input_brand_name?.trim())
    errors.push('Укажите название бренда');
  if (!task.input_author_name?.trim())
    errors.push('Укажите имя автора');
  if (!task.input_region?.trim())
    errors.push('Укажите регион');
  if (!task.input_min_chars || parseInt(task.input_min_chars) <= 200)
    errors.push('Мин. символов должно быть > 200');
  if (
    !task.input_max_chars ||
    parseInt(task.input_max_chars) <= parseInt(task.input_min_chars)
  )
    errors.push('Макс. символов должно быть > мин.');
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks
// Список задач текущего пользователя (с метриками если есть)
// ─────────────────────────────────────────────────────────────────────────────

async function listTasks(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT
         t.id, t.title, t.status, t.input_target_service,
         t.created_at, t.completed_at, t.started_at,
         t.bull_job_id, t.error_message,
         m.lsi_coverage, m.eeat_score, m.total_cost_usd, m.bm25_score
       FROM tasks t
       LEFT JOIN task_metrics m ON m.task_id = t.id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    return res.json({ tasks: rows });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks
// Создание черновика задачи
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Нормализация JSON-полей: если пришёл object/array — сериализуем в string.
 * pipeline всегда читает эти поля как TEXT, поэтому безопасно хранить как JSON-строку.
 */
function toText(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'string') return val.trim() || null;
  // Пришёл object или array с фронтенда — сериализуем
  return JSON.stringify(val);
}

async function createTask(req, res, next) {
  try {
    const {
      title,
      input_target_service,
      input_brand_name,
      input_author_name,
      input_region,
      input_language,
      input_business_type,
      input_site_type,
      input_target_audience,
      input_business_goal,
      input_monetization,
      input_project_limits,
      input_page_priorities,
      input_niche_features,
      input_raw_lsi,
      input_ngrams,
      input_tfidf_json,
      input_brand_facts,
      input_competitor_urls,
      input_min_chars,
      input_max_chars,
      input_target_url,
      llm_provider,
    } = req.body;

    // Для черновика допускаем пустое поле — ставим плейсхолдер
    const targetService = input_target_service?.toString().trim() || 'Черновик';

    const minChars = parseInt(input_min_chars) || 800;
    const maxChars = parseInt(input_max_chars) || 3500;

    if (maxChars <= minChars) {
      return res.status(400).json({ error: 'Макс. символов должно быть больше мин.' });
    }

    // Whitelist для LLM-провайдера. Невалидное значение → fallback к 'gemini'.
    const provider = (typeof llm_provider === 'string' && llm_provider.toLowerCase().trim() === 'grok')
      ? 'grok'
      : 'gemini';

    const { rows } = await db.query(
      `INSERT INTO tasks (
         user_id, title, status,
         input_target_service, input_brand_name, input_author_name,
         input_region, input_language, input_business_type, input_site_type,
         input_target_audience, input_business_goal, input_monetization,
         input_project_limits, input_page_priorities, input_niche_features,
         input_raw_lsi, input_ngrams, input_tfidf_json,
         input_brand_facts, input_competitor_urls,
         input_min_chars, input_max_chars,
         input_target_url,
         llm_provider
       ) VALUES (
         $1, $2, 'draft',
         $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19, $20,
         $21, $22,
         $23,
         $24
       ) RETURNING *`,
      [
        req.user.id,
        toText(title) || targetService,
        targetService,
        toText(input_brand_name),
        toText(input_author_name),
        toText(input_region),
        toText(input_language),
        toText(input_business_type),
        toText(input_site_type),
        toText(input_target_audience),
        toText(input_business_goal),
        toText(input_monetization),
        toText(input_project_limits),
        toText(input_page_priorities),
        toText(input_niche_features),
        toText(input_raw_lsi),
        toText(input_ngrams),
        toText(input_tfidf_json),
        toText(input_brand_facts),
        toText(input_competitor_urls),
        minChars,
        maxChars,
        toText(input_target_url),
        provider,
      ]
    );

    return res.status(201).json({ task: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id
// Получить задачу по ID
// ─────────────────────────────────────────────────────────────────────────────

async function getTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);
    return res.json({ task });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/tasks/:id
// Обновление входных данных черновика
// ─────────────────────────────────────────────────────────────────────────────

async function updateTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    // Нельзя редактировать задачу в процессе выполнения
    if (task.status === 'processing' || task.status === 'queued') {
      return res.status(409).json({
        error: `Нельзя редактировать задачу в статусе "${task.status}"`,
      });
    }

    // Разрешённые поля для обновления
    const ALLOWED = [
      'title',
      'input_target_service', 'input_brand_name', 'input_author_name',
      'input_region', 'input_language', 'input_business_type', 'input_site_type',
      'input_target_audience', 'input_business_goal', 'input_monetization',
      'input_project_limits', 'input_page_priorities', 'input_niche_features',
      'input_raw_lsi', 'input_ngrams', 'input_tfidf_json',
      'input_brand_facts', 'input_competitor_urls',
      'input_min_chars', 'input_max_chars',
      'input_target_url',
      'llm_provider',
    ];

    const fields = [];
    const values = [req.params.id, req.user.id];

    // Поля, которые хранят JSON-строку (TEXT в СХ)
    const JSON_FIELDS = new Set(['input_ngrams', 'input_tfidf_json', 'input_competitor_urls']);
    // Поля, которые хранят INTEGER
    const INT_FIELDS  = new Set(['input_min_chars', 'input_max_chars']);
    // Поля с whitelist-валидацией
    const ENUM_FIELDS = { llm_provider: new Set(['gemini', 'grok']) };

    for (const key of ALLOWED) {
      if (key in req.body) {
        fields.push(`${key} = $${values.length + 1}`);
        let val = req.body[key];
        if (INT_FIELDS.has(key))  val = parseInt(val) || null;
        else if (JSON_FIELDS.has(key)) val = toText(val);
        else if (ENUM_FIELDS[key]) {
          const lc = (val == null ? '' : String(val).toLowerCase().trim());
          val = ENUM_FIELDS[key].has(lc) ? lc : 'gemini';
        }
        values.push(val);
      }
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'Нет допустимых полей для обновления' });
    }

    const { rows } = await db.query(
      `UPDATE tasks
       SET ${fields.join(', ')}, updated_at = NOW(), status = 'draft'
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      values
    );

    return res.json({ task: rows[0] });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/start
// Запустить задачу — добавить в очередь BullMQ
// ─────────────────────────────────────────────────────────────────────────────

async function startTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    // Нельзя запустить уже запущенную / выполняющуюся / завершённую
    if (task.status === 'queued' || task.status === 'processing' || task.status === 'completed') {
      return res.status(409).json({
        error: `Задача уже в статусе "${task.status}"`,
      });
    }

    // При повторном старте задачи из статуса failed — удаляем старый Bull job,
    // чтобы избежать конфликта jobId, если он ещё остался в Redis.
    if (task.status === 'failed' && task.bull_job_id) {
      try {
        const oldJob = await generationQueue.getJob(task.bull_job_id);
        if (oldJob) await oldJob.remove();
      } catch (cleanupErr) {
        console.warn(`[StartTask] Не удалось удалить старый Bull job ${task.bull_job_id}:`, cleanupErr.message);
      }
    }

    // Валидация полей (ТЗ §16)
    const errors = validateTaskForStart(task);
    if (errors.length) {
      return res.status(422).json({ errors });
    }

    // Добавляем в BullMQ. Используем уникальный jobId, чтобы повторный старт после fail
    // не ломался из-за оставшегося старого job-а с тем же task.id.
    const jobId = `${task.id}-${Date.now()}`;
    const job = await generationQueue.add(
      'generate',
      { taskId: task.id },
      {
        jobId,
        attempts: 2,
        backoff:  { type: 'exponential', delay: 5000 },
      }
    );

    // Переводим статус в queued и сохраняем bull_job_id
    await db.query(
      `UPDATE tasks SET status = 'queued', bull_job_id = $1, updated_at = NOW() WHERE id = $2`,
      [String(job.id), task.id]
    );

    return res.json({
      message:    'Задача поставлена в очередь',
      jobId:      job.id,
      taskId:     task.id,
      status:     'queued',
    });
  } catch (err) {
    // BullMQ бросает если jobId уже занят
    if (err.message?.includes('Job') && err.message?.includes('already')) {
      return res.status(409).json({ error: 'Задача уже в очереди' });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/pause — Graceful pause (кнопка "Стоп")
// ─────────────────────────────────────────────────────────────────────────────

async function pauseTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    if (task.status !== 'processing' && task.status !== 'queued') {
      return res.status(409).json({
        error: `Нельзя остановить задачу в статусе "${task.status}"`,
      });
    }

    // Устанавливаем статус 'pausing' — orchestrator обнаружит это перед следующим блоком
    await db.query(
      `UPDATE tasks SET status = 'pausing', updated_at = NOW() WHERE id = $1`,
      [task.id]
    );

    // SSE-уведомление
    publish(task.id, { type: 'pausing', message: 'Останавливаем после текущего блока...' });

    return res.json({ message: 'Запрос на остановку отправлен', status: 'pausing' });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/resume — Resume paused/failed task (кнопка "Продолжить")
// ─────────────────────────────────────────────────────────────────────────────

async function resumeTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    if (task.status !== 'paused' && task.status !== 'failed') {
      return res.status(409).json({
        error: `Нельзя продолжить задачу в статусе "${task.status}"`,
      });
    }

    // Удаляем старый Bull job если остался
    if (task.bull_job_id) {
      try {
        const oldJob = await generationQueue.getJob(task.bull_job_id);
        if (oldJob) await oldJob.remove();
      } catch (cleanupErr) {
        console.warn(`[ResumeTask] Не удалось удалить старый Bull job ${task.bull_job_id}:`, cleanupErr.message);
      }
    }

    // Загружаем checkpoint из БД
    const checkpoint = task.pipeline_checkpoint || null;
    const resumeFromBlock = checkpoint?.resumeFromBlock ?? 0;

    // Добавляем в BullMQ с данными для resume
    const jobId = `${task.id}-resume-${Date.now()}`;
    const job = await generationQueue.add(
      'generate',
      { taskId: task.id, resumeFrom: checkpoint },
      {
        jobId,
        attempts: 1,  // При resume — 1 попытка (не дублируем)
      }
    );

    await db.query(
      `UPDATE tasks SET status = 'queued', bull_job_id = $1, error_message = NULL, updated_at = NOW() WHERE id = $2`,
      [String(job.id), task.id]
    );

    // SSE-уведомление
    publish(task.id, {
      type:             'resuming',
      message:          `Возобновляем с блока ${resumeFromBlock + 1}...`,
      resumeFromBlock,
    });

    return res.json({
      message:          'Задача поставлена на возобновление',
      status:           'queued',
      resumeFromBlock,
    });
  } catch (err) {
    if (err.message?.includes('Job') && err.message?.includes('already')) {
      return res.status(409).json({ error: 'Задача уже в очереди' });
    }
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/tasks/:id
// Удалить задачу (ТЗ §13)
// ─────────────────────────────────────────────────────────────────────────────

async function deleteTask(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    // 1. Если задача в очереди или выполняется — отменяем Bull job
    if ((task.status === 'queued' || task.status === 'processing') && task.bull_job_id) {
      try {
        const job = await generationQueue.getJob(task.bull_job_id);
        if (job) {
          await job.remove();
        }
      } catch (bullErr) {
        // Джоб мог уже завершиться — логируем, не прерываем удаление
        console.warn(`[Delete] Could not remove Bull job ${task.bull_job_id}:`, bullErr.message);
      }
    }

    // 2. Закрываем SSE-соединения для этой задачи
    closeTask(task.id);

    // 3. Публикуем событие отмены (для клиентов, успевших поймать)
    publish(task.id, { type: 'cancelled', taskId: task.id });

    // 4. Каскадное удаление из БД (ON DELETE CASCADE покрывает stages, blocks, metrics)
    await db.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [task.id, req.user.id]);

    // 5. Удаляем загруженный DOCX с диска (если есть)
    if (task.input_tz_docx_path) {
      const fullPath = path.resolve(__dirname, '../../', task.input_tz_docx_path);
      fs.unlink(fullPath, (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          console.warn(`[Delete] Could not unlink file ${fullPath}:`, unlinkErr.message);
        }
      });
    }

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/result
// Полный результат задачи
// ─────────────────────────────────────────────────────────────────────────────

async function getResult(req, res, next) {
  try {
    const task = await loadOwnTask(req.params.id, req.user.id);

    if (task.status !== 'completed') {
      return res.status(409).json({
        error:  'Задача ещё не завершена',
        status: task.status,
      });
    }

    // Блоки контента
    const { rows: blocks } = await db.query(
      `SELECT block_index, h2_title, section_type, html_content,
              status, lsi_coverage, pq_score, audit_log_json
       FROM task_content_blocks
       WHERE task_id = $1
       ORDER BY block_index ASC`,
      [task.id]
    );

    // Метрики
    const { rows: metricsRows } = await db.query(
      `SELECT * FROM task_metrics WHERE task_id = $1`,
      [task.id]
    );

    return res.json({
      task: {
        id:            task.id,
        title:         task.title,
        status:        task.status,
        created_at:    task.created_at,
        started_at:    task.started_at,
        completed_at:  task.completed_at,
        input_target_service: task.input_target_service,
        stage7_result: task.stage7_result,
        full_html:     task.full_html,
        full_html_edited: task.full_html_edited || null,
      },
      blocks,
      metrics: metricsRows[0] || null,
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/metrics
// Метрики задачи
// ─────────────────────────────────────────────────────────────────────────────

async function getMetrics(req, res, next) {
  try {
    await loadOwnTask(req.params.id, req.user.id); // проверка владельца

    const { rows } = await db.query(
      `SELECT * FROM task_metrics WHERE task_id = $1`,
      [req.params.id]
    );
    return res.json({ metrics: rows[0] || null });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/blocks
// Все HTML-блоки задачи
// ─────────────────────────────────────────────────────────────────────────────

async function getBlocks(req, res, next) {
  try {
    await loadOwnTask(req.params.id, req.user.id);

    const { rows } = await db.query(
      `SELECT block_index, h2_title, section_type, html_content,
              status, lsi_coverage, ngram_coverage, pq_score, audit_log_json,
              created_at, updated_at
       FROM task_content_blocks
       WHERE task_id = $1
       ORDER BY block_index ASC`,
      [req.params.id]
    );
    return res.json({ blocks: rows });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/stages
// История вызовов LLM по стадиям
// ─────────────────────────────────────────────────────────────────────────────

async function getStages(req, res, next) {
  try {
    await loadOwnTask(req.params.id, req.user.id);

    const { rows } = await db.query(
      `SELECT stage_name, call_label, status, model_used,
              prompt_size, tokens_in, tokens_out, cost_usd,
              error_message, started_at, completed_at
       FROM task_stages
       WHERE task_id = $1
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    return res.json({ stages: rows });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/logs?after=<ISO>&limit=500
// История лог-событий задачи (для восстановления MonitorPage после F5).
// Возвращает события в хронологическом порядке. `after` — ISO timestamp
// (или ID), события строго ПОСЛЕ него; пустой → с самого начала.
// ─────────────────────────────────────────────────────────────────────────────

async function getTaskLogs(req, res, next) {
  try {
    await loadOwnTask(req.params.id, req.user.id);

    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const after = (req.query.after || '').trim();

    const params = [req.params.id];
    let whereExtra = '';
    if (after) {
      // Поддерживаем ISO-timestamp или числовой id (ID — для пагинации,
      // ts — для «дай новые с момента T»).
      if (/^\d+$/.test(after)) {
        params.push(parseInt(after, 10));
        whereExtra = ` AND id > $${params.length}`;
      } else {
        const d = new Date(after);
        if (!isNaN(d.getTime())) {
          params.push(d);
          whereExtra = ` AND ts > $${params.length}`;
        }
      }
    }
    params.push(limit);

    const { rows } = await db.query(
      `SELECT id, ts, level, stage, event_type, message, payload
         FROM task_logs
        WHERE task_id = $1${whereExtra}
        ORDER BY id ASC
        LIMIT $${params.length}`,
      params,
    );

    return res.json({ logs: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/:id/stream
// SSE endpoint — поток логов выполнения
// ─────────────────────────────────────────────────────────────────────────────

async function streamTask(req, res, next) {
  try {
    // Проверяем, что задача принадлежит пользователю
    const task = await loadOwnTask(req.params.id, req.user.id);

    // Настраиваем SSE-заголовки
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: отключить буферизацию
    res.flushHeaders();

    // Немедленно отправляем текущий статус задачи
    const initEvent = JSON.stringify({
      type:   'init',
      taskId: task.id,
      status: task.status,
      sseClients: getClientCount(task.id),
    });
    res.write(`data: ${initEvent}\n\n`);

    // Если задача уже завершена — шлём done и закрываем
    if (task.status === 'completed' || task.status === 'failed') {
      const doneEvent = JSON.stringify({ type: 'done', taskId: task.id, status: task.status });
      res.write(`data: ${doneEvent}\n\n`);
      res.end();
      return;
    }

    // Регистрируем SSE-клиента в sseManager
    const { subscribe } = require('../services/sse/sseManager');
    const unsubscribe = subscribe(task.id, res);

    // При разрыве соединения со стороны клиента — отписываемся
    req.on('close', () => {
      if (typeof unsubscribe === "function") unsubscribe();
    });

  } catch (err) {
    // Если ошибка до установки SSE-заголовков — обычный JSON
    if (!res.headersSent) {
      next(err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/upload-tz
// Загрузка DOCX файла ТЗ (multer обрабатывает файл, роут передаёт сюда)
// ─────────────────────────────────────────────────────────────────────────────

async function uploadTZ(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const task = await loadOwnTask(req.params.id, req.user.id);

    // Нельзя загрузить файл в выполняющуюся задачу
    if (task.status === 'processing' || task.status === 'queued') {
      // Удаляем только что загруженный файл
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({
        error: `Нельзя обновить файл задачи в статусе "${task.status}"`,
      });
    }

    // Удаляем предыдущий файл если был
    if (task.input_tz_docx_path) {
      const oldPath = path.resolve(__dirname, '../../', task.input_tz_docx_path);
      fs.unlink(oldPath, () => {});
    }

    // Сохраняем путь к файлу в БД
    const relativePath = path.relative(
      path.resolve(__dirname, '../../'),
      req.file.path
    );

    // Парсим ТЗ и извлекаем поля
    let parsedFields = {};
    try {
      parsedFields = await parseTZ(req.file.path);
      console.log('[UploadTZ] Parsed fields:', JSON.stringify(parsedFields).substring(0, 200));
    } catch (parseErr) {
      console.warn('[UploadTZ] Не удалось распарсить ТЗ:', parseErr.message);
    }

    // Обновляем задачу: путь к файлу + распознанные поля
    const updateFields = { input_tz_docx_path: relativePath };
    const fieldMap = [
      'input_target_service',
      'input_min_chars',
      'input_max_chars',
      'input_competitor_urls',
      'input_raw_lsi',
      'input_ngrams',
      'input_tfidf_json',
      'input_target_url',
    ];
    for (const key of fieldMap) {
      if (parsedFields[key] !== undefined && parsedFields[key] !== '') {
        updateFields[key] = parsedFields[key];
      }
    }

    const setClauses = Object.keys(updateFields)
      .map((k, i) => `${k} = $${i + 2}`)
      .join(', ');
    const setValues = Object.values(updateFields);

    await db.query(
      `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
      [task.id, ...setValues]
    );

    return res.json({
      message: 'Файл ТЗ загружен и распознан',
      filePath: relativePath,
      taskId: task.id,
      parsedFields,
    });
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    next(err);
  }

}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-Stage (-1): LLM-извлечение полей из текста ТЗ
// POST /api/tasks/parse-tz  (не требует taskId, возвращает JSON с полями)
// ─────────────────────────────────────────────────────────────────────────────

const pdfParse  = require('pdf-parse');
const mammoth   = require('mammoth');
const { TZ_EXTRACTOR_PROMPT } = require('../prompts/systemPrompts');
const { callDeepSeek }        = require('../services/llm/deepseek.adapter');
const { callGemini }          = require('../services/llm/gemini.adapter');

/**
 * Извлекает сырой текст из загруженного файла (PDF / DOCX / TXT).
 * Возвращает строку с текстом.
 */
async function extractTextFromFile(filePath, mimetype) {
  if (mimetype === 'application/pdf') {
    const buffer = fs.readFileSync(filePath);
    const data   = await pdfParse(buffer);
    return data.text || '';
  }

  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  // TXT и все остальные — читаем как UTF-8
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * JSON Schema для валидации ответа TZ-экстрактора (DSPy-inspired Signature).
 * Каждое поле имеет тип и nullable-статус.
 */
const TZ_SCHEMA = {
  keyword:              { type: 'string',  nullable: true },
  target_page_url:      { type: 'string',  nullable: true },
  niche:                { type: 'string',  nullable: true },
  geo:                  { type: 'string',  nullable: true },
  language:             { type: 'string',  nullable: true },
  business_type:        { type: 'string',  nullable: true },
  site_type:            { type: 'string',  nullable: true },
  domain_strength:      { type: 'string',  nullable: true },
  target_audience:      { type: 'string',  nullable: true },
  audience_segments:    { type: 'array',   nullable: false },
  business_goal:        { type: 'string',  nullable: true },
  monetization:         { type: 'string',  nullable: true },
  products_services:    { type: 'array',   nullable: false },
  brand_usp:            { type: 'array',   nullable: false },
  pricing_info:         { type: 'array',   nullable: false },
  service_process:      { type: 'array',   nullable: false },
  delivery_conditions:  { type: 'array',   nullable: false },
  guarantees:           { type: 'array',   nullable: false },
  certifications:       { type: 'array',   nullable: false },
  awards:               { type: 'array',   nullable: false },
  experience_years:     { type: 'string',  nullable: true },
  team_info:            { type: 'string',  nullable: true },
  cases_portfolio:      { type: 'array',   nullable: false },
  reviews_info:         { type: 'string',  nullable: true },
  trust_assets:         { type: 'array',   nullable: false },
  competitor_urls:      { type: 'array',   nullable: false },
  competitor_names:     { type: 'array',   nullable: false },
  niche_features:       { type: 'array',   nullable: false },
  constraints:          { type: 'array',   nullable: false },
  priority_page_types:  { type: 'array',   nullable: false },
  tone_of_voice:        { type: 'string',  nullable: true },
  conversion_points:    { type: 'array',   nullable: false },
  content_requirements: { type: 'array',   nullable: false },
  planning_horizon:     { type: 'string',  nullable: true },
  existing_site_sections: { type: 'array', nullable: false },
  existing_formats:     { type: 'array',   nullable: false },
  experts_authors:      { type: 'array',   nullable: false },
  community_sources:    { type: 'array',   nullable: false },
  known_terms:          { type: 'array',   nullable: false },
  additional_notes:     { type: 'string',  nullable: true },
};

/**
 * DSPy-inspired валидация ответа экстрактора.
 * Проверяет наличие всех полей и корректность типов.
 * Возвращает { valid, errors, repaired } — если possible, ремонтирует ответ.
 */
function validateAndRepairTzOutput(obj) {
  const errors = [];
  const repaired = { ...obj };

  for (const [field, spec] of Object.entries(TZ_SCHEMA)) {
    if (!(field in repaired)) {
      repaired[field] = spec.type === 'array' ? [] : null;
      errors.push(`missing field: ${field}`);
      continue;
    }
    const val = repaired[field];
    if (val === null || val === undefined) {
      if (spec.type === 'array') {
        repaired[field] = [];
      }
      continue;
    }
    if (spec.type === 'array' && !Array.isArray(val)) {
      repaired[field] = typeof val === 'string' ? [val] : [];
      errors.push(`type mismatch for ${field}: expected array`);
    }
    if (spec.type === 'string' && Array.isArray(val)) {
      repaired[field] = val.join('; ');
      errors.push(`type mismatch for ${field}: expected string, got array`);
    }
  }

  // Дополнительная санитизация competitor_urls: оставляем только реальные URL,
  // строки-названия (например, "Sputnik8", "Трипсе") переносим в competitor_names.
  // Это защищает Stage 0 от запросов "Invalid URL" к именам брендов.
  if (Array.isArray(repaired.competitor_urls)) {
    const { sanitizeUrl } = require('../services/parser/scraper');
    const validUrls   = [];
    const movedNames  = [];
    for (const item of repaired.competitor_urls) {
      if (typeof item !== 'string') continue;
      const normalized = sanitizeUrl(item);
      if (normalized) {
        validUrls.push(normalized);
      } else if (item.trim()) {
        movedNames.push(item.trim());
      }
    }
    repaired.competitor_urls = validUrls;
    if (movedNames.length) {
      const existingNames = Array.isArray(repaired.competitor_names) ? repaired.competitor_names : [];
      // Дедуп по lowercase
      const seen = new Set(existingNames.map(n => String(n).trim().toLowerCase()));
      for (const name of movedNames) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          existingNames.push(name);
          seen.add(key);
        }
      }
      repaired.competitor_names = existingNames;
    }
  }

  return { valid: errors.length === 0, errors, repaired };
}

/**
 * Вызывает LLM с промптом-экстрактором и возвращает распарсенный JSON.
 * DSPy-inspired: используем self-correction (retry с feedback) при ошибке парсинга/валидации.
 * Предпочитает DeepSeek (последняя модель), при ошибке пробует Gemini.
 */
async function callExtractorLLM(tzText) {
  const MAX_TZ_CHARS = 40000; // защита от слишком длинных ТЗ
  const truncated = tzText.length > MAX_TZ_CHARS
    ? tzText.slice(0, MAX_TZ_CHARS) + '\n\n[...текст обрезан для безопасности...]'
    : tzText;

  const prompt = TZ_EXTRACTOR_PROMPT.replace('{{TZ_TEXT}}', truncated);

  // Системная инструкция — оптимизированная для DeepSeek
  const systemMsg = 'Ты — аналитик ТЗ и специалист по сбору бизнес-данных. Извлекай данные СТРОГО из текста. Возвращай только корректный JSON без markdown-обёрток. ВАЖНО: для полей target_audience, niche_features, constraints, priority_page_types, audience_segments, brand_usp, service_process — давай РАЗВЁРНУТЫЕ описания из 2-5 предложений, НЕ одно слово. Описывай подробно: кто аудитория, какие особенности ниши, какие ограничения, какие УТП, как работает процесс. Собирай ВСЕ факты о бренде: цены, условия, гарантии, лицензии, опыт, команда.';

  // Увеличенный timeout для стабильности; temperature=0 для детерминизма
  const llmOptions = { temperature: 0.0, maxTokens: 8192, timeoutMs: 150000 };

  const MAX_RETRIES = 2; // DSPy self-correction: до 2 попыток с feedback
  let lastErrors = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const currentPrompt = attempt === 0
      ? prompt
      : prompt + '\n\n⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА БЫЛА НЕКОРРЕКТНОЙ. Ошибки:\n' +
        lastErrors.join('\n') +
        '\n\nИсправь эти ошибки и верни корректный JSON строго по схеме.';

    let rawText = '';
    try {
      const dsResult = await callDeepSeek(systemMsg, currentPrompt, llmOptions);
      rawText = dsResult.text || '';
    } catch (deepseekErr) {
      console.warn('[parseTZWithLLM] DeepSeek failed, trying Gemini:', deepseekErr.message);
      try {
        const gmResult = await callGemini(systemMsg, currentPrompt, llmOptions);
        rawText = gmResult.text || '';
      } catch (geminiErr) {
        console.error('[parseTZWithLLM] Gemini also failed:', geminiErr.message);
        throw new Error('Не удалось обработать ТЗ. Сервис LLM временно недоступен, попробуйте позже.');
      }
    }

    // Нормализуем и парсим JSON
    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
      if (attempt < MAX_RETRIES - 1) {
        lastErrors = ['LLM не вернул JSON-объект. Ответ должен начинаться с { и заканчиваться }.'];
        continue;
      }
      throw new Error('LLM не вернул корректный JSON');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (parseErr) {
      if (attempt < MAX_RETRIES - 1) {
        lastErrors = [`JSON parse error: ${parseErr.message}`];
        continue;
      }
      throw new Error('LLM вернул невалидный JSON');
    }

    // DSPy-inspired validation + repair
    const { valid, errors, repaired } = validateAndRepairTzOutput(parsed);

    if (!valid && attempt < MAX_RETRIES - 1) {
      lastErrors = errors;
      continue; // retry with feedback
    }

    return repaired;
  }

  // Safety: should not reach here, but if all attempts are exhausted
  throw new Error('LLM не вернул корректные данные после всех попыток');
}

/**
 * POST /api/tasks/parse-tz
 * Принимает файл ТЗ (PDF / DOCX / TXT), извлекает текст,
 * отправляет в LLM, возвращает структурированный JSON.
 */
async function parseTZWithLLM(req, res, next) {
  const filePath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const tzText = await extractTextFromFile(filePath, req.file.mimetype);
    if (!tzText || tzText.trim().length < 30) {
      return res.status(422).json({ error: 'Не удалось извлечь текст из файла или файл слишком короткий' });
    }

    const extracted = await callExtractorLLM(tzText);

    return res.json({ success: true, extracted });
  } catch (err) {
    next(err);
  } finally {
    // Всегда удаляем временный файл
    if (filePath) fs.unlink(filePath, () => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/example-tz — скачать пример ТЗ (DOCX)
// ─────────────────────────────────────────────────────────────────────────────
const { generateExampleTZ } = require('../utils/generateExampleTZ');

async function downloadExampleTZ(req, res, next) {
  try {
    const buffer = await generateExampleTZ();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': 'attachment; filename="Example_TZ_SEO_Genius.docx"',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listTasks,
  createTask,
  getTask,
  updateTask,
  startTask,
  pauseTask,
  resumeTask,
  deleteTask,
  getResult,
  getMetrics,
  getBlocks,
  getStages,
  getTaskLogs,
  streamTask,
  uploadTZ,
  parseTZWithLLM,
  downloadExampleTZ,
};
