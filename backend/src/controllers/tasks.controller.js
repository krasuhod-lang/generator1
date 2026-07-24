'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../config/db');
const { parseTZ } = require('../utils/parseTZ');
const { generationQueue } = require('../queue/queue');
const { closeTask, getClientCount } = require('../services/sse/sseManager');
const { publish }         = require('../services/sse/sseManager');
const { normalizeGeminiCopywritingModel } = require('../services/llm/geminiModels');
const { resolveOwnedProjectId } = require('../services/projects/projectOwnership');

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

// UUID v4 / v3 / v5 — допускаем любую версию: relevance_reports.id = gen_random_uuid().
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * resolveOwnedRelevanceReportId — возвращает UUID отчёта релевантности,
 * только если:
 *   1) формат — валидный UUID,
 *   2) запись существует в relevance_reports,
 *   3) принадлежит тому же user_id (защита от IDOR — пользователь не может
 *      «подсадить» свою задачу на чужой отчёт),
 *   4) отчёт завершён (status='done') — иначе вливать просто нечего.
 *
 * Любой fail возвращает null (а не бросает) — пользователь увидит задачу
 * созданной как обычно, без обогащения. Это безопаснее, чем 400 на пустяке.
 */
async function resolveOwnedRelevanceReportId(rawId, userId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const id = rawId.trim().toLowerCase();
  if (!_UUID_RE.test(id)) return null;
  try {
    const { rows } = await db.query(
      `SELECT id FROM relevance_reports
        WHERE id = $1 AND user_id = $2 AND status = 'done'
        LIMIT 1`,
      [id, userId],
    );
    return rows.length ? rows[0].id : null;
  } catch (_) {
    return null;
  }
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
         t.llm_provider, t.gemini_model,
         t.created_at, t.completed_at, t.started_at,
         t.bull_job_id, t.error_message, t.quality_gate,
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
      gemini_model,
      // Опциональная привязка к отчёту релевантности (миграция 022).
      // Если задано — orchestrator подгружает report.competitor_signals
      // и report.entity_coverage и вливает их в __moduleContext + AKB.
      source_relevance_report_id,
      // ТЗ §5/§8: явная привязка задачи к SEO-проекту. Опциональна.
      // Сервер валидирует владение и подтягивает контекст из БД, если
      // часть полей формы пустая.
      project_id,
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
    const geminiModel = normalizeGeminiCopywritingModel(gemini_model);

    // source_relevance_report_id: принимаем только валидный UUID, который
    // принадлежит текущему пользователю и завершился успешно. Невалидный/
    // чужой/незавершённый id → null (не падаем — задача создаётся «как раньше»).
    const relevanceReportId = await resolveOwnedRelevanceReportId(
      source_relevance_report_id, req.user.id
    );

    // ТЗ §5: владение проектом валидируется на сервере (не доверяем фронту).
    const projectId = await resolveOwnedProjectId(project_id, req.user.id);

    // ТЗ §8: серверный fallback из контекста проекта. Если пользователь
    // не передал region/brand_name/brand_facts/audience/business_type,
    // но выбрал project_id — подтягиваем из contextResolver. Поля, которые
    // пользователь ввёл явно, имеют приоритет (правило согласовано с
    // partial _projectContext.partial.txt).
    let effRegion       = input_region;
    let effBrandName    = input_brand_name;
    let effBrandFacts   = input_brand_facts;
    let effAudience     = input_target_audience;
    let effBusinessType = input_business_type;
    let projectCtxSnapshot = null;
    if (projectId) {
      try {
        const { buildProjectContext } = require('../services/projects/contextResolver');
        const ctx = await buildProjectContext(projectId, req.user.id);
        if (ctx) {
          projectCtxSnapshot = ctx;
          if (!effRegion       && ctx.project?.region)      effRegion       = ctx.project.region;
          if (!effBrandName    && ctx.brand?.name)          effBrandName    = ctx.brand.name;
          if (!effBrandFacts   && Array.isArray(ctx.brand?.facts) && ctx.brand.facts.length) {
            effBrandFacts = ctx.brand.facts.join('. ');
          }
          if (!effAudience     && ctx.project?.audience)    effAudience     = ctx.project.audience;
          if (!effBusinessType && ctx.project?.niche)       effBusinessType = ctx.project.niche;
        }
      } catch (e) { console.warn('[tasks] project context fallback failed:', e.message); }
    }

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
         llm_provider,
         gemini_model,
         source_relevance_report_id,
         project_id,
         project_context_snapshot
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
          $24,
          $25,
          $26,
          $27,
          $28::jsonb
        ) RETURNING *`,
      [
        req.user.id,
        toText(title) || targetService,
        targetService,
        toText(input_brand_name),
        toText(input_author_name),
        toText(effRegion),
        toText(input_language),
        toText(effBusinessType),
        toText(input_site_type),
        toText(effAudience),
        toText(input_business_goal),
        toText(input_monetization),
        toText(input_project_limits),
        toText(input_page_priorities),
        toText(input_niche_features),
        toText(input_raw_lsi),
        toText(input_ngrams),
        toText(input_tfidf_json),
        toText(effBrandFacts),
        toText(input_competitor_urls),
        minChars,
        maxChars,
        toText(input_target_url),
        provider,
        geminiModel,
        relevanceReportId,
        projectId,
        projectCtxSnapshot ? JSON.stringify(projectCtxSnapshot) : null,
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
      'gemini_model',
      'source_relevance_report_id',
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
        let val = req.body[key];
        if (INT_FIELDS.has(key))  val = parseInt(val) || null;
        else if (JSON_FIELDS.has(key)) val = toText(val);
        else if (ENUM_FIELDS[key]) {
          const lc = (val == null ? '' : String(val).toLowerCase().trim());
          val = ENUM_FIELDS[key].has(lc) ? lc : 'gemini';
        } else if (key === 'source_relevance_report_id') {
          // Та же owner-валидация, что и в createTask. Невалидное id → null
          // (не падаем 400). Чужой/несуществующий/недоделанный отчёт также → null.
          val = await resolveOwnedRelevanceReportId(val, req.user.id);
        } else if (key === 'gemini_model') {
          val = normalizeGeminiCopywritingModel(val);
        }
        fields.push(`${key} = $${values.length + 1}`);
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

  // Без ограничения по времени (timeoutMs: 0 → адаптеры отключают timeout);
  // temperature=0 для детерминизма
  const llmOptions = { temperature: 0.0, maxTokens: 8192, timeoutMs: 0 };

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks/relevance-prefill/:reportId
//
// Возвращает данные для автозаполнения формы создания задачи на основе
// готового отчёта релевантности (см. кнопку «✍ SEO-текст» в
// RelevanceResultPage). Структура ответа:
//   {
//     deterministic: {
//       input_target_url, input_competitor_urls,
//       input_ngrams, input_tfidf_json,
//     },
//     llm: {
//       input_target_audience, input_niche_features, input_brand_facts,
//     },
//     llm_used: bool,        // удалось ли получить LLM-аналитику
//     llm_error: string|null // если упало — текст для UI (для админки)
//   }
//
// Принципы:
//   • Owner-check: отчёт должен принадлежать req.user.id и иметь status='done'
//     (защита от IDOR). Иначе 404.
//   • Детерминированные поля строим прямо из JSONB-колонок отчёта — без
//     LLM (быстро, дёшево, надёжно).
//   • LLM-блок (DeepSeek, последняя модель из env DEEPSEEK_MODEL) опционален:
//     если упал — возвращаем deterministic + llm:{} + llm_error для UI,
//     задача всё равно создаётся.
//   • Никаких записей в БД здесь нет — это чистый «read+enrich», фронт сам
//     решает, какие пустые поля заполнить ответом.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Безопасно сериализует структуру в JSON-строку с лимитом длины (для prompt'а).
 */
function _safeJsonForPrompt(value, maxChars = 4000) {
  try {
    const s = JSON.stringify(value);
    if (!s) return '';
    return s.length > maxChars ? s.slice(0, maxChars) + '…[truncated]' : s;
  } catch (_) { return ''; }
}

/**
 * Из vocabulary собирает текст «лемма-в-строке через \n» для поля input_raw_lsi
 * формы создания SEO-задачи. Берём:
 *   1. Все важные (status==='important', ≥51% документов топа), отсортированы
 *      по df_share_pct desc, затем по bm25.
 *   2. Дополнительные (status==='additional', 20–50%) — добиваем до `limit`,
 *      чтобы юзер сразу получил полную LSI-палитру для редактуры.
 * Дубликаты исключаем, длину обрезаем до 80 символов на лемму.
 */
function _vocabularyToRawLsi(vocabulary, limit = 60) {
  if (!Array.isArray(vocabulary)) return '';
  const important = vocabulary
    .filter((v) => v && v.lemma && v.status === 'important')
    .sort((a, b) => (b.df_share_pct || 0) - (a.df_share_pct || 0) || (b.bm25_score || 0) - (a.bm25_score || 0));
  const additional = vocabulary
    .filter((v) => v && v.lemma && v.status === 'additional')
    .sort((a, b) => (b.df_share_pct || 0) - (a.df_share_pct || 0) || (b.bm25_score || 0) - (a.bm25_score || 0));
  const merged = [...important, ...additional].slice(0, limit);
  const seen = new Set();
  const out = [];
  for (const v of merged) {
    const lemma = String(v.lemma).trim().slice(0, 80).toLowerCase();
    if (!lemma || seen.has(lemma)) continue;
    seen.add(lemma);
    out.push(lemma);
  }
  return out.join('\n');
}

/**
 * Пытается собрать «дефолтный бренд» из URL целевой страницы — берём
 * домен второго уровня (example.com → Example). Это нужно, чтобы кнопка
 * «▶ Запустить генерацию» сразу стала активной при переходе из релевантности
 * (там бренд явно не задаётся, а форма требует его как обязательное).
 * Пользователь всегда может перезаписать поле вручную.
 */
function _brandFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    // Для example.com → 'example'; для blog.example.co.uk → 'example'.
    let core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (core && core.length <= 2 && parts.length >= 3) core = parts[parts.length - 3];
    if (!core) return '';
    return core.charAt(0).toUpperCase() + core.slice(1);
  } catch (_) { return ''; }
}

/**
 * Из vocabulary (с .status==='important') собирает массив для формы:
 *   [{ term, rangeMin, rangeMax }, ...]
 * rangeMin/rangeMax — окрестность медианы по ТОПу (±20%, минимум 1).
 */
function _vocabularyToTfidfJson(vocabulary, limit = 20) {
  if (!Array.isArray(vocabulary)) return [];
  const important = vocabulary
    .filter((v) => v && v.lemma && (v.status === 'important' || (v.bm25_score || 0) > 0))
    .sort((a, b) => (b.bm25_score || 0) - (a.bm25_score || 0))
    .slice(0, limit);
  return important.map((v) => {
    const median = Math.max(1, Math.round(Number(v.median_count) || 1));
    const rangeMin = Math.max(1, Math.round(median * 0.8));
    const rangeMax = Math.max(rangeMin, Math.round(median * 1.2));
    return { term: String(v.lemma).slice(0, 80), rangeMin, rangeMax };
  });
}

/**
 * Строит строку «n-граммы через запятую» из report.ngrams.
 * Берём топ по df (документ-частоте), отбрасываем мусор (одиночные слова).
 */
function _ngramsToCsv(ngrams, limit = 25) {
  if (!Array.isArray(ngrams)) return '';
  const filtered = ngrams
    .filter((n) => n && typeof n.phrase === 'string' && n.phrase.trim().length >= 4)
    .sort((a, b) => (b.df_share_pct || b.df || 0) - (a.df_share_pct || a.df || 0))
    .slice(0, limit)
    .map((n) => n.phrase.trim());
  // Дедуп с сохранением порядка
  const seen = new Set();
  const out = [];
  for (const p of filtered) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(', ');
}

/**
 * DeepSeek-аналитика: на основе query/региона/ngrams/competitor-сигналов
 * генерирует ЦА, особенности ниши, факты о конкурентах. Один JSON-вызов.
 * Возвращает { target_audience, niche_features, brand_facts } или null
 * при ошибке (не бросает — fail-soft).
 */
async function _runRelevanceLlmEnrichment({ query, lr, ngramsCsv, topVocabulary, competitorSignals, ourUrl, competitorUrls }) {
  const systemMsg =
    'Ты — senior SEO-стратег, voice-of-customer аналитик и специалист по conversational demand mining. ' +
    'На вход ты получаешь данные аналитического отчёта по поисковой выдаче (запрос, регион, n-граммы ' +
    'и важные термины ТОП-10, сигналы топовых конкурентов). По этим данным восстанови реальный голос ' +
    'аудитории и зафиксируй конкретные факты, цифры и доказательства, которые используют конкуренты в ТОПе. ' +
    'Возвращай СТРОГО JSON-объект без markdown-обёрток с пятью строковыми ключами: ' +
    'target_audience, niche_features, brand_facts, project_limits, priority_pages.\n\n' +
    '— target_audience: 2–6 предложений. Портрет ЦА: сегменты, демография, JTBD, ключевые боли, ' +
    'эмоциональные триггеры, как они сами называют свою проблему и желаемый результат.\n' +
    '— niche_features: 2–6 предложений. Особенности ниши: тип бизнеса, YMYL/не-YMYL, сезонность, ' +
    'локальная привязка, уровень конкуренции, регуляторные требования, специфика buyer journey.\n' +
    '— project_limits: 1–3 предложения. Ограничения проекта: что нельзя писать, tone of voice, ' +
    'юридические и регуляторные ограничения ниши, запретные темы и обещания.\n' +
    '— priority_pages: 1–2 предложения. Приоритетные типы страниц (например, коммерческие лендинги, ' +
    'информационные статьи, карточки товаров, категории), которые дадут максимум трафика/конверсии в этой нише.\n' +
    '— brand_facts: РАЗВЁРНУТЫЙ структурированный текст-дайджест (10–25 предложений, можно с короткими ' +
    'подзаголовками вида «Боли:», «Возражения:», «Критерии выбора:», «Цифры/доказательства из ТОПа:», ' +
    '«Trust-сигналы:», «Часто задаваемые вопросы:», «Мифы и заблуждения:», «Сценарии использования:»). ' +
    'Цель — дать команде voice-of-customer карту ниши, которую дальше можно использовать в SEO, ' +
    'page messaging, money-pages, FAQ, CTA и AI-search. Опирайся на:\n' +
    '   1) реальные формулировки болей и желаемых результатов (problem language vs outcome language);\n' +
    '   2) повторяющиеся объекции и hesitation language (цена, доверие, сложность, риск, время, поддержка);\n' +
    '   3) decision criteria, по которым люди выбирают (proof, цены, сроки, локальность, гарантии, отзывы);\n' +
    '   4) trust- и skepticism-сигналы (что усиливает доверие, что подрывает);\n' +
    '   5) recurring questions / FAQ-кластеры из языка ниши (с интентом и подходящим page type);\n' +
    '   6) мифы, misconceptions и language traps;\n' +
    '   7) различия по сегментам (новички / эксперты, B2B / B2C, локальные / удалённые, urgency / price-sensitive);\n' +
    '   8) сигналы по этапам buyer journey (awareness → evaluation → decision → onboarding → retention);\n' +
    '   9) типовые цифры, опыт, лицензии, объёмы, гарантии и USP, которые упоминают конкуренты в ТОПе.\n\n' +
    'Правила:\n' +
    '• Если конкретных цифр/имён/лицензий нет в данных — НЕ выдумывай; формулируй как «обычно конкуренты ' +
    'указывают…», «характерно для ниши…», «ожидание аудитории…».\n' +
    '• Различай язык аудитории (как люди реально говорят) и keyword-язык; полезные «человеческие» ' +
    'формулировки приводи в кавычках.\n' +
    '• Различай pre-purchase voice и post-purchase truth.\n' +
    '• Если ниша B2B — добавь ROI/stakeholder/risk/implementation language.\n' +
    '• Если ниша SaaS — добавь onboarding/pricing/switching/integration/support language.\n' +
    '• Если ниша e-commerce — добавь fit/quality/shipping/comparison/post-purchase reality.\n' +
    '• Если ниша local-heavy — добавь urgency/proximity/availability/local proof.\n' +
    '• Если ниша YMYL/trust-sensitive — добавь fear/caution/proof/credibility cues.\n' +
    '• Не используй markdown-блоки кода; подзаголовки внутри строки оформляй простым текстом ' +
    'вида «Боли: …», «Возражения: …».';

  const userPrompt =
    `Запрос: ${String(query || '').slice(0, 250)}\n` +
    `Регион (lr): ${String(lr || '')}\n` +
    `URL целевой страницы (наша): ${String(ourUrl || '—').slice(0, 250)}\n` +
    `URL конкурентов (ТОП): ${(competitorUrls || []).slice(0, 4).join(', ').slice(0, 800)}\n` +
    `Топ n-грамм (df desc): ${ngramsCsv.slice(0, 1500)}\n` +
    `Важные термины ТОПа (lemma → median_count): ` +
    _safeJsonForPrompt(
      (topVocabulary || []).slice(0, 30).map((v) => ({ l: v.lemma, m: v.median_count })),
      2000,
    ) + '\n' +
    `Сигналы конкурентов (digest): ` +
    _safeJsonForPrompt(competitorSignals || {}, 2500) + '\n\n' +
    `Сначала мысленно пройди по фреймворку community voice (problem language → outcome language → ` +
    `objections → decision criteria → trust signals → recurring questions → myths → segments → journey ` +
    `stages → typical proof points конкурентов в ТОПе). Затем верни ТОЛЬКО JSON по схеме ` +
    `{"target_audience":"…","niche_features":"…","brand_facts":"…","project_limits":"…","priority_pages":"…"} без каких-либо обёрток. ` +
    `Поле brand_facts — самое объёмное и структурированное (с подзаголовками внутри строки), ` +
    `target_audience и niche_features — компактные 2–6 предложений, ` +
    `project_limits — 1–3 предложения, priority_pages — 1–2 предложения.`;

  try {
    const ds = await callDeepSeek(systemMsg, userPrompt, {
      temperature: 0.3,
      maxTokens:   3500,
      timeoutMs:   120000,
    });
    const raw = (ds.text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const pick = (k) => {
      const v = parsed && parsed[k];
      return (typeof v === 'string') ? v.trim().slice(0, 4000) : '';
    };
    return {
      target_audience: pick('target_audience'),
      niche_features:  pick('niche_features'),
      brand_facts:     pick('brand_facts'),
      project_limits:  pick('project_limits'),
      priority_pages:  pick('priority_pages'),
    };
  } catch (err) {
    // fail-soft: пробрасываем как { _error } — вызывающий решит, как показать.
    return { _error: (err && err.message) || 'DeepSeek error' };
  }
}

/**
 * GET /api/tasks/relevance-prefill/:reportId
 */
async function getRelevancePrefill(req, res, next) {
  try {
    const reportId = String(req.params.reportId || '').trim().toLowerCase();
    if (!_UUID_RE.test(reportId)) {
      return res.status(400).json({ error: 'Некорректный ID отчёта' });
    }

    const { rows } = await db.query(
      `SELECT id, query, lr, our_url, status, serp, report, our_report, comparison
         FROM relevance_reports
        WHERE id = $1 AND user_id = $2`,
      [reportId, req.user.id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Отчёт не найден или доступ запрещён' });
    }
    const r = rows[0];
    if (r.status !== 'done') {
      return res.status(409).json({ error: `Отчёт ещё не готов (status=${r.status})` });
    }

    const report     = r.report     || {};
    const ourReport  = r.our_report || {};
    const comparison = r.comparison || {};
    const serpRows   = Array.isArray(r.serp) ? r.serp : [];

    // Детерминированный блок
    const competitorUrls = serpRows
      .map((s) => (s && typeof s.url === 'string') ? s.url.trim() : '')
      .filter(Boolean)
      .slice(0, 4);

    const tfidfArr = _vocabularyToTfidfJson(report.vocabulary, 20);
    const ngramsCsv = _ngramsToCsv(report.ngrams, 25);
    const rawLsi    = _vocabularyToRawLsi(report.vocabulary, 60);

    const targetUrl = (ourReport && typeof ourReport.url === 'string')
      ? ourReport.url.trim()
      : (typeof r.our_url === 'string' ? r.our_url.trim() : '');

    const deterministic = {
      input_target_url:      targetUrl,
      input_competitor_urls: competitorUrls.join('\n'),
      input_ngrams:          ngramsCsv,
      input_tfidf_json:      JSON.stringify(tfidfArr),
      // input_raw_lsi — главное LSI-поле для формы SEO-задачи (textarea
      // «2. LSI / N-граммы / TF-IDF»). Передаётся \n-разделённым списком
      // из 60 верхних важных+дополнительных лемм; canStart на форме
      // требует ≥5 LSI — этим автоматически закрываем условие.
      input_raw_lsi:         rawLsi,
      // Sensible defaults — чтобы кнопка «▶ Запустить генерацию» сразу
      // стала активной (форма требует brand/author/region не пустыми).
      // Пользователь всегда может перезаписать.
      input_brand_name:      _brandFromUrl(targetUrl) || 'Бренд',
      input_author_name:     'Редакция',
      input_region:          (r.lr || report.lr || '').toString().trim() || 'Россия',
    };

    // LLM-аналитика
    const llmRaw = await _runRelevanceLlmEnrichment({
      query:              report.query || r.query || '',
      lr:                 report.lr    || r.lr    || '',
      ngramsCsv,
      topVocabulary:      Array.isArray(report.vocabulary) ? report.vocabulary : [],
      competitorSignals:  report.competitor_signals || null,
      ourUrl:             deterministic.input_target_url,
      competitorUrls,
    });

    let llm = {
      input_target_audience: '',
      input_niche_features: '',
      input_brand_facts: '',
      input_project_limits: '',
      input_page_priorities: '',
    };
    let llmUsed = false;
    let llmError = null;
    if (llmRaw && !llmRaw._error) {
      llm = {
        input_target_audience: llmRaw.target_audience || '',
        input_niche_features:  llmRaw.niche_features  || '',
        input_brand_facts:     llmRaw.brand_facts     || '',
        input_project_limits:  llmRaw.project_limits  || '',
        input_page_priorities: llmRaw.priority_pages  || '',
      };
      llmUsed = !!(
        llm.input_target_audience ||
        llm.input_niche_features ||
        llm.input_brand_facts ||
        llm.input_project_limits ||
        llm.input_page_priorities
      );
    } else if (llmRaw && llmRaw._error) {
      llmError = String(llmRaw._error).slice(0, 400);
    }

    return res.json({
      report_id: r.id,
      query:     report.query || r.query || '',
      deterministic,
      llm,
      llm_used:  llmUsed,
      llm_error: llmError,
    });
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
  getRelevancePrefill,
};
