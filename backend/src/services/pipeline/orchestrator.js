const db = require('../../config/db');
const stage0 = require('./stage0');
const stage1 = require('./stage1');
const stage2 = require('./stage2');
const stage3 = require('./stage3');
const stage4 = require('./stage4');
const stage5 = require('./stage5');
const stage6 = require('./stage6');
const stage7 = require('./stage7');

const stages = [stage0, stage1, stage2, stage3, stage4, stage5, stage6, stage7];

/**
 * Run the full SEO pipeline (stages 0–7) sequentially.
 *
 * @param {string} taskId
 * @param {Function} log – SSE logging callback
 */
async function runPipeline(taskId, log) {
  // Fetch task data
  const result = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (result.rows.length === 0) {
    throw new Error(`Task ${taskId} not found`);
  }
  const task = result.rows[0];

  const context = { task, results: {} };

  for (let i = 0; i < stages.length; i++) {
    const stageName = `stage${i}`;
    log(`Starting ${stageName}`, { stage: i });

    await db.query('UPDATE tasks SET current_stage = $2 WHERE id = $1', [taskId, i]);

    try {
      const stageResult = await stages[i].run(taskId, context, log);
      context.results[stageName] = stageResult;
      log(`Completed ${stageName}`, { stage: i });
    } catch (err) {
      log(`Failed at ${stageName}: ${err.message}`, { stage: i, error: true });
      throw err;
    }
  }

  // Persist final results
  await db.query('UPDATE tasks SET result = $2 WHERE id = $1', [taskId, JSON.stringify(context.results)]);

  return context.results;
}

module.exports = { runPipeline };
