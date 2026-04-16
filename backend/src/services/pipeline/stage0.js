const { scrapeCompetitors } = require('../parser/scraper');
const db = require('../../config/db');

/**
 * Stage 0 – Competitor Scraping
 * Fetches HTML content from competitor URLs provided in the task.
 */
async function run(taskId, context, log) {
  const { task } = context;

  let urls = [];
  try {
    urls = typeof task.competitor_urls === 'string'
      ? JSON.parse(task.competitor_urls)
      : task.competitor_urls || [];
  } catch (_e) {
    urls = [];
  }

  if (!urls.length) {
    log('No competitor URLs provided, skipping scraping');
    return { competitors: [], skipped: true };
  }

  log(`Scraping ${urls.length} competitor URL(s)...`);
  const results = await scrapeCompetitors(urls);

  const successful = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  log(`Scraped ${successful.length}/${urls.length} successfully, ${failed.length} failed`);

  await db.query('UPDATE tasks SET stage0_result = $2 WHERE id = $1', [
    taskId,
    JSON.stringify({ competitors: results }),
  ]);

  return { competitors: results };
}

module.exports = { run };
