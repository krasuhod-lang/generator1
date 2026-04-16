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
    } = req.body;

    // Для черновика допускаем пустое поле — ставим плейсхолдер
    const targetService = input_target_service?.toString().trim() || 'Черновик';

    const minChars = parseInt(input_min_chars) || 800;
    const maxChars = parseInt(input_max_chars) || 3500;

    if (maxChars <= minChars) {
      return res.status(400).json({ error: 'Макс. символов должно быть больше мин.' });
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
         input_min_chars, input_max_chars
       ) VALUES (
         $1, $2, 'draft',
         $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18,
         $19, $20,
         $21, $22
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
    ];

    const fields = [];
    const values = [req.params.id, req.user.id];

    // Поля, которые хранят JSON-строку (TEXT в СХ)
    const JSON_FIELDS = new Set(['input_ngrams', 'input_tfidf_json', 'input_competitor_urls']);
    // Поля, которые хранят INTEGER
    const INT_FIELDS  = new Set(['input_min_chars', 'input_max_chars']);

    for (const key of ALLOWED) {
      if (key in req.body) {
        fields.push(`${key} = $${values.length + 1}`);
        let val = req.body[key];
        if (INT_FIELDS.has(key))  val = parseInt(val) || null;
        else if (JSON_FIELDS.has(key)) val = toText(val);
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
        completed_at:  task.completed_at,
        input_target_service: task.input_target_service,
        stage7_result: task.stage7_result,
        full_html:     task.full_html,
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
 * Вызывает LLM с промптом-экстрактором и возвращает распарсенный JSON.
 * Предпочитает DeepSeek, при ошибке пробует Gemini.
 */
async function callExtractorLLM(tzText) {
  const MAX_TZ_CHARS = 40000; // защита от слишком длинных ТЗ
  const truncated = tzText.length > MAX_TZ_CHARS
    ? tzText.slice(0, MAX_TZ_CHARS) + '\n\n[...текст обрезан для безопасности...]'
    : tzText;

  const prompt = TZ_EXTRACTOR_PROMPT.replace('{{TZ_TEXT}}', truncated);

  // Системная инструкция — короткая, без лишнего
  const systemMsg = 'Ты — аналитик ТЗ. Извлекай данные СТРОГО из текста. Возвращай только корректный JSON без markdown-обёрток.';

  // Антигаллюцинационные параметры: temperature=0.0, ограниченные токены
  const llmOptions = { temperature: 0.0, maxTokens: 4096, timeoutMs: 60000 };

  let rawText = '';
  try {
    const dsResult = await callDeepSeek(systemMsg, prompt, llmOptions);
    rawText = dsResult.text || '';
  } catch (deepseekErr) {
    console.warn('[parseTZWithLLM] DeepSeek failed, trying Gemini:', deepseekErr.message);
    const gmResult = await callGemini(systemMsg, prompt, llmOptions);
    rawText = gmResult.text || '';
  }

  // Нормализуем и парсим JSON
  const cleaned = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('LLM не вернул корректный JSON');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
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

module.exports = {
  listTasks,
  createTask,
  getTask,
  updateTask,
  startTask,
  deleteTask,
  getResult,
  getMetrics,
  getBlocks,
  getStages,
  streamTask,
  uploadTZ,
  parseTZWithLLM,
};
