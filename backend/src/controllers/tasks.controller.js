const db = require('../config/db');
const path = require('path');
const sseManager = require('../services/sse/sseManager');
const pipelineQueue = require('../queue/queue');
const tzParser = require('../services/tz/tzParser');
const tzExtractor = require('../services/tz/tzExtractor');
const fs = require('fs');

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

// --- CRUD ---

async function createTask(req, res) {
  try {
    const userId = req.user.id;
    const {
      name,
      input_keyword, input_niche, input_target_audience, input_tone_of_voice,
      input_region, input_language, input_competitor_urls, input_content_type,
      input_brand_name, input_unique_selling_points, input_word_count,
      input_additional,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!input_keyword) {
      return res.status(400).json({ error: 'input_keyword is required' });
    }

    const result = await db.query(
      `INSERT INTO tasks
        (user_id, name, input_keyword, input_niche, input_target_audience,
         input_tone_of_voice, input_region, input_language, input_competitor_urls,
         input_content_type, input_brand_name, input_unique_selling_points,
         input_word_count, input_additional, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
       RETURNING *`,
      [
        userId, name, input_keyword, input_niche || null,
        input_target_audience || null, input_tone_of_voice || null,
        input_region || null, input_language || 'русский',
        input_competitor_urls || null, input_content_type || null,
        input_brand_name || null, input_unique_selling_points || null,
        input_word_count || 3000, input_additional || null,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[tasks] Create error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function listTasks(req, res) {
  try {
    const userId = req.user.id;
    const result = await db.query(
      'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[tasks] List error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getTask(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[tasks] Get error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function deleteTask(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const result = await db.query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    return res.json({ deleted: true, id });
  } catch (err) {
    console.error('[tasks] Delete error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Pipeline ---

async function startPipeline(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const taskResult = await db.query(
      'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    if (task.status === 'running') {
      return res.status(409).json({ error: 'Pipeline is already running' });
    }

    await db.query("UPDATE tasks SET status = 'queued' WHERE id = $1", [id]);

    await pipelineQueue.add('run-pipeline', { taskId: id }, {
      jobId: id,
      removeOnComplete: true,
      removeOnFail: false,
    });

    return res.json({ message: 'Pipeline queued', taskId: id });
  } catch (err) {
    console.error('[tasks] Start pipeline error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// --- SSE ---

function sseStream(req, res) {
  try {
    const { id } = req.params;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write('data: {"type":"connected"}\n\n');

    sseManager.subscribe(id, res);

    req.on('close', () => {
      sseManager.unsubscribe(id, res);
    });
  } catch (err) {
    console.error('[tasks] SSE error:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
}

// --- Parse TZ ---

async function parseTz(req, res) {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    filePath = path.resolve(req.file.path);
    if (!filePath.startsWith(UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    // Extract raw text from the uploaded file
    const rawText = await tzParser.parseFile(filePath);
    if (!rawText || !rawText.trim()) {
      return res.status(422).json({ error: 'Could not extract text from file' });
    }

    // Send text to LLM for structured extraction
    const fields = await tzExtractor.extractFields(rawText);

    return res.json(fields);
  } catch (err) {
    console.error('[tasks] parseTz error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to parse TZ file' });
  } finally {
    // Cleanup uploaded file (only if within uploads directory)
    if (filePath && filePath.startsWith(UPLOADS_DIR)) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('[tasks] File cleanup error:', unlinkErr.message);
      });
    }
  }
}

module.exports = {
  createTask,
  listTasks,
  getTask,
  deleteTask,
  startPipeline,
  sseStream,
  parseTz,
};
